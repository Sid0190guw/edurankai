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
import { ensureAttendanceSchema, ensureWorkingTimeSchema } from './attendance-schema';
import { startWorkflow, resumeWorkflow, instanceForRecord, type WorkflowInstanceRow } from './workflow';
// FACE VERIFICATION IS AN OUTCOME THIS FILE RECORDS, NOT A CHECK IT PERFORMS. The comparison lives
// in src/lib/attendance-verify.ts (which owns the descriptor and drops it) and its result arrives
// here already decided, by the server, in a shape no request body can produce. This file never sees
// a descriptor and never sees an image. The import is one-directional — attendance-verify.ts
// imports nothing from here — so there is no cycle.
import {
  ensureFaceVerifySchema,
  dayVerification,
  type PunchVerification,
} from './attendance-verify';

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
// TODAY, IN THE ZONE THE COMPANY ACTUALLY WORKS IN
// -------------------------------------------------------------------------------------------------

/**
 * THE ZONE EVERY DAY BOUNDARY IN THIS MODULE IS CUT ON, named once.
 *
 * Attendance is the one module where a day is not a formatting choice: "did I clock in today" is a
 * claim about a person's pay, and the header of this file says so. Declared here, above the only
 * function that reads it — const is not hoisted.
 */
export const ATTENDANCE_TIME_ZONE = 'Asia/Kolkata';

/**
 * Today, as the working day is counted here. Null when the read did not happen.
 *
 * ASKING POSTGRES WAS ONLY HALF THE ANSWER, AND THE MISSING HALF COST FIVE AND A HALF HOURS A DAY.
 * This used to be `SELECT CURRENT_DATE`, written deliberately so a render process in another region
 * could not decide the date. But CURRENT_DATE is the DATABASE SESSION's zone, and nothing anywhere
 * sets it: src/lib/db/index.ts opens postgres(connectionString, { prepare: false }) with no timezone
 * option and no SET TIME ZONE, so the session inherits the server default, which is UTC. IST is
 * UTC+05:30, so between 00:00 and 05:29 every night "today" was still YESTERDAY.
 *
 * What that produced, every night: an early-shift punch at 05:00 IST written onto the previous day's
 * hr_attendance row over a day already closed out; a daily report filed at 00:30 IST refused as
 * "that day has not happened yet"; an overtime claim refused the same way.
 *
 * `NOW() AT TIME ZONE '<zone>'` converts the transaction timestamp into local wall-clock time in that
 * zone and the ::date then cuts the day where the people cutting it do. It is explicit, it does not
 * depend on the session's configuration, and it does not require changing the connection — which on
 * a pooled connection is not this module's decision to make.
 *
 * NULL IS NOT "GUESS". A caller that gets null must not render a day-partitioned claim; the pages
 * here say so rather than showing yesterday's punches under today's heading.
 */
