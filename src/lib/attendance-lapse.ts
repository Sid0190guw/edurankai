// src/lib/attendance-lapse.ts — nine working days unaccounted for, and what happens then.
//
// THE RULE THE FOUNDER ASKED FOR: somebody absent for nine days has their profile paused and must
// appeal to have it restored.
//
// =================================================================================================
// THE DANGEROUS PART IS THE WORD "ABSENT", NOT THE COUNTING
// =================================================================================================
//
// Getting this wrong suspends a real person who did nothing wrong, and the wrong version is the one
// that is easier to write. So a day counts against somebody ONLY when all of these hold:
//
//   - it is a WORKING day for them: not a weekend, not a holiday on their calendar;
//   - it is on or after their joining date, and before today (today is still in progress);
//   - hr_attendance holds no record of presence for it — no row at all, or a row saying 'absent';
//   - they were not on approved leave, working from home, or otherwise accounted for.
//
// 'on_leave', 'wfh', 'present' and 'holiday' all mean the day is ACCOUNTED FOR. Somebody on approved
// medical leave for a fortnight must never be paused by this; that would be both wrong and, in most
// places this company hires, unlawful.
//
// =================================================================================================
// AND A MISSING ROW IS NOT PROOF OF ABSENCE
// =================================================================================================
//
// This is the failure that would hurt most people at once. If attendance is recorded patchily — and
// on a young company it always is — then "no row" means nobody wrote one, not that nobody came to
// work. A naive version of this rule would pause the entire company on the day it was switched on.
//
// Two guards, both deliberate:
//
//   1. IT ONLY APPLIES TO PEOPLE THE SYSTEM IS ACTUALLY TRACKING. Somebody who has never clocked in
//      at all is not nine days absent; they are somebody nobody has onboarded onto attendance.
//      requiresEverClockedIn() is the difference between a compliance tool and an accident.
//
//   2. IT IS OFF UNTIL SOMEBODY TURNS IT ON, and evaluating is separate from acting, so the pause
//      can be previewed against real data before it is ever allowed to fire.
//
// =================================================================================================
// WHAT A PAUSE IS, AND WHAT IT IS NOT
// =================================================================================================
//
// A pause is REVERSIBLE, NOTIFIED and APPEALABLE. It is not a termination, not a disciplinary
// finding, and not a statement that the person did anything wrong — it is the platform saying it has
// lost track of somebody and needs to hear from them.
//
// It deliberately does NOT set hr_employees.is_active = false. That column means "employed", and
// payroll, leave accrual, the org graph and half the product read it; flipping it would quietly stop
// somebody's pay on the strength of a missing attendance row. A pause is its own state.
//
// CLAUDE.md says automated detection is advisory and a human decides. The founder asked for an
// automatic pause, and both can hold: the SYSTEM pauses, because that is the ask, but a pause is a
// recoverable state with an appeal attached and it can never escalate to separation without a human.
// The one thing automation may not do here is end somebody's employment.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { ensureOnce } from '@/lib/ensure-once';
// EVERY WAIT IN THIS FILE IS BOUNDED, because nobody is on a screen when it runs. The nightly
// /api/cron/hr-sweep invocation is what calls assessAll(); postgres-js has no query timeout, so an
// unbounded await here does not fail, it HANGS — holding a pooler connection until the platform
// kills the invocation. withCronRun then leaves last_status = 'running' and cronHealth() only
// relabels it 'timeout' after two intervals, which for a daily cron is two days of /admin/ops
// saying the sweep is still going while nobody is being assessed at all.
import { withDbTimeout } from '@/lib/db-timeout';
// idEq/idIn put the cast on the PARAMETER instead of the column. `department_id::text = $1` is a
// sequential scan; `department_id = $1` is an index lookup. idIn also emits `IN (…)` rather than
// `= ANY(${array})`, which this driver renders as a row constructor and Postgres rejects.
import { idEq, idIn } from '@/lib/workforce/scale';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST. `const` is not hoisted, and a binding under its first reader has taken pages down.
// -------------------------------------------------------------------------------------------------

/** The founder's number. Configurable, because it is a policy and policies change. */
export const DEFAULT_LAPSE_DAYS = 9;

/**
 * Warn before you act. Somebody should hear from us at five days and seven days, so a pause is never
 * the first they know of it. A rule that arrives without warning reads as a trap.
 */
export const WARN_AT_DAYS: readonly number[] = Object.freeze([5, 7]);

