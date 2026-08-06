// src/lib/holidays.ts — THE HOLIDAY CALENDAR, as leave and attendance need to read it.
//
// =================================================================================================
// ONE HOLIDAY TABLE. THIS FILE CREATES NOTHING.
// =================================================================================================
//
// hr_holidays is declared in src/lib/attendance-schema.ts and nowhere else, and the three WRITERS
// (addHoliday, removeHoliday, listHolidays) live in src/lib/attendance.ts and are re-exported from
// the bottom of this file rather than re-implemented. A second CREATE TABLE for one table with a
// different shape silently breaks every write for whichever module loses the race — that exact fault
// cost this project four months of unsent messages, and it is not being reintroduced for a calendar.
//
// WHAT IS HERE THAT IS NOT THERE: the questions LEAVE has to ask, which attendance.ts never needed.
// "Is the 26th a holiday for this person?" and "how many of these nine days actually come out of
// their allowance?" are the difference between a leave balance that is right and one that quietly
// overcharges everybody whose trip spans a public holiday.
//
// =================================================================================================
// WHAT A LOCATION CAN AND CANNOT DECIDE — READ THIS BEFORE CHANGING observedHolidays()
// =================================================================================================
//
// hr_holidays.location is a free-text place name, because there is no office, site or location
// register in this product to point at, and hr_employees HAS NO LOCATION COLUMN. So this codebase
// cannot answer "is this person at the place this holiday applies to". It must not pretend to.
//
// THE RULE, and it is deliberately the cautious one:
//
//   - A holiday with NO location is observed by everyone in its department scope.
//   - A holiday WITH a location is observed only when the caller asks about that same location.
//     An employee screen has no location to pass, so a regional holiday NEVER silently removes a day
//     from somebody's leave balance on the strength of a place nobody recorded them at. It is shown
//     on the calendar, labelled with where it applies, and a person can see it.
//   - An OPTIONAL (restricted) holiday is never observed automatically either way. That matches what
//     src/lib/attendance.ts already does in weeklyTimesheet(), where an optional holiday leaves the
//     day a working day.
//
// TO MAKE A REGIONAL HOLIDAY COUNT, SCOPE IT TO A DEPARTMENT as well as a location. Department is a
// relationship this product actually records, so it is the one that can decide anything.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. `r.rows[0]` is always a bug here.
//   - The real Postgres reason is on `e.cause`.
//   - department ids are compared as TEXT, never cast ::uuid — departments.id is a varchar slug in
//     src/lib/db/schema.ts and a UUID in db/hr-schema.sql.
//   - Every const is declared above the function that reads it.
//   - Readers fail closed to "no holidays", which charges leave normally. The opposite failure would
//     hand out free days nobody granted.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureAttendanceSchema, ensureWorkingTimeSchema } from './attendance-schema';
import {
  addHoliday,
  removeHoliday,
  listHolidays,
  dateRange,
  isoWeekday,
  shiftDateIso,
  type Holiday,
} from './attendance';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[holidays] ' + tag, e?.cause?.message || e?.message);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

/** No page may pull more than this many holiday rows at once. A year has nowhere near it. */
const LIST_LIMIT = 300;

/** The widest span any single reader will scan. Two years of dates is already an unusual question. */
const MAX_SPAN_DAYS = 800;

/** Who a holiday question is being asked on behalf of. Every field optional; all of them narrow. */
export interface HolidayScope {
  /** hr_employees.department_id, as TEXT. Org-wide holidays are always included. */
  departmentId?: string | null;
  /** A place name. Only holidays with no location, or exactly this one, are OBSERVED. */
  location?: string | null;
  /** Include optional (restricted) holidays in the list. They are never OBSERVED regardless. */
  includeOptional?: boolean;
}

