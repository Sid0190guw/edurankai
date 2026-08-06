// src/lib/hr-leave.ts — HRMS LEAVE. Allowances, part-days, comp off, and what an approved request
// does to the attendance record.
//
// =================================================================================================
// WHAT THIS OWNS
// =================================================================================================
//
//   hr_leave_request        one row per request, of every kind: whole days, half days, hours, and
//                           work-from-home. ONE TABLE, because "was Priya off on the 12th" must have
//                           one answer, and a second request table for part-days would mean two.
//   hr_comp_off_credits     the comp-off ledger. Earned only from an APPROVED overtime claim or an
//                           approved worked holiday, expiring, and consumable like any allowance.
//
// Requests are approved or rejected by whoever holds `leave.approve`, or by that employee's own
// reporting manager (the same permission chain as payouts). Self-bootstrapping.
//
// =================================================================================================
// NOTHING HERE EVER GRANTS ITSELF ANYTHING
// =================================================================================================
//
// COMP OFF IS NOT EARNED BY WORKING LATE. It is earned when an overtime claim or a worked-holiday
// claim is APPROVED through src/lib/workflow.ts and src/lib/attendance.ts then calls creditCompOff()
// with that approval's id. There is no code path in this file that credits the ledger from hours, a
// punch, a date or a schedule — creditCompOff() has to be called by something holding an approval,
// and it refuses a credit that carries no source reference. A clock left running overnight must
// never quietly become a day off.
//
// =================================================================================================
// PART DAYS: WHY day_units EXISTS AND days STAYED
// =================================================================================================
//
// hr_leave_request.days is `INT NOT NULL` and every row already in the database was written under
// it. Retyping that column would rewrite history and break every reader that expects a whole number,
// so a half day is stored as days = 1 (the calendar span it occupies) and day_units = 0.5 (what it
// actually costs). ALL BALANCE ARITHMETIC READS COALESCE(day_units, days), so rows written before
// this existed keep counting exactly as they always did.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. `r.rows[0]` is always a bug here.
//   - The real Postgres reason is on `e.cause`; `e.message` is only the failed SQL.
//   - NO EXCEPTION IS SWALLOWED IN A WRITE PATH. applyLeave, decideLeave and the ledger writers all
//     return { ok: false, error } carrying a real reason.
//   - Every const is declared above the function that reads it.
//   - department ids are compared as TEXT, never cast ::uuid.
//   - NO BACKTICK inside a sql template, not even in a comment.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { approverRole } from '@/lib/hr-wallet';
import { decidesEveryRequest } from '@/lib/auth/capability';
import { leaveSpan, observedDates, type HolidayScope } from '@/lib/holidays';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// Declared ABOVE safe(), which calls it. `const` is not hoisted and a helper under its first reader
// has taken pages down on this project.
const logFail = (tag: string, e: any) =>
  console.error('[hr-leave] ' + tag, e?.cause?.message || e?.message);

/**
 * A read that degrades to "nothing" rather than throwing — AND SAYS SO IN THE LOG.
 *
 * The bare `catch { return [] }` this replaces made a FAILED read and an EMPTY table the same
 * observable fact, with nothing written down anywhere. Every screen behind it showed "no leave
 * requests" and no operator could tell the difference between a person with no leave and a query
 * that had died. The tolerance is kept, because a broken read must not blank a whole console; the
 * silence is not.
 *
 * WHERE THE ANSWER DECIDES SOMETHING RATHER THAN RENDERS SOMETHING, DO NOT USE THIS — use
 * strictRead() below, which throws so the caller can refuse.
 */
async function safe(q: any, tag = 'read'): Promise<any[]> {
  try {
    return rows(await db.execute(q));
  } catch (e: any) {
    logFail('safe.' + tag, e);
    return [];
  }
}

/** The same read with no tolerance: it throws, so a caller that is about to grant something can refuse. */
async function strictRead(q: any): Promise<any[]> {
  return rows(await db.execute(q));
}

const errText = (e: any, fallback: string) =>
  String(e?.cause?.message || e?.message || fallback).slice(0, 400);

// -------------------------------------------------------------------------------------------------
// THE LEAVE TYPES
// -------------------------------------------------------------------------------------------------

/**
 * What a request can be, and what each kind costs.
 *
 *   allowance   days a year. 0 means "not counted against an annual allowance" — either because the
 *               type is unpaid, or because its balance comes from the comp-off ledger, or because it
 *               is not an absence at all.
 *   kind        'absence'   the person is not working that day.
 *               'work_mode' the person IS working; only WHERE changes. Work from home is this, and
 *                           that is the whole reason it is a type here rather than a leave type in
 *                           name only: markLeaveAttendance() writes it as 'wfh' and it never touches
 *                           an allowance or shows up as absence in a report.
 *   source      'allowance' counted against the annual number above.
 *               'ledger'    counted against hr_comp_off_credits.
 *               'none'      uncounted (unpaid leave, and work from home).
 *   halfDay     a request for this type may be half a day.
 *   hourly      a request for this type may be a number of hours.
 *
 * MATERNITY, PATERNITY AND BEREAVEMENT ARE WHOLE DAYS ONLY, deliberately. Splitting a bereavement
 * into two hours is not a thing anybody needs, and maternity leave is a continuous statutory block —
 * offering an hourly version of it would be a form that invites a mistake in a hard week.
 *
 * THE ALLOWANCES ARE THIS ORGANISATION'S NUMBERS, not a claim about anybody's statutory rights. They
 * are here to be edited by whoever sets the policy; nothing in this file treats them as law.
 */
export interface LeaveType {
  id: string;
  name: string;
  allowance: number;
  kind: 'absence' | 'work_mode';
  source: 'allowance' | 'ledger' | 'none';
  halfDay: boolean;
  hourly: boolean;
  /** One line a person reads on the request form. */
  note: string;
}

