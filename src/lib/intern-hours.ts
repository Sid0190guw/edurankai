// src/lib/intern-hours.ts — AN INTERN'S HOURS AS A MEASUREMENT, NEXT TO THE PROMISE THEY MADE.
//
// =================================================================================================
// THE COMPLAINT THIS FILE EXISTS TO FIX
// =================================================================================================
//
// The product showed an intern a figure like "40 hours" that was not derived from anything they had
// done. It came from two places and neither of them is a measurement:
//
//   1. offer_letters.content->>'hoursCommitment' — FREE TEXT typed into a form, e.g. "20 hours per
//      week" or "2.5 hrs/day, 5 days/week" or just "Full-time". That is a COMMITMENT: what somebody
//      agreed to do. It says nothing whatsoever about what they did.
//   2. credit-hours.ts FULL_TIME_WEEKLY_HOURS = 40, which summarise() also uses as the per-day
//      credit for any 'present' day that carries no recorded hours. A day HR ticked in a grid
//      therefore reads as eight hours worked. Nobody worked those eight hours; a default did.
//
// Interns now clock in and out (src/lib/attendance.ts). Their hours are a FACT with a source, and
// this module reads that source. It never invents a minute, and it never presents a commitment as
// though it were an achievement — both numbers are returned, separately, each labelled with the
// period it covers and what it counts, so the person can reconcile it against their own week.
//
// =================================================================================================
// WHERE THE MINUTES COME FROM, AND WHY NET
// =================================================================================================
//
// hr_attendance.work_hours is written by writeDayFromPunches() in src/lib/attendance.ts from
// computeDay(), which is span-minus-breaks. So the stored figure is ALREADY net of breaks, and
// hr_attendance.break_minutes carries what was taken out. Both are returned: a person who is told
// "6h 10m worked" and can also see "50m of breaks" can check the number against their own day, and
// a person who cannot check a number has been given a worse thing than no number.
//
// NOTHING HERE RE-DERIVES A DAY FROM THE PUNCH LOG. computeDay() is the one place that arithmetic
// lives and it has already run. A second implementation would eventually disagree with the first,
// and then nobody could say which of the two figures on the two screens was the real one.
//
// =================================================================================================
// AN UNFINISHED DAY IS NEITHER A FULL ONE NOR A ZERO
// =================================================================================================
//
// A clock-in with no clock-out leaves hr_attendance with clock_in set, clock_out NULL and
// work_hours 0 — because computeDay() bounds the day by its clock_out and there isn't one. Two
// tempting readings are both lies: "0 hours" says they did nothing, "a full day" says they did
// eight. So the day is INCOMPLETE: it counts toward what was expected of them, contributes zero
// measured minutes, and is reported and dated separately so the screen can name the days that need
// fixing instead of quietly deflating a total.
//
// (A row with no clock_out but non-zero work_hours is an HR entry, not an abandoned clock. Those
// minutes are real and are counted, with clockOutMissing flagged so the row still reads honestly.)
//
// =================================================================================================
// LEAVE AND HOLIDAYS COME OUT OF THE EXPECTATION, NOT OUT OF THE PERSON
// =================================================================================================
//
// An approved leave day or an observed holiday is EXCUSED: it contributes nothing to worked minutes
// AND nothing to expected minutes. Counting it as a shortfall would punish somebody for leave that
// was granted to them, which is the opposite of what granting it meant. This mirrors the rule
// credit-hours.ts already applies to authorised leave, so the two do not drift.
//
// AN ADVISORY, NEVER A PENALTY. Nothing in this module decides anything. There is no threshold, no
// flag, no score and no consequence — it returns counts and sentences, and a human reads them.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. `r.rows[0]` is always a bug.
//   - The real Postgres reason is on `e.cause`; `e.message` is only the failed SQL.
//   - Every const is declared above the function that reads it — `const` is not hoisted.
//   - employee_id and department_id are compared as ::text on both sides, never cast ::uuid:
//     departments.id is a varchar slug in schema.ts and a UUID in db/hr-schema.sql.
//   - Readers fail closed. A failed read reports `readFailed`, and the caller must SAY SO on screen
//     rather than render a zero that looks like an answer.
import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureAttendanceSchema } from './attendance-schema';
import {
  dateRange,
  isoWeekday,
  weekdayName,
  weekStartIso,
  shiftDateIso,
  formatMinutes,
  today as attendanceToday,
} from './attendance';
import { observedDates } from './holidays';
import { textIn } from '@/lib/pg-array';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[intern-hours] ' + tag, e?.cause?.message || e?.message);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const isoOf = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

/** The widest window a single read will scan. Two years of an internship is already unusual. */
const MAX_SPAN_DAYS = 800;

/** How many people one bulk read will accept. An HR list is paged; this is the ceiling on a page. */
const MAX_PEOPLE = 200;

/** No parsed commitment above this is believed — it is a typo, not a contract. */
const MAX_SANE_WEEKLY_HOURS = 80;
const MAX_SANE_DAILY_HOURS = 16;

/** Working days assumed when nothing was agreed. Stated on screen wherever it is used. */
const DEFAULT_WORKING_DAYS_PER_WEEK = 5;

// =================================================================================================
// THE COMMITMENT — free text, read as free text
// =================================================================================================

export interface HoursCommitment {
  /** Exactly what the offer letter records, unedited. Null when no offer text was found. */
  text: string | null;
  /** Hours a week, only when something unambiguous was stated. Null is a real answer here. */
  weeklyHours: number | null;
  /** Hours a day, derived from the text or from weeklyHours over the agreed working days. */
  dailyHours: number | null;
  /** Working days a week the commitment assumes. Defaulted to 5 and said so in `basis`. */
  workingDaysPerWeek: number;
  /** Whether workingDaysPerWeek was stated or assumed — the screen must not imply it was agreed. */
  workingDaysStated: boolean;
  source: 'offer-letter' | 'engagement-terms' | 'none';
  /** One sentence saying how the number above was arrived at. Rendered next to it, always. */
  basis: string;
}