/** hr_attendance.status values that mean the day IS accounted for. Absence is the absence of these. */
const ACCOUNTED_FOR: readonly string[] = Object.freeze(['present', 'wfh', 'on_leave', 'holiday']);

/**
 * How far back anything here reads, and how far back the day-walk counts.
 *
 * The SQL below writes the interval as a literal because a parameterised `CURRENT_DATE - $1` has to
 * resolve an ambiguous operator; this constant is the JS half and the two must be changed together.
 * Nobody needs a longer streak than this to establish that we have lost track of somebody.
 */
const WINDOW_DAYS = 120;

/**
 * How long any single statement in this module may wait before it is given up on.
 *
 * Shorter than DB_TIMEOUT_MS (8s) deliberately: the sweep issues several statements in sequence and
 * a serverless invocation has roughly ten seconds in total. A wait that outlives the invocation it
 * is inside cannot report anything, and a cron that reports nothing is the failure this bound
 * exists to convert into a recorded one.
 */
const LAPSE_DB_MS = 5000;

/**
 * How many employee ids go into one IN list.
 *
 * The sweep used to issue four statements PER PERSON, strictly serially — roughly 56 seconds at a
 * hundred tracked staff against a ten second ceiling, so it was killed mid-loop every night. It now
 * issues two statements per chunk, so a chunk of five hundred costs the same two round trips as a
 * chunk of one. Five hundred parameters is nowhere near Postgres's 65535 limit and keeps each
 * statement's plan small enough to stay an index scan.
 */
const IDS_PER_STATEMENT = 500;

/**
 * The most people one sweep will assess, and it SAYS SO when it stops short.
 *
 * A cron with no cap is a cron that grows into an invocation kill. Stopping by choice and reporting
 * the truncation is the only version of this that stays honest: `rows` then means "these are the
 * people we assessed", never "these are all the people there are".
 */
export const ASSESS_MAX_EMPLOYEES = 2000;

export type LapseState = 'clear' | 'warning' | 'lapsed';

export interface LapseAssessment {
  employeeId: string;
  /** Consecutive working days with no record of presence, most recent first. */
  days: number;
  state: LapseState;
  /** The dates counted, so a human can check the arithmetic rather than trust it. */
  dates: string[];
  /** Why this person was skipped entirely, when they were. */
  skipped: string | null;
  threshold: number;
}

export interface PauseRecord {
  id: string;
  employeeId: string;
  pausedAt: string;
  days: number;
  reason: string;
  appealId: string | null;
  restoredAt: string | null;
  restoredBy: string | null;
}

function isUuid(v: unknown): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/**
 * The pause state, kept OFF hr_employees.is_active for the reason in the header.
 *
 * New ensureOnce key: adding DDL to a spent key never runs, and the column silently never appears —
 * which on this project has produced a write path that threw forever while the page reported fine.
 */
