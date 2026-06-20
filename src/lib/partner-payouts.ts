// Partner payout workflow: partners request payouts against their accrued
// revenue share; super-admins approve / mark paid / reject. Self-bootstrapping
// table so it works without a manual migration.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export function ensurePayoutSchema(): Promise<void> {
  return ensureOnce('partner_payouts', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS partner_payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_user_id UUID NOT NULL,
      amount_paise BIGINT NOT NULL,
      method VARCHAR(40),
      details TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'requested',
      note TEXT,
      paid_ref TEXT,
      decided_by UUID,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS partner_payouts_user_idx ON partner_payouts(partner_user_id, requested_at DESC)`);
  });
}

export interface PayoutSummary { earned: number; paid: number; pending: number; available: number; }

// earned = lifetime accrued share (paise). locked = anything requested/approved/paid.
export async function getPayoutSummary(userId: string, earnedPaise: number): Promise<PayoutSummary> {
  await ensurePayoutSchema();
  const r = rows(await db.execute(sql`
    SELECT
      COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS paid,
      COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('requested','approved')), 0)::bigint AS pending
    FROM partner_payouts WHERE partner_user_id = ${userId}
  `).catch(() => [] as any))[0] || { paid: 0, pending: 0 };
  const paid = Number(r.paid) || 0;
  const pending = Number(r.pending) || 0;
  const available = Math.max(0, (Number(earnedPaise) || 0) - paid - pending);
  return { earned: Number(earnedPaise) || 0, paid, pending, available };
}

export async function listPayouts(userId: string): Promise<any[]> {
  await ensurePayoutSchema();
  return rows(await db.execute(sql`
    SELECT id, amount_paise, method, details, status, note, paid_ref, requested_at, decided_at
    FROM partner_payouts WHERE partner_user_id = ${userId}
    ORDER BY requested_at DESC LIMIT 100
  `).catch(() => [] as any));
}

export async function requestPayout(userId: string, amountPaise: number, method: string, details: string): Promise<{ ok: boolean; error?: string }> {
  await ensurePayoutSchema();
  const amt = Math.round(Number(amountPaise) || 0);
  if (amt < 10000) return { ok: false, error: 'Minimum payout is Rs 100.' }; // 10000 paise
  try {
    await db.execute(sql`
      INSERT INTO partner_payouts (partner_user_id, amount_paise, method, details, status)
      VALUES (${userId}, ${amt}, ${(method || 'bank').slice(0, 40)}, ${(details || '').slice(0, 2000)}, 'requested')
    `);
    return { ok: true };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; }
}

export async function listAllPayouts(status?: string): Promise<any[]> {
  await ensurePayoutSchema();
  const filt = status && status !== 'all' ? sql`WHERE p.status = ${status}` : sql``;
  return rows(await db.execute(sql`
    SELECT p.id, p.partner_user_id, p.amount_paise, p.method, p.details, p.status, p.note, p.paid_ref,
           p.requested_at, p.decided_at, u.name AS partner_name, u.email AS partner_email
    FROM partner_payouts p
    LEFT JOIN users u ON u.id = p.partner_user_id
    ${filt}
    ORDER BY (p.status = 'requested') DESC, p.requested_at DESC LIMIT 300
  `).catch(() => [] as any));
}

export async function decidePayout(id: string, status: 'approved' | 'paid' | 'rejected', adminId: string, note?: string, paidRef?: string): Promise<{ ok: boolean; error?: string; partnerUserId?: string; amountPaise?: number }> {
  await ensurePayoutSchema();
  try {
    const r = rows(await db.execute(sql`
      UPDATE partner_payouts
      SET status = ${status}, decided_by = ${adminId}, decided_at = NOW(),
          note = COALESCE(${note || null}, note), paid_ref = COALESCE(${paidRef || null}, paid_ref)
      WHERE id = ${id}
      RETURNING partner_user_id, amount_paise
    `));
    return { ok: true, partnerUserId: r[0]?.partner_user_id, amountPaise: Number(r[0]?.amount_paise) || 0 };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; }
}

export async function payoutTotals(): Promise<{ requested: number; pendingAmt: number; paidAmt: number }> {
  await ensurePayoutSchema();
  const r = rows(await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'requested')::int AS requested,
      COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('requested','approved')), 0)::bigint AS pending_amt,
      COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS paid_amt
    FROM partner_payouts
  `).catch(() => [] as any))[0] || { requested: 0, pending_amt: 0, paid_amt: 0 };
  return { requested: Number(r.requested) || 0, pendingAmt: Number(r.pending_amt) || 0, paidAmt: Number(r.paid_amt) || 0 };
}
