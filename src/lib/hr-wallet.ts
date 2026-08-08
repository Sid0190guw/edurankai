// HRMS wallet + payouts. Salary is disbursed into an employee wallet (a
// double-entry ledger); the employee connects a bank account; withdrawals are
// requested by the employee and must be approved by someone who holds
// `payouts.approve` — or by that employee's own reporting manager — before being
// released by someone who holds `payouts.pay` via Razorpay (RazorpayX Payouts).
// Self-bootstrapping schema — consistent with the rest of the app.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { holdsCapability, decidesEveryRequest, type ApprovalCapability } from '@/lib/auth/capability';
// Money arithmetic. numeric() reads the NUMERIC that postgres-js hands back as a STRING without the
// precision loss a ::float cast in SQL causes; toMinor/fromMinor compare and subtract in integer
// paise, which is why an employee is no longer refused a withdrawal of the exact balance they hold.
import { numeric, toMinor, fromMinor } from '@/lib/money';
import { sendPushToUser } from '@/lib/push';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** Where a wallet notification sends somebody. The page exists (src/pages/portal/employee/wallet.astro). */
const WALLET_PORTAL_URL = '/portal/employee/wallet';

/**
 * TELL AN EMPLOYEE WHAT HAPPENED TO THEIR OWN MONEY.
 *
 * NOTHING IN THIS MODULE DID THIS. decideWithdrawal() ended at hrAudit(); payWithdrawal() ended at
 * hrAudit(); the workflow mirror in expenses.routeWithdrawals() ends at logAudit(); and
 * workflow.notifyRequester() could not fire because that mirror starts the instance without a
 * requestedByUserId. So a person asked for their own money and was never told what happened to it —
 * not when it was approved, not when it left. The withdrawal simply changed colour on a page they had
 * to go and look at. That is the payroll mark-paid fault repeating in the withdrawal path, except
 * here it was never wired at all rather than broken by a wrong column.
 *
 * Declared ABOVE its readers; `const` is not hoisted. Never blocks the decision it announces.
 */
async function notifyEmployeeOfMoney(
  employeeId: string,
  payload: { type: string; title: string; body: string; tag: string },
): Promise<void> {
  try {
    const r = await safe(sql`SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`);
    const userId = r.length ? String(r[0].user_id || '') : '';
    if (!userId) return;
    await sendPushToUser(userId, { ...payload, url: WALLET_PORTAL_URL });
  } catch (e: any) {
    console.error('[hr-wallet] could not notify employee', employeeId, '-', e?.cause?.message || e?.message);
  }
}
/**
 * A read that answers "nothing" rather than throwing.
 *
 * KEPT for the LIST screens, where an empty table and an unreadable one both render as "no rows"
 * and neither is dangerous. It is NOT used by creditPayrollRun() any more: there, an empty list was
 * indistinguishable from "already credited" and turned a total wallet-credit failure into a
 * reassuring message. Note that getBalance() still reports ₹0 on a failed read — that is a wrong
 * number shown to an employee, so the reason is at least on the log now instead of nowhere.
 */
async function safe(q: any): Promise<any[]> {
  try { return rows(await db.execute(q)); } catch (e: any) {
    console.error('[hr-wallet] read failed, returning no rows:', e?.cause?.message || e?.message);
    return [];
  }
}

/**
 * THE DUPLICATE IS GONE. `holdsHrCapability` was a byte-for-byte copy of holdsCapability() in
 * src/lib/auth/workspace-access.ts, kept separate — the comment here said so — "so the HR money path
 * has no dependency on the workspace module", and ending "if they are ever consolidated, consolidate
 * them deliberately and together." This is that consolidation.
 *
 * The dependency concern is answered by WHERE the shared copy lives, not by keeping two of them:
 * src/lib/auth/capability.ts imports src/lib/auth/permissions and nothing else, so this module still
 * does not reach the workspace module. What it no longer does is carry its own copy of the
 * adaptation rules, which were one edit away from disagreeing about what `isActive` means.
 *
 * The name is kept as an alias because src/lib/hr-leave.ts imports it from here. Same function, same
 * answer for every account.
 */
export { holdsCapability, holdsCapability as holdsHrCapability, type ApprovalCapability };

let ready: Promise<void> | null = null;
export function ensureWalletSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_wallet_txn (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        direction TEXT NOT NULL,            -- 'credit' | 'debit'
        amount NUMERIC(14,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        kind TEXT NOT NULL DEFAULT 'adjustment', -- salary|bonus|reimbursement|withdrawal|adjustment
        ref TEXT, note TEXT, created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_wallet_txn_emp ON hr_wallet_txn (employee_id, created_at DESC)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_bank_account (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        holder TEXT NOT NULL, account_number TEXT NOT NULL, ifsc TEXT NOT NULL DEFAULT '',
        bank_name TEXT NOT NULL DEFAULT '', upi_id TEXT NOT NULL DEFAULT '',
        is_primary BOOLEAN NOT NULL DEFAULT true, verified BOOLEAN NOT NULL DEFAULT false,
        rzp_fund_account_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_withdrawal (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        amount NUMERIC(14,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
        bank_account_id UUID, method TEXT NOT NULL DEFAULT 'bank',
        status TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|paid|failed
        note TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_by UUID, decided_by_role TEXT, decided_at TIMESTAMPTZ, decision_note TEXT,
        payout_ref TEXT, paid_at TIMESTAMPTZ)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_withdrawal_status ON hr_withdrawal (status, requested_at DESC)`);
      // ADDITIVE. payWithdrawal() now CLAIMS a request into status 'paying' before it calls the payout
      // provider, so a second press cannot reach the provider at all. These two columns say who holds
      // the claim and since when, which is the only way to tell a payout in flight from one whose
      // process died between the claim and the provider's answer. Nothing is dropped, and a database
      // that already has the columns is unaffected.
      await db.execute(sql`ALTER TABLE hr_withdrawal ADD COLUMN IF NOT EXISTS paying_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_withdrawal ADD COLUMN IF NOT EXISTS paying_by UUID`);
      // IDEMPOTENCY FOR SALARY, ENFORCED BY THE DATABASE RATHER THAN BY A RACE.
      //
      // creditPayrollRun() skips a payslip whose ref already exists, but that read-then-write is not
      // atomic: two Mark Paid clicks landing together both see no row and both credit the same
      // payslip. db/hr-schema.sql:333 creates a NON-unique index for this lookup and this module
      // created none at all, so on a database bootstrapped only by the lib the lookup was also
      // unindexed. A UNIQUE index closes the race and keeps the lookup fast.
      //
      // ADDITIVE AND NON-FATAL. If a live database already contains a duplicated ref the index
      // cannot be built; that must not take the wallet module down, so the failure is logged loudly
      // (it means somebody has been paid twice and it needs a human) and the rest still works —
      // creditPayrollRun's own SELECT guard continues to cover the non-concurrent case.
      try {
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_wallet_txn_ref_uniq ON hr_wallet_txn (ref) WHERE ref IS NOT NULL`);
      } catch (e: any) {
        console.error('[hr-wallet] could not create the UNIQUE index on hr_wallet_txn.ref — duplicate refs may already exist, which means a payslip was credited more than once:', e?.cause?.message || e?.message);
      }
    } catch (e: any) {
      // WAS `catch (_) { ready = null; }` — a silent reset that retried forever and never said what
      // was wrong. Still retries (that is correct: a transient outage should not permanently poison
      // the module), but the reason is now on the log.
      console.error('[hr-wallet] ensureWalletSchema failed, will retry on next call:', e?.cause?.message || e?.message);
      ready = null;
    }
  })();
  return ready;
}