function mapRow(row: any): Holiday {
  return {
    id: String(row?.id ?? ''),
    dateIso: row?.holiday_date ? String(row.holiday_date).slice(0, 10) : '',
    name: String(row?.name ?? ''),
    departmentId: row?.department_id ? String(row.department_id) : null,
    departmentName: row?.department_name ? String(row.department_name) : null,
    location: row?.location ? String(row.location) : null,
    isOptional: row?.is_optional === true,
  };
}

/** The calendar year a 'YYYY-MM-DD' falls in, or the current year when it will not parse. */
export function yearOf(dateIso: string): number {
  return isDateIso(dateIso) ? Number(dateIso.slice(0, 4)) : new Date().getFullYear();
}

/** 'YYYY-01-01' and 'YYYY-12-31' for a year, clamped to something sane. */
export function yearBounds(year: number): { from: string; to: string } {
  const y = Math.min(Math.max(Math.round(Number(year) || new Date().getFullYear()), 1970), 2999);
  return { from: y + '-01-01', to: y + '-12-31' };
}

/**
 * Every holiday between two dates that is in scope for this caller.
 *
 * IN SCOPE IS NOT THE SAME AS OBSERVED. This returns the rows a person should SEE — including
 * regional and optional ones, so the calendar can show them and say what they are. observedDates()
 * below is the narrower question that decides whether a day comes out of an allowance.
 */
export async function holidaysBetween(
  from: string,
  to: string,
  scope: HolidayScope = {},
): Promise<Holiday[]> {
  return (await readHolidays(from, to, scope)).list;
}

/**
 * THE SAME READ, SAYING WHETHER IT WORKED.
 *
 * holidaysBetween() catches its own errors and returns [], so a FAILED read and a company with no
 * holidays are the same observable fact. That tolerance is right for a calendar — a broken read must
 * not blank a screen — and wrong for money: applyLeave() then charges the public holiday to somebody's
 * allowance and hands back an EMPTY `excluded` list, so the confirmation says nothing was skipped and
 * neither the person nor HR can tell it from correct behaviour without reading the server log.
 * src/lib/payroll.ts, faced with the same class of failure, pushes to `gaps` and says so on the
 * payslip. This is how a caller that is about to charge somebody can do the same.
 *
 * `ok: false` means UNKNOWN, never "none".
 */
export async function readHolidays(
  from: string,
  to: string,
  scope: HolidayScope = {},
): Promise<{ ok: boolean; list: Holiday[]; error?: string }> {
  if (!isDateIso(from) || !isDateIso(to) || to < from) return { ok: true, list: [] };
  const dept = scope.departmentId ? String(scope.departmentId).trim() : '';
  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();
    const deptScope = dept
      ? sql`AND (h.department_id IS NULL OR h.department_id::text = ${dept}::text)`
      : sql``;
    const optionalScope = scope.includeOptional === false ? sql`AND h.is_optional = FALSE` : sql``;
    const r = await db.execute(sql`
      SELECT h.id, h.holiday_date, h.name, h.department_id::text AS department_id,
             h.location, h.is_optional, d.name AS department_name
        FROM hr_holidays h
        LEFT JOIN departments d ON d.id::text = h.department_id::text
       WHERE h.holiday_date >= ${from}::date
         AND h.holiday_date <= ${to}::date
         ${deptScope}
         ${optionalScope}
       ORDER BY h.holiday_date ASC, h.name ASC
       LIMIT ${LIST_LIMIT}`);
    return { ok: true, list: rows(r).map(mapRow) };
  } catch (e: any) {
    logFail('holidaysBetween', e);
    return { ok: false, list: [], error: String(e?.cause?.message || e?.message || 'the holiday calendar could not be read') };
  }
}

/** One calendar year of holidays, for the calendar screen. */
export async function holidaysInYear(year: number, scope: HolidayScope = {}): Promise<Holiday[]> {
  const b = yearBounds(year);
  return holidaysBetween(b.from, b.to, scope);
}

