// src/lib/safety.ts — the emergency path: raising an SOS, the console that answers it, and the
// live-location beacon behind both.
//
// WHY THIS MODULE EXISTS.
//
// 1. THE TABLES HAD NO CREATE STATEMENT ANYWHERE IN THE REPOSITORY. `sos_events` and
//    `user_locations` were INSERTed into by src/pages/api/safety/sos.ts and src/pages/api/location/
//    update.ts, and SELECTed by /admin/sos, and nothing in src/, db/ or scripts/ ever created
//    either one. On any deployment where a hand-run migration had not been applied, EVERY statement
//    in the emergency path failed — and every one of those failures was swallowed:
//      * /api/safety/sos returned `{ ok:false }` and public/sos.js said "SOS sent. Help is coming."
//      * /admin/sos caught the read into `catch(e) {}` and rendered "No active location data" and
//        zero active alerts, which is pixel-identical to a calm day.
//    A panic button that reports success it did not achieve is the worst shape this codebase has
//    shipped. The DDL below is additive, IF NOT EXISTS only, never DROP, and runs inside the
//    ensureOnce guard so a failed run retries instead of poisoning the process.
//
// 2. THE READS COULD NOT SAY THEY HAD FAILED. Every function here returns a discriminated result.
//    On a safety board "we could not read the queue" and "there is no emergency" must never render
//    the same, and the caller cannot tell them apart from an empty array.
//
// 3. RESOLVING SOMEBODY ELSE'S EMERGENCY WAS UNVERIFIED AND UNRECORDED. The UPDATE bound whatever
//    string the form posted into `status`, never checked that it matched a row, and wrote nothing
//    to the audit log. Closing an emergency in another person's name is exactly the act
//    src/lib/auth/registry.ts describes as sensitive; resolveSos() now validates the status against
//    a closed set, RETURNS the row it changed so "resolved" means a row actually moved, and writes
//    one audit entry through src/lib/audit.ts.
//
// AUTHORIZATION IS NOT DECIDED HERE. The page asks src/lib/auth/permissions.ts. This module refuses
// to guess who may answer an emergency.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { dbReason, toRows, uuidish } from '@/lib/page-safety';

/**
 * The only statuses an SOS may hold. The form used to post `status` straight into the UPDATE, so a
 * crafted request could park an emergency in any string at all and it would then match no filter on
 * the console — an alert hidden rather than answered.
 */
export const SOS_STATUSES = ['active', 'resolved', 'false_alarm'] as const;
export type SosStatus = (typeof SOS_STATUSES)[number];

export function isSosStatus(v: unknown): v is SosStatus {
  return typeof v === 'string' && (SOS_STATUSES as readonly string[]).includes(v);
}

export const SOS_STATUS_LABELS: Record<SosStatus, string> = {
  active: 'Active',
  resolved: 'Resolved',
  false_alarm: 'False alarm',
};

/** How recent a location ping has to be to count as "live" on the console. */
export const LIVE_LOCATION_MINUTES = 10;

/**
 * Additive schema-ensure for the emergency path.
 *
 * DELIBERATELY PERMISSIVE COLUMN TYPES. lat/lon arrive as JSON numbers from a browser and are
 * compared with trigonometry in src/pages/api/safety/sos.ts, so they are DOUBLE PRECISION.
 * `nearby_users` is stored as JSONB text by the existing INSERT (JSON.stringify of the row list),
 * and JSONB accepts that string, so the shape the live code already writes keeps working unchanged.
 *
 * NOTHING HERE DROPS OR REWRITES A COLUMN. If a deployment already has these tables from a
 * hand-run migration, every statement below is a no-op.
 */
export function ensureSafetySchema(): Promise<void> {
  return ensureOnce('safety:schema', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS user_locations (
      user_id UUID PRIMARY KEY,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS user_locations_updated_idx ON user_locations (updated_at DESC)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS sos_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      message TEXT,
      nearby_users JSONB,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      resolved_by UUID,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // The console orders by status-then-recency; both halves of that are indexed.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS sos_events_status_idx ON sos_events (status, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS sos_events_user_idx ON sos_events (user_id, created_at DESC)`);
  });
}