export interface Balance {
  balance: number;
  currency: string;
  pending: number;
  available: number;
  /**
   * Money this employee holds in a currency OTHER than the one `balance` is denominated in.
   *
   * Normally empty. It is never folded into `balance`, and a screen that shows a wallet MUST show
   * this too — see the comment on getBalance() for what happens when it is not.
   */
  otherCurrencies: Array<{ currency: string; balance: number }>;
}

/**
 * THE WALLET BALANCE, IN ONE CURRENCY, WITHOUT ADDING TWO OF THEM TOGETHER.
 *
 * WHAT THIS USED TO DO. It summed EVERY hr_wallet_txn row for an employee regardless of the
 * `currency` column that has existed on that table since it was created, cast the exact NUMERIC to
 * ::float, and then returned the result hard-coded as `currency: 'INR'`. A wallet holding one salary
 * credit of USD 1,000 and one reimbursement of INR 5,000 reported a balance of ₹6,000 — a number that
 * is not true in any currency, printed with a rupee sign, and withdrawable.
 *
 * That was not a hypothetical. creditPayrollRun() writes the PAYSLIP's currency into the ledger
 * (`${s.currency || 'INR'}`), and computePay() reads that currency from the salary structure, so any
 * employee on a non-INR structure produced exactly these rows.
 *
 * WHAT IT DOES NOW. The employee's own currency is resolved once — the caller's argument, else the
 * salary structure, else hr_employees.currency, else INR — and only rows in THAT currency are summed.
 * Anything held in another currency is returned separately in `otherCurrencies` rather than being
 * dropped, because money that is invisible is worse than money that is inconvenient. There is no
 * exchange rate anywhere in this codebase and this function does not invent one.
 *
 * THE ::float CASTS ARE GONE. postgres-js returns NUMERIC as a STRING precisely so no precision is
 * lost; casting to float in SQL threw that away before JavaScript ever saw it, and the arithmetic
 * `balance - pending` on the results produced values like 7225.199999999999. Comparisons now happen
 * in integer paise (see requestWithdrawal), and these figures are for display.
 */
export async function getBalance(employeeId: string, currencyHint?: string): Promise<Balance> {
  await ensureWalletSchema();

  let currency = String(currencyHint || '').trim().toUpperCase();
  if (!currency) {
    const emp = (await safe(sql`
      SELECT COALESCE(ss.currency, e.currency, 'INR') AS cur
        FROM hr_employees e
        LEFT JOIN hr_salary_structures ss ON ss.employee_id = e.id
             AND ss.effective_from <= CURRENT_DATE
             AND (ss.effective_to IS NULL OR ss.effective_to >= CURRENT_DATE)
       WHERE e.id = ${employeeId}::uuid
       ORDER BY ss.effective_from DESC NULLS LAST
       LIMIT 1`))[0] || {};
    currency = String(emp.cur || 'INR').toUpperCase();
  }

  // One row per currency held, so nothing an employee owns can fall out of the answer unseen.
  const byCurrency = await safe(sql`
    SELECT COALESCE(NULLIF(UPPER(currency), ''), 'INR') AS cur,
           COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) AS bal
      FROM hr_wallet_txn
     WHERE employee_id = ${employeeId}::uuid
     GROUP BY 1`);

  let balance = 0;
  const otherCurrencies: Array<{ currency: string; balance: number }> = [];
  for (const row of byCurrency) {
    const cur = String(row.cur || 'INR').toUpperCase();
    const amount = numeric(row.bal);
    if (cur === currency) balance = amount;
    else if (amount !== 0) otherCurrencies.push({ currency: cur, balance: amount });
  }

  // 'paying' is money already handed to the payout channel and not yet confirmed. It is NOT available
  // to request again, so it counts as pending exactly like 'pending' and 'approved' do. Withdrawals
  // are matched on currency for the same reason the ledger is.
  const pend = (await safe(sql`
    SELECT COALESCE(SUM(amount), 0) AS p
      FROM hr_withdrawal
     WHERE employee_id = ${employeeId}::uuid
       AND status IN ('pending', 'approved', 'paying')
       AND COALESCE(NULLIF(UPPER(currency), ''), 'INR') = ${currency}`))[0] || {};
  const pending = numeric(pend.p);

  return {
    balance,
    currency,
    pending,
    // Subtracted in integer paise so the figure quoted back to an employee is the figure compared.
    available: Math.max(0, fromMinor(toMinor(balance) - toMinor(pending))),
    otherCurrencies,
  };
}
export async function listTxns(employeeId: string, limit = 30): Promise<any[]> {
  await ensureWalletSchema();
  return safe(sql`SELECT direction, amount, currency, kind, note, created_at FROM hr_wallet_txn WHERE employee_id = ${employeeId} ORDER BY created_at DESC LIMIT ${limit}`);
}
/**
 * Put money into an employee's wallet.
 *
 * `currency` IS NOT OPTIONAL IN MEANING, only in position — it is last so no existing call site
 * changes shape, and it defaults to INR exactly as the column already did.
 *
 * WHY IT HAD TO EXIST. This function took no currency and its INSERT omitted the column, so every
 * row it wrote defaulted to 'INR'. Two callers hand it money that carries its own currency:
 * src/lib/expenses.ts credits `claim.amount` for a claim with a currency column, and
 * src/lib/invoices.ts credits an invoice payment whose invoice carries one. An approved travel claim
 * of USD 1,200 therefore landed as a credit of 1,200 RUPEES — roughly a hundredth of what was
 * approved — and nothing anywhere recorded that a conversion had been assumed, because none had:
 * the currency was simply dropped on the way in.
 *
 * NEGATIVES ARE REFUSED AT THE WRITE. `!(amount > 0)` also catches NaN, so a credit is either a
 * positive amount or it is not written. A negative "credit" is a debit and belongs on the debit path
 * where the balance is checked.
 */