/** What a free-text commitment yielded. Every field null when the text stated no number. */
export interface ParsedCommitment {
  dailyHours: number | null;
  daysPerWeek: number | null;
  weeklyHours: number | null;
  /** True when at least one number was recognised. */
  matched: boolean;
}

const NUM = '(\\d{1,3}(?:[.,]\\d{1,2})?)';
const PER = '(?:\\/|\\s*per\\s*|\\s*a\\s*|\\s*each\\s*|\\s*)';
const HOURS_PER_DAY_RE = new RegExp(NUM + '\\s*(?:hrs?|hours?|h)\\b' + PER + 'day', 'i');
const HOURS_PER_WEEK_RE = new RegExp(NUM + '\\s*(?:hrs?|hours?|h)\\b' + PER + '(?:week|wk)', 'i');
const DAYS_PER_WEEK_RE = new RegExp(NUM + '\\s*days?\\b' + PER + '(?:week|wk)', 'i');

const toNumber = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/**
 * Read a free-text hours commitment as numbers, WITHOUT guessing.
 *
 * PURE. "2.5 hrs/day, 5 days/week" and "20 hours per week" both state something checkable;
 * "Full-time" states an arrangement, not a quantity, and comes back unmatched on purpose. The
 * caller then falls through to the engagement terms recorded against the employee, and if those are
 * unset it shows no commitment at all — which is the truth, and is better than printing 40.
 */
export function parseHoursCommitment(text: string | null | undefined): ParsedCommitment {
  const empty: ParsedCommitment = { dailyHours: null, daysPerWeek: null, weeklyHours: null, matched: false };
  const s = String(text ?? '').trim();
  if (!s) return empty;

  const perDay = toNumber(HOURS_PER_DAY_RE.exec(s)?.[1]);
  const perWeek = toNumber(HOURS_PER_WEEK_RE.exec(s)?.[1]);
  const daysRaw = toNumber(DAYS_PER_WEEK_RE.exec(s)?.[1]);
  const daysPerWeek = daysRaw !== null && daysRaw >= 1 && daysRaw <= 7 ? daysRaw : null;

  // A daily figure above a waking day, or a weekly figure above a working life, is a typo. Refusing
  // it leaves the commitment unstated, which a screen can say; believing it would put a fiction on
  // an intern's record.
  const dailySane = perDay !== null && perDay <= MAX_SANE_DAILY_HOURS ? perDay : null;
  const weeklySane = perWeek !== null && perWeek <= MAX_SANE_WEEKLY_HOURS ? perWeek : null;

  let weeklyHours = weeklySane;
  let dailyHours = dailySane;

  if (weeklyHours === null && dailyHours !== null && daysPerWeek !== null) {
    const w = Math.round(dailyHours * daysPerWeek * 100) / 100;
    weeklyHours = w <= MAX_SANE_WEEKLY_HOURS ? w : null;
  }
  if (dailyHours === null && weeklyHours !== null && daysPerWeek !== null && daysPerWeek > 0) {
    dailyHours = Math.round((weeklyHours / daysPerWeek) * 100) / 100;
  }

  return {
    dailyHours,
    daysPerWeek,
    weeklyHours,
    matched: dailyHours !== null || weeklyHours !== null || daysPerWeek !== null,
  };
}

/**
 * Turn the offer text and the recorded engagement terms into one commitment, saying which won.
 *
 * PURE, so the sentence on the intern's own screen and the sentence on the HR screen are produced
 * by the same three lines rather than written twice.
 */
export function resolveCommitment(input: {
  offerText?: string | null;
  termsWeeklyHours?: number | null;
  termsWorkingDaysPerWeek?: number | null;
}): HoursCommitment {
  const text = String(input?.offerText ?? '').trim() || null;
  const parsed = parseHoursCommitment(text);

  const termsWeekly = Number(input?.termsWeeklyHours);
  const termsWeeklyOk = Number.isFinite(termsWeekly) && termsWeekly > 0 && termsWeekly <= MAX_SANE_WEEKLY_HOURS
    ? Math.round(termsWeekly * 100) / 100
    : null;

  const termsDaysRaw = Number(input?.termsWorkingDaysPerWeek);
  const termsDays = Number.isFinite(termsDaysRaw) && termsDaysRaw >= 1 && termsDaysRaw <= 7
    ? Math.round(termsDaysRaw)
    : null;

  const workingDaysStated = parsed.daysPerWeek !== null || termsDays !== null;
  const workingDaysPerWeek = parsed.daysPerWeek ?? termsDays ?? DEFAULT_WORKING_DAYS_PER_WEEK;

  // The offer is the document the person signed, so it is asked first. The engagement terms are the
  // fallback because they are a number a human typed into a numeric field, which "Full-time" is not.
  let weeklyHours: number | null = null;
  let source: HoursCommitment['source'] = 'none';
  if (parsed.weeklyHours !== null) {
    weeklyHours = parsed.weeklyHours;
    source = 'offer-letter';
  } else if (termsWeeklyOk !== null) {
    weeklyHours = termsWeeklyOk;
    source = 'engagement-terms';
  }

  let dailyHours: number | null = parsed.dailyHours;
  if (dailyHours === null && weeklyHours !== null) {
    dailyHours = Math.round((weeklyHours / workingDaysPerWeek) * 100) / 100;
  }
  if (weeklyHours === null && dailyHours !== null) {
    weeklyHours = Math.round(dailyHours * workingDaysPerWeek * 100) / 100;
    source = 'offer-letter';
  }

  let basis: string;
  if (source === 'none') {
    basis = text
      ? 'The offer records "' + text + '", which does not state a number of hours, and no weekly '
        + 'hours are recorded against this engagement. So there is no commitment to compare against.'
      : 'No hours commitment is recorded on the offer or against this engagement, so there is '
        + 'nothing to compare the measured hours against.';
  } else if (source === 'offer-letter') {
    basis = 'From the offer letter, which records "' + String(text) + '".'
      + (workingDaysStated
        ? ''
        : ' It does not state how many days a week, so ' + DEFAULT_WORKING_DAYS_PER_WEEK
          + ' working days a week is assumed for the per-day figure.');
  } else {
    basis = 'From the weekly hours recorded against this engagement by HR'
      + (text ? ', because the offer records "' + text + '", which states no number.' : '.')
      + (workingDaysStated ? '' : ' ' + DEFAULT_WORKING_DAYS_PER_WEEK
        + ' working days a week is assumed for the per-day figure.');
  }

  return { text, weeklyHours, dailyHours, workingDaysPerWeek, workingDaysStated, source, basis };
}