export async function today(): Promise<string | null> {
  try {
    const r = await db.execute(
      sql`SELECT (NOW() AT TIME ZONE ${ATTENDANCE_TIME_ZONE})::date::text AS d`,
    );
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
  /**
   * Where this holiday applies. Null means everywhere.
   *
   * A free-text place name rather than a foreign key, because this product has no office or site
   * register to point at. It is matched case-insensitively against the employee's own recorded
   * location — see src/lib/holidays.ts, which owns that comparison.
   */
  location: string | null;
  isOptional: boolean;
}

function mapHoliday(row: any): Holiday {
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
    await ensureWorkingTimeSchema();
    const scope = dept
      ? sql`AND (h.department_id IS NULL OR h.department_id::text = ${dept}::text)`
      : sql``;
    const r = await db.execute(sql`
      SELECT h.id, h.holiday_date, h.name, h.department_id::text AS department_id,
             h.location, h.is_optional, d.name AS department_name
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
  /** Where it applies. Omit for the whole organization. */
  location?: string | null;
  isOptional?: boolean;
  createdByUserId?: string | null;
}): Promise<WriteResult> {
  const dateIso = String(input?.dateIso || '');
  const name = String(input?.name || '').trim().slice(0, 160);
  if (!isDateIso(dateIso)) return { ok: false, error: 'That is not a date.' };
  if (!name) return { ok: false, error: 'A holiday needs a name.' };
  const dept = input?.departmentId ? String(input.departmentId).trim().slice(0, 80) : null;
  const location = input?.location ? String(input.location).trim().slice(0, 120) : null;
  const optional = input?.isOptional === true;
  const by = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_holidays (holiday_date, name, department_id, location, is_optional, created_by)
      VALUES (${dateIso}::date, ${name}, ${dept}::text, ${location}::text, ${optional}, ${by}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const list = rows(r);
    // No returned row means that date already carries a holiday for that exact scope — same
    // department, same location. Re-entering it is not an error; it is somebody making sure, and
    // the honest answer is "it is already there".
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
  /**
   * THE RESULT of a face check that the SERVER already ran, or null when none was attempted.
   *
   * NOT A DESCRIPTOR, NOT A DISTANCE, NOT AN IMAGE — there is no field on this interface that could
   * carry any of those and no column to put them in. The caller obtains this by awaiting
   * verifyPunchFace() or declinedVerification() in src/lib/attendance-verify.ts; it is never parsed
   * out of a request body, so a browser cannot post `{ verified: true }` and be believed.
   *
   * A FAILED CHECK NEVER REFUSES THE PUNCH. It is recorded beside it, exactly as a poor GPS fix is.
   */
  verification?: PunchVerification | null;
}

export interface PunchResult extends WriteResult {
  /** The day after the punch, so a caller can re-render without a second read. */
  totals?: DayTotals;
  /**
   * A sentence about the evidence, for a person to read. ADVISORY: it never blocked anything and it
   * must never be rendered as a warning about the employee. Null when there is nothing to say.
   */
  advisory?: string | null;
  /**
   * The face-check outcome that was written beside this punch, echoed back so the caller can say so
   * on screen without a second read. Null when no check was attempted.
   *
   * A punch is `ok: true` whether this verified or not. That is the point: the outcome is a label on
   * a recorded fact, never a gate in front of one.
   */
  verification?: PunchVerification | null;
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
  /**
   * What the face check found, or null when none ran. THE OUTCOME ONLY — there is no descriptor and
   * no image to select, because none was ever stored. Rendered by verificationBadge() in
   * src/lib/attendance-verify.ts so an unverified punch is visibly unverified.
   */
  faceVerified: boolean | null;
  faceOutcome: string | null;
}

export async function punchLog(employeeId: string, dateIso: string): Promise<PunchRow[]> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return [];
  try {
    await ensureAttendanceSchema();
    await ensureFaceVerifySchema();
    const r = await db.execute(sql`
      SELECT c.event_type, c.event_time, c.lat, c.lon, c.accuracy, c.location_name,
             c.qr_code_raw, c.source, c.face_verified, c.face_verify_outcome,
             s.label AS station_label
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
      faceVerified: row?.face_verified === null || row?.face_verified === undefined ? null : row.face_verified === true,
      faceOutcome: row?.face_verify_outcome ? String(row.face_verify_outcome) : null,
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

  // THE FACE-CHECK OUTCOME, AND NOTHING ELSE ABOUT IT.
  //
  // Four scalars are lifted out of the result the server already computed: a boolean, two short
  // words and a timestamp. THERE IS NO DESCRIPTOR HERE AND NO IMAGE HERE, and the INSERT below has
  // no column that could take one. Note what is NOT done with this value: it is not consulted by
  // any branch between here and the write. There is deliberately no `if (!verified) return` — a
  // failed face check records the punch exactly like a passed one and differs only in the label it
  // carries, because a person who turned up must never lose the record of turning up to a camera.
  const verification = evidence?.verification || null;
  const faceVerified = verification ? verification.verified === true : null;
  const faceMethod = verification ? String(verification.method).slice(0, 20) : null;
  const faceOutcome = verification ? String(verification.outcome).slice(0, 30) : null;
  const faceAt = verification && verification.at ? verification.at : null;

  try {
    await ensureAttendanceSchema();
    // Its own ensureOnce key: ensureOnce memoises per key per PROCESS, so a server that has already
    // resolved 'attendance_v1' would never run statements appended to it. ensureOnce swallows a
    // failed run for the caller, so a DDL hiccup cannot cost anybody their punch.
    await ensureFaceVerifySchema();
    await db.execute(sql`
      INSERT INTO hr_clock_events
        (employee_id, event_type, lat, lon, accuracy, location_name, work_mode, note,
         ip_address, device_info, qr_station_id, qr_code_raw, source,
         face_verified, face_verify_method, face_verify_outcome, face_verified_at)
      VALUES
        (${employeeId}::uuid, ${kind}, ${goodLat}, ${goodLon}, ${goodAcc},
         ${station ? station.label : null}, ${workMode}, ${note},
         ${ip}, ${device}, ${station ? station.id : null}::uuid, ${rawCode}, ${source},
         ${faceVerified}, ${faceMethod}, ${faceOutcome}, ${faceAt}::timestamptz)`);
  } catch (e: any) {
    logFail('punch.insert', e);
    return { ok: false, error: errText(e, 'The punch could not be recorded.'), totals: before };
  }

  const after = computeDay(await punchesOn(employeeId, day));
  const written = await writeDayFromPunches(employeeId, day, after, workMode);
  if (!written.ok) return { ...written, totals: after, advisory, verification };

  return { ok: true, changed: true, totals: after, advisory, verification };
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

    // THE DAY'S VERIFICATION IS RECOMPUTED FROM THE PUNCHES, never incremented — the same discipline
    // work_hours already follows two lines below, and for the same reason: a double-fire cannot then
    // double-count, and a repaired event log repairs the day the next time anybody punches.
    //
    // THREE STATES, and the third one matters. TRUE means every punch today passed a server-side
    // check; FALSE means at least one did not; NULL means nothing about verification is recorded for
    // this day at all (HR entered it, approved leave wrote it, or it predates this feature). NULL is
    // NOT "unverified", and COALESCE below keeps a NULL from overwriting a real answer — otherwise a
    // later HR edit to the same day would erase the fact that the person verified at 09:02.
    //
    // That COALESCE covers face_verified too, and it has to: dayVerification() fails CLOSED to a
    // NULL summary, so without it one unreadable moment would rewrite a verified day as "nothing
    // recorded". A real answer still replaces a real answer, true -> false included, because the
    // summary is recomputed from the punches rather than incremented.
    const dayFace = await dayVerification(employeeId, dateIso);

    await db.execute(sql`
      INSERT INTO hr_attendance
        (employee_id, date, clock_in, clock_out, work_hours, break_minutes, status, work_mode,
         shift_id, source, face_verified, face_verify_method, face_verified_at)
      VALUES
        (${employeeId}::uuid, ${dateIso}::date, ${totals.clockIn}::timestamptz,
         ${totals.clockOut}::timestamptz, ${hours}, ${totals.breakMinutes},
         ${status}, ${workMode}, ${shift ? shift.id : null}::uuid, 'self',
         ${dayFace.allVerified}, ${dayFace.method}, ${dayFace.at}::timestamptz)
      ON CONFLICT (employee_id, date) DO UPDATE
        SET clock_in      = EXCLUDED.clock_in,
            clock_out     = EXCLUDED.clock_out,
            work_hours    = EXCLUDED.work_hours,
            break_minutes = EXCLUDED.break_minutes,
            status        = EXCLUDED.status,
            work_mode     = EXCLUDED.work_mode,
            shift_id      = COALESCE(EXCLUDED.shift_id, hr_attendance.shift_id),
            face_verified      = COALESCE(EXCLUDED.face_verified, hr_attendance.face_verified),
            face_verify_method = COALESCE(EXCLUDED.face_verify_method, hr_attendance.face_verify_method),
            face_verified_at   = COALESCE(EXCLUDED.face_verified_at, hr_attendance.face_verified_at),
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

// =================================================================================================
// BREAKS — WHAT THE DAY WAS ACTUALLY MADE OF
// =================================================================================================

/** One break, as it happened. `end` is null while the person is still on it. */
export interface BreakSegment {
  start: string;
  end: string | null;
  minutes: number;
  /** True while it is still running. Its minutes are counted to now, not to nothing. */
  open: boolean;
}

/**
 * Every break in a day, in order. PURE.
 *
 * computeDay() already TOTALS breaks — this SEPARATES them, because a person looking at "2h 10m on
 * break" needs to see it was four breaks and not one two-hour lunch before they can tell whether the
 * number is right. Multiple breaks a day is the ordinary case and always has been: hr_clock_events
 * has accepted repeated break_start/break_end pairs since it was written.
 *
 * AN OPEN BREAK IS COUNTED TO NOW, so the screen can say "on a break, 12 minutes so far". It is
 * still excluded from worked time by computeDay(), which closes it at clock_out or leaves it open —
 * this function reports it, it does not re-decide it.
 */
export function breakSegments(events: PunchEvent[], nowIso?: string | null): BreakSegment[] {
  const sorted = (events || [])
    .filter((e) => e && isPunchKind(e.kind) && e.at)
    .map((e) => ({ kind: e.kind as PunchKind, ms: Date.parse(e.at), at: e.at }))
    .filter((e) => !isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms);

  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const out: BreakSegment[] = [];
  let openAt: { ms: number; at: string } | null = null;

  for (const e of sorted) {
    if (e.kind === 'break_start') {
      if (!openAt) openAt = { ms: e.ms, at: e.at };
    } else if (e.kind === 'break_end' || e.kind === 'clock_out') {
      if (openAt) {
        out.push({
          start: openAt.at,
          end: e.at,
          minutes: Math.max(0, Math.round((e.ms - openAt.ms) / 60000)),
          open: false,
        });
        openAt = null;
      }
    }
  }
  if (openAt) {
    out.push({
      start: openAt.at,
      end: null,
      minutes: Math.max(0, Math.round(((isNaN(nowMs) ? openAt.ms : nowMs) - openAt.ms) / 60000)),
      open: true,
    });
  }
  return out;
}

/** Worked time with breaks taken out. computeDay() already does this; named for the screens. */
export function netWorkedMinutes(totals: DayTotals): number {
  return Math.max(0, Number(totals?.workedMinutes) || 0);
}

// =================================================================================================
// PUNCTUALITY — ADVISORY, AND ADVISORY BY CONSTRUCTION
// =================================================================================================
//
// LATE ARRIVAL AND EARLY DEPARTURE ARE SENTENCES, NOT VERDICTS, and nothing here or in
// attendance-schema.ts stores them. That absence is the design, and it is the same one the geo and
// QR columns were built with: the moment a `late_minutes` column exists, some screen filters on it,
// somebody sorts by it, and a person loses money to a shift that was changed after they were
// rostered on it, or to a phone that could not reach the network at 08:58.
//
// So this is computed WHEN SOMEBODY LOOKS, from the punches and the shift in force on that day, and
// a human reads it and decides what it means, if anything. There is no threshold, no flag, and no
// count anywhere in this codebase that adds these up into a consequence.

export interface Punctuality {
  /** Minutes after the shift start (plus its grace) that the first check-in happened. 0 if not late. */
  lateMinutes: number;
  /** Minutes before the shift end that the last check-out happened. 0 if not early. */
  earlyMinutes: number;
  /** A sentence for a person, or null when there is nothing worth saying. */
  sentence: string | null;
  /** True when there was no rostered shift, so there is nothing to be late for. */
  noShift: boolean;
}

/**
 * How the day sat against the shift. PURE, and it returns WORDS beside its numbers on purpose.
 *
 * TIMES ARE READ IN UTC, matching how every attendance screen in this product renders a clock time
 * (see clockTime() in /portal/employee/attendance). Both sides of the comparison therefore use one
 * clock. Mixing the process timezone into one side would make somebody in a different timezone
 * permanently four hours late.
 */
export function punctuality(shift: Shift | null, totals: DayTotals | null): Punctuality {
  const none: Punctuality = { lateMinutes: 0, earlyMinutes: 0, sentence: null, noShift: !shift };
  if (!shift || !totals) return none;

  const minuteOfDay = (iso: string | null): number | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };

  const inMin = minuteOfDay(totals.clockIn);
  const outMin = minuteOfDay(totals.clockOut);
  const grace = Math.max(0, Number(shift.graceMinutes) || 0);

  let late = 0;
  if (inMin !== null) late = Math.max(0, inMin - (shift.startMinute + grace));

  let early = 0;
  // A shift that crosses midnight cannot be compared this way without a second date, and guessing
  // would report every night-shift check-out as hours early. Left at zero and said so.
  const crossesMidnight = shift.endMinute <= shift.startMinute;
  if (outMin !== null && !crossesMidnight) early = Math.max(0, shift.endMinute - outMin);

  const parts: string[] = [];
  if (late > 0) {
    parts.push(
      'Checked in ' + formatMinutes(late) + ' after ' + minuteToHm(shift.startMinute) +
      (grace ? ' plus the ' + grace + '-minute grace period' : '') + '.',
    );
  }
  if (early > 0) {
    parts.push('Checked out ' + formatMinutes(early) + ' before ' + minuteToHm(shift.endMinute) + '.');
  }
  if (!parts.length) return { lateMinutes: 0, earlyMinutes: 0, sentence: null, noShift: false };

  parts.push('This is a note for a person to read. Nothing is deducted and nobody is penalised by it.');
  return { lateMinutes: late, earlyMinutes: early, sentence: parts.join(' '), noShift: false };
}

// =================================================================================================
// OVERTIME — A CLAIM, ROUTED FOR APPROVAL, NEVER CREDITED BY ARITHMETIC
// =================================================================================================

/** What comp off a length of overtime is worth, in days. PURE. */
export function compOffUnitsFor(minutes: number, dayMinutes: number): number {
  const m = Number(minutes) || 0;
  const d = Number(dayMinutes) || 0;
  if (m <= 0 || d <= 0) return 0;
  // Nearest half day, capped at two. A quarter of a shift rounds up to half a day; anything shorter
  // is recorded as overtime hours and earns no day, which the caller says out loud rather than
  // dropping silently.
  return Math.min(2, Math.round((m / d) * 2) / 2);
}

/** What one day looked like against its shift — the numbers an overtime claim is made from. */
export interface DayAgainstShift {
  dateIso: string;
  shift: Shift | null;
  workedMinutes: number;
  expectedMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  punctuality: Punctuality;
  holiday: Holiday | null;
  /** True when the shift does not roster this weekday, or a holiday falls on it. */
  nonWorkingDay: boolean;
}

/**
 * Read one day and compare it with the shift that was in force ON THAT DAY.
 *
 * Extra minutes are DERIVED here and stored nowhere. Nothing in this function writes, credits or
 * flags anything — it produces the number a person then claims through requestOvertime().
 */
export async function dayAgainstShift(employeeId: string, dateIso: string): Promise<DayAgainstShift | null> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return null;
  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();

    const totals = computeDay(await punchesOn(employeeId, dateIso));
    const shift = await shiftOn(employeeId, dateIso);
    const wd = isoWeekday(dateIso) || 0;
    const departmentId = await departmentOf(employeeId);
    const holidays = await listHolidays(dateIso, dateIso, departmentId);
    const holiday = holidays.find((h) => !h.isOptional && !h.location) || null;

    const rostered = !!shift && shift.workingDays.includes(wd);
    const nonWorkingDay = !rostered || !!holiday;
    const expected = rostered && !holiday ? shiftExpectedMinutes(shift) : 0;

    // A day the roster does not expect any hours on is ALL overtime when somebody worked it — that
    // is what a worked holiday or a called-in Sunday is.
    const worked = totals.workedMinutes;
    const overtime = Math.max(0, worked - expected);

    return {
      dateIso,
      shift,
      workedMinutes: worked,
      expectedMinutes: expected,
      breakMinutes: totals.breakMinutes,
      overtimeMinutes: overtime,
      punctuality: punctuality(shift, totals),
      holiday,
      nonWorkingDay,
    };
  } catch (e: any) {
    logFail('dayAgainstShift', e);
    return null;
  }
}

export interface OvertimeClaim {
  id: string;
  employeeId: string;
  employeeName: string | null;
  workDate: string;
  minutes: number;
  reason: string;
  /** What the claim ASKS for: 'comp_off' or 'pay'. It decides nothing on its own. */
  convertTo: string;
  workedHoliday: boolean;
  appliedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string | null;
  /** The APPROVAL, from workflow_instances. Null means the workflow could not be started at all. */
  workflow: WorkflowInstanceRow | null;
}

function mapOvertime(row: any, wf: WorkflowInstanceRow | null): OvertimeClaim {
  return {
    id: String(row?.id ?? ''),
    employeeId: String(row?.employee_id ?? ''),
    employeeName: row?.employee_name ? String(row.employee_name) : null,
    workDate: row?.work_date ? String(row.work_date).slice(0, 10) : '',
    minutes: Number(row?.minutes) || 0,
    reason: String(row?.reason ?? ''),
    convertTo: String(row?.convert_to ?? 'comp_off'),
    workedHoliday: row?.worked_holiday === true,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
    withdrawnAt: row?.withdrawn_at ? new Date(row.withdrawn_at).toISOString() : null,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    workflow: wf,
  };
}

export interface WorkingTimeResult extends WriteResult {
  instanceId?: string;
  state?: string;
  /** The engine's own sentence when routing could not name an approver. Rendered verbatim. */
  haltReason?: string | null;
  /** What settling actually did, in words, for a screen to repeat. Never a failure. */
  note?: string | null;
}

/**
 * CLAIM OVERTIME FOR A DAY.
 *
 * The row is written FIRST and the workflow started against it, so the instance's record_id points
 * at something that exists. If routing then fails the engine still creates the instance in state
 * 'halted' carrying the sentence that names the missing relationship, so the claim is visible and
 * resumable rather than lost.
 *
 * THERE IS NO AUTO-APPROVE PATH AND NO ROLE FALLBACK. If the Organization Graph cannot name a
 * reporting manager, the claim halts and says so.
 *
 * THE MINUTES ARE CHECKED AGAINST THE DAY. A claim for more overtime than the punches support is
 * refused with the real numbers in the sentence — not because the employee is suspected of anything,
 * but because a typed 480 where 48 was meant is the ordinary mistake and it becomes a day's pay.
 */
export async function requestOvertime(input: {
  employeeId: string;
  workDate: string;
  minutes: number;
  reason: string;
  convertTo?: 'comp_off' | 'pay';
  requestedByUserId?: string | null;
}): Promise<WorkingTimeResult> {
  const employeeId = String(input?.employeeId || '');
  const workDate = String(input?.workDate || '');
  const reason = String(input?.reason || '').trim().slice(0, 1000);
  const minutes = Math.round(Number(input?.minutes) || 0);
  const convertTo = input?.convertTo === 'pay' ? 'pay' : 'comp_off';
  const by = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  if (!isDateIso(workDate)) return { ok: false, error: 'Choose the day you worked the extra hours.' };
  if (minutes <= 0) return { ok: false, error: 'A claim needs some minutes in it.' };
  if (minutes > MAX_DAY_MINUTES) return { ok: false, error: 'That is more than a day. Check the number.' };
  if (reason.length < 5) {
    return { ok: false, error: 'Say what the extra hours were for. Your manager decides this, and one line is enough.' };
  }

  const now = await today();
  if (!now) {
    return { ok: false, error: 'We could not read the date from the database, so we will not guess which day this belongs to.' };
  }
  if (workDate > now) return { ok: false, error: 'That day has not happened yet.' };
  const age = daysBetweenIso(workDate, now);
  if (age !== null && age > CORRECTION_WINDOW_DAYS) {
    return {
      ok: false,
      error: 'That day is more than ' + CORRECTION_WINDOW_DAYS + ' days ago, which is past the window for a claim. Ask HR to look at it directly.',
    };
  }

  const day = await dayAgainstShift(employeeId, workDate);
  if (!day) return { ok: false, error: 'We could not read that day, so the claim was not saved.' };
  if (day.overtimeMinutes <= 0) {
    return {
      ok: false,
      error: 'Your punches for ' + workDate + ' show ' + (formatMinutes(day.workedMinutes) || 'no time') +
        ' worked against ' + (formatMinutes(day.expectedMinutes) || 'no expected hours') +
        ', so there is nothing over. If a punch is missing, ask for a correction first.',
    };
  }
  if (minutes > day.overtimeMinutes) {
    return {
      ok: false,
      error: 'Your punches support ' + formatMinutes(day.overtimeMinutes) + ' over the shift on ' + workDate +
        '. Claim that or less, or ask for a correction if a punch is wrong.',
    };
  }

  let claimId = '';
  try {
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_overtime_requests
        (employee_id, work_date, minutes, reason, convert_to, worked_holiday, requested_by_user_id)
      VALUES
        (${employeeId}::uuid, ${workDate}::date, ${minutes}, ${reason}, ${convertTo},
         ${!!day.holiday}, ${by}::uuid)
      RETURNING id`);
    const list = rows(r);
    if (!list.length) {
      // Defensive only. An INSERT with no ON CONFLICT returns its row or throws; it cannot return
      // zero. The real duplicate path is the catch below.
      return { ok: false, error: 'You already have a claim open for that day. Withdraw it before filing another.' };
    }
    claimId = String(list[0].id);
  } catch (e: any) {
    logFail('requestOvertime.insert', e);
    // THE FRIENDLY SENTENCE ABOVE WAS UNREACHABLE, AND THIS IS WHERE IT ACTUALLY BELONGS.
    //
    // hr_overtime_one_live (src/lib/attendance-schema.ts) is a partial unique index on
    // (employee_id, work_date) WHERE withdrawn_at IS NULL, so a second claim for the same day raises
    // 23505 — it does not come back as zero rows. errText() then returned e.cause.message verbatim,
    // so an employee who double-tapped a slow form was shown
    // 'duplicate key value violates unique constraint "hr_overtime_one_live"'. The constraint is
    // doing exactly its job; the only thing wrong was who the message was written for.
    const real = String(e?.cause?.message || e?.message || '');
    if (/duplicate key|unique constraint/i.test(real)) {
      return {
        ok: false,
        error: 'You already have a claim on file for ' + workDate + '. Withdraw that one before filing '
          + 'another — including a claim your manager has already turned down, which still holds the day.',
      };
    }
    return { ok: false, error: errText(e, 'The claim could not be saved.') };
  }

  const started = await startWorkflow({
    domain: 'overtime',
    recordId: claimId,
    subjectEmployeeId: employeeId,
    requestedByUserId: by,
    createdByUserId: by,
    summary: 'Overtime on ' + workDate + ': ' + formatMinutes(minutes) +
      (convertTo === 'pay' ? ', asked to be paid' : ', asked as comp off'),
  });

  if (!started.ok) {
    return {
      ok: false,
      id: claimId,
      error: 'Your claim was saved but it could not be sent for approval: ' +
        (started.error || 'the approval engine did not say why') +
        '. Nothing is lost - tell HR and it can be sent again.',
    };
  }

  return {
    ok: true,
    changed: started.changed !== false,
    id: claimId,
    instanceId: started.instanceId,
    state: started.state,
    haltReason: started.haltReason ?? null,
  };
}

/** Overtime claims for one employee, newest day first, each with its approval state. */
export async function overtimeFor(employeeId: string, limit = 30): Promise<OvertimeClaim[]> {
  if (!isUuid(employeeId)) return [];
  const n = Math.min(Math.max(Number(limit) || 30, 1), LIST_LIMIT);
  try {
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      SELECT o.*, e.full_name AS employee_name
        FROM hr_overtime_requests o
        LEFT JOIN hr_employees e ON e.id = o.employee_id
       WHERE o.employee_id = ${employeeId}::uuid
       ORDER BY o.work_date DESC, o.created_at DESC
       LIMIT ${n}`);
    const out: OvertimeClaim[] = [];
    for (const row of rows(r)) {
      out.push(mapOvertime(row, await instanceForRecord('overtime', String(row.id))));
    }
    return out;
  } catch (e: any) {
    logFail('overtimeFor', e);
    return [];
  }
}

/** Withdraw a claim that has not been applied. */
export async function withdrawOvertime(claimId: string, employeeId: string): Promise<WriteResult> {
  if (!isUuid(claimId) || !isUuid(employeeId)) return { ok: false, error: 'That is not an overtime claim.' };
  try {
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      UPDATE hr_overtime_requests SET withdrawn_at = NOW()
       WHERE id = ${claimId}::uuid AND employee_id = ${employeeId}::uuid
         AND applied_at IS NULL AND withdrawn_at IS NULL
      RETURNING id`);
    return rows(r).length ? { ok: true, id: claimId, changed: true } : { ok: true, changed: false };
  } catch (e: any) {
    logFail('withdrawOvertime', e);
    return { ok: false, error: errText(e, 'The claim could not be withdrawn.') };
  }
}

