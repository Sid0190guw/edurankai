// src/lib/wellness.ts  -  the wellness and care engine for the women in this organisation.
//
// Everything this system needs lives here: the access gate, the storage, the cycle maths, the
// guidance content, and the aggregate-only reporting. Pages and API routes are thin shells over it.
//
// THREE RULES ARE BUILT IN RATHER THAN LEFT AS POLICY SOMEBODY HAS TO REMEMBER.
//
//   1. ACCESS IS DECIDED HERE, ON THE SERVER, FROM THE DATABASE RECORD.
//      canAccessWellness() reads the gender recorded on the employee record. It never looks at a
//      query string, a form field, a header, a cookie or anything else the browser can set. It
//      fails closed: an error, a missing record or a blank field all return "no access" with a calm
//      message, never a stack trace and never a demand to disclose anything. Every page and every
//      API route must call it for itself  -  hiding a nav link is not a gate.
//
//   2. THERE IS NO FUNCTION IN THIS FILE THAT RETURNS ONE PERSON'S CYCLE DATA TO ANYBODY BUT HER.
//      Every read of cycles, symptoms and settings takes the owner's user id and puts it in the
//      WHERE clause. Nothing filters after the fact. The oversight functions at the bottom return
//      counts and durations only, they take no user id, and they suppress any group smaller than
//      MIN_GROUP so a number can never be walked back to a person. There is deliberately no
//      "read any user's log" helper, so there is no screen anybody could build on one.
//
//   3. NOTHING HERE DIAGNOSES.
//      The guidance is general wellbeing information about food, movement, hydration and sleep. It
//      names no condition, it starts and stops no medication, and it says so on every object it
//      returns. Anything past general guidance routes to a human consultant, and the symptoms that
//      need a doctor are listed plainly with a calm "please speak to a doctor" line rather than a
//      guess at a cause.
//
// House notes: postgres-js returns plain arrays (see rows()); real Postgres errors are on
// e.cause.message; the schema bootstraps itself because migrations are not available here.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const errText = (e: any): string => e?.cause?.message || e?.message || String(e);

// ---------------------------------------------------------------------------
// SHARED CONSTANTS AND SMALL HELPERS
// Declared before anything that uses them, on purpose.
// ---------------------------------------------------------------------------

/** A cycle gap longer than this is a missed log, not a cycle. It never enters an average. */
export const MAX_PLAUSIBLE_CYCLE_DAYS = 60;
/** Cycles shorter than this are almost always two entries for the same period. Also excluded. */
export const MIN_PLAUSIBLE_CYCLE_DAYS = 15;
/** A "period" longer than this is a forgotten end date. Bleeding that long belongs with a doctor. */
export const MAX_PLAUSIBLE_PERIOD_DAYS = 15;
/** Used only when there is not enough history to compute one. Always drops confidence to low. */
export const DEFAULT_CYCLE_DAYS = 28;
/** Days from ovulation to the next period. Stable across cycle lengths, unlike the first half. */
export const LUTEAL_PHASE_DAYS = 14;

/**
 * Minimum group size for anything shown outside the person it belongs to.
 * Below five people a "count" stops being a statistic and starts being a description of somebody.
 * In a small organisation, "3 people used the period tracker this month" plus a bit of context is
 * enough to name them. Five is the ordinary floor for this kind of disclosure control.
 */
export const MIN_GROUP = 5;
export const TOO_FEW_LABEL = 'Too few to report';

const MAX_NOTE_CHARS = 2000;
const MAX_MESSAGE_CHARS = 4000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Trims, caps length, and turns an empty string into null so the column stays honest. */
function cleanText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r\n/g, '\n').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Accepts only YYYY-MM-DD and only a real calendar date. Anything else is null. */
export function safeDay(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return ymd(parseDay(v) as Date);
  const s = String(v ?? '').trim();
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/**
 * Normalises whatever a date column hands back into a UTC-midnight Date.
 *
 * Read queries in this file cast dates to text so they arrive as 'YYYY-MM-DD' strings, but the pure
 * functions are also called from tests and from callers holding raw driver output, where a date can
 * arrive as a JS Date. A Date that is exactly midnight UTC is a date-only value and its UTC parts
 * are the truth; anything else is a timestamp rendered in local time, so its local parts are.
 */
export function parseDay(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const dateOnly = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    return dateOnly
      ? new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()))
      : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(dt.getTime()) ? null : dt;
}

/** UTC-midnight Date to 'YYYY-MM-DD'. */
export function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