export function ensureLapseSchema(): Promise<void> {
  return ensureOnce('hr_attendance_lapse_v1', async () => {
    // BOUNDED LIKE EVERY OTHER WAIT HERE. A CREATE INDEX that queues behind somebody else's lock is
    // the one statement in this file that can wait forever on a perfectly healthy database, and it
    // runs first — so an unbounded one consumes the whole invocation before a single person has
    // been assessed. ensureOnce drops a failed run from its cache, so the next call retries.
    await withDbTimeout(db.execute(sql`
      CREATE TABLE IF NOT EXISTS hr_profile_pauses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        days INTEGER NOT NULL,
        reason TEXT NOT NULL,
        appeal_id UUID,
        restored_at TIMESTAMPTZ,
        restored_by UUID,
        restored_reason TEXT
      )`), 'lapse.schema.table', LAPSE_DB_MS);
    // One OPEN pause per person. A second pause on top of an unresolved one would give somebody two
    // appeals for one situation and no clear thing to answer.
    await withDbTimeout(db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_profile_pauses_open_uniq
        ON hr_profile_pauses(employee_id) WHERE restored_at IS NULL`), 'lapse.schema.openUniq', LAPSE_DB_MS);
    await withDbTimeout(db.execute(sql`
      CREATE INDEX IF NOT EXISTS hr_profile_pauses_emp_idx
        ON hr_profile_pauses(employee_id, paused_at DESC)`), 'lapse.schema.empIdx', LAPSE_DB_MS);
  });
}

/**
 * THE RULE ITSELF, WITH NO DATABASE IN IT. Declared above both of its readers, per the house rule.
 *
 * Count consecutive working days, ending yesterday, with no record of presence. Walks BACKWARDS
 * from yesterday and stops at the first accounted-for day, which is what makes it "consecutive"
 * rather than "nine days somewhere in the last year". Today is excluded because it is still in
 * progress and somebody may yet clock in.
 *
 * assessEmployee() reads for one person; assessAll() reads for everybody at once in a handful of
 * statements. Both then walk the same days through THIS function, so the preview an admin runs and
 * the sweep that raises the flag cannot arrive at different answers about the same week — which
 * they could have, silently, while the counting lived inside the per-person read.
 */
function walkBack(
  employeeId: string,
  emp: { date_of_joining?: any },
  accounted: Set<string>,
  holidays: Set<string>,
  threshold: number,
): LapseAssessment {
  const joined = emp?.date_of_joining ? new Date(String(emp.date_of_joining)) : null;
  const dates: string[] = [];

  // Walk back from yesterday. WINDOW_DAYS is the read window; nobody needs a longer streak than that
  // to establish that we have lost track of somebody.
  for (let back = 1; back <= WINDOW_DAYS; back++) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - back);
    if (joined && d < joined) break;                    // before they started is not absence

    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;               // not a working day
    if (holidays.has(iso)) continue;                    // not a working day
    if (accounted.has(iso)) break;                      // the streak ends here

    dates.push(iso);
    if (dates.length >= threshold) break;               // no need to count further
  }

  const days = dates.length;
  const state: LapseState =
    days >= threshold ? 'lapsed'
      : days >= Math.min(...WARN_AT_DAYS) ? 'warning'
        : 'clear';

  return { employeeId, days, state, dates, skipped: null, threshold };
}

/**
 * Assess ONE person: read their facts, their accounted-for days and their holiday calendar, then
 * walk the days through walkBack() above.
 *
 * Every wait here is bounded. The nightly sweep does not use this function — assessAll() reads for
 * everybody in a handful of statements instead, because four round trips per person is what was
 * killing the invocation — but an admin screen asking about one person still comes through here.
 */
export async function assessEmployee(
  employeeId: string,
  threshold: number = DEFAULT_LAPSE_DAYS,
): Promise<LapseAssessment> {
  const empty: LapseAssessment = {
    employeeId, days: 0, state: 'clear', dates: [], skipped: null, threshold,
  };
  if (!isUuid(employeeId)) return { ...empty, skipped: 'not a valid employee reference' };

  // GUARD ONE: somebody who has never clocked in is not absent, they are untracked. Pausing them
  // would punish a person for an onboarding step nobody did. The EXISTS rides along on the employee
  // read rather than costing its own round trip, and the subquery stops at the first matching row.
  const emp = rowsOf(await withDbTimeout(db.execute(sql`
    SELECT e.date_of_joining, e.is_active, e.department_id::text AS department_id,
           EXISTS (
             SELECT 1 FROM hr_attendance a
              WHERE a.employee_id = e.id AND a.status IN ('present', 'wfh')
           ) AS ever_present
      FROM hr_employees e
     WHERE e.id = ${employeeId}::uuid`), 'hr-sweep.assessEmployee.employee', LAPSE_DB_MS))[0];
  if (!emp) return { ...empty, skipped: 'no employee record' };
  if (emp.is_active === false) return { ...empty, skipped: 'not an active employee' };
  if (emp.ever_present !== true) {
    return { ...empty, skipped: 'has never been recorded present, so attendance is not being tracked for them' };
  }

  // Days that ARE accounted for, and holidays, read once rather than per day.
  const accounted = new Set<string>(
    rowsOf(await withDbTimeout(db.execute(sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS d FROM hr_attendance
       WHERE employee_id = ${employeeId}::uuid
         AND status IN ('present', 'wfh', 'on_leave', 'holiday')
         AND date >= CURRENT_DATE - INTERVAL '120 days'`), 'hr-sweep.assessEmployee.attendance', LAPSE_DB_MS))
      .map((r: any) => String(r.d)));

  // THE CAST GOES ON THE PARAMETER, NEVER ON THE COLUMN. This read used
  // `department_id::text = ${...}`, which no index on hr_holidays can answer, and it passed the
  // empty string for a person with no department — a value that matches nothing but still made
  // Postgres scan the table to discover that. idEq() emits the plain comparison for a well-formed
  // id and `false` for a blank one, so the org-wide branch alone answers an employee with no
  // department.
  const holidays = new Set<string>(
    rowsOf(await withDbTimeout(db.execute(sql`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM hr_holidays
       WHERE holiday_date >= CURRENT_DATE - INTERVAL '120 days'
         AND (department_id IS NULL OR ${idEq(sql`department_id`, emp.department_id)})`),
      'hr-sweep.assessEmployee.holidays', LAPSE_DB_MS))
      .map((r: any) => String(r.d)));

  return walkBack(employeeId, emp, accounted, holidays, threshold);
}

