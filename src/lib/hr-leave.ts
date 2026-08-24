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
import { civilToday } from '@/lib/page-safety';
import { round2 } from '@/lib/money';
// THE APPROVAL ENGINE. Leave was the ONE domain that declared a chain in workflow.ts DOMAINS and
// never entered it: applyLeave() ended at the INSERT, so no approver was ever resolved from the org
// graph, nobody was notified, and the request sat 'pending' with no owner until a human happened to
// open an admin list. Fifteen other services already start their own chain from their own module;
// this one now does too. src/lib/workflow.ts does not import this file at load time (its leave
// settlement uses a dynamic import), so there is no cycle.
import { startWorkflow, cancelWorkflow, instanceForRecord } from '@/lib/workflow';
import { sendPushToUser } from '@/lib/push';

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

/**
 * THE ZONE EVERY DAY BOUNDARY IN THIS MODULE IS CUT ON, named once and declared above every reader —
 * `const` is not hoisted.
 *
 * The comment on compOffBalance() says expiry "is asked of Postgres (CURRENT_DATE), never of the
 * render process", and the reasoning was right: two processes in two regions must not disagree about
 * what day it is. But CURRENT_DATE is the DATABASE SESSION's zone, and nothing in this codebase sets
 * it — src/lib/db/index.ts opens the connection with no timezone option and no SET TIME ZONE, so the
 * session inherits the server default, which is UTC. IST is UTC+05:30, so between 00:00 and 05:29
 * every night Postgres answered YESTERDAY.
 *
 * A comp-off credit is spendable until its expiry date. Cutting that boundary in UTC takes the last
 * five and a half hours off the final day of every credit — the day somebody would notice they were
 * about to lose it and use it. `NOW() AT TIME ZONE '<zone>'` converts the transaction timestamp to
 * local wall-clock time and the ::date then cuts the day where the people cutting it do. It is
 * explicit, it does not depend on the session's configuration, and it changes no connection setting
 * that other modules share. Same expression, same zone, as src/lib/attendance.ts.
 */
const LEAVE_TIME_ZONE = 'Asia/Kolkata';

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

  // THE APPROVAL THAT WAS NEVER ATTACHED.
  //
  // Additive, never dropped. workflow_instance_id is the engine instance this request was routed
  // through, so the two tables can be joined instead of guessed at; halt_reason is the engine's own
  // sentence copied onto the request so the PERSON WAITING can read it. The halt was previously
  // rendered only on /admin/hr/leave/workflow — honest to the wrong audience: the employee saw
  // 'pending' and waited while the record actually said no reporting manager is recorded for them.
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS workflow_instance_id UUID`);
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS halt_reason TEXT`);
  await db.execute(sql`ALTER TABLE hr_leave_request ADD COLUMN IF NOT EXISTS requested_by_user_id UUID`);

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

