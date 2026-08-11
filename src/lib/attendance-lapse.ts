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
    await db.execute(sql`
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
      )`);
    // One OPEN pause per person. A second pause on top of an unresolved one would give somebody two
    // appeals for one situation and no clear thing to answer.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_profile_pauses_open_uniq
        ON hr_profile_pauses(employee_id) WHERE restored_at IS NULL`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS hr_profile_pauses_emp_idx
        ON hr_profile_pauses(employee_id, paused_at DESC)`);
  });
}

/**
 * Count consecutive working days, ending yesterday, with no record of presence.
 *
 * Walks BACKWARDS from yesterday and stops at the first accounted-for day, which is what makes it
 * "consecutive" rather than "nine days somewhere in the last year". Today is excluded because it is
 * still in progress and somebody may yet clock in.
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
  // would punish a person for an onboarding step nobody did.
  const ever = rowsOf(await db.execute(sql`
    SELECT 1 FROM hr_attendance
     WHERE employee_id = ${employeeId}::uuid AND status IN ('present', 'wfh')
     LIMIT 1`));
  if (ever.length === 0) {
    return { ...empty, skipped: 'has never been recorded present, so attendance is not being tracked for them' };
  }

  const emp = rowsOf(await db.execute(sql`
    SELECT date_of_joining, is_active, department_id
      FROM hr_employees WHERE id = ${employeeId}::uuid`))[0];
  if (!emp) return { ...empty, skipped: 'no employee record' };
  if (emp.is_active === false) return { ...empty, skipped: 'not an active employee' };

  // Days that ARE accounted for, and holidays, read once rather than per day.
  const accounted = new Set<string>(
    rowsOf(await db.execute(sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS d FROM hr_attendance
       WHERE employee_id = ${employeeId}::uuid
         AND status IN ('present', 'wfh', 'on_leave', 'holiday')
         AND date >= CURRENT_DATE - INTERVAL '120 days'`)).map((r: any) => String(r.d)));

  const holidays = new Set<string>(
    rowsOf(await db.execute(sql`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM hr_holidays
       WHERE holiday_date >= CURRENT_DATE - INTERVAL '120 days'
         AND (department_id IS NULL OR department_id::text = ${String(emp.department_id || '')})`))
      .map((r: any) => String(r.d)));

  const joined = emp.date_of_joining ? new Date(String(emp.date_of_joining)) : null;
  const dates: string[] = [];

  // Walk back from yesterday. 120 days is the read window; nobody needs a longer streak than that to
  // establish that we have lost track of somebody.
  for (let back = 1; back <= 120; back++) {
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
 * Is this person's profile paused right now?
 *
 * Never throws: a paused check that fails must not lock somebody out, so a failure answers false and
 * says why. Failing closed here would suspend the whole company on a bad query.
 */
export async function pauseFor(employeeId: string): Promise<{ paused: PauseRecord | null; error: string | null }> {
  if (!isUuid(employeeId)) return { paused: null, error: null };
  try {
    await ensureLapseSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT id, employee_id, paused_at, days, reason, appeal_id, restored_at, restored_by
        FROM hr_profile_pauses
       WHERE employee_id = ${employeeId}::uuid AND restored_at IS NULL
       LIMIT 1`));
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

    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_profile_pauses (employee_id, days, reason)
      SELECT ${opts.employeeId}::uuid, ${Math.round(opts.days)}, ${reason}
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_profile_pauses
          WHERE employee_id = ${opts.employeeId}::uuid AND restored_at IS NULL)
      RETURNING id`));

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
        await db.execute(sql`
          UPDATE hr_profile_pauses SET appeal_id = ${flagId}::uuid WHERE id = ${pauseId}::uuid`);
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
      const link = rowsOf(await db.execute(sql`
        SELECT user_id FROM hr_employees WHERE id = ${opts.employeeId}::uuid`))[0];
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
    const r = rowsOf(await db.execute(sql`
      UPDATE hr_profile_pauses
         SET restored_at = NOW(), restored_by = ${actorUserId}::uuid,
             restored_reason = ${String(reason || '').trim().slice(0, 1000)}
       WHERE id = ${pauseId}::uuid AND restored_at IS NULL
      RETURNING id`));
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
    const r = rowsOf(await db.execute(sql`
      SELECT to_char(date_trunc('week', CURRENT_DATE - INTERVAL '7 days'), 'YYYY-MM-DD') AS week_start,
             -- work_hours, not hours_worked. Checked against db/hr-schema.sql rather than assumed:
             -- the wrong name would not fail loudly here, it would throw inside the try and report
             -- every week as unreadable, which reads on screen as nobody ever being short.
             COALESCE(SUM(work_hours), 0)::float AS hours
        FROM hr_attendance
       WHERE employee_id = ${employeeId}::uuid
         AND date >= date_trunc('week', CURRENT_DATE - INTERVAL '7 days')
         AND date <  date_trunc('week', CURRENT_DATE)`))[0] || {};

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
    const already = rowsOf(await db.execute(sql`
      SELECT 1 FROM hr_employee_flags
       WHERE employee_id = ${s.employeeId}::uuid
         AND breach_type = 'hours_breach'
         AND description LIKE ${'%' + marker + '%'}
       LIMIT 1`));
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

/**
 * Assess everybody, and report. WRITES NOTHING.
 *
 * Separated from pausing on purpose: this is what an admin screen runs to see who the rule WOULD
 * pause, against real data, before anybody allows it to fire. A policy this consequential should be
 * previewable, and the preview is the same code path as the action so the two cannot disagree.
 */
export async function assessAll(
  threshold: number = DEFAULT_LAPSE_DAYS,
): Promise<{ rows: LapseAssessment[]; error: string | null }> {
  try {
    const ids = rowsOf(await db.execute(sql`
      SELECT id FROM hr_employees WHERE is_active = true ORDER BY full_name ASC`))
      .map((r: any) => String(r.id));
    const out: LapseAssessment[] = [];
    for (const id of ids) out.push(await assessEmployee(id, threshold));
    return { rows: out, error: null };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[lapse] assessAll failed:', why);
    return { rows: [], error: why };
  }
}