// =================================================================================================
// ONE DAY
// =================================================================================================

export type InternDayState =
  | 'worked'
  | 'incomplete'
  | 'present-no-hours'
  | 'leave'
  | 'holiday'
  | 'absent'
  | 'no-record'
  | 'off'
  | 'before-joining'
  | 'future';

export interface InternDay {
  dateIso: string;
  weekday: string;
  state: InternDayState;
  /** Net of breaks, and 0 for every state except 'worked'. Never a guess. */
  workedMinutes: number;
  /** What was taken out of the span to get workedMinutes. Shown so the total reconciles. */
  breakMinutes: number;
  clockIn: string | null;
  clockOut: string | null;
  /** A clock-in with no clock-out. True on 'incomplete', and on an HR row that still has hours. */
  clockOutMissing: boolean;
  /** Excused: contributes nothing to worked minutes AND nothing to expected minutes. */
  excused: boolean;
  /** Counts toward what was expected of this person on this day. */
  counted: boolean;
  /** Minutes expected on this day. 0 whenever there is no commitment or the day is excused. */
  expectedMinutes: number;
  /** One sentence for the screen. Never a verdict. */
  note: string;
}

/** Everything classifyDay needs about one date, already read. */
export interface DayFacts {
  dateIso: string;
  status: string | null;
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number | null;
  breakMinutes: number | null;
  /** An APPROVED leave request covers this date. */
  approvedLeave: boolean;
  /** The name of an observed (non-optional, in-scope) holiday on this date. */
  holidayName: string | null;
}

export interface DayContext {
  todayIso: string;
  joiningIso: string | null;
  /** ISO weekday numbers (1 = Monday) that are working days. */
  workingWeekdays: number[];
  /** Minutes expected on a working day, or null when no commitment is recorded. */
  dailyExpectedMinutes: number | null;
}

/**
 * What one date WAS. PURE, and the only place the states are decided.
 *
 * The order of the tests is the whole design, so it is written out rather than left to be inferred:
 *
 *   1. future / before-joining      — outside the engagement; never counted, never a shortfall.
 *   2. an unfinished clock          — a clock-in with no clock-out and nothing measurable. Counted
 *                                     as expected, credited zero, and REPORTED as incomplete. This
 *                                     is tested before status because the status column says
 *                                     'present' or 'wfh' on exactly such a row.
 *   3. holiday                      — the row says so, or the holiday calendar does. Excused.
 *   4. leave                        — an approved request covers it, or the row says 'on_leave'.
 *                                     Excused, whichever said so first.
 *   5. measured minutes             — worked. The only state that contributes worked time.
 *   6. a row with no minutes        — 'present-no-hours'. Not zero-worked, not a full day: a day
 *                                     somebody recorded without recording any hours against it.
 *   7. absent                       — the row says so and no approved leave covers it. Counted.
 *   8. no row at all                — 'no-record' on a working day, 'off' otherwise. An absence of
 *                                     DATA, which is not the same claim as an absence of work.
 */