/** Whole days from a to b. Both are UTC midnights so there is no DST drift to worry about. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Today as a UTC-midnight Date, so "today" means the same thing everywhere in the file. */
export function today(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

function mean(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

// ---------------------------------------------------------------------------
// 1. SCHEMA  -  self-bootstrapping, because migrations are not available here.
// ---------------------------------------------------------------------------

/**
 * Statements that are allowed to fail without taking the rest of the bootstrap with them.
 *
 * A unique index cannot be created over rows that already violate it, and an ALTER on a table an
 * older deployment shaped differently can fail too. Neither should stop the tables after it in the
 * sequence from being created, which is what would happen if the error propagated: the ensure runs
 * top to bottom and the first throw ends it.
 */
async function optionalDdl(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e: any) {
    console.warn(`[wellness] optional schema step skipped (${label}):`, errText(e));
  }
}

export function ensureWellnessSchema(): Promise<void> {
  return ensureOnce('wellness_v1', async () => {
    // A cycle is one period: when it started, and when it finished if she came back to say so.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS wellness_cycles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_on DATE NOT NULL,
      ended_on DATE,
      flow VARCHAR(20),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS wellness_cycles_user_idx ON wellness_cycles (user_id, started_on DESC)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS wellness_symptoms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      logged_on DATE NOT NULL,
      symptom VARCHAR(60) NOT NULL,
      severity INT NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS wellness_symptoms_user_idx ON wellness_symptoms (user_id, logged_on DESC)`);

    // A request to talk to a human. The body of this is read by exactly two people: the woman who
    // wrote it and the consultant it is assigned to. No admin query in this file selects message,
    // topic or response  -  see listUnassignedForRouting().
    await db.execute(sql`CREATE TABLE IF NOT EXISTS wellness_consult_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic VARCHAR(60),
      urgency VARCHAR(20) NOT NULL DEFAULT 'routine',
      message TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TIMESTAMPTZ,
      answered_at TIMESTAMPTZ,
      response TEXT,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS wellness_consults_status_idx ON wellness_consult_requests (status, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS wellness_consults_user_idx ON wellness_consult_requests (user_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS wellness_consults_assigned_idx ON wellness_consult_requests (assigned_to, status)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS wellness_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      reminders_enabled BOOLEAN NOT NULL DEFAULT false,
      average_cycle_days INT,
      last_reviewed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    // The consultant pool. Without it, assigned_to has no source and there is no server-side way to
    // decide who may open a request, which would leave the messages ungated. Membership is a name
    // on a list and nothing more: being in this pool does not let anybody read a request that was
    // not routed to them.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS wellness_consultants (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name VARCHAR(200) NOT NULL,
      credentials VARCHAR(200),
      focus TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS wellness_consultants_active_idx ON wellness_consultants (is_active)`);

    // Everything below is best-effort and runs last, so a failure here cannot leave a table above
    // it uncreated. One period start per person per day: a double tap is the same period, not a
    // second cycle, and logCycleStart relies on this index for its ON CONFLICT.
    await optionalDdl('cycles unique day', () =>
      db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS wellness_cycles_user_day_uniq ON wellness_cycles (user_id, started_on)`)
    );
    // Forward-compatible column adds, so an older deployment catches up without a migration.
    await optionalDdl('cycles.updated_at', () =>
      db.execute(sql`ALTER TABLE wellness_cycles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    );
    await optionalDdl('consults.assigned_at', () =>
      db.execute(sql`ALTER TABLE wellness_consult_requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`)
    );
    await optionalDdl('consults.closed_at', () =>
      db.execute(sql`ALTER TABLE wellness_consult_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`)
    );
    await optionalDdl('settings.updated_at', () =>
      db.execute(sql`ALTER TABLE wellness_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    );
  });
}

// ---------------------------------------------------------------------------
// 2. THE GATE
// ---------------------------------------------------------------------------

export type WellnessAccessReason = 'ok' | 'not_recorded' | 'not_eligible';
export interface WellnessAccess {
  allowed: boolean;
  reason: WellnessAccessReason;
}

const DENY_NOT_RECORDED: WellnessAccess = { allowed: false, reason: 'not_recorded' };
const DENY_NOT_ELIGIBLE: WellnessAccess = { allowed: false, reason: 'not_eligible' };
const ALLOW: WellnessAccess = { allowed: true, reason: 'ok' };

/**
 * The gender column is free text with no constraint, so two writers have put two different casings
 * into it over time ('Female' from the HR editor, 'female' from staff self-service). Normalise
 * before comparing, and compare against a whole-value set rather than a substring: 'male' contains
 * 'male' and so does 'female'.
 */
function normaliseGender(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

const FEMALE_VALUES = new Set(['female', 'f', 'woman', 'women', 'girl']);
const MALE_VALUES = new Set(['male', 'm', 'man', 'men', 'boy']);

/**
 * The server-side gate. Every page and every API route in this system calls it for itself.
 *
 * It reads the employee record, not the request. Nothing the browser sends can change the answer.
 *
 * On the three outcomes:
 *   ok             -  a female value is recorded.
 *   not_eligible   -  a male value is recorded. Only an explicit male value produces this.
 *   not_recorded   -  everything else: no employee record at all, a blank field, 'other',
 *                   'non-binary', 'prefer not to say', an unrecognised value, or any error.
 *
 * That last grouping is deliberate. "Prefer not to say" means we do not know, not that the answer
 * is no, and telling someone who chose not to disclose that she is "not eligible" is exactly the
 * pressure to disclose this system must not apply. The same goes for a non-binary colleague who may
 * well need this. All of them get the calm "we do not have this recorded, here is how to have it
 * corrected" path, which leaves the decision with the person and her HR contact.
 *
 * The employee lookup uses the widest identity match in the repo (user_id or any of the three email
 * columns), because the users-to-employees link is not guaranteed to be filled in and a woman whose
 * record was never linked must not be locked out of something she is entitled to. Where more than
 * one record matches, the most strongly linked one wins, deterministically.
 */
export async function canAccessWellness(
  user: { id?: string | null; email?: string | null } | null | undefined
): Promise<WellnessAccess> {
  if (!user || !user.id) return DENY_NOT_RECORDED;
  try {
    const uid = String(user.id);
    const email = String(user.email || '').trim().toLowerCase();
    const r = await db.execute(sql`
      SELECT gender,
             CASE
               WHEN user_id = ${uid}::uuid THEN 0
               WHEN ${email}::text <> '' AND lower(work_email) = ${email}::text THEN 1
               WHEN ${email}::text <> '' AND lower(personal_email) = ${email}::text THEN 2
               ELSE 3
             END AS link_rank,
             updated_at
      FROM hr_employees
      WHERE is_active = true
        AND (
          user_id = ${uid}::uuid
          OR (${email}::text <> '' AND lower(work_email) = ${email}::text)
          OR (${email}::text <> '' AND lower(personal_email) = ${email}::text)
          OR (${email}::text <> '' AND lower(email) = ${email}::text)
        )
      ORDER BY link_rank ASC, updated_at DESC NULLS LAST
      LIMIT 1
    `);
    const row = rows(r)[0];
    if (!row) return DENY_NOT_RECORDED;
    const g = normaliseGender(row.gender);
    if (!g) return DENY_NOT_RECORDED;
    if (FEMALE_VALUES.has(g)) return ALLOW;
    if (MALE_VALUES.has(g)) return DENY_NOT_ELIGIBLE;
    return DENY_NOT_RECORDED;
  } catch (e: any) {
    // Fail closed. A database hiccup must never become an open door, and it must never become a
    // stack trace on somebody's screen either.
    console.error('[wellness] access check failed:', errText(e));
    return DENY_NOT_RECORDED;
  }
}

/** Convenience for route handlers: the boolean only. Still server-side, still fails closed. */
export async function requireWellnessAccess(
  user: { id?: string | null; email?: string | null } | null | undefined
): Promise<boolean> {
  return (await canAccessWellness(user)).allowed;
}

export interface AccessMessage { title: string; body: string; help: string }

/**
 * The words shown when the gate says no. Calm, short, no error language, and no request that
 * anybody explain or prove anything to us.
 */
export function accessMessage(reason: WellnessAccessReason): AccessMessage {
  if (reason === 'not_eligible') {
    return {
      title: 'This space is not open from your account',
      body: 'These pages are set up for the women in the organisation, and access is read from your employee record rather than from anything you enter here.',
      help: 'If the detail on your record is wrong, your HR contact can correct it, and access follows the record automatically.',
    };
  }
  return {
    title: 'We do not have what we need to open this yet',
    body: 'Access to these pages is read from your employee record. Yours does not currently carry the detail this is based on, so we have left it closed rather than guess.',
    help: 'Your HR contact can update your record whenever you would like. Nothing needs to be explained to us, and nothing you type on this page can change the answer.',
  };
}

// ---------------------------------------------------------------------------
// 3. CYCLE INTELLIGENCE  -  pure functions, no database, no clock except what you pass in.
// ---------------------------------------------------------------------------

export type CyclePhase = 'menstrual' | 'follicular' | 'ovulatory' | 'luteal' | 'unknown';
export type Confidence = 'low' | 'medium' | 'high';

/**
 * Loose on purpose: rows straight out of the driver (snake_case) and hand-built objects
 * (camelCase) both work, so these stay trivially testable.
 */
export interface CycleLike {
  id?: string;
  started_on?: unknown;
  startedOn?: unknown;
  ended_on?: unknown;
  endedOn?: unknown;
  flow?: unknown;
  notes?: unknown;
}

function startOf(c: CycleLike): Date | null {
  return parseDay(c.startedOn !== undefined ? c.startedOn : c.started_on);
}
function endOf(c: CycleLike): Date | null {
  return parseDay(c.endedOn !== undefined ? c.endedOn : c.ended_on);
}

/** Oldest first, unparseable rows dropped. Everything below assumes this ordering. */
function sortedStarts(cycles: CycleLike[]): Date[] {
  return (cycles || [])
    .map(startOf)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The gaps between consecutive period starts, with the implausible ones removed.
 *
 * A gap over 60 days is a month she did not log, not a 74-day cycle, and averaging it in would push
 * every future prediction weeks late. A gap under 15 days is almost always two entries for the same
 * period. Neither is data, so neither counts.
 */
export function cycleGaps(cycles: CycleLike[]): number[] {
  const starts = sortedStarts(cycles);
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const g = daysBetween(starts[i - 1], starts[i]);
    if (g >= MIN_PLAUSIBLE_CYCLE_DAYS && g <= MAX_PLAUSIBLE_CYCLE_DAYS) gaps.push(g);
  }
  return gaps;
}

/** Average days from one period start to the next. null when there is nothing usable to average. */
export function averageCycleLength(cycles: CycleLike[]): number | null {
  const gaps = cycleGaps(cycles);
  if (!gaps.length) return null;
  return Math.round(mean(gaps));
}

/**
 * Average length of bleeding, counted inclusively, from cycles that have an end date.
 * A recorded span over 15 days is a forgotten end date rather than a period, so it is left out of
 * the average. A genuine 15-day bleed is in the red flag list instead, where it belongs.
 */
export function averagePeriodLength(cycles: CycleLike[]): number | null {
  const lengths: number[] = [];
  for (const c of cycles || []) {
    const s = startOf(c);
    const e = endOf(c);
    if (!s || !e) continue;
    const len = daysBetween(s, e) + 1;
    if (len >= 1 && len <= MAX_PLAUSIBLE_PERIOD_DAYS) lengths.push(len);
  }
  if (!lengths.length) return null;
  return Math.round(mean(lengths));
}

export interface Prediction {
  nextStart: string | null;
  fertileWindow: { start: string; end: string } | null;
  confidence: Confidence;
  /** Plain-language reason for that confidence, meant to be shown next to the date. */
  basis: string;
  cyclesLogged: number;
  usableGaps: number;
  averageDays: number | null;
  /** Spread between the shortest and longest usable cycle. The honest measure of regularity. */
  spreadDays: number | null;
  /** True when the last log is old enough that the estimate was rolled forward to reach today. */
  rolledForward: boolean;
}

/**
 * The next expected start, plus the fertile window around the ovulation that precedes it.
 *
 * Confidence is not decoration. A date presented as fact when it is arithmetic on two data points
 * is how these tools lose trust, and how somebody gets caught out. So: fewer than three logged
 * cycles is always low, no matter how neat the numbers look. Above that, regularity decides, and a
 * prediction that had to be rolled forward past a missed log drops back to low because a gap in the
 * record means we genuinely do not know where she is.
 *
 * The fertile window is counted back from the expected start, because the luteal phase is the
 * stable half of the cycle. It is an estimate from her own logs and nothing more.
 */
export function predictNext(
  cycles: CycleLike[],
  opts: { overrideCycleDays?: number | null; from?: Date } = {}
): Prediction {
  const starts = sortedStarts(cycles);
  const gaps = cycleGaps(cycles);
  const avgComputed = gaps.length ? Math.round(mean(gaps)) : null;
  const override = opts.overrideCycleDays && opts.overrideCycleDays >= MIN_PLAUSIBLE_CYCLE_DAYS && opts.overrideCycleDays <= MAX_PLAUSIBLE_CYCLE_DAYS
    ? Math.round(opts.overrideCycleDays)
    : null;
  const spread = gaps.length >= 2 ? Math.max(...gaps) - Math.min(...gaps) : null;

  const empty: Prediction = {
    nextStart: null,
    fertileWindow: null,
    confidence: 'low',
    basis: 'Nothing is logged yet, so there is nothing to estimate from. One or two months of dates is enough to start.',
    cyclesLogged: starts.length,
    usableGaps: gaps.length,
    averageDays: avgComputed,
    spreadDays: spread,
    rolledForward: false,
  };
  if (!starts.length) return empty;

  const cycleDays = override || avgComputed || DEFAULT_CYCLE_DAYS;
  const usingDefault = !override && !avgComputed;
  const last = starts[starts.length - 1];
  const now = opts.from ? new Date(Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate())) : today();

  // Roll forward past months that were not logged, so the answer is a date ahead of her rather
  // than a date behind her. Capped so a very old single entry cannot spin.
  let next = addDays(last, cycleDays);
  let rolled = false;
  let guard = 0;
  while (next.getTime() < now.getTime() && guard < 24) {
    next = addDays(next, cycleDays);
    rolled = true;
    guard++;
  }

  let confidence: Confidence;
  let basis: string;
  if (starts.length < 3 || gaps.length < 2 || usingDefault) {
    confidence = 'low';
    basis = usingDefault
      ? 'This is a general 28-day estimate, not your pattern. Once a second period is logged the estimate starts using your own dates.'
      : `Based on ${starts.length} logged ${starts.length === 1 ? 'period' : 'periods'}. Three or more is where an estimate starts being worth much.`;
  } else if (rolled) {
    confidence = 'low';
    basis = 'A month or more looks unlogged, so this has been carried forward and is a rough guide only.';
  } else if (gaps.length >= 4 && (spread ?? 99) <= 4) {
    confidence = 'high';
    basis = `Your last ${gaps.length + 1} cycles have been close to ${cycleDays} days and within ${spread} days of each other.`;
  } else if ((spread ?? 99) <= 9) {
    confidence = 'medium';
    basis = `Averaging ${cycleDays} days across ${gaps.length + 1} cycles, varying by about ${spread} days. Close, not exact.`;
  } else {
    confidence = 'low';
    basis = `Your cycles have varied by ${spread} days recently, so a single date is not a fair thing to promise. Treat this as a rough window.`;
  }

  // Ovulation sits roughly LUTEAL_PHASE_DAYS before the next start; sperm survive several days, the
  // egg about one. That gives the familiar five-days-before to one-day-after window.
  const ovulation = addDays(next, -LUTEAL_PHASE_DAYS);
  const fertileWindow = { start: ymd(addDays(ovulation, -5)), end: ymd(addDays(ovulation, 1)) };

  return {
    nextStart: ymd(next),
    fertileWindow,
    confidence,
    basis,
    cyclesLogged: starts.length,
    usableGaps: gaps.length,
    averageDays: override || avgComputed,
    spreadDays: spread,
    rolledForward: rolled,
  };
}

/** Must be shown wherever the fertile window is. It is an estimate, not a method. */
export const FERTILE_WINDOW_CAVEAT =
  'This window is estimated from the dates you have logged. It is not a method of contraception, and it is not a way of avoiding or planning a pregnancy on its own. If that is what you need, please talk to a doctor.';

/** Day 1 is the first day of bleeding. Returns null when there is no recent start to count from. */
export function cycleDay(cycles: CycleLike[], on: Date = today()): number | null {
  const starts = sortedStarts(cycles).filter((d) => d.getTime() <= on.getTime());
  if (!starts.length) return null;
  const last = starts[starts.length - 1];
  const n = daysBetween(last, on) + 1;
  return n > MAX_PLAUSIBLE_CYCLE_DAYS ? null : n;
}

/**
 * Where she is right now.
 *
 * Menstrual runs to the recorded end date, or to the usual period length when she has not come back
 * to close it off. Ovulation is placed a fixed fourteen days before the next expected start rather
 * than at the midpoint, because the second half of the cycle is the consistent one. Everything
 * before that window is follicular, everything after is luteal.
 *
 * Returns 'unknown' rather than guessing when the last log is too old to mean anything. An
 * confident wrong answer is worse than an honest blank.
 */
export function currentPhase(cycles: CycleLike[], on: Date = today()): CyclePhase {
  const list = (cycles || []).filter((c) => {
    const s = startOf(c);
    return !!s && s.getTime() <= on.getTime();
  });
  if (!list.length) return 'unknown';

  list.sort((a, b) => (startOf(a) as Date).getTime() - (startOf(b) as Date).getTime());
  const currentCycle = list[list.length - 1];
  const start = startOf(currentCycle) as Date;
  const since = daysBetween(start, on);
  if (since < 0 || since > MAX_PLAUSIBLE_CYCLE_DAYS) return 'unknown';

  const end = endOf(currentCycle);
  const usualPeriod = averagePeriodLength(cycles) || 5;
  const bleeding = end ? on.getTime() <= end.getTime() : since < usualPeriod;
  if (bleeding) return 'menstrual';

  const cycleDays = averageCycleLength(cycles) || DEFAULT_CYCLE_DAYS;
  const ovulationDay = cycleDays - LUTEAL_PHASE_DAYS; // days after the start
  if (since >= ovulationDay - 1 && since <= ovulationDay + 1) return 'ovulatory';
  if (since < ovulationDay - 1) return 'follicular';
  return 'luteal';
}

// ---------------------------------------------------------------------------
// 4. GUIDANCE CONTENT
//
// Structured so the summary can render on its own, with everything else behind an expander the
// person chooses to open. Full detail is here for whoever wants it; nobody is walled in by it.
//
// This is general wellbeing information. It names no condition, it prescribes nothing, and it says
// so on every object. Where a supplement or a medicine would be the obvious next sentence, the
// sentence is "that is a conversation with a doctor" instead.
// ---------------------------------------------------------------------------

export const NOT_MEDICAL_ADVICE =
  'This is general wellbeing information, not medical advice. It is not a diagnosis and it is not personal to your health history. If something feels wrong, or you want advice for your own situation, please speak to a doctor or ask for a consultant here.';

export interface GuidanceFood {
  food: string;
  why: string;
  when: string;
}

export interface PhaseGuidance {
  phase: CyclePhase;
  title: string;
  /** One or two sentences. Always shown. */
  summary: string;
  detail: {
    whatIsHappening: string[];
    eating: { headline: string; foods: GuidanceFood[]; easeOff: string[] };
    hydration: { headline: string; points: string[] };
    movement: { headline: string; points: string[] };
    sleep: { headline: string; points: string[] };
    smallThings: string[];
  };
  notMedicalAdvice: string;
}

/**
 * An array rather than a keyed map, so a page can iterate it directly without declaring a typed
 * lookup inside markup. Use guidanceFor() when you want one.
 */
export const PHASE_GUIDANCE: PhaseGuidance[] = [
  {
    phase: 'menstrual',
    title: 'While you are bleeding',
    summary:
      'You are losing iron along with the bleeding, and the cramping is muscle, not weakness. Warmth, iron eaten alongside something sour or citrusy, and gentler movement will do more for you this week than pushing through will.',
    detail: {
      whatIsHappening: [
        'Oestrogen and progesterone are at their lowest point of the month. The lining built up over the last few weeks is being shed, and that is the bleeding.',
        'Cramping is the uterus contracting to do it. The chemicals driving those contractions can also reach the gut, which is why loose stools, nausea and a low ache in the lower back often arrive with day one.',
        'A typical period loses somewhere around 30 to 40 mg of iron. That is a real amount, and it is the reason days one and two often feel flat in a way that is not about mood.',
        'Body temperature drops back down and sleep can be broken on the first night or two.',
      ],
      eating: {
        headline: 'Put iron back, and eat it with something sour so your body can actually use it.',
        foods: [
          {
            food: 'Iron from food: cooked palak and methi, ragi, rajma, chana, black til, dates, raisins, jaggery, and liver or red meat if you eat them',
            why: 'Replaces what leaves with the bleeding. Iron from plants is harder for the body to take up than iron from meat, which is why the next line matters so much.',
            when: 'Something iron-rich in both lunch and dinner across the bleeding days, rather than one large effort.',
          },
          {
            food: 'Vitamin C in the same meal: a lemon squeezed over the dal, amla, guava, orange, tomato, capsicum',
            why: 'Vitamin C converts plant iron into a form the gut can absorb, and it can multiply how much you take up several times over. This is the single most useful thing on this page.',
            when: 'In the same sitting as the iron, not hours later. Squeezing lemon on the dal at the table is enough.',
          },
          {
            food: 'Chai and coffee, moved away from meals',
            why: 'The tannins in tea and coffee bind iron and block a good part of it. This is worth knowing rather than worrying about.',
            when: 'Keep them about an hour either side of an iron-rich meal. Mid-morning and mid-afternoon rather than with lunch.',
          },
          {
            food: 'Magnesium: pumpkin seeds, almonds, cashews, dark chocolate at 70 per cent or above, banana',
            why: 'Magnesium is involved in muscle relaxation, and cramping is a muscle doing the opposite.',
            when: 'A small handful in the afternoon, when the slump usually lands anyway.',
          },
          {
            food: 'Omega-3 fats: flaxseed, walnuts, chia, and oily fish such as mackerel or sardines',
            why: 'These fats sit on the calmer side of the same chemical family that drives cramping.',
            when: 'A spoon of ground flax into curd or a chapati dough works across the week.',
          },
          {
            food: 'Warm fluids, especially fresh ginger tea',
            why: 'Warmth eases the muscle, and ginger has a reasonable track record for period pain specifically.',
            when: 'A cup in the morning and one in the evening on the heavier days.',
          },
          {
            food: 'Steady complex carbohydrates: oats, bajra, jowar, brown rice, sweet potato',
            why: 'Keeps blood sugar even. A crash on a cramping day feels far worse than a crash on any other day.',
            when: 'Every meal, and do not skip breakfast on day one.',
          },
          {
            food: 'Calcium: curd, milk, ragi, sesame',
            why: 'Supports muscle function, and curd is easy on a day when nothing else appeals.',
            when: 'Whenever it goes down easily.',
          },
        ],
        easeOff: [
          'Very salty packaged food, which adds to the puffiness rather than settling it.',
          'A lot of caffeine on the heaviest cramping days, which can tighten things further and disturb an already broken night.',
          'Alcohol, which worsens both the sleep and the next day.',
          'Long gaps without eating. Four or five hours without food on day one is felt much more sharply than usual.',
          'Iron tablets started on your own. Whether you need iron, and how much, is a blood test and a doctor, not a guess. Food is safe to lean on in the meantime.',
        ],
      },
      hydration: {
        headline: 'Slightly more than usual, and warmer than usual.',
        points: [
          'Around two to two and a half litres across the day, more in heat.',
          'Warm or room-temperature water sits better than cold on a cramping day.',
          'If you feel wrung out, a glass with a pinch of salt and a squeeze of lemon is more useful than plain water.',
          'Ginger, chamomile or ajwain water all count towards the total and are gentler company than another coffee.',
        ],
      },
      movement: {
        headline: 'Move gently, and let the day decide the intensity.',
        points: [
          'A twenty to thirty minute walk genuinely reduces cramping for a lot of people. It is the highest-return thing on this list.',
          'Gentle yoga: cat-cow, child pose, a reclined twist, reclined bound angle. Hold each for several slow breaths.',
          'Light stretching through the hips and lower back, where the ache usually settles.',
          'Swimming is fine if you are comfortable with it.',
          'There is no rule that says you cannot train hard while bleeding. If you feel good, train. If day one leaves you flat, take the easy option without treating it as a failure.',
          'Nothing here requires you to exercise. On a bad day, rest is the correct answer.',
        ],
      },
      sleep: {
        headline: 'Aim a little longer than usual, and set up for comfort.',
        points: [
          'Eight to nine hours if you can get it. The first two nights are usually the broken ones.',
          'A hot water bottle or heat pad on the lower abdomen or lower back for fifteen to twenty minutes before bed.',
          'Side-lying with a pillow between the knees, or on your back with a pillow under the knees, takes the pull off the lower back.',
          'Keep the room cool and dark. Body temperature has just dropped and a warm room fights it.',
          'Start winding down earlier than you think you need to on night one.',
        ],
      },
      smallThings: [
        'A warm shower in the morning, not just at night.',
        'Loose waistbands. It sounds small and it is not.',
        'Note the flow each day, even roughly. It is the only way a heavier-than-usual month becomes visible instead of just being a bad week you forget.',
        'If work allows any flexibility, spend it on day one rather than saving it.',
      ],
    },
    notMedicalAdvice: NOT_MEDICAL_ADVICE,
  },
  {
    phase: 'follicular',
    title: 'After the bleeding stops',
    summary:
      'Oestrogen is climbing and energy usually climbs with it. This is the easiest week to start something hard, and the week protein and fibre pay you back the most.',
    detail: {
      whatIsHappening: [
        'A hormone from the brain is maturing follicles in the ovaries, and one of them will go on to release an egg. Rising oestrogen is the result.',
        'The uterine lining is rebuilding after the shed.',
        'Insulin sensitivity is generally better in this half of the cycle, so carbohydrates are handled well and training loads land well.',
        'Mood, verbal fluency and appetite for effort tend to be at their steadiest. Most people notice they simply want to do more.',
        'Iron stores are still low for the first several days after the bleeding stops, even though the bleeding is over.',
      ],
      eating: {
        headline: 'Protein at every meal and fibre through the day. You are rebuilding.',
        foods: [
          {
            food: 'Protein: eggs, curd, paneer, dal with rice, rajma, chana, tofu, soya, chicken, fish',
            why: 'Tissue is rebuilding and, if you are training, this is the week the work sticks. Roughly a palm-sized portion at each meal is a good practical marker.',
            when: 'Every meal, including breakfast. Breakfast is the one most people miss.',
          },
          {
            food: 'Fibre: whole grains, oats, vegetables, fruit eaten with the skin, ground flax and chia',
            why: 'Fibre binds surplus oestrogen in the gut so it leaves the body instead of being reabsorbed, and it feeds the bacteria that do that work. Rising oestrogen is the point of this week; circulating more than you need is not.',
            when: 'Across all three meals. Roughly 25 to 30 g a day is the general target for adults.',
          },
          {
            food: 'Fermented foods: curd, idli and dosa batter, kanji, brine pickles',
            why: 'A healthier gut handles oestrogen clearance better, and these are the cheapest way in.',
            when: 'Something small daily.',
          },
          {
            food: 'Cruciferous vegetables: broccoli, cabbage, cauliflower, mustard greens',
            why: 'They support the liver pathways that process oestrogen.',
            when: 'Three or four times through the week.',
          },
          {
            food: 'Keep the iron going for the first four or five days after bleeding stops',
            why: 'The bleeding ends before the stores refill. This is the week the tiredness quietly resolves if you keep eating for it.',
            when: 'Same pairing rule: iron with something sour or citrusy.',
          },
          {
            food: 'Complex carbohydrates before training: oats, poha, upma, banana, a roti',
            why: 'Better tolerated now than at any other point in the month, and they are what a hard session actually runs on.',
            when: 'An hour or two before the session.',
          },
        ],
        easeOff: [
          'Nothing needs cutting this week. If there is a week to eat normally and train properly, this is it.',
          'Very low-carbohydrate eating alongside heavy training, which tends to backfire on energy and on the cycle itself.',
        ],
      },
      hydration: {
        headline: 'Two and a half to three litres, more if you are training.',
        points: [
          'Drink ahead of thirst on training days rather than catching up afterwards.',
          'A glass first thing, before coffee, is the easiest habit to hold.',
          'If a session runs beyond an hour or the weather is hot, add something with salt in it rather than plain water alone.',
        ],
      },
      movement: {
        headline: 'The best window in the month for hard work. Use it.',
        points: [
          'Heaviest lifts, progressive overload, personal bests. Recovery is on your side right now.',
          'Interval work, tempo runs, hill repeats.',
          'A good week to learn a new skill or a new movement pattern, when coordination and motivation are both cooperating.',
          'Longer sessions land better now than they will in three weeks.',
          'If you plan training in blocks, put the demanding block here on purpose rather than by accident.',
        ],
      },
      sleep: {
        headline: 'Seven to nine hours, and hold the timing steady.',
        points: [
          'Consistent wake time matters more than a perfect bedtime.',
          'Daylight on your face within an hour of waking anchors the whole rhythm, and this is the week the habit is easiest to build.',
          'Sleep is usually least troublesome this week, which makes it the right week to fix a slipped schedule.',
        ],
      },
      smallThings: [
        'Put the difficult conversations, the presentations and the demanding work here if you have any say over the calendar.',
        'Start the thing you have been putting off. The appetite for it is a hormonal fact this week, not a character improvement.',
      ],
    },
    notMedicalAdvice: NOT_MEDICAL_ADVICE,
  },
  {
    phase: 'ovulatory',
    title: 'Around ovulation',
    summary:
      'Oestrogen peaks and an egg is released, and most people feel at their most capable for these few days. Keep fluids and colour on the plate, warm up properly, and expect a dip shortly after.',
    detail: {
      whatIsHappening: [
        'A surge of luteinising hormone triggers a follicle to release its egg. That is ovulation, and it takes about a day.',
        'Body temperature rises by roughly 0.3 to 0.5 degrees C afterwards and stays up until the next period.',
        'Cervical mucus becomes clear and stretchy, a bit like raw egg white. It is the most reliable thing you can observe without a thermometer.',
        'A brief one-sided twinge or ache mid-cycle is common and ordinary.',
        'Testosterone has a small rise too, which is part of why energy and confidence often peak here.',
      ],
      eating: {
        headline: 'Colour, zinc and B vitamins, in meals that are easy to digest.',
        foods: [
          {
            food: 'Deeply coloured produce: pomegranate, berries, beetroot, citrus, red and yellow capsicum, carrots',
            why: 'Ovulation is a genuinely oxidative event and these are the foods that support the cleanup.',
            when: 'Something coloured at every meal for these few days.',
          },
          {
            food: 'Zinc: pumpkin seeds, chana, cashews, sesame, curd, seafood',
            why: 'Zinc is involved in the hormone signalling that runs ovulation.',
            when: 'A small daily handful of seeds is the simplest route.',
          },
          {
            food: 'B vitamins: eggs, leafy greens, whole grains, dals, sunflower seeds',
            why: 'Energy metabolism runs on them, and this is a high-output few days.',
            when: 'Spread across meals rather than concentrated.',
          },
          {
            food: 'Lighter, easily digested meals: khichdi, curd rice, grilled things, soups',
            why: 'Digestion is at its most comfortable in this half of the cycle. Heavy meals waste that.',
            when: 'Especially in the evening.',
          },
          {
            food: 'Fibre continues from last week',
            why: 'Oestrogen is at its highest point of the month right now, so the clearance route matters most here.',
            when: 'Daily.',
          },
        ],
        easeOff: [
          'Nothing in particular. Eat well and eat enough.',
          'If the heat is getting to you, heavy fried food in the middle of the day is the one thing worth moving to the evening.',
        ],
      },
      hydration: {
        headline: 'Three litres, and pay attention if it is hot.',
        points: [
          'Core temperature has just gone up, so you are losing slightly more without noticing.',
          'Coconut water, nimbu paani, or plain water with a pinch of salt after a sweaty session.',
          'Dry mouth and a dull afternoon headache around now are usually fluid rather than anything else.',
        ],
      },
      movement: {
        headline: 'Peak output, with a proper warm-up. Both halves of that sentence matter.',
        points: [
          'Power, speed, team sport, competition, anything social and high-energy.',
          'Warm up properly. Joints are slightly laxer around the oestrogen peak, and in sport this is when landing and cutting injuries are modestly more likely.',
          'That is not a reason to hold back. It is a reason to spend ten minutes on the warm-up instead of three.',
          'Expect a noticeable dip the day or two after ovulation. It is normal and it is temporary.',
        ],
      },
      sleep: {
        headline: 'Cool the room down.',
        points: [
          'The temperature rise makes the same bedroom feel warmer than it did last week.',
          'Lighter bedding, a fan, or a cooler shower before bed.',
          'Keep the wake time steady even though energy is high and late nights feel affordable.',
        ],
      },
      smallThings: [
        'If you are tracking, this is the useful few days to note temperature or mucus. It is what turns a rough estimate into your own pattern.',
        'A one-sided twinge that passes within a day is ordinary. Pain that is severe or sudden is on the red flag list below, and that one is worth acting on the same day.',
      ],
    },
    notMedicalAdvice: NOT_MEDICAL_ADVICE,
  },
  {
    phase: 'luteal',
    title: 'The week or two before your period',
    summary:
      'Progesterone rises, your temperature and appetite go up with it, and the last few days can bring irritability, bloating or sore breasts. Magnesium, proper carbohydrates and slightly more food, not less, make this stretch considerably easier.',
    detail: {
      whatIsHappening: [
        'The follicle that released the egg becomes a temporary gland producing progesterone. That hormone runs this whole phase.',
        'Resting metabolism rises by roughly 5 to 10 per cent, which is somewhere around 100 to 300 extra calories a day. The hunger is real and it is physiological. It is not a lapse in discipline.',
        'Core temperature stays about half a degree up, which is a common reason sleep gets worse in the second half of the month.',
        'In the last few days oestrogen falls, and serotonin tends to fall with it. That is the low mood, the short fuse and the crying at something small.',
        'Progesterone slows the gut, so bloating and constipation are common. Water retention adds to the puffiness.',
        'Breasts often feel full or tender. This usually eases as soon as bleeding starts.',
      ],
      eating: {
        headline: 'Magnesium in the evening, real carbohydrates through the day, and enough food.',
        foods: [
          {
            food: 'Magnesium: pumpkin seeds, almonds, cashews, dark chocolate at 70 per cent or above, spinach, black beans, banana',
            why: 'Magnesium supports muscle relaxation, sleep and mood, and this is the phase all three are under pressure.',
            when: 'A 25 to 30 g portion of seeds or nuts after dinner. The evening timing is doing real work here, not just habit.',
          },
          {
            food: 'Complex carbohydrates: oats, bajra, jowar, ragi, brown rice, sweet potato, whole wheat',
            why: 'They hold blood sugar steady and they help tryptophan reach the brain, which is the route to serotonin. This is the honest answer to a craving, where a biscuit is the short one.',
            when: 'At every meal, and a proper one in the evening rather than a light dinner.',
          },
          {
            food: 'Enough food overall',
            why: 'You genuinely need somewhat more this week. Eating at last week amount while feeling hungrier is how the mood and the energy get worse.',
            when: 'Add to meals rather than adding a fourth snack, which tends to leave you hungrier.',
          },
          {
            food: 'Calcium: curd, milk, ragi, sesame, paneer',
            why: 'Calcium intake has held up better than most things in studies of premenstrual symptoms.',
            when: 'Daily, and easy to fold into the evening magnesium habit.',
          },
          {
            food: 'Vitamin B6: banana, chickpeas, potato, sunflower seeds, fish, poultry',
            why: 'B6 is involved in making serotonin, and food sources are safe to lean on. High-dose B6 tablets are not, and that is a doctor conversation, not a self-serve one.',
            when: 'Through the week.',
          },
          {
            food: 'Potassium: banana, coconut water, sweet potato, spinach',
            why: 'It balances sodium and eases the water retention rather than adding to it.',
            when: 'Daily in the second half of this phase.',
          },
          {
            food: 'Fibre and fluid together',
            why: 'The gut has slowed down. Fibre without enough water makes constipation worse, not better, which is the mistake most people make here.',
            when: 'Every day, and pair each fibre increase with a glass of water.',
          },
        ],
        easeOff: [
          'Packaged and processed salt, which is where most water retention comes from. Home-cooked salt is rarely the problem.',
          'Caffeine in the last few days, especially if sleep is broken or breasts are tender.',
          'Alcohol as a way to sleep. It gets you under faster and then fragments the second half of the night, in a week when the second half is already fragile.',
          'Cutting calories to counter the bloating. It is fluid, not fat, and it goes on its own once bleeding starts.',
        ],
      },
      hydration: {
        headline: 'Two and a half to three litres. More water, not less.',
        points: [
          'It reads backwards, but drinking more reduces retention. Holding fluid is what a body does when it is short of it.',
          'Front-load the day so the evening does not become a series of trips to the bathroom.',
          'Warm drinks help the bloating more than cold ones.',
        ],
      },
      movement: {
        headline: 'Steady, moderate work. Plan the deload here.',
        points: [
          'Brisk walking, cycling, swimming, pilates, yoga, steady strength work at a slightly lower load with good form.',
          'A personal best attempt in the last three or four days will usually feel dreadful and prove nothing. If your training runs in cycles, put the lighter week here.',
          'Movement measurably reduces premenstrual symptoms. On the days it appeals least, a twenty minute walk is still worth more than the rest.',
          'Warm up longer than usual. Everything feels stiffer this week.',
        ],
      },
      sleep: {
        headline: 'Eight to nine hours, in a cooler room than you think you need.',
        points: [
          'Core temperature is up, so set the room a degree or two lower than usual.',
          'Hold the wake time steady even when falling asleep has been harder.',
          'Screens down 45 to 60 minutes before bed. This is the week that habit actually shows a difference.',
          'The magnesium-rich evening snack doubles as a sleep habit.',
          'Waking at three or four in the morning in the last few days before a period is common and it passes.',
        ],
      },
      smallThings: [
        'If you have any control over the calendar, put the lower-stakes work in the last three days.',
        'A comfortable, well-fitting bra makes tenderness noticeably better.',
        'A warm compress on the abdomen when the ache starts early, rather than waiting for day one.',
        'If the mood drop is sharp and predictable every month, that is worth raising with a consultant here. It is a common thing to ask about and there is nothing dramatic about asking.',
      ],
    },
    notMedicalAdvice: NOT_MEDICAL_ADVICE,
  },
  {
    phase: 'unknown',
    title: 'General guidance',
    summary:
      'There is not enough logged yet to say where you are in your cycle, so here is what holds true across all of it. Two or three logged periods is usually enough for the guidance to become specific.',
    detail: {
      whatIsHappening: [
        'Guidance here becomes specific once there are a couple of period start dates to work from. Until then nothing is being assumed about you.',
        'A cycle is counted from the first day of one period to the day before the next. Anywhere from 21 to 35 days is ordinary, and cycles vary between people far more than most guidance admits.',
        'Bleeding usually lasts between two and seven days.',
      ],
      eating: {
        headline: 'Four things that hold true in every week of the month.',
        foods: [
          {
            food: 'Iron with vitamin C',
            why: 'Menstruating people lose iron every month and low iron is the most common reason for tiredness that does not lift. Eating iron together with something sour or citrusy multiplies how much of it you absorb.',
            when: 'Lunch and dinner, especially during and just after bleeding.',
          },
          {
            food: 'Protein at every meal',
            why: 'It steadies appetite, protects muscle and makes every other part of this easier.',
            when: 'A palm-sized portion, three times a day.',
          },
          {
            food: 'Fibre, around 25 to 30 g a day',
            why: 'It keeps digestion moving and helps clear surplus oestrogen through the gut.',
            when: 'Across all meals, with enough water alongside it.',
          },
          {
            food: 'Calcium and magnesium daily: curd, milk, ragi, sesame, seeds, nuts, greens',
            why: 'Both are involved in muscle, mood and sleep, and both are commonly short in ordinary diets.',
            when: 'Something at each of two meals.',
          },
        ],
        easeOff: [
          'Long gaps without eating.',
          'Starting any supplement on your own. What you need and how much is a blood test and a doctor.',
        ],
      },
      hydration: {
        headline: 'Two to three litres a day, adjusted for heat and training.',
        points: [
          'Pale straw-coloured urine is the simplest check there is.',
          'Tea and coffee count towards fluid, but keep them away from iron-rich meals.',
        ],
      },
      movement: {
        headline: 'Something most days, hard some days.',
        points: [
          'Around 150 minutes a week of moderate activity, plus two sessions of strength work, is the general adult guidance.',
          'Once a few cycles are logged, this page will suggest when to push and when to ease off based on your own pattern.',
        ],
      },
      sleep: {
        headline: 'Seven to nine hours, at consistent times.',
        points: [
          'A steady wake time does more than a perfect bedtime.',
          'Daylight early, screens down late, a cool dark room.',
        ],
      },
      smallThings: [
        'Log the first day of your next period. One date is enough to start.',
        'Note anything you notice alongside it. Patterns become obvious across three months in a way they never are in one.',
      ],
    },
    notMedicalAdvice: NOT_MEDICAL_ADVICE,
  },
];

/** One phase, with the general guidance as a safe fallback. */
export function guidanceFor(phase: CyclePhase): PhaseGuidance {
  return PHASE_GUIDANCE.find((g) => g.phase === phase) || (PHASE_GUIDANCE[PHASE_GUIDANCE.length - 1] as PhaseGuidance);
}

/** Just the two-line version, for a card that has not been expanded. */
export function guidanceSummary(phase: CyclePhase): { title: string; summary: string; notMedicalAdvice: string } {
  const g = guidanceFor(phase);
  return { title: g.title, summary: g.summary, notMedicalAdvice: g.notMedicalAdvice };
}

// ---------------------------------------------------------------------------
// 5. RED FLAGS
//
// Things that are worth a doctor looking at, described plainly and without a guess at the cause.
// There is no condition named anywhere in this list on purpose. Naming one would be a diagnosis,
// and a wrong one frightens somebody for no reason while a right one still is not ours to make.
// ---------------------------------------------------------------------------

export type RedFlagUrgency = 'same_day' | 'soon';

export interface RedFlag {
  id: string;
  /** What she would actually notice, in her words rather than clinical ones. */
  sign: string;
  /** Why it is on the list. Never a cause, only why it is worth checking. */
  context: string;
  /** The action line. Always calm, always concrete. */
  action: string;
  urgency: RedFlagUrgency;
  /** Lowercase keywords for matchRedFlags(). Not shown. */
  match: string[];
}

export const RED_FLAGS: RedFlag[] = [
  {
    id: 'soaking_hourly',
    sign: 'Soaking through a pad or a tampon every hour for two hours or more in a row, or passing large clots repeatedly.',
    context: 'That is more bleeding than a period is expected to involve, and losing it at that rate can leave you short of iron quite quickly.',
    action: 'Please speak to a doctor today rather than waiting for the period to finish.',
    urgency: 'same_day',
    match: ['soaking', 'soak', 'flooding', 'clots', 'very heavy', 'heavy bleeding', 'hourly'],
  },
  {
    id: 'severe_pain',
    sign: 'Pain severe enough to stop you doing ordinary things, or pain that the relief you normally use does not touch.',
    context: 'Period pain is common, but pain that takes a day away from you, or that has changed from what is usual for you, is worth a proper look rather than an endurance test.',
    action: 'Please speak to a doctor. If it came on suddenly and severely, please do that today.',
    urgency: 'same_day',
    match: ['severe pain', 'unbearable', 'worst pain', 'cannot stand', 'agony', 'pain killers not working'],
  },
  {
    id: 'sudden_one_sided',
    sign: 'Sudden severe pain on one side of the lower abdomen, especially with feeling sick or faint.',
    context: 'A brief mid-cycle twinge is ordinary. Sudden severe pain is a different thing and it should not be waited out at home.',
    action: 'Please go to urgent or emergency care now. Do not drive yourself.',
    urgency: 'same_day',
    match: ['sudden pain', 'one side', 'sharp pain', 'stabbing'],
  },
  {
    id: 'over_seven_days',
    sign: 'Bleeding that carries on for more than seven days.',
    context: 'Most periods finish within about seven days. Longer than that, month after month, is worth understanding rather than adjusting to.',
    action: 'Please book an appointment with a doctor this week.',
    urgency: 'soon',
    match: ['long period', 'still bleeding', 'more than 7', 'ten days', 'two weeks bleeding'],
  },
  {
    id: 'between_periods',
    sign: 'Bleeding between periods, or bleeding after sex.',
    context: 'Occasional light spotting has plenty of ordinary explanations, but bleeding at these times is something a doctor should see rather than something to watch for a few more months.',
    action: 'Please book an appointment with a doctor. Sooner is better than later here.',
    urgency: 'soon',
    match: ['between periods', 'spotting', 'after sex', 'mid cycle bleeding', 'irregular bleeding'],
  },
  {
    id: 'fainting',
    sign: 'Fainting or nearly fainting, breathlessness on ordinary stairs, a racing heart, or looking unusually pale.',
    context: 'These come together when the body is short of blood or of iron, and they are the point at which heavy periods stop being only inconvenient.',
    action: 'Please speak to a doctor today, and ask about a blood test.',
    urgency: 'same_day',
    match: ['faint', 'fainting', 'dizzy', 'dizzi', 'blackout', 'breathless', 'palpitations', 'pale', 'heart racing'],
  },
  {
    id: 'fever_with_pain',
    sign: 'Fever alongside pelvic pain, or discharge that smells unpleasant.',
    context: 'Fever with pain is the combination that should never be left to settle on its own.',
    action: 'Please see a doctor today.',
    urgency: 'same_day',
    match: ['fever', 'temperature', 'smell', 'foul', 'discharge'],
  },
  {
    id: 'periods_stopped',
    sign: 'Periods stopping for three months or more when you were not expecting them to.',
    context: 'There are many ordinary reasons this happens and most of them are manageable, but all of them are worth identifying rather than waiting out.',
    action: 'Please book an appointment with a doctor.',
    urgency: 'soon',
    match: ['no period', 'missed period', 'stopped', 'not had a period', 'amenorrhea'],
  },
  {
    id: 'bleeding_in_pregnancy',
    sign: 'Any bleeding while pregnant, or while you might be pregnant.',
    context: 'This one is not for a tracker to interpret in either direction.',
    action: 'Please contact a doctor straight away, today.',
    urgency: 'same_day',
    match: ['pregnant', 'pregnancy', 'bleeding while pregnant'],
  },
  {
    id: 'mood_severe',
    sign: 'Mood before a period that becomes severe: unable to work, unable to be around people, or thoughts of harming yourself.',
    context: 'Premenstrual mood changes are common. Changes this severe are not something to manage alone, and there is real help for them.',
    action: 'Please speak to a doctor. If you are thinking of harming yourself, please reach out today to a doctor, a helpline or someone you trust, rather than waiting.',
    urgency: 'same_day',
    match: ['depressed', 'suicidal', 'harm myself', 'cannot cope', 'panic', 'severe mood'],
  },
];

/** The line that sits above the list, so it reads as care rather than as a warning notice. */
export const RED_FLAG_INTRO =
  'None of the following means something is wrong. They are simply the things worth having a doctor look at rather than waiting out, and knowing them is what makes the waiting-out decision yours.';

export const RED_FLAG_FOOTER =
  'This list does not diagnose anything and it is not a complete list. If something feels wrong to you and it is not written here, that is still a good enough reason to see a doctor.';

/**
 * Surfaces the relevant "please speak to a doctor" lines for free text she has already written.
 *
 * This is escalation, not triage. It suggests no cause and it draws no conclusion. It only makes
 * sure that if she typed "I have been fainting" into a consultation request, she is not left waiting
 * for a reply when what she needs is a doctor today.
 */
export function matchRedFlags(text: string): RedFlag[] {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return [];
  return RED_FLAGS.filter((f) => f.match.some((k) => s.includes(k)));
}

// ---------------------------------------------------------------------------
// 6. HER OWN DATA
//
// Every function below takes the owner's user id and puts it in the WHERE clause. Nothing selects
// broadly and filters afterwards, so there is no version of these that leaks by omission. There is
// deliberately no variant that takes an admin id and a subject id.
// ---------------------------------------------------------------------------

export const FLOW_OPTIONS = ['spotting', 'light', 'medium', 'heavy'] as const;
export type FlowLevel = typeof FLOW_OPTIONS[number];

export const SYMPTOM_OPTIONS = [
  'Cramps', 'Lower back ache', 'Headache', 'Bloating', 'Breast tenderness', 'Fatigue',
  'Nausea', 'Low mood', 'Irritability', 'Anxiety', 'Trouble sleeping', 'Food cravings',
  'Acne', 'Dizziness', 'Heavy bleeding', 'Spotting',
] as const;

export const SEVERITY_LABELS = ['', 'Mild', 'Moderate', 'Strong'];

export interface CycleRow {
  id: string;
  startedOn: string;
  endedOn: string | null;
  flow: string | null;
  notes: string | null;
}

/** Logs the first day of a period. Re-logging the same day updates it rather than duplicating. */
export async function logCycleStart(
  userId: string,
  input: { startedOn: string; flow?: string | null; notes?: string | null }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const day = safeDay(input.startedOn);
  if (!day) return { ok: false, error: 'Please choose a valid date.' };
  const start = parseDay(day) as Date;
  if (start.getTime() > addDays(today(), 1).getTime()) {
    return { ok: false, error: 'That date is in the future. You can log it when it arrives.' };
  }
  const flow = FLOW_OPTIONS.includes(String(input.flow || '') as FlowLevel) ? String(input.flow) : null;
  const notes = cleanText(input.notes, MAX_NOTE_CHARS);
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      INSERT INTO wellness_cycles (user_id, started_on, flow, notes)
      VALUES (${userId}::uuid, ${day}::date, ${flow}, ${notes})
      ON CONFLICT (user_id, started_on) DO UPDATE
        SET flow = COALESCE(EXCLUDED.flow, wellness_cycles.flow),
            notes = COALESCE(EXCLUDED.notes, wellness_cycles.notes),
            updated_at = NOW()
      RETURNING id
    `);
    return { ok: true, id: rows(r)[0]?.id };
  } catch (e: any) {
    console.error('[wellness] logCycleStart:', errText(e));
    return { ok: false, error: 'That did not save. Please try once more.' };
  }
}

/** Closes off a period. Scoped to the owner in the query, not afterwards. */
export async function setCycleEnd(
  userId: string,
  cycleId: string,
  endedOn: string | null
): Promise<{ ok: boolean; error?: string }> {
  const day = endedOn === null ? null : safeDay(endedOn);
  if (endedOn !== null && !day) return { ok: false, error: 'Please choose a valid date.' };
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      UPDATE wellness_cycles
      SET ended_on = ${day}::date, updated_at = NOW()
      WHERE id = ${cycleId}::uuid AND user_id = ${userId}::uuid
        AND (${day}::date IS NULL OR ${day}::date >= started_on)
      RETURNING id
    `);
    if (!rows(r).length) return { ok: false, error: 'The end date needs to be on or after the start date.' };
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] setCycleEnd:', errText(e));
    return { ok: false, error: 'That did not save. Please try once more.' };
  }
}