/**
 * Is this person's profile paused right now?
 *
 * Never throws: a paused check that fails must not lock somebody out, so a failure answers false and
 * says why. Failing closed here would suspend the whole company on a bad query.
 */
export async function pauseFor(employeeId: string): Promise<{ paused: PauseRecord | null; error: string | null }> {
  if (!isUuid(employeeId)) return { paused: null, error: null };
  try {
    await ensureLapseSchema();
    const r = rowsOf(await withDbTimeout(db.execute(sql`
      SELECT id, employee_id, paused_at, days, reason, appeal_id, restored_at, restored_by
        FROM hr_profile_pauses
       WHERE employee_id = ${employeeId}::uuid AND restored_at IS NULL
       LIMIT 1`), 'lapse.pauseFor', LAPSE_DB_MS));
    if (!r.length) return { paused: null, error: null };
    const x = r[0];
    return {
      paused: {
        id: String(x.id),
        employeeId: String(x.employee_id),
        pausedAt: String(x.paused_at),
        days: Number(x.days || 0),
        reason: String(x.reason || ''),
        appealId: x.appeal_id ? String(x.appeal_id) : null,
        restoredAt: null,
        restoredBy: null,
      },
      error: null,
    };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] pauseFor failed:', why);
    return { paused: null, error: why };
  }
}

/**
 * Pause a profile, and raise the flag that carries the appeal.
 *
 * The flag is raised through the EXISTING hr-flags system rather than a second one, so the appeal a
 * paused person files is the same appeal HR already knows how to answer, on the same screen, with
 * the same four outcomes.
 */
export async function pauseProfile(opts: {
  employeeId: string;
  days: number;
  actorUserId?: string | null;
  actorName?: string | null;
}): Promise<{ ok: boolean; pauseId?: string; flagId?: string; error?: string }> {
  if (!isUuid(opts?.employeeId)) return { ok: false, error: 'That employee could not be identified.' };
  try {
    await ensureLapseSchema();

    const reason = opts.days + ' consecutive working days with no record of attendance, and no '
      + 'approved leave covering them. This pause is not a finding that anything was done wrong: it '
      + 'means we have lost track of somebody and need to hear from them.';

    // withDbTimeout and NOT withDbRetry. The NOT EXISTS makes this idempotent in the ordinary case,
    // but a retry after a TIMEOUT is a retry against a statement that may well have committed —
    // and the thing at stake is somebody's access being suspended twice. One bounded attempt.
    const ins = rowsOf(await withDbTimeout(db.execute(sql`
      INSERT INTO hr_profile_pauses (employee_id, days, reason)
      SELECT ${opts.employeeId}::uuid, ${Math.round(opts.days)}, ${reason}
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_profile_pauses
          WHERE employee_id = ${opts.employeeId}::uuid AND restored_at IS NULL)
      RETURNING id`), 'lapse.pauseProfile.insert', LAPSE_DB_MS));

    // Zero rows means they are already paused, which is not a failure.
    if (!ins.length) return { ok: true, error: undefined };
    const pauseId = String(ins[0].id);

    // The flag carries the appeal. hours_breach is the level-1 breach this belongs to: a warning and
    // a conversation, not a level-2 investigation. An unexplained gap is not misconduct.
    let flagId: string | undefined;
    try {
      const { raiseFlag } = await import('@/lib/hr-flags');
      const f = await raiseFlag({
        employeeId: opts.employeeId,
        breachType: 'hours_breach',
        description: reason,
        actionTaken: 'Profile paused pending an explanation. Restored on appeal.',
        flaggedByUserId: opts.actorUserId || undefined,
        flaggedByName: opts.actorName || 'Attendance monitor',
      });
      if (f.ok && f.flagId) {
        flagId = f.flagId;
        await withDbTimeout(db.execute(sql`
          UPDATE hr_profile_pauses SET appeal_id = ${flagId}::uuid WHERE id = ${pauseId}::uuid`),
          'lapse.pauseProfile.attachAppeal', LAPSE_DB_MS);
      }
    } catch (e: any) {
      // NOT swallowed. A pause whose appeal route was never created traps somebody with no way out,
      // which is far worse than no pause at all — so the caller is told.
      const why = e?.cause?.message || e?.message || 'unknown error';
      console.error('[lapse] pause created but flag failed:', why);
      return {
        ok: true, pauseId,
        error: 'The profile was paused but the appeal record could not be created (' + why
          + '). Restore it by hand until that is fixed, so nobody is left without a route to appeal.',
      };
    }

    // Tell them. A pause somebody discovers by being locked out is a pause nobody can answer.
    // notify.ts speaks in USER ids, and this module speaks in employee ids, so the sign-in account
    // is resolved here rather than assumed — an hr_employees row can exist with no account attached,
    // and in that case there is genuinely nobody to notify, which is worth logging rather than
    // pretending the person was told.
    try {
      const link = rowsOf(await withDbTimeout(db.execute(sql`
        SELECT user_id FROM hr_employees WHERE id = ${opts.employeeId}::uuid`),
        'lapse.pauseProfile.account', LAPSE_DB_MS))[0];
      const userId = link?.user_id ? String(link.user_id) : '';
      if (!userId) {
        console.error('[lapse] paused an employee with no sign-in account; they cannot be told or appeal:', opts.employeeId);
      } else {
        const { notifyUser } = await import('@/lib/notify');
        await notifyUser(userId, {
          title: 'Your profile has been paused',
          body: reason + ' Open your profile to explain what happened; it is restored as soon as '
            + 'somebody has read it.',
          type: 'system',
          actionUrl: '/portal/employee',
          entityType: 'profile_pause',
          entityId: pauseId,
        });
      }
    } catch (e: any) {
      console.error('[lapse] pause notice failed:', e?.cause?.message || e?.message);
    }

    return { ok: true, pauseId, flagId };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] pauseProfile failed:', why);
    return { ok: false, error: why };
  }
}

