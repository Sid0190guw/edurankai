// src/lib/payroll-reports.ts — WHAT PAYROLL COST, AGGREGATED.
//
// =================================================================================================
// THE LINE THIS FILE DOES NOT CROSS
// =================================================================================================
//
// AN OVERSIGHT SCREEN DOES NOT LIST ONE ROW PER PERSON. Everything rendered on /admin/hr/payroll/
// reports is a TOTAL — per run, per department, per month. Nobody's individual pay appears on it,
// because a screen that puts forty salaries in a scrollable list is a screen that gets left open on
// a laptop in a meeting room, and the number beside somebody's name is not the reader's to have just
// because they can run payroll.
//
// A PAYROLL REGISTER IS PER PERSON, AND THAT IS WHAT REGISTERS ARE FOR — it is the document handed to
// whoever actually pays the money. So it exists here as an EXPORT, downloaded deliberately by
// somebody who already holds `payroll.manage` (the key that already permits reading base_salary and
// generating payslips), and it is written to the audit log when it is taken. It is never rendered as
// a page. Downloading a file is an act; scrolling past a list is not.
//
// SMALL DEPARTMENTS ARE SUPPRESSED, and this is not decoration. A department with one person in it
// has an "aggregate" that IS that person's salary, and a department with two has an aggregate that
// either of them can subtract themselves out of. Any group below MIN_DEPARTMENT_GROUP is reported as
// a named row with its headcount and NO money, so the reader can see that the department exists and
// that its figures are deliberately withheld — which is a different fact from a department with no
// payroll at all, and the screen says which one it is looking at.
//
// NO COMPLIANCE CLAIM ANYWHERE. These are sums of what was actually written on payslips. Nothing
// here asserts that a deduction was correct, statutory, or sufficient for any jurisdiction.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. rows() below; never r.rows[0].
//   - the real Postgres reason is on e.cause.
//   - every const above the function that reads it.
//   - departments.id is a varchar(50) slug in schema.ts and a UUID in db/hr-schema.sql, so every
//     join compares ::text on BOTH sides and NEVER casts ::uuid — a cast throws on half the values.
//   - reads fail closed to an empty result, never to a zero dressed up as an answer.
//   - NO BACKTICK inside a sql template literal, not even in a comment.
//
// =================================================================================================
// TWO CURRENCIES ARE NEVER ADDED TOGETHER ON THIS SCREEN
// =================================================================================================
//
// hr_payslips carries a `currency` column, and computePay() fills it from the employee's salary
// structure — so a company with one person on a non-INR structure produces a run with payslips in
// two currencies. Every total here used to be a bare SUM across all of them, labelled with
// MIN(ps.currency): one USD payslip of 4,000 and nine INR payslips of 60,000 reported a gross of
// "INR 544,000", a number that is not true in any currency and that a reader has no way to spot.
//
// That is the same fault src/lib/hr-wallet.ts getBalance() was repaired for, and it is answered the
// same way: the run's own currency is the one MOST of its payslips are in, only payslips in THAT
// currency are summed, and anything held in another currency is reported SEPARATELY rather than
// folded in or dropped. There is no exchange rate anywhere in this codebase and this file does not
// invent one.
//
// =================================================================================================
// AN EMPTY REPORT AND A FAILED READ ARE DIFFERENT SENTENCES
// =================================================================================================
//
// departmentTotals() and monthlyTotals() returned a bare array and caught their own failure into an
// empty one, so /admin/hr/payroll/reports rendered "This run produced no payslips" and "No payroll
// run exists for 2026" for a database that was simply unreachable. Both now return the rows AND the
// reason they could not be read, and the page says which it is looking at.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
// THE ONE ROUNDING RULE — see src/lib/money.ts. The local copy here was
// `Math.round(n * 100) / 100`, which rounds on the binary double and loses a half paisa downward.
import { numeric } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { MONTH_NAMES } from '@/lib/payroll';
import { csvCell } from '@/lib/csv';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');