export const LEAVE_TYPES: LeaveType[] = [
  { id: 'casual', name: 'Casual', allowance: 12, kind: 'absence', source: 'allowance', halfDay: true, hourly: true,
    note: 'Short notice time off. Can be taken as a half day or a few hours.' },
  { id: 'sick', name: 'Sick', allowance: 12, kind: 'absence', source: 'allowance', halfDay: true, hourly: true,
    note: 'For illness. Can be taken as a half day or a few hours.' },
  { id: 'earned', name: 'Earned / privilege', allowance: 15, kind: 'absence', source: 'allowance', halfDay: true, hourly: false,
    note: 'Planned time off, usually booked in advance.' },
  { id: 'maternity', name: 'Maternity', allowance: 182, kind: 'absence', source: 'allowance', halfDay: false, hourly: false,
    note: 'A continuous block of whole days. Talk to HR about dates before you file it.' },
  { id: 'paternity', name: 'Paternity', allowance: 15, kind: 'absence', source: 'allowance', halfDay: false, hourly: false,
    note: 'Whole days, taken around the birth or adoption of a child.' },
  { id: 'bereavement', name: 'Bereavement', allowance: 5, kind: 'absence', source: 'allowance', halfDay: false, hourly: false,
    note: 'Whole days, after a death in the family. Nobody will ask you for detail.' },
  { id: 'comp_off', name: 'Comp off', allowance: 0, kind: 'absence', source: 'ledger', halfDay: true, hourly: false,
    note: 'Earned from approved overtime or a worked holiday. Expires, so use it before it does.' },
  { id: 'wfh', name: 'Work from home', allowance: 0, kind: 'work_mode', source: 'none', halfDay: false, hourly: false,
    note: 'You are working, from elsewhere. This is not absence and it costs no leave.' },
  { id: 'unpaid', name: 'Unpaid', allowance: 0, kind: 'absence', source: 'none', halfDay: true, hourly: true,
    note: 'No allowance is used and the day is not paid.' },
];

const TYPE_IDS = new Set(LEAVE_TYPES.map((t) => t.id));

/** The definition for a type id, or null. Never throws — an unknown id is a refusal, not a crash. */
export function leaveType(id: string): LeaveType | null {
  return LEAVE_TYPES.find((t) => t.id === String(id || '')) || null;
}

/** Plain words for a type id, for a screen. Falls back to the id so nothing renders blank. */
export function leaveTypeName(id: string): string {
  return leaveType(id)?.name || String(id || 'Leave');
}

/** The units a request can be made in. */
export const LEAVE_UNITS = ['full', 'half', 'hours'] as const;
export type LeaveUnit = (typeof LEAVE_UNITS)[number];

/** Which half of the day a half-day request is. */
export const DAY_PARTS = ['first_half', 'second_half'] as const;
export type DayPart = (typeof DAY_PARTS)[number];

export const DAY_PART_LABELS: Record<DayPart, string> = {
  first_half: 'First half of the day',
  second_half: 'Second half of the day',
};

/**
 * The working day hourly leave is measured against, when the person has no rostered shift.
 *
 * Used ONLY to convert hours into a fraction of a day for the balance. When a shift IS rostered, the
 * shift's own expected minutes are used instead — see dayMinutesFor() — so an eight-hour rule is
 * never imposed on somebody working a six-hour one.
 */
export const DEFAULT_DAY_MINUTES = 8 * 60;

/** Hourly leave shorter than this is not worth a request; longer than a day is not hourly. */
const MIN_LEAVE_HOURS = 0.5;

/** How long comp off lasts before it expires, when the credit does not say. */
export const COMP_OFF_EXPIRY_DAYS = 90;

/** A single request may not span more than this. A typo must not write a year of rows. */
const MAX_SPAN_DAYS = 400;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * Create the leave tables and the columns part-days need. Idempotent, safe on every request.
 *
 * The catch RE-THROWS after logging: ensureOnce() drops a failed run from its cache so the next call
 * retries, and swallows the rejection for the caller so consumers keep the tolerate-missing-schema
 * behaviour the rest of this codebase relies on. The previous version of this function caught and
 * discarded silently, which meant a schema that never appeared also never said why.
 */
export function ensureLeaveSchema(): Promise<void> {
  return ensureOnce('hr_leave_v2', async () => {
    try {
      await createLeaveTables();
    } catch (e: any) {
      logFail('ensureLeaveSchema', e);
      throw e;
    }
  });
}