export function classifyDay(facts: DayFacts, ctx: DayContext): InternDay {
  const dateIso = String(facts?.dateIso || '');
  const weekday = weekdayName(dateIso);
  const status = String(facts?.status ?? '').trim().toLowerCase();
  const worked = Math.max(0, Math.round(Number(facts?.workedMinutes) || 0));
  const breaks = Math.max(0, Math.round(Number(facts?.breakMinutes) || 0));
  const clockIn = facts?.clockIn ? String(facts.clockIn) : null;
  const clockOut = facts?.clockOut ? String(facts.clockOut) : null;
  const clockOutMissing = !!clockIn && !clockOut;
  const hasRow = !!status || !!clockIn || worked > 0;
  const wd = isoWeekday(dateIso) || 0;
  const isWorkingWeekday = ctx.workingWeekdays.includes(wd);
  const perDay = ctx.dailyExpectedMinutes;

  const make = (
    state: InternDayState,
    note: string,
    opts: { worked?: number; excused?: boolean; counted?: boolean } = {},
  ): InternDay => {
    const counted = opts.counted === true;
    return {
      dateIso,
      weekday,
      state,
      workedMinutes: opts.worked || 0,
      breakMinutes: breaks,
      clockIn,
      clockOut,
      clockOutMissing,
      excused: opts.excused === true,
      counted,
      expectedMinutes: counted && perDay !== null ? perDay : 0,
      note,
    };
  };

  if (dateIso > ctx.todayIso) return make('future', 'Has not happened yet.');
  if (ctx.joiningIso && dateIso < ctx.joiningIso) {
    return make('before-joining', 'Before the recorded joining date.');
  }

  if (clockOutMissing && worked <= 0) {
    return make('incomplete',
      'Checked in and never checked out, so no worked time could be measured for this day. It is '
      + 'not zero hours and it is not a full day — it is an unfinished record.',
      { counted: isWorkingWeekday });
  }

  if (status === 'holiday' || facts?.holidayName) {
    return make('holiday',
      facts?.holidayName ? String(facts.holidayName) + ' — a holiday, so nothing was expected.'
        : 'Recorded as a holiday, so nothing was expected.',
      { excused: true });
  }

  if (facts?.approvedLeave || status === 'on_leave') {
    return make('leave',
      facts?.approvedLeave
        ? 'Approved leave, so nothing was expected on this day.'
        : 'Recorded as leave, so nothing was expected on this day.',
      { excused: true });
  }

  if (worked > 0) {
    return make('worked',
      'Worked ' + formatMinutes(worked)
      + (breaks > 0 ? ', with ' + formatMinutes(breaks) + ' of breaks already taken out' : '')
      + (clockOutMissing ? '. No check-out was recorded, so these hours were entered by HR' : '')
      + '.',
      { worked, counted: isWorkingWeekday });
  }

  if (status === 'absent') {
    return make('absent',
      'Recorded as absent, with no approved leave covering it.',
      { counted: isWorkingWeekday });
  }

  if (hasRow) {
    return make('present-no-hours',
      'A day was recorded but no hours were recorded against it, so there is nothing to count.',
      { counted: isWorkingWeekday });
  }

  if (isWorkingWeekday) {
    return make('no-record',
      'No attendance was recorded at all. That is missing data, not a claim that nothing was done.',
      { counted: true });
  }
  return make('off', 'Not a working day under the recorded arrangement.');
}

// =================================================================================================
// A PERIOD
// =================================================================================================

export interface HoursPeriod {
  /** e.g. "This week" — what the figure is FOR. Always rendered beside the number. */
  label: string;
  fromIso: string;
  toIso: string;
  /** What the number counts, in words. Rendered beside the number, always. */
  counts: string;
  /** Net of breaks. Only days with measured worked time contribute. */
  workedMinutes: number;
  /** Break minutes already excluded from workedMinutes, over the same days. */
  breakMinutes: number;
  daysWorked: number;
  incompleteDays: number;
  /** The dates of those days, so a screen can name them instead of only counting them. */
  incompleteDates: string[];
  presentNoHoursDays: number;
  leaveDays: number;
  holidayDays: number;
  absentDays: number;
  noRecordDays: number;
  /** Days excused by leave or a holiday, and therefore removed from expectedMinutes. */
  excusedDays: number;
  /** Working days in the period that counted toward the expectation. */
  countedDays: number;
  /** Null when no commitment is recorded. Null is a real answer and must be shown as one. */
  expectedMinutes: number | null;
}

const EMPTY_PERIOD = (label: string, fromIso: string, toIso: string, counts: string): HoursPeriod => ({
  label, fromIso, toIso, counts,
  workedMinutes: 0, breakMinutes: 0, daysWorked: 0,
  incompleteDays: 0, incompleteDates: [], presentNoHoursDays: 0,
  leaveDays: 0, holidayDays: 0, absentDays: 0, noRecordDays: 0,
  excusedDays: 0, countedDays: 0, expectedMinutes: null,
});

/**
 * Add up a run of classified days. PURE.
 *
 * `expectedMinutes` stays NULL when no commitment is recorded, rather than becoming 0 — a zero
 * expectation and an unknown one look identical on a progress bar and mean opposite things.
 */
export function totalPeriod(
  days: InternDay[],
  opts: { label: string; fromIso: string; toIso: string; counts: string; hasCommitment: boolean },
): HoursPeriod {
  const out = EMPTY_PERIOD(opts.label, opts.fromIso, opts.toIso, opts.counts);
  let expected = 0;
  for (const d of days || []) {
    out.workedMinutes += d.workedMinutes;
    if (d.state === 'worked') { out.daysWorked++; out.breakMinutes += d.breakMinutes; }
    if (d.state === 'incomplete') { out.incompleteDays++; out.incompleteDates.push(d.dateIso); }
    if (d.state === 'present-no-hours') out.presentNoHoursDays++;
    if (d.state === 'leave') out.leaveDays++;
    if (d.state === 'holiday') out.holidayDays++;
    if (d.state === 'absent') out.absentDays++;
    if (d.state === 'no-record') out.noRecordDays++;
    if (d.excused) out.excusedDays++;
    if (d.counted) { out.countedDays++; expected += d.expectedMinutes; }
  }
  out.expectedMinutes = opts.hasCommitment ? expected : null;
  return out;
}

// =================================================================================================
// THE ANSWER
// =================================================================================================

export interface InternHours {
  employeeId: string;
  /** CURRENT_DATE as Postgres counts it, or the server's date when that read did not happen. */
  todayIso: string;
  joiningIso: string | null;
  /** Monday of the current week, and the day the week figure stops at (today, not Sunday). */
  weekStartIso: string;
  weekEndIso: string;
  /** The window actually scanned for the cumulative figure. */
  fromIso: string;
  toIso: string;
  commitment: HoursCommitment;
  week: HoursPeriod;
  total: HoursPeriod;
  /** Every day in the window, oldest first. The evidence behind both figures. */
  days: InternDay[];
  /** True when a read failed. The caller MUST say so instead of rendering the zeros below. */
  readFailed: boolean;
  /** Which reads failed, for the sentence on screen. */
  failed: string[];
}