export async function updateCycle(
  userId: string,
  cycleId: string,
  input: { flow?: string | null; notes?: string | null }
): Promise<{ ok: boolean }> {
  const flow = FLOW_OPTIONS.includes(String(input.flow || '') as FlowLevel) ? String(input.flow) : null;
  const notes = cleanText(input.notes, MAX_NOTE_CHARS);
  try {
    await ensureWellnessSchema();
    await db.execute(sql`
      UPDATE wellness_cycles SET flow = ${flow}, notes = ${notes}, updated_at = NOW()
      WHERE id = ${cycleId}::uuid AND user_id = ${userId}::uuid
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] updateCycle:', errText(e));
    return { ok: false };
  }
}

/** Hers to delete, with no copy kept. */
export async function deleteCycle(userId: string, cycleId: string): Promise<{ ok: boolean }> {
  try {
    await ensureWellnessSchema();
    await db.execute(sql`DELETE FROM wellness_cycles WHERE id = ${cycleId}::uuid AND user_id = ${userId}::uuid`);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] deleteCycle:', errText(e));
    return { ok: false };
  }
}

/** Newest first. Dates come back as text so nothing has to guess at a timezone. */
export async function listCycles(userId: string, limit = 24): Promise<CycleRow[]> {
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT id,
             to_char(started_on, 'YYYY-MM-DD') AS started_on,
             to_char(ended_on, 'YYYY-MM-DD') AS ended_on,
             flow, notes
      FROM wellness_cycles
      WHERE user_id = ${userId}::uuid
      ORDER BY started_on DESC
      LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}
    `);
    return rows(r).map((x) => ({
      id: x.id,
      startedOn: x.started_on,
      endedOn: x.ended_on || null,
      flow: x.flow || null,
      notes: x.notes || null,
    }));
  } catch (e: any) {
    console.error('[wellness] listCycles:', errText(e));
    return [];
  }
}