async function createLeaveTables(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_leave_request (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    leave_type TEXT NOT NULL,
    start_date DATE NOT NULL, end_date DATE NOT NULL, days INT NOT NULL,
    reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_by UUID, decided_by_role TEXT, decided_at TIMESTAMPTZ, decision_note TEXT)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_leave_status ON hr_leave_request (status, requested_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_leave_emp ON hr_leave_request (employee_id, start_date DESC)`);

  // PART DAYS. Additive columns on the table that already exists — see the header for why days
  // stayed an INT. day_units is what the request COSTS; days is the calendar span it occupies.
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS day_units NUMERIC(6,2)`);
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS hours NUMERIC(6,2)`);
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS day_part TEXT`);
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'full'`);

  // -----------------------------------------------------------------------------------------
  // THE COMP-OFF LEDGER.
  //
  // A CREDIT, NOT A BALANCE FIELD. Comp off is earned one approval at a time, each with its own
  // expiry, so "how much comp off does Ravi have" is a question about which credits are still
  // alive today — a single number on hr_employees could not answer it and would silently keep
  // expired days spendable.
  //
  // source_ref IS THE APPROVAL THAT EARNED IT (hr_overtime_requests.id). The partial unique index
  // on it is what makes crediting IDEMPOTENT: a retried settlement, a double-clicked apply, or two
  // page loads racing each other all insert the same row once. Without it, one approved evening
  // could pay out three times.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS hr_comp_off_credits (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id    UUID NOT NULL,
      units          NUMERIC(5,2) NOT NULL,
      consumed_units NUMERIC(5,2) NOT NULL DEFAULT 0,
      earned_on      DATE NOT NULL DEFAULT CURRENT_DATE,
      expires_on     DATE NOT NULL,
      source         TEXT NOT NULL,
      source_ref     TEXT,
      note           TEXT,
      created_by     UUID,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS hr_comp_off_emp_idx
      ON hr_comp_off_credits (employee_id, expires_on)`);
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_comp_off_source
        ON hr_comp_off_credits (source, source_ref) WHERE source_ref IS NOT NULL`);
  } catch (e: any) {
    // An existing table with a duplicate credit would reject this. Log it and carry on: creditCompOff
    // also re-reads before inserting, so the invariant holds through the only writer either way.
    logFail('hr_comp_off_source', e);
  }
}

// -------------------------------------------------------------------------------------------------
// PURE HELPERS
// -------------------------------------------------------------------------------------------------

/**
 * Calendar days from a to b, both ends included.
 *
 * PARSED AS UTC ('T00:00:00Z'), not as local midnight. The old form parsed in the process timezone
 * and every consumer of the result then formatted with toISOString(), which is UTC — arithmetic in
 * one zone, formatting in another. On this server the two happen to agree; anywhere they do not, a
 * leave range silently gains or loses its first day. src/lib/attendance.ts already does its date
 * arithmetic this way and this now matches it.
 */
function daysBetween(a: string, b: string): number {
  const d1 = new Date(a + 'T00:00:00Z'), d2 = new Date(b + 'T00:00:00Z');
  if (isNaN(d1.getTime()) || isNaN(d2.getTime()) || d2 < d1) return 0;
  return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
}

/** Round to two decimals. Day units are money-shaped: 0.5, 0.13, 1.25. */
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** '1 day', 'half a day', '2 hours' — what a request cost, in words a person reads. */
export function describeUnits(unit: string, dayUnits: number, hours: number | null): string {
  if (unit === 'hours' && hours) return hours === 1 ? '1 hour' : hours + ' hours';
  if (unit === 'half') return 'half a day';
  const u = round2(dayUnits);
  if (!u) return 'nothing';
  return u === 1 ? '1 day' : u + ' days';
}

// -------------------------------------------------------------------------------------------------
// EMPLOYEE FACTS THE ARITHMETIC NEEDS
// -------------------------------------------------------------------------------------------------

/** hr_employees.department_id as TEXT, for holiday scope. Null is the ordinary case here. */
async function departmentOf(employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  const list = await safe(sql`
    SELECT department_id::text AS d FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`);
  return list.length && list[0].d ? String(list[0].d) : null;
}

/**
 * How many minutes a full working day is for this person.
 *
 * From their rostered shift when they have one, so hourly leave for somebody on a six-hour shift
 * costs a sixth of a day per hour rather than an eighth. The roster module is imported DYNAMICALLY
 * because src/lib/attendance.ts imports this file back (markLeaveAttendance) — a static pair would
 * be a load-time cycle.
 */
async function dayMinutesFor(employeeId: string, dateIso: string): Promise<number> {
  try {
    const { shiftOn, shiftExpectedMinutes } = await import('@/lib/attendance');
    const shift = await shiftOn(employeeId, dateIso);
    const mins = shiftExpectedMinutes(shift);
    return mins > 0 ? mins : DEFAULT_DAY_MINUTES;
  } catch (e: any) {
    logFail('dayMinutesFor', e);
    return DEFAULT_DAY_MINUTES;
  }
}

/** The holiday scope for one employee: their department, and no location claim. See holidays.ts. */
async function scopeFor(employeeId: string): Promise<HolidayScope> {
  return { departmentId: await departmentOf(employeeId) };
}

// -------------------------------------------------------------------------------------------------
// THE COMP-OFF LEDGER
// -------------------------------------------------------------------------------------------------

export interface CompOffCredit {
  id: string;
  units: number;
  consumedUnits: number;
  remaining: number;
  earnedOn: string;
  expiresOn: string;
  expired: boolean;
  source: string;
  sourceRef: string | null;
  note: string | null;
}

export interface CompOffBalance {
  /** Units still available today: credited, not consumed, not expired. */
  available: number;
  /** Units that were credited and have run out of time unused. Shown, never silently dropped. */
  expired: number;
  consumed: number;
  /** The soonest expiry among the credits that still have something left. */
  nextExpiry: string | null;
  /** Units expiring within thirty days, so a screen can say "use it or lose it". */
  expiringSoon: number;
}

const EMPTY_COMP_OFF: CompOffBalance = {
  available: 0, expired: 0, consumed: 0, nextExpiry: null, expiringSoon: 0,
};

function mapCredit(row: any): CompOffCredit {
  const units = Number(row?.units) || 0;
  const consumed = Number(row?.consumed_units) || 0;
  const expiresOn = row?.expires_on ? String(row.expires_on).slice(0, 10) : '';
  return {
    id: String(row?.id ?? ''),
    units,
    consumedUnits: consumed,
    remaining: round2(Math.max(0, units - consumed)),
    earnedOn: row?.earned_on ? String(row.earned_on).slice(0, 10) : '',
    expiresOn,
    expired: row?.is_expired === true,
    source: String(row?.source ?? ''),
    sourceRef: row?.source_ref ? String(row.source_ref) : null,
    note: row?.note ? String(row.note) : null,
  };
}

/** Every comp-off credit for one person, newest first, with expiry resolved by the database. */
export async function listCompOff(employeeId: string, limit = 60): Promise<CompOffCredit[]> {
  if (!isUuid(employeeId)) return [];
  await ensureLeaveSchema();
  const n = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const list = await safe(sql`
    SELECT c.*, (c.expires_on < CURRENT_DATE) AS is_expired
      FROM hr_comp_off_credits c
     WHERE c.employee_id = ${employeeId}::uuid
     ORDER BY c.earned_on DESC, c.created_at DESC
     LIMIT ${n}`);
  return list.map(mapCredit);
}

/**
 * What comp off this person can actually spend today.
 *
 * EXPIRY IS ASKED OF POSTGRES (CURRENT_DATE), never of the render process. The two disagree by a day
 * whenever their timezones differ, and "did my comp off expire yesterday" is exactly the claim that
 * must not be off by one.
 */
export async function compOffBalance(employeeId: string): Promise<CompOffBalance> {
  if (!isUuid(employeeId)) return { ...EMPTY_COMP_OFF };
  await ensureLeaveSchema();
  const list = await safe(sql`
    SELECT
      COALESCE(SUM(CASE WHEN expires_on >= CURRENT_DATE THEN GREATEST(units - consumed_units, 0) ELSE 0 END), 0)::numeric AS available,
      COALESCE(SUM(CASE WHEN expires_on <  CURRENT_DATE THEN GREATEST(units - consumed_units, 0) ELSE 0 END), 0)::numeric AS expired,
      COALESCE(SUM(consumed_units), 0)::numeric AS consumed,
      COALESCE(SUM(CASE WHEN expires_on >= CURRENT_DATE AND expires_on <= (CURRENT_DATE + 30)
                        THEN GREATEST(units - consumed_units, 0) ELSE 0 END), 0)::numeric AS expiring_soon,
      MIN(CASE WHEN expires_on >= CURRENT_DATE AND units > consumed_units THEN expires_on END)::text AS next_expiry
    FROM hr_comp_off_credits
    WHERE employee_id = ${employeeId}::uuid`);
  if (!list.length) return { ...EMPTY_COMP_OFF };
  const r = list[0];
  return {
    available: round2(Number(r.available) || 0),
    expired: round2(Number(r.expired) || 0),
    consumed: round2(Number(r.consumed) || 0),
    expiringSoon: round2(Number(r.expiring_soon) || 0),
    nextExpiry: r.next_expiry ? String(r.next_expiry).slice(0, 10) : null,
  };
}

export interface LedgerResult {
  ok: boolean;
  error?: string;
  /** False when the call was a no-op because the credit already existed. NOT an error. */
  changed?: boolean;
  id?: string;
}

/**
 * CREDIT COMP OFF. The only way units ever enter the ledger.
 *
 * REFUSES A CREDIT WITH NO SOURCE REFERENCE, and that refusal is the safety property: the reference
 * is the id of the approved overtime or worked-holiday claim that earned it, so every unit in this
 * ledger can be traced back to a decision a named human made through the workflow engine. A credit
 * with no reference would be comp off that appeared because some code ran.
 *
 * IDEMPOTENT on (source, source_ref) — a retried settlement credits once.
 */
export async function creditCompOff(input: {
  employeeId: string;
  units: number;
  source: 'overtime' | 'holiday_work';
  sourceRef: string;
  earnedOn?: string | null;
  expiresOn?: string | null;
  note?: string | null;
  createdByUserId?: string | null;
}): Promise<LedgerResult> {
  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };

  const units = round2(Number(input?.units));
  if (!isFinite(units) || units <= 0) return { ok: false, error: 'A credit has to be more than nothing.' };
  if (units > 5) return { ok: false, error: 'A single comp-off credit above five days is not something this records.' };

  const source = input?.source === 'holiday_work' ? 'holiday_work' : 'overtime';
  const sourceRef = String(input?.sourceRef || '').trim();
  if (!sourceRef) {
    return {
      ok: false,
      error: 'Comp off can only be credited against an approved claim. Nothing was credited.',
    };
  }

  const earnedOn = isDateIso(input?.earnedOn) ? String(input?.earnedOn) : null;
  const expiresOn = isDateIso(input?.expiresOn) ? String(input?.expiresOn) : null;
  const note = input?.note ? String(input.note).slice(0, 400) : null;
  const by = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensureLeaveSchema();
    const r = await db.execute(sql`
      INSERT INTO hr_comp_off_credits
        (employee_id, units, earned_on, expires_on, source, source_ref, note, created_by)
      VALUES
        (${employeeId}::uuid, ${units},
         COALESCE(${earnedOn}::date, CURRENT_DATE),
         COALESCE(${expiresOn}::date, COALESCE(${earnedOn}::date, CURRENT_DATE) + ${COMP_OFF_EXPIRY_DAYS}),
         ${source}, ${sourceRef}, ${note}, ${by}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const list = rows(r);
    // No row back means this claim has already been credited. That is the retry working, not a
    // failure, and reporting it as an error would send somebody looking for a problem that is not
    // there.
    return list.length ? { ok: true, id: String(list[0].id), changed: true } : { ok: true, changed: false };
  } catch (e: any) {
    logFail('creditCompOff', e);
    return { ok: false, error: errText(e, 'The comp-off credit could not be saved.') };
  }
}