/**
 * APPLY AN APPROVED OVERTIME CLAIM.
 *
 * THE GUARD IS THE POINT: this re-reads the workflow instance and refuses unless the ENGINE says
 * 'approved'. No argument lets a caller assert approval and no path in this file credits anything
 * without that check. Applying is idempotent — applied_at is written in the same breath, and the
 * comp-off ledger is keyed on this claim's id so a retry credits once.
 *
 * TWO THINGS HAPPEN, IN THIS ORDER:
 *   1. The minutes are written onto the day (hr_attendance.overtime_hours, a column that has existed
 *      since the HR schema was written and that nothing has ever filled in).
 *   2. If the claim asked for comp off, the ledger is credited through src/lib/hr-leave.ts. If it
 *      asked for pay, NOTHING here pays anybody: the hours are on the day for payroll to read, which
 *      is a person's decision on a payroll run and not an automatic transfer.
 */
export async function applyApprovedOvertime(claimId: string): Promise<WorkingTimeResult> {
  if (!isUuid(claimId)) return { ok: false, error: 'That is not an overtime claim.' };

  try {
    await ensureWorkingTimeSchema();
    const list = rows(await db.execute(sql`
      SELECT * FROM hr_overtime_requests WHERE id = ${claimId}::uuid LIMIT 1`));
    if (!list.length) return { ok: false, error: 'That claim no longer exists.' };
    const claim = list[0];
    if (claim.applied_at) return { ok: true, id: claimId, changed: false };
    if (claim.withdrawn_at) return { ok: false, error: 'That claim was withdrawn.' };

    const wf = await instanceForRecord('overtime', claimId);
    if (!wf) return { ok: false, error: 'That claim has no approval attached, so there is nothing to apply.' };
    if (wf.state !== 'approved') {
      return { ok: false, error: 'That claim is ' + wf.state + ', not approved, so nothing is credited.' };
    }

    const minutes = Number(claim.minutes) || 0;
    const workDate = String(claim.work_date).slice(0, 10);
    const employeeId = String(claim.employee_id);
    const hours = minutesToHours(minutes);

    await db.execute(sql`
      INSERT INTO hr_attendance (employee_id, date, overtime_hours, status, work_mode, source)
      VALUES (${employeeId}::uuid, ${workDate}::date, ${hours}, 'present', 'remote', 'overtime')
      ON CONFLICT (employee_id, date) DO UPDATE
        SET overtime_hours = ${hours}`);

    let creditNote = '';
    if (String(claim.convert_to) === 'comp_off') {
      const shift = await shiftOn(employeeId, workDate);
      const dayMinutes = shiftExpectedMinutes(shift) || 8 * 60;
      const units = compOffUnitsFor(minutes, dayMinutes);
      if (units > 0) {
        // Dynamically imported: src/lib/hr-leave.ts imports this module back for shift lengths, and a
        // static pair would be a load-time cycle.
        const { creditCompOff } = await import('@/lib/hr-leave');
        const credited = await creditCompOff({
          employeeId,
          units,
          source: claim.worked_holiday === true ? 'holiday_work' : 'overtime',
          sourceRef: claimId,
          earnedOn: workDate,
          note: 'Approved overtime on ' + workDate + ' (' + formatMinutes(minutes) + ')',
        });
        if (!credited.ok) {
          // NOT SWALLOWED. The day carries the hours; the ledger does not. Say so, so somebody can
          // fix it rather than the employee discovering the missing day months later.
          return {
            ok: false,
            id: claimId,
            error: 'The hours were recorded on ' + workDate + ' but the comp off could not be credited: ' +
              (credited.error || 'no reason given') + '. The claim has not been marked applied, so it can be retried.',
          };
        }
        creditNote = units + ' day(s) of comp off credited.';
      } else {
        creditNote = 'Recorded as overtime hours. It is shorter than a quarter of a shift, so it earns no comp-off day.';
      }
    }

    await db.execute(sql`
      UPDATE hr_overtime_requests SET applied_at = NOW()
       WHERE id = ${claimId}::uuid AND applied_at IS NULL`);

    return { ok: true, id: claimId, changed: true, state: 'approved', note: creditNote || null };
  } catch (e: any) {
    logFail('applyApprovedOvertime', e);
    return { ok: false, error: errText(e, 'The approved claim could not be applied.') };
  }
}