export interface SymptomRow {
  id: string;
  loggedOn: string;
  symptom: string;
  severity: number;
  note: string | null;
}

export async function logSymptom(
  userId: string,
  input: { loggedOn?: string; symptom: string; severity?: number; note?: string | null }
): Promise<{ ok: boolean; id?: string; error?: string; redFlags: RedFlag[] }> {
  const day = safeDay(input.loggedOn || ymd(today()));
  const symptom = cleanText(input.symptom, 60);
  if (!day) return { ok: false, error: 'Please choose a valid date.', redFlags: [] };
  if (!symptom) return { ok: false, error: 'Please choose what you noticed.', redFlags: [] };
  const severity = Math.max(1, Math.min(3, Math.round(Number(input.severity) || 1)));
  const note = cleanText(input.note, MAX_NOTE_CHARS);
  // Escalation, not triage: if what she wrote matches something on the doctor list, the page can
  // show that line straight away rather than leaving it inside a log nobody reads.
  const redFlags = matchRedFlags(`${symptom} ${note || ''}`);
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      INSERT INTO wellness_symptoms (user_id, logged_on, symptom, severity, note)
      VALUES (${userId}::uuid, ${day}::date, ${symptom}, ${severity}, ${note})
      RETURNING id
    `);
    return { ok: true, id: rows(r)[0]?.id, redFlags };
  } catch (e: any) {
    console.error('[wellness] logSymptom:', errText(e));
    return { ok: false, error: 'That did not save. Please try once more.', redFlags };
  }
}

export async function listSymptoms(userId: string, sinceDays = 90, limit = 200): Promise<SymptomRow[]> {
  const days = Math.max(1, Math.min(730, Math.floor(sinceDays)));
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT id, to_char(logged_on, 'YYYY-MM-DD') AS logged_on, symptom, severity, note
      FROM wellness_symptoms
      WHERE user_id = ${userId}::uuid AND logged_on >= (CURRENT_DATE - make_interval(days => ${days}::int))
      ORDER BY logged_on DESC, created_at DESC
      LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}
    `);
    return rows(r).map((x) => ({
      id: x.id,
      loggedOn: x.logged_on,
      symptom: x.symptom,
      severity: Number(x.severity) || 1,
      note: x.note || null,
    }));
  } catch (e: any) {
    console.error('[wellness] listSymptoms:', errText(e));
    return [];
  }
}