export async function credit(
  employeeId: string,
  amount: number,
  kind: string,
  note: string,
  createdBy: string | null,
  ref?: string,
  currency?: string | null,
): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  await ensureWalletSchema();
  if (!(amount > 0)) return { ok: false, error: 'A credit is a positive amount.' };
  const cur = String(currency || 'INR').trim().toUpperCase().slice(0, 8) || 'INR';
  // =================================================================================================
  // A DUPLICATE REF IS NOT A FAILURE — IT IS THE IDEMPOTENCY WORKING
  // =================================================================================================
  //
  // hr_wallet_txn_ref_uniq is a PARTIAL unique index (WHERE ref IS NOT NULL). A caller that supplies
  // a ref gets exactly-once crediting from the database rather than from a read-then-write race, and
  // the second attempt lands here as a duplicate-key error. Reporting that as an error would make the
  // repair paths retry it; reporting it as `duplicate` lets a screen say "already credited", which is
  // the truth. Anything else still throws, because a credit that did not happen must never read as
  // one that did.
  //
  // The return value is additive: every existing caller ignored the void this used to return.
  try {
    await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, currency, kind, note, ref, created_by)
      VALUES (${employeeId}, 'credit', ${amount}, ${cur}, ${kind}, ${note || null}, ${ref || null}, ${createdBy})`);
    return { ok: true };
  } catch (e: any) {
    const real = String(e?.cause?.message || e?.message || '');
    if (ref && /duplicate key|unique constraint/i.test(real)) {
      return { ok: true, duplicate: true };
    }
    console.error('[hr-wallet] credit failed for employee', employeeId, '-', real);
    throw e;
  }
}

// ---- bank accounts ----
function mask(acc: string): string { const a = (acc || '').replace(/\s/g, ''); return a.length > 4 ? '••••' + a.slice(-4) : a; }
/**
 * Credit a payroll run into employee wallets — the step that was missing entirely.
 *
 * Payroll marked a run "paid" and set every payslip to paid, but nothing ever reached the wallet
 * ledger, so an employee's balance stayed at zero however many months they had been paid for and
 * there was nothing to withdraw. This closes payroll -> wallet -> withdrawal into one chain.
 *
 * IDEMPOTENT: each credit carries ref 'payslip:<id>', and an existing txn with that ref is
 * skipped. Marking a run paid twice (double submit, retry, an HR user re-clicking) must not pay
 * anyone twice.
 *
 * NOTHING HERE IS ALLOWED TO FAIL QUIETLY. This function used to read its payslips through safe(),
 * which is `try { ... } catch { return [] }` — so ANY failure of that SELECT produced an empty list,
 * the credit loop never ran, and it returned {credited:0, skipped:0} with no error anywhere. The
 * caller reads credited===0 as "already credited", so a TOTAL wallet-credit failure was rendered to
 * the admin as reassurance while the run was already marked paid and every employee was pushed
 * "Rs X has been credited to your wallet". The per-payslip INSERT had the same shape: `catch { skipped++ }`.
 *
 * Now: the SELECT failure THROWS (the caller must not be able to mistake it for success), and every
 * payslip that could not be credited is logged with e.cause.message and returned in `failures` as a
 * sentence an admin can act on. `alreadyCredited` is reported separately from `skipped` so "nothing
 * to do" and "nothing worked" can never look alike again.
 */
export interface PayrollCreditResult {
  credited: number;
  skipped: number;
  total: number;
  /** Payslips already in the ledger from an earlier Mark Paid — genuinely fine. */
  alreadyCredited: number;
  /** One readable sentence per payslip that could NOT be credited. Empty means every payslip landed. */
  failures: string[];
  /** employee_ids whose salary is in the wallet ledger now — credited on this pass or already there. */
  walletOk: string[];
}

export async function creditPayrollRun(runId: string, byUserId: string | null): Promise<PayrollCreditResult> {
  await ensureWalletSchema();

  let slips: any[];
  try {
    slips = rows(await db.execute(sql`
      SELECT ps.id, ps.employee_id, ps.net_salary, ps.currency, pr.month, pr.year
      FROM hr_payslips ps JOIN hr_payroll_runs pr ON ps.payroll_run_id = pr.id
      WHERE ps.payroll_run_id = ${runId}`));
  } catch (e: any) {
    const real = e?.cause?.message || e?.message;
    console.error('[hr-wallet] creditPayrollRun could not read the payslips for run', runId, '-', real);
    // THROWS ON PURPOSE. Returning {credited:0} here is indistinguishable from "already credited",
    // which is exactly how a failed payroll credit came to be reported as a success.
    throw new Error('Could not read the payslips for this run, so no wallet was credited: ' + (real || 'unknown database error'));
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  let credited = 0, skipped = 0, total = 0, alreadyCredited = 0;
  const failures: string[] = [];
  const walletOk: string[] = [];

  for (const s of slips) {
    const amount = Number(s.net_salary || 0);
    const who = String(s.employee_id || 'unknown employee');
    if (!s.employee_id) {
      skipped++;
      failures.push('A payslip on this run (' + String(s.id) + ') has no employee linked to it, so nothing could be credited for it.');
      continue;
    }
    if (!(amount > 0)) {
      // A zero/negative net is a legitimate outcome (full loss of pay), not a failure — but it is
      // still worth saying out loud, because the employee will be notified about a payslip.
      skipped++;
      continue;
    }
    const ref = 'payslip:' + s.id;
    let dupe: any[];
    try {
      dupe = rows(await db.execute(sql`SELECT id FROM hr_wallet_txn WHERE ref = ${ref} LIMIT 1`));
    } catch (e: any) {
      const real = e?.cause?.message || e?.message;
      console.error('[hr-wallet] duplicate check failed for', ref, '-', real);
      skipped++;
      failures.push('Could not check whether employee ' + who + ' had already been credited, so ₹' + Math.round(amount).toLocaleString('en-IN') + ' was NOT credited (' + (real || 'database error') + ').');
      continue;
    }
    if (dupe.length) { alreadyCredited++; walletOk.push(who); continue; }

    const period = (MONTHS[(Number(s.month) || 1) - 1] || '') + ' ' + (s.year || '');
    try {
      await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, currency, kind, note, ref, created_by)
        VALUES (${s.employee_id}, 'credit', ${amount}, ${s.currency || 'INR'}, 'salary',
                ${'Salary for ' + period.trim()}, ${ref}, ${byUserId})`);
      credited++; total += amount; walletOk.push(who);
    } catch (e: any) {
      const real = String(e?.cause?.message || e?.message || '');
      // The UNIQUE index on ref is the concurrency guard: losing that race means somebody else
      // credited this exact payslip a moment ago, which is the desired outcome, not a failure.
      if (/duplicate key|unique constraint/i.test(real)) { alreadyCredited++; walletOk.push(who); continue; }
      console.error('[hr-wallet] wallet credit FAILED for payslip', s.id, 'employee', who, '-', real);
      skipped++;
      failures.push('Employee ' + who + ' was NOT credited ₹' + Math.round(amount).toLocaleString('en-IN') + ' (' + (real || 'database error') + ').');
    }
  }
  return { credited, skipped, total, alreadyCredited, failures, walletOk };
}

