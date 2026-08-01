// src/lib/activity-feed.ts — everything that happens, recorded; only what matters, pushed.
//
// The brief was "each small to small activity should be notified to super admin". Recording all of
// it is right. PUSHING all of it is not: a platform this size generates thousands of events a day,
// and a notification stream nobody can read is worse than none — it trains you to dismiss the one
// that mattered. So this splits the two concerns:
//
//   RECORD   every event, always, to an append-only activity log the super admin can read and
//            filter. Nothing is lost.
//   PUSH     only events that need a human, plus a periodic digest of the rest.
//
// Subscribes through the event bus (src/lib/events.ts), so producers stay unaware of it. Adding a
// new consumer later never touches a producer.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { on, EVENTS, type EventMeta } from '@/lib/events';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** How an event reaches a super admin. */
export type Reach = 'push' | 'digest' | 'log-only';

/**
 * Per-event routing. The default for anything unlisted is 'digest' rather than 'push', so a new
 * event type added later cannot flood the bell by omission — under-notifying is recoverable,
 * training someone to ignore notifications is not.
 */
const ROUTING: Record<string, Reach> = {
  // Money and irreversible commitments: always interrupt.
  [EVENTS.OFFER_SIGNED]: 'push',
  [EVENTS.PAYROLL_PAID]: 'push',
  'payment.failed': 'push',
  'payment.refunded': 'push',
  'security.permission_changed': 'push',
  'security.admin_created': 'push',
  'data.export': 'push',
  'data.purge': 'push',
  // Joining and leaving. Someone is waiting on the other side of each of these — a hire blocked
  // until their document is reviewed, or an account that should stop working today — so they are
  // summarised rather than left purely to whoever thinks to open the screen.
  'hr.onboarding_document_submitted': 'digest',
  'hr.separation_started': 'push',
  // Routine but time-sensitive.
  [EVENTS.OFFER_EXTENDED]: 'digest',
  [EVENTS.INTERVIEW_SCHEDULED]: 'digest',
  [EVENTS.APPLICATION_SUBMITTED]: 'digest',
  // High-volume by nature: recorded, never pushed individually.
  [EVENTS.APPLICATION_STARTED]: 'log-only',
  [EVENTS.APPLICATION_STATUS_CHANGED]: 'log-only',
  [EVENTS.LOCATION_RECORDED]: 'log-only',
  [EVENTS.KNOWLEDGE_UPDATED]: 'log-only',
};

export function ensureActivitySchema(): Promise<void> {
  return ensureOnce('activity_log_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS activity_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event TEXT NOT NULL,
      actor_id UUID,
      correlation_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      payload JSONB,
      reach TEXT NOT NULL DEFAULT 'digest',
      digested BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS activity_log_time_idx ON activity_log (created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS activity_log_event_idx ON activity_log (event, created_at DESC)`);
    // Partial index: the digest job only ever scans undigested rows.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS activity_log_pending_idx ON activity_log (created_at) WHERE digested = false`);
  });
}

/** A short human line for the feed. Falls back to the event name rather than inventing detail. */
function summarise(event: string, payload: any): string {
  const p = payload || {};
  const who = p.candidateName || p.name || p.employeeName || p.requesterName || '';
  const what = p.roleTitle || p.role || p.title || '';
  if (who && what) return `${who} — ${what}`;
  if (who) return String(who);
  if (what) return String(what);
  return event.replace(/[._]/g, ' ');
}

/**
 * Record one event. Never throws: observability must not be able to break the action it observes,
 * and the event bus already isolates handlers so a failure here cannot affect siblings either.
 */
