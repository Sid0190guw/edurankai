// src/lib/meet-schema.ts — THE ONE PLACE THE `meet_*` TABLES ARE CREATED.
//
// WHY THIS FILE EXISTS. `meet_rooms` and `meet_participants` were CREATEd by two pages of the SAME
// meeting platform, with two incompatible shapes, in the same commit (f9b5fd6, 2026-06-09):
//
//   src/pages/portal/meet/index.astro   — the scheduler/lobby
//       meet_rooms.id TEXT PRIMARY KEY, host_user_id INTEGER NOT NULL, duration_min,
//       description / host_name / host_email / waiting_room / record_on_default /
//       breakouts_enabled / attendee_mute_default / raise_hand_enabled / recurrence / invitees
//   src/pages/portal/meet/[id].astro    — the room itself
//       meet_rooms.id UUID PRIMARY KEY DEFAULT gen_random_uuid(), host_user_id UUID,
//       duration_minutes, is_locked / recording_enabled / recording_url / max_participants /
//       features
//
// CREATE TABLE IF NOT EXISTS is a NO-OP on an existing table. Whichever page was visited first on a
// given database owns the table and the other one has been failing ever since. Both failures are
// silent: the scheduler's SELECT names columns the room shape does not have and is wrapped in
// `catch (_) { upcoming = []; }`, so it renders "no meetings" forever; the room page's INSERT is not
// wrapped at all, so under the scheduler shape it 500s the room.
//
// WHICH SHAPE IS LIVE — inferred from the repository, NOT verified against the database (no agent on
// this project connects to it; CLAUDE.md). The evidence is decisive in one direction:
//
//   * NOTHING IN THE REPOSITORY CAN WRITE THE SCHEDULER SHAPE. Its `host_user_id` is INTEGER NOT
//     NULL and every user id in this product is a UUID string, so an INSERT throws on the column
//     type before it reaches the NOT NULL. The scheduler page itself never INSERTs — its "save
//     meeting" form POSTs to /api/meet/rooms, a route that did not exist until this build. So a
//     database that took the scheduler shape holds ZERO rows in meet_rooms.
//   * The ROOM page is the only writer there has ever been, and it writes UUIDs.
//   * Every other consumer is written against UUID: src/lib/huddle-session.ts:36
//     (`WHERE id = ${roomId}::uuid`), /api/portal/meet/[room]/anim.ts and .../breakout.ts, and the
//     meet_chat / meet_polls / meet_breakouts children, whose room_id columns are UUID and are
//     created in one place only.
//
// Conclusion: the UUID shape is canonical. It is the only shape that has ever held a row, and it is
// the shape the rest of the module is written against.
//
// WHAT THIS MODULE DOES ABOUT IT. It reconciles ADDITIVELY. Every column either page needs is added
// with ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Nothing is dropped, nothing is renamed, no row is
// rewritten and no column type is altered — ALTER COLUMN ... TYPE is a full table rewrite, which is
// exactly what this build is forbidden to do against unknown production state.
//
// THE ONE THING ADDITIVE CANNOT REACH, STATED PLAINLY: if a database really did take the scheduler
// shape, `id` is TEXT and `host_user_id` is INTEGER and no ALTER ... ADD COLUMN changes that. The
// module DETECTS it (getMeetShape().roomIdIsUuid) and the surfaces say so rather than throwing; the
// fix is a human-run migration, handed over and not improvised here. On the canonical shape — and on
// every fresh database, which this module now creates unified so the split can never recur — every
// column both surfaces read exists and both work.
//
// ROOM CODES, and a real bug this closes. The scheduler generates a 10-character human code
// ("HKD3M7QP2R") and sends the browser to /portal/meet/<code>. The room page only recognised a UUID,
// so a code fell through to its "create a room" branch with a FRESH gen_random_uuid() — meaning two
// people typing the SAME code each got their OWN empty room and never met. `room_code` is the
// additive column that fixes it: it is the handle in the URL, it is UNIQUE, and it exists under
// either id type. Look a room up with roomLookupSql(); never compare the URL segment to `id` alone.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logEvent } from '@/lib/logger';

