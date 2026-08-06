// src/lib/loans.ts — EMPLOYEE LOANS AND SALARY ADVANCES, and the per-run recovery that stops itself.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT IS NOT
// =================================================================================================
//
// A LOAN and a SALARY ADVANCE are the same act with different words: the company hands somebody
// money now and takes it back out of later pay runs. So they live in ONE table with a `kind`
// discriminator and share ONE recovery engine. Two tables would mean two engines, and the second one
// written would be the one that forgets to stop deducting when the balance clears — which is a
// person being quietly overcharged out of their salary every month with nothing on any screen
// saying so.
//
// THIS IS NOT src/lib/expenses.ts's `advance`, AND THE TWO MUST NOT BE CONFLATED. That one is money
// you need BEFORE you spend it on the company's behalf, it is settled by submitting receipts, and it
// is recovered by reconciling a claim. This one is money you need for yourself, it is settled by
// deducting it from your pay, and it never involves a receipt. They are approved down different
// chains and they clear in different ways. Recording one as the other means either an employee is
// asked for receipts they cannot produce, or a salary advance is written off as a business expense.
//
// NOTHING HERE PAYS ANYBODY AND NOTHING HERE APPROVES ANYTHING.
//   - Approval is src/lib/workflow.ts, domain 'loan'. When routing cannot name an approver the
//     request HALTS with the engine's sentence. There is no fallback to a role name, no
//     auto-approval, and no arm anywhere in this file that writes 'approved'.
//   - Disbursement is a RECORDED HANDOFF, pressed by a person, exactly as the final-settlement
//     handoff on the separation console is. An approved loan sits at disbursed_at IS NULL until
//     somebody says the money actually went out — and RECOVERY WILL NOT START UNTIL IT DID. Nothing
//     is more corrosive than a deduction for money that never arrived.
//
// =================================================================================================
// THE ARITHMETIC, STATED IN FULL BECAUSE IT IS PRINTED ON A PAYSLIP
// =================================================================================================
//
//   interest_total   = principal * (rate / 100) * (instalments / 12), rounded to 2dp, where `rate` is
//                      a FLAT ANNUAL PERCENTAGE AN ADMINISTRATOR TYPED IN. It is not compounded, it
//                      is not reducing-balance, and this module makes NO claim that it matches any
//                      lending rule anywhere. A rate of 0 gives an interest-free loan, which is what
//                      a salary advance normally is.
//   total_payable    = principal + interest_total. FROZEN ON THE ROW AT REQUEST TIME, so editing the
//                      rate later cannot silently rewrite what somebody already agreed to repay.
//   instalment       = round2(total_payable / instalments), and the LAST recovery is whatever is
//                      actually left. Rounding therefore lands on the final instalment and the sum
//                      of the recoveries is exactly total_payable — never a stray 0.04 that keeps a
//                      loan open forever.
//   outstanding      = total_payable - sum(recovered). At zero the loan CLOSES and stops deducting.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. rows() below; `r.rows[0]` is always a bug here.
//   - the real Postgres reason is on e.cause. logFail() logs `e?.cause?.message || e?.message`.
//   - every `const` is declared ABOVE the function that reads it. `const` is not hoisted.
//   - DDL lives in ONE ensureOnce guard that logs the cause and RE-THROWS, so a failed run retries.
//   - no exception is swallowed in a write path: every writer returns { ok, error } and logs.
//   - NO BACKTICK inside a sql template literal, not even in a comment.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { startWorkflow, getInstance } from '@/lib/workflow';
// The civil date in the company's zone. new Date() on this deployment is UTC, which is five and a
// half hours behind IST — see src/lib/page-safety.ts for why every derived "today" has to say so.
import { civilToday } from '@/lib/page-safety';
import { round2 } from '@/lib/money';
import { sendPushToUser } from '@/lib/push';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. All of them above the functions that read them.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');

const logFail = (tag: string, e: any) => console.error('[loans] ' + tag, reasonOf(e));

/** Where a loan notification sends the borrower. The page exists (src/pages/portal/employee/loans.astro). */
const LOANS_PORTAL_URL = '/portal/employee/loans';

/**
 * TELL THE BORROWER.
 *
 * NOTHING IN THIS MODULE DID. A loan being approved, disbursed or cleared sent nobody anything, in
 * any path — the borrower's own screen simply changed if they happened to open it, and until this
 * repair it did not even change then, because the approval mirror only ran on an admin page load. So
 * the company decided about somebody's money and the somebody found out by checking.
 *
 * Declared above every reader; `const` is not hoisted. Never blocks the write it announces — a loan
 * that was approved and not announced is a page somebody has to open; an approval refused because a
 * push endpoint was stale is money that does not move.
 */
