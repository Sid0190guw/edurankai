// HRMS wallet + payouts. Salary is disbursed into an employee wallet (a
// double-entry ledger); the employee connects a bank account; withdrawals are
// requested by the employee and must be approved by someone who holds
// `payouts.approve` — or by that employee's own reporting manager — before being
// released by someone who holds `payouts.pay` via Razorpay (RazorpayX Payouts).
// Self-bootstrapping schema — consistent with the rest of the app.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can, type Permission } from '@/lib/auth/permissions';
import type { User } from '@/lib/db/schema';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function safe(q: any): Promise<any[]> { try { return rows(await db.execute(q)); } catch { return []; } }

/**
 * The standing authority approverRole() is asked about. Named as a type so a caller cannot pass
 * `'leave.edit'` or a hand-typed string that nothing grants: inventing a permission string outside
 * the Permission union is what made an entire console unreachable for every role on this project.
 *
 * Two members, because approving time off and approving money are two different powers held by the
 * same people today. Asking with the wrong one would be silently correct right now and silently
 * wrong the day either grant moves — so each caller names its own.
 */
export type ApprovalCapability = Extract<Permission, 'leave.approve' | 'payouts.approve'>;

/**
 * Does this account hold a capability? The only way these two engines may ask about authority.
 *
 * `can()` — the pure, database-free test over PERMS_BY_ROLE — and deliberately NOT the registry's
 * resolvePermissions(): the registry adds the super_admin WILDCARD and every custom-role grant, so
 * asking IT would admit any admin-created role that had been handed the key. The role tests replaced
 * here admitted exactly two built-in roles. This is a mechanism change and must not move the policy.
 *
 * `key` is typed `Permission`, so a string that is not in the union fails to COMPILE. An invented key
 * answers false for every role INCLUDING super_admin, which is how a whole console became unreachable
 * on this project once already.
 *
 * TWO ADAPTATIONS, both there to preserve exactly what the role comparisons did:
 *   - the role is trimmed and lowercased, because every test replaced here read
 *     `String(user.role || '').toLowerCase()`;
 *   - `isActive` is read as "not explicitly false". can() denies an inactive account and the old
 *     tests looked at the role alone. The difference is unreachable through the three call paths
 *     that exist — all pass Astro.locals.user, and validateSessionToken() deletes the session of a
 *     deactivated account (src/lib/auth/session.ts:59-62) — but these functions take `user: any`,
 *     and a caller handing over a narrower object must not lose authority to a field it never
 *     carried.
 *
 * Twin of holdsCapability() in src/lib/auth/workspace-access.ts, which makes the same two adaptations
 * for the workspace gates. Kept separate rather than imported so the HR money path has no dependency
 * on the workspace module; if they are ever consolidated, consolidate them deliberately and together.
 */
export function holdsHrCapability(user: any, key: Permission): boolean {
  if (!user) return false;
  return can(
    { role: String(user.role || '').trim().toLowerCase(), isActive: user.isActive !== false } as unknown as User,
    key,
  );
}

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
    } catch (_) { ready = null; }
  })();
  return ready;
}

export interface Balance { balance: number; currency: string; pending: number; available: number; }
export async function getBalance(employeeId: string): Promise<Balance> {
  await ensureWalletSchema();
  const r = (await safe(sql`SELECT
      COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0)::float AS bal
    FROM hr_wallet_txn WHERE employee_id = ${employeeId}`))[0] || {};
  const pend = (await safe(sql`SELECT COALESCE(SUM(amount),0)::float AS p FROM hr_withdrawal WHERE employee_id = ${employeeId} AND status IN ('pending','approved')`))[0] || {};
  const balance = Number(r.bal || 0), pending = Number(pend.p || 0);
  return { balance, currency: 'INR', pending, available: Math.max(0, balance - pending) };
}
export async function listTxns(employeeId: string, limit = 30): Promise<any[]> {
  await ensureWalletSchema();
  return safe(sql`SELECT direction, amount, currency, kind, note, created_at FROM hr_wallet_txn WHERE employee_id = ${employeeId} ORDER BY created_at DESC LIMIT ${limit}`);
}
export async function credit(employeeId: string, amount: number, kind: string, note: string, createdBy: string | null, ref?: string): Promise<void> {
  await ensureWalletSchema();
  if (!(amount > 0)) return;
  await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, kind, note, ref, created_by)
    VALUES (${employeeId}, 'credit', ${amount}, ${kind}, ${note || null}, ${ref || null}, ${createdBy})`);
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
 */
export async function creditPayrollRun(runId: string, byUserId: string | null): Promise<{ credited: number; skipped: number; total: number }> {
  await ensureWalletSchema();
  const slips = await safe(sql`
    SELECT ps.id, ps.employee_id, ps.net_salary, ps.currency, pr.month, pr.year
    FROM hr_payslips ps JOIN hr_payroll_runs pr ON ps.payroll_run_id = pr.id
    WHERE ps.payroll_run_id = ${runId}`);

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  let credited = 0, skipped = 0, total = 0;

  for (const s of slips) {
    const amount = Number(s.net_salary || 0);
    if (!(amount > 0) || !s.employee_id) { skipped++; continue; }
    const ref = 'payslip:' + s.id;
    const dupe = await safe(sql`SELECT id FROM hr_wallet_txn WHERE ref = ${ref} LIMIT 1`);
    if (dupe.length) { skipped++; continue; }
    const period = (MONTHS[(Number(s.month) || 1) - 1] || '') + ' ' + (s.year || '');
    try {
      await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, currency, kind, note, ref, created_by)
        VALUES (${s.employee_id}, 'credit', ${amount}, ${s.currency || 'INR'}, 'salary',
                ${'Salary for ' + period.trim()}, ${ref}, ${byUserId})`);
      credited++; total += amount;
    } catch { skipped++; }
  }
  return { credited, skipped, total };
}