/**
 * Apply every overtime claim the engine has approved and that has not been credited yet.
 *
 * Called when an overtime screen loads, for the same reason applyApprovedCorrections() is: the
 * approval and the credit are two separate facts, and without this reconciliation somebody would see
 * an "Approved" chip over a comp-off balance that had not moved.
 */
export async function applyApprovedOvertimeClaims(employeeId?: string | null, limit = 20): Promise<number> {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  try {
    await ensureWorkingTimeSchema();
    const scope = isUuid(employeeId) ? sql`AND o.employee_id = ${employeeId}::uuid` : sql``;
    const r = await db.execute(sql`
      SELECT o.id
        FROM hr_overtime_requests o
        JOIN workflow_instances w ON w.domain = 'overtime' AND w.record_id = o.id::text
       WHERE o.applied_at IS NULL AND o.withdrawn_at IS NULL AND w.state = 'approved'
         ${scope}
       ORDER BY o.work_date DESC
       LIMIT ${n}`);
    let applied = 0;
    for (const row of rows(r)) {
      const res = await applyApprovedOvertime(String(row.id));
      if (res.ok && res.changed) applied++;
    }
    return applied;
  } catch (e: any) {
    logFail('applyApprovedOvertimeClaims', e);
    return 0;
  }
}

// =================================================================================================
// WEEKLY TIMESHEETS — WHAT THE PERSON SAYS THE WEEK WAS
// =================================================================================================