/** Lift a pause. Always available to a human, and it records who and why. */
export async function restoreProfile(
  pauseId: string,
  actorUserId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(pauseId)) return { ok: false, error: 'Unknown pause.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'You must be signed in to restore a profile.' };
  try {
    await ensureLapseSchema();
    const r = rowsOf(await withDbTimeout(db.execute(sql`
      UPDATE hr_profile_pauses
         SET restored_at = NOW(), restored_by = ${actorUserId}::uuid,
             restored_reason = ${String(reason || '').trim().slice(0, 1000)}
       WHERE id = ${pauseId}::uuid AND restored_at IS NULL
      RETURNING id`), 'lapse.restoreProfile', LAPSE_DB_MS));
    if (!r.length) return { ok: false, error: 'That pause was already lifted.' };
    return { ok: true };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] restoreProfile failed:', why);
    return { ok: false, error: why };
  }
}

// =================================================================================================
// THE OTHER SIGNAL: A WEEK THAT CAME UP SHORT
// =================================================================================================
//
// Absence is somebody who did not appear. This is somebody who appeared and did not reach the hours
// their engagement expects — a different fact needing a different response, and a much gentler one.
//
// IT IS A WARNING, NEVER A PAUSE. A short week has a hundred honest explanations: a public holiday
// the calendar does not know about, a half-day nobody filed, a machine that would not clock out, a
// week somebody genuinely had less to do. Pausing a profile over it would be absurd. So this raises
// a level-one flag — a conversation — and nothing else.
//
// THE HOURS COME FROM THE ENGAGEMENT, not from one number. src/lib/engagement-policy.ts already
// holds totalMinutesPerWeek per level, so an intern is measured against an intern's week and a
// director against a director's. A single company-wide target would flag every part-timer forever.

/** Below this fraction of the expected week, a warning is worth raising. */
export const SHORTFALL_FRACTION = 0.6;

export interface WeekShortfall {
  employeeId: string;
  weekStart: string;
  expectedHours: number | null;
  actualHours: number;
  /** null when the engagement sets no weekly expectation — which is not a shortfall, it is silence. */
  fraction: number | null;
  short: boolean;
  skipped: string | null;
}

/**
 * Did this person's most recently COMPLETED week fall short?
 *
 * The completed week, never the current one: judging somebody on Tuesday for a week that has three
 * days left in it is the most obviously unfair version of this rule.
 */
