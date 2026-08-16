// src/lib/mail-product/analytics.ts — every number the dashboard and the analytics screen show.
//
// THE ONE RULE: aggregate in Postgres, return tens of rows, never thousands. "Do not pull raw event
// tables into the browser" is not a performance preference — mail_campaign_events grows by one row
// per recipient per event, so a single 50,000-recipient campaign is 150,000 rows before anybody
// opens anything.
//
// TWO SOURCES, KEPT SEPARATE ON PURPOSE. Transactional delivery is recorded in email_logs (written
// by the existing transport). Campaign delivery is recorded in mail_campaign_events (written by
// campaigns.ts, which passes logToDb:false precisely so the two never double-count each other). The
// combined view adds them; every screen that shows a combined number says which halves it added.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailProductSchema } from './schema';
import { rowsOf, reasonOf, isUuid, clampInt } from './common';

export interface Totals {
  sent: number; delivered: number; deferred: number; bounced: number;
  opened: number; clicked: number; unsubscribed: number; complained: number; failed: number;
}

const ZERO: Totals = { sent: 0, delivered: 0, deferred: 0, bounced: 0, opened: 0, clicked: 0, unsubscribed: 0, complained: 0, failed: 0 };

/**
 * Campaign totals over a window.
 *
 * Every read in this module is wrapped: an analytics screen that 500s because one aggregate failed
 * takes down the numbers that WOULD have loaded. A failed read returns zeros AND sets `partial`, so
 * the screen can say the figures are incomplete rather than quietly showing a zero as a fact.
 */
export async function campaignTotals(days = 30): Promise<{ totals: Totals; partial: boolean }> {
  await ensureMailProductSchema();
  const d = clampInt(days, 1, 365, 30);
  try {
    const r = await db.execute(sql`
      SELECT type, count(*)::int AS n FROM mail_campaign_events
      WHERE created_at > now() - (${d} || ' days')::interval
      GROUP BY type`);
    const out: Totals = { ...ZERO };
    for (const row of rowsOf(r)) {
      const k = String(row.type) as keyof Totals;
      if (k in out) out[k] = Number(row.n) || 0;
    }
    return { totals: out, partial: false };
  } catch (e: any) {
    console.error('[mail-product] campaignTotals failed:', reasonOf(e));
    return { totals: { ...ZERO }, partial: true };
  }
}

/** Transactional totals from email_logs — the mail the platform sends by itself (offers, resets). */
export async function transactionalTotals(days = 30): Promise<{ totals: Partial<Totals>; partial: boolean }> {
  const d = clampInt(days, 1, 365, 30);
  try {
    const r = await db.execute(sql`
      SELECT status, count(*)::int AS n FROM email_logs
      WHERE created_at > now() - (${d} || ' days')::interval
      GROUP BY status`);
    const out: Partial<Totals> = {};
    for (const row of rowsOf(r)) {
      const s = String(row.status).toLowerCase();
      const n = Number(row.n) || 0;
      // email_logs uses the transport's own vocabulary. Mapped here, once, rather than in each screen.
      if (s === 'sent' || s === 'ok' || s === 'delivered') out.sent = (out.sent || 0) + n;
      else if (s === 'failed' || s === 'error') out.failed = (out.failed || 0) + n;
      else if (s === 'bounced') out.bounced = (out.bounced || 0) + n;
      else if (s === 'queued' || s === 'deferred') out.deferred = (out.deferred || 0) + n;
    }
    return { totals: out, partial: false };
  } catch (e: any) {
    console.error('[mail-product] transactionalTotals failed:', reasonOf(e));
    return { totals: {}, partial: true };
  }
}

export interface DayPoint { day: string; [type: string]: string | number; }

/**
 * One row per day, one column per event type — the shape a line chart consumes directly.
 *
 * generate_series fills the days with no events, because a chart that skips empty days draws a
 * straight line through a gap and makes an outage look like steady sending.
 */