// Declared before every function that uses them: `const` is not hoisted, and a handler that reaches
// a later declaration has taken pages down on this project.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** The one surface where a meeting is scheduled, and the one where it is held. */
export const MEET_INDEX_HREF = '/portal/meet';
export const MEET_ROOM_HREF = '/portal/meet/';

export interface MeetShape {
  /** Did the table exist before this process ensured it? */
  existed: boolean;
  /** True when meet_rooms.id is UUID — the canonical shape. False means the legacy TEXT shape. */
  roomIdIsUuid: boolean;
  /** True when meet_rooms.host_user_id is UUID. False on the legacy INTEGER column. */
  hostIsUuid: boolean;
  /**
   * Can this database accept a NEW meeting? False only on the legacy shape, where host_user_id is
   * INTEGER and cannot hold a users.id. Surfaces check this and say something true instead of
   * handing the person a 500.
   */
  writable: boolean;
}

// The shape this process found. Populated by run(); read through getMeetShape() AFTER awaiting
// ensureMeetSchema(), never before — ensureOnce hands back a Promise<void>, so the shape cannot
// travel out through its return value.
let detected: MeetShape = { existed: false, roomIdIsUuid: true, hostIsUuid: true, writable: true };

/**
 * Did the ensure itself fail?
 *
 * ensureOnce() deliberately SWALLOWS the rejection it hands back (src/lib/ensure-once.ts:24) so that
 * callers keep their "tolerate missing schema" behaviour — which means `try { await
 * ensureMeetSchema() } catch {}` in a caller can never fire, and a caller that assumed it could
 * would carry straight on into a write against a table that was never reconciled. This flag is how
 * the failure gets out. It is set BEFORE the rethrow in run() and cleared at the start of every
 * attempt, so a retry (ensureOnce drops a failed run from its cache) can clear it.
 */
let ensureFailed = false;

/**
 * The sentence a surface shows when the legacy shape is live. It names the one command a human
 * runs, because CLAUDE.md hands migrations over rather than running them.
 */
/** The ensure did not complete. Different fact, different sentence — never collapsed into one. */
export const MEET_UNAVAILABLE_NOTE =
  'Meetings could not be opened just now. The meeting store did not answer, so nothing has been ' +
  'scheduled or cancelled. Try again in a moment, and tell an administrator if it keeps happening.';

export const MEET_LEGACY_SHAPE_NOTE =
  'Meetings cannot be created on this database yet. The meeting store was created in an older shape ' +
  'that records a host as a number rather than as an account, so a new meeting has nowhere to record ' +
  'its owner. No meeting has been lost — there are none stored in that shape. An administrator needs ' +
  'to run the meeting-store migration before scheduling is switched on.';