export interface TimesheetEntryInput {
  dateIso: string;
  minutes: number;
  workMode?: string | null;
  project?: string | null;
  note?: string | null;
}

export interface TimesheetEntry {
  id: string;
  dateIso: string;
  weekday: string;
  minutes: number;
  workMode: string | null;
  project: string | null;
  note: string | null;
}

export interface SubmittedTimesheet {
  id: string;
  employeeId: string;
  employeeName: string | null;
  weekStart: string;
  weekEnd: string;
  note: string | null;
  submittedAt: string | null;
  withdrawnAt: string | null;
  entries: TimesheetEntry[];
  totalMinutes: number;
  workflow: WorkflowInstanceRow | null;
}

function mapTimesheetEntry(row: any): TimesheetEntry {
  const dateIso = row?.work_date ? String(row.work_date).slice(0, 10) : '';
  return {
    id: String(row?.id ?? ''),
    dateIso,
    weekday: weekdayName(dateIso),
    minutes: Number(row?.minutes) || 0,
    workMode: row?.work_mode ? String(row.work_mode) : null,
    project: row?.project ? String(row.project) : null,
    note: row?.note ? String(row.note) : null,
  };
}

/** One submitted week for one person, with its entries and its approval. Null when never submitted. */
export async function timesheetFor(employeeId: string, anyDayInWeek: string): Promise<SubmittedTimesheet | null> {
  if (!isUuid(employeeId)) return null;
  const weekStart = weekStartIso(isDateIso(anyDayInWeek) ? anyDayInWeek : '');
  if (!isDateIso(weekStart)) return null;
  try {
    await ensureWorkingTimeSchema();
    const head = rows(await db.execute(sql`
      SELECT t.*, e.full_name AS employee_name
        FROM hr_timesheets t
        LEFT JOIN hr_employees e ON e.id = t.employee_id
       WHERE t.employee_id = ${employeeId}::uuid AND t.week_start = ${weekStart}::date
       LIMIT 1`));
    if (!head.length) return null;
    const id = String(head[0].id);
    const entries = rows(await db.execute(sql`
      SELECT * FROM hr_timesheet_entries WHERE timesheet_id = ${id}::uuid ORDER BY work_date ASC`))
      .map(mapTimesheetEntry);
    return {
      id,
      employeeId,
      employeeName: head[0].employee_name ? String(head[0].employee_name) : null,
      weekStart,
      weekEnd: shiftDateIso(weekStart, 6),
      note: head[0].note ? String(head[0].note) : null,
      submittedAt: head[0].submitted_at ? new Date(head[0].submitted_at).toISOString() : null,
      withdrawnAt: head[0].withdrawn_at ? new Date(head[0].withdrawn_at).toISOString() : null,
      entries,
      totalMinutes: entries.reduce((sum, e) => sum + e.minutes, 0),
      workflow: await instanceForRecord('timesheet', id),
    };
  } catch (e: any) {
    logFail('timesheetFor', e);
    return null;
  }
}