/**
 * Spend comp off, oldest expiry first.
 *
 * FIFO BY EXPIRY, not by earning date: spending the credit that dies soonest is the only order that
 * does not throw away days the person earned. Partial consumption is normal — half a day comes out
 * of a whole-day credit and leaves half behind.
 *
 * Returns an error rather than going negative. Every UPDATE re-states its own precondition
 * (consumed_units + take <= units), so two requests racing cannot both spend the last half day.
 */
export async function consumeCompOff(
  employeeId: string,
  units: number,
  note: string | null = null,
): Promise<LedgerResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  let need = round2(Number(units));
  if (!isFinite(need) || need <= 0) return { ok: true, changed: false };

  try {
    await ensureLeaveSchema();
    const credits = rows(await db.execute(sql`
      SELECT id, units, consumed_units
        FROM hr_comp_off_credits
       WHERE employee_id = ${employeeId}::uuid
         AND expires_on >= CURRENT_DATE
         AND units > consumed_units
       ORDER BY expires_on ASC, earned_on ASC
       LIMIT 60`));

    const total = credits.reduce(
      (sum, c) => sum + Math.max(0, (Number(c.units) || 0) - (Number(c.consumed_units) || 0)),
      0,
    );
    if (round2(total) < need) {
      return {
        ok: false,
        error: 'There is only ' + round2(total) + ' day(s) of comp off left, and this needs ' + need + '.',
      };
    }

    // WHAT THIS CALL HAS ALREADY TAKEN, so a refusal half way through can put it back.
    //
    // Each credit is its own UPDATE and there is no transaction around the loop. When a concurrent
    // request wins the race for the last half day, the UPDATEs that already succeeded STAY
    // COMMITTED — and applyLeave() then abandons the request without writing a row. The old code
    // returned "nothing was taken twice" and left those units consumed against a leave request that
    // does not exist: comp off the person earned, silently gone, with nothing on any screen saying
    // where. Declared before the loop that writes it; `const` is not hoisted.
    let taken = 0;

    for (const c of credits) {
      if (need <= 0) break;
      const left = round2(Math.max(0, (Number(c.units) || 0) - (Number(c.consumed_units) || 0)));
      if (left <= 0) continue;
      const take = round2(Math.min(left, need));
      const wrote = rows(await db.execute(sql`
        UPDATE hr_comp_off_credits
           SET consumed_units = consumed_units + ${take},
               note = COALESCE(note, ${note})
         WHERE id = ${String(c.id)}::uuid
           AND consumed_units + ${take} <= units
        RETURNING id`));
      if (wrote.length) {
        need = round2(need - take);
        taken = round2(taken + take);
      }
    }

    if (need > 0) {
      // Somebody else spent it between the read and the write. Hand back whatever THIS call did
      // manage to take before returning the refusal — see the note on `taken` above.
      if (taken > 0) {
        const back = await refundCompOff(employeeId, taken);
        if (!back.ok) {
          return {
            ok: false,
            error: 'Your comp off was spent by another request a moment ago, and ' + taken +
              ' day(s) this attempt had already taken could not be put back (' +
              (back.error || 'no reason given') + '). Nothing was filed. Ask HR to check your comp-off ledger.',
          };
        }
      }
      return { ok: false, error: 'Your comp off was spent by another request a moment ago. Nothing was taken, and nothing was filed.' };
    }
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('consumeCompOff', e);
    return { ok: false, error: errText(e, 'The comp off could not be spent.') };
  }
}