// Day units are money-shaped — 0.5, 0.13, 1.25 — and are rounded by the same rule money is.
//
// The copy that lived here was `Math.round((Number(n) || 0) * 100) / 100`, which rounds a half unit
// DOWN whenever the product lands just under .5 in IEEE754 (1.005 * 100 === 100.49999999999999).
// On a leave balance the bias runs against the employee: an entitlement that should read 1.01 days
// remaining reads 1.00. round2() in src/lib/money.ts rounds the decimal value instead.

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
    SELECT c.*, (c.expires_on < (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date) AS is_expired
      FROM hr_comp_off_credits c
     WHERE c.employee_id = ${employeeId}::uuid
     ORDER BY c.earned_on DESC, c.created_at DESC
     LIMIT ${n}`);
  return list.map(mapCredit);
}

/**
 * What comp off this person can actually spend today.
 *
 * EXPIRY IS ASKED OF POSTGRES, never of the render process. The two disagree by a day whenever their
 * timezones differ, and "did my comp off expire yesterday" is exactly the claim that must not be off
 * by one.
 *
 * ASKING POSTGRES WAS ONLY HALF OF IT. This used CURRENT_DATE, which is the database SESSION's zone —
 * UTC here, because nothing sets it — so the answer was still off by one for the first five and a half
 * hours of every IST day. The zone is now named explicitly; see LEAVE_TIME_ZONE at the top of this file.
 */
export async function compOffBalance(employeeId: string): Promise<CompOffBalance> {
  if (!isUuid(employeeId)) return { ...EMPTY_COMP_OFF };
  await ensureLeaveSchema();
  const list = await safe(sql`
    SELECT
      COALESCE(SUM(CASE WHEN expires_on >= (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date THEN GREATEST(units - consumed_units, 0) ELSE 0 END), 0)::numeric AS available,
      COALESCE(SUM(CASE WHEN expires_on <  (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date THEN GREATEST(units - consumed_units, 0) ELSE 0 END), 0)::numeric AS expired,
      COALESCE(SUM(consumed_units), 0)::numeric AS consumed,
      COALESCE(SUM(CASE WHEN expires_on >= (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date
                         AND expires_on <= ((NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date + 30)
                        THEN GREATEST(units - consumed_units, 0) ELSE 0 END), 0)::numeric AS expiring_soon,
      MIN(CASE WHEN expires_on >= (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date AND units > consumed_units THEN expires_on END)::text AS next_expiry
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
    // THE RE-READ THE SCHEMA COMMENT PROMISES, WRITTEN DOWN AT LAST.
    //
    // createLeaveTables() builds hr_comp_off_source inside a try/catch and its catch says "creditCompOff
    // also re-reads before inserting, so the invariant holds through the only writer either way". That
    // was not true: this function contained no SELECT, and the ON CONFLICT DO NOTHING carried NO
    // conflict target, so with the index absent it matched nothing and degraded to a plain INSERT.
    // applyApprovedOvertimeClaims() runs on every overtime page load, so two page loads racing each
    // other credited the same approved evening twice and the balance grew whenever somebody opened a
    // screen. The stated defence existed only in the comment.
    //
    // NOT EXISTS is that defence, in the same statement as the write. The untargeted ON CONFLICT stays
    // as the second layer for the true race — it needs no index to be VALID, and where the index does
    // exist it turns a duplicate-key error into the same quiet no-op.
    //
    // TODAY IS CUT IN THE ZONE THE COMPANY WORKS IN. CURRENT_DATE is the database session's zone, and
    // nothing sets it, so it is UTC — earned_on and the expiry derived from it landed on the previous
    // day for anything credited between 00:00 and 05:29 IST, which is a comp-off day expiring a day
    // early.
    const r = await db.execute(sql`
      INSERT INTO hr_comp_off_credits
        (employee_id, units, earned_on, expires_on, source, source_ref, note, created_by)
      SELECT ${employeeId}::uuid, ${units},
             COALESCE(${earnedOn}::date, (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date),
             COALESCE(${expiresOn}::date,
                      COALESCE(${earnedOn}::date, (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date)
                        + ${COMP_OFF_EXPIRY_DAYS}),
             ${source}, ${sourceRef}, ${note}, ${by}::uuid
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_comp_off_credits
          WHERE source = ${source} AND source_ref = ${sourceRef}
       )
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
 * A REFUSAL CARRIED OUT OF THE SPEND TRANSACTION, so throwing is what rolls the spend back.
 *
 * Declared above consumeCompOff(), which is the only thing that throws or catches it. A class
 * binding is in the temporal dead zone before its declaration exactly like a `const`, and a helper
 * placed under its first reader has taken pages down on this project.
 *
 * It never reaches a caller: consumeCompOff catches it and returns the LedgerResult it carries.
 */
class CompOffRefusal extends Error {
  constructor(public readonly refusal: LedgerResult) {
    super('comp off refusal');
    this.name = 'CompOffRefusal';
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
 *
 * =================================================================================================
 * THE WHOLE SPEND IS ONE TRANSACTION, AND THAT IS THE POINT
 * =================================================================================================
 *
 * This used to be a bare loop of autocommitting UPDATEs with a JavaScript compensation bolted onto
 * ONE of the two ways it could end. The race branch handed the credits back; the EXCEPTION branch
 * did not — it could not, because the running total lived inside the try block and was not even in
 * scope in the catch. So when a single UPDATE failed part-way (a stalled connection, the 30s
 * statement_timeout, the circuit breaker) after earlier ones had already COMMITTED, consumeCompOff
 * returned ok:false, applyLeave abandoned the request, and the screen said "The comp off could not
 * be spent." That sentence was false: half a day to N days of comp off were permanently marked
 * consumed, carrying the note for a leave request that was never written. No leave row, no audit
 * row, no screen showed the deduction, and the amount taken died with the request that took it, so
 * nothing could ever repair it.
 *
 * A ROLLBACK CANNOT FORGET AND CANNOT BE HALF-DONE, which is why the compensating refundCompOff()
 * call that used to sit on the race branch is gone rather than duplicated onto the catch. Both ways
 * of failing now end the same way: nothing was taken, because nothing was committed.
 *
 * WHAT IS SAFE TO DO IN HERE. At most 61 short statements, all against one employee's own
 * hr_comp_off_credits rows. No HTTP, no mail, no blob, and no second connection checked out from
 * inside the held one — refundCompOff() would have done exactly that, which at max:5 is how a pool
 * deadlocks.
 *
 * ensureLeaveSchema() STAYS OUTSIDE IT, deliberately. It can emit DDL, and a `tx` handle reaches
 * the driver directly — it does not pass through the request-time-DDL guard that every db.execute()
 * goes through in src/lib/db/index.ts. Bootstrapping inside the transaction would also hold the
 * pooler slot for the whole of it.
 *
 * AND THE TRANSACTION IS NOT WRAPPED IN withDbTimeout(), which is a deliberate exception to the
 * house rule and not an oversight. withDbTimeout sheds the WAIT and not the WORK: on a timeout the
 * statements keep running and the transaction can still COMMIT, so a client-side bound here would
 * report "could not be spent" over credits that were in fact taken — precisely the false sentence
 * this repair exists to delete. The bounds that apply to this await are the server-side ones set in
 * src/lib/db/index.ts (statement_timeout 30s, idle_in_transaction_session_timeout 15s) and they are
 * the right ones, because they ABORT the transaction rather than abandoning the wait on it. A
 * killed invocation drops the connection, which rolls it back for the same reason.
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
  } catch (e: any) {
    // Nothing has been read or written at this point, so this refusal is unambiguous. It is split
    // out of the transaction's own catch only because ensureLeaveSchema() has to run outside it.
    logFail('consumeCompOff.schema', e);
    return {
      ok: false,
      error: 'The comp off could not be spent, so nothing was taken and nothing was filed. Reason: '
        + errText(e, 'the leave tables could not be prepared.'),
    };
  }

  try {
    await db.transaction(async (tx: any) => {
      const credits = rows(await tx.execute(sql`
        SELECT id, units, consumed_units
          FROM hr_comp_off_credits
         WHERE employee_id = ${employeeId}::uuid
           AND expires_on >= (NOW() AT TIME ZONE ${LEAVE_TIME_ZONE})::date
           AND units > consumed_units
         ORDER BY expires_on ASC, earned_on ASC
         LIMIT 60`));

      const total = credits.reduce(
        (sum, c) => sum + Math.max(0, (Number(c.units) || 0) - (Number(c.consumed_units) || 0)),
        0,
      );
      if (round2(total) < need) {
        // Nothing has been written yet, so the throw is only a way out of the callback. The sentence
        // is unchanged from the version that returned early here.
        throw new CompOffRefusal({
          ok: false,
          error: 'There is only ' + round2(total) + ' day(s) of comp off left, and this needs ' + need + '.',
        });
      }

      for (const c of credits) {
        if (need <= 0) break;
        const left = round2(Math.max(0, (Number(c.units) || 0) - (Number(c.consumed_units) || 0)));
        if (left <= 0) continue;
        const take = round2(Math.min(left, need));
        const wrote = rows(await tx.execute(sql`
          UPDATE hr_comp_off_credits
             SET consumed_units = consumed_units + ${take},
                 note = COALESCE(note, ${note})
           WHERE id = ${String(c.id)}::uuid
             AND consumed_units + ${take} <= units
          RETURNING id`));
        if (wrote.length) need = round2(need - take);
      }

      if (need > 0) {
        // Somebody else spent it between the read and the write. THE THROW IS THE COMPENSATION:
        // rolling back is what puts back whatever this attempt had already taken, and unlike the
        // JavaScript refund it replaces, it cannot itself fail half way and leave a person short.
        throw new CompOffRefusal({
          ok: false,
          error: 'Your comp off was spent by another request a moment ago. Nothing was taken, and nothing was filed.',
        });
      }
    });
  } catch (e: any) {
    if (e instanceof CompOffRefusal) return e.refusal;
    // THE REASSURANCE LEADS AND IS UNCONDITIONAL, because it is now the one thing this branch can
    // promise: every UPDATE this call made has been rolled back. errText() returns the Postgres
    // reason whenever there is one, so passing this sentence as its FALLBACK — which is what the
    // old code did — meant the person almost never saw it. The reason is kept after it, exactly as
    // this file reports every other ledger failure.
    logFail('consumeCompOff', e);
    return {
      ok: false,
      error: 'The comp off could not be spent, so nothing was taken and nothing was filed. Reason: '
        + errText(e, 'no reason was given.'),
    };
  }
  return { ok: true, changed: true };
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
  // THE LEAVE YEAR, IN THE ZONE THE LEAVE YEAR TURNS OVER IN. This was new Date().getFullYear() — the
  // process clock, UTC on this deployment — while applyLeave() derives the year from the request's own
  // start date. Between 00:00 and 05:29 IST on 1 January the two disagreed: every balance screen showed
  // LAST year's allowance and consumption while applyLeave charged against the new year, so somebody
  // opening the portal at 02:00 on New Year's Day saw an exhausted balance and believed they had no
  // leave left.
  const y = year || Number(civilToday(LEAVE_TIME_ZONE).slice(0, 4)) || new Date().getFullYear();
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
// TELLING THE PERSON, AND PUTTING THE REQUEST INTO THE ENGINE
// -------------------------------------------------------------------------------------------------
//
// Both of these are declared ABOVE applyLeave() and decideLeave(), which call them. `const` is not
// hoisted on this project and a helper under its first reader has taken pages down here.

/** Where a leave notification sends somebody. The page exists (src/pages/portal/employee/leave.astro). */
const LEAVE_PORTAL_URL = '/portal/employee/leave';

/**
 * The users.id behind an hr_employees.id, or null when the employee has no account.
 *
 * NEVER THROWS and never blocks a decision. A person with no portal account is a person who cannot
 * be pushed to, which is a fact about the account and not a reason to refuse an approval.
 */
async function employeeUserId(employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  const r = await safe(sql`SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`, 'employeeUserId');
  const id = r.length ? String(r[0].user_id || '') : '';
  return isUuid(id) ? id : null;
}

/**
 * Tell an employee something happened to their own request.
 *
 * THIS MODULE HAD NO NOTIFIER AT ALL. Nothing was sent when a request was filed and nothing was sent
 * when it was decided, while the form promised "Decided by your reporting manager or by HR" — so a
 * request approved or rejected today reached the person whenever they next happened to open the page,
 * which could be after the dates had passed.
 *
 * sendPushToUser() is this codebase's single notifier: it writes the in-app row AND sends the browser
 * push, and de-duplicates identical messages inside two minutes, which covers a retried POST. A failed
 * notification is logged and swallowed HERE and only here — an approval that was recorded and not
 * announced is a person who has to look at a page; an approval refused because a push endpoint was
 * stale is a person who cannot work.
 */
async function notifyEmployee(
  employeeId: string,
  payload: { type: string; title: string; body: string; tag: string },
): Promise<void> {
  try {
    const userId = await employeeUserId(employeeId);
    if (!userId) return;
    await sendPushToUser(userId, { ...payload, url: LEAVE_PORTAL_URL });
  } catch (e: any) {
    logFail('notifyEmployee', e);
  }
}

export interface LeaveRouting {
  /** The engine could not name an approver. The request EXISTS and is visible; nothing auto-approved. */
  halted: boolean;
  /** The engine's own readable sentence, copied onto the request so the employee can read it too. */
  haltReason: string | null;
  instanceId: string | null;
  /** True when an approval chain is live and its first rung has been notified. */
  routed: boolean;
}

/**
 * PUT A FILED REQUEST INTO THE APPROVAL ENGINE.
 *
 * startWorkflow() resolves the chain per ROW from the Organization Graph, writes the steps, and
 * notifies only the first rung. When the graph cannot name an approver it creates the instance in
 * state 'halted' CARRYING THE REASON rather than declining to create it — that is what makes the
 * failure visible on /admin/hr/leave/workflow, where it can be resumed the moment the missing
 * relationship is recorded. It never approves anything.
 *
 * IDEMPOTENT: startWorkflow is unique on (domain, record_id) in the database, so a retried POST or a
 * second sweep attaches one chain.
 *
 * THE HALT SENTENCE IS COPIED ONTO THE LEAVE ROW. Without that, /portal/employee/leave reads
 * hr_leave_request.status, which is still 'pending', and the employee is shown a wait with no cause.
 */
async function routeLeaveRequest(
  requestId: string,
  employeeId: string,
  requestedByUserId: string | null,
  summary: string,
): Promise<LeaveRouting> {
  const none: LeaveRouting = { halted: false, haltReason: null, instanceId: null, routed: false };
  try {
    const wf = await startWorkflow({
      domain: 'leave',
      recordId: String(requestId),
      subjectEmployeeId: employeeId,
      requestedByUserId: requestedByUserId || null,
      createdByUserId: requestedByUserId || null,
      summary: summary.slice(0, 300),
    });
    if (!wf.ok || !wf.instanceId) {
      // NOT SWALLOWED. The request is filed and has no chain; the caller says so on screen and the
      // row carries the reason, so it can be found and re-routed rather than sitting unowned.
      const why = wf.error || 'The approval chain could not be started.';
      // NOT SWALLOWED. This UPDATE is what carries the halt sentence onto the row, and the docblock
      // above says why it matters: without it /portal/employee/leave reads status 'pending' and shows
      // the employee a wait with no cause. `.catch(() => {})` meant a failure to record the reason
      // left no trace at all, so the request looked like an ordinary pending one to every screen.
      try {
        await db.execute(sql`
          UPDATE hr_leave_request SET halt_reason = ${why.slice(0, 500)}
           WHERE id = ${requestId} AND status = 'pending'`);
      } catch (e2: any) {
        logFail('routeLeaveRequest.markHalt', e2);
      }
      return { halted: true, haltReason: why, instanceId: null, routed: false };
    }
    const halted = wf.state === 'halted';
    const reason = halted ? (wf.haltReason || 'No approver could be resolved from the organization graph.') : null;
    await db.execute(sql`
      UPDATE hr_leave_request
         SET workflow_instance_id = ${wf.instanceId}::uuid, halt_reason = ${reason}::text
       WHERE id = ${requestId}`);
    return { halted, haltReason: reason, instanceId: wf.instanceId, routed: !halted };
  } catch (e: any) {
    logFail('routeLeaveRequest', e);
    const why = errText(e, 'The approval chain could not be started.');
    try {
      await db.execute(sql`UPDATE hr_leave_request SET halt_reason = ${why} WHERE id = ${requestId}`);
    } catch (e2: any) {
      logFail('routeLeaveRequest.mark', e2);
    }
    return { ...none, halted: true, haltReason: why };
  }
}

/**
 * WITHDRAW THE APPROVAL WHEN THE REQUEST IS DECIDED OR CANCELLED THE ORDINARY WAY.
 *
 * Without this the two engines never told each other anything: a request decided through
 * decideLeave() left its workflow instance 'pending' with a live step, so the routed approver kept
 * seeing it forever — and approving it flipped the instance to 'approved' while the leave row stayed
 * rejected or cancelled, two screens stating opposite facts about the same request with no way back.
 * expenses.ts, procurement.ts and invoices.ts all call cancelWorkflow() in exactly this situation.
 *
 * NEVER FAILS THE DECISION IT FOLLOWS. The decision is already committed; a stale instance is a
 * screen to clean up, not a reason to refuse. It is logged, never silent.
 */
async function closeLeaveWorkflow(requestId: string, actor: any, why: string): Promise<void> {
  try {
    const instance = await instanceForRecord('leave', String(requestId));
    if (!instance) return;
    if (instance.state !== 'pending' && instance.state !== 'halted') return;
    // THE REAL ACTOR, NEVER A FABRICATED ONE. cancelWorkflow admits the person who raised the request
    // or a holder of the domain capability, and it asks holdsCapability() about the user it is given —
    // so handing it a synthesised role would be this module granting itself authority, which is the
    // one thing the three-layer split exists to stop. Leave is the single domain that HAS a capability
    // ('leave.approve'), so an HR decision closes it and a requester closes their own; anything else
    // is LEFT ALONE and said out loud rather than forced.
    const res = await cancelWorkflow(instance.id, actor, why);
    if (!res.ok) {
      console.error('[hr-leave] the approval instance for leave', requestId, 'could not be withdrawn -', res.error);
    }
  } catch (e: any) {
    logFail('closeLeaveWorkflow', e);
  }
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
  /**
   * users.id of the person filing it. Carried into the approval instance so the engine can tell them
   * when it settles — workflow.notifyRequester() returns on its first line without it, which is why
   * every request started from the admin console has always settled silently.
   */
  requestedByUserId?: string | null;
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
  /**
   * WHAT HAPPENED TO THE APPROVAL. The request is filed either way; this says whether anybody was
   * actually asked. `halted: true` means the Organization Graph could not name an approver — the
   * request is visible on /admin/hr/leave/workflow with `haltReason` on it and can be resumed, and it
   * is NEVER auto-approved. A caller reporting success must show haltReason; "Waiting for approval"
   * on a request nobody was asked about is the sentence this whole repair exists to remove.
   */
  routing?: LeaveRouting;
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

  // =================================================================================================
  // THE ALLOWANCE TEST AND THE OVERLAP TEST ARE PART OF THE INSERT, NOT IN FRONT OF IT
  // =================================================================================================
  //
  // getBalances() above is a READ. Two applications submitted together — two tabs, a double tap on a
  // slow phone, a retried POST — both saw the same `remaining` and both were written, so a twelve-day
  // casual allowance could carry twenty-four approved days against it. Nothing showed it either:
  // getBalances() clamps remaining with Math.max(0, ...), so the over-consumption reads as a clean
  // zero on the balance screen, on the employee's portal and on the approver's queue alike.
  //
  // AND THERE WAS NO OVERLAP RULE ANYWHERE — not in this function, not as an index. One employee could
  // hold two or three simultaneous pending requests covering the same dates; a double-submitted form
  // produced two identical rows, both appeared in the approver's queue, both were approvable, and each
  // was charged to the allowance separately.
  //
  // Both tests now run inside the statement that writes the row, against the same snapshot, so the
  // second request sees the first one already counted and inserts nothing.
  //
  // WHY THE OVERLAP RULE IS SHAPED THE WAY IT IS. A blanket "no two requests may touch the same day"
  // would refuse a legitimate pair — a first-half and a second-half request on one date is two halves
  // of one day, not a double booking. So it refuses exactly two unambiguous things:
  //   * a WHOLE-day request overlapping an existing whole-day request. Nobody takes two full days off
  //     on the same date, whatever the two types are.
  //   * an EXACT repeat of a part-day request — same type, same date, same unit, same half. That is a
  //     double-submitted form and never a real second request.
  // Anything in between (a half day beside an hourly request) is left to a human, because refusing it
  // would be this module inventing a policy nobody set.
  //
  // NOT AN INDEX, AND HERE IS WHY. Range overlap cannot be expressed as a UNIQUE index; it needs an
  // EXCLUSION constraint over a daterange, which requires the btree_gist extension and a rewrite of
  // rows that already violate it. So the guard is a statement-level one and it is stated as such.
  // TO SEE WHETHER LIVE DATA ALREADY OVERLAPS (run this yourself — this process never connects):
  //   SELECT a.employee_id, a.id, b.id, a.start_date, a.end_date, b.start_date, b.end_date
  //     FROM hr_leave_request a JOIN hr_leave_request b
  //       ON a.employee_id = b.employee_id AND a.id < b.id
  //      AND a.start_date <= b.end_date AND a.end_date >= b.start_date
  //    WHERE a.status IN ('approved','pending') AND b.status IN ('approved','pending')
  //      AND COALESCE(a.unit,'full') = 'full' AND COALESCE(b.unit,'full') = 'full';
  // Existing overlaps are untouched; only new ones are refused.
  const year = Number(start.slice(0, 4));
  const allowanceGuard = (meta.source === 'allowance' && meta.allowance > 0)
    ? sql`AND ${dayUnits} <= ${meta.allowance} - COALESCE((
            SELECT SUM(COALESCE(r.day_units, r.days))
              FROM hr_leave_request r
             WHERE r.employee_id = ${employeeId}::uuid
               AND r.leave_type = ${type}
               AND r.status IN ('approved', 'pending')
               AND EXTRACT(YEAR FROM r.start_date) = ${year}), 0)`
    : sql``;

  try {
    const r = await db.execute(sql`
      INSERT INTO hr_leave_request
        (employee_id, leave_type, start_date, end_date, days, day_units, hours, day_part, unit, reason)
      SELECT ${employeeId}::uuid, ${type}, ${start}::date, ${end}::date, ${days}, ${dayUnits},
             ${hours}, ${dayPart}, ${unit}, ${reason || null}
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_leave_request o
          WHERE o.employee_id = ${employeeId}::uuid
            AND o.status IN ('approved', 'pending')
            AND o.start_date <= ${end}::date
            AND o.end_date >= ${start}::date
            AND (
              (${unit}::text = 'full' AND COALESCE(o.unit, 'full') = 'full')
              OR (o.leave_type = ${type}
                  AND o.start_date = ${start}::date AND o.end_date = ${end}::date
                  AND COALESCE(o.unit, 'full') = ${unit}::text
                  AND COALESCE(o.day_part, '') = COALESCE(${dayPart}::text, ''))
            )
       )
       ${allowanceGuard}
      RETURNING id`);
    const list = rows(r);
    if (!list.length) {
      // ZERO ROWS IS A REFUSAL, NOT A DATABASE FAILURE, and the two reasons need different sentences —
      // so the reason is re-read rather than guessed at. The credits taken above are handed back first,
      // because nothing was filed against them.
      if (meta.source === 'ledger') await refundCompOff(employeeId, dayUnits);
      const clash = await safe(sql`
        SELECT o.leave_type, o.start_date::text AS start_date, o.end_date::text AS end_date, o.status
          FROM hr_leave_request o
         WHERE o.employee_id = ${employeeId}::uuid
           AND o.status IN ('approved', 'pending')
           AND o.start_date <= ${end}::date
           AND o.end_date >= ${start}::date
         ORDER BY o.start_date ASC
         LIMIT 1`, 'applyLeave.clash');
      if (clash.length) {
        const c = clash[0];
        const other = leaveType(String(c.leave_type))?.name || 'leave';
        return {
          ok: false,
          error: 'You already have ' + String(c.status) + ' ' + other.toLowerCase() + ' covering '
            + String(c.start_date) + ' to ' + String(c.end_date) + ', so this was not filed. Withdraw '
            + 'that request first, or ask for days it does not already cover.',
        };
      }
      return {
        ok: false,
        error: 'Another request was filed against this allowance a moment ago and there is no longer '
          + 'enough left for this one, so nothing was saved. Reload your balance and try again.',
      };
    }
    const requestId = String(list[0].id);

    // WHO FILED IT, RECORDED ON THE ROW. hr_leave_request has never carried this, so nothing could
    // tell the person the outcome without going back through hr_employees — and the workflow engine
    // needs it to notify a requester at all.
    const filedBy = isUuid(opts?.requestedByUserId)
      ? String(opts.requestedByUserId)
      : await employeeUserId(employeeId);
    if (filedBy) {
      await db.execute(sql`UPDATE hr_leave_request SET requested_by_user_id = ${filedBy}::uuid WHERE id = ${requestId}`)
        .catch((e: any) => logFail('applyLeave.requestedBy', e));
    }

    // =============================================================================================
    // THE HANDOFF THAT DID NOT EXIST
    // =============================================================================================
    //
    // This function used to END at the INSERT. No approver was resolved, the org graph was never
    // consulted, and hr_leave_request has no approver column — so a filed request had no owner at
    // all. It was discovered only when somebody happened to open an admin list. Every other domain
    // in this product starts its own chain from its own service; leave, the only domain with a
    // capability declared on its chain and the only one with a dedicated console, was the single
    // one that never entered the engine.
    //
    // The routing NEVER unfiles the request. A chain that cannot be started leaves a filed request
    // carrying a stated reason, which a human can act on; discarding the request because routing
    // failed would lose work somebody already did.
    const routing = await routeLeaveRequest(
      requestId,
      employeeId,
      filedBy,
      (meta.name || type) + ' ' + describeUnits(unit, dayUnits, hours) + ' from ' + start + (start === end ? '' : ' to ' + end),
    );

    // =============================================================================================
    // A REQUEST NOBODY WAS TOLD ABOUT IS A REQUEST NOBODY DECIDES
    // =============================================================================================
    //
    // Everything above this line was right and still left a real person waiting. An employee filed
    // leave for a family function, routing found no approver because the organization graph is
    // empty, the row was correctly marked halted with its reason — and then NOTHING TOLD A HUMAN.
    // notifyEmployee() fires when a decision is made; there was no notification when one was asked
    // for. The request sat pending until the employee asked in a group chat why nothing had happened.
    //
    // So when routing does not reach somebody, the people who can decide it ANYWAY are told. That is
    // not a guess about who should approve: pendingLeaveForApprover() already returns every pending
    // request to anyone holding leave.approve, so those accounts can act on it today, with no graph
    // and no chain. They simply had no way of learning it existed.
    //
    // Deliberately only on the halted path. A routed request already notifies its approver through
    // the workflow engine, and telling the whole HR desk about every ordinary request as well would
    // train them to ignore the channel that matters.
    //
    // NEVER FAILS THE FILING. The leave is saved; a notification that could not be sent is a thing to
    // log, not a reason to reject somebody's request for time off.
    if (routing.halted) {
      try {
        const { notifyAllAdmins } = await import('@/lib/notify');
        const who = rows(await db.execute(sql`
          SELECT full_name FROM hr_employees WHERE id = ${employeeId} LIMIT 1`))[0];
        const name = who?.full_name ? String(who.full_name) : 'An employee';
        await notifyAllAdmins({
          title: name + ' asked for leave and it could not be routed',
          body: name + ' filed ' + describeUnits(unit, dayUnits, hours) + ' from ' + start
            + (start === end ? '' : ' to ' + end) + '. No approver could be resolved, so nobody was '
            + 'assigned it — but anyone who can approve leave can decide it from the leave queue. '
            + 'Reason given: ' + (routing.haltReason || 'unknown').slice(0, 200),
          type: 'leave',
          actionUrl: '/admin/hr/leave',
          entityType: 'leave_request',
          entityId: requestId,
        });
      } catch (e: any) {
        logFail('applyLeave.notifyUnrouted', e);
      }
    }

    return { ok: true, days, dayUnits, excluded: span.excluded, id: requestId, routing };
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
 * The same read, WITH the outcome — for a screen where being wrong costs somebody their time off.
 *
 * listLeave() goes through safe(), which catches, logs and returns []. That tolerance is right for a
 * widget on a workspace: one broken query must not blank a whole console. It is wrong for
 * /admin/hr/leave, where the identical empty array renders as "No leave requests waiting." — a
 * confident empty on a DECISION screen. Nobody investigates the word "none", so a total read failure
 * looked exactly like a quiet Tuesday and every pending request sat unactioned behind it.
 *
 * Same query, same shape, same ordering. The only difference is that the caller can tell the
 * difference between "nothing is waiting" and "we do not know what is waiting". Callers that
 * legitimately want the tolerant form keep listLeave(); nothing about it changes.
 *
 * Never throws — the failure comes back as `{ ok: false, error }`, so a page cannot forget to handle
 * it by forgetting a try/catch.
 */
export async function readLeave(
  opts: { employeeId?: string; status?: string } = {},
): Promise<{ ok: boolean; rows: any[]; error: string | null }> {
  try {
    await ensureLeaveSchema();
    const q = opts.employeeId
      ? sql`SELECT * FROM hr_leave_request WHERE employee_id = ${opts.employeeId} ORDER BY start_date DESC LIMIT 60`
      : sql`SELECT l.*, e.full_name, e.employee_code, e.designation
          FROM hr_leave_request l LEFT JOIN hr_employees e ON l.employee_id = e.id
          ${opts.status ? sql`WHERE l.status = ${opts.status}` : sql``}
          ORDER BY (l.status='pending') DESC, l.start_date DESC LIMIT 120`;
    return { ok: true, rows: await strictRead(q), error: null };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the SQL that failed.
    const reason = String(e?.cause?.message || e?.message || 'unknown database error');
    logFail('readLeave', e);
    return { ok: false, rows: [], error: reason };
  }
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
 *
 * `onError` — WHY AN EMPTY LIST NEEDED A SECOND CHANNEL. The catch below fails closed, which is
 * right, and returns [] — which is indistinguishable from a manager with nothing to decide. Both
 * /portal/approvals and /portal/employee were written to tell those two apart and neither could,
 * because this function never rejects: the try/catch on the page and the allSettled around it had
 * nothing to catch. So a refused read printed "Nothing is waiting on you" over real leave requests,
 * and the people in them waited for an answer that nobody knew they owed.
 *
 * It changes no behaviour and no visibility. The return is still [], still fail-closed; the callback
 * only lets a caller learn that the [] it is holding is not a fact about leave. It must not throw,
 * and a throw from it is swallowed rather than promoted into a failed read.
 */
export async function pendingLeaveForApprover(
  user: any,
  opts?: { onError?: (e: unknown) => void },
): Promise<any[]> {
  // Declared before the branches that use it. `const` is not hoisted.
  const reportError = (e: unknown): void => {
    try { opts?.onError?.(e); } catch { /* a broken reporter must not break the read */ }
  };
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
    // else's leave is a data leak. Fail closed, but SAY SO — see the note on onError above.
    logFail('pendingLeaveForApprover', e);
    reportError(e);
    return [];
  }
}

/**
 * HOW MANY PENDING LEAVE REQUESTS ARE SITTING WITH EACH MANAGER, IN ONE QUERY.
 *
 * WHY IT EXISTS. pendingLeaveForApprover() answers "what may THIS person decide" and costs a round
 * trip per person, so a load view over a whole roster would ask it once per manager. This is the
 * same rows, counted, grouped by the column that decides who they are waiting on.
 *
 * IT IS THE MANAGER ARM ONLY, AND THAT IS THE POINT. pendingLeaveForApprover() has two branches: a
 * holder of `leave.approve` sees EVERY pending request in the company, and everybody else sees the
 * requests of employees whose reporting_manager_id is their own users id. A per-person load column
 * built on the first branch would credit every standing-authority holder with the entire company's
 * leave queue, which says nothing about what that person is personally holding up. This counts the
 * second branch only — the requests routed to somebody BY the reporting line — and a surface that
 * also shows a standing-authority queue must label the two differently.
 *
 * NOTHING ABOUT A REQUEST LEAVES THIS QUERY. No dates, no type, no reason, no name: a count per
 * manager and nothing else. Leave reasons are never read or aggregated anywhere in this module and
 * they are not read here either.
 *
 * reporting_manager_id HOLDS A USERS ID, not an hr_employees id — the same column and the same
 * comparison approverRole() and pendingLeaveForApprover() make. Compared as text because it is a
 * UUID in one schema file and a slug elsewhere, and ::uuid would throw on the latter.
 *
 * ok:false ON FAILURE, NEVER AN EMPTY MAP. A manager with a fortnight of requests behind a broken
 * read must not be rendered as a manager with nothing waiting.
 */
export interface PendingLeaveCount {
  /** users.id of the manager the request routes to, per the reporting column. */
  managerUserId: string;
  pending: number;
}

export interface PendingLeaveCountsView {
  /** False means the read did not happen — never render "nothing is waiting" on this. */
  ok: boolean;
  rows: PendingLeaveCount[];
  /** The same counts keyed by manager, so a caller joining to a roster does no scanning. */
  byManagerUserId: Record<string, number>;
  /**
   * Pending requests whose employee has NO reporting manager recorded on the column. They are
   * waiting on nobody in particular, and they are invisible on every manager's queue — which is
   * exactly the kind of zero that looks like an empty queue and is not.
   */
  unrouted: number;
  error?: string;
}

export async function pendingLeaveCountsByManager(): Promise<PendingLeaveCountsView> {
  await ensureLeaveSchema();
  try {
    const list = rows(await db.execute(sql`
      SELECT e.reporting_manager_id::text AS manager_user_id, COUNT(*)::int AS n
        FROM hr_leave_request l
        JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.status = 'pending'
       GROUP BY e.reporting_manager_id`));

    const byManagerUserId: Record<string, number> = {};
    const out: PendingLeaveCount[] = [];
    let unrouted = 0;
    for (const row of list) {
      const id = String(row?.manager_user_id || '').trim();
      const n = Number(row?.n) || 0;
      if (!id) { unrouted += n; continue; }
      byManagerUserId[id] = n;
      out.push({ managerUserId: id, pending: n });
    }
    out.sort((a, b) => b.pending - a.pending);
    return { ok: true, rows: out, byManagerUserId, unrouted };
  } catch (e: any) {
    logFail('pendingLeaveCountsByManager', e);
    return {
      ok: false,
      rows: [],
      byManagerUserId: {},
      unrouted: 0,
      error: String(e?.cause?.message || e?.message || 'unknown database error'),
    };
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
export async function cancelLeave(id: string, employeeId: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLeaveSchema();
  try {
    const cancelled = rows(await db.execute(sql`
      UPDATE hr_leave_request SET status='cancelled'
       WHERE id = ${id} AND employee_id = ${employeeId} AND status='pending'
      RETURNING leave_type, COALESCE(day_units, days) AS units, requested_by_user_id::text AS requested_by_user_id`));

    // ZERO ROWS IS NOT SUCCESS, AND IT USED TO READ AS SUCCESS.
    //
    // This returned void and caught everything, and the page printed "Request cancelled. Any comp off
    // it used has been returned." whatever happened. A person whose UPDATE matched nothing — already
    // decided, wrong employee, a typed id — believed they were working that day, the approver still
    // saw a live request, and the comp off was never returned. Discovered when somebody asked why
    // they were not at their desk.
    if (!cancelled.length) {
      return {
        ok: false,
        error: 'Nothing was cancelled. That request is no longer pending — it may already have been '
          + 'decided. Reload this page to see where it stands.',
      };
    }

    if (String(cancelled[0].leave_type) === 'comp_off') {
      await refundCompOff(employeeId, Number(cancelled[0].units) || 0);
    }

    // THE APPROVAL GOES WITH IT. Otherwise the routed approver keeps a live step for a request that
    // no longer exists, and approving it would flip the instance to 'approved' while the leave row
    // reads 'cancelled'.
    const by = String(cancelled[0].requested_by_user_id || '') || (await employeeUserId(employeeId)) || null;
    await closeLeaveWorkflow(id, { id: by }, 'Withdrawn by the person who raised it');

    return { ok: true };
  } catch (e: any) {
    logFail('cancelLeave', e);
    return { ok: false, error: errText(e, 'That request could not be cancelled just now. Nothing was changed.') };
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

  // THE PRECONDITION IS RESTATED IN THE WRITE, and the write's own answer decides what follows.
  //
  // The status was read at the top of this function and the UPDATE then ran unconditionally, so two
  // decisions landing together BOTH took effect. Three things went wrong at once, and none of them
  // left a trace anybody could follow:
  //   * approve-then-reject: markLeaveAttendance() below had already stamped the days 'on_leave' while
  //     the row now reads 'rejected'. Attendance and leave disagree permanently about the same days,
  //     and payroll reads attendance — so the employee is charged for leave they were refused.
  //   * reject-then-reject on a comp_off request: refundCompOff() ran TWICE and handed back the units
  //     twice. The per-credit guard (consumed_units >= back) does not stop it, because with several
  //     credits there is more than one row to draw the second refund from. Comp off out of nothing.
  //   * decided_by is overwritten by the loser, so audit_log names one person and the row names another.
  //
  // cancelLeave() a few lines up already had this shape. This is the same guard on the decision path.
  const decided = rows(await db.execute(sql`
    UPDATE hr_leave_request
       SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role},
           decided_at = NOW(), decision_note = ${note || null}
     WHERE id = ${id} AND status = 'pending'
    RETURNING id`));
  if (!decided.length) {
    return {
      ok: false,
      error: 'That request was decided by somebody else while this page was open, and nothing was '
        + 'changed. Reload it to see the decision that stands.',
    };
  }

  const warnings: string[] = [];

  // Approving leave has to reach attendance, or the two modules disagree about the same day:
  // payroll counts attendance, so an approved leave day with no attendance row was counted as
  // nothing at all, and a day the employee had been told to take off could be read as absence.
  //
  // ITS ANSWER IS READ NOW. markLeaveAttendance() has always returned the number of days it managed
  // to write and BOTH callers threw that number away. Every per-day INSERT failure is logged and the
  // loop continues, so `written` can legitimately be 0 — the approval recorded, the balance charged,
  // the approver told "Decision recorded.", and NO ATTENDANCE ROW ANYWHERE. computePay() then counts
  // those days as nothing at all, or an operator's bulk mark-absent turns approved leave into loss of
  // pay. Unlike overtime and attendance corrections there is no sweep that re-runs, so if this is not
  // said here it is not said until somebody queries a payslip months later.
  if (decision === 'approved') {
    const written = await markLeaveAttendance(l);
    const expected = expectedAttendanceDays(l);
    if (written <= 0 && expected > 0) {
      warnings.push(
        'The approval is saved, but NO attendance rows could be written for these days, so payroll '
        + 'will not see this leave. Record the days on the attendance screen, or approve again once '
        + 'the attendance table is reachable.',
      );
    } else if (written < expected) {
      warnings.push(
        'The approval is saved, but only ' + written + ' of ' + expected + ' day(s) reached the '
        + 'attendance record. Check the remaining days on the attendance screen.',
      );
    }
  }

  // A REJECTED COMP-OFF REQUEST GETS ITS CREDITS BACK. They were spent when the request was filed.
  if (decision === 'rejected' && String(l.leave_type) === 'comp_off') {
    await refundCompOff(String(l.employee_id), Number(l.day_units ?? l.days) || 0);
  }

  // THE OTHER ENGINE IS TOLD. Without this the workflow instance stays 'pending' with a live step
  // forever and the routed approver keeps being asked to decide something already decided.
  await closeLeaveWorkflow(String(id), user, 'Decided directly on the leave console (' + decision + ')');

  // THE PERSON IS TOLD. This module sent nothing, in either direction, ever.
  await notifyEmployee(String(l.employee_id), {
    type: 'leave_decision',
    title: decision === 'approved' ? 'Leave approved' : 'Leave declined',
    body: leaveTypeName(String(l.leave_type)) + ' ' + String(l.start_date).slice(0, 10)
      + (String(l.start_date).slice(0, 10) === String(l.end_date).slice(0, 10) ? '' : ' to ' + String(l.end_date).slice(0, 10))
      + (note ? ' - ' + String(note).slice(0, 140) : ''),
    tag: 'leave-' + String(id),
  });

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
    warnings.push('The decision is saved, but it could not be written to the audit log, so there is no permanent record of who made it.');
  }

  return warnings.length ? { ok: true, warning: warnings.join(' ') } : { ok: true };
}

/**
 * How many attendance days an approved request OUGHT to produce — the same span markLeaveAttendance()
 * walks, without the holiday read (which is a database call and would double the cost of a decision).
 *
 * Deliberately an UPPER bound: it counts calendar days, so a span containing holidays expects more
 * days than are written and the caller reports a partial write. That is the safe direction — a
 * warning nobody needed is a sentence; a silent zero is a month of wrong pay. Declared here, after
 * its only reader, because it is a function declaration and those ARE hoisted; every `const` in this
 * module still sits above its first use.
 */
function expectedAttendanceDays(l: any): number {
  const s = new Date(String(l?.start_date || '').slice(0, 10) + 'T00:00:00Z');
  const e = new Date(String(l?.end_date || '').slice(0, 10) + 'T00:00:00Z');
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return 0;
  const span = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  return span > MAX_SPAN_DAYS ? 0 : span;
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

// -------------------------------------------------------------------------------------------------
// THE OTHER DOOR: A DECISION THAT ARRIVED THROUGH THE APPROVAL ENGINE
// -------------------------------------------------------------------------------------------------

/**
 * Apply a workflow decision to the leave row it settles.
 *
 * WHY THIS LIVES HERE AND NOT IN THE ENGINE. src/lib/workflow.ts had the leave settlement inlined,
 * and it did three-quarters of the job: it wrote the status and stamped attendance, and it did NOT
 * refund comp off on a rejection and did NOT tell the employee anything. So a comp-off request
 * rejected through the engine consumed the days the person had earned from approved overtime, with
 * no reversal row and nothing on any screen saying where they went — permanent and silent — while the
 * same rejection through decideLeave() refunded correctly. Leave policy belongs to the leave module;
 * the engine now calls this and there is ONE settlement, so the two doors cannot diverge again.
 *
 * STILL GUARDED TO 'pending'. A request already decided the ordinary way is left exactly as the
 * person who decided it left it, and the two paths cannot overwrite each other.
 *
 * NEVER THROWS INTO THE ENGINE. A settlement that cannot reach this table is logged and reported;
 * the workflow still shows the decision that was genuinely made.
 */
export async function settleLeaveFromWorkflow(
  requestId: string,
  state: 'approved' | 'rejected',
  actorUserId: string | null,
  instanceId: string,
): Promise<{ settled: boolean; warning?: string }> {
  try {
    await ensureLeaveSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE hr_leave_request
         SET status = ${state},
             decided_by = ${actorUserId}::uuid,
             decided_by_role = 'workflow',
             decided_at = NOW(),
             halt_reason = NULL,
             decision_note = ${'Decided through the approval workflow (' + instanceId + ')'}
       WHERE id::text = ${String(requestId)}
         AND status = 'pending'
      RETURNING *`));
    if (!wrote.length) return { settled: false };

    const l = wrote[0];
    let warning: string | undefined;

    if (state === 'approved') {
      const written = await markLeaveAttendance(l);
      const expected = expectedAttendanceDays(l);
      if (written <= 0 && expected > 0) {
        warning = 'The approval is saved, but no attendance rows could be written, so payroll will not see this leave.';
        console.error('[hr-leave] workflow approval for leave', requestId, 'wrote NO attendance rows');
      }
    }

    // THE REFUND THE ENGINE PATH NEVER MADE. Credits are spent at filing time, so a rejection that
    // does not hand them back costs somebody days they earned.
    if (state === 'rejected' && String(l.leave_type) === 'comp_off') {
      await refundCompOff(String(l.employee_id), Number(l.day_units ?? l.days) || 0);
    }

    await notifyEmployee(String(l.employee_id), {
      type: 'leave_decision',
      title: state === 'approved' ? 'Leave approved' : 'Leave declined',
      body: leaveTypeName(String(l.leave_type)) + ' ' + String(l.start_date).slice(0, 10)
        + (String(l.start_date).slice(0, 10) === String(l.end_date).slice(0, 10) ? '' : ' to ' + String(l.end_date).slice(0, 10)),
      tag: 'leave-' + String(requestId),
    });

    return { settled: true, warning };
  } catch (e: any) {
    logFail('settleLeaveFromWorkflow', e);
    return { settled: false, warning: errText(e, 'The decision could not be written to the leave record.') };
  }
}
