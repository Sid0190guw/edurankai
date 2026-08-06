// src/lib/settlement.ts — FULL AND FINAL SETTLEMENT, and the statement that explains it.
//
// =================================================================================================
// WHAT THIS IS
// =================================================================================================
//
// When somebody leaves, four questions have to be answered in one place and written down:
//   1. what salary is still owed for the days they actually worked in their final month;
//   2. what unused leave, if any, is being encashed, and at what rate;
//   3. what they still owe on a loan or a salary advance;
//   4. whether the equipment they hold has come back.
// The answer is a SETTLEMENT FIGURE and a payslip-style statement that shows how it was reached.
//
// =================================================================================================
// FOUR THINGS THIS FILE REFUSES TO DO
// =================================================================================================
//
// 1. IT DOES NOT PAY ANYBODY. Nothing here moves money. A settlement is prepared, approved through
//    src/lib/workflow.ts, and then HANDED OFF — recorded with a reference somebody can follow, in the
//    same shape the separation console already uses. There is no arm in this file that credits a
//    wallet, and there must not be one.
//
// 2. IT DOES NOT RECOMPUTE THE LOAN BALANCE. Outstanding loan and advance figures are READ from
//    src/lib/loans.ts, which owns the recovery ledger, and the balance is closed by calling that
//    module's own settleLoanOutsidePayroll(). A second arithmetic over one ledger is how a leaver
//    ends up with a settlement that disagrees with their own loan screen by a few hundred rupees and
//    nobody can say which number is wrong.
//
// 3. IT DOES NOT INVENT AN ENCASHMENT RULE. How many days of unused leave are paid out, and at what
//    rate, is a POLICY this product does not hold and must not guess. So the module states the FACTS
//    it can stand behind — the unused balance per leave type, and a per-day figure derived from the
//    person's own regular gross — and the encashment itself is a line an operator enters, with those
//    facts shown beside the field. A default that looks like a rule is a rule.
//
// 4. IT DOES NOT APPROVE ANYTHING. Routed through the ONE approval engine, domain 'separation', with
//    the record id NAMESPACED as 'settlement:<separation id>' so the settlement's approval and the
//    separation's own approval are two different instances over two different decisions and cannot
//    collide on (domain, record_id). That namespacing is the pattern the performance module already
//    uses on the 'promotion' domain; it is a stated adaptation, not a hidden one.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. rows() below; never r.rows[0].
//   - the real Postgres reason is on e.cause.
//   - every const above the function that reads it.
//   - DDL in ONE ensureOnce guard that logs the cause and re-throws so a failed run retries.
//   - no exception swallowed in a write path.
//   - NO BACKTICK inside a sql template literal, not even in a comment.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { startWorkflow, getInstance } from '@/lib/workflow';
import { computePay, MONTH_NAMES } from '@/lib/payroll';
import { outstandingForEmployee, settleLoanOutsidePayroll, loanKindLabel, type LoanRow } from '@/lib/loans';
import { getBalances, type LeaveBalance } from '@/lib/hr-leave';
import { clearanceFor, recordSettlementHandoff, ensureExitSchema } from '@/lib/hr-separation';
// ONE ROUNDING RULE, SHARED. The copy that lived in this file was
// `Math.round((Number(n) || 0) * 100) / 100`, which rounds a half paisa DOWN whenever the product
// lands just under .5 in IEEE754 (1.005 * 100 === 100.49999999999999) — always against the leaver.
// sumMoney() adds in integer paise so a statement's total equals the lines it prints. src/lib/money.ts.
import { round2, sumMoney } from '@/lib/money';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');

const logFail = (tag: string, e: any) => console.error('[settlement] ' + tag, reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** Money owed to the leaver, or money recovered from what is owed. Two words, two columns of a page. */
export const SETTLEMENT_LINE_KINDS = ['earning', 'deduction'] as const;
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number];

/**
 * WHERE A SETTLEMENT CAN BE.
 *
 *   draft      being prepared. Lines can still be added, changed and recomputed.
 *   pending    routed for approval. NOTHING on it may change from here on.
 *   halted     routing could not name an approver. Not approved, not waiting on anybody.
 *   rejected   an approver refused the figure. Terminal.
 *   cancelled  withdrawn. Terminal.
 *   approved   the figure is agreed. STILL NOT PAID.
 *   settled    handed off to whoever pays it, with a reference. Terminal.
 */
export type SettlementState =
  | 'draft' | 'pending' | 'halted' | 'rejected' | 'cancelled' | 'approved' | 'settled';

export const SETTLEMENT_STATE_LABELS: Record<SettlementState, string> = {
  draft: 'Being prepared',
  pending: 'Waiting for approval',
  halted: 'Halted',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
  approved: 'Approved, not yet paid',
  settled: 'Handed off for payment',
};

export function settlementStateLabel(s: string): string {
  const k = String(s || '') as SettlementState;
  return SETTLEMENT_STATE_LABELS[k] || k;
}

/** Only these states allow the lines to be touched. Everything else is a record of a decision. */
const EDITABLE_STATES = new Set<SettlementState>(['draft']);

const MAX_LINE_AMOUNT = 100000000;

/** Codes reserved for lines this module computes. A manual line never carries one. */
const AUTO_FINAL_SALARY = 'final_salary';

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------
//
// TWO TABLES. Grep before adding a third: two CREATE TABLE statements for one table with different
// shapes silently break every write for whichever module lost the race.
//
//   hr_settlements        one per separation, enforced by a UNIQUE index rather than only by this
//                         file, so a second console could not open a rival settlement over one exit.
//   hr_settlement_lines   the statement, line by line. `code` is set on lines this module computes
//                         and NULL on lines a person typed; the unique index therefore stops a
//                         duplicate auto line without ever stopping two manual lines that happen to
//                         share a label.