/** The weeks this person has submitted, newest first. */
export async function timesheetsFor(employeeId: string, limit = 12): Promise<SubmittedTimesheet[]> {
  if (!isUuid(employeeId)) return [];
  const n = Math.min(Math.max(Number(limit) || 12, 1), 52);
  try {
    await ensureWorkingTimeSchema();
    const heads = rows(await db.execute(sql`
      SELECT week_start FROM hr_timesheets
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY week_start DESC LIMIT ${n}`));
    const out: SubmittedTimesheet[] = [];
    for (const h of heads) {
      const t = await timesheetFor(employeeId, String(h.week_start).slice(0, 10));
      if (t) out.push(t);
    }
    return out;
  } catch (e: any) {
    logFail('timesheetsFor', e);
    return [];
  }
}

/**
 * SUBMIT A WEEK FOR APPROVAL.
 *
 * A RESUBMISSION IS ALLOWED ONLY WHILE NOTHING HAS SETTLED. Once the engine has approved a week, the
 * rows are evidence of what somebody signed off and this refuses to rewrite them — a changed mind is
 * a conversation with the approver, not a silent edit under an approval that already happened. That
 * is the same discipline workflow.ts applies to its own terminal states.
 *
 * ENTRIES ARE UPSERTED PER DAY, so a resubmission corrects the days it names and leaves the rest.
 *
 * IT DOES NOT WRITE hr_attendance. The punches are what the clock saw; this is what the person says.
 * Two writers for one day's hours is the fault attendance-schema.ts's header warns about, and a
 * timesheet that overwrote punches would let anybody rewrite their own recorded attendance.
 */