export async function listBankAccounts(employeeId: string): Promise<any[]> {
  await ensureWalletSchema();
  return (await safe(sql`SELECT id, holder, account_number, ifsc, bank_name, upi_id, is_primary, verified FROM hr_bank_account WHERE employee_id = ${employeeId} ORDER BY is_primary DESC, created_at DESC`))
    .map((r) => ({ ...r, account_masked: mask(r.account_number) }));
}
export async function addBankAccount(employeeId: string, f: { holder: string; account_number: string; ifsc: string; bank_name?: string; upi_id?: string }): Promise<void> {
  await ensureWalletSchema();
  await db.execute(sql`UPDATE hr_bank_account SET is_primary = false WHERE employee_id = ${employeeId}`).catch(() => {});
  await db.execute(sql`INSERT INTO hr_bank_account (employee_id, holder, account_number, ifsc, bank_name, upi_id, is_primary)
    VALUES (${employeeId}, ${f.holder.slice(0, 120)}, ${(f.account_number || '').replace(/\s/g, '').slice(0, 30)}, ${(f.ifsc || '').toUpperCase().slice(0, 15)}, ${(f.bank_name || '').slice(0, 120)}, ${(f.upi_id || '').slice(0, 80)}, true)`);
}

// ---- withdrawals ----
export async function requestWithdrawal(employeeId: string, amount: number, bankAccountId: string | null, note: string): Promise<{ ok: boolean; error?: string }> {
  await ensureWalletSchema();
  const bal = await getBalance(employeeId);
  if (!(amount > 0)) return { ok: false, error: 'Enter an amount.' };
  if (amount > bal.available) return { ok: false, error: 'Amount exceeds your available balance (₹' + bal.available.toFixed(2) + ').' };
  await db.execute(sql`INSERT INTO hr_withdrawal (employee_id, amount, bank_account_id, note) VALUES (${employeeId}, ${amount}, ${bankAccountId}, ${note || null})`);
  return { ok: true };
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
  const seesAll = holdsHrCapability(user, 'payouts.approve');

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
  if (holdsHrCapability(user, capability)) {
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
  await db.execute(sql`UPDATE hr_withdrawal SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role}, decided_at = NOW(), decision_note = ${note || null} WHERE id = ${id}`);
  await hrAudit(user.id, 'hr.withdrawal.' + decision, String(id),
    { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, byRole: role, note: note || null });
  return { ok: true };
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
  if (!holdsHrCapability(user, 'payouts.pay')) return { ok: false, error: 'Only HR/admin can release a payout.' };

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
      if (!res.ok) return { ok: false, error: 'Razorpay: ' + (j?.error?.description || res.status) };
      ref = j.id; paidVia = 'razorpayx';
    } catch (e: any) { return { ok: false, error: 'Payout failed: ' + (e?.message || 'network') }; }
  }
  await db.execute(sql`UPDATE hr_withdrawal SET status = 'paid', payout_ref = ${ref}, paid_at = NOW() WHERE id = ${id}`);
  await db.execute(sql`INSERT INTO hr_wallet_txn (employee_id, direction, amount, kind, note, ref, created_by)
    VALUES (${w.employee_id}, 'debit', ${w.amount}, 'withdrawal', ${'Withdrawal via ' + paidVia}, ${ref}, ${user.id})`);
  await hrAudit(user.id, 'hr.withdrawal.paid', String(id),
    { employeeId: w.employee_id, amount: Number(w.amount), currency: w.currency, paidVia, payoutRef: ref });
  return { ok: true, ref: ref || undefined };
}