export async function listBankAccounts(employeeId: string): Promise<any[]> {
  await ensureWalletSchema();
  return (await safe(sql`SELECT id, holder, account_number, ifsc, bank_name, upi_id, is_primary, verified FROM hr_bank_account WHERE employee_id = ${employeeId} ORDER BY is_primary DESC, created_at DESC`))
    .map((r) => ({ ...r, account_masked: mask(r.account_number) }));
}
export async function addBankAccount(employeeId: string, f: { holder: string; account_number: string; ifsc: string; bank_name?: string; upi_id?: string }): Promise<void> {
  await ensureWalletSchema();
  // WAS `.catch(() => {})`. If this demotion fails the next insert makes a SECOND primary account,
  // and payWithdrawal pays whichever the request happened to name — with nothing anywhere saying two
  // exist. The insert still proceeds (an account the employee can see beats no account at all), but
  // the reason is on the log instead of nowhere.
  await db.execute(sql`UPDATE hr_bank_account SET is_primary = false WHERE employee_id = ${employeeId}`)
    .catch((e: any) => {
      console.error('[hr-wallet] could not clear the previous primary bank account for employee',
        employeeId, '- there may now be two marked primary:', e?.cause?.message || e?.message);
    });
  await db.execute(sql`INSERT INTO hr_bank_account (employee_id, holder, account_number, ifsc, bank_name, upi_id, is_primary)
    VALUES (${employeeId}, ${f.holder.slice(0, 120)}, ${(f.account_number || '').replace(/\s/g, '').slice(0, 30)}, ${(f.ifsc || '').toUpperCase().slice(0, 15)}, ${(f.bank_name || '').slice(0, 120)}, ${(f.upi_id || '').slice(0, 80)}, true)`);
}

// ---- withdrawals ----
/**
 * Ask to withdraw from the wallet.
 *
 * THE BALANCE TEST AND THE INSERT ARE ONE STATEMENT, and that is the whole point of the shape below.
 * It used to read the balance, compare it in JavaScript, and then insert — so two requests submitted
 * together (a double tap, a retried POST) both saw the same available balance and both were written,
 * and an employee could have more requested than they hold. The ledger sums and the pending sum are
 * now computed inside the INSERT ... SELECT ... WHERE, against the same snapshot the row is written
 * from, so the second request finds the first one already counted in `pending` and inserts nothing.
 *
 * Zero rows back is therefore NOT a database failure: it is the refusal, and it is reported as one
 * with the balance re-read so the sentence names a real number.
 */
