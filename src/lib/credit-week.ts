// src/lib/credit-week.ts — ONE CREDIT IS ONE COMPLETED WEEK. The rule, with no database in it.
//
// =================================================================================================
// THE UNIT THE FOUNDER CORRECTED, AND WHY IT IS NOT THE ONE IN credit-hours.ts
// =================================================================================================
//
// credit-hours.ts counts HOURS. That is still true and still needed — a completion letter states a
// number of hours. But a credit is not an hour. A CREDIT IS A COMPLETED WEEK, and for an intern a
// week is 40 hours. A credit is earned when BOTH of these are true of that week:
//
//   (a) THE HOURS ARE ACTUALLY THERE. Forty, measured from real clock-in and clock-out, net of
//       breaks. Not an agreed figure, not a day somebody ticked in a grid.
//   (b) THE WEEK IS COMPLETE. The daily reports were filed and the assigned work was done.
//
// WHEN BOTH ARE TRUE THE CREDIT IS APPROVED AUTOMATICALLY. Nobody clicks anything and the record
// says it was granted automatically and on what evidence.
//
// WHEN EITHER IS NOT TRUE THE CREDIT IS PENDING. Never silently granted, and never silently
// refused: the difference between those two is the entire content of this module. A pending credit
// waits for a person — the reporting manager the org graph names, HR, or a senior authority above
// them — who approves it WITH A REASON, because somebody is being credited for a week the
// measurement did not fully support.
//
// =================================================================================================
// WHAT COUNTS AS A MEASUREMENT, AND WHAT DOES NOT
// =================================================================================================
//
// A DAY WITH NO CLOCK-OUT IS INCOMPLETE. It is not eight hours and it is not zero. It is named, it
// contributes nothing, and it BLOCKS automatic approval — that block is not a punishment, it is the
// reason the human override exists. Somebody who genuinely worked that day gets their credit from a
// person who says so in writing, which is a better record than a guess.
//
// APPROVED LEAVE AND HOLIDAYS REDUCE THE REQUIREMENT rather than counting as a shortfall. Counting
// granted leave against somebody is how a figure stops being believed, and once it stops being
// believed the whole ledger is worthless.
//
// =================================================================================================
// WHY THIS FILE HAS NO DATABASE IN IT
// =================================================================================================
//
// These decisions are printed next to somebody's name and shown to an accredited partner. The rule
// therefore has to be readable and testable without a connection — the same reason credit-hours.ts
// is pure. src/lib/credit-week-ledger.ts does the reading, the writing and the routing; this file
// decides. Nothing here performs I/O, so nothing here can silently answer "no evidence" because a
// pooler blinked.
//
// EduRankAI is the technology platform. A credit here is a RECORD OF WORK DONE ON THIS PLATFORM. It
// is never a claim to confer a qualification — accredited partners award credentials, and this
// module produces evidence they can read, not an award.

import {
  ENGAGEMENT_POLICIES, resolveEngagementPolicy, isInternshipPolicy, hoursPerWeek,
  type EngagementPolicy,
} from './engagement-policy';

/* ------------------------------------------------------------------------------ the week itself */

/**
 * WEEKS ARE ISO WEEKS: Monday to Sunday. Stated once, here, because a week that means Monday on one
 * screen and Sunday on another produces two different credit totals for one person and no way to
 * tell which is right.
 */
export const WEEK_START_DAY = 1; // ISO Monday

const DAY_MS = 86400000;