export async function assessWeek(
  employeeId: string,
  level: string | null,
): Promise<WeekShortfall> {
  const empty: WeekShortfall = {
    employeeId, weekStart: '', expectedHours: null, actualHours: 0,
    fraction: null, short: false, skipped: null,
  };
  if (!isUuid(employeeId)) return { ...empty, skipped: 'not a valid employee reference' };

  let expected: number | null = null;
  try {
    const { ENGAGEMENT_POLICIES, hoursPerWeek } = await import('@/lib/engagement-policy');
    const policy = (ENGAGEMENT_POLICIES as any)[String(level || '')];
    if (policy) expected = hoursPerWeek(policy);
  } catch (e: any) {
    console.error('[lapse] engagement policy unreadable:', e?.cause?.message || e?.message);
    return { ...empty, skipped: 'the engagement policy could not be read' };
  }

  // No expectation is not a shortfall. A level with no weekly hours recorded means nobody has said
  // what a week looks like for them, and inventing a number to measure them against would be worse
  // than saying nothing.
  if (expected === null || expected <= 0) {
    return { ...empty, skipped: 'no weekly hours are set for this engagement level' };
  }

  try {
    const r = rowsOf(await withDbTimeout(db.execute(sql`
      SELECT to_char(date_trunc('week', CURRENT_DATE - INTERVAL '7 days'), 'YYYY-MM-DD') AS week_start,
             -- work_hours, not hours_worked. Checked against db/hr-schema.sql rather than assumed:
             -- the wrong name would not fail loudly here, it would throw inside the try and report
             -- every week as unreadable, which reads on screen as nobody ever being short.
             COALESCE(SUM(work_hours), 0)::float AS hours
        FROM hr_attendance
       WHERE employee_id = ${employeeId}::uuid
         AND date >= date_trunc('week', CURRENT_DATE - INTERVAL '7 days')
         AND date <  date_trunc('week', CURRENT_DATE)`), 'hr-sweep.assessWeek', LAPSE_DB_MS))[0] || {};

    const actual = Number(r.hours || 0);
    const fraction = actual / expected;
    return {
      employeeId,
      weekStart: String(r.week_start || ''),
      expectedHours: expected,
      actualHours: Math.round(actual * 10) / 10,
      fraction: Math.round(fraction * 100) / 100,
      short: fraction < SHORTFALL_FRACTION,
      skipped: null,
    };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] assessWeek failed:', why);
    // A read that failed is NOT a short week. Reporting it as one would flag somebody for a database
    // hiccup, and the flag goes on their record.
    return { ...empty, expectedHours: expected, skipped: why };
  }
}

/**
 * Raise the warning. Level one, on the existing flag system, and idempotent per week so a nightly
 * job cannot paper somebody's record with the same warning seven times.
 */
export async function warnShortWeek(
  s: WeekShortfall,
  actorName = 'Attendance monitor',
): Promise<{ ok: boolean; flagId?: string; error?: string }> {
  if (!s.short || s.skipped) return { ok: true };
  try {
    await ensureLapseSchema();
    const marker = 'week of ' + s.weekStart;
    // THIS DEDUPE CANNOT USE AN INDEX AND IT IS KNOWN. A leading-wildcard LIKE on `description` is a
    // sequential scan of hr_employee_flags, and the same shape is written a second time in
    // src/lib/hr/scheduled.ts. It is bounded here so a slow scan cannot eat the sweep's invocation,
    // but the real repair is a schema change this process is not allowed to make:
    //
    //   ALTER TABLE hr_employee_flags ADD COLUMN IF NOT EXISTS dedup_key TEXT;
    //   CREATE INDEX IF NOT EXISTS hr_employee_flags_dedup_idx
    //     ON hr_employee_flags (employee_id, breach_type, dedup_key);
    //
    // That belongs in a db/*.sql file the user applies by hand — never as request-time DDL — and
    // once the column exists this probe becomes an equality match on dedup_key. Until then the LIKE
    // stays, because a dedupe that silently stops matching would paper somebody's record with the
    // same warning every night.
    const already = rowsOf(await withDbTimeout(db.execute(sql`
      SELECT 1 FROM hr_employee_flags
       WHERE employee_id = ${s.employeeId}::uuid
         AND breach_type = 'hours_breach'
         AND description LIKE ${'%' + marker + '%'}
       LIMIT 1`), 'hr-sweep.warnShortWeek.dedupe', LAPSE_DB_MS));
    if (already.length) return { ok: true };

    const { raiseFlag } = await import('@/lib/hr-flags');
    const f = await raiseFlag({
      employeeId: s.employeeId,
      breachType: 'hours_breach',
      description: 'Recorded ' + s.actualHours + ' hours in the ' + marker + ', against '
        + s.expectedHours + ' expected for this engagement. This is a warning and a prompt for a '
        + 'conversation, not a finding: a short week is as often a holiday nobody recorded, a '
        + 'half-day nobody filed, or a clock-out that did not save.',
      actionTaken: 'Warning raised. Speak to them before it is treated as a pattern.',
      flaggedByName: actorName,
    });
    return f.ok ? { ok: true, flagId: f.flagId } : { ok: false, error: f.error };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] warnShortWeek failed:', why);
    return { ok: false, error: why };
  }
}