export async function requestWithdrawal(
  employeeId: string,
  amount: number,
  bankAccountId: string | null,
  note: string,
): Promise<{
  ok: boolean;
  error?: string;
  /** The request exists but nobody has been asked yet. NEVER auto-approved — see the routing below. */
  halted?: boolean;
  haltReason?: string;
}> {
  await ensureWalletSchema();
  if (!(amount > 0)) return { ok: false, error: 'Enter an amount.' };
  try {
    // THE CURRENCY IS PART OF THE TEST, not an assumption.
    //
    // The sums below used to run across EVERY row for the employee, so a wallet holding USD 1,000 and
    // INR 5,000 authorised a withdrawal of 6,000 in whichever currency the request happened to be
    // stamped with. Both the ledger sum and the pending sum are now confined to one currency, and the
    // row is written carrying that currency, so a request can only ever be measured against money of
    // the same kind.
    const bal = await getBalance(employeeId);
    const cur = bal.currency;
    const wrote = rows(await db.execute(sql`
      INSERT INTO hr_withdrawal (employee_id, amount, currency, bank_account_id, note)
      SELECT ${employeeId}::uuid, ${amount}, ${cur}, ${bankAccountId}, ${note || null}
       WHERE ${amount} <= (
         COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)
                     FROM hr_wallet_txn
                    WHERE employee_id = ${employeeId}::uuid
                      AND COALESCE(NULLIF(UPPER(currency), ''), 'INR') = ${cur}), 0)
         - COALESCE((SELECT SUM(amount) FROM hr_withdrawal
                      WHERE employee_id = ${employeeId}::uuid
                        AND status IN ('pending', 'approved', 'paying')
                        AND COALESCE(NULLIF(UPPER(currency), ''), 'INR') = ${cur}), 0)
       )
      RETURNING id`));
    if (wrote.length) {
      // =============================================================================================
      // NOBODY WAS ASKED FOR ANYTHING
      // =============================================================================================
      //
      // This function wrote the row and returned, and the screen told the employee "pending approval".
      // routeWithdrawals() — the function that creates the workflow instance and therefore fires
      // notifyApprover — was called only from a page load of /portal/employee/expenses or of
      // /admin/hr/payroll/claims. So the approver's inbox stayed empty, no push was sent, and the
      // request entered the chain only if the employee later happened to open a DIFFERENT page. Same
      // shape as the scheduler that POSTed to a route nobody had built.
      //
      // The sweep is idempotent (startWorkflow is unique on (domain, record_id)), so calling it here
      // costs one no-op for requests already routed. Imported dynamically: src/lib/expenses.ts
      // imports this module, and a static import back would be a load-time cycle.
      //
      // NEVER FAILS THE REQUEST. The row is written and the money is reserved against the balance
      // either way; a routing failure means an unrouted request that is still visible, not a lost one.
      const newId = String(wrote[0].id);
      try {
        const { routeWithdrawals } = await import('@/lib/expenses');
        // SCOPED TO THIS EMPLOYEE. The unscoped sweep reads up to a hundred rows across the company
        // on a page an employee just posted from; the request that needs routing is theirs.
        const results = await routeWithdrawals(employeeId);
        const mine = results.find((r) => r.id === newId);
        if (mine && mine.workflowState === 'halted') {
          // HALTED, NOT LOST. The request exists, nothing is auto-approved, and the reason is handed
          // back so the screen can say it rather than printing "pending approval" over the top of it.
          return { ok: true, halted: true, haltReason: mine.haltReason || 'No approver could be resolved from the organization graph.' };
        }
        if (!mine || !mine.workflowState) {
          return {
            ok: true,
            halted: true,
            haltReason: 'The approval chain could not be started, so nobody has been asked yet. '
              + 'Your request is recorded and HR can route it.',
          };
        }
      } catch (e: any) {
        console.error('[hr-wallet] withdrawal', newId, 'was filed but could not be sent for approval -', e?.cause?.message || e?.message);
        return {
          ok: true,
          halted: true,
          haltReason: 'Your request is recorded, but it could not be sent for approval just now. '
            + 'Tell HR if it is still waiting tomorrow.',
        };
      }
      return { ok: true };
    }

    {
      const fresh = await getBalance(employeeId);
      const money = (n: number) => (fresh.currency === 'INR' ? '₹' : fresh.currency + ' ') + n.toFixed(2);
      return {
        ok: false,
        error: 'Amount exceeds your available balance (' + money(fresh.available) + ').'
          + (fresh.pending > 0 ? ' ' + money(fresh.pending) + ' is already requested and not yet paid.' : '')
          + (fresh.otherCurrencies.length
            ? ' You also hold ' + fresh.otherCurrencies.map((o) => o.currency + ' ' + o.balance.toFixed(2)).join(', ')
              + ', which is a different currency and is not part of this balance.'
            : ''),
      };
    }
  } catch (e: any) {
    // NOT SWALLOWED. A request that was not written must never read as one that was.
    console.error('[hr-wallet] requestWithdrawal failed for employee', employeeId, '-', e?.cause?.message || e?.message);
    return { ok: false, error: 'That request could not be saved just now. Nothing was changed — try again in a moment.' };
  }
}
export async function listWithdrawals(opts: { employeeId?: string; status?: string } = {}): Promise<any[]> {
  await ensureWalletSchema();
  if (opts.employeeId) return safe(sql`SELECT * FROM hr_withdrawal WHERE employee_id = ${opts.employeeId} ORDER BY requested_at DESC LIMIT 50`);
  // admin: join employee name + bank
  return safe(sql`SELECT w.*, e.full_name, e.employee_code, e.designation, b.holder AS bank_holder, b.account_number AS bank_acc, b.ifsc, b.upi_id
    FROM hr_withdrawal w
    LEFT JOIN hr_employees e ON w.employee_id = e.id
    LEFT JOIN hr_bank_account b ON w.bank_account_id = b.id
    ${opts.status ? sql`WHERE w.status = ${opts.status}` : sql``}
    ORDER BY (w.status='pending') DESC, w.requested_at DESC LIMIT 100`);
}

// Approval permission: super-admin / admin / HR always; the employee's reporting
// manager (if the schema links one) also may approve. Returns the role label used.
/**
 * Withdrawal requests THIS person can actually decide.
 *
 * The counterpart to pendingLeaveForApprover(). listWithdrawals() answers "one employee's" or "all
 * with this status"; neither tells an approver what is waiting on them, so requests sit unanswered
 * while everyone assumes someone else is looking.
 *
 * Same authority as approverRole(), expressed in SQL: whoever holds `payouts.approve` sees every
 * pending request; everyone else sees only employees whose reporting_manager_id is their own USERS
 * id. decideWithdrawal() still re-checks through approverRole() — this decides what to show, never
 * what may be done.
 */
export async function pendingWithdrawalsForApprover(user: any): Promise<any[]> {
  if (!user?.id) return [];
  await ensureWalletSchema();

  // WAS `role === 'super_admin' || role === 'admin' || role === 'hr'`. Same people, asked as a
  // capability: PERMS_BY_ROLE grants payouts.approve to exactly super_admin and hr, and 'admin' is
  // not a value of userRoleEnum (src/lib/db/schema.ts:10-16) so that arm could never match an
  // account. can() reads the built-in matrix only — no database — so this answer survives an outage
  // and cannot be widened by a section-matrix row that merely spells 'payouts'.
  //
  // ASKED THROUGH THE SHARED PREDICATE. This is one of the four places that expressed "may decide
  // every request of this kind"; decidesEveryRequest() in src/lib/auth/capability.ts is now the only
  // expression of it, and approverRole() below — the enforcement — asks the same function.
  const seesAll = decidesEveryRequest(user, 'payouts.approve');

  try {
    if (seesAll) {
      return await safe(sql`
        SELECT w.*, e.full_name, e.employee_code
          FROM hr_withdrawal w
          LEFT JOIN hr_employees e ON e.id = w.employee_id
         WHERE w.status = 'pending'
         ORDER BY w.requested_at ASC
         LIMIT 120`);
    }
    return await safe(sql`
      SELECT w.*, e.full_name, e.employee_code
        FROM hr_withdrawal w
        JOIN hr_employees e ON e.id = w.employee_id
       WHERE w.status = 'pending'
         AND e.reporting_manager_id::text = ${String(user.id)}
       ORDER BY w.requested_at ASC
       LIMIT 120`);
  } catch (e: any) {
    console.error('[hr-wallet] pendingWithdrawalsForApprover', e?.cause?.message || e?.message);
    return [];
  }
}