/** Give back comp off when an approved request is cancelled or a decision is reversed. */
export async function refundCompOff(employeeId: string, units: number): Promise<LedgerResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  let give = round2(Number(units));
  if (!isFinite(give) || give <= 0) return { ok: true, changed: false };
  try {
    await ensureLeaveSchema();
    const credits = rows(await db.execute(sql`
      SELECT id, consumed_units FROM hr_comp_off_credits
       WHERE employee_id = ${employeeId}::uuid AND consumed_units > 0
       ORDER BY expires_on DESC LIMIT 60`));
    for (const c of credits) {
      if (give <= 0) break;
      const back = round2(Math.min(Number(c.consumed_units) || 0, give));
      if (back <= 0) continue;
      const wrote = rows(await db.execute(sql`
        UPDATE hr_comp_off_credits SET consumed_units = consumed_units - ${back}
         WHERE id = ${String(c.id)}::uuid AND consumed_units >= ${back}
        RETURNING id`));
      if (wrote.length) give = round2(give - back);
    }
    if (give > 0) {
      // A SHORT REFUND IS NOT A SUCCESS. This returned { ok: true } whatever happened, so a refund
      // that could only find part of what it was giving back reported the same thing as one that
      // found all of it — and every caller here is a compensating action for a write that already
      // failed, which is exactly when nobody is watching. Say what is still missing.
      const short = round2(give);
      logFail('refundCompOff.short', new Error(short + ' day(s) of comp off could not be returned to ' + employeeId));
      return {
        ok: false,
        changed: true,
        error: short + ' day(s) of comp off could not be put back — there is no consumed credit left to return them to.',
      };
    }
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('refundCompOff', e);
    return { ok: false, error: errText(e, 'The comp off could not be returned.') };
  }
}

// -------------------------------------------------------------------------------------------------
// BALANCES
// -------------------------------------------------------------------------------------------------

export interface LeaveBalance {
  id: string;
  name: string;
  allowance: number;
  used: number;
  pending: number;
  remaining: number;
  /** Where the number comes from: an annual allowance, the comp-off ledger, or nowhere. */
  source: 'allowance' | 'ledger' | 'none';
  kind: 'absence' | 'work_mode';
  /** Set for comp off: units that expire within a month. */
  expiringSoon?: number;
  nextExpiry?: string | null;
}

/**
 * What is left, per type, this year.
 *
 * COALESCE(day_units, days) EVERYWHERE. Rows written before part-days existed have no day_units and
 * fall back to the whole number they were always counted as; rows written since carry the true cost.
 * One expression, so a half day cannot cost a whole one on the balance screen and half a one on the
 * report.
 *
 * COMP OFF DOES NOT COME FROM THIS TABLE. Its allowance is the ledger, so its row is filled from
 * compOffBalance() — approved comp-off requests have already consumed the credits, which is why the
 * ledger is the whole truth and subtracting the requests again would double-count them.
 *
 * `strict` IS WHAT STOPS A FAILED READ FROM GRANTING LEAVE. The aggregate below used to be a
 * tolerant read: when it threw, used and pending came back as zero and every allowance reported
 * ITSELF as remaining. A screen rendering that is merely wrong; applyLeave() checking against it
 * lets somebody file their thirteenth casual day out of twelve, and the row is then real. Display
 * callers keep the tolerant behaviour so a broken query cannot blank a console — the one caller
 * that GRANTS something passes strict and refuses instead.
 */
export async function getBalances(
  employeeId: string,
  year?: number,
  opts: { strict?: boolean } = {},
): Promise<LeaveBalance[]> {
  await ensureLeaveSchema();
  const y = year || new Date().getFullYear();
  const aggQuery = sql`SELECT leave_type,
      COALESCE(SUM(CASE WHEN status='approved' THEN COALESCE(day_units, days) ELSE 0 END),0)::numeric AS used,
      COALESCE(SUM(CASE WHEN status='pending'  THEN COALESCE(day_units, days) ELSE 0 END),0)::numeric AS pending
    FROM hr_leave_request WHERE employee_id = ${employeeId} AND EXTRACT(YEAR FROM start_date) = ${y} GROUP BY leave_type`;
  const agg = opts.strict ? await strictRead(aggQuery) : await safe(aggQuery, 'getBalances');
  const map: Record<string, any> = {};
  agg.forEach((r) => { map[r.leave_type] = r; });

  const ledger = isUuid(employeeId) ? await compOffBalance(employeeId) : { ...EMPTY_COMP_OFF };

  return LEAVE_TYPES.map((t) => {
    const used = round2(Number(map[t.id]?.used || 0));
    const pending = round2(Number(map[t.id]?.pending || 0));

    if (t.source === 'ledger') {
      return {
        id: t.id, name: t.name, allowance: round2(ledger.available + ledger.consumed),
        used, pending, remaining: round2(Math.max(0, ledger.available - pending)),
        source: t.source, kind: t.kind,
        expiringSoon: ledger.expiringSoon, nextExpiry: ledger.nextExpiry,
      };
    }

    return {
      id: t.id, name: t.name, allowance: t.allowance, used, pending,
      remaining: t.allowance > 0
        ? round2(Math.max(0, t.allowance - used - pending))
        : (Infinity as any),
      source: t.source, kind: t.kind,
    };
  });
}

// -------------------------------------------------------------------------------------------------
// APPLYING
// -------------------------------------------------------------------------------------------------

export interface ApplyLeaveOptions {
  /** 'full' whole days, 'half' half of one day, 'hours' a number of hours on one day. */
  unit?: LeaveUnit;
  /** Which half, for a half-day request. */
  dayPart?: DayPart;
  /** How many hours, for an hourly request. */
  hours?: number;
}

export interface ApplyLeaveResult {
  ok: boolean;
  error?: string;
  /** Calendar days the request spans. Kept for callers that already read it. */
  days?: number;
  /** What it actually costs the allowance. */
  dayUnits?: number;
  /** Days in the range that were NOT charged, and why. */
  excluded?: Array<{ dateIso: string; reason: string }>;
  id?: string;
}

/**
 * FILE A LEAVE REQUEST.
 *
 * The fifth argument and the signature before it are unchanged, so every existing caller keeps
 * working; part-days arrive through the optional sixth.
 *
 * ORDER OF CHECKS, and it matters:
 *   1. Is this a type we have?
 *   2. Is the range a range?
 *   3. WHAT DOES IT ACTUALLY COST — holidays in the span come out first (src/lib/holidays.ts), so a
 *      week off across a public holiday charges four days and not five. A request made ENTIRELY of
 *      holidays is refused rather than filed for zero: the person does not need it.
 *   4. Is there enough left? Comp off asks the ledger; everything else asks the allowance.
 *   5. COMP OFF IS SPENT BEFORE THE ROW IS WRITTEN. If the ledger write fails, no request exists —
 *      the alternative is a filed request against credits that were never taken.
 *
 * WORK FROM HOME COSTS NOTHING and is checked against no balance. It is a request about where the
 * work happens.
 */