/** The sentence that must appear beside the weekly figure. Exported so it is written once. */
export const WEEK_COUNTS =
  'Net time between check-in and check-out, with breaks taken out, on days from Monday to today.';

/** The sentence that must appear beside the cumulative figure. */
export const TOTAL_COUNTS =
  'Net time between check-in and check-out, with breaks taken out, across every recorded day since '
  + 'the engagement started. Days never checked out of are excluded and counted separately.';

/**
 * Hours for one intern: this week, in total, and the commitment to compare them against.
 *
 * FOUR READS, NOT ONE PER DAY: attendance rows, approved leave, the holiday calendar and the
 * commitment are each fetched once for the whole window and joined in memory. A per-day loop over an
 * internship is three hundred round trips on a pooled connection.
 */
export async function internHoursFor(
  employeeId: string,
  opts: { fromIso?: string | null; toIso?: string | null } = {},
): Promise<InternHours> {
  const failed: string[] = [];
  const now = (await attendanceToday()) || new Date().toISOString().slice(0, 10);

  // Declared before every use. The commitment read needs the employee row anyway, so it is first.
  const profile = await readProfile(employeeId, failed);
  const commitment = resolveCommitment({
    offerText: profile.offerHoursCommitment,
    termsWeeklyHours: profile.weeklyHours,
    termsWorkingDaysPerWeek: profile.workingDaysPerWeek,
  });

  const requestedFrom = isDateIso(opts?.fromIso) ? String(opts.fromIso) : null;
  const joining = isDateIso(profile.joiningDate) ? profile.joiningDate : null;
  const to = isDateIso(opts?.toIso) && String(opts.toIso) <= now ? String(opts.toIso) : now;
  const from = clampWindow(requestedFrom || joining || shiftDateIso(to, -179), to);

  const weekStart = weekStartIso(now);
  const weekEnd = now;

  const scanFrom = from < weekStart ? from : weekStart;
  const ctx: DayContext = {
    todayIso: now,
    joiningIso: joining,
    workingWeekdays: workingWeekdaysFor(commitment.workingDaysPerWeek),
    dailyExpectedMinutes: commitment.dailyHours === null
      ? null
      : Math.round(commitment.dailyHours * 60),
  };

  const attendance = await readAttendance(employeeId, scanFrom, to, failed);
  const leave = await readApprovedLeave(employeeId, scanFrom, to, failed);
  const holidays = await readHolidays(scanFrom, to, profile.departmentId, failed);

  const days: InternDay[] = dateRange(scanFrom, to, MAX_SPAN_DAYS).map((dateIso) => {
    const row = attendance.get(dateIso) || null;
    return classifyDay({
      dateIso,
      status: row ? row.status : null,
      clockIn: row ? row.clockIn : null,
      clockOut: row ? row.clockOut : null,
      workedMinutes: row ? row.workedMinutes : null,
      breakMinutes: row ? row.breakMinutes : null,
      approvedLeave: leave.has(dateIso),
      holidayName: holidays.get(dateIso) || null,
    }, ctx);
  });

  const hasCommitment = commitment.dailyHours !== null;
  const week = totalPeriod(days.filter((d) => d.dateIso >= weekStart && d.dateIso <= weekEnd), {
    label: 'This week', fromIso: weekStart, toIso: weekEnd, counts: WEEK_COUNTS, hasCommitment,
  });
  const total = totalPeriod(days.filter((d) => d.dateIso >= from), {
    label: 'Since the engagement started', fromIso: from, toIso: to, counts: TOTAL_COUNTS, hasCommitment,
  });

  return {
    employeeId: String(employeeId || ''),
    todayIso: now,
    joiningIso: joining,
    weekStartIso: weekStart,
    weekEndIso: weekEnd,
    fromIso: from,
    toIso: to,
    commitment,
    week,
    total,
    days,
    readFailed: failed.length > 0,
    failed,
  };
}