export async function deleteSymptom(userId: string, id: string): Promise<{ ok: boolean }> {
  try {
    await ensureWellnessSchema();
    await db.execute(sql`DELETE FROM wellness_symptoms WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] deleteSymptom:', errText(e));
    return { ok: false };
  }
}

/** Removes everything this system holds about her, in one call. Nothing is archived elsewhere. */
export async function deleteAllMyWellnessData(userId: string): Promise<{ ok: boolean }> {
  try {
    await ensureWellnessSchema();
    await db.execute(sql`DELETE FROM wellness_symptoms WHERE user_id = ${userId}::uuid`);
    await db.execute(sql`DELETE FROM wellness_cycles WHERE user_id = ${userId}::uuid`);
    await db.execute(sql`DELETE FROM wellness_consult_requests WHERE user_id = ${userId}::uuid`);
    await db.execute(sql`DELETE FROM wellness_settings WHERE user_id = ${userId}::uuid`);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] deleteAllMyWellnessData:', errText(e));
    return { ok: false };
  }
}

export interface WellnessSettings {
  remindersEnabled: boolean;
  averageCycleDays: number | null;
  lastReviewedAt: string | null;
}

export async function getSettings(userId: string): Promise<WellnessSettings> {
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT reminders_enabled, average_cycle_days, last_reviewed_at
      FROM wellness_settings WHERE user_id = ${userId}::uuid LIMIT 1
    `);
    const row = rows(r)[0];
    if (!row) return { remindersEnabled: false, averageCycleDays: null, lastReviewedAt: null };
    return {
      remindersEnabled: !!row.reminders_enabled,
      averageCycleDays: row.average_cycle_days === null || row.average_cycle_days === undefined ? null : Number(row.average_cycle_days),
      lastReviewedAt: row.last_reviewed_at ? new Date(row.last_reviewed_at).toISOString() : null,
    };
  } catch (e: any) {
    console.error('[wellness] getSettings:', errText(e));
    return { remindersEnabled: false, averageCycleDays: null, lastReviewedAt: null };
  }
}