export async function dailySeries(days = 30, campaignId?: string | null): Promise<{ rows: DayPoint[]; partial: boolean }> {
  await ensureMailProductSchema();
  const d = clampInt(days, 1, 180, 30);
  const scope = campaignId && isUuid(campaignId) ? sql`AND e.campaign_id = ${campaignId}` : sql``;
  try {
    const r = await db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - ((${d} - 1) || ' days')::interval,
          date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata'),
          '1 day'::interval)::date AS day
      ),
      ev AS (
        SELECT date_trunc('day', e.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, e.type, count(*)::int AS n
        FROM mail_campaign_events e
        WHERE e.created_at > now() - (${d} || ' days')::interval ${scope}
        GROUP BY 1, 2
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(n) FILTER (WHERE type = 'sent'), 0)::int AS sent,
             COALESCE(SUM(n) FILTER (WHERE type = 'delivered'), 0)::int AS delivered,
             COALESCE(SUM(n) FILTER (WHERE type = 'opened'), 0)::int AS opened,
             COALESCE(SUM(n) FILTER (WHERE type = 'clicked'), 0)::int AS clicked,
             COALESCE(SUM(n) FILTER (WHERE type = 'bounced'), 0)::int AS bounced,
             COALESCE(SUM(n) FILTER (WHERE type = 'unsubscribed'), 0)::int AS unsubscribed
      FROM days LEFT JOIN ev ON ev.day = days.day
      GROUP BY days.day ORDER BY days.day ASC`);
    return { rows: rowsOf<DayPoint>(r), partial: false };
  } catch (e: any) {
    console.error('[mail-product] dailySeries failed:', reasonOf(e));
    return { rows: [], partial: true };
  }
}

/** The campaign performance table: one row per campaign, already rated. */
export async function campaignPerformance(limit = 12): Promise<any[]> {
  await ensureMailProductSchema();
  try {
    const r = await db.execute(sql`
      SELECT c.id, c.name, c.status, c.completed_at, c.recipients_total, c.sent_count, c.failed_count,
             COALESCE(e.opened, 0) AS opened, COALESCE(e.clicked, 0) AS clicked,
             COALESCE(e.bounced, 0) AS bounced, COALESCE(e.unsubscribed, 0) AS unsubscribed
      FROM mail_campaigns c
      LEFT JOIN (
        SELECT campaign_id,
               count(*) FILTER (WHERE type = 'opened')::int AS opened,
               count(*) FILTER (WHERE type = 'clicked')::int AS clicked,
               count(*) FILTER (WHERE type = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE type = 'unsubscribed')::int AS unsubscribed
        FROM mail_campaign_events GROUP BY campaign_id
      ) e ON e.campaign_id = c.id
      WHERE c.status IN ('sending','completed','paused')
      ORDER BY COALESCE(c.completed_at, c.started_at, c.updated_at) DESC
      LIMIT ${clampInt(limit, 1, 50, 12)}`);
    return rowsOf(r);
  } catch (e: any) {
    console.error('[mail-product] campaignPerformance failed:', reasonOf(e));
    return [];
  }
}

/**
 * Delivery by recipient domain — the screen that tells you it is one provider rejecting you and not
 * "email in general". Capped to the top domains; the tail is summed into one "everything else" row
 * rather than truncated silently.
 */
export async function domainPerformance(days = 30, top = 8): Promise<{ rows: any[]; othersSent: number }> {
  await ensureMailProductSchema();
  const d = clampInt(days, 1, 365, 30);
  const n = clampInt(top, 1, 25, 8);
  try {
    const r = await db.execute(sql`
      WITH byd AS (
        SELECT lower(split_part(email, '@', 2)) AS domain,
               count(*) FILTER (WHERE type = 'sent')::int AS sent,
               count(*) FILTER (WHERE type = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE type = 'opened')::int AS opened
        FROM mail_campaign_events
        WHERE created_at > now() - (${d} || ' days')::interval AND email IS NOT NULL AND email <> ''
        GROUP BY 1
      )
      SELECT * FROM byd ORDER BY sent DESC LIMIT ${n + 50}`);
    const all = rowsOf(r);
    const rows = all.slice(0, n);
    const othersSent = all.slice(n).reduce((a, x: any) => a + (Number(x.sent) || 0), 0);
    return { rows, othersSent };
  } catch (e: any) {
    console.error('[mail-product] domainPerformance failed:', reasonOf(e));
    return { rows: [], othersSent: 0 };
  }
}

/** Audience health for the dashboard — subscribed / unsubscribed / bounced / complained. */
export async function audienceTotals(): Promise<Record<string, number>> {
  await ensureMailProductSchema();
  try {
    const r = await db.execute(sql`SELECT status, count(*)::int AS n FROM mail_contacts GROUP BY status`);
    const out: Record<string, number> = { subscribed: 0, unconfirmed: 0, unsubscribed: 0, bounced: 0, complained: 0 };
    for (const row of rowsOf(r)) out[String(row.status)] = Number(row.n) || 0;
    out.total = Object.values(out).reduce((a, b) => a + b, 0);
    return out;
  } catch (e: any) {
    console.error('[mail-product] audienceTotals failed:', reasonOf(e));
    return { subscribed: 0, unconfirmed: 0, unsubscribed: 0, bounced: 0, complained: 0, total: 0 };
  }
}

/**
 * The derived rates, computed in ONE place.
 *
 * Every one of them is a percentage OF SOMETHING, and which something is the whole argument: an
 * open rate over "sent" and an open rate over "delivered" differ by exactly the bounce rate, and a
 * product that shows one and labels it the other is lying by a number it could have got right.
 * Stated here: opens and clicks are rated against DELIVERED where a delivered count exists, and
 * against SENT where it does not — and `basis` says which was used so the screen can print it.
 */
export function rates(t: Totals): { key: string; label: string; value: number | null; basis: string }[] {
  const base = t.delivered > 0 ? t.delivered : t.sent;
  const basis = t.delivered > 0 ? 'delivered' : 'sent';
  const of = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
  return [
    { key: 'delivery', label: 'Delivery rate', value: of(t.delivered || t.sent - t.bounced - t.failed, t.sent), basis: 'sent' },
    { key: 'open', label: 'Open rate', value: of(t.opened, base), basis },
    { key: 'click', label: 'Click rate', value: of(t.clicked, base), basis },
    { key: 'ctor', label: 'Click-to-open', value: of(t.clicked, t.opened), basis: 'opened' },
    { key: 'bounce', label: 'Bounce rate', value: of(t.bounced, t.sent), basis: 'sent' },
    { key: 'unsub', label: 'Unsubscribe rate', value: of(t.unsubscribed, base), basis },
    { key: 'complaint', label: 'Complaint rate', value: of(t.complained, base), basis },
  ];
}