export interface AssessAllResult {
  rows: LapseAssessment[];
  /** Non-null when the assessment could not run. `rows` is then EMPTY AND MEANS NOTHING. */
  error: string | null;
  /**
   * True when there are more active employees than one run assesses. `rows` is then the people this
   * run looked at, NEVER everybody — an empty `rows` beside `truncated: false` is the only shape
   * that means "nobody is at a boundary".
   */
  truncated: boolean;
  /** Set only when truncated: how many were assessed, out of how many there are. */
  note: string | null;
}

/**
 * Assess everybody, and report. WRITES NOTHING.
 *
 * Separated from pausing on purpose: this is what an admin screen runs to see who the rule WOULD
 * pause, against real data, before anybody allows it to fire. A policy this consequential should be
 * previewable, and the preview is the same code path as the action so the two cannot disagree.
 *
 * =================================================================================================
 * WHY THIS IS SET-BASED NOW, AND WHAT IT REPLACED
 * =================================================================================================
 *
 * This used to be `for (const id of ids) out.push(await assessEmployee(id, threshold));` — strictly
 * serial, four round trips per tracked person, with no LIMIT on the id list. At the measured ~140ms
 * warm round trip from bom1 that is roughly 56 seconds at a hundred tracked staff, against a ten
 * second serverless ceiling. The nightly sweep was therefore KILLED MID-LOOP every night: it held a
 * pooler connection for the whole invocation, /api/cron/hr-sweep's withCronRun left the row at
 * 'running', and cronHealth() only relabels that 'timeout' after two intervals — two days, for a
 * daily cron. Nobody was flagged for attendance lapse in the meantime and /admin/ops said the sweep
 * was still going.
 *
 * It now issues ONE id list, ONE holiday read, and TWO statements per chunk of IDS_PER_STATEMENT.
 * Two thousand people cost ten round trips instead of eight thousand.
 *
 * THE HOLIDAY CALENDAR IS READ ONCE FOR EVERYBODY and bucketed by department in JS. Reading it per
 * employee was the most wasteful of the four statements — the answer differs between two people
 * only by their department, and a hundred and twenty days of holidays is a few dozen rows in total.
 */
