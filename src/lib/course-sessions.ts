// src/lib/course-sessions.ts — SCHEDULED LIVE SESSIONS ON A COURSE. One module, one table, one gate.
//
// WHAT THIS IS BUILT ON, AND WHY NOTHING NEW WAS CREATED FOR IT
// -------------------------------------------------------------
// `live_classes` already existed and already carried `course_id`, `scheduled_at`, `duration_minutes`,
// `meet_url`, `recording_url`, `capacity`, `enrolled_count` and `status`, with seat reservation and a
// bootstrap in src/pages/portal/liveclass.astro. Nothing had ever written `course_id` — the column
// was a promise with no writer, the same shape as the partial-waiver columns fee-waiver.ts documents.
// This module is that writer. A `course_sessions` table would have been a second timetable for
// /portal/liveclass, /portal/parent and src/lib/calendar-hub.ts to disagree about.
//
// Four columns are ADDED, additively, nothing dropped:
//   mode              'in_house' | 'external' — where the session actually happens
//   time_zone         the IANA zone the organiser scheduled in (see TIME, below)
//   board_session_id  for an in-house session: the live board session it drives
//   is_recorded       whether a recording is expected, which is not the same as one existing
//
// IN-HOUSE MEANS THE BOARD THAT ALREADY EXISTS. src/lib/board-session.ts persists a fired spec and
// streams it over DB-backed SSE; /aquintutor/board is the teacher's surface and
// /aquintutor/board/live?session=ID is the learner's. Its `session_id` is free-form TEXT bound to
// nothing, and there has never been any authorisation over WHO MAY JOIN one. That is precisely the
// missing piece, and boardSessionGate() below is it: once a board session belongs to a course
// session, only somebody entitled to that course may follow it.
//
// WHAT WAS *NOT* REUSED, AND WHY — /aquintutor/classroom/live.astro looks like the obvious in-house
// classroom and is not one: it is presentational, with three hard-coded student names and a
// hard-coded slide deck, and its own header says so. Pointing learners at it would be a demo dressed
// as a class. meet_rooms + huddle-session.ts IS real, but its transport is a WebRTC mesh that
// docs/huddle-sfu-followup.md says needs an SFU before many-video works — a cohort-sized lecture is
// exactly the case it does not yet carry. The board carries a cohort today because it broadcasts a
// spec rather than pixels. An organiser who needs faces schedules an EXTERNAL session and pastes a
// link, which is the honest answer rather than a room that collapses at class size.
//
// THE LINK IS NEVER IN THE PAGE. Every read function here returns `hasLink: boolean` and no URL. A
// URL exists in exactly one function — resolveJoinTarget() — which re-resolves entitlement on the
// request that asks for it. That is a structural guarantee: a surface CANNOT render a join link into
// HTML and hide it with CSS, because no surface is ever handed one.
//
// URL VALIDATION IS NOT DONE HERE. src/lib/video-embed.ts is this codebase's URL guard and it was
// written for the lesson-video work in the same pass; a recording is a video link like any other and
// goes through the same resolveVideoLink(), with the same scheme rules, the same allowlist and the
// same sandbox attributes. Meeting links go through safeResourceUrl() from that module. Writing a
// second validator here would have left the two renderers it already fixed guarded by one policy and
// this one by another. Note that video-embed.ts REFUSES a conferencing address in a video field with
// "add it as a live session instead" — that sentence points at this file, and the two halves meet.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { resolveVideoLink, safeResourceUrl, type VideoLinkKind } from '@/lib/video-embed';
import { pricingFromRow, priceForUser } from '@/lib/course-pricing';

// Declared before every function that uses them: `const` is not hoisted, and a handler reaching a
// later declaration throws on its first line while the page above it still looks fine.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any): void => { console.error('[course-sessions] ' + tag + ' -', reasonOf(e)); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v);

/**
 * How long before the start time the join link opens.
 *
 * /portal/liveclass has told learners "receive a join link 15 minutes before start" since it was
 * written, so this is the number the copy already promised rather than a new invention.
 */
export const JOIN_OPENS_MINUTES = 15;

/** How long after the scheduled end a session is still joinable. Sessions over-run. */
export const JOIN_GRACE_MINUTES = 20;

/** The word this product uses for a conferencing address. Never a brand, on any surface. */
export const MEETING_LINK_LABEL = 'meeting link';

export type SessionMode = 'in_house' | 'external';
export type SessionState = 'scheduled' | 'open' | 'live' | 'ended' | 'cancelled';

/** How a page should present a recording. Carries NO url — the url comes from the join endpoint. */
export interface RecordingPresentation {
  kind: VideoLinkKind;
  /** Brand-free sentence from video-embed.ts. Safe to print. */
  description: string;
  sandbox: string;
  allow: string;
  referrerPolicy: string;
}

/**
 * What a SURFACE is allowed to know about a session. Note what is absent: meet_url,
 * board_session_id and recording_url. A page cannot leak what it was never given.
 */
export interface CourseSessionView {
  id: string;
  courseId: string;
  title: string;
  subject: string | null;
  /** The instant, always UTC. The wall clock a person reads is derived from this plus timeZone. */
  startIso: string;
  durationMinutes: number;
  timeZone: string;
  mode: SessionMode;
  hostUserId: string | null;
  hostName: string | null;
  capacity: number;
  enrolled: number;
  /** A recording is expected. NOT the same as one existing — see recording. */
  isRecorded: boolean;
  /** A join target exists at all (a pasted link, or an in-house room). */
  hasLink: boolean;
  /** How to render the recording, when there is one that validates. Null when there is none. */
  recording: RecordingPresentation | null;
  /** Set when a recording IS stored but will not validate. The organiser has to know. */
  recordingProblem: string;
  status: string;
}

