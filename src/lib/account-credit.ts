// Universal account credit (a wallet). Admins grant credit to a user; it can
// be spent on ANY paid flow in ANY product (application fee, tests, tool pass,
// event fees, registration, ...). At checkout, an endpoint calls
// coverWithCredit() BEFORE creating a Razorpay order: if the balance covers the
// amount, we debit the wallet, write a 'paid' payments row, and run the same
// downstream effects as a real payment - no card charge.
//
// A redeemed fee-waiver coupon can also top up this wallet, so "granting a
// coupon" gives spendable credit everywhere. Self-bootstrapping schema.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export function ensureCreditSchema(): Promise<void> {
  return ensureOnce('account_credit_ledger', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS account_credit_ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      delta_paise BIGINT NOT NULL,
      reason TEXT,
      ref_type VARCHAR(40),
      ref_id TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS acl_user_idx ON account_credit_ledger(user_id, created_at DESC)`);
  });
}

export async function getCreditBalance(userId: string): Promise<number> {
  if (!userId) return 0;
  await ensureCreditSchema();
  const r = rows(await db.execute(sql`SELECT COALESCE(SUM(delta_paise), 0)::bigint AS bal FROM account_credit_ledger WHERE user_id = ${userId}`).catch(() => [] as any))[0] as any;
  return Number(r?.bal) || 0;
}

export async function getCreditLedger(userId: string, limit = 100): Promise<any[]> {
  await ensureCreditSchema();
  return rows(await db.execute(sql`
    SELECT delta_paise, reason, ref_type, ref_id, created_at
    FROM account_credit_ledger WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}
  `).catch(() => [] as any));
}

export async function grantCredit(userId: string, amountPaise: number, reason: string, byUserId?: string): Promise<{ ok: boolean; error?: string; balance?: number }> {
  await ensureCreditSchema();
  const amt = Math.round(Number(amountPaise) || 0);
  if (amt === 0) return { ok: false, error: 'amount required' };
  try {
    await db.execute(sql`
      INSERT INTO account_credit_ledger (user_id, delta_paise, reason, ref_type, created_by)
      VALUES (${userId}, ${amt}, ${(reason || 'admin grant').slice(0, 300)}, 'grant', ${byUserId || null})
    `);
    return { ok: true, balance: await getCreditBalance(userId) };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; }
}

// Try to pay for something entirely from wallet credit. Returns covered:false
// if the balance is insufficient (caller then falls back to a Razorpay order).
export async function coverWithCredit(opts: {
  userId: string;
  amountPaise: number;
  purpose: string;
  referenceType: string;
  referenceId: string;
  email?: string;
  label?: string;
}): Promise<{ covered: boolean; applicationId?: string; error?: string }> {
  const { userId, amountPaise, purpose, referenceType, referenceId } = opts;
  if (!userId || !referenceId || !amountPaise) return { covered: false };
  await ensureCreditSchema();
  const bal = await getCreditBalance(userId);
  if (bal < amountPaise) return { covered: false };

  // Synthetic order id so the existing payments + effects machinery works.
  const orderId = 'CREDIT-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  try {
    // Debit the wallet first.
    await db.execute(sql`
      INSERT INTO account_credit_ledger (user_id, delta_paise, reason, ref_type, ref_id)
      VALUES (${userId}, ${-Math.round(amountPaise)}, ${'Paid with credit: ' + (opts.label || purpose)}, ${referenceType}, ${referenceId})
    `);
    // Record a paid payments row.
    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
      VALUES (${orderId}, ${Math.round(amountPaise)}, 'INR', 'paid', ${purpose}, ${referenceType}, ${referenceId}, ${userId},
        ${opts.email || 'credit@edurankai.in'}, ${sql.raw("'" + JSON.stringify({ credit: true }).replace(/'/g, "''") + "'::jsonb")})
    `).catch(() => {});
    // Run the same downstream effects as a real capture (materialise app, mark fee paid, etc.).
    const { applyPaidEffects } = await import('@/lib/payment-effects');
    const r = await applyPaidEffects(orderId, 'credit');
    return { covered: true, applicationId: (r && (r as any).applicationId) || undefined };
  } catch (e: any) {
    return { covered: false, error: String(e?.message || e).slice(0, 160) };
  }
}