export async function saveSettings(
  userId: string,
  input: { remindersEnabled?: boolean; averageCycleDays?: number | null; markReviewed?: boolean }
): Promise<{ ok: boolean }> {
  const reminders = !!input.remindersEnabled;
  const raw = Number(input.averageCycleDays);
  const avg = Number.isFinite(raw) && raw >= MIN_PLAUSIBLE_CYCLE_DAYS && raw <= MAX_PLAUSIBLE_CYCLE_DAYS ? Math.round(raw) : null;
  const reviewed = !!input.markReviewed;
  try {
    await ensureWellnessSchema();
    await db.execute(sql`
      INSERT INTO wellness_settings (user_id, reminders_enabled, average_cycle_days, last_reviewed_at)
      VALUES (${userId}::uuid, ${reminders}, ${avg}::int, ${reviewed ? sql`NOW()` : sql`NULL::timestamptz`})
      ON CONFLICT (user_id) DO UPDATE
        SET reminders_enabled = EXCLUDED.reminders_enabled,
            average_cycle_days = EXCLUDED.average_cycle_days,
            last_reviewed_at = COALESCE(EXCLUDED.last_reviewed_at, wellness_settings.last_reviewed_at),
            updated_at = NOW()
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] saveSettings:', errText(e));
    return { ok: false };
  }
}

export interface CycleOverview {
  cycles: CycleRow[];
  cyclesLogged: number;
  averageCycleDays: number | null;
  averagePeriodDays: number | null;
  lastStart: string | null;
  dayOfCycle: number | null;
  phase: CyclePhase;
  prediction: Prediction;
  guidance: PhaseGuidance;
}

/** Everything one page needs about her own cycle, in a single round trip. */
export async function cycleOverview(userId: string): Promise<CycleOverview> {
  const [cycles, settings] = await Promise.all([listCycles(userId, 24), getSettings(userId)]);
  const phase = currentPhase(cycles);
  return {
    cycles,
    cyclesLogged: cycles.length,
    averageCycleDays: averageCycleLength(cycles),
    averagePeriodDays: averagePeriodLength(cycles),
    lastStart: cycles.length ? cycles[0].startedOn : null,
    dayOfCycle: cycleDay(cycles),
    phase,
    prediction: predictNext(cycles, { overrideCycleDays: settings.averageCycleDays }),
    guidance: guidanceFor(phase),
  };
}

// ---------------------------------------------------------------------------
// CONSULTATIONS
//
// The body of a request is read by exactly two people: the woman who wrote it, and the consultant
// it is routed to. There is no function here that returns a message, a topic or a response to an
// administrator. The routing helper below returns identifiers and timing only, so a queue can be
// kept moving without anybody reading what is in it.
// ---------------------------------------------------------------------------

export const CONSULT_TOPICS = [
  'Periods and cycle',
  'Pain and cramping',
  'Food and nutrition',
  'Energy and tiredness',
  'Sleep',
  'Mood and stress',
  'Pregnancy and fertility',
  'Menopause and the years before it',
  'A general question',
] as const;

export const CONSULT_URGENCIES = ['routine', 'soon', 'priority'] as const;
export type ConsultUrgency = typeof CONSULT_URGENCIES[number];

export const URGENCY_LABELS: { value: ConsultUrgency; label: string; hint: string }[] = [
  { value: 'routine', label: 'Whenever there is time', hint: 'Usually answered within a few days.' },
  { value: 'soon', label: 'Sometime this week', hint: 'Moved ahead of general questions.' },
  { value: 'priority', label: 'As soon as possible', hint: 'Looked at first. Still not a substitute for a doctor today.' },
];

export const CONSULT_STATUSES = ['open', 'assigned', 'answered', 'closed', 'cancelled'] as const;
export type ConsultStatus = typeof CONSULT_STATUSES[number];

/** Shown above the request form. Nobody should wait on a queue when they need care now. */
export const CONSULT_NOT_URGENT_CARE =
  'This goes to a person, not to a doctor on call, and a reply takes time. If something needs seeing today, please contact a doctor or urgent care rather than waiting for an answer here.';

/** What she is told about who reads it. It is true, which is the only reason to say it. */
export const CONSULT_PRIVACY_NOTE =
  'What you write here is read by the consultant it goes to and by nobody else. It is not visible to your manager, to HR, to the administrators of this site, or to anyone who reports on how the programme is doing. Those reports only ever count requests, never open them.';

export interface ConsultRow {
  id: string;
  topic: string | null;
  urgency: string;
  message: string | null;
  status: string;
  response: string | null;
  consultantName: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export async function createConsultRequest(
  userId: string,
  input: { topic?: string | null; urgency?: string | null; message: string; consultantUserId?: string | null }
): Promise<{ ok: boolean; id?: string; error?: string; redFlags: RedFlag[] }> {
  const message = cleanText(input.message, MAX_MESSAGE_CHARS);
  if (!message) return { ok: false, error: 'Please write a little about what you would like to talk through.', redFlags: [] };
  const topic = (CONSULT_TOPICS as readonly string[]).includes(String(input.topic || '')) ? String(input.topic) : null;
  const urgency = (CONSULT_URGENCIES as readonly string[]).includes(String(input.urgency || '')) ? String(input.urgency) : 'routine';
  const redFlags = matchRedFlags(message);
  try {
    await ensureWellnessSchema();
    // She chooses who reads it. Confirm that choice is a real, active consultant before storing it,
    // rather than trusting the id that came off the form.
    const chosen = input.consultantUserId && (await isWellnessConsultant(input.consultantUserId))
      ? String(input.consultantUserId)
      : null;
    const r = await db.execute(sql`
      INSERT INTO wellness_consult_requests (user_id, topic, urgency, message, status, assigned_to, assigned_at)
      VALUES (
        ${userId}::uuid, ${topic}, ${urgency}, ${message},
        ${chosen ? 'assigned' : 'open'},
        ${chosen}::uuid,
        ${chosen ? sql`NOW()` : sql`NULL::timestamptz`}
      )
      RETURNING id
    `);
    return { ok: true, id: rows(r)[0]?.id, redFlags };
  } catch (e: any) {
    console.error('[wellness] createConsultRequest:', errText(e));
    return { ok: false, error: 'That did not send. Please try once more.', redFlags };
  }
}

/** Her own requests, with the replies. Scoped in the query. */
export async function listMyConsultRequests(userId: string, limit = 20): Promise<ConsultRow[]> {
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT q.id, q.topic, q.urgency, q.message, q.status, q.response, q.created_at, q.answered_at,
             c.display_name AS consultant_name
      FROM wellness_consult_requests q
      LEFT JOIN wellness_consultants c ON c.user_id = q.assigned_to
      WHERE q.user_id = ${userId}::uuid
      ORDER BY q.created_at DESC
      LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}
    `);
    return rows(r).map(mapConsultRow);
  } catch (e: any) {
    console.error('[wellness] listMyConsultRequests:', errText(e));
    return [];
  }
}

function mapConsultRow(x: any): ConsultRow {
  return {
    id: x.id,
    topic: x.topic || null,
    urgency: x.urgency || 'routine',
    message: x.message || null,
    status: x.status || 'open',
    response: x.response || null,
    consultantName: x.consultant_name || null,
    createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
    answeredAt: x.answered_at ? new Date(x.answered_at).toISOString() : null,
  };
}