async function notifyBorrower(
  employeeId: string,
  payload: { type: string; title: string; body: string; tag: string },
): Promise<void> {
  try {
    if (!isUuid(employeeId)) return;
    const r = rows(await db.execute(sql`
      SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    const userId = r.length ? String(r[0].user_id || '') : '';
    if (!userId) return;
    await sendPushToUser(userId, { ...payload, url: LOANS_PORTAL_URL });
  } catch (e: any) {
    logFail('notifyBorrower', e);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ONE ROUNDING RULE, SHARED. The copy that lived here was
// `Math.round((Number(n) || 0) * 100) / 100`, which rounds a half paisa DOWN whenever the product
// lands just under .5 in IEEE754 (1.005 * 100 === 100.49999999999999) — and the bias always ran
// against the borrower, on every EMI split and every interest apportionment. See src/lib/money.ts.

/** The two words for one act. See the header for why they share a table. */
export const LOAN_KINDS = [
  {
    key: 'loan',
    label: 'Loan',
    note: 'Money lent to an employee and recovered over several pay runs. Interest optional.',
  },
  {
    key: 'advance',
    label: 'Salary advance',
    note: 'Pay released early and recovered from the next run or two. Normally interest-free.',
  },
] as const;

export type LoanKind = (typeof LOAN_KINDS)[number]['key'];

const LOAN_KIND_KEYS = new Set<string>(LOAN_KINDS.map((k) => k.key));

export function loanKindLabel(key: string): string {
  for (const k of LOAN_KINDS) if (k.key === key) return k.label;
  return 'Loan';
}

/**
 * WHERE A REQUEST CAN BE.
 *
 *   pending    routed, waiting on a named approver.
 *   halted     routing could not name an approver. NOT approved and NOT waiting on anybody.
 *   rejected   an approver refused it. Terminal.
 *   cancelled  withdrawn before it settled. Terminal.
 *   active     approved. Recovers on each run FROM THE MOMENT disbursed_at IS SET, not before.
 *   closed     the balance reached zero. Terminal, and it stops the deduction by itself.
 */
export type LoanState = 'pending' | 'halted' | 'rejected' | 'cancelled' | 'active' | 'closed';

export const LOAN_STATE_LABELS: Record<LoanState, string> = {
  pending: 'Waiting for approval',
  halted: 'Halted',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
  active: 'Approved',
  closed: 'Cleared',
};

export function loanStateLabel(s: string): string {
  const k = String(s || '') as LoanState;
  return LOAN_STATE_LABELS[k] || k;
}

/** Ceilings that stop a typo becoming a hundred-year deduction. Not policy — arithmetic guards. */
const MAX_INSTALMENTS = 120;
const MAX_PRINCIPAL = 100000000;
const MAX_RATE_PCT = 100;

/** What a person is shown when a write fails. The database's own words go to the log, not to them. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------
//
// TWO TABLES, and each answers a question no existing table can. Before adding anything here, grep
// for the table name: two CREATE TABLE statements for one table with different shapes silently
// breaks every write for whichever module lost the race.
//
//   hr_salary_loans        the agreement: who, how much, over how many runs, at what rate, approved
//                          by which workflow instance, and when the money actually went out.
//   hr_loan_instalments    THE LEDGER — one row per loan per payroll run. The outstanding balance is
//                          DERIVED from it and is never a mutable column, because a running total in
//                          a column is a number that can drift from the payslips that produced it,
//                          and the payslips are the evidence. UNIQUE on (loan_id, payroll_run_id) so
//                          a re-run of one month cannot recover the same instalment twice.

export function ensureLoanSchema(): Promise<void> {
  return ensureOnce('hr_salary_loans_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_salary_loans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL DEFAULT 'loan',
        purpose TEXT NOT NULL,
        principal NUMERIC(14,2) NOT NULL,
        interest_rate_pct NUMERIC(6,3) NOT NULL DEFAULT 0,
        interest_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_payable NUMERIC(14,2) NOT NULL,
        instalments INT NOT NULL,
        instalment_amount NUMERIC(14,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        start_month INT NOT NULL,
        start_year INT NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        disbursed_at TIMESTAMPTZ,
        disbursed_reference TEXT,
        disbursed_by_user_id UUID,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_salary_loans_emp_idx
        ON hr_salary_loans(employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_salary_loans_state_idx
        ON hr_salary_loans(state, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_loan_instalments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        loan_id UUID NOT NULL REFERENCES hr_salary_loans(id) ON DELETE CASCADE,
        payroll_run_id UUID,
        payslip_id UUID,
        month INT NOT NULL,
        year INT NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        principal_part NUMERIC(14,2) NOT NULL DEFAULT 0,
        interest_part NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // ONE RECOVERY PER LOAN PER RUN, enforced by the database and not only by this file. A retried
      // payroll run therefore cannot deduct the same instalment a second time.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_loan_instalments_run_uniq
        ON hr_loan_instalments(loan_id, payroll_run_id)`);
      // AND ONE SETTLEMENT PER LOAN OUTSIDE PAYROLL. The index above does NOT cover
      // settleLoanOutsidePayroll(), because that path writes payroll_run_id = NULL and Postgres treats
      // NULLs as DISTINCT in a unique index — so N calls wrote N rows, each for the whole outstanding
      // balance, and mapLoan()'s Math.max(0, ...) clamp then reported the over-recovery as a clean
      // zero. A partial unique index over the NULL rows is the constraint that was missing.
      //
      // ADDITIVE AND NON-FATAL. If a live database already carries two out-of-payroll rows for one
      // loan, this index cannot be built — and that must not take the loan module down. The failure is
      // logged with the query a human should run first. settleLoanOutsidePayroll's own atomic state
      // claim covers the ordinary case with or without this index.
      try {
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_loan_instalments_offpayroll_uniq
          ON hr_loan_instalments(loan_id) WHERE payroll_run_id IS NULL`);
      } catch (e: any) {
        console.error(
          '[loans] could not create hr_loan_instalments_offpayroll_uniq. A loan may already have been '
          + 'settled outside payroll more than once, which means it was over-recovered. Check with: '
          + 'SELECT loan_id, count(*), sum(amount) FROM hr_loan_instalments WHERE payroll_run_id IS NULL '
          + 'GROUP BY loan_id HAVING count(*) > 1; -- reason: ' + reasonOf(e),
        );
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_loan_instalments_loan_idx
        ON hr_loan_instalments(loan_id, year DESC, month DESC)`);
    } catch (e: any) {
      logFail('ensureLoanSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries instead of staying broken.
    }
  });
}