/** ISO weekday numbers that are working days, given how many days a week were agreed. */
export function workingWeekdaysFor(daysPerWeek: number): number[] {
  const n = Number.isFinite(daysPerWeek) ? Math.min(Math.max(Math.round(daysPerWeek), 1), 7) : 5;
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

function clampWindow(from: string, to: string): string {
  if (!isDateIso(from) || !isDateIso(to)) return to;
  if (from > to) return to;
  const widest = shiftDateIso(to, -(MAX_SPAN_DAYS - 1));
  return from < widest ? widest : from;
}

// -------------------------------------------------------------------------------------------------
// THE READS. Each one fails closed and names itself in `failed`.
// -------------------------------------------------------------------------------------------------

interface AttendanceFacts {
  status: string | null;
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
}

interface Profile {
  joiningDate: string | null;
  departmentId: string | null;
  weeklyHours: number | null;
  workingDaysPerWeek: number | null;
  offerHoursCommitment: string | null;
  fullName: string;
  employeeCode: string | null;
  designation: string | null;
}

interface ProfileRow extends Profile { departmentName: string | null; }

const EMPTY_PROFILE: Profile = {
  joiningDate: null, departmentId: null, weeklyHours: null, workingDaysPerWeek: null,
  offerHoursCommitment: null, fullName: '', employeeCode: null, designation: null,
};

/** The list-shaped fallback. Declared here, above both readers — `const` is not hoisted. */
const EMPTY_PROFILE_ROW: ProfileRow = { ...EMPTY_PROFILE, departmentName: null };

/**
 * The employee row plus the hours line from their offer.
 *
 * The offer is reached through hr_employees.application_id -> offer_letters.application_id, and the
 * SIGNED one wins over a later draft: a draft is a document somebody is still editing, and an
 * intern's own screen must quote what they actually signed. weekly_hours / working_days_per_week may
 * not exist on hr_employees (they are added at runtime by credit-ledger.ensureTermColumns), so they
 * are read in a SECOND statement whose failure costs only the fallback, not the whole profile.
 */
async function readProfile(employeeId: string, failed: string[]): Promise<Profile> {
  if (!isUuid(employeeId)) return EMPTY_PROFILE;
  const out: Profile = { ...EMPTY_PROFILE };
  try {
    const r = rows(await db.execute(sql`
      SELECT e.full_name, e.employee_code, e.designation,
             e.joining_date, e.department_id::text AS department_id,
             o.content->>'hoursCommitment' AS hours_commitment
        FROM hr_employees e
        LEFT JOIN LATERAL (
          SELECT ol.content
            FROM offer_letters ol
           WHERE ol.application_id = e.application_id
           ORDER BY (ol.signed_at IS NOT NULL) DESC, ol.created_at DESC
           LIMIT 1
        ) o ON TRUE
       WHERE e.id = ${employeeId}::uuid
       LIMIT 1`))[0];
    if (r) {
      out.fullName = String(r.full_name || '');
      out.employeeCode = r.employee_code ? String(r.employee_code) : null;
      out.designation = r.designation ? String(r.designation) : null;
      out.joiningDate = isoOf(r.joining_date) || null;
      out.departmentId = r.department_id ? String(r.department_id) : null;
      out.offerHoursCommitment = r.hours_commitment ? String(r.hours_commitment) : null;
    }
  } catch (e: any) {
    logFail('readProfile', e);
    failed.push('the employee record and the offer');
  }

  try {
    const t = rows(await db.execute(sql`
      SELECT weekly_hours, working_days_per_week
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    if (t) {
      out.weeklyHours = t.weekly_hours == null ? null : Number(t.weekly_hours);
      out.workingDaysPerWeek = t.working_days_per_week == null ? null : Number(t.working_days_per_week);
    }
  } catch (e: any) {
    // The columns are added at runtime elsewhere. Absent here means "no agreed hours recorded",
    // which resolveCommitment() already renders honestly — so this is NOT reported as a read failure.
    logFail('readProfile.terms', e);
  }
  return out;
}

async function readAttendance(
  employeeId: string,
  from: string,
  to: string,
  failed: string[],
): Promise<Map<string, AttendanceFacts>> {
  const out = new Map<string, AttendanceFacts>();
  if (!isUuid(employeeId) || !isDateIso(from) || !isDateIso(to)) return out;
  try {
    await ensureAttendanceSchema();
    for (const r of rows(await db.execute(sql`
      SELECT date, status, clock_in, clock_out, work_hours, break_minutes
        FROM hr_attendance
       WHERE employee_id::text = ${String(employeeId)}
         AND date >= ${from}::date
         AND date <= ${to}::date
       ORDER BY date ASC`))) {
      const key = isoOf(r.date);
      if (key) out.set(key, mapAttendanceRow(r));
    }
  } catch (e: any) {
    logFail('readAttendance', e);
    failed.push('the attendance record');
  }
  return out;
}

function mapAttendanceRow(r: any): AttendanceFacts {
  return {
    status: r?.status ? String(r.status) : null,
    clockIn: r?.clock_in ? new Date(r.clock_in).toISOString() : null,
    clockOut: r?.clock_out ? new Date(r.clock_out).toISOString() : null,
    workedMinutes: Math.max(0, Math.round((Number(r?.work_hours) || 0) * 60)),
    breakMinutes: Math.max(0, Math.round(Number(r?.break_minutes) || 0)),
  };
}

/**
 * Dates covered by an APPROVED leave request.
 *
 * Approval is the only test here. credit-hours.ts additionally distinguishes leave taken WITHOUT
 * prior notice, and that distinction belongs to the completion letter — it is a question about
 * process, not about hours, and importing it would quietly make a notice breach look like a missing
 * hour on a screen about hours.
 */
async function readApprovedLeave(
  employeeId: string,
  from: string,
  to: string,
  failed: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isUuid(employeeId) || !isDateIso(from) || !isDateIso(to)) return out;
  try {
    for (const r of rows(await db.execute(sql`
      SELECT start_date, end_date
        FROM hr_leave_request
       WHERE employee_id::text = ${String(employeeId)}
         AND status = 'approved'
         AND end_date >= ${from}::date
         AND start_date <= ${to}::date
       ORDER BY start_date ASC
       LIMIT 400`))) {
      addLeaveWindow(out, isoOf(r.start_date), isoOf(r.end_date), from, to);
    }
  } catch (e: any) {
    logFail('readApprovedLeave', e);
    failed.push('approved leave');
  }
  return out;
}

function addLeaveWindow(into: Set<string>, start: string, end: string, from: string, to: string): void {
  if (!isDateIso(start)) return;
  const last = isDateIso(end) && end >= start ? end : start;
  const a = start < from ? from : start;
  const b = last > to ? to : last;
  if (a > b) return;
  for (const d of dateRange(a, b, MAX_SPAN_DAYS)) into.add(d);
}

async function readHolidays(
  from: string,
  to: string,
  departmentId: string | null,
  failed: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isDateIso(from) || !isDateIso(to)) return out;
  try {
    const observed = await observedDates(from, to, { departmentId });
    for (const [dateIso, h] of observed) out.set(dateIso, h?.name || 'Holiday');
  } catch (e: any) {
    logFail('readHolidays', e);
    failed.push('the holiday calendar');
  }
  return out;
}

// =================================================================================================
// MANY PEOPLE, FOR AN HR LIST
// =================================================================================================

export interface InternHoursRow {
  employeeId: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  departmentName: string | null;
  joiningIso: string | null;
  commitment: HoursCommitment;
  week: HoursPeriod;
  total: HoursPeriod;
  readFailed: boolean;
}

/**
 * The same figures for a bounded list of people, in a fixed number of queries.
 *
 * FOUR READS FOR THE WHOLE LIST, not four per head. An HR screen looking at forty interns would
 * otherwise be a hundred and sixty round trips, and every one of them would be reading rows it
 * already had. The days are then classified by the SAME classifyDay() the intern's own screen uses,
 * so the number HR reads is the number the intern reads.
 *
 * The caller must bound the list. There is no LIMIT inside the day queries because a LIMIT across a
 * multi-person result silently truncates the last person's history and understates their hours.
 */
export async function internHoursForMany(
  employeeIds: string[],
  opts: { fromIso?: string | null } = {},
): Promise<Map<string, InternHoursRow>> {
  const out = new Map<string, InternHoursRow>();
  const ids = Array.from(new Set((employeeIds || []).filter(isUuid))).slice(0, MAX_PEOPLE);
  if (!ids.length) return out;
  if ((employeeIds || []).length > MAX_PEOPLE) {
    console.warn('[intern-hours] internHoursForMany called with', employeeIds.length,
      'people — the list is bounded at', MAX_PEOPLE, 'and was truncated. Page it at the caller.');
  }

  const now = (await attendanceToday()) || new Date().toISOString().slice(0, 10);
  const weekStart = weekStartIso(now);
  const requestedFrom = isDateIso(opts?.fromIso) ? String(opts.fromIso) : null;
  const windowFrom = clampWindow(requestedFrom || shiftDateIso(now, -179), now);
  const scanFrom = windowFrom < weekStart ? windowFrom : weekStart;

  const failed: string[] = [];
  const profiles = await readProfilesMany(ids, failed);
  const attendance = await readAttendanceMany(ids, scanFrom, now, failed);
  const leave = await readApprovedLeaveMany(ids, scanFrom, now, failed);

  // One holiday read per distinct department rather than per person: an HR list is normally one or
  // two departments, and the calendar is scoped by department.
  const holidayByDept = new Map<string, Map<string, string>>();
  const deptKeys = new Set<string>();
  for (const id of ids) deptKeys.add(String(profiles.get(id)?.departmentId || ''));
  for (const key of deptKeys) {
    holidayByDept.set(key, await readHolidays(scanFrom, now, key || null, failed));
  }

  for (const id of ids) {
    const p = profiles.get(id) || EMPTY_PROFILE_ROW;
    const commitment = resolveCommitment({
      offerText: p.offerHoursCommitment,
      termsWeeklyHours: p.weeklyHours,
      termsWorkingDaysPerWeek: p.workingDaysPerWeek,
    });
    const joining = isDateIso(p.joiningDate) ? p.joiningDate : null;
    const ctx: DayContext = {
      todayIso: now,
      joiningIso: joining,
      workingWeekdays: workingWeekdaysFor(commitment.workingDaysPerWeek),
      dailyExpectedMinutes: commitment.dailyHours === null ? null : Math.round(commitment.dailyHours * 60),
    };
    const att = attendance.get(id) || new Map<string, AttendanceFacts>();
    const lv = leave.get(id) || new Set<string>();
    const hol = holidayByDept.get(String(p.departmentId || '')) || new Map<string, string>();

    const from = joining && joining > windowFrom ? joining : windowFrom;
    const days = dateRange(scanFrom, now, MAX_SPAN_DAYS).map((dateIso) => {
      const row = att.get(dateIso) || null;
      return classifyDay({
        dateIso,
        status: row ? row.status : null,
        clockIn: row ? row.clockIn : null,
        clockOut: row ? row.clockOut : null,
        workedMinutes: row ? row.workedMinutes : null,
        breakMinutes: row ? row.breakMinutes : null,
        approvedLeave: lv.has(dateIso),
        holidayName: hol.get(dateIso) || null,
      }, ctx);
    });

    const hasCommitment = commitment.dailyHours !== null;
    out.set(id, {
      employeeId: id,
      name: p.fullName,
      employeeCode: p.employeeCode,
      designation: p.designation,
      departmentName: p.departmentName,
      joiningIso: joining,
      commitment,
      week: totalPeriod(days.filter((d) => d.dateIso >= weekStart), {
        label: 'This week', fromIso: weekStart, toIso: now, counts: WEEK_COUNTS, hasCommitment,
      }),
      total: totalPeriod(days.filter((d) => d.dateIso >= from), {
        label: 'Window scanned', fromIso: from, toIso: now, counts: TOTAL_COUNTS, hasCommitment,
      }),
      readFailed: failed.length > 0,
    });
  }
  return out;
}

async function readProfilesMany(ids: string[], failed: string[]): Promise<Map<string, ProfileRow>> {
  const out = new Map<string, ProfileRow>();
  try {
    for (const r of rows(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name, e.employee_code, e.designation,
             e.joining_date, e.department_id::text AS department_id, d.name AS department_name,
             o.content->>'hoursCommitment' AS hours_commitment
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
        LEFT JOIN LATERAL (
          SELECT ol.content
            FROM offer_letters ol
           WHERE ol.application_id = e.application_id
           ORDER BY (ol.signed_at IS NOT NULL) DESC, ol.created_at DESC
           LIMIT 1
        ) o ON TRUE
       WHERE e.id::text IN ${textIn(ids)}`))) {
      out.set(String(r.id), {
        fullName: String(r.full_name || ''),
        employeeCode: r.employee_code ? String(r.employee_code) : null,
        designation: r.designation ? String(r.designation) : null,
        joiningDate: isoOf(r.joining_date) || null,
        departmentId: r.department_id ? String(r.department_id) : null,
        departmentName: r.department_name ? String(r.department_name) : null,
        offerHoursCommitment: r.hours_commitment ? String(r.hours_commitment) : null,
        weeklyHours: null,
        workingDaysPerWeek: null,
      });
    }
  } catch (e: any) {
    logFail('readProfilesMany', e);
    failed.push('the employee records and offers');
  }

  // Second statement for the runtime-added term columns, exactly as readProfile() does and for the
  // same reason: their absence means "no agreed hours recorded", not a broken page.
  try {
    for (const r of rows(await db.execute(sql`
      SELECT id::text AS id, weekly_hours, working_days_per_week
        FROM hr_employees WHERE id::text IN ${textIn(ids)}`))) {
      const p = out.get(String(r.id));
      if (!p) continue;
      p.weeklyHours = r.weekly_hours == null ? null : Number(r.weekly_hours);
      p.workingDaysPerWeek = r.working_days_per_week == null ? null : Number(r.working_days_per_week);
    }
  } catch (e: any) {
    logFail('readProfilesMany.terms', e);
  }
  return out;
}

