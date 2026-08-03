// src/lib/attendance.ts — THE ATTENDANCE ENGINE. Punches, timesheets, shifts, rosters, holidays,
// geo/QR evidence, and correction requests.
//
// =================================================================================================
// WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT
// =================================================================================================
//
//   OWNS      the punch state machine, the day computation, the weekly timesheet, shift and roster
//             definition, the holiday list, QR stations, and the FACTS of a correction request.
//
//   DOES NOT  decide an approval. A correction is routed and decided by src/lib/workflow.ts
//             (domain 'attendance', which already exists there: one rung, the reporting manager,
//             resolved from the organization graph). This file starts the workflow and, once the
//             engine says approved, writes the corrected numbers into hr_attendance. It contains no
//             approve() function, no status column of its own, and no way for a request to become
//             approved without the engine saying so.
//
//   DOES NOT  answer "who is this person's manager". src/lib/org-graph.ts does, and the workflow
//             engine asks it. Nothing here reads users.role, and nothing here falls back to a role
//             name when the graph is empty — when routing cannot name an approver the request
//             HALTS with a readable sentence and the screen says so.
//
// =================================================================================================
// AUTOMATED SIGNALS ARE ADVISORY. A HUMAN DECIDES. NO EXCEPTION.
// =================================================================================================
//
// A location fix and a scanned code are EVIDENCE recorded beside a punch. This file:
//   - never refuses a punch because of where the phone thought it was,
//   - never refuses a punch because a scanned code was not recognised,
//   - never writes an 'invalid', 'suspicious' or 'rejected' marker anywhere,
//   - computes a distance and phrases it as a SENTENCE for a person to read.
// GPS indoors is routinely wrong by hundreds of metres. A rule that turned that into a lost day's
// pay would be a real harm caused by a number nobody checked, which is why the harm is prevented in
// the DATA MODEL (there is no verdict column to filter on) and not only in the UI.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. rows() normalises; `r.rows[0]` is always a bug here.
//   - The real Postgres reason is `e.cause.message`; `e.message` is only the failed SQL.
//   - NO EXCEPTION IS SWALLOWED IN A WRITE PATH. Every writer returns { ok: false, error } carrying
//     the real reason. A punch that silently did nothing is worse than one that says why it did not.
//   - Every const is declared before the function that reads it.
//   - department ids are compared as TEXT, never cast ::uuid.
//   - TODAY COMES FROM POSTGRES (CURRENT_DATE), never from `new Date()` in the render process. The
//     two disagree by a day whenever the process timezone and the session timezone differ, and
//     "did I clock in today" is exactly the claim that must not be off by one.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureAttendanceSchema } from './attendance-schema';
import { startWorkflow, instanceForRecord, type WorkflowInstanceRow } from './workflow';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — all above their first use.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[attendance] ' + tag, e?.cause?.message || e?.message);

const errText = (e: any, fallback: string) =>
  String(e?.cause?.message || e?.message || fallback).slice(0, 400);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

/** The four things a punch can be. Values of hr_clock_events.event_type, which already exist. */
export const PUNCH_KINDS = ['clock_in', 'break_start', 'break_end', 'clock_out'] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];

const PUNCH_SET = new Set<string>(PUNCH_KINDS);
export function isPunchKind(v: unknown): v is PunchKind {
  return typeof v === 'string' && PUNCH_SET.has(v);
}

export const PUNCH_LABELS: Record<PunchKind, string> = {
  clock_in: 'Check in',
  break_start: 'Start break',
  break_end: 'End break',
  clock_out: 'Check out',
};

/** hr_attendance.status values already in use across the product. */
export const ATTENDANCE_STATUSES = ['present', 'wfh', 'on_leave', 'absent', 'holiday'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  wfh: 'Working from home',
  on_leave: 'On leave',
  absent: 'Absent',
  holiday: 'Holiday',
};