/** The same row for the ORGANISER, who may see and edit the link they pasted. */
export interface CourseSessionAdminView extends CourseSessionView {
  meetUrl: string | null;
  boardSessionId: string | null;
  recordingUrl: string | null;
}

// ---------------------------------------------------------------------------------------------
// TIME. A start time without a zone is a bug waiting for the first learner in another country.
// ---------------------------------------------------------------------------------------------
//
// TWO FACTS ARE STORED, not one. `scheduled_at` is TIMESTAMPTZ — an instant, unambiguous, the thing
// a countdown subtracts from. `time_zone` is the IANA zone the organiser was thinking in, which the
// instant alone cannot recover: 18:30 UTC does not remember that it was "half six in Delhi", and a
// session edited later by a colleague in another office has to keep the class's own clock. Rendering
// only in the viewer's local time would be no better: a learner shown "14:00" with no zone, by a
// server in a third zone, has no way to check the number.
//
// /portal/liveclass formats every class with a hard-coded `timeZone: 'Asia/Kolkata'` today. That is
// right for most of this platform's learners and silently wrong for the rest. Sessions written
// through this module carry their own zone and are rendered in it, with the zone named, and the page
// additionally offers the reader's own local time from the instant.

/** A short list for a picker. Any valid IANA zone is accepted by the writers — this is convenience. */
export const COMMON_TIME_ZONES: string[] = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai',
  'Europe/London', 'Europe/Zurich', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Africa/Nairobi', 'Africa/Lagos', 'Africa/Johannesburg',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** Does the runtime know this zone? Intl throws on an unknown one, which is the whole test. */
export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The offset, in ms, that `tz` was at the given instant. Positive east of UTC. */
function zoneOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // Some engines render midnight as hour 24 under hour12:false. Left unhandled that puts a session a
  // day out, once a day, for the people least likely to be believed when they report it.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(parts.year, (parts.month || 1) - 1, parts.day, hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

/**
 * A wall clock in a named zone -> the instant it denotes.
 *
 * `local` is exactly what an <input type="datetime-local"> submits: "2026-08-14T18:30". It carries no
 * zone, which is why the organiser must also choose one.
 *
 * Two passes, deliberately. The offset depends on the instant and the instant is what we are solving
 * for; near a DST changeover one pass lands an hour out. The second pass re-reads the offset at the
 * candidate instant and converges. A time inside a spring-forward gap does not exist at all — the
 * result is the instant the clock jumps to, which is what every calendar does.
 */
export function zonedWallTimeToUtc(local: string, tz: string): { ok: boolean; iso: string; reason: string } {
  const s = String(local || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return { ok: false, iso: '', reason: 'That start time could not be read.' };
  }
  if (!isValidTimeZone(tz)) {
    return { ok: false, iso: '', reason: 'That time zone is not one this server recognises.' };
  }
  const naive = Date.parse(s.length === 16 ? s + ':00Z' : s + 'Z');
  if (!Number.isFinite(naive)) return { ok: false, iso: '', reason: 'That start time could not be read.' };
  let guess = naive - zoneOffsetMs(new Date(naive), tz);
  guess = naive - zoneOffsetMs(new Date(guess), tz);
  const d = new Date(guess);
  if (!Number.isFinite(d.getTime())) return { ok: false, iso: '', reason: 'That start time could not be read.' };
  return { ok: true, iso: d.toISOString(), reason: '' };
}