export async function getMyConsultRequest(userId: string, id: string): Promise<ConsultRow | null> {
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT q.id, q.topic, q.urgency, q.message, q.status, q.response, q.created_at, q.answered_at,
             c.display_name AS consultant_name
      FROM wellness_consult_requests q
      LEFT JOIN wellness_consultants c ON c.user_id = q.assigned_to
      WHERE q.id = ${id}::uuid AND q.user_id = ${userId}::uuid
      LIMIT 1
    `);
    const row = rows(r)[0];
    return row ? mapConsultRow(row) : null;
  } catch (e: any) {
    console.error('[wellness] getMyConsultRequest:', errText(e));
    return null;
  }
}

export async function cancelConsultRequest(userId: string, id: string): Promise<{ ok: boolean }> {
  try {
    await ensureWellnessSchema();
    await db.execute(sql`
      UPDATE wellness_consult_requests
      SET status = 'cancelled', message = NULL, closed_at = NOW(), updated_at = NOW()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND status IN ('open', 'assigned')
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] cancelConsultRequest:', errText(e));
    return { ok: false };
  }
}

// --- The consultant side -----------------------------------------------------
//
// THIS HALF OF THE SYSTEM HAD NO SCREEN AT ALL.
//
// A woman could write a consultation request and the row was stored correctly. Nothing then listed
// it for anybody, nothing routed it, and nothing could answer it: listAssignedConsults,
// getAssignedConsult, respondToConsult, listUnassignedForRouting, routeConsultToConsultant,
// upsertConsultant and setConsultantActive were called by no page in the repository. The request
// form told her "it goes to one wellness consultant, who reads it and writes back on this page",
// and no consultant could have read it. That is the worst shape of stub in this codebase — not a
// dead helper, but a promise made to somebody at the moment she asked for help.
//
// There are now two surfaces: /portal/wellness/consultant (the pool's own queue: take a waiting
// request, read the one assigned to you, write back) and /admin/wellness/consultants (appointing
// the pool, which involves no health data at all).
//
// EVERY READ BELOW IS DISCRIMINATED. These functions used to return [] or null on a query failure,
// which on a consultant's queue reads as "nobody is waiting" — the single most dangerous empty
// state in this system. { ok:false, reason } is now returned and the page prints it.

export interface ConsultantRow {
  userId: string;
  displayName: string;
  credentials: string | null;
  focus: string | null;
  isActive: boolean;
}

/**
 * The engine's read result. An empty list and a failed query are different facts, and on a health
 * queue they are opposite instructions to the person reading the screen.
 */
export type WellnessRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Names only. Safe to show on the request form so she can choose who reads it. */
export async function listConsultants(activeOnly = true): Promise<WellnessRead<ConsultantRow[]>> {
  try {
    await ensureWellnessSchema();
    const r = activeOnly
      ? await db.execute(sql`SELECT user_id, display_name, credentials, focus, is_active FROM wellness_consultants WHERE is_active = true ORDER BY display_name`)
      : await db.execute(sql`SELECT user_id, display_name, credentials, focus, is_active FROM wellness_consultants ORDER BY is_active DESC, display_name`);
    return {
      ok: true,
      value: rows(r).map((x) => ({
        userId: x.user_id,
        displayName: x.display_name,
        credentials: x.credentials || null,
        focus: x.focus || null,
        isActive: !!x.is_active,
      })),
    };
  } catch (e: any) {
    const reason = errText(e);
    console.error('[wellness] listConsultants:', reason);
    return { ok: false, reason };
  }
}

/**
 * An account to appoint to the pool, looked up by the address the administrator typed.
 *
 * Reads name and email from `users` and nothing else. It touches no wellness table, no employee
 * record and no health column: appointing a consultant is an administrative act about an account,
 * not about anybody's health.
 */
export async function findAccountForConsultant(email: string): Promise<WellnessRead<{ id: string; name: string; email: string } | null>> {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { ok: true, value: null };
  try {
    const r = await db.execute(sql`SELECT id, name, email FROM users WHERE LOWER(email) = ${addr} LIMIT 1`);
    const row = rows(r)[0];
    return { ok: true, value: row ? { id: String(row.id), name: String(row.name || ''), email: String(row.email || '') } : null };
  } catch (e: any) {
    const reason = errText(e);
    console.error('[wellness] findAccountForConsultant:', reason);
    return { ok: false, reason };
  }
}

/**
 * Pool membership is the only thing that lets somebody read a request, and it is checked here on
 * every consultant call rather than assumed from a role. Being an administrator does not grant it.
 */
export async function isWellnessConsultant(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`SELECT 1 FROM wellness_consultants WHERE user_id = ${String(userId)}::uuid AND is_active = true LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    console.error('[wellness] isWellnessConsultant:', errText(e));
    return false; // fail closed
  }
}

export async function upsertConsultant(input: {
  userId: string;
  displayName: string;
  credentials?: string | null;
  focus?: string | null;
  isActive?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const name = cleanText(input.displayName, 200);
  if (!name) return { ok: false, error: 'A name is needed.' };
  try {
    await ensureWellnessSchema();
    await db.execute(sql`
      INSERT INTO wellness_consultants (user_id, display_name, credentials, focus, is_active)
      VALUES (${String(input.userId)}::uuid, ${name}, ${cleanText(input.credentials, 200)}, ${cleanText(input.focus, 500)}, ${input.isActive !== false})
      ON CONFLICT (user_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            credentials = EXCLUDED.credentials,
            focus = EXCLUDED.focus,
            is_active = EXCLUDED.is_active,
            updated_at = NOW()
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] upsertConsultant:', errText(e));
    return { ok: false, error: 'That did not save.' };
  }
}

export async function setConsultantActive(userId: string, active: boolean): Promise<{ ok: boolean }> {
  try {
    await ensureWellnessSchema();
    await db.execute(sql`UPDATE wellness_consultants SET is_active = ${!!active}, updated_at = NOW() WHERE user_id = ${String(userId)}::uuid`);
    return { ok: true };
  } catch (e: any) {
    console.error('[wellness] setConsultantActive:', errText(e));
    return { ok: false };
  }
}

/**
 * A consultant's own queue: only what was routed to her.
 *
 * 'not-in-pool' is returned as a FAILURE rather than an empty queue, because a consultant whose
 * pool membership was deactivated while she was reading needs to be told that, not shown a page
 * saying nobody needs her.
 */
export async function listAssignedConsults(consultantUserId: string, limit = 50): Promise<WellnessRead<ConsultRow[]>> {
  if (!(await isWellnessConsultant(consultantUserId))) return { ok: false, reason: 'not-in-pool' };
  try {
    const r = await db.execute(sql`
      SELECT q.id, q.topic, q.urgency, q.message, q.status, q.response, q.created_at, q.answered_at,
             NULL::text AS consultant_name
      FROM wellness_consult_requests q
      WHERE q.assigned_to = ${String(consultantUserId)}::uuid
        AND q.status IN ('assigned', 'answered')
      ORDER BY CASE q.urgency WHEN 'priority' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, q.created_at ASC
      LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}
    `);
    return { ok: true, value: rows(r).map(mapConsultRow) };
  } catch (e: any) {
    const reason = errText(e);
    console.error('[wellness] listAssignedConsults:', reason);
    return { ok: false, reason };
  }
}

/** One assigned request. value===null means "not yours / no such request", which is not a failure. */
export async function getAssignedConsult(consultantUserId: string, id: string): Promise<WellnessRead<ConsultRow | null>> {
  if (!(await isWellnessConsultant(consultantUserId))) return { ok: false, reason: 'not-in-pool' };
  try {
    const r = await db.execute(sql`
      SELECT q.id, q.topic, q.urgency, q.message, q.status, q.response, q.created_at, q.answered_at,
             NULL::text AS consultant_name
      FROM wellness_consult_requests q
      WHERE q.id = ${id}::uuid AND q.assigned_to = ${String(consultantUserId)}::uuid
      LIMIT 1
    `);
    const row = rows(r)[0];
    return { ok: true, value: row ? mapConsultRow(row) : null };
  } catch (e: any) {
    const reason = errText(e);
    console.error('[wellness] getAssignedConsult:', reason);
    return { ok: false, reason };
  }
}

/**
 * Write the reply, and tell her it arrived.
 *
 * THE NOTIFICATION CARRIES NO CONTENT. It says a reply is waiting and links to her own page; the
 * words are read there, behind her own gate. The UPDATE returns the requester's user id for that
 * one purpose — it is the id of the person being written to, which the consultant is already
 * authorised to correspond with, and it is not returned to any caller.
 *
 * The notify() failure is caught SEPARATELY from the write. A notifier that is down must never
 * make a saved reply report itself as unsaved — she would be told to write it again and the
 * consultant would answer twice.
 */
export async function respondToConsult(
  consultantUserId: string,
  id: string,
  response: string
): Promise<{ ok: boolean; error?: string }> {
  const text = cleanText(response, MAX_MESSAGE_CHARS);
  if (!text) return { ok: false, error: 'Please write a reply first.' };
  if (!(await isWellnessConsultant(consultantUserId))) return { ok: false, error: 'Not available.' };
  let requesterId = '';
  try {
    const r = await db.execute(sql`
      UPDATE wellness_consult_requests
      SET response = ${text}, answered_at = NOW(), status = 'answered', updated_at = NOW()
      WHERE id = ${id}::uuid AND assigned_to = ${String(consultantUserId)}::uuid
      RETURNING id, user_id
    `);
    const row = rows(r)[0];
    if (!row) return { ok: false, error: 'That request is no longer open to you.' };
    requesterId = String(row.user_id || '');
  } catch (e: any) {
    console.error('[wellness] respondToConsult:', errText(e));
    return { ok: false, error: 'That did not save. Nothing has been sent.' };
  }
  if (requesterId) {
    try {
      const { notifyUser } = await import('@/lib/notify');
      await notifyUser(requesterId, {
        title: 'There is a reply to your consultation',
        body: 'Open your consultation page to read it.',
        type: 'message',
        actionUrl: '/portal/wellness/consult',
      });
    } catch (e: any) {
      // Logged, never surfaced as a failed reply: the reply IS saved by this point.
      console.error('[wellness] respondToConsult.notify:', errText(e));
    }
  }
  return { ok: true };
}

export interface RoutingRow {
  id: string;
  urgency: string;
  createdAt: string;
  waitingHours: number;
}

/**
 * The routing queue, for keeping unassigned requests moving.
 *
 * It returns an identifier, an urgency and how long it has been waiting. It does NOT return the
 * message, the topic, the response or the name or id of the person who wrote it, and it must never
 * be changed to. Whoever routes a request is deciding which consultant should read it, which needs
 * none of that. This is the only function in the file that touches a request belonging to somebody
 * other than the writer or the assigned consultant, and this is why its SELECT list is short.
 */