async function readAttendanceMany(
  ids: string[],
  from: string,
  to: string,
  failed: string[],
): Promise<Map<string, Map<string, AttendanceFacts>>> {
  const out = new Map<string, Map<string, AttendanceFacts>>();
  if (!isDateIso(from) || !isDateIso(to)) return out;
  try {
    await ensureAttendanceSchema();
    for (const r of rows(await db.execute(sql`
      SELECT employee_id::text AS employee_id, date, status, clock_in, clock_out,
             work_hours, break_minutes
        FROM hr_attendance
       WHERE employee_id::text IN ${textIn(ids)}
         AND date >= ${from}::date
         AND date <= ${to}::date
       ORDER BY employee_id ASC, date ASC`))) {
      const key = String(r.employee_id);
      const day = isoOf(r.date);
      if (!day) continue;
      let m = out.get(key);
      if (!m) { m = new Map<string, AttendanceFacts>(); out.set(key, m); }
      m.set(day, mapAttendanceRow(r));
    }
  } catch (e: any) {
    logFail('readAttendanceMany', e);
    failed.push('the attendance record');
  }
  return out;
}

async function readApprovedLeaveMany(
  ids: string[],
  from: string,
  to: string,
  failed: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!isDateIso(from) || !isDateIso(to)) return out;
  try {
    for (const r of rows(await db.execute(sql`
      SELECT employee_id::text AS employee_id, start_date, end_date
        FROM hr_leave_request
       WHERE employee_id::text IN ${textIn(ids)}
         AND status = 'approved'
         AND end_date >= ${from}::date
         AND start_date <= ${to}::date
       ORDER BY employee_id ASC, start_date ASC`))) {
      const key = String(r.employee_id);
      let s = out.get(key);
      if (!s) { s = new Set<string>(); out.set(key, s); }
      addLeaveWindow(s, isoOf(r.start_date), isoOf(r.end_date), from, to);
    }
  } catch (e: any) {
    logFail('readApprovedLeaveMany', e);
    failed.push('approved leave');
  }
  return out;
}