async function detectRooms(): Promise<{ present: Map<string, string>; notNull: Set<string> }> {
  const r = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'meet_rooms'`);
  const present = new Map<string, string>();
  const notNull = new Set<string>();
  for (const row of rows(r)) {
    const name = String((row as any).column_name);
    present.set(name, String((row as any).data_type).toLowerCase());
    if (String((row as any).is_nullable).toUpperCase() === 'NO') notNull.add(name);
  }
  return { present, notNull };
}

async function run(): Promise<void> {
  ensureFailed = false;
  try {
    const before = await detectRooms();
    const existed = before.present.size > 0;

    if (!existed) {
      // Created UNIFIED, so a fresh database can never reproduce the split. This is the union of
      // both declarations under the canonical (UUID) types.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS meet_rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          room_code TEXT,
          host_user_id UUID,
          host_name TEXT,
          host_email TEXT,
          title TEXT,
          description TEXT,
          kind VARCHAR(20) DEFAULT 'huddle',
          scheduled_at TIMESTAMPTZ,
          duration_min INTEGER DEFAULT 30,
          duration_minutes INT DEFAULT 60,
          passcode VARCHAR(40),
          waiting_room BOOLEAN DEFAULT true,
          record_on_default BOOLEAN DEFAULT false,
          breakouts_enabled BOOLEAN DEFAULT false,
          attendee_mute_default BOOLEAN DEFAULT false,
          raise_hand_enabled BOOLEAN DEFAULT true,
          recurrence TEXT DEFAULT 'none',
          invitees JSONB DEFAULT '[]'::jsonb,
          is_locked BOOLEAN DEFAULT false,
          recording_enabled BOOLEAN DEFAULT false,
          recording_url TEXT,
          max_participants INT DEFAULT 250,
          features JSONB DEFAULT '{}'::jsonb,
          status VARCHAR(20) DEFAULT 'scheduled',
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      detected = { existed: false, roomIdIsUuid: true, hostIsUuid: true, writable: true };
    } else {
      // Whichever half is missing is added. No column is dropped, no type is altered and no row is
      // touched: a room already stored keeps every value it has and simply gains NULL columns.
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS room_code TEXT`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS host_name TEXT`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS host_email TEXT`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS title TEXT`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS description TEXT`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS kind VARCHAR(20) DEFAULT 'huddle'`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS duration_min INTEGER DEFAULT 30`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 60`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS passcode VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS waiting_room BOOLEAN DEFAULT true`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS record_on_default BOOLEAN DEFAULT false`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS breakouts_enabled BOOLEAN DEFAULT false`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS attendee_mute_default BOOLEAN DEFAULT false`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS raise_hand_enabled BOOLEAN DEFAULT true`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS recurrence TEXT DEFAULT 'none'`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS invitees JSONB DEFAULT '[]'::jsonb`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN DEFAULT false`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS recording_url TEXT`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS max_participants INT DEFAULT 250`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'::jsonb`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'scheduled'`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE meet_rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

      // `title TEXT NOT NULL` belongs to the scheduler shape only, and a room opened ad hoc has no
      // title until somebody types one. Dropping a NOT NULL removes no column and rewrites no row;
      // it is applied only where it is actually set, so this is a no-op on every later cold start.
      if (before.notNull.has('title')) {
        await db.execute(sql`ALTER TABLE meet_rooms ALTER COLUMN title DROP NOT NULL`);
      }
      if (before.notNull.has('host_user_id')) {
        await db.execute(sql`ALTER TABLE meet_rooms ALTER COLUMN host_user_id DROP NOT NULL`);
      }

      const idType = before.present.get('id') || '';
      const hostType = before.present.get('host_user_id') || '';
      const roomIdIsUuid = idType === 'uuid';
      const hostIsUuid = hostType === 'uuid';
      detected = { existed: true, roomIdIsUuid, hostIsUuid, writable: hostIsUuid };

      // The shape this process found, recorded once per cold start. This is the line that answers
      // "which CREATE won" from the logs instead of from an argument about commit dates.
      logEvent(hostIsUuid ? 'info' : 'warn', 'meet.schema.reconciled', {
        idType: idType || null,
        hostType: hostType || null,
        writable: hostIsUuid,
      });
    }

    // room_code is the handle in the URL. UNIQUE so a code resolves to exactly one room — the whole
    // point of the column. Partial, because rooms created before this build have no code and NULL is
    // not unique-constrained anyway; naming the predicate keeps the index small.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS meet_rooms_room_code_idx
        ON meet_rooms (room_code) WHERE room_code IS NOT NULL`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_meet_rooms_host ON meet_rooms (host_user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_meet_rooms_scheduled ON meet_rooms (scheduled_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_meet_rooms_status ON meet_rooms (status)`);

    // ---- the children. Each is created in ONE place — here — and in the canonical types. No FK is
    // attached to meet_rooms(id): on a legacy-shaped parent the types would not match and a failed
    // ensure would take the whole meeting platform down to gain nothing the surfaces do not check.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS meet_participants (
        room_id UUID,
        user_id UUID,
        display_name VARCHAR(200),
        email TEXT,
        role VARCHAR(20) DEFAULT 'attendee',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        left_at TIMESTAMPTZ,
        in_lobby BOOLEAN DEFAULT false,
        PRIMARY KEY (room_id, user_id)
      )`);
    await db.execute(sql`ALTER TABLE meet_participants ADD COLUMN IF NOT EXISTS email TEXT`);
    await db.execute(sql`ALTER TABLE meet_participants ADD COLUMN IF NOT EXISTS in_lobby BOOLEAN DEFAULT false`);
    await db.execute(sql`ALTER TABLE meet_participants ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS meet_recordings (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        title TEXT,
        duration_sec INTEGER DEFAULT 0,
        attendees_count INTEGER DEFAULT 0,
        transcript_available BOOLEAN DEFAULT false,
        blob_url TEXT,
        thumbnail_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_meet_recordings_room ON meet_recordings (room_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS meet_chat (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID,
        user_id UUID,
        body TEXT,
        is_private_to UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS meet_polls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID,
        question TEXT,
        options JSONB DEFAULT '[]'::jsonb,
        votes JSONB DEFAULT '{}'::jsonb,
        status VARCHAR(20) DEFAULT 'live',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS meet_breakouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID,
        label VARCHAR(120),
        participants JSONB DEFAULT '[]'::jsonb,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
  } catch (e: any) {
    // Recorded, logged, and THEN rethrown. ensureOnce drops a failed run from its cache so the next
    // request retries; without these two lines that retry would be the only trace that anything went
    // wrong — and because ensureOnce swallows the rejection, a caller's own catch never fires.
    ensureFailed = true;
    logEvent('error', 'meet.schema.ensure-failed', { message: reason(e) });
    throw e;
  }
}

/**
 * Create/reconcile the meeting tables, at most once per server process.
 *
 * Every surface that touches a meeting calls THIS — /portal/meet, /portal/meet/[id] and the
 * endpoints under /api/meet/. No other module may CREATE these tables; adding a second one recreates
 * the exact defect this file was written to remove.
 */
export function ensureMeetSchema(): Promise<void> {
  return ensureOnce('meet.schema.unified.v1', run);
}

/**
 * The shape this process found. Only meaningful AFTER `await ensureMeetSchema()`.
 *
 * `writable` is false when the ensure FAILED as well as when the legacy shape is live: a surface
 * must not write to a table nobody has confirmed the shape of, and a failed ensure is exactly that.
 */
export function getMeetShape(): MeetShape {
  if (ensureFailed) return { ...detected, writable: false };
  return detected;
}

/**
 * Find a room from the segment in the URL.
 *
 * The segment is a room CODE for anything the scheduler made and a UUID for a room opened directly,
 * and both must resolve. `id::text` rather than `${code}::uuid`: casting the PARAMETER throws on a
 * non-uuid string, and casting the COLUMN is safe under either id type — the same rule this project
 * already applies to departments.id.
 *
 * lower() ON BOTH SIDES OF THE ID ARM, and this is not cosmetic. Every caller normalises the URL
 * segment through normaliseRoomCode(), which UPPERCASES — correct for a room code, whose alphabet is
 * uppercase by construction, and fatal for a uuid, because Postgres renders `uuid::text` in
 * LOWERCASE hex. `id::text = 'A3F1…'` is therefore false for the very row it is looking for. The
 * consequence was silent and specific: every room that predates room_code (all of them — the only
 * writer before this build was the ad-hoc INSERT in the room page, which stored no code) is
 * addressed by its uuid, so Edit and Cancel answered 404 on it, and opening /portal/meet/<uuid>
 * failed to find it and created a SECOND empty room beside it. One code, one room means one uuid,
 * one room too.
 */
export function roomLookupSql(segment: string) {
  return sql`(room_code = ${segment} OR lower(id::text) = lower(${segment}))`;
}

/**
 * Why can this database not take a new meeting? Null when it can.
 *
 * One place, so the scheduler and the room cannot describe the same condition differently — and so
 * a failed ensure is never reported as "your database is an old shape", which would send somebody
 * to write a migration for a problem that was a dropped connection.
 */
export function meetBlockReason(): string | null {
  if (ensureFailed) return MEET_UNAVAILABLE_NOTE;
  if (!getMeetShape().writable) return MEET_LEGACY_SHAPE_NOTE;
  return null;
}

/** A room code: the 10-character alphabet the scheduler's client already generates. */
export function normaliseRoomCode(raw: string): string {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}