export async function submitTimesheet(input: {
  employeeId: string;
  weekStart: string;
  entries: TimesheetEntryInput[];
  note?: string | null;
  submittedByUserId?: string | null;
}): Promise<WorkingTimeResult> {
  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  const weekStart = weekStartIso(String(input?.weekStart || ''));
  if (!isDateIso(weekStart)) return { ok: false, error: 'That is not a week.' };
  const weekEnd = shiftDateIso(weekStart, 6);
  const note = input?.note ? String(input.note).slice(0, 1000) : null;
  const by = isUuid(input?.submittedByUserId) ? String(input.submittedByUserId) : null;

  const clean: TimesheetEntryInput[] = [];
  for (const e of input?.entries || []) {
    const dateIso = String(e?.dateIso || '');
    if (!isDateIso(dateIso) || dateIso < weekStart || dateIso > weekEnd) continue;
    const minutes = Math.max(0, Math.min(MAX_DAY_MINUTES, Math.round(Number(e?.minutes) || 0)));
    const mode = WORK_MODES.includes(String(e?.workMode) as WorkMode) ? String(e?.workMode) : null;
    clean.push({
      dateIso,
      minutes,
      workMode: mode,
      project: e?.project ? String(e.project).trim().slice(0, 160) : null,
      note: e?.note ? String(e.note).trim().slice(0, 400) : null,
    });
  }
  if (!clean.length) return { ok: false, error: 'A timesheet needs at least one day on it.' };
  if (!clean.some((e) => e.minutes > 0)) {
    return { ok: false, error: 'Every day on that timesheet is zero. Put some hours on it, or leave the week unsubmitted.' };
  }

  const existing = await timesheetFor(employeeId, weekStart);
  if (existing?.workflow && (existing.workflow.state === 'approved' || existing.workflow.state === 'rejected')) {
    return {
      ok: false,
      error: 'That week has already been ' + existing.workflow.state +
        '. It cannot be rewritten - talk to your manager and, if it needs changing, ask for an attendance correction on the days concerned.',
    };
  }

  let timesheetId = existing?.id || '';
  try {
    await ensureWorkingTimeSchema();
    if (!timesheetId) {
      const ins = rows(await db.execute(sql`
        INSERT INTO hr_timesheets (employee_id, week_start, note, submitted_by_user_id, submitted_at)
        VALUES (${employeeId}::uuid, ${weekStart}::date, ${note}, ${by}::uuid, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id`));
      if (!ins.length) {
        // The unique index won a race the read could not see. Read the winner back.
        const raced = await timesheetFor(employeeId, weekStart);
        if (!raced) return { ok: false, error: 'The timesheet was not saved and the database did not say why.' };
        timesheetId = raced.id;
      } else {
        timesheetId = String(ins[0].id);
      }
    } else {
      await db.execute(sql`
        UPDATE hr_timesheets
           SET note = ${note}, submitted_by_user_id = ${by}::uuid, submitted_at = NOW(), withdrawn_at = NULL
         WHERE id = ${timesheetId}::uuid`);
    }

    for (const e of clean) {
      await db.execute(sql`
        INSERT INTO hr_timesheet_entries (timesheet_id, work_date, minutes, work_mode, project, note)
        VALUES (${timesheetId}::uuid, ${e.dateIso}::date, ${e.minutes}, ${e.workMode}, ${e.project}, ${e.note})
        ON CONFLICT (timesheet_id, work_date) DO UPDATE
          SET minutes = EXCLUDED.minutes,
              work_mode = EXCLUDED.work_mode,
              project = EXCLUDED.project,
              note = EXCLUDED.note`);
    }
  } catch (e: any) {
    logFail('submitTimesheet', e);
    return { ok: false, error: errText(e, 'The timesheet could not be saved.') };
  }

  const total = clean.reduce((sum, e) => sum + e.minutes, 0);
  const started = await startWorkflow({
    domain: 'timesheet',
    recordId: timesheetId,
    subjectEmployeeId: employeeId,
    requestedByUserId: by,
    createdByUserId: by,
    summary: 'Timesheet for the week of ' + weekStart + ': ' + formatMinutes(total),
  });

  if (!started.ok) {
    return {
      ok: false,
      id: timesheetId,
      error: 'Your timesheet was saved but it could not be sent for approval: ' +
        (started.error || 'the approval engine did not say why') +
        '. Nothing is lost - tell HR and it can be sent again.',
    };
  }

  // A RESUBMITTED WEEK WHOSE APPROVAL HALTED IS RE-ROUTED, not left where it was. startWorkflow() is
  // idempotent on (domain, record_id), so a second submit returns the SAME halted instance rather
  // than trying again — which would mean a week that halted before the reporting line was recorded
  // could never be sent to anybody, however many times the person pressed the button. resumeWorkflow
  // re-resolves the route and refuses anything that is not halted, so it cannot disturb a live or
  // settled approval.
  let state = started.state;
  let haltReason = started.haltReason ?? null;
  if (started.state === 'halted' && started.instanceId) {
    const resumed = await resumeWorkflow(started.instanceId, { id: by });
    if (resumed.ok) {
      state = resumed.state;
      haltReason = null;
    } else {
      haltReason = resumed.haltReason ?? haltReason;
    }
  }

  return {
    ok: true,
    changed: true,
    id: timesheetId,
    instanceId: started.instanceId,
    state,
    haltReason,
  };
}