export async function approverRole(
  user: any,
  employeeId: string,
  capability: ApprovalCapability,
): Promise<string | null> {
  if (!user) return null;

  // THE STANDING AUTHORITY, asked as a capability rather than spelled as a role.
  //
  // It was `role.indexOf('hr') >= 0` once, so ANY role whose name merely contained the letters "hr"
  // could approve leave and wallet withdrawals; then it was three exact role names. Both forms make
  // approval authority a property of a STRING. Now the question is "may this person approve", and
  // PERMS_BY_ROLE is the one place that answers it.
  //
  // IDENTICAL SET, NOT A WIDER ONE. can() consults the built-in matrix only — no database, no custom
  // roles — and leave.approve / payouts.approve are granted there to exactly super_admin and hr,
  // which is what the three name tests matched. The dropped `role === 'admin'` arm was dead: 'admin'
  // is not a value of userRoleEnum (src/lib/db/schema.ts:10-16), so no account could ever hold it.
  //
  // ONE EXPRESSION, FOUR READERS. pendingWithdrawalsForApprover(), pendingLeaveForApprover() and
  // workforce/composer.ts seesEveryRequest all ask decidesEveryRequest() too, so what a screen
  // OFFERS and what this function ALLOWS cannot answer differently. They already agreed; they now
  // cannot stop agreeing.
  if (decidesEveryRequest(user, capability)) {
    // decided_by_role is an audit column that both /admin/hr/leave and /admin/hr/wallet PRINT, and
    // rows written before this change say 'super_admin' or 'hr_head'. The labels are kept byte-for-
    // byte so the history stays readable and payWithdrawal's old narrowing means the same thing.
    // Reading user.role here decides only what the record is CALLED — never who may act.
    // HONEST LIMIT: a role granted this capability later would be recorded as 'hr_head'. Give it its
    // own label at that point; do not let the label decide anything.
    return String(user.role || '').toLowerCase() === 'super_admin' ? 'super_admin' : 'hr_head';
  }

  // The employee's own reporting manager may approve.
  //
  // KEPT EXACTLY AS IT WAS, and it must stay that way: this is a RELATIONSHIP to one employee, not a
  // role. The same manager may decide Ravi's request and not Priya's, which no role grant can say.
  // Granting leave.approve to a role "to cover managers" would hand every manager authority over
  // every employee — the widest policy change available in this file.
  //
  // This previously probed `reporting_manager_user_id` and `manager_user_id` — neither column
  // exists. The errors were swallowed by safe(), so the branch silently returned nothing every
  // time and a reporting manager could never approve anything. It also built the query by string
  // interpolation with a strip-the-quotes sanitiser, which is not a defence.
  //
  // The real column is hr_employees.reporting_manager_id, and it holds a USERS id. Parameterised.
  const r = await safe(sql`
    SELECT 1 FROM hr_employees
     WHERE id = ${employeeId}::uuid AND reporting_manager_id = ${user.id}::uuid
     LIMIT 1`);
  if (r.length) return 'reporting_manager';

  return null;
}

export async function decideWithdrawal(id: string, user: any, decision: 'approved' | 'rejected', note: string): Promise<{ ok: boolean; error?: string }> {
  await ensureWalletSchema();
  const w = (await safe(sql`SELECT * FROM hr_withdrawal WHERE id = ${id} LIMIT 1`))[0];
  if (!w) return { ok: false, error: 'Withdrawal not found.' };
  if (w.status !== 'pending') return { ok: false, error: 'Already ' + w.status + '.' };
  // THE ENFORCEMENT. The page gate decides what to SHOW; this decides what may be DONE, and it runs
  // on every posted decision including one whose id was typed into the form by hand.
  const role = await approverRole(user, w.employee_id, 'payouts.approve');
  if (!role) return { ok: false, error: 'You are not permitted to approve this withdrawal.' };
  // THE PRECONDITION IS RESTATED IN THE WRITE. Reading 'pending' and then updating unconditionally
  // means two decisions landing together both take effect and the second silently overwrites the
  // first — including an approval overwriting a rejection on a request for money.
  const decided = rows(await db.execute(sql`UPDATE hr_withdrawal SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role}, decided_at = NOW(), decision_note = ${note || null} WHERE id = ${id} AND status = 'pending' RETURNING id`));
  if (!decided.length) return { ok: false, error: 'That request was decided by somebody else while this page was open. Reload it.' };
  await hrAudit(user.id, 'hr.withdrawal.' + decision, String(id),
    { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, byRole: role, note: note || null });
  // THE PERSON WHOSE MONEY IT IS, TOLD.
  await notifyEmployeeOfMoney(String(w.employee_id), {
    type: 'withdrawal_decision',
    title: decision === 'approved' ? 'Withdrawal approved' : 'Withdrawal declined',
    body: (String(w.currency || 'INR') + ' ' + Number(w.amount).toLocaleString('en-IN'))
      + (decision === 'approved'
        ? ' is approved and waiting to be released.'
        : ' was not approved.')
      + (note ? ' ' + String(note).slice(0, 140) : ''),
    tag: 'withdrawal-' + String(id),
  });
  return { ok: true };
}

/**
 * RESOLVE A PAYOUT STUCK AT 'paying'.
 *
 * payWithdrawal() deliberately leaves a request at 'paying' when the gateway call throws without an
 * answer — a network error is not proof the payout did not happen, and an automatic retry there is
 * how somebody gets paid twice. That reasoning is right, and it had no exit. The request could not be
 * paid (payWithdrawal accepts only 'approved'), the admin console drew no button for it, and
 * getBalance() counts 'paying' as pending — so the employee could neither receive the money nor ask
 * for it again, indefinitely, and the only way out was a manual UPDATE on the production database.
 *
 * A HUMAN DECIDES, HAVING CHECKED THE PAYOUT CHANNEL. That is the whole point: this function does not
 * guess and does not call the gateway.
 *
 *   'paid'     the payout IS in the channel. The wallet debit is written idempotently (ref
 *              'withdrawal:<id>', which carries a UNIQUE index) so this can never double-debit, and
 *              the reference the operator read off the channel is recorded.
 *   'approved' the payout is NOT in the channel. The claim is released and it can be paid again
 *              deliberately.
 *
 * Same capability as releasing money in the first place — confirming a payout is a statement that
 * money left the company, so it is not a lesser act than sending it.
 */