export function ensureSettlementSchema(): Promise<void> {
  return ensureOnce('hr_settlements_v1', async () => {
    try {
      // hr_separations MUST exist before a table can reference it. Awaited here rather than assumed,
      // exactly as ensureExitSchema() itself awaits ensureSeparationSchema(): on a fresh database the
      // reference would otherwise fail, this guard would re-throw, and the settlement console would
      // read as permanently empty for a reason nothing on screen could explain.
      await ensureExitSchema();

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_settlements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        separation_id UUID NOT NULL REFERENCES hr_separations(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        state VARCHAR(20) NOT NULL DEFAULT 'draft',
        halt_reason TEXT,
        workflow_instance_id UUID,
        notes TEXT,
        prepared_by_user_id UUID,
        settled_reference TEXT,
        settled_at TIMESTAMPTZ,
        settled_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_settlements_sep_uniq
        ON hr_settlements(separation_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_settlements_state_idx
        ON hr_settlements(state, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_settlement_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        settlement_id UUID NOT NULL REFERENCES hr_settlements(id) ON DELETE CASCADE,
        code TEXT,
        label VARCHAR(200) NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'earning',
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        source VARCHAR(10) NOT NULL DEFAULT 'manual',
        note TEXT,
        sort_order INT NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_settlement_lines_code_uniq
        ON hr_settlement_lines(settlement_id, code)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_settlement_lines_idx
        ON hr_settlement_lines(settlement_id, sort_order)`);
    } catch (e: any) {
      logFail('ensureSettlementSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries.
    }
  });
}

async function safeEnsure(): Promise<boolean> {
  try {
    await ensureSettlementSchema();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// THE FACTS — read, never assumed, and each one able to say it could not be read
// -------------------------------------------------------------------------------------------------

export interface SettlementFacts {
  separationId: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  currency: string;
  lastWorkingDay: string | null;
  /** Days of the final month actually worked, up to and including the last working day. */
  finalMonthDaysWorked: number;
  finalMonthDays: number;
  finalMonthLabel: string;
  /** The person's regular monthly gross, from the live salary structure. Bonuses excluded by design. */
  regularGross: number;
  /** regularGross divided by the days in the final month. The only per-day figure this module offers. */
  perDayRate: number;
  /** Salary for the days worked in the final month, IF no payslip for that month exists yet. */
  unpaidFinalSalary: number;
  /** True when payroll already ran for the final month, so no salary line is proposed. */
  finalMonthAlreadyPaid: boolean;
  /** Unused balance per leave type. Facts only — this module proposes no encashment. */
  leaveBalances: LeaveBalance[];
  /** Live loans and advances with something still owed. */
  loans: LoanRow[];
  loanOutstandingTotal: number;
  /** Whether the asset clearance on the separation has been signed off. */
  assetsCleared: boolean;
  assetsClearanceStatus: string;
  /** Named things that could not be read, in words. Never an empty list dressed up as a zero. */
  gaps: string[];
}

/**
 * EVERYTHING THE SETTLEMENT NEEDS TO KNOW, gathered once and stated plainly.
 *
 * READ-ONLY. It writes nothing, so a screen can show what a settlement WOULD look like before
 * anybody opens one.
 *
 * THE FINAL-SALARY METHOD, IN FULL, because it appears on a document handed to a person who has just
 * lost their income: regular monthly gross divided by the number of days in their final calendar
 * month, multiplied by the number of days of that month up to and including their last working day.
 * Calendar days, matching how this codebase already prices loss of pay in src/lib/payroll.ts, so the
 * two never disagree about what a day of somebody's pay is worth. If payroll has ALREADY run for
 * that month the figure is zero and the reason is stated, because paying it twice is the error that
 * costs the company and paying it never is the error that costs the person.
 */
export async function settlementFacts(separationId: string): Promise<SettlementFacts | null> {
  if (!isUuid(separationId)) return null;
  const gaps: string[] = [];

  let sep: any = null;
  try {
    sep = rows(await db.execute(sql`
      SELECT s.id, s.employee_id, s.last_working_day, s.ff_currency,
             e.full_name, e.employee_code, e.currency AS emp_currency
        FROM hr_separations s
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.id = ${separationId}::uuid LIMIT 1`))[0] || null;
  } catch (e: any) {
    logFail('settlementFacts.separation', e);
    return null;
  }
  if (!sep) return null;

  const employeeId = String(sep.employee_id || '');
  const lwd = sep.last_working_day ? String(sep.last_working_day).slice(0, 10) : null;

  // The final month is the month of the last working day. Without one there is nothing to prorate
  // against, and that is said out loud rather than guessed at from today's date — a settlement dated
  // by the day somebody happened to open the screen is not a settlement.
  const lwdDate = lwd ? new Date(lwd + 'T00:00:00') : null;
  const haveLwd = !!lwdDate && !isNaN(lwdDate.getTime());
  if (!haveLwd) gaps.push('the last working day, which the final month is calculated from');

  const month = haveLwd ? lwdDate!.getMonth() + 1 : 0;
  const year = haveLwd ? lwdDate!.getFullYear() : 0;
  const finalMonthDays = haveLwd ? new Date(year, month, 0).getDate() : 0;
  const finalMonthDaysWorked = haveLwd ? lwdDate!.getDate() : 0;

  let regularGross = 0;
  let currency = String(sep.ff_currency || sep.emp_currency || 'INR');
  if (haveLwd && isUuid(employeeId)) {
    try {
      const pay = await computePay(employeeId, { month, year });
      regularGross = pay.regularGross;
      currency = String(sep.ff_currency || pay.currency || currency);
      for (const g of pay.gaps) gaps.push(g);
    } catch (e: any) {
      logFail('settlementFacts.pay', e);
      gaps.push('the salary structure this settlement is calculated from');
    }
  }

  let finalMonthAlreadyPaid = false;
  if (haveLwd && isUuid(employeeId)) {
    try {
      const paid = rows(await db.execute(sql`
        SELECT id FROM hr_payslips
         WHERE employee_id = ${employeeId}::uuid AND month = ${month} AND year = ${year} LIMIT 1`));
      finalMonthAlreadyPaid = paid.length > 0;
    } catch (e: any) {
      logFail('settlementFacts.payslip', e);
      gaps.push('whether payroll has already run for the final month');
    }
  }

  // MULTIPLY FIRST, ROUND ONCE. This was round2(gross / days) followed by a multiplication by the
  // days worked, so the rounding error on the per-day figure was multiplied by up to 31: a 75,000
  // gross over a 31-day month with all 31 days worked paid 74,999.85 — fifteen paise short of a month
  // actually worked — and a 65,000 gross over 28 days paid 65,000.04, four paise more than the month
  // is worth. perDayRate is still published because the statement PRINTS it, but it is now a display
  // figure and no longer the thing the total is derived from.
  const perDayRate = finalMonthDays > 0 ? round2(regularGross / finalMonthDays) : 0;
  const unpaidFinalSalary = finalMonthAlreadyPaid || finalMonthDays <= 0
    ? 0
    : round2((regularGross * finalMonthDaysWorked) / finalMonthDays);

  let leaveBalances: LeaveBalance[] = [];
  if (isUuid(employeeId)) {
    try {
      leaveBalances = await getBalances(employeeId, haveLwd ? year : undefined);
    } catch (e: any) {
      logFail('settlementFacts.leave', e);
      gaps.push('the leave balance');
    }
  }

  let loans: LoanRow[] = [];
  try {
    loans = await outstandingForEmployee(employeeId);
    // A LOAN IN ANOTHER CURRENCY IS NOT DEDUCTED FROM THIS STATEMENT.
    //
    // refreshComputedLines() writes one 'loan:<id>' deduction per row below, using l.outstanding as a
    // bare number against a settlement denominated in `currency`. A loan of USD 4,000 outstanding was
    // therefore deducted as 4,000 RUPEES from a rupee final settlement — the leaver kept most of a
    // debt the statement says was recovered — and finaliseSettlement() then closed that loan in full
    // through settleLoanOutsidePayroll(), so the balance disappeared from the register as well.
    //
    // No conversion, for the reason src/lib/payroll.ts gives at the same decision: there is no
    // exchange rate in this codebase. The loan is left off the statement and still open, which is the
    // recoverable state, and the reason is on the gap list every settlement screen prints.
    const sameCurrency: LoanRow[] = [];
    for (const l of loans) {
      const loanCurrency = String(l.currency || currency).toUpperCase();
      if (loanCurrency !== String(currency).toUpperCase()) {
        gaps.push(
          'a ' + loanKindLabel(l.kind).toLowerCase() + ' of ' + loanCurrency + ' '
          + l.outstanding.toLocaleString('en-IN') + ' is still outstanding, but it is recorded in '
          + loanCurrency + ' and this settlement is in ' + currency + '. It has NOT been deducted here '
          + 'and the loan stays open — there is no exchange rate in this system to convert it with. '
          + 'Recover it separately, or re-record the loan in ' + currency + '.',
        );
        continue;
      }
      sameCurrency.push(l);
    }
    loans = sameCurrency;
  } catch (e: any) {
    logFail('settlementFacts.loans', e);
    gaps.push('outstanding loan and advance balances');
  }

  let assetsClearanceStatus = 'pending';
  try {
    const clearance = await clearanceFor(separationId);
    const assets = clearance.find((c) => c.area === 'assets');
    assetsClearanceStatus = String(assets?.status || 'pending');
  } catch (e: any) {
    logFail('settlementFacts.clearance', e);
    gaps.push('the asset clearance');
  }

  return {
    separationId,
    employeeId,
    employeeName: sep.full_name ? String(sep.full_name) : null,
    employeeCode: sep.employee_code ? String(sep.employee_code) : null,
    currency,
    lastWorkingDay: lwd,
    finalMonthDaysWorked,
    finalMonthDays,
    finalMonthLabel: haveLwd ? (MONTH_NAMES[month - 1] + ' ' + year) : 'not known',
    regularGross,
    perDayRate,
    unpaidFinalSalary,
    finalMonthAlreadyPaid,
    leaveBalances,
    loans,
    loanOutstandingTotal: sumMoney(loans.map((l) => l.outstanding)),
    assetsCleared: assetsClearanceStatus === 'cleared',
    assetsClearanceStatus,
    gaps,
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface SettlementLine {
  id: string;
  code: string | null;
  label: string;
  kind: SettlementLineKind;
  amount: number;
  source: string;
  note: string | null;
  sortOrder: number;
}

export interface SettlementRow {
  id: string;
  separationId: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  currency: string;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  notes: string | null;
  settledReference: string | null;
  settledAt: string | null;
  createdAt: string | null;
  lines: SettlementLine[];
  totalEarnings: number;
  totalDeductions: number;
  /** Earnings minus deductions. May be NEGATIVE, and it is shown as such rather than clamped to zero:
   *  somebody who owes more than they are due owes the difference, and hiding that means nobody ever
   *  asks for it back. */
  netPayable: number;
}

function mapLine(r: any): SettlementLine {
  return {
    id: String(r?.id ?? ''),
    code: r?.code ? String(r.code) : null,
    label: String(r?.label ?? ''),
    kind: (String(r?.kind) === 'deduction' ? 'deduction' : 'earning'),
    amount: Number(r?.amount) || 0,
    source: String(r?.source || 'manual'),
    note: r?.note ? String(r.note) : null,
    sortOrder: Number(r?.sort_order) || 100,
  };
}

/**
 * THE TOTALS EQUAL THE LINES THAT ARE PRINTED BESIDE THEM.
 *
 * These were `reduce((s, l) => s + l.amount, 0)` — doubles added left to right, so the accumulated
 * representation error can reach the second decimal on a statement with many lines and the printed
 * total then differs from the printed lines by a paisa. A leaver querying their final statement is
 * the last person who should be told the document does not add up. sumMoney() adds integer paise,
 * where that failure mode does not exist.
 */
function totalsOf(lines: SettlementLine[]) {
  const totalEarnings = sumMoney(lines.filter((l) => l.kind === 'earning').map((l) => l.amount));
  const totalDeductions = sumMoney(lines.filter((l) => l.kind === 'deduction').map((l) => l.amount));
  return { totalEarnings, totalDeductions, netPayable: round2(totalEarnings - totalDeductions) };
}

/** One settlement with its statement lines, or null. Fails closed. */
export async function getSettlement(id: string): Promise<SettlementRow | null> {
  if (!isUuid(id)) return null;
  if (!(await safeEnsure())) return null;
  try {
    const head = rows(await db.execute(sql`
      SELECT s.*, e.full_name AS employee_name, e.employee_code AS employee_code
        FROM hr_settlements s
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.id = ${id}::uuid LIMIT 1`))[0] as any;
    if (!head) return null;
    const lineRows = rows(await db.execute(sql`
      SELECT * FROM hr_settlement_lines WHERE settlement_id = ${id}::uuid
       ORDER BY (kind = 'deduction'), sort_order ASC, created_at ASC`)).map(mapLine);
    return {
      id: String(head.id),
      separationId: String(head.separation_id),
      employeeId: String(head.employee_id),
      employeeName: head.employee_name ? String(head.employee_name) : null,
      employeeCode: head.employee_code ? String(head.employee_code) : null,
      currency: String(head.currency || 'INR'),
      state: String(head.state || 'draft'),
      haltReason: head.halt_reason ? String(head.halt_reason) : null,
      workflowInstanceId: head.workflow_instance_id ? String(head.workflow_instance_id) : null,
      notes: head.notes ? String(head.notes) : null,
      settledReference: head.settled_reference ? String(head.settled_reference) : null,
      settledAt: head.settled_at ? new Date(head.settled_at).toISOString() : null,
      createdAt: head.created_at ? new Date(head.created_at).toISOString() : null,
      lines: lineRows,
      ...totalsOf(lineRows),
    };
  } catch (e: any) {
    logFail('getSettlement', e);
    return null;
  }
}

/** The settlement attached to one separation, or null when none has been opened. */
export async function settlementForSeparation(separationId: string): Promise<SettlementRow | null> {
  if (!isUuid(separationId)) return null;
  if (!(await safeEnsure())) return null;
  try {
    const r = rows(await db.execute(sql`
      SELECT id FROM hr_settlements WHERE separation_id = ${separationId}::uuid LIMIT 1`));
    return r.length ? await getSettlement(String(r[0].id)) : null;
  } catch (e: any) {
    logFail('settlementForSeparation', e);
    return null;
  }
}

export interface SettlementListRow {
  id: string;
  separationId: string;
  employeeName: string | null;
  state: string;
  currency: string;
  netPayable: number;
  lastWorkingDay: string | null;
  createdAt: string | null;
}

/** Every settlement, open ones first. Aggregate list — one row per EXIT, not per pay component. */
export async function listSettlements(limit = 100): Promise<SettlementListRow[]> {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  if (!(await safeEnsure())) return [];
  try {
    const r = await db.execute(sql`
      SELECT s.id, s.separation_id, s.state, s.currency, s.created_at,
             e.full_name AS employee_name,
             sep.last_working_day,
             COALESCE(SUM(CASE WHEN l.kind = 'deduction' THEN -l.amount ELSE l.amount END), 0) AS net_payable
        FROM hr_settlements s
        LEFT JOIN hr_employees e ON e.id = s.employee_id
        LEFT JOIN hr_separations sep ON sep.id = s.separation_id
        LEFT JOIN hr_settlement_lines l ON l.settlement_id = s.id
       GROUP BY s.id, s.separation_id, s.state, s.currency, s.created_at, e.full_name, sep.last_working_day
       ORDER BY (s.state IN ('draft', 'pending', 'halted', 'approved')) DESC, s.created_at DESC
       LIMIT ${lim}`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      separationId: String(x.separation_id),
      employeeName: x.employee_name ? String(x.employee_name) : null,
      state: String(x.state || 'draft'),
      currency: String(x.currency || 'INR'),
      netPayable: round2(Number(x.net_payable) || 0),
      lastWorkingDay: x.last_working_day ? String(x.last_working_day).slice(0, 10) : null,
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail('listSettlements', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface SettlementResult {
  ok: boolean;
  id?: string;
  error?: string;
  haltReason?: string | null;
  changed?: boolean;
}

/**
 * OPEN A SETTLEMENT for one separation, and fill in the lines this module can stand behind.
 *
 * Idempotent: opening one that already exists returns it with changed:false rather than creating a
 * second, and the unique index on separation_id rejects a concurrent second insert that the read
 * could not have seen.
 */
export async function openSettlement(
  separationId: string,
  actorUserId: string | null,
): Promise<SettlementResult> {
  if (!isUuid(separationId)) return { ok: false, error: 'That separation could not be identified.' };
  const by = isUuid(actorUserId) ? String(actorUserId) : null;
  try {
    await ensureSettlementSchema();

    const existing = rows(await db.execute(sql`
      SELECT id FROM hr_settlements WHERE separation_id = ${separationId}::uuid LIMIT 1`));
    if (existing.length) return { ok: true, id: String(existing[0].id), changed: false };

    const facts = await settlementFacts(separationId);
    if (!facts) return { ok: false, error: 'That separation could not be found.' };

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_settlements (separation_id, employee_id, currency, state, prepared_by_user_id)
      VALUES (${separationId}::uuid, ${facts.employeeId}::uuid, ${facts.currency}, 'draft', ${by}::uuid)
      ON CONFLICT (separation_id) DO NOTHING
      RETURNING id`));
    if (!ins.length) {
      // The unique index won a race the read above could not see. Return the winner: the caller's
      // intent was satisfied, and creating a rival settlement over one exit is exactly what the
      // index is there to prevent.
      const raced = rows(await db.execute(sql`
        SELECT id FROM hr_settlements WHERE separation_id = ${separationId}::uuid LIMIT 1`));
      if (raced.length) return { ok: true, id: String(raced[0].id), changed: false };
      return { ok: false, error: WRITE_FAILED };
    }
    const id = String(ins[0].id);

    const refreshed = await refreshComputedLines(id, by);
    if (!refreshed.ok) return { ok: true, id, changed: true, error: refreshed.error };

    await logAudit({
      userId: by, action: 'settlement.opened', entity: 'hr_settlement', entityId: id,
      diff: { separationId, employeeId: facts.employeeId },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('openSettlement', e);
    return { ok: false, error: 'The settlement was not opened: ' + reasonOf(e) };
  }
}

/**
 * RECOMPUTE THE LINES THIS MODULE OWNS, and leave every typed-in line alone.
 *
 * Only two lines are computed here, and both are facts rather than policy: the salary for days
 * actually worked in the final month, and one deduction per outstanding loan or advance. Leave
 * encashment is NOT among them — see the header; this product does not hold that rule.
 *
 * REFUSES ONCE THE SETTLEMENT HAS LEFT DRAFT. A figure somebody approved must not change underneath
 * them because a balance moved afterwards.
 */
export async function refreshComputedLines(
  settlementId: string,
  actorUserId: string | null,
): Promise<SettlementResult> {
  if (!isUuid(settlementId)) return { ok: false, error: 'That settlement could not be identified.' };
  try {
    await ensureSettlementSchema();
    const head = rows(await db.execute(sql`
      SELECT id, separation_id, state FROM hr_settlements WHERE id = ${settlementId}::uuid LIMIT 1`))[0] as any;
    if (!head) return { ok: false, error: 'That settlement could not be found.' };
    if (!EDITABLE_STATES.has(String(head.state) as SettlementState)) {
      return {
        ok: false,
        error: 'This settlement is ' + settlementStateLabel(String(head.state)).toLowerCase()
          + ', so its figures can no longer be recalculated. Nothing was changed.',
      };
    }

    const facts = await settlementFacts(String(head.separation_id));
    if (!facts) return { ok: false, error: 'The separation behind this settlement could not be read.' };

    // Replace only what this module owns. A manual line has code IS NULL and survives untouched.
    await db.execute(sql`
      DELETE FROM hr_settlement_lines
       WHERE settlement_id = ${settlementId}::uuid AND source = 'auto'`);

    if (facts.unpaidFinalSalary > 0) {
      await db.execute(sql`
        INSERT INTO hr_settlement_lines (settlement_id, code, label, kind, amount, source, note, sort_order)
        VALUES (${settlementId}::uuid, ${AUTO_FINAL_SALARY},
                ${'Salary for ' + facts.finalMonthDaysWorked + ' day'
                  + (facts.finalMonthDaysWorked === 1 ? '' : 's') + ' of ' + facts.finalMonthLabel},
                'earning', ${facts.unpaidFinalSalary}, 'auto',
                ${'Regular monthly gross of ' + facts.regularGross + ' divided by '
                  + facts.finalMonthDays + ' days, for ' + facts.finalMonthDaysWorked
                  + ' days up to the last working day.'}, 10)
        ON CONFLICT (settlement_id, code) DO NOTHING`);
    }

    for (const l of facts.loans) {
      await db.execute(sql`
        INSERT INTO hr_settlement_lines (settlement_id, code, label, kind, amount, source, note, sort_order)
        VALUES (${settlementId}::uuid, ${'loan:' + l.id},
                ${loanKindLabel(l.kind) + ' balance outstanding'},
                'deduction', ${l.outstanding}, 'auto',
                ${'Read from the loan ledger. Closing this settlement clears the balance and closes '
                  + 'the loan; it is not recomputed here.'}, 60)
        ON CONFLICT (settlement_id, code) DO NOTHING`);
    }

    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'settlement.recomputed', entity: 'hr_settlement', entityId: settlementId,
      diff: {
        unpaidFinalSalary: facts.unpaidFinalSalary,
        loanOutstandingTotal: facts.loanOutstandingTotal,
        gaps: facts.gaps,
      },
    });
    return { ok: true, id: settlementId, changed: true };
  } catch (e: any) {
    logFail('refreshComputedLines', e);
    return { ok: false, error: 'The figures were not recalculated: ' + reasonOf(e) };
  }
}

/** Add a line somebody typed — leave encashment, notice pay, gratuity, a recovery. Draft only. */
export async function addSettlementLine(opts: {
  settlementId: string;
  label: string;
  kind: string;
  amount: number;
  note?: string | null;
  actorUserId?: string | null;
}): Promise<SettlementResult> {
  if (!isUuid(opts?.settlementId)) return { ok: false, error: 'That settlement could not be identified.' };
  const label = String(opts?.label || '').trim().slice(0, 200);
  if (!label) return { ok: false, error: 'Name the line. It is printed on the statement exactly as you write it.' };
  const kind: SettlementLineKind = String(opts?.kind) === 'deduction' ? 'deduction' : 'earning';
  const amount = round2(Number(opts?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter the amount. A deduction is entered as a positive number in the deduction column.' };
  }
  if (amount > MAX_LINE_AMOUNT) return { ok: false, error: 'That amount is beyond what this statement handles. Check the figure.' };
  const note = opts?.note ? String(opts.note).trim().slice(0, 500) : null;
  const by = isUuid(opts?.actorUserId) ? String(opts.actorUserId) : null;

  try {
    await ensureSettlementSchema();
    const head = rows(await db.execute(sql`
      SELECT state FROM hr_settlements WHERE id = ${opts.settlementId}::uuid LIMIT 1`))[0] as any;
    if (!head) return { ok: false, error: 'That settlement could not be found.' };
    if (!EDITABLE_STATES.has(String(head.state) as SettlementState)) {
      return {
        ok: false,
        error: 'This settlement is ' + settlementStateLabel(String(head.state)).toLowerCase()
          + ', so nothing can be added to it. Nothing was changed.',
      };
    }
    await db.execute(sql`
      INSERT INTO hr_settlement_lines (settlement_id, code, label, kind, amount, source, note, sort_order)
      VALUES (${opts.settlementId}::uuid, NULL, ${label}, ${kind}, ${amount}, 'manual', ${note}, 40)`);
    await logAudit({
      userId: by, action: 'settlement.line.added', entity: 'hr_settlement',
      entityId: opts.settlementId, diff: { label, kind, amount },
    });
    return { ok: true, id: opts.settlementId, changed: true };
  } catch (e: any) {
    logFail('addSettlementLine', e);
    return { ok: false, error: 'The line was not added: ' + reasonOf(e) };
  }
}

/** Remove one line. Draft only, and computed lines come back on the next recalculation. */
export async function removeSettlementLine(
  lineId: string,
  actorUserId: string | null,
): Promise<SettlementResult> {
  if (!isUuid(lineId)) return { ok: false, error: 'That line could not be identified.' };
  try {
    await ensureSettlementSchema();
    const wrote = rows(await db.execute(sql`
      DELETE FROM hr_settlement_lines l
       USING hr_settlements s
       WHERE l.id = ${lineId}::uuid AND s.id = l.settlement_id AND s.state = 'draft'
      RETURNING l.settlement_id, l.label`));
    if (!wrote.length) {
      return { ok: false, error: 'That line was not removed. A settlement that has been sent for approval can no longer be edited.' };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'settlement.line.removed', entity: 'hr_settlement',
      entityId: String(wrote[0].settlement_id), diff: { label: String(wrote[0].label) },
    });
    return { ok: true, id: String(wrote[0].settlement_id), changed: true };
  } catch (e: any) {
    logFail('removeSettlementLine', e);
    return { ok: false, error: 'The line was not removed: ' + reasonOf(e) };
  }
}

/**
 * SEND THE FIGURE FOR APPROVAL. Routed by the one engine, decided by nobody here.
 *
 * The record id is NAMESPACED as 'settlement:<separation id>' so this instance and the separation's
 * own approval are two decisions over two records and cannot collide on (domain, record_id).
 */
export async function requestSettlementApproval(
  settlementId: string,
  actorUserId: string | null,
): Promise<SettlementResult> {
  if (!isUuid(settlementId)) return { ok: false, error: 'That settlement could not be identified.' };
  const by = isUuid(actorUserId) ? String(actorUserId) : null;
  try {
    await ensureSettlementSchema();
    const s = await getSettlement(settlementId);
    if (!s) return { ok: false, error: 'That settlement could not be found.' };
    if (s.state !== 'draft') {
      return {
        ok: false,
        error: 'This settlement is ' + settlementStateLabel(s.state).toLowerCase()
          + ', so it cannot be sent for approval again.',
      };
    }
    if (!s.lines.length) {
      return { ok: false, error: 'There is nothing on this statement yet. Add at least one line before sending it for approval.' };
    }

    const wf = await startWorkflow({
      domain: 'separation',
      recordId: 'settlement:' + s.separationId,
      subjectEmployeeId: s.employeeId,
      requestedByUserId: by,
      createdByUserId: by,
      amount: s.netPayable,
      currency: s.currency,
      summary: 'Full and final settlement for ' + (s.employeeName || 'an employee')
        + ' — ' + s.currency + ' ' + s.netPayable.toLocaleString('en-IN'),
    });

    if (!wf.ok) {
      await db.execute(sql`
        UPDATE hr_settlements SET state = 'halted',
               halt_reason = ${String(wf.error || 'The approval could not be started.')}, updated_at = NOW()
         WHERE id = ${settlementId}::uuid`);
      return { ok: false, id: settlementId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_settlements
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${settlementId}::uuid`);

    await logAudit({
      userId: by, action: 'settlement.approval_requested', entity: 'hr_settlement',
      entityId: settlementId,
      diff: {
        separationId: s.separationId, netPayable: s.netPayable, currency: s.currency,
        workflowInstanceId: wf.instanceId || null, state: halted ? 'halted' : 'pending',
        haltReason: wf.haltReason || null,
      },
    });
    return { ok: true, id: settlementId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logFail('requestSettlementApproval', e);
    return { ok: false, error: 'The approval was not started: ' + reasonOf(e) };
  }
}

/** Read the engine's decisions back onto open settlements. Decides nothing. */
export async function syncSettlementApprovals(): Promise<{ settled: number; errors: string[] }> {
  const out = { settled: 0, errors: [] as string[] };
  try {
    await ensureSettlementSchema();
    const open = rows(await db.execute(sql`
      SELECT id, workflow_instance_id, state FROM hr_settlements
       WHERE state IN ('pending', 'halted') AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 100`));

    for (const raw of open) {
      const id = String((raw as any).id);
      const instanceId = String((raw as any).workflow_instance_id || '');
      if (!instanceId) continue;
      let instance = null as Awaited<ReturnType<typeof getInstance>>;
      try {
        instance = await getInstance(instanceId);
      } catch (e: any) {
        logFail('syncSettlementApprovals.getInstance', e);
        out.errors.push('An approval could not be read: ' + reasonOf(e));
        continue;
      }
      if (!instance) continue;

      let next: SettlementState | null = null;
      if (instance.state === 'approved') next = 'approved';
      else if (instance.state === 'rejected') next = 'rejected';
      else if (instance.state === 'cancelled') next = 'cancelled';
      else if (instance.state === 'halted') next = 'halted';
      else if (instance.state === 'pending') next = 'pending';
      if (!next || next === String((raw as any).state)) continue;

      try {
        await db.execute(sql`
          UPDATE hr_settlements SET state = ${next}, halt_reason = ${instance.haltReason}::text,
                 updated_at = NOW()
           WHERE id = ${id}::uuid`);
        out.settled += 1;
      } catch (e: any) {
        logFail('syncSettlementApprovals.write', e);
        out.errors.push('A decision could not be written down: ' + reasonOf(e));
      }
    }
  } catch (e: any) {
    logFail('syncSettlementApprovals', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}

/**
 * HAND THE APPROVED SETTLEMENT OFF FOR PAYMENT, and close the loans it recovered.
 *
 * NOTHING HERE PAYS ANYBODY. It records that an approved figure was handed to whoever actually moves
 * the money, with a reference somebody can follow — the same shape recordSettlementHandoff() already
 * has on the separation console, and it CALLS that function rather than writing hr_separations
 * itself, so there is one writer of the handoff columns and not two.
 *
 * IT REFUSES ON THREE CONDITIONS, and says all three at once rather than one per attempt:
 *   - the settlement is not approved. An unapproved figure is not a figure anybody agreed to.
 *   - asset clearance has not been signed off. Handing over the final money while the laptop is
 *     still out removes the only leverage anybody has to get it back, and it is a decision somebody
 *     should have to make deliberately on the clearance screen rather than by accident here.
 *   - the net is negative. That is a real answer — the person owes more than they are due — but it
 *     is not something to hand off as a payment, and it needs a human, not a button.
 */
export async function finaliseSettlement(opts: {
  settlementId: string;
  reference: string;
  actorUserId?: string | null;
}): Promise<SettlementResult & { blockers?: string[] }> {
  if (!isUuid(opts?.settlementId)) return { ok: false, error: 'That settlement could not be identified.' };
  const reference = String(opts?.reference || '').trim().slice(0, 300);
  if (!reference) {
    return { ok: false, error: 'Record where this settlement was handed off — a reference somebody can follow.' };
  }
  const by = isUuid(opts?.actorUserId) ? String(opts.actorUserId) : null;

  try {
    await ensureSettlementSchema();
    const s = await getSettlement(opts.settlementId);
    if (!s) return { ok: false, error: 'That settlement could not be found.' };

    const blockers: string[] = [];
    if (s.state !== 'approved') {
      blockers.push(
        'The settlement is ' + settlementStateLabel(s.state).toLowerCase()
        + '. Only an approved figure can be handed off.',
      );
    }
    const facts = await settlementFacts(s.separationId);
    if (!facts) {
      blockers.push('The separation behind this settlement could not be read, so nothing was done.');
    } else if (!facts.assetsCleared) {
      blockers.push(
        'Asset clearance is ' + (facts.assetsClearanceStatus === 'blocked' ? 'blocked' : 'still pending')
        + '. Sign it off on the separation console first, or record there why it is being waived.',
      );
    }
    if (s.netPayable < 0) {
      blockers.push(
        'The net settlement is negative — this person owes more than they are due. '
        + 'That is a recovery, not a payment, and it is not handed off from here.',
      );
    }

    // ---- THE FINAL MONTH, RE-TESTED AT THE MOMENT OF THE HANDOFF ------------------------------------
    //
    // THIS IS THE ONE THAT PAYS A FULL MONTH'S SALARY TWICE.
    //
    // settlementFacts() asks whether payroll has already produced a payslip for the month of the last
    // working day, and refreshComputedLines() writes the prorated final-month salary as an auto line
    // ONLY when it has not. But that question is answered when the settlement is PREPARED, and
    // refreshComputedLines() deliberately refuses to recompute once the settlement has left draft
    // (an approved figure must not change under the people who approved it). So the answer on the
    // statement is as old as the draft.
    //
    // The gap between those two moments is where the money goes:
    //
    //   3 March   last working day 12 March; settlement opened, final salary auto line 19,354.80
    //   5 March   approved
    //  31 March   the March payroll run includes the employee — generateRun() selects
    //             `WHERE is_active = true`, and the record is not closed until the exit completes —
    //             and pays the full 50,000
    //   2 April   Hand off is pressed. The statement still carries its 19,354.80.
    //
    // Total paid for one month: 69,354.80. Nothing on any screen says the two overlap, because each
    // one is individually correct about the moment it was written.
    //
    // `facts` above is a FRESH read, so finalMonthAlreadyPaid is the answer as of now. It was already
    // being fetched and only assetsCleared was being read off it. Refusing here rather than silently
    // adjusting the line is deliberate: an approved figure is not quietly rewritten at handoff time
    // either. Somebody reopens the settlement, recomputes it against a month that is now paid, and
    // has it approved again — which is a decision, made by a person, with both facts in front of them.
    const finalSalaryLine = s.lines.find(
      (l) => l.code === AUTO_FINAL_SALARY && l.kind === 'earning' && l.amount > 0,
    );
    if (finalSalaryLine && facts && facts.finalMonthAlreadyPaid) {
      blockers.push(
        'This statement pays ' + s.currency + ' ' + finalSalaryLine.amount.toLocaleString('en-IN')
        + ' for ' + facts.finalMonthLabel + ', but payroll has since run for that month and already '
        + 'paid it. Handing this off would pay the final month twice. Reopen the settlement so the '
        + 'line is recomputed against a month that is now paid, and have the new figure approved.',
      );
    }

    if (blockers.length) return { ok: false, error: blockers[0], blockers };

    // CLAIM THE SETTLEMENT BEFORE ANYTHING IRREVERSIBLE HAPPENS.
    //
    // The state check above is a READ, and the write that marked the settlement 'settled' used to sit
    // at the very END of this function with no precondition on it. Two presses of Hand off landing
    // together therefore both passed the read, both closed the loans (a second ledger row for a
    // balance already recovered) and both recorded a handoff on the separation. This single
    // conditional UPDATE lets exactly one of them through; the loser is told and does nothing.
    //
    // The reference and timestamp are written here rather than afterwards so the row never sits in a
    // state that says settled without saying by what.
    const claimed = rows(await db.execute(sql`
      UPDATE hr_settlements
         SET state = 'settled', settled_reference = ${reference}, settled_at = NOW(),
             settled_by_user_id = ${by}::uuid, updated_at = NOW()
       WHERE id = ${opts.settlementId}::uuid AND state = 'approved'
      RETURNING id`));
    if (!claimed.length) {
      return {
        ok: false,
        error: 'This settlement was handed off by somebody else while this page was open. Reload it — '
          + 'nothing was done twice.',
      };
    }

    // CLOSE THE LOANS THIS STATEMENT RECOVERED, through the module that owns them. Each failure is
    // collected and reported; none of them is swallowed, because a loan left open after its balance
    // was deducted from a settlement will keep showing as owed by somebody who has left.
    const loanErrors: string[] = [];
    for (const line of s.lines) {
      if (!line.code || !line.code.startsWith('loan:')) continue;
      const loanId = line.code.slice(5);
      const r = await settleLoanOutsidePayroll({
        loanId, reference: 'Full and final settlement ' + reference, actorUserId: by,
      });
      if (!r.ok) loanErrors.push(r.error || 'A loan balance could not be closed.');
    }

    // THE HANDOFF, through hr-separation.ts. One writer of those columns, not two.
    const handoff = await recordSettlementHandoff({
      separationId: s.separationId,
      amount: s.netPayable,
      reference,
      actorUserId: by,
    });
    if (!handoff.ok) {
      // The claim above already moved this settlement to 'settled', and the loans it recovered may
      // already be closed, so putting it back to 'approved' would invite a second run over ledger
      // rows that now exist. It stays settled and the failure is stated in full: what is missing is
      // the handoff record on the separation, which is repaired on that console.
      logFail('finaliseSettlement.handoff', new Error(handoff.error || 'unknown reason'));
      return {
        ok: false,
        error: 'The settlement is marked handed off here, but the record on the separation console was '
          + 'NOT written: ' + (handoff.error || 'unknown reason')
          + ' Record it there by hand.'
          + (loanErrors.length ? ' Some loan balances could not be closed either — check the loan register.' : ''),
      };
    }

    await logAudit({
      userId: by, action: 'settlement.handed_off', entity: 'hr_settlement',
      entityId: opts.settlementId,
      diff: {
        separationId: s.separationId, netPayable: s.netPayable, currency: s.currency,
        reference, loanErrors,
      },
    });

    return {
      ok: true,
      id: opts.settlementId,
      changed: true,
      error: loanErrors.length ? loanErrors[0] : undefined,
    };
  } catch (e: any) {
    logFail('finaliseSettlement', e);
    return { ok: false, error: 'The settlement was not handed off: ' + reasonOf(e) };
  }
}