/**
 * Does this holiday actually take the day off THIS caller?
 *
 * PURE, and the single expression of the rule described in this file's header. Everything that needs
 * to know "does this day still come out of my leave" asks this, so the calendar, the balance
 * arithmetic and the attendance writer cannot drift apart.
 */
export function isObserved(holiday: Holiday, scope: HolidayScope = {}): boolean {
  if (!holiday || !holiday.dateIso) return false;
  // An optional (restricted) holiday is a day somebody MAY take, not one they are given. It stays a
  // working day until they ask for it, which is exactly what weeklyTimesheet() already assumes.
  if (holiday.isOptional) return false;
  if (!holiday.location) return true;
  const asked = String(scope.location || '').trim().toLowerCase();
  return asked.length > 0 && asked === holiday.location.trim().toLowerCase();
}

/**
 * The dates in a range that are genuinely non-working holidays for this caller, mapped to the
 * holiday that made them so.
 *
 * A Map rather than a Set because every caller that has this question also has to SAY WHY on screen:
 * "the 26th is Republic Day, so it did not come out of your leave" is a sentence a person can check,
 * and "8 days instead of 9" on its own is one they cannot.
 */
export async function observedDates(
  from: string,
  to: string,
  scope: HolidayScope = {},
): Promise<Map<string, Holiday>> {
  return (await observedDatesResult(from, to, scope)).map;
}

/**
 * The same answer, carrying whether the calendar could actually be read. See readHolidays() for why
 * "no holidays" and "we could not tell" must not be the same value to a caller about to charge
 * somebody a day of their allowance.
 */
export async function observedDatesResult(
  from: string,
  to: string,
  scope: HolidayScope = {},
): Promise<{ ok: boolean; map: Map<string, Holiday>; error?: string }> {
  const out = new Map<string, Holiday>();
  const read = await readHolidays(from, to, scope);
  for (const h of read.list) {
    if (!h.dateIso || out.has(h.dateIso)) continue;
    if (isObserved(h, scope)) out.set(h.dateIso, h);
  }
  return { ok: read.ok, map: out, error: read.error };
}

/** Is one specific day a holiday for this caller? Null when the date will not parse. */
export async function isHolidayOn(dateIso: string, scope: HolidayScope = {}): Promise<Holiday | null> {
  if (!isDateIso(dateIso)) return null;
  const map = await observedDates(dateIso, dateIso, scope);
  return map.get(dateIso) || null;
}

/** What a span of dates costs somebody, once the holidays in it are taken out. */
export interface LeaveSpan {
  from: string;
  to: string;
  /** Every day in the range, inclusive of both ends. */
  calendarDays: number;
  /** Days removed because they are observed holidays. */
  holidayDays: number;
  /** Days removed because they fall on a weekly off (only when weeklyOffDays is supplied). */
  weeklyOffDays: number;
  /** What actually comes out of the allowance. Never negative. */
  chargeableDays: number;
  /** The dates that were removed, and why — for a sentence on screen. */
  excluded: Array<{ dateIso: string; reason: string }>;
  /**
   * THE HOLIDAY CALENDAR COULD NOT BE READ, so `holidayDays` is 0 because nothing is KNOWN and not
   * because nothing is there.
   *
   * A caller that merely displays this can ignore it. A caller about to CHARGE somebody must not:
   * charging the full span here takes a public holiday out of a person's allowance and reports an
   * empty `excluded` list, which reads exactly like correct behaviour. src/lib/hr-leave.ts
   * applyLeave() refuses on this rather than guessing, the same way it refuses when the balance
   * itself could not be read.
   */
  holidayReadFailed: boolean;
}