export async function resolvePaying(
  id: string,
  user: any,
  outcome: 'paid' | 'approved',
  channelRef: string = '',
): Promise<{ ok: boolean; error?: string }> {
  await ensureWalletSchema();
  if (outcome !== 'paid' && outcome !== 'approved') return { ok: false, error: 'That is not an outcome we record.' };
  if (!holdsCapability(user, 'payouts.pay')) return { ok: false, error: 'Only HR/admin can settle a payout that is being released.' };

  const w = (await safe(sql`SELECT * FROM hr_withdrawal WHERE id = ${id} LIMIT 1`))[0];
  if (!w) return { ok: false, error: 'Not found.' };
  if (String(w.status) !== 'paying') {
    return { ok: false, error: 'That request is ' + String(w.status) + ', not being released. Nothing was changed.' };
  }
  const ref = String(channelRef || '').trim().slice(0, 200);
  if (outcome === 'paid' && !ref) {
    return {
      ok: false,
      error: 'Confirming a payout needs the reference you read off the payout channel. Nothing was '
        + 'changed — without it there is no way to tell later which instruction this was.',
    };
  }

  try {
    if (outcome === 'approved') {
      const back = rows(await db.execute(sql`
        UPDATE hr_withdrawal SET status = 'approved', paying_at = NULL, paying_by = NULL
         WHERE id = ${id} AND status = 'paying' RETURNING id`));
      if (!back.length) return { ok: false, error: 'That request changed while this page was open. Reload it.' };
      await hrAudit(user.id, 'hr.withdrawal.payout_not_found', String(id),
        { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, note: ref || null });
      return { ok: true };
    }

    // THE DEBIT FIRST, AND IDEMPOTENTLY. The unique index on hr_wallet_txn.ref means a repeat can only
    // ever collide with its own earlier row, so a confirmation that races payWithdrawal's own debit
    // cannot remove the money twice.
    const debitRef = 'withdrawal:' + String(id);
    try {
      await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, currency, kind, note, ref, created_by)
        VALUES (${w.employee_id}, 'debit', ${w.amount}, ${String(w.currency || 'INR').toUpperCase()}, 'withdrawal',
                ${'Withdrawal confirmed against the payout channel (' + ref + ')'}, ${debitRef}, ${user.id})`);
    } catch (e: any) {
      const real = String(e?.cause?.message || e?.message || '');
      if (!/duplicate key|unique constraint/i.test(real)) {
        // NOT SWALLOWED. The money has left and the ledger does not know.
        console.error('[hr-wallet] confirming payout', id, 'could not write the wallet debit -', real);
        return {
          ok: false,
          error: 'The wallet could not be debited, so nothing was confirmed and the request is still '
            + 'being released. (' + (real || 'database error') + ')',
        };
      }
    }

    const done = rows(await db.execute(sql`
      UPDATE hr_withdrawal SET status = 'paid', payout_ref = ${ref}, paid_at = NOW()
       WHERE id = ${id} AND status = 'paying' RETURNING id`));
    if (!done.length) return { ok: false, error: 'That request changed while this page was open. Reload it.' };

    await hrAudit(user.id, 'hr.withdrawal.payout_confirmed', String(id),
      { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, payoutRef: ref });
    await notifyEmployeeOfMoney(String(w.employee_id), {
      type: 'withdrawal_paid',
      title: 'Withdrawal paid',
      body: String(w.currency || 'INR') + ' ' + Number(w.amount).toLocaleString('en-IN')
        + ' has left for your bank account. Reference ' + ref + '.',
      tag: 'withdrawal-' + String(id),
    });
    return { ok: true };
  } catch (e: any) {
    console.error('[hr-wallet] resolvePaying failed for withdrawal', id, '-', e?.cause?.message || e?.message);
    return { ok: false, error: 'That could not be recorded just now. Nothing was changed.' };
  }
}

/** Money decisions leave a trail. Nothing under /admin/hr wrote to audit_log before this. */
export async function hrAudit(userId: string, action: string, entityId: string, diff: Record<string, unknown>): Promise<void> {
  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: String(userId), action, entity: 'hr_wallet', entityId, diff });
  } catch (_) { /* auditing must never block the decision it records */ }
}

// Pay out an approved withdrawal via Razorpay (RazorpayX Payouts) if configured;
// otherwise record a manual settlement reference. Debits the wallet on success.
export async function payWithdrawal(id: string, user: any, manualRef?: string): Promise<{ ok: boolean; error?: string; ref?: string }> {
  await ensureWalletSchema();
  const w = (await safe(sql`SELECT w.*, b.account_number, b.ifsc, b.holder, b.upi_id FROM hr_withdrawal w LEFT JOIN hr_bank_account b ON w.bank_account_id = b.id WHERE w.id = ${id} LIMIT 1`))[0];
  if (!w) return { ok: false, error: 'Not found.' };
  if (w.status !== 'approved') return { ok: false, error: 'Only approved withdrawals can be paid.' };

  // RELEASING MONEY IS ITS OWN POWER. This was `approverRole()` followed by throwing away three of
  // its four answers — `role !== 'admin' && role !== 'super_admin' && role !== 'hr_head'` — which is
  // a long way of saying "approving is not releasing": a reporting manager may APPROVE a withdrawal
  // and may NOT send the money. That distinction now has a name, so it can be read at a glance and
  // granted deliberately, and the row-level reporting-manager lookup no longer runs only to have its
  // answer discarded.
  //
  // IDENTICAL SET. payouts.pay is granted in PERMS_BY_ROLE to exactly super_admin and hr — the two
  // roles approverRole() answered 'super_admin' and 'hr_head' for. The 'admin' arm was dead ('admin'
  // is not a value of userRoleEnum), and 'reporting_manager' was refused before and is refused now.
  if (!holdsCapability(user, 'payouts.pay')) return { ok: false, error: 'Only HR/admin can release a payout.' };

  // ---- CLAIM THE REQUEST BEFORE ANY MONEY MOVES ---------------------------------------------------
  //
  // This function used to read status='approved', call RazorpayX, and THEN update the row. Two people
  // pressing Release in the same second — or one person double-submitting a form on a slow phone —
  // both read 'approved', both sent a payout instruction to the bank, and the employee was paid
  // TWICE with two debit rows to match. Nothing on any screen said so.
  //
  // The claim below is a single conditional UPDATE, so exactly one caller can move a request out of
  // 'approved'. The loser is told plainly. 'paying' is a real state that means "handed to the payout
  // channel, not yet confirmed": it is counted as pending against the balance, and if a process dies
  // between the claim and the bank's answer the row STAYS 'paying' rather than being retried
  // automatically — an automatic retry there is how a payout gets sent a second time.
  const claimed = rows(await db.execute(sql`
    UPDATE hr_withdrawal SET status = 'paying', paying_at = NOW(), paying_by = ${user.id}::uuid
     WHERE id = ${id} AND status = 'approved' RETURNING id`));
  if (!claimed.length) {
    return { ok: false, error: 'That payout is already being released, or has been released. Reload the page before trying again.' };
  }
  /** Put the request back where it was, so a failed payout can be retried deliberately. */
  const releaseClaim = async (why: string) => {
    try {
      await db.execute(sql`UPDATE hr_withdrawal SET status = 'approved', paying_at = NULL, paying_by = NULL WHERE id = ${id} AND status = 'paying'`);
    } catch (e: any) {
      console.error('[hr-wallet] payout', id, 'failed (' + why + ') AND the request could not be put back to approved — it is stuck at "paying":', e?.cause?.message || e?.message);
    }
  };

  let ref = manualRef || null, paidVia = 'manual';
  const KEY = process.env.RAZORPAY_KEY_ID, SEC = process.env.RAZORPAY_KEY_SECRET, ACC = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  if (!manualRef && KEY && SEC && ACC && w.account_number) {
    try {
      const auth = 'Basic ' + Buffer.from(KEY + ':' + SEC).toString('base64');
      const res = await fetch('https://api.razorpay.com/v1/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ account_number: ACC, amount: Math.round(Number(w.amount) * 100), currency: w.currency || 'INR', mode: 'IMPS', purpose: 'payout',
          fund_account: { account_type: 'bank_account', bank_account: { name: w.holder, ifsc: w.ifsc, account_number: w.account_number } },
          queue_if_low_balance: true, narration: 'Salary withdrawal' }),
      });
      const j: any = await res.json();
      if (!res.ok) {
        await releaseClaim('gateway refused');
        return { ok: false, error: 'Razorpay: ' + (j?.error?.description || res.status) };
      }
      ref = j.id; paidVia = 'razorpayx';
    } catch (e: any) {
      // A NETWORK ERROR IS NOT PROOF THE PAYOUT DID NOT HAPPEN. The instruction may have reached the
      // bank; the answer did not reach us. So the request is left at 'paying' for a human to check
      // against the payout channel rather than put back where a second press would resend it.
      console.error('[hr-wallet] payout request to RazorpayX did not return for withdrawal', id, '-', e?.cause?.message || e?.message);
      return {
        ok: false,
        error: 'The payout instruction was sent but no confirmation came back, so this request is held at '
          + '"being released". Check the payout channel for the reference before releasing it again — '
          + 'pressing again could pay twice.',
      };
    }
  }

  // THE DEBIT REF IS THE WITHDRAWAL, NOT THE GATEWAY'S ID. hr_wallet_txn.ref carries a UNIQUE index,
  // so keying the debit on this request makes the ledger write idempotent by construction: a repeat
  // can only ever collide with its own earlier row. It was the payout reference before, which is
  // neither unique across manual entries (two payouts typed with the same UTR collide and the second
  // debit is LOST while the request still says paid) nor present at all when none is given.
  const debitRef = 'withdrawal:' + String(id);
  try {
    // THE DEBIT CARRIES THE REQUEST'S CURRENCY. It omitted the column before, so every debit defaulted
    // to INR — and a USD withdrawal removed USD from the bank while subtracting rupees from the
    // ledger, leaving the USD balance untouched and withdrawable a second time.
    await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, currency, kind, note, ref, created_by)
      VALUES (${w.employee_id}, 'debit', ${w.amount}, ${String(w.currency || 'INR').toUpperCase()}, 'withdrawal', ${'Withdrawal via ' + paidVia + (ref ? ' (' + ref + ')' : '')}, ${debitRef}, ${user.id})`);
  } catch (e: any) {
    const real = String(e?.cause?.message || e?.message || '');
    if (!/duplicate key|unique constraint/i.test(real)) {
      // THE MONEY HAS LEFT AND THE LEDGER DOES NOT KNOW. Not swallowed: the request is marked paid so
      // nobody releases it a second time, and the caller is told the balance is now wrong.
      console.error('[hr-wallet] payout', id, 'was released but the wallet debit FAILED -', real);
      await db.execute(sql`UPDATE hr_withdrawal SET status = 'paid', payout_ref = ${ref}, paid_at = NOW() WHERE id = ${id} AND status = 'paying'`).catch(() => {});
      await hrAudit(user.id, 'hr.withdrawal.paid_debit_failed', String(id),
        { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, paidVia, payoutRef: ref, error: real });
      return {
        ok: false,
        error: 'The payout was released but the wallet was NOT debited, so the balance now reads higher '
          + 'than it is. Do not release it again — record the correction by hand. (' + (real || 'database error') + ')',
      };
    }
  }

  await db.execute(sql`UPDATE hr_withdrawal SET status = 'paid', payout_ref = ${ref}, paid_at = NOW() WHERE id = ${id} AND status = 'paying'`);
  await hrAudit(user.id, 'hr.withdrawal.paid', String(id),
    { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, paidVia, payoutRef: ref });
  // THE MONEY LEFT AND THE PERSON IS TOLD. Nothing announced this before, in any path.
  await notifyEmployeeOfMoney(String(w.employee_id), {
    type: 'withdrawal_paid',
    title: 'Withdrawal paid',
    body: String(w.currency || 'INR') + ' ' + Number(w.amount).toLocaleString('en-IN')
      + ' has left for your bank account.' + (ref ? ' Reference ' + ref + '.' : ''),
    tag: 'withdrawal-' + String(id),
  });
  return { ok: true, ref: ref || undefined };
}