/** Provision, but never throw into a reader — a read that cannot run returns an empty list. */
async function safeEnsure(): Promise<boolean> {
  try {
    await ensureLoanSchema();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface LoanRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  kind: string;
  purpose: string;
  principal: number;
  interestRatePct: number;
  interestTotal: number;
  totalPayable: number;
  instalments: number;
  instalmentAmount: number;
  currency: string;
  startMonth: number;
  startYear: number;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  disbursedAt: string | null;
  disbursedReference: string | null;
  closedAt: string | null;
  createdAt: string | null;
  /** Derived from the ledger, never a stored running total. */
  recovered: number;
  outstanding: number;
  instalmentsPaid: number;
}

function mapLoan(r: any): LoanRow {
  const totalPayable = Number(r?.total_payable) || 0;
  const recovered = round2(Number(r?.recovered) || 0);
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    employeeCode: r?.employee_code ? String(r.employee_code) : null,
    kind: String(r?.kind ?? 'loan'),
    purpose: String(r?.purpose ?? ''),
    principal: Number(r?.principal) || 0,
    interestRatePct: Number(r?.interest_rate_pct) || 0,
    interestTotal: Number(r?.interest_total) || 0,
    totalPayable,
    instalments: Number(r?.instalments) || 0,
    instalmentAmount: Number(r?.instalment_amount) || 0,
    currency: String(r?.currency || 'INR'),
    startMonth: Number(r?.start_month) || 1,
    startYear: Number(r?.start_year) || 0,
    state: String(r?.state ?? 'pending'),
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    disbursedAt: r?.disbursed_at ? new Date(r.disbursed_at).toISOString() : null,
    disbursedReference: r?.disbursed_reference ? String(r.disbursed_reference) : null,
    closedAt: r?.closed_at ? new Date(r.closed_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    recovered,
    outstanding: round2(Math.max(0, totalPayable - recovered)),
    instalmentsPaid: Number(r?.instalments_paid) || 0,
  };
}

/** The SELECT every read below shares, so the derived balance is computed one way and only one way. */
const LOAN_SELECT = sql`
  SELECT l.*,
         e.full_name AS employee_name,
         e.employee_code AS employee_code,
         COALESCE(led.recovered, 0) AS recovered,
         COALESCE(led.paid_count, 0) AS instalments_paid
    FROM hr_salary_loans l
    LEFT JOIN hr_employees e ON e.id = l.employee_id
    LEFT JOIN (
      SELECT loan_id, SUM(amount) AS recovered, COUNT(*) AS paid_count
        FROM hr_loan_instalments GROUP BY loan_id
    ) led ON led.loan_id = l.id`;

/** The register. `state` narrows it; omit for everything. Fails closed to an empty list. */
export async function listLoans(
  opts: { state?: string; employeeId?: string; limit?: number } = {},
): Promise<LoanRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 150, 1), 400);
  if (!(await safeEnsure())) return [];
  try {
    const stateFilter = opts.state ? sql`AND l.state = ${String(opts.state)}` : sql``;
    const empFilter = isUuid(opts.employeeId)
      ? sql`AND l.employee_id = ${String(opts.employeeId)}::uuid`
      : sql``;
    const r = await db.execute(sql`
      ${LOAN_SELECT}
       WHERE TRUE ${stateFilter} ${empFilter}
       ORDER BY (l.state IN ('pending', 'halted')) DESC, l.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapLoan);
  } catch (e: any) {
    logFail('listLoans', e);
    return [];
  }
}

/** One person's own loans and advances. Narrowed by employee_id in the WHERE clause. */
export async function loansForEmployee(employeeId: string): Promise<LoanRow[]> {
  if (!isUuid(employeeId)) return [];
  return listLoans({ employeeId, limit: 100 });
}

export async function getLoan(id: string): Promise<LoanRow | null> {
  if (!isUuid(id)) return null;
  if (!(await safeEnsure())) return null;
  try {
    const r = await db.execute(sql`${LOAN_SELECT} WHERE l.id = ${id}::uuid LIMIT 1`);
    const list = rows(r);
    return list.length ? mapLoan(list[0]) : null;
  } catch (e: any) {
    logFail('getLoan', e);
    return null;
  }
}

export interface InstalmentRow {
  id: string;
  loanId: string;
  month: number;
  year: number;
  amount: number;
  principalPart: number;
  interestPart: number;
  payslipId: string | null;
  createdAt: string | null;
}

/** Every recovery taken against one loan, newest first. The evidence behind the balance. */
export async function loanLedger(loanId: string): Promise<InstalmentRow[]> {
  if (!isUuid(loanId)) return [];
  if (!(await safeEnsure())) return [];
  try {
    const r = await db.execute(sql`
      SELECT * FROM hr_loan_instalments
       WHERE loan_id = ${loanId}::uuid
       ORDER BY year DESC, month DESC, created_at DESC
       LIMIT 200`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      loanId: String(x.loan_id),
      month: Number(x.month) || 1,
      year: Number(x.year) || 0,
      amount: Number(x.amount) || 0,
      principalPart: Number(x.principal_part) || 0,
      interestPart: Number(x.interest_part) || 0,
      payslipId: x.payslip_id ? String(x.payslip_id) : null,
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail('loanLedger', e);
    return [];
  }
}

/**
 * WHAT THIS PERSON STILL OWES, across every live loan and advance.
 *
 * Read by src/lib/settlement.ts so the final settlement takes the balance from HERE rather than
 * recomputing it from the same rows in a second place. Two arithmetics over one ledger is how a
 * leaver gets a settlement that disagrees with their own loan screen by a few hundred rupees, and
 * neither number can be shown to be the wrong one.
 */
export async function outstandingForEmployee(employeeId: string): Promise<LoanRow[]> {
  if (!isUuid(employeeId)) return [];
  const all = await listLoans({ employeeId, limit: 100 });
  return all.filter((l) => l.state === 'active' && l.outstanding > 0);
}

// -------------------------------------------------------------------------------------------------
// WRITES — the request. Nothing below approves anything.
// -------------------------------------------------------------------------------------------------

export interface LoanResult {
  ok: boolean;
  id?: string;
  error?: string;
  haltReason?: string | null;
  changed?: boolean;
}

export interface LoanRequestInput {
  employeeId: string;
  kind: string;
  purpose: string;
  principal: number;
  instalments: number;
  interestRatePct?: number | null;
  startMonth: number;
  startYear: number;
  currency?: string | null;
  requestedByUserId?: string | null;
}

/**
 * Ask for a loan or a salary advance. WRITES A REQUEST. MOVES NO MONEY AND DEDUCTS NOTHING.
 *
 * Every refusal below is a SENTENCE naming what to change. A pay screen that answers "invalid input"
 * makes somebody guess which of seven fields it meant, and they guess wrong about the money one.
 */
export async function requestLoan(input: LoanRequestInput): Promise<LoanResult> {
  const employeeId = String(input?.employeeId || '').trim();
  if (!isUuid(employeeId)) return { ok: false, error: 'Choose the person this is for.' };

  const kind = LOAN_KIND_KEYS.has(String(input?.kind)) ? String(input.kind) : '';
  if (!kind) return { ok: false, error: 'Say whether this is a loan or a salary advance — they are recovered the same way but they are not the same thing on the record.' };

  const purpose = String(input?.purpose || '').trim();
  if (purpose.length < 5) {
    return { ok: false, error: 'Write what this is for. An approver reads it before deciding.' };
  }

  const principal = round2(Number(input?.principal));
  if (!Number.isFinite(principal) || principal <= 0) {
    return { ok: false, error: 'Enter the amount being lent. It has to be more than zero.' };
  }
  if (principal > MAX_PRINCIPAL) {
    return { ok: false, error: 'That amount is beyond what this register handles. Check the figure.' };
  }

  const instalments = Math.round(Number(input?.instalments) || 0);
  if (instalments < 1 || instalments > MAX_INSTALMENTS) {
    return {
      ok: false,
      error: 'Enter how many pay runs this is recovered over, between 1 and ' + MAX_INSTALMENTS + '.',
    };
  }

  const rate = round2(Number(input?.interestRatePct) || 0);
  if (rate < 0 || rate > MAX_RATE_PCT) {
    return { ok: false, error: 'The interest rate has to be between 0 and ' + MAX_RATE_PCT + '. Enter 0 for an interest-free advance.' };
  }

  const startMonth = Math.round(Number(input?.startMonth) || 0);
  const startYear = Math.round(Number(input?.startYear) || 0);
  if (startMonth < 1 || startMonth > 12) return { ok: false, error: 'Pick the month recovery starts in.' };
  if (startYear < 2000 || startYear > 2100) return { ok: false, error: 'That is not a year this payroll covers.' };

  const currency = String(input?.currency || 'INR').slice(0, 8) || 'INR';
  const requestedBy = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  // THE ARITHMETIC, FROZEN ONTO THE ROW. See the header: flat, simple, uncompounded, and stated in
  // words on every screen that shows it. This module claims nothing about lending rules anywhere.
  const interestTotal = round2(principal * (rate / 100) * (instalments / 12));
  const totalPayable = round2(principal + interestTotal);
  const instalmentAmount = round2(totalPayable / instalments);

  try {
    await ensureLoanSchema();

    const empRows = rows(await db.execute(sql`
      SELECT id, full_name, is_active, currency FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!empRows.length) return { ok: false, error: 'That employee record could not be found.' };
    const emp = empRows[0] as any;
    if (emp.is_active === false) {
      return { ok: false, error: 'That employee record is closed. Somebody who has left cannot take a new loan; anything outstanding is settled on their exit instead.' };
    }

    // ONE LIVE AGREEMENT OF EACH KIND AT A TIME. Two overlapping advances mean two deductions in one
    // month against a net that may not carry them, and the person finds out on payday.
    const openAlready = rows(await db.execute(sql`
      SELECT id FROM hr_salary_loans
       WHERE employee_id = ${employeeId}::uuid AND kind = ${kind}
         AND state IN ('pending', 'halted', 'active') LIMIT 1`));
    if (openAlready.length) {
      return {
        ok: false,
        error: 'This person already has a ' + loanKindLabel(kind).toLowerCase()
          + ' in progress. Settle or withdraw that one before raising another.',
      };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_salary_loans
        (employee_id, kind, purpose, principal, interest_rate_pct, interest_total, total_payable,
         instalments, instalment_amount, currency, start_month, start_year, state, requested_by_user_id)
      VALUES
        (${employeeId}::uuid, ${kind}, ${purpose}, ${principal}, ${rate}, ${interestTotal},
         ${totalPayable}, ${instalments}, ${instalmentAmount}, ${currency}, ${startMonth},
         ${startYear}, 'pending', ${requestedBy}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const loanId = String(ins[0].id);

    const wf = await startWorkflow({
      domain: 'loan',
      recordId: loanId,
      subjectEmployeeId: employeeId,
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      amount: totalPayable,
      currency,
      summary: loanKindLabel(kind) + ' of ' + currency + ' ' + principal.toLocaleString('en-IN')
        + ' for ' + (emp.full_name || 'an employee') + ', recovered over ' + instalments
        + ' run' + (instalments === 1 ? '' : 's'),
    });

    if (!wf.ok) {
      await db.execute(sql`
        UPDATE hr_salary_loans SET state = 'halted',
               halt_reason = ${String(wf.error || 'The approval could not be started.')}, updated_at = NOW()
         WHERE id = ${loanId}::uuid`);
      return { ok: false, id: loanId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_salary_loans
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${loanId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: 'loan.requested',
      entity: 'hr_salary_loan',
      entityId: loanId,
      diff: {
        employeeId, kind, principal, interestRatePct: rate, interestTotal, totalPayable,
        instalments, startMonth, startYear, workflowInstanceId: wf.instanceId || null,
        state: halted ? 'halted' : 'pending', haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: loanId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logFail('requestLoan', e);
    return { ok: false, error: 'The request was not saved: ' + reasonOf(e) };
  }
}

/** Withdraw a request that has not been decided. An active loan cannot be withdrawn — it is repaid. */
export async function cancelLoan(id: string, actorUserId: string | null): Promise<LoanResult> {
  if (!isUuid(id)) return { ok: false, error: 'That request could not be identified.' };
  try {
    await ensureLoanSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE hr_salary_loans SET state = 'cancelled', updated_at = NOW()
       WHERE id = ${id}::uuid AND state IN ('pending', 'halted') RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That request has already been settled, so it cannot be withdrawn. An approved loan is cleared by repaying it.' };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'loan.cancelled', entity: 'hr_salary_loan', entityId: id, diff: {},
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('cancelLoan', e);
    return { ok: false, error: 'The request was not withdrawn: ' + reasonOf(e) };
  }
}

/**
 * RECORD THAT THE MONEY ACTUALLY WENT OUT. A handoff, not a payment.
 *
 * This product does not move money here and does not pretend to. Somebody pays the loan out through
 * whatever the organisation actually uses, then records the reference. RECOVERY STARTS FROM THIS
 * MOMENT AND NOT BEFORE — an approved-but-undisbursed loan deducts nothing, because a deduction for
 * money that never arrived is theft with a spreadsheet behind it.
 */
export async function recordDisbursement(opts: {
  loanId: string;
  reference: string;
  actorUserId?: string | null;
}): Promise<LoanResult> {
  if (!isUuid(opts?.loanId)) return { ok: false, error: 'That loan could not be identified.' };
  const reference = String(opts?.reference || '').trim().slice(0, 300);
  if (!reference) {
    return { ok: false, error: 'Record where the money was paid out — a reference somebody can follow.' };
  }
  const by = isUuid(opts?.actorUserId) ? String(opts.actorUserId) : null;
  try {
    await ensureLoanSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE hr_salary_loans
         SET disbursed_at = NOW(), disbursed_reference = ${reference},
             disbursed_by_user_id = ${by}::uuid, updated_at = NOW()
       WHERE id = ${opts.loanId}::uuid AND state = 'active' AND disbursed_at IS NULL
      RETURNING id`));
    if (!wrote.length) {
      return {
        ok: false,
        error: 'Nothing was recorded. A disbursement can only be recorded once, and only on a loan that has been approved.',
      };
    }
    await logAudit({
      userId: by, action: 'loan.disbursed', entity: 'hr_salary_loan',
      entityId: opts.loanId, diff: { reference },
    });
    return { ok: true, id: opts.loanId, changed: true };
  } catch (e: any) {
    logFail('recordDisbursement', e);
    return { ok: false, error: 'The disbursement was not recorded: ' + reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// MIRRORING THE ENGINE'S DECISIONS
// -------------------------------------------------------------------------------------------------

/**
 * Read the workflow engine's decisions back onto open loan requests.
 *
 * A reconcile rather than a callback, for the same reason src/lib/contracts.ts and
 * src/lib/hr-lifecycle.ts are: a completion callback would make the approval engine import the pay
 * modules, which is a dependency in the wrong direction and a second place a loan could be activated
 * from. IT DECIDES NOTHING. It reads a decision the engine already made.
 */
export async function syncLoanApprovals(actorUserId?: string | null): Promise<{
  settled: number;
  errors: string[];
}> {
  const out = { settled: 0, errors: [] as string[] };
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  try {
    await ensureLoanSchema();
    const open = rows(await db.execute(sql`
      SELECT id, workflow_instance_id, state, employee_id::text AS employee_id, kind, principal, currency
        FROM hr_salary_loans
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
        logFail('syncLoanApprovals.getInstance', e);
        out.errors.push('An approval could not be read: ' + reasonOf(e));
        continue;
      }
      if (!instance) continue;

      // 'approved' becomes ACTIVE, not paid. Disbursement is a separate, pressed act.
      let next: LoanState | null = null;
      if (instance.state === 'approved') next = 'active';
      else if (instance.state === 'rejected') next = 'rejected';
      else if (instance.state === 'cancelled') next = 'cancelled';
      else if (instance.state === 'halted') next = 'halted';
      else if (instance.state === 'pending') next = 'pending';
      if (!next || next === String((raw as any).state)) continue;

      try {
        // THE READ IS RE-STATED IN THE WRITE. This UPDATE was `WHERE id = ${id}` alone, and the loop
        // makes a getInstance() round-trip per row, so the window between the SELECT above and this
        // write is many round-trips wide. An employee who withdrew their request in that window had
        // 'cancelled' overwritten with 'active' and an audit row that says the loan was approved,
        // with nothing anywhere recording that a cancellation ever happened.
        //
        // The state this row was READ in is now part of the WHERE, so a row that moved on since is
        // left exactly as it is and this pass simply does not count it. `state` is a plain varchar,
        // so no cast is needed on either side.
        const wrote = rows(await db.execute(sql`
          UPDATE hr_salary_loans
             SET state = ${next}, halt_reason = ${instance.haltReason}::text, updated_at = NOW()
           WHERE id = ${id}::uuid AND state = ${String((raw as any).state)}
          RETURNING id`));
        if (!wrote.length) continue;
        out.settled += 1;
        if (next === 'active') {
          await logAudit({
            userId: actor, action: 'loan.approved', entity: 'hr_salary_loan', entityId: id,
            diff: { workflowInstanceId: instanceId },
          });
        }
        // THE BORROWER IS TOLD. A settled decision about somebody's money reached them only if they
        // happened to reopen the page — and, before this sync started running from the payroll run
        // too, only after an admin had opened the loans console first.
        if (next === 'active' || next === 'rejected') {
          const money = String((raw as any).currency || 'INR') + ' '
            + Number((raw as any).principal || 0).toLocaleString('en-IN');
          await notifyBorrower(String((raw as any).employee_id || ''), {
            type: 'loan_decision',
            title: next === 'active' ? 'Loan or advance approved' : 'Loan or advance declined',
            body: next === 'active'
              ? money + ' is approved. It is recovered from your pay once the disbursement is recorded.'
              : money + ' was not approved.',
            tag: 'loan-' + id,
          });
        }
      } catch (e: any) {
        logFail('syncLoanApprovals.write', e);
        out.errors.push('A decision could not be written down: ' + reasonOf(e));
      }
    }
  } catch (e: any) {
    logFail('syncLoanApprovals', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// RECOVERY — what payroll deducts, and the ledger row that records it
// -------------------------------------------------------------------------------------------------

/** One planned deduction for one loan in one period. Computed, never written, by plannedRecoveries. */
export interface LoanCharge {
  loanId: string;
  kind: string;
  label: string;
  amount: number;
  /**
   * THE CURRENCY THE LOAN IS DENOMINATED IN, carried so payroll can refuse to mix.
   *
   * hr_salary_loans has had a `currency` column since the table was created (see the DDL above) and
   * mapLoan() reads it, but this interface dropped the field — so a loan of USD 500 arrived in
   * src/lib/payroll.ts as the bare number 500 and was deducted from a rupee payslip as 500 rupees.
   * The currency did not convert; it stopped existing at the boundary between these two modules.
   *
   * The consequence compounds: recordRecovery() writes that 500 into hr_loan_instalments, and
   * closeCleared() closes the loan once SUM(amount) reaches total_payable — so a USD 500-a-month
   * loan is marked fully repaid after the rupee ledger has summed to a USD figure, and the balance
   * disappears from the register while the debt is still owed.
   */
  currency: string;
  principalPart: number;
  interestPart: number;
  /** What will still be owed AFTER this deduction. Printed so a payslip can say where it stands. */
  remainingAfter: number;
  /** True when this deduction clears the balance and the loan closes. */
  finalInstalment: boolean;
}

/**
 * WHAT THIS PERSON'S PAY SHOULD LOSE TO LOAN RECOVERY THIS MONTH. READ-ONLY.
 *
 * Called by src/lib/payroll.ts computePay(), which is itself read-only so a payroll run can be
 * PREVIEWED before anybody commits to one. Nothing is written until recordRecovery() runs against a
 * real payslip.
 *
 * IT STOPS BY ITSELF, in three separate ways, because a deduction that outlives the debt is the
 * failure this whole module is shaped around:
 *   1. only loans in state 'active' are considered — rejected, withdrawn and CLOSED ones are not;
 *   2. only loans that have actually been DISBURSED, so undisbursed money is never recovered;
 *   3. the amount is min(instalment, outstanding), so the last recovery is the exact remainder and
 *      the one after it would be zero and is therefore not produced at all.
 */
export async function plannedRecoveries(
  employeeId: string,
  opts: { month: number; year: number },
): Promise<LoanCharge[]> {
  if (!isUuid(employeeId)) return [];
  if (!(await safeEnsure())) return [];
  const month = Math.max(1, Math.min(12, Math.round(Number(opts?.month) || 0)));
  const year = Math.max(1970, Math.min(9999, Math.round(Number(opts?.year) || 0)));
  const period = year * 12 + month;

  try {
    const live = await listLoans({ employeeId, state: 'active', limit: 50 });
    const out: LoanCharge[] = [];
    for (const l of live) {
      if (!l.disbursedAt) continue;                       // never recover money that has not gone out
      if (l.outstanding <= 0) continue;                   // already clear; closeCleared() will close it
      if (l.startYear * 12 + l.startMonth > period) continue; // recovery has not started yet

      const amount = round2(Math.min(l.instalmentAmount, l.outstanding));
      if (amount <= 0) continue;

      // Interest is spread evenly across the planned instalments and the principal is the remainder,
      // which is a SPLIT FOR THE RECORD only — the employee pays `amount` either way. It exists so a
      // settlement or a report can say how much of a repayment was interest without inventing it.
      const interestPart = l.instalments > 0
        ? round2(Math.min(l.interestTotal / l.instalments, amount))
        : 0;
      const remainingAfter = round2(Math.max(0, l.outstanding - amount));

      out.push({
        loanId: l.id,
        kind: l.kind,
        label: loanKindLabel(l.kind) + ' repayment'
          + (l.instalments > 1 ? ' (' + Math.min(l.instalmentsPaid + 1, l.instalments) + ' of ' + l.instalments + ')' : ''),
        amount,
        currency: l.currency,
        principalPart: round2(amount - interestPart),
        interestPart,
        remainingAfter,
        finalInstalment: remainingAfter <= 0,
      });
    }
    return out;
  } catch (e: any) {
    logFail('plannedRecoveries', e);
    return [];
  }
}

/**
 * WRITE ONE RECOVERY INTO THE LEDGER, against a payslip that exists.
 *
 * Called by generateRun() AFTER the payslip row is written, so no ledger row can ever exist for a
 * payslip that does not. ON CONFLICT DO NOTHING against the (loan_id, payroll_run_id) unique index:
 * a re-run of a month recovers nothing extra.
 *
 * THE FAILURE IS RETURNED, NEVER SWALLOWED. The caller reports it beside the employee's name — a
 * payslip that deducted a repayment which never reached the ledger means the balance stays high and
 * the person is charged for it again next month.
 */
export async function recordRecovery(opts: {
  charge: LoanCharge;
  payrollRunId: string;
  payslipId: string;
  month: number;
  year: number;
}): Promise<{ ok: boolean; error?: string }> {
  const c = opts?.charge;
  if (!c || !isUuid(c.loanId)) return { ok: false, error: 'That loan could not be identified.' };
  if (!isUuid(opts?.payrollRunId) || !isUuid(opts?.payslipId)) {
    return { ok: false, error: 'A repayment can only be recorded against a payslip that exists.' };
  }
  const month = Math.max(1, Math.min(12, Math.round(Number(opts?.month) || 0)));
  const year = Math.max(1970, Math.min(9999, Math.round(Number(opts?.year) || 0)));
  try {
    await ensureLoanSchema();
    await db.execute(sql`
      INSERT INTO hr_loan_instalments
        (loan_id, payroll_run_id, payslip_id, month, year, amount, principal_part, interest_part)
      VALUES
        (${c.loanId}::uuid, ${opts.payrollRunId}::uuid, ${opts.payslipId}::uuid, ${month}, ${year},
         ${round2(c.amount)}, ${round2(c.principalPart)}, ${round2(c.interestPart)})
      ON CONFLICT (loan_id, payroll_run_id) DO NOTHING`);

    // CLOSE IT THE MOMENT IT IS CLEAR, in the same statement that checks. Comparing the derived sum
    // rather than trusting the caller's `finalInstalment` flag means a loan closes on the truth of
    // the ledger even if a rounding assumption elsewhere were wrong.
    await db.execute(sql`
      UPDATE hr_salary_loans l
         SET state = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE l.id = ${c.loanId}::uuid
         AND l.state = 'active'
         AND l.total_payable <= (
           SELECT COALESCE(SUM(i.amount), 0) FROM hr_loan_instalments i WHERE i.loan_id = l.id
         )`);
    return { ok: true };
  } catch (e: any) {
    logFail('recordRecovery', e);
    return { ok: false, error: 'The repayment was not written to the loan ledger: ' + reasonOf(e) };
  }
}

/**
 * Close any active loan whose ledger already covers it.
 *
 * A safety net for the case recordRecovery() cannot cover: a loan whose final instalment was written
 * by a run that then failed part-way, or one settled outside payroll on an exit. Idempotent, and it
 * closes nothing that is not actually paid off.
 */
export async function closeClearedLoans(): Promise<{ closed: number; error?: string }> {
  try {
    await ensureLoanSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE hr_salary_loans l
         SET state = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE l.state = 'active'
         AND l.total_payable <= (
           SELECT COALESCE(SUM(i.amount), 0) FROM hr_loan_instalments i WHERE i.loan_id = l.id
         )
      RETURNING l.id, l.employee_id::text AS employee_id`));
    // CLEARED IS WORTH SAYING. The last instalment is the one a borrower actually wants to hear
    // about, and a deduction silently stopping appearing on a payslip is not the same as being told
    // the debt is settled. Each notification is independent of the write, which is already committed.
    for (const row of wrote) {
      await notifyBorrower(String((row as any).employee_id || ''), {
        type: 'loan_cleared',
        title: 'Loan repaid in full',
        body: 'Your loan or advance is fully repaid. Nothing further will be deducted from your pay.',
        tag: 'loan-' + String((row as any).id),
      });
    }
    return { closed: wrote.length };
  } catch (e: any) {
    logFail('closeClearedLoans', e);
    return { closed: 0, error: reasonOf(e) };
  }
}

/**
 * SETTLE A BALANCE OUTSIDE PAYROLL — the exit case, and the only one.
 *
 * When somebody leaves with a loan outstanding, the remainder is recovered from their final
 * settlement rather than from a pay run that will never happen. src/lib/settlement.ts calls this
 * ONCE the settlement has been approved, so the loan closes against the same figure the statement
 * showed. It writes a ledger row with no payslip behind it and a reference that says where it went,
 * which is why the payslip_id column is nullable.
 *
 * It refuses to over-recover: the amount is capped at what is actually outstanding.
 *
 * =================================================================================================
 * WHY THIS IS A CLAIM AND A TRANSACTION, AND NOT A READ FOLLOWED BY TWO WRITES
 * =================================================================================================
 *
 * It used to be: getLoan() -> refuse unless state='active' -> INSERT the whole outstanding balance
 * with payroll_run_id NULL -> UPDATE state='closed' with NO state guard. Three problems compounded:
 *
 *   1. hr_loan_instalments_run_uniq is on (loan_id, payroll_run_id) and Postgres treats NULLs as
 *      DISTINCT, so the ONE constraint that looked like it covered this path covered nothing.
 *   2. Nothing was atomic. Two 'Hand off' presses on a settlement carrying a loan line — or one
 *      press retried after a timeout — both read 'active' and both inserted, so a 100,000 loan with
 *      40,000 outstanding took two 40,000 rows and the ledger summed to 140,000.
 *   3. mapLoan() clamps outstanding with Math.max(0, ...), so the over-recovery read as a clean zero
 *      on the loan register, the employee's screen and the settlement statement alike.
 *
 * Now the state transition IS the claim: 'active' -> 'closed' in one conditional UPDATE, so exactly
 * one caller can proceed, whatever the index situation is. The amount is derived FROM THE LEDGER
 * inside the same statement rather than from a number read earlier, so a payroll recovery that
 * landed in between cannot be double-counted. Both statements run in one transaction: if the
 * instalment cannot be written the closure rolls back and the loan is still open and still owed —
 * which is the only safe half-state for a debt.
 */
export async function settleLoanOutsidePayroll(opts: {
  loanId: string;
  reference: string;
  actorUserId?: string | null;
}): Promise<{ ok: boolean; amount?: number; error?: string }> {
  if (!isUuid(opts?.loanId)) return { ok: false, error: 'That loan could not be identified.' };
  const reference = String(opts?.reference || '').trim().slice(0, 300);
  if (!reference) return { ok: false, error: 'Record where this balance was settled — a reference somebody can follow.' };
  const by = isUuid(opts?.actorUserId) ? String(opts.actorUserId) : null;

  // The period this recovery is filed under, in the zone the company actually works in. It was
  // new Date().getMonth() from the process clock — UTC on this deployment — so a settlement handed
  // off on the 1st before 05:30 IST was filed to the PREVIOUS month, and a monthly reconciliation
  // then showed a recovery in a closed period and a hole in the open one.
  const period = civilToday();
  const settleYear = Number(period.slice(0, 4));
  const settleMonth = Number(period.slice(5, 7));

  try {
    await ensureLoanSchema();
    const loan = await getLoan(opts.loanId);
    if (!loan) return { ok: false, error: 'That loan could not be found.' };
    if (loan.state !== 'active') {
      return { ok: false, error: 'That loan is ' + loanStateLabel(loan.state).toLowerCase() + ', so there is nothing to settle.' };
    }
    if (loan.outstanding <= 0) {
      return { ok: false, error: 'That loan is already clear.' };
    }

    let settled = 0;
    let lost = false;
    await db.transaction(async (tx: any) => {
      // THE CLAIM. Zero rows back means somebody else closed this loan between the read above and
      // here, so this call must write nothing at all.
      const claimed = rows(await tx.execute(sql`
        UPDATE hr_salary_loans SET state = 'closed', closed_at = NOW(), updated_at = NOW()
         WHERE id = ${opts.loanId}::uuid AND state = 'active'
        RETURNING id`));
      if (!claimed.length) { lost = true; return; }

      // THE AMOUNT IS DERIVED HERE, not carried in. total_payable is frozen on the row and the
      // recovered total is the ledger sum as it stands inside this transaction, so nothing that
      // landed in the meantime is charged twice. GREATEST(...,0) keeps a already-over-recovered
      // loan from writing a negative row; the WHERE below then writes nothing at all for it.
      const wrote = rows(await tx.execute(sql`
        INSERT INTO hr_loan_instalments
          (loan_id, payroll_run_id, payslip_id, month, year, amount, principal_part, interest_part)
        SELECT l.id, NULL, NULL, ${settleMonth}, ${settleYear}, d.due, d.due, 0
          FROM hr_salary_loans l
          CROSS JOIN LATERAL (
            SELECT GREATEST(l.total_payable - COALESCE((
              SELECT SUM(i.amount) FROM hr_loan_instalments i WHERE i.loan_id = l.id), 0), 0) AS due
          ) d
         WHERE l.id = ${opts.loanId}::uuid AND d.due > 0
        RETURNING amount`));
      settled = wrote.length ? Number((wrote[0] as any).amount || 0) : 0;
    });

    if (lost) {
      return { ok: false, error: 'That loan was closed a moment ago by someone else, so nothing was recovered twice.' };
    }
    await logAudit({
      userId: by, action: 'loan.settled_on_exit', entity: 'hr_salary_loan', entityId: opts.loanId,
      diff: { amount: settled, reference, month: settleMonth, year: settleYear },
    });
    return { ok: true, amount: settled };
  } catch (e: any) {
    logFail('settleLoanOutsidePayroll', e);
    return { ok: false, error: 'The balance was not settled: ' + reasonOf(e) };
  }
}