/**
 * WHAT A LEAVE REQUEST ACTUALLY COSTS.
 *
 * The one piece of arithmetic that must not exist twice: applyLeave() charges the balance with it,
 * markLeaveAttendance() decides which days to stamp with it, and the leave screen shows the person
 * the same number before they commit. A second copy anywhere would be a balance that disagrees with
 * the days recorded against it, and nobody would be able to say which was right.
 *
 * WEEKLY OFFS ARE OPT-IN, and that is deliberate. hr_leave_request has always counted CALENDAR days
 * (daysBetween in src/lib/hr-leave.ts), so every balance already in the database was computed that
 * way. Passing weeklyOffDays changes the answer for the caller that asks, and callers that do not
 * pass it keep the behaviour every existing row was written under. Silently switching every request
 * to working days would rewrite what "12 casual days" has meant here since the module was written.
 */
export async function leaveSpan(
  from: string,
  to: string,
  scope: HolidayScope = {},
  weeklyOffDays: number[] = [],
): Promise<LeaveSpan> {
  const empty: LeaveSpan = {
    from,
    to,
    calendarDays: 0,
    holidayDays: 0,
    weeklyOffDays: 0,
    chargeableDays: 0,
    excluded: [],
    holidayReadFailed: false,
  };
  if (!isDateIso(from) || !isDateIso(to) || to < from) return empty;

  const dates = dateRange(from, to, MAX_SPAN_DAYS);
  if (!dates.length) return empty;

  const offs = new Set(
    (weeklyOffDays || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
  );
  const read = await observedDatesResult(from, to, scope);
  const holidays = read.map;

  const excluded: Array<{ dateIso: string; reason: string }> = [];
  let holidayDays = 0;
  let offDays = 0;

  for (const d of dates) {
    const h = holidays.get(d);
    if (h) {
      holidayDays++;
      excluded.push({ dateIso: d, reason: h.name });
      continue;
    }
    const wd = isoWeekday(d);
    if (wd && offs.has(wd)) {
      offDays++;
      excluded.push({ dateIso: d, reason: 'Weekly off' });
    }
  }

  return {
    from,
    to,
    calendarDays: dates.length,
    holidayDays,
    weeklyOffDays: offDays,
    chargeableDays: Math.max(0, dates.length - holidayDays - offDays),
    excluded,
    holidayReadFailed: !read.ok,
  };
}

/**
 * The distinct place names already used on holidays, for a pick list rather than a free-text box
 * that grows six spellings of one city.
 */
export async function holidayLocations(): Promise<string[]> {
  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      SELECT DISTINCT location FROM hr_holidays
       WHERE location IS NOT NULL AND length(trim(location)) > 0
       ORDER BY location ASC
       LIMIT 100`);
    return rows(r).map((row: any) => String(row.location)).filter(Boolean);
  } catch (e: any) {
    logFail('holidayLocations', e);
    return [];
  }
}

/** The years that already have holidays recorded, newest first, so a screen can offer them. */
export async function holidayYears(): Promise<number[]> {
  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      SELECT DISTINCT EXTRACT(YEAR FROM holiday_date)::int AS y
        FROM hr_holidays ORDER BY y DESC LIMIT 30`);
    return rows(r).map((row: any) => Number(row.y)).filter((n) => Number.isInteger(n));
  } catch (e: any) {
    logFail('holidayYears', e);
    return [];
  }
}

/** The next few holidays from a date, for a card on somebody's own screen. */
export async function upcomingHolidays(
  fromIso: string,
  scope: HolidayScope = {},
  days = 60,
): Promise<Holiday[]> {
  if (!isDateIso(fromIso)) return [];
  const span = Math.min(Math.max(Number(days) || 60, 1), MAX_SPAN_DAYS);
  return holidaysBetween(fromIso, shiftDateIso(fromIso, span), scope);
}

// -------------------------------------------------------------------------------------------------
// THE WRITERS ARE src/lib/attendance.ts's. Re-exported so a screen has one import site, NOT
// reimplemented — there is one hr_holidays table and it has one writer.
// -------------------------------------------------------------------------------------------------
export { addHoliday, removeHoliday, listHolidays };
export type { Holiday };