const logFail = (tag: string, e: any) => console.error('[payroll-reports] ' + tag, reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Read a NUMERIC postgres-js handed back as a string, rounded on the DECIMAL value. See money.ts. */
const num = (v: any): number => numeric(v);

/**
 * The smallest department whose pay totals may be shown.
 *
 * THREE, matching the suppression floor this codebase already applies to aggregate oversight
 * elsewhere. Below it the row still appears — named, with its headcount — and its money is withheld.
 * Dropping the row entirely would be worse: a reader would conclude the department has no payroll,
 * and the difference between "withheld" and "zero" is the whole point of saying it out loud.
 */
export const MIN_DEPARTMENT_GROUP = 3;

// -------------------------------------------------------------------------------------------------
// THE RUNS
// -------------------------------------------------------------------------------------------------

export interface RunRow {
  id: string;
  month: number;
  year: number;
  periodLabel: string;
  status: string;
  notes: string | null;
  createdAt: string | null;
  paidAt: string | null;
}

function mapRun(r: any): RunRow {
  const month = Number(r?.month) || 1;
  return {
    id: String(r?.id ?? ''),
    month,
    year: Number(r?.year) || 0,
    periodLabel: (MONTH_NAMES[month - 1] || '') + ' ' + (r?.year ?? ''),
    status: String(r?.status || 'draft'),
    notes: r?.notes ? String(r.notes) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    paidAt: r?.paid_at ? new Date(r.paid_at).toISOString() : null,
  };
}

/** Every payroll run, newest period first. Fails closed to an empty list. */
export async function listRuns(limit = 36): Promise<RunRow[]> {
  const lim = Math.min(Math.max(Number(limit) || 36, 1), 200);
  try {
    const r = await db.execute(sql`
      SELECT id, month, year, status, notes, created_at, paid_at
        FROM hr_payroll_runs
       ORDER BY year DESC, month DESC
       LIMIT ${lim}`);
    return rows(r).map(mapRun);
  } catch (e: any) {
    logFail('listRuns', e);
    return [];
  }
}

export interface RunTotals {
  runId: string;
  periodLabel: string;
  status: string;
  /** How many payslips the run actually produced. NOT the company headcount. */
  headcount: number;
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  lopDeduction: number;
  /** Sums taken from the two ledgers, so they agree with the loan and award screens by construction. */
  bonusPaid: number;
  loanRecovered: number;
  /** The currency EVERY figure above is denominated in — the one most of this run's payslips use. */
  currency: string;
  /**
   * Payslips in this run denominated in some OTHER currency.
   *
   * Never folded into the totals above and never dropped. A screen showing this run MUST show this
   * too: money that is invisible is worse than money that is inconvenient, and a gross figure that
   * silently excludes four people is the same lie as one that silently converts them at a rate
   * nobody agreed to.
   */
  otherCurrencies: Array<{ currency: string; payslips: number; gross: number; net: number }>;
  /** Named things that could not be read, in words. Never an empty list dressed up as a zero. */
  gaps: string[];
}

const EMPTY_TOTALS = (runId: string): RunTotals => ({
  runId, periodLabel: '', status: '', headcount: 0, gross: 0, deductions: 0, net: 0,
  employerCost: 0, lopDeduction: 0, bonusPaid: 0, loanRecovered: 0, currency: 'INR',
  otherCurrencies: [], gaps: [],
});

/**
 * ONE RUN, TOTALLED. Headcount, gross, deductions, net — the four numbers a payroll run is judged on.
 *
 * The bonus and loan figures come from hr_bonus_payouts and hr_loan_instalments rather than from the
 * payslip lines, deliberately: those two tables are what the award and loan consoles read, so the
 * report cannot drift from the screens an employee is shown. If either table does not exist yet the
 * figure is reported as a GAP rather than as a zero.
 */
export async function runTotals(runId: string): Promise<RunTotals> {
  const out = EMPTY_TOTALS(String(runId || ''));
  if (!isUuid(runId)) {
    out.gaps.push('that payroll run could not be identified');
    return out;
  }
  try {
    // ONE ROW PER CURRENCY, not one row for the run. The run's own month/year/status come back on
    // every row (they are grouped by, and they are the same on all of them), and a run with no
    // payslips at all still returns exactly one row with a NULL currency and a zero headcount —
    // which is how "this run exists and produced nothing" stays distinguishable from "no such run".
    const perCurrency = rows(await db.execute(sql`
      SELECT pr.month, pr.year, pr.status,
             COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR') AS currency,
             COUNT(ps.id)::int                     AS headcount,
             COALESCE(SUM(ps.gross_salary), 0)     AS gross,
             COALESCE(SUM(ps.total_deductions), 0) AS deductions,
             COALESCE(SUM(ps.net_salary), 0)       AS net,
             COALESCE(SUM(ps.employer_cost), 0)    AS employer_cost,
             COALESCE(SUM(ps.lop_deduction), 0)    AS lop
        FROM hr_payroll_runs pr
        LEFT JOIN hr_payslips ps ON ps.payroll_run_id = pr.id
       WHERE pr.id = ${runId}::uuid
       GROUP BY pr.month, pr.year, pr.status, COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR')
       ORDER BY COUNT(ps.id) DESC`)) as any[];

    if (!perCurrency.length) {
      out.gaps.push('that payroll run could not be found');
      return out;
    }
    const head = perCurrency[0];
    out.periodLabel = (MONTH_NAMES[(Number(head.month) || 1) - 1] || '') + ' ' + (head.year ?? '');
    out.status = String(head.status || 'draft');

    // The run's currency is the one MOST of its payslips are in (the ORDER BY above put it first).
    // Every headline figure is that currency and only that currency.
    out.currency = String(head.currency || 'INR');
    out.headcount = Number(head.headcount) || 0;
    out.gross = num(head.gross);
    out.deductions = num(head.deductions);
    out.net = num(head.net);
    out.employerCost = num(head.employer_cost);
    out.lopDeduction = num(head.lop);

    for (const row of perCurrency.slice(1)) {
      const cur = String(row.currency || 'INR');
      const payslips = Number(row.headcount) || 0;
      if (payslips <= 0) continue;
      out.otherCurrencies.push({ currency: cur, payslips, gross: num(row.gross), net: num(row.net) });
    }
  } catch (e: any) {
    logFail('runTotals.head', e);
    out.gaps.push('the payslip totals for this run');
    return out;
  }

  // NOTE ON THESE TWO. hr_bonus_payouts and hr_loan_instalments carry no currency column of their
  // own — an amount there is implicitly in the payslip's currency — so on a run whose payslips are
  // not all in one currency these two figures span the whole run and the currency label above does
  // not strictly apply to them. That is stated on the screen beside the mixed-currency notice rather
  // than hidden here. Adding a currency column to two ledgers this file only READS is not this
  // module's change to make.
  try {
    const b = rows(await db.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS total FROM hr_bonus_payouts
       WHERE payroll_run_id = ${runId}::uuid`))[0] as any;
    out.bonusPaid = num(b?.total);
  } catch (e: any) {
    // The award ledger may simply not have been provisioned yet on a fresh database. Saying so is a
    // different sentence from reporting that no bonus was paid, and both are things a reader needs.
    logFail('runTotals.bonus', e);
    out.gaps.push('bonuses paid in this run');
  }

  try {
    const l = rows(await db.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS total FROM hr_loan_instalments
       WHERE payroll_run_id = ${runId}::uuid`))[0] as any;
    out.loanRecovered = num(l?.total);
  } catch (e: any) {
    logFail('runTotals.loans', e);
    out.gaps.push('loan repayments recovered in this run');
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// BY DEPARTMENT — suppressed below MIN_DEPARTMENT_GROUP
// -------------------------------------------------------------------------------------------------

export interface DepartmentTotals {
  departmentId: string | null;
  departmentName: string;
  headcount: number;
  /** Null WHENEVER the group is too small to report. Null is not zero and must not render as zero. */
  gross: number | null;
  deductions: number | null;
  net: number | null;
  suppressed: boolean;
  /** The currency this row's figures are in. A row is never a mix — see the grouping below. */
  currency: string;
}

/**
 * ONE RUN, SPLIT BY DEPARTMENT AND BY CURRENCY.
 *
 * Every join onto `departments` compares ::text on both sides. departments.id is a varchar(50) slug
 * in src/lib/db/schema.ts and a UUID in db/hr-schema.sql, so ::uuid throws on half the values in this
 * product — that is a live fault class here, not a hypothetical one.
 *
 * People with no department land in one honest row called "No department recorded" rather than being
 * dropped, because a payroll report whose parts do not add up to the whole is worse than useless.
 *
 * CURRENCY IS PART OF THE GROUP, so a department paying some people in one currency and some in
 * another produces TWO rows, each labelled, rather than one row adding the two together. Two rows
 * that are each true beat one row that is true in no currency. It also tightens the suppression, not
 * loosens it: the headcount tested against MIN_DEPARTMENT_GROUP is the headcount of the smaller
 * group, so a split department is more likely to be withheld, never less.
 *
 * RETURNS THE REASON IT COULD NOT READ. It used to catch into an empty array, and the page printed
 * "This run produced no payslips, so there is nothing to split" for a database that was down.
 */
export async function departmentTotals(runId: string): Promise<{ rows: DepartmentTotals[]; error: string | null }> {
  if (!isUuid(runId)) return { rows: [], error: 'that payroll run could not be identified' };
  try {
    const r = await db.execute(sql`
      SELECT e.department_id::text            AS department_id,
             COALESCE(d.name, '')             AS department_name,
             COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR') AS currency,
             COUNT(ps.id)::int                AS headcount,
             COALESCE(SUM(ps.gross_salary), 0)     AS gross,
             COALESCE(SUM(ps.total_deductions), 0) AS deductions,
             COALESCE(SUM(ps.net_salary), 0)       AS net
        FROM hr_payslips ps
        JOIN hr_employees e ON e.id = ps.employee_id
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE ps.payroll_run_id = ${runId}::uuid
       GROUP BY e.department_id::text, COALESCE(d.name, ''), COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR')
       ORDER BY COALESCE(d.name, '') ASC, COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR') ASC`);
    return {
      rows: rows(r).map((x: any) => {
        const headcount = Number(x.headcount) || 0;
        const suppressed = headcount < MIN_DEPARTMENT_GROUP;
        return {
          departmentId: x.department_id ? String(x.department_id) : null,
          departmentName: String(x.department_name || '') || 'No department recorded',
          headcount,
          gross: suppressed ? null : num(x.gross),
          deductions: suppressed ? null : num(x.deductions),
          net: suppressed ? null : num(x.net),
          suppressed,
          currency: String(x.currency || 'INR'),
        };
      }),
      error: null,
    };
  } catch (e: any) {
    logFail('departmentTotals', e);
    return { rows: [], error: reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// BY MONTH
// -------------------------------------------------------------------------------------------------

export interface MonthTotals {
  month: number;
  year: number;
  periodLabel: string;
  headcount: number;
  gross: number;
  deductions: number;
  net: number;
  status: string;
  /** The currency this row's figures are in. Currency is part of the group, so a row is never a mix. */
  currency: string;
}

/**
 * Every run in one year, in calendar order, so a reader can see the shape of the year.
 *
 * ONE ROW PER MONTH PER CURRENCY, for the reason set out in the file header: a month whose payslips
 * are in two currencies is two rows, each true, rather than one row that adds rupees to dollars.
 *
 * RETURNS THE REASON IT COULD NOT READ. It used to catch into an empty array and the page then said
 * "No payroll run exists for 2026", which is a statement about the company, not about the database.
 */
export async function monthlyTotals(year: number): Promise<{ rows: MonthTotals[]; error: string | null }> {
  const y = Math.round(Number(year) || 0);
  if (y < 2000 || y > 2100) return { rows: [], error: 'that is not a year this product holds payroll for' };
  try {
    const r = await db.execute(sql`
      SELECT pr.month, pr.year, pr.status,
             COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR') AS currency,
             COUNT(ps.id)::int                     AS headcount,
             COALESCE(SUM(ps.gross_salary), 0)     AS gross,
             COALESCE(SUM(ps.total_deductions), 0) AS deductions,
             COALESCE(SUM(ps.net_salary), 0)       AS net
        FROM hr_payroll_runs pr
        LEFT JOIN hr_payslips ps ON ps.payroll_run_id = pr.id
       WHERE pr.year = ${y}
       GROUP BY pr.month, pr.year, pr.status, COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR')
       ORDER BY pr.month ASC, COALESCE(NULLIF(UPPER(ps.currency), ''), 'INR') ASC`);
    return {
      rows: rows(r).map((x: any) => {
        const month = Number(x.month) || 1;
        return {
          month,
          year: Number(x.year) || y,
          periodLabel: (MONTH_NAMES[month - 1] || '') + ' ' + (x.year ?? y),
          headcount: Number(x.headcount) || 0,
          gross: num(x.gross),
          deductions: num(x.deductions),
          net: num(x.net),
          status: String(x.status || 'draft'),
          currency: String(x.currency || 'INR'),
        };
      }),
      error: null,
    };
  } catch (e: any) {
    logFail('monthlyTotals', e);
    return { rows: [], error: reasonOf(e) };
  }
}

/** Which years have any payroll at all, so a picker offers real periods rather than a guess. */
export async function payrollYears(): Promise<number[]> {
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT year FROM hr_payroll_runs ORDER BY year DESC LIMIT 30`);
    return rows(r).map((x: any) => Number(x.year) || 0).filter((n) => n > 0);
  } catch (e: any) {
    logFail('payrollYears', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// THE REGISTER EXPORT — per person, downloaded on purpose, and written to the audit log
// -------------------------------------------------------------------------------------------------

/**
 * THE PAYROLL REGISTER FOR ONE RUN, as CSV.
 *
 * PER PERSON, because that is what a register is: the document handed to whoever moves the money.
 * It is NOT rendered as a page anywhere — see the header. The caller must already hold
 * `payroll.manage`, and it writes an audit entry naming who took it and for which run, so that the
 * export of every salary in the company is an event with somebody's name on it rather than a page
 * view.
 *
 * Returns null when the run does not exist or cannot be read; the caller renders a sentence rather
 * than serving an empty file that looks like a company with no employees.
 */
export async function registerCsv(
  runId: string,
  actorUserId: string | null,
): Promise<{ filename: string; csv: string } | null> {
  if (!isUuid(runId)) return null;

  // A component label, an employee name or a designation is free text somebody typed, and a comma
  // or a quote in it would otherwise shift every later column by one — which in a payroll register
  // means paying the wrong amount to the right person. csvCell also stops a name beginning with
  // `=` from becoming a formula, while leaving a negative deduction like -1500 as a NUMBER, so the
  // total at the bottom of the accountant's column still adds up. See src/lib/csv.ts.
  const cell = csvCell;

  try {
    const meta = rows(await db.execute(sql`
      SELECT month, year, status FROM hr_payroll_runs WHERE id = ${runId}::uuid LIMIT 1`))[0] as any;
    if (!meta) return null;

    const r = await db.execute(sql`
      SELECT e.employee_code, e.full_name, e.designation,
             COALESCE(d.name, '') AS department_name,
             ps.days_worked, ps.days_leave, ps.days_absent, ps.lop_days, ps.lop_deduction,
             ps.basic, ps.gross_salary, ps.total_deductions, ps.net_salary,
             ps.employer_cost, ps.currency, ps.status
        FROM hr_payslips ps
        JOIN hr_employees e ON e.id = ps.employee_id
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE ps.payroll_run_id = ${runId}::uuid
       ORDER BY e.full_name ASC`);

    const header = [
      'Employee code', 'Name', 'Designation', 'Department',
      'Days worked', 'Leave days', 'Absent days', 'Loss of pay days', 'Loss of pay',
      'Basic', 'Gross', 'Deductions', 'Net', 'Employer cost', 'Currency', 'Payslip status',
    ].map(cell).join(',');

    const body = rows(r).map((x: any) => [
      x.employee_code, x.full_name, x.designation, x.department_name,
      x.days_worked, x.days_leave, x.days_absent, x.lop_days, x.lop_deduction,
      x.basic, x.gross_salary, x.total_deductions, x.net_salary,
      x.employer_cost, x.currency, x.status,
    ].map(cell).join(','));

    const period = (MONTH_NAMES[(Number(meta.month) || 1) - 1] || '') + '-' + (meta.year ?? '');

    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'payroll.register.exported',
      entity: 'hr_payroll_run',
      entityId: runId,
      diff: { period, employees: body.length },
    });

    return {
      filename: 'payroll-register-' + period.toLowerCase() + '.csv',
      csv: [header, ...body].join('\r\n') + '\r\n',
    };
  } catch (e: any) {
    logFail('registerCsv', e);
    return null;
  }
}