/** yyyy-mm-dd for a Date, in UTC. Every date in this module is a calendar date, never an instant. */
export function isoDate(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

/** Parse yyyy-mm-dd to a UTC midnight Date. Returns null on anything that is not a calendar date. */
export function parseIso(s: string | null | undefined): Date | null {
  const t = String(s || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(t + 'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) ? d : null;
}

/** The Monday of the ISO week containing this date. '' when the date cannot be read. */
export function weekStartOf(dateIso: string): string {
  const d = parseIso(dateIso);
  if (!d) return '';
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();   // 1..7, Monday..Sunday
  return isoDate(new Date(d.getTime() - (dow - WEEK_START_DAY) * DAY_MS));
}

/** The Sunday closing the ISO week that starts on this Monday. */
export function weekEndOf(weekStartIso: string): string {
  const d = parseIso(weekStartIso);
  return d ? isoDate(new Date(d.getTime() + 6 * DAY_MS)) : '';
}

/** Every ISO week start from `fromIso` to `toIso` inclusive of the weeks those dates fall in. */
export function weekStartsBetween(fromIso: string, toIso: string, cap = 260): string[] {
  const a = parseIso(weekStartOf(fromIso));
  const b = parseIso(weekStartOf(toIso));
  if (!a || !b || b.getTime() < a.getTime()) return [];
  const out: string[] = [];
  for (let t = a.getTime(); t <= b.getTime() && out.length < cap; t += 7 * DAY_MS) {
    out.push(isoDate(new Date(t)));
  }
  return out;
}

/** Human label for a week, with no arrow characters — those break .astro JSX strings. */
export function weekLabel(weekStartIso: string): string {
  const end = weekEndOf(weekStartIso);
  return end ? weekStartIso + ' to ' + end : weekStartIso;
}

/* --------------------------------------------------------------------------------- the states */

/**
 * WHAT A WEEKLY CREDIT RECORD CAN SAY. Four values, and the gap between the first two is the whole
 * correction:
 *
 *   'earned-automatically'  both tests passed on real data. Nobody clicked anything. The record
 *                           carries the evidence it was granted on.
 *   'pending'               one or both tests did not pass, OR the week could not be measured.
 *                           WAITING ON A PERSON. Not granted and not refused.
 *   'approved'             a person credited the week despite the measurement, WITH A REASON.
 *   'refused'              a person declined to credit it, WITH A REASON.
 */
export const CREDIT_WEEK_STATES = ['earned-automatically', 'pending', 'approved', 'refused'] as const;
export type CreditWeekState = (typeof CREDIT_WEEK_STATES)[number];

const STATE_SET = new Set<string>(CREDIT_WEEK_STATES);
export function isCreditWeekState(v: unknown): v is CreditWeekState {
  return typeof v === 'string' && STATE_SET.has(v);
}

/** Plain words for a screen. No emoji anywhere in this codebase. */
export const CREDIT_WEEK_STATE_LABELS: Record<CreditWeekState, string> = {
  'earned-automatically': 'Earned automatically',
  pending: 'Waiting for a decision',
  approved: 'Approved by a person',
  refused: 'Refused',
};

/** The two states that mean a credit exists. Everything else has not been credited. */
export const CREDITED_STATES: CreditWeekState[] = ['earned-automatically', 'approved'];

export function isCredited(state: string): boolean {
  return CREDITED_STATES.includes(state as CreditWeekState);
}

/** A decided record is FROZEN — see the note on idempotency in credit-week-ledger.ts. */
export function isDecided(state: string): boolean {
  return state === 'earned-automatically' || state === 'approved' || state === 'refused';
}

/* ---------------------------------------------------------------------------- required hours */

/**
 * HOW MANY HOURS THIS PERSON'S WEEK REQUIRES, and whether they are on the credit model at all.
 *
 * ORDER MATTERS, and each rung is narrower than the one below it:
 *
 *   1. A RECORDED CONTRACT WINS. hr_employees.weekly_hours, when somebody actually entered one.
 *      A part-time intern at 20 hours is measured against 20, never against 40.
 *   2. OTHERWISE THE PUBLISHED POLICY, from src/lib/engagement-policy.ts, per engagement type. An
 *      intern is 40 because the internship policy says 40 — six days of 5 hours' project work plus
 *      1 hour 40 minutes of well-being. That number is not repeated here; it is read from there, so
 *      the two cannot drift.
 *   3. OTHERWISE UNKNOWN. Not 40. The week is measurable in hours but there is nothing to measure
 *      it against, so every week comes out pending and says so.
 *
 * AND A FULL-TIME EMPLOYEE IS NOT ON THIS MODEL AT ALL. Only engagements whose time model is
 * 'counted' — Intern and Apprentice — have hours as the certified deliverable. A salaried engineer
 * has a scheduled week for statutory compliance, not a credit-bearing one, and running them through
 * a credit ledger would be a category error that shows up as "your credits" on their portal.
 */
export interface RequiredHoursInput {
  /** hr_employees.employment_type, e.g. 'Intern'. */
  employmentType?: string | null;
  /** hr_employees.designation — the field a human actually filled in on purpose. */
  designation?: string | null;
  /** hr_employees.weekly_hours, when one was recorded. Null/undefined means none was. */
  recordedWeeklyHours?: number | null;
}

export interface RequiredHours {
  /** True only when this engagement is credit-bearing at all. */
  applicable: boolean;
  /** Hours the week requires, or null when unknown. Never a default. */
  hours: number | null;
  /** Working days the policy expects in a week, for the per-day figure leave is excused at. */
  daysPerWeek: number | null;
  /** Where the figure came from, verbatim, for the evidence record. */
  basis: string;
  policy: EngagementPolicy;
}

export function requiredWeeklyHours(input: RequiredHoursInput): RequiredHours {
  const policy = resolveEngagementPolicy({
    employmentType: input.employmentType || null,
    roleTitle: input.designation || null,
  });

  if (!isInternshipPolicy(policy)) {
    return {
      applicable: false,
      hours: null,
      daysPerWeek: policy.daysPerWeek,
      basis: 'This engagement is on the ' + policy.label + ' model, where hours are not the certified '
        + 'deliverable. Weekly credits are not measured for it.',
      policy,
    };
  }

  const recorded = Number(input.recordedWeeklyHours);
  if (Number.isFinite(recorded) && recorded > 0) {
    return {
      applicable: true,
      hours: recorded,
      daysPerWeek: policy.daysPerWeek,
      basis: 'Recorded weekly hours on the employee record: ' + recorded + ' hours a week.',
      policy,
    };
  }

  const fromPolicy = hoursPerWeek(policy);
  if (fromPolicy && fromPolicy > 0) {
    return {
      applicable: true,
      hours: fromPolicy,
      daysPerWeek: policy.daysPerWeek,
      basis: 'Published ' + policy.label + ' policy: ' + fromPolicy + ' hours a week over '
        + (policy.daysPerWeek || 0) + ' days.',
      policy,
    };
  }

  return {
    applicable: true,
    hours: null,
    daysPerWeek: policy.daysPerWeek,
    basis: 'No weekly hours are recorded for this engagement and the policy states none. '
      + 'Nothing can be measured against an unknown week.',
    policy,
  };
}

/** The intern week, quoted from the policy rather than restated. Used by copy and by tests. */
export const INTERN_WEEKLY_HOURS: number = hoursPerWeek(ENGAGEMENT_POLICIES.Intern) || 0;

/* ----------------------------------------------------------------------- the measurement input */

/** One day of the week, already mapped out of storage. Pure input — no rows, no nulls-from-SQL. */
export interface WeekDay {
  date: string;
  /** Hours measured from a real clock-in and clock-out, net of breaks. Null when there is no pair. */
  clockHours: number | null;
  /** An hours figure entered against the day by a person. Null when none. */
  recordedHours: number | null;
  /** Clocked in and never clocked out. The hours are UNKNOWN. */
  incomplete: boolean;
  /** The person was at work in some form on this day (present or working from home). */
  worked: boolean;
  /** A holiday, from the holiday list or from the day row itself. */
  holiday: boolean;
  /** Fraction of the day covered by APPROVED leave. 1 for a full day, 0.5 for a half. */
  approvedLeaveUnits: number;
  /** A daily report exists for this date. */
  reportFiled: boolean;
}

export interface WeekTasks {
  /** Tasks assigned to this person that fell due inside the week, cancellations excluded. */
  assigned: number;
  /** How many of those are complete. */
  completed: number;
  /** Titles of the ones that are not, so a pending week can say WHICH work is outstanding. */
  outstanding: string[];
}

export interface WeekMeasurementInput {
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  required: RequiredHours;
  days: WeekDay[];
  tasks: WeekTasks;
  /** False while the week is still running. A week in progress is never decided either way. */
  weekComplete: boolean;
}

/* --------------------------------------------------------------------------------- the verdict */

/**
 * THE EVIDENCE A DECISION RESTS ON, stored WITH the decision.
 *
 * A credit granted six months ago must still be able to say what it was granted on. That is the
 * whole difference between a ledger and a number: /admin/hr/completion/[id] prints a credit-hours
 * figure today with nothing behind it, and nobody looking at it later — not the person, not HR, not
 * the partner institution — can reconstruct where it came from. This object is serialised into the
 * record at the moment of decision and is never recomputed for a decided week.
 */
export interface CreditWeekEvidence {
  weekStart: string;
  weekEnd: string;
  hoursMeasured: number;
  hoursFromClock: number;
  hoursFromRecorded: number;
  hoursRequired: number | null;
  hoursRequiredBeforeLeave: number | null;
  hoursBasis: string;
  excusedDays: number;
  excusedHours: number;
  reportsFiled: number;
  reportsExpected: number;
  tasksCompleted: number;
  tasksAssigned: number;
  tasksOutstanding: string[];
  incompleteDates: string[];
  daysWorked: number;
  holidays: number;
  /** The sentences behind the verdict, in the order a person would read them. */
  findings: string[];
  measuredAt: string;
}

export interface CreditWeekVerdict {
  state: CreditWeekState;
  /** True only when hours AND completeness both passed on real data. */
  automatic: boolean;
  /** Every reason the week did not qualify automatically. Empty when it did. */
  blockers: string[];
  evidence: CreditWeekEvidence;
  /** One credit per completed week. Stated as a number so a part-week can never become a fraction. */
  creditValue: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A quarter of an hour of slack on the hours test, and no more.
 *
 * Clock arithmetic across a week accumulates seconds, and refusing a credit over 39.98 measured
 * hours would be arithmetic pretending to be judgement. Fifteen minutes is small enough that nobody
 * can bank it and large enough that a rounding artefact never costs somebody a week.
 */
export const HOURS_TOLERANCE = 0.25;

/**
 * DECIDE ONE WEEK.
 *
 * PURE. Same input, same verdict, every time — which is what makes the automatic path safe to run
 * repeatedly. Idempotency at the storage layer (credit-week-ledger.ts) depends on this: running the
 * reconciliation twice must produce the same verdict, so that the second run has nothing to change.
 *
 * NOTHING IS EVER REFUSED HERE. A verdict is 'earned-automatically' or 'pending', full stop.
 * 'refused' is a state only a person can put a week into, because refusing somebody credit for a
 * week they say they worked is a decision with a name attached to it.
 */
export function decideCreditWeek(input: WeekMeasurementInput): CreditWeekVerdict {
  const days = input.days || [];
  const required = input.required;

  let hoursFromClock = 0;
  let hoursFromRecorded = 0;
  let daysWorked = 0;
  let holidays = 0;
  let excusedDays = 0;
  let reportsFiled = 0;
  let reportsExpected = 0;
  const incompleteDates: string[] = [];

  for (const d of days) {
    if (d.holiday) holidays++;
    const leaveUnits = Number.isFinite(d.approvedLeaveUnits) ? Math.min(Math.max(d.approvedLeaveUnits, 0), 1) : 0;
    // A holiday and approved leave on the same day is still one excused day, not two.
    excusedDays += d.holiday ? 1 : leaveUnits;

    if (d.incomplete) incompleteDates.push(d.date);

    if (typeof d.clockHours === 'number' && d.clockHours > 0) {
      hoursFromClock += d.clockHours;
    } else if (typeof d.recordedHours === 'number' && d.recordedHours > 0 && !d.incomplete) {
      hoursFromRecorded += d.recordedHours;
    }

    if (d.worked) {
      daysWorked++;
      // A daily report is expected for a day somebody worked, and for no other kind of day.
      // Expecting one on granted leave is the same mistake as counting the leave as a shortfall.
      reportsExpected++;
      if (d.reportFiled) reportsFiled++;
    }
  }

  hoursFromClock = round2(hoursFromClock);
  hoursFromRecorded = round2(hoursFromRecorded);
  const hoursMeasured = round2(hoursFromClock + hoursFromRecorded);

  // LEAVE AND HOLIDAYS REDUCE THE REQUIREMENT. Excused at the policy's own per-day figure, and the
  // requirement can be reduced to zero but never below it.
  const perDay = required.hours != null && required.daysPerWeek && required.daysPerWeek > 0
    ? required.hours / required.daysPerWeek
    : 0;
  const excusedHours = round2(Math.min(excusedDays * perDay, required.hours || 0));
  const hoursRequired = required.hours == null ? null : round2(Math.max(0, required.hours - excusedHours));

  const tasks = input.tasks || { assigned: 0, completed: 0, outstanding: [] };
  const findings: string[] = [];
  const blockers: string[] = [];

  findings.push('Required: ' + required.basis);
  if (excusedDays > 0) {
    findings.push('Approved leave and holidays excused ' + round2(excusedDays) + ' day(s), reducing the requirement by '
      + excusedHours + ' hour(s).');
  }
  findings.push('Measured ' + hoursMeasured + ' hour(s): ' + hoursFromClock
    + ' from clock-in and clock-out net of breaks, ' + hoursFromRecorded + ' from recorded entries.');
  findings.push('Daily reports filed on ' + reportsFiled + ' of ' + reportsExpected + ' day(s) worked.');
  findings.push('Assigned work: ' + tasks.completed + ' of ' + tasks.assigned + ' task(s) complete.');

  // ---- the two tests, each failing in words --------------------------------------------------

  if (!required.applicable) {
    blockers.push('This engagement is not on the weekly credit model.');
  }
  if (required.hours == null) {
    blockers.push('The required weekly hours are not recorded, so the hours cannot be tested.');
  }
  if (incompleteDates.length > 0) {
    blockers.push(incompleteDates.length + ' day(s) were clocked in and never clocked out ('
      + incompleteDates.join(', ') + '). Those hours are unknown, not zero.');
  }
  if (hoursRequired != null && hoursMeasured + HOURS_TOLERANCE < hoursRequired) {
    blockers.push('Measured ' + hoursMeasured + ' of the ' + hoursRequired + ' hour(s) this week required.');
  }
  if (reportsExpected > reportsFiled) {
    blockers.push((reportsExpected - reportsFiled) + ' daily report(s) were not filed.');
  }
  if (tasks.assigned > tasks.completed) {
    const which = tasks.outstanding.length ? ' (' + tasks.outstanding.slice(0, 5).join('; ') + ')' : '';
    blockers.push((tasks.assigned - tasks.completed) + ' assigned task(s) are not complete' + which + '.');
  }
  if (!input.weekComplete) {
    blockers.push('The week is still in progress. A week is decided once it has finished.');
  }
  // A week nobody worked at all is not a week that quietly earns a credit because there was also
  // nothing outstanding. Stated explicitly rather than left to arithmetic.
  if (daysWorked === 0 && hoursMeasured <= 0) {
    blockers.push('No worked day and no measured hours are recorded for this week.');
  }

  const automatic = blockers.length === 0;

  const evidence: CreditWeekEvidence = {
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    hoursMeasured,
    hoursFromClock,
    hoursFromRecorded,
    hoursRequired,
    hoursRequiredBeforeLeave: required.hours,
    hoursBasis: required.basis,
    excusedDays: round2(excusedDays),
    excusedHours,
    reportsFiled,
    reportsExpected,
    tasksCompleted: tasks.completed,
    tasksAssigned: tasks.assigned,
    tasksOutstanding: tasks.outstanding.slice(0, 20),
    incompleteDates,
    daysWorked,
    holidays,
    findings: automatic ? findings.concat(['Both tests passed on measured data. Credit granted automatically.']) : findings.concat(blockers),
    measuredAt: new Date().toISOString(),
  };

  return {
    state: automatic ? 'earned-automatically' : 'pending',
    automatic,
    blockers,
    evidence,
    creditValue: 1,
  };
}

/**
 * WHAT A SCREEN SAYS A CREDIT RESTS ON. Never a bare number.
 *
 * Returns short lines rather than a paragraph so a 360px phone can render them as a list without
 * anything scrolling sideways.
 */
export function describeEvidence(e: CreditWeekEvidence | null | undefined): string[] {
  if (!e) return ['No evidence was recorded with this credit.'];
  return Array.isArray(e.findings) && e.findings.length ? e.findings : ['No evidence was recorded with this credit.'];
}

/** The one-line summary of a week, for a list. Plain words, no arrows, no emoji. */
export function summariseWeek(e: CreditWeekEvidence | null | undefined): string {
  if (!e) return 'No measurement recorded.';
  const req = e.hoursRequired == null ? 'an unrecorded requirement' : e.hoursRequired + ' h required';
  return e.hoursMeasured + ' h measured against ' + req + '; '
    + e.reportsFiled + '/' + e.reportsExpected + ' reports; '
    + e.tasksCompleted + '/' + e.tasksAssigned + ' tasks.';
}

/* ------------------------------------------------------------------------------ the position */

/** What a person has earned, and what is still waiting on somebody. */
export interface CreditPosition {
  earnedAutomatically: number;
  approvedByPerson: number;
  pending: number;
  refused: number;
  /** Credits that exist: earned automatically plus approved by a person. */
  credits: number;
  /** Hours measured across every week counted, credited or not. */
  hoursMeasured: number;
}

export function positionFrom(
  weeks: { state: string; creditValue?: number | null; hoursMeasured?: number | null }[],
): CreditPosition {
  const p: CreditPosition = {
    earnedAutomatically: 0, approvedByPerson: 0, pending: 0, refused: 0, credits: 0, hoursMeasured: 0,
  };
  for (const w of weeks || []) {
    const v = Number(w.creditValue);
    const credit = Number.isFinite(v) && v > 0 ? v : 1;
    const h = Number(w.hoursMeasured);
    if (Number.isFinite(h)) p.hoursMeasured += h;
    if (w.state === 'earned-automatically') { p.earnedAutomatically += credit; p.credits += credit; }
    else if (w.state === 'approved') { p.approvedByPerson += credit; p.credits += credit; }
    else if (w.state === 'refused') p.refused += credit;
    else p.pending += credit;
  }
  p.hoursMeasured = round2(p.hoursMeasured);
  return p;
}