export type SosEvent = {
  id: string;
  user_id: string;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  message: string | null;
  nearby_users: any;
  status: string;
  resolved_by: string | null;
  resolved_at: any;
  created_at: any;
  user_name: string | null;
  user_email: string | null;
  resolver_name: string | null;
};

export type LiveLocation = {
  user_id: string;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  updated_at: any;
  name: string | null;
  role: string | null;
};

/**
 * A read that knows whether it worked.
 *
 * `ok:false` is NOT "no emergencies". The console renders the two differently, which is the whole
 * reason this is not a bare array.
 */
export type SafetyRead<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: string };

/** The SOS queue: active first, then most recent. Includes who closed each past event. */
export async function listSosEvents(limit = 50): Promise<SafetyRead<SosEvent>> {
  const cap = Math.min(200, Math.max(1, Math.floor(limit || 50)));
  try {
    await ensureSafetySchema();
    const r = await db.execute(sql`
      SELECT s.id::text AS id, s.user_id::text AS user_id, s.lat, s.lon, s.accuracy, s.message,
             s.nearby_users, s.status, s.resolved_by::text AS resolved_by, s.resolved_at, s.created_at,
             u.name AS user_name, u.email AS user_email,
             r.name AS resolver_name
      FROM sos_events s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN users r ON s.resolved_by = r.id
      ORDER BY CASE s.status WHEN 'active' THEN 1 ELSE 2 END, s.created_at DESC
      LIMIT ${cap}
    `);
    return { ok: true, rows: toRows<SosEvent>(r) };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[safety] SOS queue could not be read -', reason);
    return { ok: false, reason };
  }
}

/**
 * Everyone whose beacon reported in the last LIVE_LOCATION_MINUTES.
 *
 * A LEFT JOIN, not the inner join this used to be: a location row whose user has been deleted is
 * still a person on the map at the moment of an emergency, and dropping it silently made the count
 * on the console disagree with the pins.
 */
export async function listLiveLocations(limit = 50): Promise<SafetyRead<LiveLocation>> {
  const cap = Math.min(500, Math.max(1, Math.floor(limit || 50)));
  try {
    await ensureSafetySchema();
    const r = await db.execute(sql`
      SELECT ul.user_id::text AS user_id, ul.lat, ul.lon, ul.accuracy, ul.updated_at,
             u.name, u.role
      FROM user_locations ul
      LEFT JOIN users u ON ul.user_id = u.id
      WHERE ul.updated_at >= NOW() - make_interval(mins => ${LIVE_LOCATION_MINUTES})
      ORDER BY ul.updated_at DESC
      LIMIT ${cap}
    `);
    return { ok: true, rows: toRows<LiveLocation>(r) };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[safety] live locations could not be read -', reason);
    return { ok: false, reason };
  }
}

/**
 * The newest beacon this deployment has EVER recorded, regardless of age.
 *
 * WHY THIS EXISTS. listLiveLocations() windows to the last LIVE_LOCATION_MINUTES, so it returns
 * nothing in two completely different situations: nobody is out sharing a location right now, or
 * NOTHING CAN EVER WRITE ONE. Today it is the second — `/api/location/update` is answered at the
 * edge of src/middleware.ts with 410 (the circuit breaker for the v5 watcher leak), so the only
 * INSERT into user_locations is unreachable and the live map is structurally, permanently empty.
 * The console rendered that as a calm "no beacon has reported in the last 10 minutes", which is a
 * responder reading "nobody is out there" off a feature that is switched off.
 *
 * This deliberately reads EVIDENCE rather than asserting the middleware's state, so it stays true
 * when the breaker is lifted: null means no beacon has ever been stored, and a very old timestamp
 * means the beacon stopped at that moment.
 */
