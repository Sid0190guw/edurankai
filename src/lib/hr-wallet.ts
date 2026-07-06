// HRMS wallet + payouts. Salary is disbursed into an employee wallet (a
// double-entry ledger); the employee connects a bank account; withdrawals are
// requested by the employee and must be approved by their reporting manager, an
// HR head, an admin or a super-admin before being paid out via Razorpay (RazorpayX
// Payouts). Self-bootstrapping schema — consistent with the rest of the app.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function safe(q: any): Promise<any[]> { try { return rows(await db.execute(q)); } catch { return []; } }

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
export async function approverRole(user: any, employeeId: string): Promise<string | null> {
  if (!user) return null;
  const role = (user.role || '').toLowerCase();
  if (role === 'super_admin') return 'super_admin';
  if (role === 'admin') return 'admin';
  if (role.indexOf('hr') >= 0) return 'hr_head';
  // reporting manager link (guarded — column names vary)
  for (const col of ['reporting_manager_user_id', 'manager_user_id']) {
    const r = (await safe(sql.raw(`SELECT 1 FROM hr_employees WHERE id = '${employeeId.replace(/'/g, "")}' AND ${col} = '${(user.id || '').replace(/'/g, "")}' LIMIT 1`)));
    if (r.length) return 'reporting_manager';
  }
  return null;
}

export async function decideWithdrawal(id: string, user: any, decision: 'approved' | 'rejected', note: string): Promise<{ ok: boolean; error?: string }> {
  await ensureWalletSchema();
  const w = (await safe(sql`SELECT * FROM hr_withdrawal WHERE id = ${id} LIMIT 1`))[0];
  if (!w) return { ok: false, error: 'Withdrawal not found.' };
  if (w.status !== 'pending') return { ok: false, error: 'Already ' + w.status + '.' };
  const role = await approverRole(user, w.employee_id);
  if (!role) return { ok: false, error: 'You are not permitted to approve this withdrawal.' };
  await db.execute(sql`UPDATE hr_withdrawal SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role}, decided_at = NOW(), decision_note = ${note || null} WHERE id = ${id}`);
  return { ok: true };
}

// Pay out an approved withdrawal via Razorpay (RazorpayX Payouts) if configured;
// otherwise record a manual settlement reference. Debits the wallet on success.
export async function payWithdrawal(id: string, user: any, manualRef?: string): Promise<{ ok: boolean; error?: string; ref?: string }> {
  await ensureWalletSchema();
  const w = (await safe(sql`SELECT w.*, b.account_number, b.ifsc, b.holder, b.upi_id FROM hr_withdrawal w LEFT JOIN hr_bank_account b ON w.bank_account_id = b.id WHERE w.id = ${id} LIMIT 1`))[0];
  if (!w) return { ok: false, error: 'Not found.' };
  if (w.status !== 'approved') return { ok: false, error: 'Only approved withdrawals can be paid.' };
  const role = await approverRole(user, w.employee_id);
  if (!role || (role !== 'admin' && role !== 'super_admin' && role !== 'hr_head')) return { ok: false, error: 'Only HR/admin can release a payout.' };

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
  return { ok: true, ref: ref || undefined };
}