/** The instant, written as the wall clock of `tz`, with the zone named. Never a bare number. */
export function formatInZone(iso: string, tz: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

/** The wall clock an <input type="datetime-local"> wants, for editing an existing session. */
export function utcToZonedWallTime(iso: string, tz: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const off = zoneOffsetMs(d, zone);
  return new Date(d.getTime() + off).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// STATE. Pure, so it is testable without a database and cannot disagree with itself between the page
// that draws the badge and the endpoint that hands out the link.
// ---------------------------------------------------------------------------------------------

export function sessionState(
  input: { startIso: string; durationMinutes: number; status?: string | null },
  now: number = Date.now(),
): SessionState {
  const status = String(input.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  const start = Date.parse(input.startIso);
  if (!Number.isFinite(start)) return 'scheduled';
  const dur = Number(input.durationMinutes) > 0 ? Number(input.durationMinutes) : 60;
  const end = start + dur * 60000;
  if (status === 'ended' || now >= end + JOIN_GRACE_MINUTES * 60000) return 'ended';
  if (now >= start) return 'live';
  if (now >= start - JOIN_OPENS_MINUTES * 60000) return 'open';
  return 'scheduled';
}

/** May the join link be handed out at all, on state alone? Entitlement is a separate question. */
export function joinableState(state: SessionState): boolean {
  return state === 'open' || state === 'live';
}

/** "in 2 days", "in 3h 10m", "starting now". The page also ticks this client-side from the instant. */
export function countdownLabel(startIso: string, now: number = Date.now()): string {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return '';
  const diff = start - now;
  if (diff <= 0) return 'starting now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return 'in ' + m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return 'in ' + h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return 'in ' + d + (d === 1 ? ' day' : ' days');
}

/** The words a learner reads for each state. One wording, everywhere. */
export function stateLabel(state: SessionState): string {
  if (state === 'cancelled') return 'Cancelled';
  if (state === 'ended') return 'Finished';
  if (state === 'live') return 'Happening now';
  if (state === 'open') return 'Open now';
  return 'Not open yet';
}

// ---------------------------------------------------------------------------------------------
// LINKS IN. A meeting address, validated by the module that validates every other address here.
// ---------------------------------------------------------------------------------------------

const MEETING_URL_REFUSED =
  'A ' + MEETING_LINK_LABEL + ' has to be a full https:// address on a public host, with no user ' +
  'name or password in it. Copy it from the invitation.';

/**
 * A pasted conferencing address.
 *
 * EVERY conferencing product is accepted and none is named: this platform has no business having an
 * opinion about which one a partner uses, and the survey for this work was explicit that the founder
 * will paste links from several. safeResourceUrl() (src/lib/video-embed.ts) applies the rules that
 * actually matter — https only, no embedded credentials, no loopback, no IP literal, no bare host —
 * and it is the same function guarding image and attachment addresses, so there is one policy.
 *
 * A same-origin PATH is refused here even though safeResourceUrl allows one: an external session is
 * external by definition, and a path in that field is a mistake worth catching at the form.
 */
export function meetingUrlVerdict(raw: unknown): { ok: boolean; url: string; reason: string } {
  const u = safeResourceUrl(raw);
  if (!u) return { ok: false, url: '', reason: MEETING_URL_REFUSED };
  if (!/^https:\/\//i.test(u)) {
    return { ok: false, url: '', reason: 'That looks like a page on this platform. Choose the in-house mode instead of pasting a ' + MEETING_LINK_LABEL + '.' };
  }
  return { ok: true, url: u, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// SCHEMA. Additive. Verified — never trusted.
// ---------------------------------------------------------------------------------------------
//
// src/lib/ensure-once.ts SWALLOWS a failed DDL run by design (its callers were written to tolerate a
// missing table), so its resolution proves nothing and this function does not treat it as proof: it
// asks information_schema what actually exists and reports what does not. A caller that gets
// `ok: false` must say so on the screen instead of drawing an empty list — "no sessions" and "the
// timetable has no mode column" are different sentences and only one of them is about the course.

const REQUIRED_COLUMNS = [
  'id', 'course_id', 'title', 'subject', 'scheduled_at', 'duration_minutes', 'meet_url',
  'status', 'host_user_id', 'capacity', 'enrolled_count', 'recording_url',
  'mode', 'time_zone', 'board_session_id', 'is_recorded',
];

export interface SchemaCheck { ok: boolean; missing: string[]; error: string | null }

let schemaVerified: SchemaCheck | null = null;

export async function ensureCourseSessionSchema(): Promise<SchemaCheck> {
  if (schemaVerified && schemaVerified.ok) return schemaVerified;

  await ensureOnce('course_sessions_v1', async () => {
    // The base table is created with the SAME definition src/pages/portal/liveclass.astro uses, so
    // whichever surface a process touches first, the other finds what it expects.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS live_classes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_user_id UUID,
        title TEXT,
        subject VARCHAR(120),
        course_id UUID,
        scheduled_at TIMESTAMPTZ,
        duration_minutes INT DEFAULT 60,
        meet_url TEXT,
        status VARCHAR(20) DEFAULT 'scheduled',
        capacity INT DEFAULT 50,
        enrolled_count INT DEFAULT 0,
        recording_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS live_class_enrollments (
        class_id UUID,
        user_id UUID,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY(class_id, user_id)
      )`);
    await db.execute(sql`ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS mode VARCHAR(12) DEFAULT 'external'`);
    await db.execute(sql`ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS time_zone TEXT`);
    await db.execute(sql`ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS board_session_id TEXT`);
    await db.execute(sql`ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS is_recorded BOOLEAN DEFAULT false`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS live_classes_course_idx ON live_classes (course_id, scheduled_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS live_classes_board_idx ON live_classes (board_session_id)`);
  });

  try {
    const present = rowsOf(await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'live_classes'`)).map((r: any) => String(r.column_name));
    const missing = REQUIRED_COLUMNS.filter((c) => present.indexOf(c) < 0);
    const result: SchemaCheck = {
      ok: present.length > 0 && missing.length === 0,
      missing: present.length === 0 ? REQUIRED_COLUMNS.slice() : missing,
      error: present.length === 0 ? 'The live_classes table does not exist.' : null,
    };
    if (result.ok) schemaVerified = result;
    else console.error('[course-sessions] schema NOT complete; missing:', result.missing.join(', '));
    return result;
  } catch (e: any) {
    logFail('schema verification', e);
    return { ok: false, missing: REQUIRED_COLUMNS.slice(), error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// ENTITLEMENT. Server-side, on every request for a link.
// ---------------------------------------------------------------------------------------------

export type EntitlementBasis = 'host' | 'organiser' | 'free' | 'paid' | 'waived' | null;

export interface Entitlement {
  ok: boolean;
  basis: EntitlementBasis;
  /** A sentence a person can read. Empty when ok. */
  reason: string;
  /** True only when the answer was "we could not tell" — a 503, not a 403. */
  retryable: boolean;
  enrolled: boolean;
}

const NOT_ENROLLED =
  'This session is for people enrolled on the course. Open the course and enrol, and it appears here.';
const NOT_PAID =
  'This course is paid, and no completed payment or approved waiver is recorded against your account, ' +
  'so the session link has not been shown. If you have paid, open the course page — an interrupted ' +
  'payment is picked up there.';
const NOT_AUDIENCE =
  'This course is not open to your account, so its sessions are not shown.';
const CANNOT_TELL =
  'We could not confirm your enrolment just now, so the link has not been shown. Nothing has changed ' +
  'about your place on the course. Try again in a moment.';

/**
 * May this person be shown the join link for this course?
 *
 * THE RULE, in the order it is applied:
 *   1. The host of the session, and anyone holding the capability that schedules sessions, may.
 *   2. Everyone else must have an enrolment row. Enrolment is the floor, not the ceiling.
 *   3. If this person owes NOTHING for the course — it is free, or they are inside the audience an
 *      employees-free course is free for — enrolment is enough.
 *   4. If they owe something, enrolment is NOT enough: there must also be a captured, non-refunded
 *      payment against this course, or the zero-value receipt an approved waiver writes.
 *
 * WHAT DECIDES "OWES NOTHING" IS NOT DECIDED HERE. src/lib/course-pricing.ts owns the four fee
 * models and priceForUser() is its answer; asking it means a course that is free for the team stays
 * free for the team on this screen too, instead of this file inventing a fifth opinion about price.
 *
 * WHY RULE 4 EXISTS AS WRITTEN, and this is the uncomfortable part: /portal/courses/[slug].astro
 * auto-enrols every signed-in reader on page load (ensureEnrolment). So "enrolled" alone is a fact
 * anyone can manufacture by opening a URL, and a paid course that released its link on enrolment
 * would be given away by the first person who navigated to it. Reading the payment directly does not
 * wait on that being fixed, and it keeps working unchanged when it is.
 *
 * A WAIVER IS RECOGNISED BY ITS RECEIPT. src/lib/fee-waiver.ts materialises an approved waiver as a
 * zero-amount, status 'paid' row in `payments` so /receipt/[order] renders. That row is what is
 * matched here, which means a course-scoped waiver starts working the moment the waiver side points
 * one at a training_course — with no change to this file. `application_fee_waivers` itself is NOT
 * read: it has no course reference today, and inventing one here would be a second opinion about a
 * table this module does not own.
 *
 * FAILS CLOSED. Every error path denies and sets retryable; none of them grants.
 */
export async function courseEntitlement(
  user: any,
  courseId: string,
  opts: { sessionHostUserId?: string | null; isOrganiser?: boolean } = {},
): Promise<Entitlement> {
  const userId = String(user?.id || '');
  if (!userId) {
    return { ok: false, basis: null, reason: 'Please sign in to open this session.', retryable: false, enrolled: false };
  }
  if (opts.sessionHostUserId && String(opts.sessionHostUserId) === userId) {
    return { ok: true, basis: 'host', reason: '', retryable: false, enrolled: true };
  }
  if (opts.isOrganiser === true) {
    return { ok: true, basis: 'organiser', reason: '', retryable: false, enrolled: false };
  }
  if (!isUuid(courseId)) {
    return { ok: false, basis: null, reason: NOT_ENROLLED, retryable: false, enrolled: false };
  }

  try {
    const row = rowsOf(await db.execute(sql`
      SELECT c.*,
        EXISTS (
          SELECT 1 FROM training_enrollments e
           WHERE e.course_id::text = c.id::text AND e.user_id::text = ${userId}
        ) AS is_enrolled,
        EXISTS (
          SELECT 1 FROM payments p
           WHERE p.user_id::text = ${userId}
             AND p.reference_type = 'training_course'
             AND p.reference_id::text = c.id::text
             AND p.status = 'paid'
             AND COALESCE(p.amount_paise, 0) > 0
        ) AS has_payment,
        EXISTS (
          SELECT 1 FROM payments p
           WHERE p.user_id::text = ${userId}
             AND p.reference_type = 'training_course'
             AND p.reference_id::text = c.id::text
             AND p.status = 'paid'
             AND COALESCE(p.amount_paise, 0) = 0
        ) AS has_waiver_receipt
      FROM training_courses c
     WHERE c.id::text = ${courseId}
     LIMIT 1`))[0];

    if (!row) {
      return { ok: false, basis: null, reason: NOT_ENROLLED, retryable: false, enrolled: false };
    }

    if (row.is_enrolled !== true) {
      return { ok: false, basis: null, reason: NOT_ENROLLED, retryable: false, enrolled: false };
    }

    const price = priceForUser(pricingFromRow(row), { id: userId, role: user?.role });
    if (!price.allowed) {
      return { ok: false, basis: null, reason: NOT_AUDIENCE, retryable: false, enrolled: true };
    }
    if (price.free) {
      return { ok: true, basis: 'free', reason: '', retryable: false, enrolled: true };
    }
    if (row.has_payment === true) {
      return { ok: true, basis: 'paid', reason: '', retryable: false, enrolled: true };
    }
    if (row.has_waiver_receipt === true) {
      return { ok: true, basis: 'waived', reason: '', retryable: false, enrolled: true };
    }
    return { ok: false, basis: null, reason: NOT_PAID, retryable: false, enrolled: true };
  } catch (e: any) {
    logFail('entitlement course=' + courseId, e);
    return { ok: false, basis: null, reason: CANNOT_TELL, retryable: true, enrolled: false };
  }
}

/**
 * The courses whose sessions this person may be shown, in ONE query.
 *
 * /portal/liveclass lists every class in the database. The moment sessions carry a course_id, that
 * board would print a paid course's schedule — and, on the live tab, its join link — to everyone
 * signed in. This is what that page filters on. It is the same rule as courseEntitlement(), asked
 * for a set instead of a row, so the two cannot drift apart.
 *
 * THROWS on a read failure. A caller handed an empty set from a failed read would hide a learner's
 * own sessions from them and call it an empty timetable.
 */
export async function entitledCourseIds(user: any): Promise<Set<string>> {
  const out = new Set<string>();
  const userId = String(user?.id || '');
  if (!userId) return out;
  const rows = rowsOf(await db.execute(sql`
    SELECT c.*,
           EXISTS (
             SELECT 1 FROM payments p
              WHERE p.user_id::text = ${userId}
                AND p.reference_type = 'training_course'
                AND p.reference_id::text = c.id::text
                AND p.status = 'paid'
           ) AS settled
      FROM training_courses c
      JOIN training_enrollments e
        ON e.course_id::text = c.id::text AND e.user_id::text = ${userId}`));
  for (const r of rows) {
    const price = priceForUser(pricingFromRow(r), { id: userId, role: user?.role });
    if (!price.allowed) continue;
    if (price.free || r.settled === true) out.add(String(r.id));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// READS. None of these returns a URL.
// ---------------------------------------------------------------------------------------------

function recordingOf(raw: any): { presentation: RecordingPresentation | null; problem: string } {
  const stored = raw ? String(raw) : '';
  if (!stored) return { presentation: null, problem: '' };
  // allowLinkOut: a recording published on a platform we do not frame is still a real recording; the
  // learner gets an honest button rather than a refusal.
  const r = resolveVideoLink(stored, { allowLinkOut: true });
  if (!r.ok) return { presentation: null, problem: r.reason };
  return {
    presentation: {
      kind: r.kind,
      description: r.description,
      sandbox: r.sandbox,
      allow: r.allow,
      referrerPolicy: r.referrerPolicy,
    },
    problem: '',
  };
}

function toView(r: any): CourseSessionView {
  const startIso = r.scheduled_at ? new Date(r.scheduled_at).toISOString() : '';
  const rec = recordingOf(r.recording_url);
  return {
    id: String(r.id),
    courseId: r.course_id ? String(r.course_id) : '',
    title: String(r.title || 'Untitled session'),
    subject: r.subject ? String(r.subject) : null,
    startIso,
    durationMinutes: Number(r.duration_minutes || 60),
    timeZone: isValidTimeZone(r.time_zone) ? String(r.time_zone) : DEFAULT_TIME_ZONE,
    mode: r.mode === 'in_house' ? 'in_house' : 'external',
    hostUserId: r.host_user_id ? String(r.host_user_id) : null,
    hostName: r.host_name ? String(r.host_name) : null,
    capacity: Number(r.capacity || 0),
    enrolled: Number(r.enrolled_count || 0),
    isRecorded: r.is_recorded === true,
    hasLink: r.mode === 'in_house' ? !!r.board_session_id : !!r.meet_url,
    recording: rec.presentation,
    recordingProblem: rec.problem,
    status: String(r.status || 'scheduled'),
  };
}

export interface SessionListResult {
  ok: boolean;
  sessions: CourseSessionView[];
  /** Empty when ok. A sentence, so a surface never prints "no sessions" over a failed read. */
  error: string;
}

const SESSION_COLUMNS = sql`
  c.id, c.course_id, c.title, c.subject, c.scheduled_at, c.duration_minutes,
  c.status, c.capacity, c.enrolled_count, c.mode, c.time_zone, c.is_recorded,
  c.host_user_id, c.meet_url, c.board_session_id, c.recording_url`;

/** Every session on a course, soonest first. No URLs leave this function. */
export async function listCourseSessions(courseId: string): Promise<SessionListResult> {
  if (!isUuid(courseId)) return { ok: true, sessions: [], error: '' };
  const schema = await ensureCourseSessionSchema();
  if (!schema.ok) {
    return {
      ok: false, sessions: [],
      error: 'The session schedule could not be read (the timetable is missing ' + schema.missing.join(', ') + ').',
    };
  }
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT ${SESSION_COLUMNS}, u.name AS host_name
        FROM live_classes c
        LEFT JOIN users u ON u.id = c.host_user_id
       WHERE c.course_id::text = ${courseId}
       ORDER BY c.scheduled_at ASC NULLS LAST
       LIMIT 100`));
    return { ok: true, sessions: rows.map(toView), error: '' };
  } catch (e: any) {
    logFail('listCourseSessions ' + courseId, e);
    return { ok: false, sessions: [], error: 'The session schedule could not be read just now.' };
  }
}

/**
 * The organiser's view — WITH the link, because the person who pasted it has to be able to check and
 * replace it. Every caller must already have passed canAccessSection(user, 'lms', 'edit'); this
 * function does not re-ask, and its name is long so that a call from anywhere else reads wrong.
 */
export async function listCourseSessionsForOrganiser(
  courseId: string,
): Promise<{ ok: boolean; sessions: CourseSessionAdminView[]; error: string }> {
  const base = await listCourseSessions(courseId);
  if (!base.ok) return { ok: false, sessions: [], error: base.error };
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, meet_url, board_session_id, recording_url FROM live_classes
       WHERE course_id::text = ${courseId}`));
    const extra = new Map<string, any>();
    for (const r of rows) extra.set(String(r.id), r);
    return {
      ok: true,
      error: '',
      sessions: base.sessions.map((s) => {
        const e = extra.get(s.id) || {};
        return {
          ...s,
          meetUrl: e.meet_url ? String(e.meet_url) : null,
          boardSessionId: e.board_session_id ? String(e.board_session_id) : null,
          recordingUrl: e.recording_url ? String(e.recording_url) : null,
        };
      }),
    };
  } catch (e: any) {
    logFail('listCourseSessionsForOrganiser ' + courseId, e);
    return { ok: false, sessions: [], error: 'The session schedule could not be read just now.' };
  }
}

/** Sessions across every course this learner is entitled to. The portal timetable reads this. */
export async function myCourseSessions(user: any, limit = 40): Promise<SessionListResult> {
  const schema = await ensureCourseSessionSchema();
  if (!schema.ok) return { ok: false, sessions: [], error: 'The session schedule could not be read.' };
  try {
    const allowed = await entitledCourseIds(user);
    if (allowed.size === 0) return { ok: true, sessions: [], error: '' };
    const rows = rowsOf(await db.execute(sql`
      SELECT ${SESSION_COLUMNS}, u.name AS host_name
        FROM live_classes c
        LEFT JOIN users u ON u.id = c.host_user_id
       WHERE c.course_id IS NOT NULL
       ORDER BY c.scheduled_at ASC NULLS LAST
       LIMIT 300`));
    const mine = rows.filter((r: any) => allowed.has(String(r.course_id))).slice(0, limit);
    return { ok: true, sessions: mine.map(toView), error: '' };
  } catch (e: any) {
    logFail('myCourseSessions', e);
    return { ok: false, sessions: [], error: 'Your sessions could not be read just now.' };
  }
}

// ---------------------------------------------------------------------------------------------
// THE ONLY FUNCTION THAT RETURNS A URL.
// ---------------------------------------------------------------------------------------------

export interface JoinTarget {
  ok: boolean;
  /** Where to send them. Empty unless ok. */
  url: string;
  /** How the caller should present it, from video-embed.ts. 'link' for a meeting or a board. */
  kind: VideoLinkKind | null;
  reason: string;
  /** 401 / 403 / 404 / 409 / 503 — decided here so every caller answers the same way. */
  status: number;
}

/**
 * Resolve the join link (or the recording) for one session, for one person, right now.
 *
 * Entitlement is resolved ON THIS CALL, from the database, every time. Nothing is cached, nothing is
 * carried in the URL, and no caller can pass "I already checked".
 */
export async function resolveJoinTarget(
  user: any,
  sessionId: string,
  what: 'join' | 'recording' = 'join',
  opts: { isOrganiser?: boolean; now?: number } = {},
): Promise<JoinTarget> {
  const now = opts.now ?? Date.now();
  if (!user?.id) return { ok: false, url: '', kind: null, reason: 'Please sign in.', status: 401 };
  if (!isUuid(sessionId)) return { ok: false, url: '', kind: null, reason: 'That session does not exist.', status: 404 };

  const schema = await ensureCourseSessionSchema();
  if (!schema.ok) {
    return { ok: false, url: '', kind: null, status: 503, reason: 'The session schedule is unavailable just now. Nothing has changed.' };
  }

  let row: any;
  try {
    row = rowsOf(await db.execute(sql`
      SELECT id, course_id, title, scheduled_at, duration_minutes, status, mode, time_zone,
             meet_url, board_session_id, recording_url, host_user_id
        FROM live_classes WHERE id::text = ${sessionId} LIMIT 1`))[0];
  } catch (e: any) {
    logFail('resolveJoinTarget read ' + sessionId, e);
    return { ok: false, url: '', kind: null, status: 503, reason: 'That session could not be read just now. Try again in a moment.' };
  }
  if (!row) return { ok: false, url: '', kind: null, reason: 'That session does not exist.', status: 404 };

  // A session with no course is one of the older, course-less classes on /portal/liveclass. It is not
  // this module's to hand out, and saying so beats pretending it is missing.
  if (!row.course_id) {
    return { ok: false, url: '', kind: null, status: 404, reason: 'That session is not attached to a course.' };
  }

  const ent = await courseEntitlement(user, String(row.course_id), {
    sessionHostUserId: row.host_user_id ? String(row.host_user_id) : null,
    isOrganiser: opts.isOrganiser === true,
  });
  if (!ent.ok) {
    return { ok: false, url: '', kind: null, reason: ent.reason, status: ent.retryable ? 503 : 403 };
  }

  const startIso = row.scheduled_at ? new Date(row.scheduled_at).toISOString() : '';
  const state = sessionState({ startIso, durationMinutes: Number(row.duration_minutes || 60), status: row.status }, now);

  if (what === 'recording') {
    if (!row.recording_url) {
      return { ok: false, url: '', kind: null, status: 404, reason: 'No recording has been added for this session yet.' };
    }
    const v = resolveVideoLink(row.recording_url, { allowLinkOut: true });
    if (!v.ok) {
      console.error('[course-sessions] session', sessionId, 'has a recording address that failed validation -', v.reason);
      return { ok: false, url: '', kind: null, status: 409, reason: 'The recording address saved for this session is not one we can open.' };
    }
    return { ok: true, url: v.embedUrl, kind: v.kind, reason: '', status: 302 };
  }

  if (state === 'cancelled') return { ok: false, url: '', kind: null, status: 409, reason: 'This session was cancelled.' };
  if (state === 'ended') {
    return { ok: false, url: '', kind: null, status: 409, reason: 'This session has finished. If a recording is added it appears on the course page.' };
  }
  if (!joinableState(state)) {
    return {
      ok: false, url: '', kind: null, status: 409,
      reason: 'This session is not open yet. The link opens ' + JOIN_OPENS_MINUTES + ' minutes before it starts.',
    };
  }

  if (row.mode === 'in_house') {
    const bs = String(row.board_session_id || '').trim();
    if (!bs) {
      return { ok: false, url: '', kind: null, status: 409, reason: 'This session has no room yet. The organiser has been told.' };
    }
    // An in-house session IS the live board: a spec-driven broadcast, not a video stream.
    return { ok: true, url: '/aquintutor/board/live?session=' + encodeURIComponent(bs), kind: 'internal', reason: '', status: 302 };
  }

  const v = meetingUrlVerdict(row.meet_url);
  if (!v.ok) {
    if (!row.meet_url) {
      return { ok: false, url: '', kind: null, status: 409, reason: 'This session has no ' + MEETING_LINK_LABEL + ' yet. The organiser has been told.' };
    }
    console.error('[course-sessions] session', sessionId, 'has a meeting address that failed validation -', v.reason);
    return { ok: false, url: '', kind: null, status: 409, reason: 'The ' + MEETING_LINK_LABEL + ' saved for this session is not one we can open.' };
  }
  return { ok: true, url: v.url, kind: 'link', reason: '', status: 302 };
}

/**
 * THE MISSING AUTHORISATION ON THE BOARD.
 *
 * board-session.ts keys everything on a free-form TEXT session id with no ownership model, so
 * /aquintutor/board/live?session=X has always been open to anyone signed in who knows X. Once a board
 * session belongs to a course session, that is a paid course's classroom. This answers, for one board
 * session id: is it a course session, and if so may this person be in it?
 *
 * A board session id belonging to NO course session is left exactly as it was — allowed — because
 * ad-hoc teaching boards predate this work, and refusing them would be a policy change smuggled in as
 * a mechanism one.
 */
export async function boardSessionGate(
  user: any,
  boardSessionId: string,
): Promise<{ allowed: boolean; reason: string; retryable: boolean }> {
  const bs = String(boardSessionId || '').trim();
  if (!bs) return { allowed: true, reason: '', retryable: false };
  try {
    const schema = await ensureCourseSessionSchema();
    if (!schema.ok) {
      // We cannot tell whether this board belongs to a course. Refusing every ad-hoc board because a
      // column is missing would take teaching down; the failure is logged and the pre-existing
      // behaviour kept. Said out loud rather than hidden.
      console.error('[course-sessions] boardSessionGate could not verify schema; leaving board', bs, 'as it was');
      return { allowed: true, reason: '', retryable: false };
    }
    const row = rowsOf(await db.execute(sql`
      SELECT id, course_id, host_user_id FROM live_classes
       WHERE board_session_id = ${bs} LIMIT 1`))[0];
    if (!row || !row.course_id) return { allowed: true, reason: '', retryable: false };
    const ent = await courseEntitlement(user, String(row.course_id), {
      sessionHostUserId: row.host_user_id ? String(row.host_user_id) : null,
    });
    return { allowed: ent.ok, reason: ent.reason, retryable: ent.retryable };
  } catch (e: any) {
    logFail('boardSessionGate ' + bs, e);
    return { allowed: false, reason: CANNOT_TELL, retryable: true };
  }
}

// ---------------------------------------------------------------------------------------------
// WRITES. Every one of them reports what actually happened.
// ---------------------------------------------------------------------------------------------

export interface CreateSessionInput {
  courseId: string;
  title: string;
  subject?: string;
  /** Wall clock from <input type="datetime-local">, e.g. "2026-08-14T18:30". */
  startLocal: string;
  timeZone: string;
  durationMinutes: number;
  mode: SessionMode;
  /** Only for mode 'external'. Ignored otherwise. */
  meetUrl?: string;
  isRecorded?: boolean;
  capacity?: number;
  hostUserId: string;
}

export interface WriteResult { ok: boolean; id: string | null; error: string }

function newBoardSessionId(): string {
  // Unguessable on purpose. boardSessionGate() is the real lock, but a session id reading
  // "course-<slug>-<date>" invites exactly the guessing the old meet.jit.si room name on the course
  // page used to reward.
  const g: any = globalThis as any;
  const raw = g?.crypto?.randomUUID ? g.crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  return 'cs-' + String(raw).replace(/-/g, '');
}

export async function createCourseSession(input: CreateSessionInput): Promise<WriteResult> {
  const schema = await ensureCourseSessionSchema();
  if (!schema.ok) {
    return { ok: false, id: null, error: 'The timetable is not ready (missing: ' + schema.missing.join(', ') + '). Nothing was scheduled.' };
  }
  const title = String(input.title || '').trim().slice(0, 300);
  const subject = String(input.subject || '').trim().slice(0, 120);
  if (!isUuid(input.courseId)) return { ok: false, id: null, error: 'That course could not be identified. Nothing was scheduled.' };
  if (!title) return { ok: false, id: null, error: 'A title is required.' };
  if (!isValidTimeZone(input.timeZone)) return { ok: false, id: null, error: 'Choose the time zone the session is scheduled in.' };

  const when = zonedWallTimeToUtc(input.startLocal, input.timeZone);
  if (!when.ok) return { ok: false, id: null, error: when.reason };

  const durRaw = Number(input.durationMinutes);
  const duration = Number.isFinite(durRaw) ? Math.min(600, Math.max(10, Math.round(durRaw))) : 60;
  const capRaw = Number(input.capacity);
  const capacity = Number.isFinite(capRaw) && capRaw > 0 ? Math.min(5000, Math.round(capRaw)) : 500;
  const mode: SessionMode = input.mode === 'in_house' ? 'in_house' : 'external';

  let meetUrl: string | null = null;
  let boardSessionId: string | null = null;
  if (mode === 'external') {
    const v = meetingUrlVerdict(input.meetUrl);
    if (!v.ok) {
      // A session with no reachable link is a session nobody can attend. Refuse at the form rather
      // than write a row whose Join button will never do anything.
      return { ok: false, id: null, error: v.reason };
    }
    meetUrl = v.url;
  } else {
    boardSessionId = newBoardSessionId();
  }

  try {
    const made = rowsOf(await db.execute(sql`
      INSERT INTO live_classes (
        host_user_id, title, subject, course_id, scheduled_at, duration_minutes,
        meet_url, status, capacity, enrolled_count, mode, time_zone, board_session_id, is_recorded
      ) VALUES (
        ${input.hostUserId}, ${title}, ${subject || null}, ${input.courseId}, ${when.iso}, ${duration},
        ${meetUrl}, 'scheduled', ${capacity}, 0, ${mode}, ${input.timeZone}, ${boardSessionId}, ${input.isRecorded === true}
      ) RETURNING id`));
    if (made.length === 0) {
      return { ok: false, id: null, error: 'The session was not written. Nothing was scheduled.' };
    }
    return { ok: true, id: String(made[0].id), error: '' };
  } catch (e: any) {
    // NEVER swallowed: this is a write path.
    logFail('createCourseSession', e);
    return { ok: false, id: null, error: 'The session could not be scheduled: ' + reasonOf(e).slice(0, 160) };
  }
}

export async function setSessionRecording(sessionId: string, recordingUrl: string): Promise<WriteResult> {
  if (!isUuid(sessionId)) return { ok: false, id: null, error: 'That session could not be identified.' };
  const v = resolveVideoLink(recordingUrl, { allowLinkOut: true });
  if (!v.ok) return { ok: false, id: null, error: v.reason };
  try {
    // The ORIGINAL address is stored, never the derived one: video-embed.ts re-resolves on every
    // render, so a change to how an embed is built reaches every existing recording without anyone
    // re-entering a link.
    const done = rowsOf(await db.execute(sql`
      UPDATE live_classes SET recording_url = ${v.originalUrl}, is_recorded = true
       WHERE id::text = ${sessionId} AND course_id IS NOT NULL
      RETURNING id`));
    if (done.length === 0) return { ok: false, id: null, error: 'No course session matched, so no recording was saved.' };
    return { ok: true, id: String(done[0].id), error: '' };
  } catch (e: any) {
    logFail('setSessionRecording ' + sessionId, e);
    return { ok: false, id: null, error: 'The recording could not be saved: ' + reasonOf(e).slice(0, 160) };
  }
}

export async function updateSessionLink(sessionId: string, meetUrl: string): Promise<WriteResult> {
  if (!isUuid(sessionId)) return { ok: false, id: null, error: 'That session could not be identified.' };
  const v = meetingUrlVerdict(meetUrl);
  if (!v.ok) return { ok: false, id: null, error: v.reason };
  try {
    const done = rowsOf(await db.execute(sql`
      UPDATE live_classes SET meet_url = ${v.url}
       WHERE id::text = ${sessionId} AND course_id IS NOT NULL AND mode = 'external'
      RETURNING id`));
    if (done.length === 0) {
      return { ok: false, id: null, error: 'No external course session matched, so the ' + MEETING_LINK_LABEL + ' was not changed.' };
    }
    return { ok: true, id: String(done[0].id), error: '' };
  } catch (e: any) {
    logFail('updateSessionLink ' + sessionId, e);
    return { ok: false, id: null, error: 'The ' + MEETING_LINK_LABEL + ' could not be saved: ' + reasonOf(e).slice(0, 160) };
  }
}

export async function cancelCourseSession(sessionId: string): Promise<WriteResult> {
  if (!isUuid(sessionId)) return { ok: false, id: null, error: 'That session could not be identified.' };
  try {
    const done = rowsOf(await db.execute(sql`
      UPDATE live_classes SET status = 'cancelled'
       WHERE id::text = ${sessionId} AND course_id IS NOT NULL
      RETURNING id`));
    if (done.length === 0) return { ok: false, id: null, error: 'No course session matched, so nothing was cancelled.' };
    return { ok: true, id: String(done[0].id), error: '' };
  } catch (e: any) {
    logFail('cancelCourseSession ' + sessionId, e);
    return { ok: false, id: null, error: 'The session could not be cancelled: ' + reasonOf(e).slice(0, 160) };
  }
}

/** The teacher's door into an in-house session. Organiser-gated by the caller, like the admin list. */
export async function organiserBoardUrl(sessionId: string): Promise<string | null> {
  if (!isUuid(sessionId)) return null;
  try {
    const row = rowsOf(await db.execute(sql`
      SELECT board_session_id FROM live_classes WHERE id::text = ${sessionId} LIMIT 1`))[0];
    const bs = row?.board_session_id ? String(row.board_session_id) : '';
    return bs ? '/aquintutor/board?session=' + encodeURIComponent(bs) : null;
  } catch (e: any) {
    logFail('organiserBoardUrl ' + sessionId, e);
    return null;
  }
}