export async function latestBeaconAt(): Promise<{ ok: true; at: Date | null } | { ok: false; reason: string }> {
  try {
    await ensureSafetySchema();
    const r = await db.execute(sql`SELECT MAX(updated_at) AS newest FROM user_locations`);
    const row = toRows<{ newest: any }>(r)[0];
    const raw = row?.newest;
    if (!raw) return { ok: true, at: null };
    const d = new Date(raw);
    return { ok: true, at: isFinite(d.getTime()) ? d : null };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[safety] latest beacon lookup failed -', reason);
    return { ok: false, reason };
  }
}

export type ResolveResult =
  | { ok: true; status: SosStatus; subjectName: string }
  | { ok: false; reason: string };

/**
 * Close an emergency in somebody else's name.
 *
 * THREE THINGS THIS DOES THAT THE OLD ONE-LINER DID NOT:
 *   - validates `status` against SOS_STATUSES instead of binding an arbitrary string;
 *   - RETURNS the row it changed, so "Marked resolved" is only said when a row actually moved. A
 *     stale page whose event id no longer exists used to report success and change nothing;
 *   - writes one audit entry. src/lib/auth/registry.ts calls this capability sensitive precisely
 *     because it is an act taken on another person's emergency.
 *
 * The exception is NEVER swallowed — it comes back as a reason the console prints.
 */
export async function resolveSos(args: {
  eventId: string;
  status: string;
  actorId: string;
}): Promise<ResolveResult> {
  const id = uuidish(args.eventId);
  if (!id) return { ok: false, reason: 'That alert id is not a valid identifier, so nothing was changed.' };
  if (!isSosStatus(args.status)) {
    return { ok: false, reason: 'Unknown status "' + String(args.status).slice(0, 40) + '". Nothing was changed.' };
  }
  const status: SosStatus = args.status;

  try {
    await ensureSafetySchema();
    // NOT `UPDATE ... FROM users` — an SOS whose raiser has since been deleted would then match no
    // row and become permanently un-closable, which is the opposite of what a responder needs. The
    // update stands alone; the name is a second, optional lookup for the message and the audit row.
    const r = await db.execute(sql`
      UPDATE sos_events
         SET status = ${status},
             resolved_by = ${args.actorId},
             resolved_at = NOW()
       WHERE id = ${id}
      RETURNING id::text AS id, user_id::text AS user_id
    `);
    const rows = toRows<{ id: string; user_id: string }>(r);
    if (rows.length === 0) {
      // The id is gone. The click did nothing, and the responder has to be told that rather than
      // shown a green tick.
      return { ok: false, reason: 'No alert with that id was found, so nothing was changed. Reload the console — someone else may have closed it.' };
    }

    let subjectName = 'the person who raised it';
    try {
      const who = toRows<{ label: string }>(await db.execute(
        sql`SELECT COALESCE(name, email, 'the person who raised it') AS label FROM users WHERE id = ${rows[0].user_id}`
      ));
      if (who[0]?.label) subjectName = String(who[0].label);
    } catch (e: any) {
      // A missing name must not undo a completed close, so this is logged and stepped over — the
      // status change above has already committed.
      console.error('[safety] resolveSos name lookup failed -', dbReason(e));
    }

    await logAudit({
      userId: args.actorId,
      action: 'sos.' + status,
      entity: 'sos_event',
      entityId: id,
      diff: { status, subject: subjectName },
    });

    return { ok: true, status, subjectName };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[safety] resolveSos failed -', reason);
    return { ok: false, reason };
  }
}

/**
 * The witness list an SOS captured, as an array whatever the driver handed back.
 *
 * `nearby_users` is written as a JSON string and read back as either a string or a parsed object
 * depending on the column type on that deployment. Parsing failure returns [] AND says so, so the
 * console can print "the witness list could not be read" instead of "no witnesses" — on an
 * emergency record those are very different sentences.
 */
export function parseNearby(raw: unknown): { ok: boolean; list: any[] } {
  if (raw == null || raw === '') return { ok: true, list: [] };
  if (Array.isArray(raw)) return { ok: true, list: raw };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { ok: true, list: parsed } : { ok: false, list: [] };
    } catch {
      return { ok: false, list: [] };
    }
  }
  return { ok: false, list: [] };
}