export async function applyLeave(
  employeeId: string,
  type: string,
  start: string,
  end: string,
  reason: string,
  opts: ApplyLeaveOptions = {},
): Promise<ApplyLeaveResult> {
  await ensureLeaveSchema();

  const meta = leaveType(type);
  if (!meta || !TYPE_IDS.has(type)) return { ok: false, error: 'Pick a leave type.' };
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  if (!isDateIso(start) || !isDateIso(end)) return { ok: false, error: 'Enter a valid date range.' };

  const days = daysBetween(start, end);
  if (days <= 0) return { ok: false, error: 'Enter a valid date range (end on or after start).' };
  if (days > MAX_SPAN_DAYS) return { ok: false, error: 'That range is longer than this records in one request.' };

  const unit: LeaveUnit = (LEAVE_UNITS as readonly string[]).includes(String(opts?.unit))
    ? (String(opts?.unit) as LeaveUnit)
    : 'full';

  if (unit === 'half' && !meta.halfDay) {
    return { ok: false, error: meta.name + ' is taken as whole days.' };
  }
  if (unit === 'hours' && !meta.hourly) {
    return { ok: false, error: meta.name + ' cannot be taken by the hour.' };
  }
  if (unit !== 'full' && start !== end) {
    return { ok: false, error: 'A part day is one day. Set the same date for both, or ask for whole days.' };
  }

  const scope = await scopeFor(employeeId);
  const span = await leaveSpan(start, end, scope);

  let dayUnits = 0;
  let hours: number | null = null;
  let dayPart: DayPart | null = null;

  if (unit === 'full') {
    dayUnits = round2(span.chargeableDays);
    if (dayUnits <= 0) {
      const names = span.excluded.map((x) => x.reason).filter(Boolean);
      return {
        ok: false,
        error: names.length
          ? 'Every day in that range is already a holiday (' + [...new Set(names)].join(', ') + '), so there is nothing to ask for.'
          : 'That range costs nothing, so there is nothing to ask for.',
      };
    }
  } else {
    // A part day on a day that is already off is a request for a day the person already has.
    const holidays = await observedDates(start, start, scope);
    const onHoliday = holidays.get(start);
    if (onHoliday) {
      return { ok: false, error: start + ' is already ' + onHoliday.name + ', so you do not need leave for it.' };
    }
    if (unit === 'half') {
      dayUnits = 0.5;
      dayPart = (DAY_PARTS as readonly string[]).includes(String(opts?.dayPart))
        ? (String(opts?.dayPart) as DayPart)
        : 'first_half';
    } else {
      const asked = round2(Number(opts?.hours));
      const dayMinutes = await dayMinutesFor(employeeId, start);
      const maxHours = round2(dayMinutes / 60);
      if (!isFinite(asked) || asked < MIN_LEAVE_HOURS) {
        return { ok: false, error: 'Ask for at least ' + MIN_LEAVE_HOURS + ' of an hour.' };
      }
      if (asked >= maxHours) {
        return {
          ok: false,
          error: 'That is a whole working day (' + maxHours + ' hours). Ask for a full day instead.',
        };
      }
      hours = asked;
      dayUnits = round2(asked / maxHours);
      if (dayUnits <= 0) dayUnits = 0.01; // never free, however short
    }
  }

  // THE BALANCE CHECK. Work from home and unpaid leave are uncounted by definition.
  //
  // STRICT, AND THAT IS THE POINT OF THE ARGUMENT. A balance that could not be read is not a full
  // allowance; it is an unknown, and granting against an unknown is how somebody ends up with more
  // days off than they have. The refusal is temporary and says so.
  if (meta.source === 'allowance' && meta.allowance > 0) {
    let balances: LeaveBalance[];
    try {
      balances = await getBalances(employeeId, Number(start.slice(0, 4)), { strict: true });
    } catch (e: any) {
      logFail('applyLeave.balance', e);
      return {
        ok: false,
        error: 'Your leave balance could not be read just now, so nothing was filed. Try again in a moment.',
      };
    }
    const bal = balances.find((b) => b.id === type);
    const remaining = bal ? Number(bal.remaining) : 0;
    if (isFinite(remaining) && dayUnits > remaining) {
      return {
        ok: false,
        error: 'Only ' + round2(remaining) + ' ' + meta.name.toLowerCase() + ' day(s) remaining this year, and this asks for ' + dayUnits + '.',
      };
    }
  }

  // COMP OFF IS SPENT FIRST. A request that exists against credits nobody took is worse than a
  // refusal, so the ledger write is the gate rather than a follow-up.
  if (meta.source === 'ledger') {
    const spent = await consumeCompOff(employeeId, dayUnits, 'Comp off leave ' + start);
    if (!spent.ok) return { ok: false, error: spent.error || 'Your comp off could not be spent.' };
  }

  try {
    const r = await db.execute(sql`
      INSERT INTO hr_leave_request
        (employee_id, leave_type, start_date, end_date, days, day_units, hours, day_part, unit, reason)
      VALUES
        (${employeeId}::uuid, ${type}, ${start}::date, ${end}::date, ${days}, ${dayUnits},
         ${hours}, ${dayPart}, ${unit}, ${reason || null})
      RETURNING id`);
    const list = rows(r);
    if (!list.length) {
      if (meta.source === 'ledger') await refundCompOff(employeeId, dayUnits);
      return { ok: false, error: 'The request was not saved and the database did not say why.' };
    }
    return { ok: true, days, dayUnits, excluded: span.excluded, id: String(list[0].id) };
  } catch (e: any) {
    logFail('applyLeave', e);
    // The credits were taken and the row was not written. Give them back rather than leaving
    // somebody short of comp off they still have.
    if (meta.source === 'ledger') await refundCompOff(employeeId, dayUnits);
    return { ok: false, error: errText(e, 'The request could not be saved.') };
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export async function listLeave(opts: { employeeId?: string; status?: string } = {}): Promise<any[]> {
  await ensureLeaveSchema();
  if (opts.employeeId) return safe(sql`SELECT * FROM hr_leave_request WHERE employee_id = ${opts.employeeId} ORDER BY start_date DESC LIMIT 60`);
  return safe(sql`SELECT l.*, e.full_name, e.employee_code, e.designation
    FROM hr_leave_request l LEFT JOIN hr_employees e ON l.employee_id = e.id
    ${opts.status ? sql`WHERE l.status = ${opts.status}` : sql``}
    ORDER BY (l.status='pending') DESC, l.start_date DESC LIMIT 120`);
}

/**
 * Leave requests THIS person can actually decide.
 *
 * listLeave() answers "one employee's requests" or "every request with this status" — neither of
 * which tells an approver what is waiting on THEM. Without this, a reporting manager has to read a
 * list of everyone's pending leave and work out by hand which rows they are allowed to act on, so
 * cover never gets arranged because nobody knows they are the blocker.
 *
 * The authority test is the same one decideLeave() enforces, expressed in SQL rather than repeated
 * in prose: whoever holds `leave.approve` sees every pending request; everyone else sees only the
 * requests of employees whose reporting_manager_id is their own USERS id. Anyone else sees nothing.
 *
 * Deciding is still re-checked by decideLeave() through approverRole(). This function decides what
 * to SHOW; it is never the permission itself. A list is not an authorisation.
 */
export async function pendingLeaveForApprover(user: any): Promise<any[]> {
  if (!user?.id) return [];
  await ensureLeaveSchema();

  // WAS `role === 'super_admin' || role === 'admin' || role === 'hr'`, and before that the substring
  // test `role.indexOf('hr') >= 0` that handed leave approval to any role merely spelled with those
  // two letters. Same people as the exact-match version, asked as a capability: PERMS_BY_ROLE grants
  // leave.approve to exactly super_admin and hr, and 'admin' is not a value of userRoleEnum
  // (src/lib/db/schema.ts:10-16) so that arm could never match an account. can() needs no database,
  // so this list still answers correctly during an outage — and it fails closed, not open.
  //
  // ASKED THROUGH THE SHARED PREDICATE, which is now the only expression of "may decide every
  // request of this kind" — decideLeave() -> approverRole() and workforce/composer.ts ask the same
  // function. The list and the enforcement cannot drift apart.
  const seesAll = decidesEveryRequest(user, 'leave.approve');

  // ORDERED BY HOW LONG SOMEBODY HAS BEEN WAITING, NOT BY WHEN THEIR LEAVE STARTS.
  //
  // This was `ORDER BY l.start_date ASC`, and that sorted the queue by the wrong clock. A request
  // filed this morning for March sorted BELOW every near-term request, so the row most likely to rot
  // was the row hardest to see — and on a busy HR account, where the whole-org branch below is the
  // one that runs, it could fall off the LIMIT 120 entirely and be invisible rather than merely low.
  // Nobody chases a request they cannot see, and nothing tells them it exists.
  //
  // requested_at is NOT NULL DEFAULT NOW() on this table and is already indexed alongside status
  // (hr_leave_status), so oldest-first costs nothing. start_date is kept as the tiebreak, so two
  // requests filed in the same second still order sensibly, and it remains in the SELECT — the
  // surface renders "started" urgency from it separately from queue position.
  //
  // The 120-row cap stays. It now truncates the NEWEST requests instead of the oldest, which is the
  // right direction: the ones cut off are the ones that have waited least.
  try {
    if (seesAll) {
      return rows(await db.execute(sql`
        SELECT l.*, e.full_name, e.employee_code, e.designation
          FROM hr_leave_request l
          LEFT JOIN hr_employees e ON e.id = l.employee_id
         WHERE l.status = 'pending'
         ORDER BY l.requested_at ASC, l.start_date ASC
         LIMIT 120`));
    }
    // reporting_manager_id holds a USERS id, not an hr_employees id — the same column and the same
    // comparison approverRole() makes. Compared as text because the column is UUID here and a slug
    // elsewhere in this schema; ::uuid would throw on the latter.
    return rows(await db.execute(sql`
      SELECT l.*, e.full_name, e.employee_code, e.designation
        FROM hr_leave_request l
        JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.status = 'pending'
         AND e.reporting_manager_id::text = ${String(user.id)}
       ORDER BY l.requested_at ASC, l.start_date ASC
       LIMIT 120`));
  } catch (e: any) {
    // Fail closed: an approver seeing nothing is a missed notification; an approver seeing everyone
    // else's leave is a data leak.
    logFail('pendingLeaveForApprover', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// DECIDING
// -------------------------------------------------------------------------------------------------

/**
 * Withdraw a pending request.
 *
 * Comp off is returned to the ledger when a pending comp-off request is cancelled — it was taken at
 * the moment the request was filed, and leaving it spent would quietly cost somebody a day for a
 * request that never happened.
 */
export async function cancelLeave(id: string, employeeId: string): Promise<void> {
  await ensureLeaveSchema();
  try {
    const cancelled = rows(await db.execute(sql`
      UPDATE hr_leave_request SET status='cancelled'
       WHERE id = ${id} AND employee_id = ${employeeId} AND status='pending'
      RETURNING leave_type, COALESCE(day_units, days) AS units`));
    if (cancelled.length && String(cancelled[0].leave_type) === 'comp_off') {
      await refundCompOff(employeeId, Number(cancelled[0].units) || 0);
    }
  } catch (e: any) {
    logFail('cancelLeave', e);
  }
}

/**
 * `warning` is set when the decision WAS committed but something that should have accompanied it
 * was not — today, the audit record. Callers reporting success should append it rather than drop it.
 */
export async function decideLeave(id: string, user: any, decision: 'approved' | 'rejected', note: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  await ensureLeaveSchema();
  const l = (await safe(sql`SELECT * FROM hr_leave_request WHERE id = ${id} LIMIT 1`))[0];
  if (!l) return { ok: false, error: 'Request not found.' };
  if (l.status !== 'pending') return { ok: false, error: 'Already ' + l.status + '.' };
  // THE ENFORCEMENT. pendingLeaveForApprover() decides what to SHOW; this decides what may be DONE.
  // Two checks on one rule are only a problem when they can diverge — this is the one that binds.
  const role = await approverRole(user, l.employee_id, 'leave.approve');
  if (!role) return { ok: false, error: 'You are not permitted to decide this request.' };
  await db.execute(sql`UPDATE hr_leave_request SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role}, decided_at = NOW(), decision_note = ${note || null} WHERE id = ${id}`);

  // Approving leave has to reach attendance, or the two modules disagree about the same day:
  // payroll counts attendance, so an approved leave day with no attendance row was counted as
  // nothing at all, and a day the employee had been told to take off could be read as absence.
  if (decision === 'approved') await markLeaveAttendance(l);

  // A REJECTED COMP-OFF REQUEST GETS ITS CREDITS BACK. They were spent when the request was filed.
  if (decision === 'rejected' && String(l.leave_type) === 'comp_off') {
    await refundCompOff(String(l.employee_id), Number(l.day_units ?? l.days) || 0);
  }

  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: String(user.id), action: 'hr.leave.' + decision, entity: 'hr_leave_request', entityId: String(id),
      diff: { employeeId: l.employee_id, leaveType: l.leave_type, days: l.days, units: l.day_units ?? l.days, unit: l.unit || 'full', from: l.start_date, to: l.end_date, byRole: role, note: note || null },
    });
  } catch (e: any) {
    // audit.ts is the single audit surface in this codebase, and this row is the only record of WHO
    // approved a person's leave. The decision is already committed, so this must not fail the
    // operation — but it was a bare catch, so the accountability could disappear in total silence.
    // The caller is handed a warning so a screen can say the decision stands and the trail does not.
    const real = e?.cause?.message || e?.message;
    console.error('[hr-leave] the audit record for leave', id, decision, 'was NOT written -', real);
    return { ok: true, warning: 'The decision is saved, but it could not be written to the audit log, so there is no permanent record of who made it.' };
  }

  return { ok: true };
}

// -------------------------------------------------------------------------------------------------
// WHAT AN APPROVAL DOES TO THE ATTENDANCE RECORD
// -------------------------------------------------------------------------------------------------

/**
 * Write attendance for an approved request.
 *
 * THREE RULES, AND EACH ONE EXISTS BECAUSE ITS ABSENCE WAS WRONG IN A WAY PAYROLL READS:
 *
 *   1. A HALF DAY OR AN HOUR IS NOT AN 'on_leave' DAY. The person worked the rest of it. A partial
 *      request records leave_units and leave_type on the day and leaves the STATUS alone when a row
 *      already exists — so a day somebody punched stays 'present' with the leave noted beside it.
 *      Stamping the whole day off would delete half a day of real work from the payroll input.
 *
 *   2. WORK FROM HOME IS NOT ABSENCE. It writes status 'wfh' and work_mode 'remote'. Nothing about a
 *      wfh request touches an allowance, and no report counts it as time off, because it is not.
 *
 *   3. A HOLIDAY INSIDE THE RANGE IS SKIPPED. applyLeave() did not charge for it, so stamping it as
 *      leave would record a day of absence the person never spent. src/lib/holidays.ts decides which
 *      days those are, and it is the same function that did the charging.
 *
 * A day the employee actually worked is left alone in every case — present/wfh wins over on_leave —
 * so a back-dated approval can never erase real attendance.
 *
 * Accepts a partial row: src/lib/workflow.ts settleDomainRecord() passes only the five columns its
 * UPDATE returned, so when the unit information is missing it is re-read by id rather than assumed.
 */
export async function markLeaveAttendance(l: any): Promise<number> {
  if (!l) return 0;

  let row: any = l;
  if (row.unit === undefined || row.day_units === undefined) {
    const id = String(row.id || '');
    if (id) {
      const full = (await safe(sql`SELECT * FROM hr_leave_request WHERE id = ${id} LIMIT 1`))[0];
      if (full) row = full;
    }
  }

  // UTC, because the loop below formats each day with toISOString(). Parsing these as LOCAL midnight
  // and then printing them as UTC is how a leave day gets stamped onto the wrong date.
  const start = new Date(String(row.start_date).slice(0, 10) + 'T00:00:00Z');
  const end = new Date(String(row.end_date).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0;
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (span > MAX_SPAN_DAYS) return 0;

  const typeId = String(row.leave_type || 'leave');
  const meta = leaveType(typeId);
  const unit = String(row.unit || 'full');
  const partial = unit !== 'full';
  const employeeId = String(row.employee_id || '');
  const isWfh = meta?.kind === 'work_mode';

  // The columns a partial day needs only exist once the working-time schema has run. Imported
  // dynamically for the same cycle reason dayMinutesFor() is.
  try {
    const { ensureWorkingTimeSchema } = await import('@/lib/attendance-schema');
    await ensureWorkingTimeSchema();
  } catch (e: any) {
    logFail('markLeaveAttendance.schema', e);
  }

  const startIso = String(row.start_date).slice(0, 10);
  const endIso = String(row.end_date).slice(0, 10);
  const scope = await scopeFor(employeeId);
  const holidays = await observedDates(startIso, endIso, scope);

  const unitsPerDay = partial ? round2(Number(row.day_units) || 0.5) : 1;
  const note = isWfh
    ? 'Approved work from home'
    : 'Approved ' + (meta?.name || typeId) + ' leave' + (partial ? ' (' + describeUnits(unit, unitsPerDay, row.hours ? Number(row.hours) : null) + ')' : '');

  let written = 0;
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    if (holidays.has(iso)) continue; // already a day off; it was never charged for

    try {
      if (isWfh) {
        // WORKING, ELSEWHERE. Never 'on_leave', never absence.
        await db.execute(sql`
          INSERT INTO hr_attendance (employee_id, date, status, work_mode, notes, source)
          VALUES (${employeeId}, ${iso}, 'wfh', 'remote', ${note}, 'leave')
          ON CONFLICT (employee_id, date) DO UPDATE
            SET status = 'wfh', work_mode = 'remote', notes = ${note}
            WHERE hr_attendance.status NOT IN ('present')`);
      } else if (partial) {
        // A PART DAY. The leave is recorded on the day; the day itself is still a working day.
        await db.execute(sql`
          INSERT INTO hr_attendance (employee_id, date, status, work_mode, notes, leave_units, leave_type, source)
          VALUES (${employeeId}, ${iso}, 'present', 'remote', ${note}, ${unitsPerDay}, ${typeId}, 'leave')
          ON CONFLICT (employee_id, date) DO UPDATE
            SET leave_units = ${unitsPerDay},
                leave_type  = ${typeId},
                notes       = ${note}`);
      } else {
        await db.execute(sql`
          INSERT INTO hr_attendance (employee_id, date, status, work_mode, notes, leave_units, leave_type, source)
          VALUES (${employeeId}, ${iso}, 'on_leave', 'leave', ${note}, 1, ${typeId}, 'leave')
          ON CONFLICT (employee_id, date) DO UPDATE
            SET status = 'on_leave', notes = ${note}, leave_units = 1, leave_type = ${typeId}
            WHERE hr_attendance.status NOT IN ('present', 'wfh')`);
      }
      written++;
    } catch (e: any) {
      // One bad day must not abort the approval — but it is never silent.
      logFail('markLeaveAttendance ' + iso, e);
    }
  }
  return written;
}