export async function assessAll(
  threshold: number = DEFAULT_LAPSE_DAYS,
): Promise<AssessAllResult> {
  try {
    // One more than the ceiling, so the presence of the extra row is what proves there are more
    // people than this run will look at. Counting separately would cost another round trip and
    // could disagree with the list it is counting.
    const idRows = rowsOf(await withDbTimeout(db.execute(sql`
      SELECT id::text AS id FROM hr_employees
       WHERE is_active = true
       ORDER BY full_name ASC
       LIMIT ${ASSESS_MAX_EMPLOYEES + 1}`), 'hr-sweep.assessAll.ids', LAPSE_DB_MS));

    const truncated = idRows.length > ASSESS_MAX_EMPLOYEES;
    const ids: string[] = idRows.slice(0, ASSESS_MAX_EMPLOYEES).map((r: any) => String(r.id));
    const note = truncated
      ? 'Assessed the first ' + ids.length + ' active employees by name; there are more than that, '
        + 'so this run is a partial sweep and the rest were not looked at.'
      : null;
    if (truncated) console.error('[lapse] assessAll stopped short:', note);

    if (!ids.length) return { rows: [], error: null, truncated, note };

    // THE HOLIDAY CALENDAR, ONCE, FOR EVERY DEPARTMENT AT ONCE. department_id is TEXT on hr_holidays
    // (src/lib/attendance-schema.ts) and NULL means org-wide, which applies to everybody.
    const orgWideHolidays = new Set<string>();
    const holidaysByDept = new Map<string, Set<string>>();
    for (const h of rowsOf(await withDbTimeout(db.execute(sql`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d, department_id::text AS department_id
        FROM hr_holidays
       WHERE holiday_date >= CURRENT_DATE - INTERVAL '120 days'`),
      'hr-sweep.assessAll.holidays', LAPSE_DB_MS))) {
      const d = String((h as any).d);
      const dept = (h as any).department_id ? String((h as any).department_id) : '';
      if (!dept) { orgWideHolidays.add(d); continue; }
      let set = holidaysByDept.get(dept);
      if (!set) { set = new Set<string>(); holidaysByDept.set(dept, set); }
      set.add(d);
    }
    // Built once per department rather than once per person: two thousand people in twelve
    // departments is twelve unions, not two thousand.
    const holidayCache = new Map<string, Set<string>>();
    const holidaysFor = (dept: string): Set<string> => {
      if (!dept) return orgWideHolidays;
      const hit = holidayCache.get(dept);
      if (hit) return hit;
      const own = holidaysByDept.get(dept);
      const merged = own ? new Set<string>([...orgWideHolidays, ...own]) : orgWideHolidays;
      holidayCache.set(dept, merged);
      return merged;
    };

    const byId = new Map<string, LapseAssessment>();

    for (let i = 0; i < ids.length; i += IDS_PER_STATEMENT) {
      const chunk = ids.slice(i, i + IDS_PER_STATEMENT);

      // The employee facts AND the never-clocked-in guard in one statement. The EXISTS is a
      // per-row index probe that stops at the first matching attendance row, so it costs far less
      // than the separate LIMIT 1 read it replaces and it keeps the guard's meaning exactly:
      // presence at ANY time, not presence inside the read window. Narrowing it to the window
      // would quietly stop flagging the very people this rule is for — somebody who last appeared
      // five months ago would read as "never tracked" instead of "long gone".
      const emps = rowsOf(await withDbTimeout(db.execute(sql`
        SELECT e.id::text AS id, e.date_of_joining, e.is_active,
               e.department_id::text AS department_id,
               EXISTS (
                 SELECT 1 FROM hr_attendance a
                  WHERE a.employee_id = e.id AND a.status IN ('present', 'wfh')
               ) AS ever_present
          FROM hr_employees e
         WHERE ${idIn(sql`e.id`, chunk)}`), 'hr-sweep.assessAll.employees', LAPSE_DB_MS));

      // Every accounted-for day for this whole chunk, in one read, grouped in JS.
      const accountedBy = new Map<string, Set<string>>();
      for (const a of rowsOf(await withDbTimeout(db.execute(sql`
        SELECT employee_id::text AS employee_id, to_char(date, 'YYYY-MM-DD') AS d, status
          FROM hr_attendance
         WHERE date >= CURRENT_DATE - INTERVAL '120 days'
           AND status IN ('present', 'wfh', 'on_leave', 'holiday')
           AND ${idIn(sql`employee_id`, chunk)}`), 'hr-sweep.assessAll.attendance', LAPSE_DB_MS))) {
        // The status list is stated in the SQL and in ACCOUNTED_FOR, and this is what keeps the two
        // from drifting apart: a status the constant does not know about must not silently end
        // somebody's streak.
        if (!ACCOUNTED_FOR.includes(String((a as any).status))) continue;
        const empId = String((a as any).employee_id);
        let set = accountedBy.get(empId);
        if (!set) { set = new Set<string>(); accountedBy.set(empId, set); }
        set.add(String((a as any).d));
      }

      for (const emp of emps) {
        const id = String((emp as any).id);
        const empty: LapseAssessment = { employeeId: id, days: 0, state: 'clear', dates: [], skipped: null, threshold };
        if ((emp as any).is_active === false) { byId.set(id, { ...empty, skipped: 'not an active employee' }); continue; }
        if ((emp as any).ever_present !== true) {
          byId.set(id, { ...empty, skipped: 'has never been recorded present, so attendance is not being tracked for them' });
          continue;
        }
        const dept = (emp as any).department_id ? String((emp as any).department_id) : '';
        byId.set(id, walkBack(id, emp as any, accountedBy.get(id) || new Set<string>(), holidaysFor(dept), threshold));
      }
    }

    // In the id list's order — full_name ASC — so the report reads the same way it always did. An id
    // whose employee row did not come back (deleted between the two statements) is reported as
    // skipped rather than dropped: a person who vanishes from the report is indistinguishable from
    // a person the rule found nothing wrong with.
    const out: LapseAssessment[] = ids.map((id) =>
      byId.get(id) || { employeeId: id, days: 0, state: 'clear', dates: [], skipped: 'no employee record', threshold });

    return { rows: out, error: null, truncated, note };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] assessAll failed:', why);
    return { rows: [], error: why, truncated: false, note: null };
  }
}