/** Written into hr_clock_events.work_mode and hr_attendance.work_mode. */
export const WORK_MODES = ['remote', 'onsite', 'hybrid'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

/**
 * A correction may only be asked for about a day inside this window.
 *
 * Not a policy invented here so much as a guard: without it, a single request could reach back
 * three years and rewrite a month that has already been paid. Sixty days is long enough to cover a
 * missed punch noticed at the end of a pay cycle, and short enough that a settled payroll is not
 * quietly re-openable from a phone.
 */
export const CORRECTION_WINDOW_DAYS = 60;

/** Nobody works more than this in one recorded day. A punch pair beyond it is a stuck clock. */
const MAX_DAY_MINUTES = 20 * 60;

/** How many rows any list reader will return, so one page load cannot pull a year of history. */
const LIST_LIMIT = 200;

/** Earth's mean radius in metres, for the distance sentence. */
const EARTH_RADIUS_M = 6371000;

// -------------------------------------------------------------------------------------------------
// PURE HELPERS. No database. Exported because the pages render from them and a second copy of
// "how many hours is that" would drift within a month.
// -------------------------------------------------------------------------------------------------

/** '09:30' from 570. Minutes past midnight; values past 1440 wrap, which is what a night shift does. */
export function minuteToHm(minute: number): string {
  const m = ((Math.round(Number(minute)) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** 570 from '09:30'. Returns null on anything unparseable rather than guessing midnight. */
export function hmToMinute(hm: unknown): number | null {
  const s = String(hm || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!isFinite(h) || !isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** Hours, to one decimal, from minutes. */
export function minutesToHours(minutes: number): number {
  const m = Number(minutes);
  if (!isFinite(m) || m <= 0) return 0;
  return Math.round((m / 60) * 10) / 10;
}

/** '7h 20m' from 440. Empty string for nothing, never '0h 0m' — a blank cell reads better. */
export function formatMinutes(minutes: number): string {
  const m = Math.round(Number(minutes));
  if (!isFinite(m) || m <= 0) return '';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h && mm) return h + 'h ' + mm + 'm';
  if (h) return h + 'h';
  return mm + 'm';
}

/** ISO weekday, 1 = Monday .. 7 = Sunday, from 'YYYY-MM-DD'. Null when the string is not a date. */
export function isoWeekday(dateIso: string): number | null {
  if (!isDateIso(dateIso)) return null;
  const d = new Date(dateIso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const js = d.getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** 'Monday' from 'YYYY-MM-DD'. Empty string when the date will not parse. */
export function weekdayName(dateIso: string): string {
  const n = isoWeekday(dateIso);
  return n ? WEEKDAY_NAMES[n - 1] : '';
}

/** The Monday of the week containing this date. Returns the input unchanged if it will not parse. */
export function weekStartIso(dateIso: string): string {
  const wd = isoWeekday(dateIso);
  if (!wd) return dateIso;
  return shiftDateIso(dateIso, -(wd - 1));
}

/** Add (or subtract) whole days to a 'YYYY-MM-DD'. UTC arithmetic, so no daylight-saving surprises. */
export function shiftDateIso(dateIso: string, days: number): string {
  if (!isDateIso(dateIso)) return dateIso;
  const d = new Date(dateIso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateIso;
  d.setUTCDate(d.getUTCDate() + Math.round(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

/** Every date from `from` to `to` inclusive, capped so a mistyped range cannot build a million rows. */
export function dateRange(from: string, to: string, cap = 400): string[] {
  if (!isDateIso(from) || !isDateIso(to)) return [];
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < cap; i++) {
    out.push(cur);
    if (cur >= to) break;
    cur = shiftDateIso(cur, 1);
  }
  return out;
}

/** Whole days between two ISO dates, `to - from`. Null when either will not parse. */
export function daysBetweenIso(from: string, to: string): number | null {
  if (!isDateIso(from) || !isDateIso(to)) return null;
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Metres between two coordinates. Used only to phrase a sentence a person reads. */
export function haversineMetres(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number | null {
  const ns = [lat1, lon1, lat2, lon2].map(Number);
  if (ns.some((n) => !isFinite(n))) return null;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(ns[2] - ns[0]);
  const dLon = toRad(ns[3] - ns[1]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(ns[0])) * Math.cos(toRad(ns[2])) * Math.sin(dLon / 2) ** 2;
  return Math.round(EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** One punch, as the day computation sees it. */
export interface PunchEvent {
  kind: string;
  at: string;
}

/** What a day of punches adds up to. */
export interface DayTotals {
  clockIn: string | null;
  clockOut: string | null;
  breakMinutes: number;
  workedMinutes: number;
  /** True while a break is open — the person is on a break right now. */
  onBreak: boolean;
  /** True when there is a clock_in with no clock_out yet. */
  open: boolean;
}

/**
 * Fold a day's punches into totals. PURE, and the only place this arithmetic exists.
 *
 * Written to survive a messy log rather than to assume a tidy one, because the log IS messy: a phone
 * loses signal mid-punch, somebody taps twice, a break is started and never ended before the person
 * goes home.
 *
 *   - The FIRST clock_in and the LAST clock_out bound the day. A second clock_in after a clock_out
 *     (came back after lunch and re-checked-in) extends nothing and loses nothing.
 *   - A break with no end is closed at clock_out, or left open if the day is still open. An
 *     un-ended break must never silently count as worked time; it must also never swallow the whole
 *     day, which is why it is bounded by the clock_out.
 *   - Worked time is the span minus closed breaks, floored at zero and capped at MAX_DAY_MINUTES.
 *     A clock stuck open for three days would otherwise report 72 hours onto somebody's timesheet.
 */
export function computeDay(events: PunchEvent[]): DayTotals {
  const sorted = (events || [])
    .filter((e) => e && isPunchKind(e.kind) && e.at)
    .map((e) => ({ kind: e.kind as PunchKind, ms: Date.parse(e.at), at: e.at }))
    .filter((e) => !isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms);

  let firstIn: number | null = null;
  let lastOut: number | null = null;
  let breakOpen: number | null = null;
  let breakMs = 0;

  for (const e of sorted) {
    if (e.kind === 'clock_in') {
      if (firstIn === null) firstIn = e.ms;
    } else if (e.kind === 'clock_out') {
      lastOut = e.ms;
      if (breakOpen !== null) {
        breakMs += Math.max(0, e.ms - breakOpen);
        breakOpen = null;
      }
    } else if (e.kind === 'break_start') {
      if (breakOpen === null) breakOpen = e.ms;
    } else if (e.kind === 'break_end') {
      if (breakOpen !== null) {
        breakMs += Math.max(0, e.ms - breakOpen);
        breakOpen = null;
      }
    }
  }

  const open = firstIn !== null && (lastOut === null || lastOut < firstIn);
  const spanEnd = lastOut !== null && firstIn !== null && lastOut > firstIn ? lastOut : null;
  const spanMs = firstIn !== null && spanEnd !== null ? spanEnd - firstIn : 0;
  const breakMinutes = Math.round(breakMs / 60000);
  const rawWorked = Math.round(spanMs / 60000) - breakMinutes;
  const workedMinutes = Math.max(0, Math.min(MAX_DAY_MINUTES, rawWorked));

  return {
    clockIn: firstIn !== null ? new Date(firstIn).toISOString() : null,
    clockOut: spanEnd !== null ? new Date(spanEnd).toISOString() : null,
    breakMinutes,
    workedMinutes,
    onBreak: breakOpen !== null,
    open,
  };
}

/**
 * Which punches make sense next, given where the day has got to.
 *
 * PURE, and the reason the buttons on screen are never a lie: the page renders exactly this list, so
 * a person is never offered "End break" when no break is running. The write path re-checks the same
 * rule, because a rendered button is not an authorisation.
 */
export function allowedPunches(totals: DayTotals): PunchKind[] {
  if (!totals.open && !totals.clockIn) return ['clock_in'];
  if (!totals.open) return ['clock_in']; // checked out already; a second stint starts a new check-in
  if (totals.onBreak) return ['break_end', 'clock_out'];
  return ['break_start', 'clock_out'];
}

/** Why a punch was refused, in words. Empty string when it is allowed. */
export function punchRefusal(kind: PunchKind, totals: DayTotals): string {
  if (allowedPunches(totals).includes(kind)) return '';
  if (kind === 'clock_in') return 'You are already checked in for today.';
  if (kind === 'clock_out') return 'You are not checked in, so there is nothing to check out of.';
  if (kind === 'break_start') {
    return totals.onBreak
      ? 'You are already on a break.'
      : 'Check in first — a break is time away from a day that has started.';
  }
  return totals.open ? 'No break is running.' : 'You are not checked in.';
}

// -------------------------------------------------------------------------------------------------
// TODAY, AS POSTGRES COUNTS IT
// -------------------------------------------------------------------------------------------------

/**
 * CURRENT_DATE from the database. Null when the read did not happen.
 *
 * NULL IS NOT "GUESS". A caller that gets null must not render a day-partitioned claim; the pages
 * here say so rather than showing yesterday's punches under today's heading.
 */
export async function today(): Promise<string | null> {
  try {
    const r = await db.execute(sql`SELECT CURRENT_DATE::text AS d`);
    const list = rows(r);
    const d = list.length ? String(list[0].d || '') : '';
    return isDateIso(d) ? d : null;
  } catch (e: any) {
    logFail('today', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// SHIFTS
// -------------------------------------------------------------------------------------------------

export interface Shift {
  id: string;
  name: string;
  code: string | null;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  graceMinutes: number;
  /** ISO weekday numbers, 1 = Monday. */
  workingDays: number[];
  isActive: boolean;
  note: string | null;
}

function parseWorkingDays(raw: unknown): number[] {
  return String(raw || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
}

function mapShift(row: any): Shift {
  return {
    id: String(row?.id ?? ''),
    name: String(row?.name ?? ''),
    code: row?.code ? String(row.code) : null,
    startMinute: Number(row?.start_minute) || 0,
    endMinute: Number(row?.end_minute) || 0,
    breakMinutes: Number(row?.break_minutes) || 0,
    graceMinutes: Number(row?.grace_minutes) || 0,
    workingDays: parseWorkingDays(row?.working_days),
    isActive: row?.is_active !== false,
    note: row?.note ? String(row.note) : null,
  };
}

/** The scheduled minutes a shift expects on a working day, breaks excluded. */
export function shiftExpectedMinutes(shift: Shift | null): number {
  if (!shift) return 0;
  const span =
    shift.endMinute > shift.startMinute
      ? shift.endMinute - shift.startMinute
      : 1440 - shift.startMinute + shift.endMinute; // crosses midnight
  return Math.max(0, span - shift.breakMinutes);
}

/** 'Day shift, 09:00 to 18:00' — one line, for a cell on a phone. */
export function shiftSummary(shift: Shift | null): string {
  if (!shift) return '';
  return shift.name + ', ' + minuteToHm(shift.startMinute) + ' to ' + minuteToHm(shift.endMinute);
}

export async function listShifts(opts: { includeInactive?: boolean } = {}): Promise<Shift[]> {
  try {
    await ensureAttendanceSchema();
    const activeOnly = opts.includeInactive ? sql`` : sql`WHERE is_active = TRUE`;
    const r = await db.execute(sql`
      SELECT id, name, code, start_minute, end_minute, break_minutes, grace_minutes,
             working_days, is_active, note
        FROM hr_shifts ${activeOnly}
       ORDER BY is_active DESC, name ASC
       LIMIT ${LIST_LIMIT}`);
    return rows(r).map(mapShift);
  } catch (e: any) {
    logFail('listShifts', e);
    return [];
  }
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
}

export interface CreateShiftInput {
  name: string;
  code?: string | null;
  startMinute: number;
  endMinute: number;
  breakMinutes?: number;
  graceMinutes?: number;
  workingDays?: number[];
  note?: string | null;
  createdByUserId?: string | null;
}

/** Define a shift. Refuses rather than guesses; the error is a sentence for a person. */
export async function createShift(input: CreateShiftInput): Promise<WriteResult> {
  const name = String(input?.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'A shift needs a name.' };
  const start = Number(input?.startMinute);
  const end = Number(input?.endMinute);
  if (!Number.isInteger(start) || start < 0 || start > 1439) {
    return { ok: false, error: 'The start time is not a time of day.' };
  }
  if (!Number.isInteger(end) || end < 0 || end > 1439) {
    return { ok: false, error: 'The end time is not a time of day.' };
  }
  if (start === end) return { ok: false, error: 'A shift cannot start and end at the same minute.' };
  const brk = Number.isInteger(input?.breakMinutes) ? Number(input?.breakMinutes) : 60;
  const grace = Number.isInteger(input?.graceMinutes) ? Number(input?.graceMinutes) : 15;
  if (brk < 0 || brk > 480) return { ok: false, error: 'The break must be between 0 and 480 minutes.' };
  if (grace < 0 || grace > 180) return { ok: false, error: 'The grace period must be between 0 and 180 minutes.' };
  const days = (input?.workingDays || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (!days.length) return { ok: false, error: 'Choose at least one working day.' };
  const code = input?.code ? String(input.code).trim().slice(0, 40) : null;
  const note = input?.note ? String(input.note).slice(0, 500) : null;
  const by = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_shifts
        (name, code, start_minute, end_minute, break_minutes, grace_minutes, working_days, note, created_by)
      VALUES
        (${name}, ${code}, ${start}, ${end}, ${brk}, ${grace},
         ${[...new Set(days)].sort().join(',')}, ${note}, ${by}::uuid)
      RETURNING id`);
    const list = rows(r);
    return list.length
      ? { ok: true, id: String(list[0].id), changed: true }
      : { ok: false, error: 'The shift was not saved and the database did not say why.' };
  } catch (e: any) {
    logFail('createShift', e);
    return { ok: false, error: errText(e, 'The shift could not be saved.') };
  }
}

/** Retire a shift. Existing roster rows keep pointing at it, so history keeps reading correctly. */
export async function retireShift(shiftId: string): Promise<WriteResult> {
  if (!isUuid(shiftId)) return { ok: false, error: 'That is not a shift id.' };
  try {
    await ensureAttendanceSchema();
    await db.execute(sql`UPDATE hr_shifts SET is_active = FALSE WHERE id = ${shiftId}::uuid`);
    return { ok: true, id: shiftId, changed: true };
  } catch (e: any) {
    logFail('retireShift', e);
    return { ok: false, error: errText(e, 'The shift could not be retired.') };
  }
}

// -------------------------------------------------------------------------------------------------
// ROSTER — which shift, and when that was true
// -------------------------------------------------------------------------------------------------

export interface RosterAssignment {
  id: string;
  employeeId: string;
  employeeName: string | null;
  shift: Shift | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

function mapRoster(row: any): RosterAssignment {
  return {
    id: String(row?.id ?? ''),
    employeeId: String(row?.employee_id ?? ''),
    employeeName: row?.employee_name ? String(row.employee_name) : null,
    shift: row?.shift_id ? mapShift({ ...row, id: row.shift_id }) : null,
    effectiveFrom: row?.effective_from ? String(row.effective_from).slice(0, 10) : '',
    effectiveTo: row?.effective_to ? String(row.effective_to).slice(0, 10) : null,
    note: row?.note ? String(row.note) : null,
  };
}

const ROSTER_COLS = sql`
  r.id, r.employee_id, r.effective_from, r.effective_to, r.note,
  e.full_name AS employee_name,
  s.id AS shift_id, s.name, s.code, s.start_minute, s.end_minute,
  s.break_minutes, s.grace_minutes, s.working_days, s.is_active`;

/**
 * The shift in force for one employee on one date, or null.
 *
 * Half-open on purpose: `effective_from <= d AND (effective_to IS NULL OR effective_to >= d)`. The
 * supersede below closes the old row the day BEFORE the new one starts, so there is no day on which
 * two rows answer and no day with a gap.
 */
export async function shiftOn(employeeId: string, dateIso: string): Promise<Shift | null> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return null;
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT s.id, s.name, s.code, s.start_minute, s.end_minute, s.break_minutes,
             s.grace_minutes, s.working_days, s.is_active, s.note
        FROM hr_roster_assignments r
        JOIN hr_shifts s ON s.id = r.shift_id
       WHERE r.employee_id = ${employeeId}::uuid
         AND r.effective_from <= ${dateIso}::date
         AND (r.effective_to IS NULL OR r.effective_to >= ${dateIso}::date)
       ORDER BY r.effective_from DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapShift(list[0]) : null;
  } catch (e: any) {
    logFail('shiftOn', e);
    return null;
  }
}

/** Every roster row for one employee, newest first. */
export async function rosterFor(employeeId: string): Promise<RosterAssignment[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT ${ROSTER_COLS}
        FROM hr_roster_assignments r
        JOIN hr_shifts s ON s.id = r.shift_id
        LEFT JOIN hr_employees e ON e.id = r.employee_id
       WHERE r.employee_id = ${employeeId}::uuid
       ORDER BY r.effective_from DESC
       LIMIT ${LIST_LIMIT}`);
    return rows(r).map(mapRoster);
  } catch (e: any) {
    logFail('rosterFor', e);
    return [];
  }
}

/** The open roster row for every active employee, for the roster board. */
export async function currentRoster(limit = 100): Promise<RosterAssignment[]> {
  const n = Math.min(Math.max(Number(limit) || 100, 1), LIST_LIMIT);
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT ${ROSTER_COLS}
        FROM hr_roster_assignments r
        JOIN hr_shifts s ON s.id = r.shift_id
        LEFT JOIN hr_employees e ON e.id = r.employee_id
       WHERE r.effective_to IS NULL
       ORDER BY e.full_name ASC NULLS LAST
       LIMIT ${n}`);
    return rows(r).map(mapRoster);
  } catch (e: any) {
    logFail('currentRoster', e);
    return [];
  }
}

/** Active employees with no open roster row. The number that stops a roster board from lying. */
export async function unrosteredCount(): Promise<number | null> {
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM hr_employees e
       WHERE e.is_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM hr_roster_assignments r
            WHERE r.employee_id = e.id AND r.effective_to IS NULL)`);
    const list = rows(r);
    return list.length ? Number(list[0].n) || 0 : null;
  } catch (e: any) {
    logFail('unrosteredCount', e);
    return null;
  }
}

/**
 * Put an employee on a shift from a date.
 *
 * ONE STATEMENT, via a data-modifying CTE, for the same reason supersedeReportingManager() uses one:
 * two statements can half-succeed, and an UPDATE that committed before a failed INSERT would leave
 * the person rostered on NOTHING while every screen quietly reported no expectation for their hours.
 *
 * The old row is closed the day BEFORE the new one starts, so the two never both answer for a day.
 */
export async function assignShift(input: {
  employeeId: string;
  shiftId: string;
  effectiveFrom: string;
  note?: string | null;
  createdByUserId?: string | null;
}): Promise<WriteResult> {
  const employeeId = String(input?.employeeId || '');
  const shiftId = String(input?.shiftId || '');
  const from = String(input?.effectiveFrom || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  if (!isUuid(shiftId)) return { ok: false, error: 'Choose a shift.' };
  if (!isDateIso(from)) return { ok: false, error: 'The start date is not a date.' };
  const note = input?.note ? String(input.note).slice(0, 500) : null;
  const by = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;
  const dayBefore = shiftDateIso(from, -1);

  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      WITH closed AS (
        UPDATE hr_roster_assignments
           SET effective_to = ${dayBefore}::date
         WHERE employee_id = ${employeeId}::uuid
           AND effective_to IS NULL
           AND effective_from <= ${dayBefore}::date
        RETURNING id
      ), superseded AS (
        -- A row that starts ON or AFTER the new one has never been in force for a past day: either
        -- it was typed a moment ago and is being corrected, or it is a future assignment being
        -- replaced. Either way it must stop answering, and the partial unique index allows only ONE
        -- open row per person, so it cannot simply be left alone.
        --
        -- IT IS CLOSED TO THE DAY BEFORE ITS OWN START, which makes effective_to < effective_from --
        -- an EMPTY range, deliberately. shiftOn() asks effective_from <= d AND effective_to >= d,
        -- which no date can satisfy, so the row is in force on no day at all while still being kept
        -- as a record that somebody entered it. Closing it to its own start date instead would leave
        -- it answering for exactly one day, tied with the new row, and the tie-break would decide
        -- somebody's shift by accident.
        UPDATE hr_roster_assignments
           SET effective_to = effective_from - 1
         WHERE employee_id = ${employeeId}::uuid
           AND effective_to IS NULL
           AND effective_from > ${dayBefore}::date
        RETURNING id
      )
      INSERT INTO hr_roster_assignments (employee_id, shift_id, effective_from, note, created_by)
      SELECT ${employeeId}::uuid, ${shiftId}::uuid, ${from}::date, ${note}, ${by}::uuid
      RETURNING id`);
    const list = rows(r);
    return list.length
      ? { ok: true, id: String(list[0].id), changed: true }
      : { ok: false, error: 'The roster change was not saved and the database did not say why.' };
  } catch (e: any) {
    logFail('assignShift', e);
    return { ok: false, error: errText(e, 'The roster change could not be saved.') };
  }
}

// -------------------------------------------------------------------------------------------------
// HOLIDAYS
// -------------------------------------------------------------------------------------------------

export interface Holiday {
  id: string;
  dateIso: string;
  name: string;
  /** Null means the whole organization. TEXT, never cast ::uuid. */
  departmentId: string | null;
  departmentName: string | null;
  isOptional: boolean;
}

function mapHoliday(row: any): Holiday {
  return {
    id: String(row?.id ?? ''),
    dateIso: row?.holiday_date ? String(row.holiday_date).slice(0, 10) : '',
    name: String(row?.name ?? ''),
    departmentId: row?.department_id ? String(row.department_id) : null,
    departmentName: row?.department_name ? String(row.department_name) : null,
    isOptional: row?.is_optional === true,
  };
}

/**
 * Holidays between two dates.
 *
 * `departmentId` narrows to the organization-wide rows PLUS that department's own. Passing null
 * returns every row, which is what the holiday calendar and the definition screen want.
 * The comparison is ::text on both sides — departments.id is a slug in one schema file and a uuid
 * in the other.
 */
export async function listHolidays(
  from: string,
  to: string,
  departmentId?: string | null,
): Promise<Holiday[]> {
  if (!isDateIso(from) || !isDateIso(to)) return [];
  const dept = departmentId ? String(departmentId).trim() : '';
  try {
    await ensureAttendanceSchema();
    const scope = dept
      ? sql`AND (h.department_id IS NULL OR h.department_id::text = ${dept}::text)`
      : sql``;
    const r = await db.execute(sql`
      SELECT h.id, h.holiday_date, h.name, h.department_id::text AS department_id,
             h.is_optional, d.name AS department_name
        FROM hr_holidays h
        LEFT JOIN departments d ON d.id::text = h.department_id::text
       WHERE h.holiday_date >= ${from}::date
         AND h.holiday_date <= ${to}::date
         ${scope}
       ORDER BY h.holiday_date ASC, h.name ASC
       LIMIT ${LIST_LIMIT}`);
    return rows(r).map(mapHoliday);
  } catch (e: any) {
    logFail('listHolidays', e);
    return [];
  }
}

export async function addHoliday(input: {
  dateIso: string;
  name: string;
  departmentId?: string | null;
  isOptional?: boolean;
  createdByUserId?: string | null;
}): Promise<WriteResult> {
  const dateIso = String(input?.dateIso || '');
  const name = String(input?.name || '').trim().slice(0, 160);
  if (!isDateIso(dateIso)) return { ok: false, error: 'That is not a date.' };
  if (!name) return { ok: false, error: 'A holiday needs a name.' };
  const dept = input?.departmentId ? String(input.departmentId).trim().slice(0, 80) : null;
  const optional = input?.isOptional === true;
  const by = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_holidays (holiday_date, name, department_id, is_optional, created_by)
      VALUES (${dateIso}::date, ${name}, ${dept}::text, ${optional}, ${by}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const list = rows(r);
    // No returned row means that date already carries a holiday for that scope. Re-entering it is
    // not an error — it is somebody making sure, and the answer is "it is already there".
    return list.length
      ? { ok: true, id: String(list[0].id), changed: true }
      : { ok: true, changed: false };
  } catch (e: any) {
    logFail('addHoliday', e);
    return { ok: false, error: errText(e, 'The holiday could not be saved.') };
  }
}

export async function removeHoliday(holidayId: string): Promise<WriteResult> {
  if (!isUuid(holidayId)) return { ok: false, error: 'That is not a holiday id.' };
  try {
    await ensureAttendanceSchema();
    await db.execute(sql`DELETE FROM hr_holidays WHERE id = ${holidayId}::uuid`);
    return { ok: true, id: holidayId, changed: true };
  } catch (e: any) {
    logFail('removeHoliday', e);
    return { ok: false, error: errText(e, 'The holiday could not be removed.') };
  }
}

// -------------------------------------------------------------------------------------------------
// QR STATIONS — a code on a wall, and where that wall is
// -------------------------------------------------------------------------------------------------

export interface QrStation {
  id: string;
  code: string;
  label: string;
  lat: number | null;
  lon: number | null;
  radiusM: number;
  isActive: boolean;
}

function mapStation(row: any): QrStation {
  return {
    id: String(row?.id ?? ''),
    code: String(row?.code ?? ''),
    label: String(row?.label ?? ''),
    lat: row?.lat === null || row?.lat === undefined ? null : Number(row.lat),
    lon: row?.lon === null || row?.lon === undefined ? null : Number(row.lon),
    radiusM: Number(row?.radius_m) || 0,
    isActive: row?.is_active !== false,
  };
}

export async function listQrStations(): Promise<QrStation[]> {
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT id, code, label, lat, lon, radius_m, is_active
        FROM hr_attendance_qr_stations
       ORDER BY is_active DESC, label ASC
       LIMIT ${LIST_LIMIT}`);
    return rows(r).map(mapStation);
  } catch (e: any) {
    logFail('listQrStations', e);
    return [];
  }
}

/** The station a scanned code stands for, or null when the code is not one we know. */
export async function stationForCode(code: string): Promise<QrStation | null> {
  const c = String(code || '').trim().slice(0, 120);
  if (!c) return null;
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT id, code, label, lat, lon, radius_m, is_active
        FROM hr_attendance_qr_stations
       WHERE code = ${c} AND is_active = TRUE
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapStation(list[0]) : null;
  } catch (e: any) {
    logFail('stationForCode', e);
    return null;
  }
}

export async function createQrStation(input: {
  code: string;
  label: string;
  lat?: number | null;
  lon?: number | null;
  radiusM?: number;
  createdByUserId?: string | null;
}): Promise<WriteResult> {
  const code = String(input?.code || '').trim().slice(0, 120);
  const label = String(input?.label || '').trim().slice(0, 160);
  if (!code) return { ok: false, error: 'A station needs the code its QR encodes.' };
  if (!label) return { ok: false, error: 'A station needs a name people will recognise.' };
  const lat = input?.lat === null || input?.lat === undefined ? null : Number(input.lat);
  const lon = input?.lon === null || input?.lon === undefined ? null : Number(input.lon);
  if (lat !== null && (!isFinite(lat) || lat < -90 || lat > 90)) {
    return { ok: false, error: 'That latitude is not a point on Earth.' };
  }
  if (lon !== null && (!isFinite(lon) || lon < -180 || lon > 180)) {
    return { ok: false, error: 'That longitude is not a point on Earth.' };
  }
  const radius = Number.isInteger(input?.radiusM) ? Number(input?.radiusM) : 150;
  const by = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_attendance_qr_stations (code, label, lat, lon, radius_m, created_by)
      VALUES (${code}, ${label}, ${lat}, ${lon}, ${Math.max(0, radius)}, ${by}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const list = rows(r);
    return list.length
      ? { ok: true, id: String(list[0].id), changed: true }
      : { ok: false, error: 'A station already uses that code.' };
  } catch (e: any) {
    logFail('createQrStation', e);
    return { ok: false, error: errText(e, 'The station could not be saved.') };
  }
}

// -------------------------------------------------------------------------------------------------
// PUNCHES — the write path
// -------------------------------------------------------------------------------------------------

/** What a phone offered about a punch. Every field optional; none of it decides anything. */
export interface PunchEvidence {
  lat?: number | null;
  lon?: number | null;
  accuracy?: number | null;
  /** Whatever a QR scanner read. Recorded verbatim even when it matches no station. */
  qrCode?: string | null;
  workMode?: string | null;
  note?: string | null;
  ipAddress?: string | null;
  deviceInfo?: string | null;
}

export interface PunchResult extends WriteResult {
  /** The day after the punch, so a caller can re-render without a second read. */
  totals?: DayTotals;
  /**
   * A sentence about the evidence, for a person to read. ADVISORY: it never blocked anything and it
   * must never be rendered as a warning about the employee. Null when there is nothing to say.
   */
  advisory?: string | null;
}

/** Today's punches for one employee, oldest first. */
export async function punchesOn(employeeId: string, dateIso: string): Promise<PunchEvent[]> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return [];
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT event_type, event_time
        FROM hr_clock_events
       WHERE employee_id = ${employeeId}::uuid
         AND event_time >= ${dateIso}::date
         AND event_time < (${dateIso}::date + INTERVAL '1 day')
       ORDER BY event_time ASC
       LIMIT ${LIST_LIMIT}`);
    return rows(r).map((row: any) => ({
      kind: String(row?.event_type || ''),
      at: row?.event_time ? new Date(row.event_time).toISOString() : '',
    }));
  } catch (e: any) {
    logFail('punchesOn', e);
    return [];
  }
}

/** One punch with its evidence, for the day's log on screen. */
export interface PunchRow extends PunchEvent {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  locationName: string | null;
  stationLabel: string | null;
  qrCodeRaw: string | null;
  source: string | null;
}

export async function punchLog(employeeId: string, dateIso: string): Promise<PunchRow[]> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return [];
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT c.event_type, c.event_time, c.lat, c.lon, c.accuracy, c.location_name,
             c.qr_code_raw, c.source, s.label AS station_label
        FROM hr_clock_events c
        LEFT JOIN hr_attendance_qr_stations s ON s.id = c.qr_station_id
       WHERE c.employee_id = ${employeeId}::uuid
         AND c.event_time >= ${dateIso}::date
         AND c.event_time < (${dateIso}::date + INTERVAL '1 day')
       ORDER BY c.event_time ASC
       LIMIT ${LIST_LIMIT}`);
    return rows(r).map((row: any) => ({
      kind: String(row?.event_type || ''),
      at: row?.event_time ? new Date(row.event_time).toISOString() : '',
      lat: row?.lat === null || row?.lat === undefined ? null : Number(row.lat),
      lon: row?.lon === null || row?.lon === undefined ? null : Number(row.lon),
      accuracy: row?.accuracy === null || row?.accuracy === undefined ? null : Number(row.accuracy),
      locationName: row?.location_name ? String(row.location_name) : null,
      stationLabel: row?.station_label ? String(row.station_label) : null,
      qrCodeRaw: row?.qr_code_raw ? String(row.qr_code_raw) : null,
      source: row?.source ? String(row.source) : null,
    }));
  } catch (e: any) {
    logFail('punchLog', e);
    return [];
  }
}

/**
 * Phrase the evidence as a sentence. PURE, and ADVISORY BY CONSTRUCTION — it returns words, never a
 * boolean, so there is nothing for a caller to branch on and no way for this to become a rule.
 */
export function evidenceAdvisory(
  station: QrStation | null,
  rawCode: string | null,
  lat: number | null,
  lon: number | null,
  accuracy: number | null,
): string | null {
  const parts: string[] = [];

  if (rawCode && !station) {
    parts.push(
      'The scanned code is not one of the recorded stations. It has been kept with the punch as it was read.',
    );
  }
  if (station) {
    parts.push('Scanned at ' + station.label + '.');
    if (lat !== null && lon !== null && station.lat !== null && station.lon !== null) {
      const d = haversineMetres(lat, lon, station.lat, station.lon);
      if (d !== null) {
        parts.push(
          d > station.radiusM
            ? 'The location reading was about ' + d + ' m from that station, which is further than the ' +
              station.radiusM + ' m it expects. Phone location is often wrong indoors, so this is a note, not a finding.'
            : 'The location reading was about ' + d + ' m from that station.',
        );
      }
    }
  }
  if (!station && lat !== null && lon !== null) {
    parts.push('A location reading was recorded with this punch.');
    if (accuracy !== null && accuracy > 200) {
      parts.push('The phone reported it as accurate to about ' + Math.round(accuracy) + ' m, which is very rough.');
    }
  }

  return parts.length ? parts.join(' ') : null;
}

/**
 * RECORD A PUNCH.
 *
 * Order matters and is deliberate:
 *   1. Validate the KIND against the day so far. A rendered button is not an authorisation, so the
 *      same rule the page drew its buttons from is re-checked here on the posted value.
 *   2. Insert the raw event with whatever evidence came with it.
 *   3. Recompute the whole day from the events and upsert hr_attendance.
 *
 * Step 3 recomputes rather than increments, for the same reason the workflow engine derives its
 * state from its step rows: a double-fire cannot then double-count, and a repaired event log
 * repairs the day automatically the next time anybody punches.
 *
 * NOTHING IS SWALLOWED. Every failure comes back as { ok: false, error } carrying the real Postgres
 * reason. A punch that quietly did nothing is how somebody discovers at the end of the month that
 * they have no attendance.
 */
export async function punch(
  employeeId: string,
  kind: string,
  evidence: PunchEvidence = {},
): Promise<PunchResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  if (!isPunchKind(kind)) return { ok: false, error: 'That is not something we record.' };

  const day = await today();
  if (!day) {
    return {
      ok: false,
      error: 'We could not read the date from the database, so we will not guess which day this punch belongs to.',
    };
  }

  const existing = await punchesOn(employeeId, day);
  const before = computeDay(existing);
  const refusal = punchRefusal(kind, before);
  if (refusal) return { ok: false, error: refusal, totals: before };

  const lat = evidence?.lat === null || evidence?.lat === undefined ? null : Number(evidence.lat);
  const lon = evidence?.lon === null || evidence?.lon === undefined ? null : Number(evidence.lon);
  const acc =
    evidence?.accuracy === null || evidence?.accuracy === undefined ? null : Number(evidence.accuracy);
  const goodLat = lat !== null && isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null;
  const goodLon = lon !== null && isFinite(lon) && lon >= -180 && lon <= 180 ? lon : null;
  const goodAcc = acc !== null && isFinite(acc) && acc >= 0 ? Math.min(acc, 100000) : null;
  const rawCode = evidence?.qrCode ? String(evidence.qrCode).trim().slice(0, 200) : null;
  const workMode = WORK_MODES.includes(String(evidence?.workMode) as WorkMode)
    ? String(evidence?.workMode)
    : 'remote';
  const note = evidence?.note ? String(evidence.note).slice(0, 500) : null;
  const ip = evidence?.ipAddress ? String(evidence.ipAddress).slice(0, 90) : null;
  const device = evidence?.deviceInfo ? String(evidence.deviceInfo).slice(0, 300) : null;

  const station = rawCode ? await stationForCode(rawCode) : null;
  const advisory = evidenceAdvisory(station, rawCode, goodLat, goodLon, goodAcc);
  const source = rawCode ? 'qr' : 'self';

  try {
    await ensureAttendanceSchema();
    await db.execute(sql`
      INSERT INTO hr_clock_events
        (employee_id, event_type, lat, lon, accuracy, location_name, work_mode, note,
         ip_address, device_info, qr_station_id, qr_code_raw, source)
      VALUES
        (${employeeId}::uuid, ${kind}, ${goodLat}, ${goodLon}, ${goodAcc},
         ${station ? station.label : null}, ${workMode}, ${note},
         ${ip}, ${device}, ${station ? station.id : null}::uuid, ${rawCode}, ${source})`);
  } catch (e: any) {
    logFail('punch.insert', e);
    return { ok: false, error: errText(e, 'The punch could not be recorded.'), totals: before };
  }

  const after = computeDay(await punchesOn(employeeId, day));
  const written = await writeDayFromPunches(employeeId, day, after, workMode);
  if (!written.ok) return { ...written, totals: after, advisory };

  return { ok: true, changed: true, totals: after, advisory };
}

/**
 * Upsert hr_attendance from a computed day.
 *
 * ON CONFLICT (employee_id, date) — the uniqueness db/hr-schema.sql:140 declares and that
 * markLeaveAttendance() already relies on. THE STATUS GUARD MATTERS: an approved leave day writes
 * 'on_leave', and if somebody then punches, the real work wins ('present'), which is the same
 * direction markLeaveAttendance() already takes ("present/wfh wins over on_leave"). The two writers
 * agree rather than fighting.
 */
async function writeDayFromPunches(
  employeeId: string,
  dateIso: string,
  totals: DayTotals,
  workMode: string,
): Promise<WriteResult> {
  const status: AttendanceStatus = workMode === 'remote' ? 'wfh' : 'present';
  const hours = minutesToHours(totals.workedMinutes);
  try {
    const shift = await shiftOn(employeeId, dateIso);
    await db.execute(sql`
      INSERT INTO hr_attendance
        (employee_id, date, clock_in, clock_out, work_hours, break_minutes, status, work_mode,
         shift_id, source)
      VALUES
        (${employeeId}::uuid, ${dateIso}::date, ${totals.clockIn}::timestamptz,
         ${totals.clockOut}::timestamptz, ${hours}, ${totals.breakMinutes},
         ${status}, ${workMode}, ${shift ? shift.id : null}::uuid, 'self')
      ON CONFLICT (employee_id, date) DO UPDATE
        SET clock_in      = EXCLUDED.clock_in,
            clock_out     = EXCLUDED.clock_out,
            work_hours    = EXCLUDED.work_hours,
            break_minutes = EXCLUDED.break_minutes,
            status        = EXCLUDED.status,
            work_mode     = EXCLUDED.work_mode,
            shift_id      = COALESCE(EXCLUDED.shift_id, hr_attendance.shift_id),
            source        = 'self'`);
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('writeDayFromPunches', e);
    return {
      ok: false,
      error: errText(e, 'The punch was recorded but the day could not be updated.'),
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE TIMESHEET
// -------------------------------------------------------------------------------------------------

export interface AttendanceDay {
  dateIso: string;
  weekday: string;
  isToday: boolean;
  /** Null when there is no hr_attendance row — an unrecorded day, not a zero-hours one. */
  status: AttendanceStatus | null;
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number | null;
  breakMinutes: number | null;
  workMode: string | null;
  source: string | null;
  notes: string | null;
  shift: Shift | null;
  /** Minutes the roster expected on this day. 0 on a non-working day, and 0 when nothing is rostered. */
  expectedMinutes: number;
  holiday: Holiday | null;
  /** True when the roster says this is a working day and no holiday falls on it. */
  isWorkingDay: boolean;
}

export interface Timesheet {
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  days: AttendanceDay[];
  totalMinutes: number;
  expectedMinutes: number;
  /** Days with an hr_attendance row of any status. */
  recordedDays: number;
  /** True when no shift is rostered for any day in the week — so "expected" means nothing yet. */
  noRoster: boolean;
}

/**
 * One week, per day, from every system that has an opinion about it.
 *
 * FOUR READS, NOT ONE PER DAY. Attendance rows, the roster, the holiday list and today's date are
 * each fetched once for the whole week and then joined in memory. A loop of per-day queries would be
 * a 7-to-28 round-trip page on a phone.
 */
export async function weeklyTimesheet(employeeId: string, anyDayInWeek: string): Promise<Timesheet | null> {
  if (!isUuid(employeeId)) return null;
  const start = weekStartIso(isDateIso(anyDayInWeek) ? anyDayInWeek : '');
  if (!isDateIso(start)) return null;
  const end = shiftDateIso(start, 6);
  const dates = dateRange(start, end);
  const now = await today();

  let attendanceRows: any[] = [];
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT a.date, a.status, a.clock_in, a.clock_out, a.work_hours, a.break_minutes,
             a.work_mode, a.source, a.notes
        FROM hr_attendance a
       WHERE a.employee_id = ${employeeId}::uuid
         AND a.date >= ${start}::date
         AND a.date <= ${end}::date`);
    attendanceRows = rows(r);
  } catch (e: any) {
    logFail('weeklyTimesheet.attendance', e);
  }

  const byDate = new Map<string, any>();
  for (const row of attendanceRows) {
    byDate.set(String(row?.date || '').slice(0, 10), row);
  }

  // The roster can change mid-week, so every day is resolved against the row in force ON THAT DAY.
  // Two reads, not seven: the whole roster history for this person is small.
  const roster = await rosterFor(employeeId);
  const shiftForDate = (dateIso: string): Shift | null => {
    for (const r of roster) {
      if (r.effectiveFrom && r.effectiveFrom <= dateIso && (!r.effectiveTo || r.effectiveTo >= dateIso)) {
        return r.shift;
      }
    }
    return null;
  };

  const departmentId = await departmentOf(employeeId);
  const holidays = await listHolidays(start, end, departmentId);
  const holidayByDate = new Map<string, Holiday>();
  for (const h of holidays) if (!holidayByDate.has(h.dateIso)) holidayByDate.set(h.dateIso, h);

  const days: AttendanceDay[] = [];
  let totalMinutes = 0;
  let expectedMinutes = 0;
  let recordedDays = 0;
  let anyShift = false;

  for (const dateIso of dates) {
    const row = byDate.get(dateIso) || null;
    const shift = shiftForDate(dateIso);
    if (shift) anyShift = true;
    const holiday = holidayByDate.get(dateIso) || null;
    const wd = isoWeekday(dateIso) || 0;
    const rostered = !!shift && shift.workingDays.includes(wd);
    const isWorkingDay = rostered && (!holiday || holiday.isOptional);
    const expect = isWorkingDay ? shiftExpectedMinutes(shift) : 0;

    const workedMinutes = row
      ? Math.round((Number(row.work_hours) || 0) * 60)
      : null;
    if (row) recordedDays++;
    if (workedMinutes) totalMinutes += workedMinutes;
    expectedMinutes += expect;

    days.push({
      dateIso,
      weekday: weekdayName(dateIso),
      isToday: !!now && now === dateIso,
      status: row?.status ? (String(row.status) as AttendanceStatus) : null,
      clockIn: row?.clock_in ? new Date(row.clock_in).toISOString() : null,
      clockOut: row?.clock_out ? new Date(row.clock_out).toISOString() : null,
      workedMinutes,
      breakMinutes: row ? Number(row.break_minutes) || 0 : null,
      workMode: row?.work_mode ? String(row.work_mode) : null,
      source: row?.source ? String(row.source) : null,
      notes: row?.notes ? String(row.notes) : null,
      shift,
      expectedMinutes: expect,
      holiday,
      isWorkingDay,
    });
  }

  return {
    employeeId,
    weekStart: start,
    weekEnd: end,
    days,
    totalMinutes,
    expectedMinutes,
    recordedDays,
    noRoster: !anyShift,
  };
}

/** hr_employees.department_id as TEXT. Null when unset — which is the ordinary case here. */
async function departmentOf(employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const r = await db.execute(sql`
      SELECT department_id::text AS d FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`);
    const list = rows(r);
    return list.length && list[0].d ? String(list[0].d) : null;
  } catch (e: any) {
    logFail('departmentOf', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// CORRECTIONS — the facts here, the decision in the workflow engine
// -------------------------------------------------------------------------------------------------

export interface CorrectionRequest {
  id: string;
  employeeId: string;
  employeeName: string | null;
  workDate: string;
  requestedStatus: string | null;
  requestedClockIn: string | null;
  requestedClockOut: string | null;
  reason: string;
  requestedByUserId: string | null;
  appliedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string | null;
  /**
   * The APPROVAL, read from workflow_instances. Null when no instance exists, which on a live
   * request means the workflow could not be started at all and the screen must say so rather than
   * showing a blank state that reads as "waiting".
   */
  workflow: WorkflowInstanceRow | null;
}

function mapCorrection(row: any, wf: WorkflowInstanceRow | null): CorrectionRequest {
  return {
    id: String(row?.id ?? ''),
    employeeId: String(row?.employee_id ?? ''),
    employeeName: row?.employee_name ? String(row.employee_name) : null,
    workDate: row?.work_date ? String(row.work_date).slice(0, 10) : '',
    requestedStatus: row?.requested_status ? String(row.requested_status) : null,
    requestedClockIn: row?.requested_clock_in ? new Date(row.requested_clock_in).toISOString() : null,
    requestedClockOut: row?.requested_clock_out ? new Date(row.requested_clock_out).toISOString() : null,
    reason: String(row?.reason ?? ''),
    requestedByUserId: row?.requested_by_user_id ? String(row.requested_by_user_id) : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
    withdrawnAt: row?.withdrawn_at ? new Date(row.withdrawn_at).toISOString() : null,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    workflow: wf,
  };
}

export interface RequestCorrectionInput {
  employeeId: string;
  workDate: string;
  requestedStatus?: string | null;
  /** 'HH:MM' local clock times. Combined with workDate before they are stored. */
  clockInHm?: string | null;
  clockOutHm?: string | null;
  reason: string;
  requestedByUserId?: string | null;
}

export interface CorrectionResult extends WriteResult {
  correctionId?: string;
  instanceId?: string;
  state?: string;
  /** The engine's own sentence when routing could not name an approver. Rendered verbatim. */
  haltReason?: string | null;
}

/**
 * ASK FOR A DAY TO BE CORRECTED.
 *
 * The row is written FIRST and the workflow is started against it, in that order, because the
 * workflow's record_id has to point at something that exists. If routing then fails, the workflow
 * engine still creates the instance — in state 'halted', carrying the sentence that says which
 * relationship is missing — so the request is visible and resumable rather than lost. That behaviour
 * is the engine's (see startWorkflow) and is deliberately not re-implemented here.
 *
 * THERE IS NO AUTO-APPROVE PATH. If the organization graph cannot name a reporting manager, the
 * request halts and says so. It does not fall back to a role name, it does not apply itself, and it
 * does not quietly succeed. That is the whole point of the authorization migration.
 */
export async function requestCorrection(input: RequestCorrectionInput): Promise<CorrectionResult> {
  const employeeId = String(input?.employeeId || '');
  const workDate = String(input?.workDate || '');
  const reason = String(input?.reason || '').trim().slice(0, 1000);

  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  if (!isDateIso(workDate)) return { ok: false, error: 'Choose the day you want corrected.' };
  if (reason.length < 5) {
    return { ok: false, error: 'Say what happened. Your manager decides this, and one line is enough.' };
  }

  const now = await today();
  if (!now) {
    return { ok: false, error: 'We could not read the date from the database, so we will not check the correction window.' };
  }
  if (workDate > now) return { ok: false, error: 'That day has not happened yet.' };
  const age = daysBetweenIso(workDate, now);
  if (age !== null && age > CORRECTION_WINDOW_DAYS) {
    return {
      ok: false,
      error:
        'That day is more than ' + CORRECTION_WINDOW_DAYS +
        ' days ago, which is past the window for a correction. Ask HR to look at it directly.',
    };
  }

  const status = input?.requestedStatus ? String(input.requestedStatus) : null;
  if (status && !(ATTENDANCE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'That is not a status we record.' };
  }
  const inMin = hmToMinute(input?.clockInHm);
  const outMin = hmToMinute(input?.clockOutHm);
  if (input?.clockInHm && inMin === null) return { ok: false, error: 'The check-in time is not a time.' };
  if (input?.clockOutHm && outMin === null) return { ok: false, error: 'The check-out time is not a time.' };
  if (inMin !== null && outMin !== null && outMin <= inMin) {
    return { ok: false, error: 'The check-out time has to be after the check-in time.' };
  }
  if (!status && inMin === null && outMin === null) {
    return { ok: false, error: 'Say what should change: a status, a check-in time, or a check-out time.' };
  }

  const inIso = inMin === null ? null : workDate + 'T' + minuteToHm(inMin) + ':00';
  const outIso = outMin === null ? null : workDate + 'T' + minuteToHm(outMin) + ':00';
  const by = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  let correctionId = '';
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_attendance_corrections
        (employee_id, work_date, requested_status, requested_clock_in, requested_clock_out,
         reason, requested_by_user_id)
      VALUES
        (${employeeId}::uuid, ${workDate}::date, ${status},
         ${inIso}::timestamptz, ${outIso}::timestamptz, ${reason}, ${by}::uuid)
      RETURNING id`);
    const list = rows(r);
    if (!list.length) {
      return { ok: false, error: 'The request was not saved and the database did not say why.' };
    }
    correctionId = String(list[0].id);
  } catch (e: any) {
    logFail('requestCorrection.insert', e);
    return { ok: false, error: errText(e, 'The request could not be saved.') };
  }

  const summary =
    'Attendance correction for ' + workDate + (status ? ', asked to be recorded as ' + status : '');
  const started = await startWorkflow({
    domain: 'attendance',
    recordId: correctionId,
    subjectEmployeeId: employeeId,
    requestedByUserId: by,
    createdByUserId: by,
    summary,
  });

  if (!started.ok) {
    // The row exists and the approval does not. Say so plainly rather than reporting success: a
    // request nobody is looking at is exactly the failure this whole build is meant to prevent.
    return {
      ok: false,
      correctionId,
      error:
        'Your correction was saved but it could not be sent for approval: ' +
        (started.error || 'the approval engine did not say why') +
        '. Nothing is lost — tell HR and it can be sent again.',
    };
  }

  return {
    ok: true,
    changed: started.changed !== false,
    correctionId,
    instanceId: started.instanceId,
    state: started.state,
    haltReason: started.haltReason ?? null,
  };
}

/** Correction requests for one employee, newest day first, each with its approval state. */
export async function correctionsFor(employeeId: string, limit = 30): Promise<CorrectionRequest[]> {
  if (!isUuid(employeeId)) return [];
  const n = Math.min(Math.max(Number(limit) || 30, 1), LIST_LIMIT);
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name
        FROM hr_attendance_corrections c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.employee_id = ${employeeId}::uuid
       ORDER BY c.work_date DESC, c.created_at DESC
       LIMIT ${n}`);
    const list = rows(r);
    const out: CorrectionRequest[] = [];
    for (const row of list) {
      const wf = await instanceForRecord('attendance', String(row.id));
      out.push(mapCorrection(row, wf));
    }
    return out;
  } catch (e: any) {
    logFail('correctionsFor', e);
    return [];
  }
}

/** One correction by id, with its approval state. Null when there is no such row. */
export async function correctionById(correctionId: string): Promise<CorrectionRequest | null> {
  if (!isUuid(correctionId)) return null;
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name
        FROM hr_attendance_corrections c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.id = ${correctionId}::uuid
       LIMIT 1`);
    const list = rows(r);
    if (!list.length) return null;
    const wf = await instanceForRecord('attendance', correctionId);
    return mapCorrection(list[0], wf);
  } catch (e: any) {
    logFail('correctionById', e);
    return null;
  }
}

/** Withdraw a request that has not been applied. The workflow instance is cancelled separately. */
export async function withdrawCorrection(
  correctionId: string,
  employeeId: string,
): Promise<WriteResult> {
  if (!isUuid(correctionId) || !isUuid(employeeId)) {
    return { ok: false, error: 'That is not a correction request.' };
  }
  try {
    await ensureAttendanceSchema();
    const r = await db.execute(sql`
      UPDATE hr_attendance_corrections
         SET withdrawn_at = NOW()
       WHERE id = ${correctionId}::uuid
         AND employee_id = ${employeeId}::uuid
         AND applied_at IS NULL
         AND withdrawn_at IS NULL
      RETURNING id`);
    const list = rows(r);
    return list.length ? { ok: true, id: correctionId, changed: true } : { ok: true, changed: false };
  } catch (e: any) {
    logFail('withdrawCorrection', e);
    return { ok: false, error: errText(e, 'The request could not be withdrawn.') };
  }
}

/**
 * APPLY AN APPROVED CORRECTION TO hr_attendance.
 *
 * THE GUARD IS THE POINT: this reads the workflow instance and refuses unless the ENGINE says
 * 'approved'. There is no argument that lets a caller assert approval, and no code path in this file
 * writes a corrected day without that check. Applying is idempotent — a second call on an
 * already-applied row is a no-op success, so a retried POST cannot double-write.
 *
 * The day is written with source 'correction', so the timesheet can say where the numbers came from
 * instead of presenting a decided change as if the person had punched it.
 */
export async function applyCorrection(correctionId: string): Promise<WriteResult> {
  if (!isUuid(correctionId)) return { ok: false, error: 'That is not a correction request.' };

  const correction = await correctionById(correctionId);
  if (!correction) return { ok: false, error: 'That correction request no longer exists.' };
  if (correction.appliedAt) return { ok: true, id: correctionId, changed: false };
  if (correction.withdrawnAt) return { ok: false, error: 'That request was withdrawn.' };
  if (!correction.workflow) {
    return { ok: false, error: 'That request has no approval attached, so there is nothing to apply.' };
  }
  if (correction.workflow.state !== 'approved') {
    return {
      ok: false,
      error: 'That request is ' + correction.workflow.state + ', not approved, so nothing is applied.',
    };
  }

  const totals = computeDay([
    ...(correction.requestedClockIn ? [{ kind: 'clock_in', at: correction.requestedClockIn }] : []),
    ...(correction.requestedClockOut ? [{ kind: 'clock_out', at: correction.requestedClockOut }] : []),
  ]);
  const hours = minutesToHours(totals.workedMinutes);
  const status = correction.requestedStatus || 'present';
  const note = 'Corrected on approval: ' + correction.reason.slice(0, 200);

  try {
    await ensureAttendanceSchema();
    // COALESCE on the time columns so a correction that only changes the STATUS does not erase a
    // real punch, and one that only changes the times does not erase a status somebody set.
    await db.execute(sql`
      INSERT INTO hr_attendance
        (employee_id, date, clock_in, clock_out, work_hours, status, work_mode, notes, source)
      VALUES
        (${correction.employeeId}::uuid, ${correction.workDate}::date,
         ${correction.requestedClockIn}::timestamptz, ${correction.requestedClockOut}::timestamptz,
         ${hours}, ${status}, 'remote', ${note}, 'correction')
      ON CONFLICT (employee_id, date) DO UPDATE
        SET clock_in   = COALESCE(EXCLUDED.clock_in, hr_attendance.clock_in),
            clock_out  = COALESCE(EXCLUDED.clock_out, hr_attendance.clock_out),
            work_hours = CASE WHEN EXCLUDED.work_hours > 0 THEN EXCLUDED.work_hours
                              ELSE hr_attendance.work_hours END,
            status     = EXCLUDED.status,
            notes      = EXCLUDED.notes,
            source     = 'correction'`);
    await db.execute(sql`
      UPDATE hr_attendance_corrections SET applied_at = NOW()
       WHERE id = ${correctionId}::uuid AND applied_at IS NULL`);
    return { ok: true, id: correctionId, changed: true };
  } catch (e: any) {
    logFail('applyCorrection', e);
    return { ok: false, error: errText(e, 'The approved correction could not be written to the day.') };
  }
}

/**
 * Apply every correction whose workflow has approved it and which has not been written yet.
 *
 * Called when a corrections screen loads. It exists because the approval and the write are two
 * separate facts: an approver can decide on one screen, and the person whose day it is opens theirs
 * a minute later. Without this reconciliation the timesheet would show old numbers under an
 * "Approved" chip, which reads as the product having lost the decision.
 *
 * Returns how many were applied. Bounded, so a page load can never turn into a bulk job.
 */
export async function applyApprovedCorrections(employeeId?: string | null, limit = 20): Promise<number> {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  try {
    await ensureAttendanceSchema();
    const scope = isUuid(employeeId) ? sql`AND c.employee_id = ${employeeId}::uuid` : sql``;
    const r = await db.execute(sql`
      SELECT c.id
        FROM hr_attendance_corrections c
        JOIN workflow_instances w
          ON w.domain = 'attendance' AND w.record_id = c.id::text
       WHERE c.applied_at IS NULL
         AND c.withdrawn_at IS NULL
         AND w.state = 'approved'
         ${scope}
       ORDER BY c.work_date DESC
       LIMIT ${n}`);
    let applied = 0;
    for (const row of rows(r)) {
      const res = await applyCorrection(String(row.id));
      if (res.ok && res.changed) applied++;
    }
    return applied;
  } catch (e: any) {
    // workflow_instances may not exist yet on a database where nothing has ever started a workflow.
    // Nothing to reconcile is not an error.
    logFail('applyApprovedCorrections', e);
    return 0;
  }
}