export async function listUnassignedForRouting(limit = 50): Promise<WellnessRead<RoutingRow[]>> {
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT id, urgency, created_at,
             ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0)::int AS waiting_hours
      FROM wellness_consult_requests
      WHERE status = 'open' AND assigned_to IS NULL
      ORDER BY CASE urgency WHEN 'priority' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, created_at ASC
      LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}
    `);
    return {
      ok: true,
      value: rows(r).map((x) => ({
        id: x.id,
        urgency: x.urgency || 'routine',
        createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
        waitingHours: Number(x.waiting_hours) || 0,
      })),
    };
  } catch (e: any) {
    const reason = errText(e);
    console.error('[wellness] listUnassignedForRouting:', reason);
    return { ok: false, reason };
  }
}

/**
 * Routes a request by id. Reads nothing about it, and writes only the assignment.
 *
 * `routedBy` exists so the consultant page can call this to TAKE a request for herself: when the
 * router and the consultant are the same person there is nobody to notify, and when they differ the
 * consultant is told there is something in her queue. The notification names no requester, no topic
 * and no words — only that a request was routed.
 *
 * WHERE status = 'open' is the whole concurrency story: two consultants pressing "Take this" on the
 * same waiting request cannot both win, and the second is told plainly that somebody else has it.
 */
export async function routeConsultToConsultant(
  id: string,
  consultantUserId: string,
  routedBy?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await isWellnessConsultant(consultantUserId))) return { ok: false, error: 'That person is not an active consultant.' };
  try {
    const r = await db.execute(sql`
      UPDATE wellness_consult_requests
      SET assigned_to = ${String(consultantUserId)}::uuid, assigned_at = NOW(), status = 'assigned', updated_at = NOW()
      WHERE id = ${id}::uuid AND status = 'open'
      RETURNING id
    `);
    if (!rows(r).length) return { ok: false, error: 'That request is no longer waiting — somebody else has taken it.' };
  } catch (e: any) {
    console.error('[wellness] routeConsultToConsultant:', errText(e));
    return { ok: false, error: 'That did not save. The request is still waiting.' };
  }
  if (routedBy && routedBy !== consultantUserId) {
    try {
      const { notifyUser } = await import('@/lib/notify');
      await notifyUser(consultantUserId, {
        title: 'A consultation request was routed to you',
        body: 'It is in your consultant queue.',
        type: 'message',
        actionUrl: '/portal/wellness/consultant',
      });
    } catch (e: any) {
      console.error('[wellness] routeConsultToConsultant.notify:', errText(e));
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 7. OVERSIGHT  -  aggregate only, and built so it cannot become anything else.
//
// These four functions answer the only questions oversight legitimately has: is the programme being
// used, is anybody waiting too long, and are requests being answered. None of them takes a user id,
// none of them selects a message, a topic body, a cycle or a symptom, and none of them can be
// narrowed to a person by any argument they accept.
//
// WHY THE MINIMUM GROUP SIZE. A count below MIN_GROUP is not a statistic, it is a description of
// specific people. In an organisation this size, "2 people asked about pregnancy this month" plus
// ordinary office knowledge names them. So anything covering fewer than MIN_GROUP distinct people
// is not published at all, and the word used is "too few to report" rather than a small number.
//
// WHY THE RESIDUAL IS NEVER PUBLISHED. Suppressing small categories while publishing the total lets
// anybody subtract their way back to the suppressed ones. That is the standard differencing attack
// on this kind of table, and it defeats the whole point. So when any category is held back, these
// functions report that some were held back and do not publish what is left over.
// ---------------------------------------------------------------------------

export interface SuppressibleCount {
  suppressed: boolean;
  count: number | null;
  label: string;
}

function suppressible(n: number | null | undefined, floor = MIN_GROUP): SuppressibleCount {
  const v = Number(n);
  if (!Number.isFinite(v) || v < floor) return { suppressed: true, count: null, label: TOO_FEW_LABEL };
  return { suppressed: false, count: Math.round(v), label: String(Math.round(v)) };
}

const windowDays = (d: number) => Math.max(1, Math.min(730, Math.floor(Number(d) || 90)));

export interface ActiveUsersResult {
  suppressed: boolean;
  people: number | null;
  windowDays: number;
  label: string;
}

/** How many distinct people used any part of the system in the window. No identities, ever. */
export async function activeUsers(days = 90): Promise<ActiveUsersResult> {
  const d = windowDays(days);
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT COUNT(DISTINCT u)::int AS people FROM (
        SELECT user_id AS u FROM wellness_cycles WHERE created_at >= NOW() - make_interval(days => ${d}::int)
        UNION
        SELECT user_id FROM wellness_symptoms WHERE created_at >= NOW() - make_interval(days => ${d}::int)
        UNION
        SELECT user_id FROM wellness_consult_requests WHERE created_at >= NOW() - make_interval(days => ${d}::int)
      ) t
    `);
    const s = suppressible(rows(r)[0]?.people);
    return { suppressed: s.suppressed, people: s.count, windowDays: d, label: s.label };
  } catch (e: any) {
    console.error('[wellness] activeUsers:', errText(e));
    return { suppressed: true, people: null, windowDays: d, label: TOO_FEW_LABEL };
  }
}

export interface ConsultLoadResult {
  suppressed: boolean;
  windowDays: number;
  people: number | null;
  total: SuppressibleCount;
  waiting: SuppressibleCount;
  withConsultant: SuppressibleCount;
  answered: SuppressibleCount;
  someCategoriesSuppressed: boolean;
  /** Longest current wait in hours. Published only when the whole set clears the floor. */
  longestWaitHours: number | null;
  note: string;
}

/** Demand and whether it is being picked up. Counts and hours only. */
export async function consultLoad(days = 90): Promise<ConsultLoadResult> {
  const d = windowDays(days);
  const blank: ConsultLoadResult = {
    suppressed: true,
    windowDays: d,
    people: null,
    total: { suppressed: true, count: null, label: TOO_FEW_LABEL },
    waiting: { suppressed: true, count: null, label: TOO_FEW_LABEL },
    withConsultant: { suppressed: true, count: null, label: TOO_FEW_LABEL },
    answered: { suppressed: true, count: null, label: TOO_FEW_LABEL },
    someCategoriesSuppressed: true,
    longestWaitHours: null,
    note: `Fewer than ${MIN_GROUP} people have used this in the period, so nothing is reported. That is the design, not a gap in the data.`,
  };
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(DISTINCT user_id)::int AS people,
             (COUNT(*) FILTER (WHERE status = 'open'))::int AS waiting,
             (COUNT(*) FILTER (WHERE status = 'assigned'))::int AS with_consultant,
             (COUNT(*) FILTER (WHERE status = 'answered' OR answered_at IS NOT NULL))::int AS answered,
             MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0)
               FILTER (WHERE answered_at IS NULL AND status IN ('open', 'assigned')) AS longest_wait_hours
      FROM wellness_consult_requests
      WHERE created_at >= NOW() - make_interval(days => ${d}::int)
    `);
    const row = rows(r)[0];
    if (!row) return blank;
    const people = Number(row.people) || 0;
    // The k-anonymity test is on distinct people, not on the number of requests. Forty requests
    // from three people is still a picture of three people.
    if (people < MIN_GROUP) return blank;

    const total = suppressible(row.total);
    const waiting = suppressible(row.waiting);
    const withConsultant = suppressible(row.with_consultant);
    const answered = suppressible(row.answered);
    const someSuppressed = waiting.suppressed || withConsultant.suppressed || answered.suppressed;
    return {
      suppressed: false,
      windowDays: d,
      people,
      total,
      waiting,
      withConsultant,
      answered,
      someCategoriesSuppressed: someSuppressed,
      longestWaitHours: row.longest_wait_hours === null || row.longest_wait_hours === undefined ? null : Math.round(Number(row.longest_wait_hours)),
      note: someSuppressed
        ? `Some categories held fewer than ${MIN_GROUP} and are not shown. The remainder is not published either, because it could be subtracted back out.`
        : '',
    };
  } catch (e: any) {
    console.error('[wellness] consultLoad:', errText(e));
    return blank;
  }
}

export interface ResponseTimeResult {
  suppressed: boolean;
  windowDays: number;
  averageHours: number | null;
  medianHours: number | null;
  answeredCount: number | null;
  note: string;
}

/** How long people wait for a reply. The number that tells you whether this actually works. */
export async function averageResponseHours(days = 90): Promise<ResponseTimeResult> {
  const d = windowDays(days);
  const blank: ResponseTimeResult = {
    suppressed: true,
    windowDays: d,
    averageHours: null,
    medianHours: null,
    answeredCount: null,
    note: `Fewer than ${MIN_GROUP} people have had a reply in this period, so no timing is reported.`,
  };
  try {
    await ensureWellnessSchema();
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n,
             COUNT(DISTINCT user_id)::int AS people,
             AVG(EXTRACT(EPOCH FROM (answered_at - created_at)) / 3600.0) AS avg_hours,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (answered_at - created_at)) / 3600.0
             ) AS median_hours
      FROM wellness_consult_requests
      WHERE answered_at IS NOT NULL
        AND answered_at >= created_at
        AND created_at >= NOW() - make_interval(days => ${d}::int)
    `);
    const row = rows(r)[0];
    if (!row) return blank;
    const n = Number(row.n) || 0;
    const people = Number(row.people) || 0;
    if (n < MIN_GROUP || people < MIN_GROUP) return blank;
    const round1 = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
    return {
      suppressed: false,
      windowDays: d,
      averageHours: round1(row.avg_hours),
      medianHours: round1(row.median_hours),
      answeredCount: n,
      note: '',
    };
  } catch (e: any) {
    console.error('[wellness] averageResponseHours:', errText(e));
    return blank;
  }
}

export interface TopicResult {
  suppressed: boolean;
  windowDays: number;
  topics: { topic: string; people: number }[];
  someCategoriesSuppressed: boolean;
  note: string;
}

/**
 * What people are asking about, by category, so the right kind of consultant can be arranged.
 *
 * Categories are counted in distinct people, not requests, and a category is only published once at
 * least MIN_GROUP different people have used it. Everything below that is dropped without a
 * residual "other" bucket, because an "other" bucket is just the suppressed categories added up.
 */
export async function topTopics(days = 90, limit = 8): Promise<TopicResult> {
  const d = windowDays(days);
  const blank: TopicResult = {
    suppressed: true,
    windowDays: d,
    topics: [],
    someCategoriesSuppressed: true,
    note: `Fewer than ${MIN_GROUP} people have asked anything in this period, so no breakdown is reported.`,
  };
  try {
    await ensureWellnessSchema();
    const totalR = await db.execute(sql`
      SELECT COUNT(DISTINCT user_id)::int AS people
      FROM wellness_consult_requests
      WHERE created_at >= NOW() - make_interval(days => ${d}::int)
    `);
    if ((Number(rows(totalR)[0]?.people) || 0) < MIN_GROUP) return blank;

    const r = await db.execute(sql`
      SELECT topic, COUNT(DISTINCT user_id)::int AS people
      FROM wellness_consult_requests
      WHERE topic IS NOT NULL AND topic <> ''
        AND created_at >= NOW() - make_interval(days => ${d}::int)
      GROUP BY topic
      ORDER BY people DESC, topic ASC
    `);
    const all = rows(r).map((x) => ({ topic: String(x.topic), people: Number(x.people) || 0 }));
    const kept = all.filter((t) => t.people >= MIN_GROUP).slice(0, Math.max(1, Math.min(20, Math.floor(limit))));
    const dropped = all.length - kept.length;
    return {
      suppressed: kept.length === 0,
      windowDays: d,
      topics: kept,
      someCategoriesSuppressed: dropped > 0,
      note: kept.length === 0
        ? `No single subject has been raised by ${MIN_GROUP} or more people, so nothing is broken down here.`
        : dropped > 0
          ? `Subjects raised by fewer than ${MIN_GROUP} people are not listed, and the remainder is not totalled, because a total would give them away.`
          : '',
    };
  } catch (e: any) {
    console.error('[wellness] topTopics:', errText(e));
    return blank;
  }
}

export interface ProgrammeHealth {
  windowDays: number;
  active: ActiveUsersResult;
  load: ConsultLoadResult;
  responseTimes: ResponseTimeResult;
  topics: TopicResult;
  disclaimer: string;
}

/** Everything an oversight screen is allowed to know, in one call. */
export async function programmeHealth(days = 90): Promise<ProgrammeHealth> {
  const d = windowDays(days);
  const [active, load, responseTimes, topics] = await Promise.all([
    activeUsers(d),
    consultLoad(d),
    averageResponseHours(d),
    topTopics(d),
  ]);
  return {
    windowDays: d,
    active,
    load,
    responseTimes,
    topics,
    disclaimer: `This page counts activity and nothing else. No individual log, symptom, request or reply is readable from here or from anywhere in the administrative system, and any group smaller than ${MIN_GROUP} people is reported as "${TOO_FEW_LABEL}" rather than as a number.`,
  };
}