/** Withdraw a submitted week that has not settled. */
export async function withdrawTimesheet(timesheetId: string, employeeId: string): Promise<WriteResult> {
  if (!isUuid(timesheetId) || !isUuid(employeeId)) return { ok: false, error: 'That is not a timesheet.' };
  try {
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      UPDATE hr_timesheets SET withdrawn_at = NOW()
       WHERE id = ${timesheetId}::uuid AND employee_id = ${employeeId}::uuid AND withdrawn_at IS NULL
      RETURNING id`);
    return rows(r).length ? { ok: true, id: timesheetId, changed: true } : { ok: true, changed: false };
  } catch (e: any) {
    logFail('withdrawTimesheet', e);
    return { ok: false, error: errText(e, 'The timesheet could not be withdrawn.') };
  }
}

// =================================================================================================
// REPORTS — PER EMPLOYEE AND PER DEPARTMENT
// =================================================================================================
//
// AGGREGATES OVER A PERIOD, built from hr_attendance and nothing else. No wellness, health or
// personal data is joined into either of these and none is available to join: they read days,
// statuses, hours and the leave UNITS on a day — never why somebody was away.

export interface AttendanceReportRow {
  employeeId: string;
  name: string;
  code: string | null;
  departmentId: string | null;
  departmentName: string | null;
  recordedDays: number;
  presentDays: number;
  wfhDays: number;
  leaveDays: number;
  absentDays: number;
  holidayDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Part-day leave taken on days that are otherwise worked. */
  partialLeaveUnits: number;
}

function mapReportRow(row: any): AttendanceReportRow {
  return {
    employeeId: String(row?.employee_id ?? ''),
    name: String(row?.full_name ?? ''),
    code: row?.employee_code ? String(row.employee_code) : null,
    departmentId: row?.department_id ? String(row.department_id) : null,
    departmentName: row?.department_name ? String(row.department_name) : null,
    recordedDays: Number(row?.recorded_days) || 0,
    presentDays: Number(row?.present_days) || 0,
    wfhDays: Number(row?.wfh_days) || 0,
    leaveDays: Number(row?.leave_days) || 0,
    absentDays: Number(row?.absent_days) || 0,
    holidayDays: Number(row?.holiday_days) || 0,
    workedMinutes: Math.round((Number(row?.work_hours) || 0) * 60),
    overtimeMinutes: Math.round((Number(row?.overtime_hours) || 0) * 60),
    partialLeaveUnits: Math.round((Number(row?.partial_leave) || 0) * 100) / 100,
  };
}

export interface ReportRange {
  from: string;
  to: string;
  departmentId?: string | null;
  employeeId?: string | null;
  limit?: number;
}

/**
 * One row per employee for a period.
 *
 * ONE QUERY, GROUPED IN POSTGRES rather than a loop of per-person reads: an HR desk asking for a
 * month across two hundred people would otherwise be two hundred round trips on a pooled connection.
 *
 * department_id is compared as ::text on BOTH sides. departments.id is a varchar slug in
 * src/lib/db/schema.ts and a UUID in db/hr-schema.sql, and a ::uuid cast throws on half of them.
 */
export async function employeeAttendanceReport(opts: ReportRange): Promise<AttendanceReportRow[]> {
  const from = String(opts?.from || '');
  const to = String(opts?.to || '');
  if (!isDateIso(from) || !isDateIso(to) || to < from) return [];
  const n = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
  const dept = opts?.departmentId ? String(opts.departmentId).trim() : '';
  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();
    const deptScope = dept ? sql`AND e.department_id::text = ${dept}::text` : sql``;
    const empScope = isUuid(opts?.employeeId) ? sql`AND e.id = ${String(opts?.employeeId)}::uuid` : sql``;
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name, e.employee_code,
             e.department_id::text AS department_id, d.name AS department_name,
             COUNT(a.id)::int AS recorded_days,
             COUNT(*) FILTER (WHERE a.status = 'present')::int  AS present_days,
             COUNT(*) FILTER (WHERE a.status = 'wfh')::int      AS wfh_days,
             COUNT(*) FILTER (WHERE a.status = 'on_leave')::int AS leave_days,
             COUNT(*) FILTER (WHERE a.status = 'absent')::int   AS absent_days,
             COUNT(*) FILTER (WHERE a.status = 'holiday')::int  AS holiday_days,
             COALESCE(SUM(a.work_hours), 0)     AS work_hours,
             COALESCE(SUM(a.overtime_hours), 0) AS overtime_hours,
             COALESCE(SUM(CASE WHEN a.status <> 'on_leave' THEN a.leave_units ELSE 0 END), 0) AS partial_leave
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
        LEFT JOIN hr_attendance a
               ON a.employee_id = e.id
              AND a.date >= ${from}::date
              AND a.date <= ${to}::date
       WHERE e.is_active = TRUE
         ${deptScope}
         ${empScope}
       GROUP BY e.id, e.full_name, e.employee_code, e.department_id, d.name
       ORDER BY e.full_name ASC
       LIMIT ${n}`);
    return rows(r).map(mapReportRow);
  } catch (e: any) {
    logFail('employeeAttendanceReport', e);
    return [];
  }
}

export interface DepartmentAttendanceRow {
  departmentId: string | null;
  departmentName: string;
  employees: number;
  recordedDays: number;
  presentDays: number;
  wfhDays: number;
  leaveDays: number;
  absentDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Average worked minutes per RECORDED day, so a small team is not flattered by a big one. */
  averageMinutesPerRecordedDay: number;
}

/** The same period, one row per department. Aggregate only; there is no drill-down to a person. */
export async function departmentAttendanceReport(opts: ReportRange): Promise<DepartmentAttendanceRow[]> {
  const from = String(opts?.from || '');
  const to = String(opts?.to || '');
  if (!isDateIso(from) || !isDateIso(to) || to < from) return [];
  try {
    await ensureAttendanceSchema();
    await ensureWorkingTimeSchema();
    const r = await db.execute(sql`
      SELECT e.department_id::text AS department_id,
             COALESCE(d.name, 'No department recorded') AS department_name,
             COUNT(DISTINCT e.id)::int AS employees,
             COUNT(a.id)::int AS recorded_days,
             COUNT(*) FILTER (WHERE a.status = 'present')::int  AS present_days,
             COUNT(*) FILTER (WHERE a.status = 'wfh')::int      AS wfh_days,
             COUNT(*) FILTER (WHERE a.status = 'on_leave')::int AS leave_days,
             COUNT(*) FILTER (WHERE a.status = 'absent')::int   AS absent_days,
             COALESCE(SUM(a.work_hours), 0)     AS work_hours,
             COALESCE(SUM(a.overtime_hours), 0) AS overtime_hours
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
        LEFT JOIN hr_attendance a
               ON a.employee_id = e.id
              AND a.date >= ${from}::date
              AND a.date <= ${to}::date
       WHERE e.is_active = TRUE
       GROUP BY e.department_id, d.name
       ORDER BY department_name ASC
       LIMIT 100`);
    return rows(r).map((row: any) => {
      const recorded = Number(row?.recorded_days) || 0;
      const worked = Math.round((Number(row?.work_hours) || 0) * 60);
      return {
        departmentId: row?.department_id ? String(row.department_id) : null,
        departmentName: String(row?.department_name ?? 'No department recorded'),
        employees: Number(row?.employees) || 0,
        recordedDays: recorded,
        presentDays: Number(row?.present_days) || 0,
        wfhDays: Number(row?.wfh_days) || 0,
        leaveDays: Number(row?.leave_days) || 0,
        absentDays: Number(row?.absent_days) || 0,
        workedMinutes: worked,
        overtimeMinutes: Math.round((Number(row?.overtime_hours) || 0) * 60),
        averageMinutesPerRecordedDay: recorded > 0 ? Math.round(worked / recorded) : 0,
      };
    });
  } catch (e: any) {
    logFail('departmentAttendanceReport', e);
    return [];
  }
}