// =================================================================================================
// SENTENCES — written once so both screens say the same thing
// =================================================================================================

/** "6h 10m" for a period, or "none" — never a bare 0 that could be read as a claim. */
export function hoursLabel(minutes: number): string {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return m > 0 ? formatMinutes(m) : 'none';
}

/**
 * The measured figure against the commitment, in one sentence, or an honest refusal.
 *
 * Never phrased as a pass or a failure. It states two facts and the period they belong to, and lets
 * the person draw the conclusion — which is the whole correction being made here.
 */
export function comparisonSentence(period: HoursPeriod, commitment: HoursCommitment): string {
  const worked = hoursLabel(period.workedMinutes);
  if (period.expectedMinutes === null || commitment.weeklyHours === null) {
    return 'Measured: ' + worked + ' between ' + period.fromIso + ' and ' + period.toIso
      + '. There is no recorded hours commitment to compare it against, so none is shown.';
  }
  const expected = hoursLabel(period.expectedMinutes);
  const excused = period.excusedDays > 0
    ? ' ' + period.excusedDays + ' day' + (period.excusedDays === 1 ? ' was' : 's were')
      + ' leave or a holiday and came out of the expected figure rather than counting against it.'
    : '';
  const incomplete = period.incompleteDays > 0
    ? ' ' + period.incompleteDays + ' day' + (period.incompleteDays === 1 ? '' : 's')
      + ' had a check-in and no check-out, so no time could be measured for '
      + (period.incompleteDays === 1 ? 'it' : 'them') + '; '
      + (period.incompleteDays === 1 ? 'it is' : 'they are') + ' listed separately and are not in the '
      + worked + '.'
    : '';
  return 'Measured ' + worked + ' against ' + expected + ' expected over '
    + period.countedDays + ' working day' + (period.countedDays === 1 ? '' : 's')
    + ' from ' + period.fromIso + ' to ' + period.toIso + '.' + excused + incomplete;
}

/** Plain-English name for a day state, for a table cell. */
export function dayStateLabel(state: InternDayState): string {
  if (state === 'worked') return 'Worked';
  if (state === 'incomplete') return 'Incomplete';
  if (state === 'present-no-hours') return 'Recorded, no hours';
  if (state === 'leave') return 'Leave';
  if (state === 'holiday') return 'Holiday';
  if (state === 'absent') return 'Absent';
  if (state === 'no-record') return 'Nothing recorded';
  if (state === 'off') return 'Non-working day';
  if (state === 'before-joining') return 'Before joining';
  return 'Not yet';
}