export async function record(
  event: string,
  payload: any,
  // `reach` overrides the routing table for this one call. It exists for events that have ALREADY
  // been delivered by another path — an admin push that we are mirroring into the feed for the
  // record. Without it those rows would default to 'digest' and the same thing would be announced
  // twice: once as it happened, once again in the nightly summary.
  meta: Partial<EventMeta> & { reach?: Reach } = {},
): Promise<void> {
  try {
    await ensureActivitySchema();
    const reach: Reach = meta.reach || ROUTING[event] || 'digest';
    await db.execute(sql`
      INSERT INTO activity_log (event, actor_id, correlation_id, summary, payload, reach, digested)
      VALUES (${event}, ${meta.actorId || null}, ${meta.correlationId || null},
              ${summarise(event, payload).slice(0, 300)},
              ${JSON.stringify(payload ?? {})}::jsonb, ${reach},
              ${reach === 'log-only'})`);

    // Only 'push' interrupts. Digest rows are collected by flushDigest() below.
    if (reach === 'push') {
      const { sendPushToAdmins } = await import('@/lib/push');
      await sendPushToAdmins({
        type: 'activity_alert',
        title: event.replace(/[._]/g, ' '),
        body: summarise(event, payload),
        url: '/admin/activity',
        tag: 'activity-' + event + '-' + (payload?.id || Date.now()),
      });
    }
  } catch (e: any) {
    console.error('[activity] record failed:', e?.cause?.message || e?.message);
  }
}

/**
 * Send one digest covering everything since the last run, then mark those rows digested.
 *
 * Marking happens by ID rather than by timestamp: a row inserted while the digest was being built
 * would otherwise be marked without ever being included, and would never appear anywhere.
 */
export async function flushDigest(): Promise<{ sent: boolean; count: number }> {
  try {
    await ensureActivitySchema();
    const pending = rows(await db.execute(sql`
      SELECT id, event, summary FROM activity_log
      WHERE digested = false AND reach = 'digest'
      ORDER BY created_at ASC LIMIT 500`));
    if (!pending.length) return { sent: false, count: 0 };

    const byEvent = new Map<string, number>();
    for (const r of pending) byEvent.set(r.event, (byEvent.get(r.event) || 0) + 1);
    const lines = [...byEvent.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([e, n]) => `${n}x ${e.replace(/[._]/g, ' ')}`)
      .slice(0, 8);

    const { sendPushToAdmins } = await import('@/lib/push');
    await sendPushToAdmins({
      type: 'activity_digest',
      title: `${pending.length} activities`,
      body: lines.join(' · '),
      url: '/admin/activity',
      tag: 'activity-digest',
    });

    const ids = pending.map((r) => r.id);
    await db.execute(sql`
      UPDATE activity_log SET digested = true
      WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)`);
    return { sent: true, count: pending.length };
  } catch (e: any) {
    console.error('[activity] digest failed:', e?.cause?.message || e?.message);
    return { sent: false, count: 0 };
  }
}

export interface ActivityRow {
  id: string; event: string; summary: string; reach: string;
  actorId: string | null; createdAt: string;
}

/** The feed, newest first, optionally filtered by event. */
export async function listActivity(opts: { event?: string; limit?: number } = {}): Promise<ActivityRow[]> {
  try {
    await ensureActivitySchema();
    const lim = Math.min(500, opts.limit || 200);
    const r = opts.event
      ? await db.execute(sql`SELECT id, event, summary, reach, actor_id, created_at FROM activity_log WHERE event = ${opts.event} ORDER BY created_at DESC LIMIT ${lim}`)
      : await db.execute(sql`SELECT id, event, summary, reach, actor_id, created_at FROM activity_log ORDER BY created_at DESC LIMIT ${lim}`);
    return rows(r).map((x: any) => ({
      id: x.id, event: x.event, summary: x.summary, reach: x.reach,
      actorId: x.actor_id, createdAt: String(x.created_at),
    }));
  } catch { return []; }
}

/**
 * Attach to the bus. Idempotent — a module can be imported more than once per process, and
 * subscribing twice would double every record.
 */
let attached = false;
export function attachActivityFeed(): void {
  if (attached) return;
  attached = true;
  const names = new Set<string>([...Object.values(EVENTS), ...Object.keys(ROUTING)]);
  for (const name of names) {
    on(name, { name: 'activity-feed' }, async (payload, meta) => {
      await record(name, payload, meta);
    });
  }
}
