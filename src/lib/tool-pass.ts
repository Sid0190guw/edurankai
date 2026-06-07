// 1 CHF day-pass for /portal/tools. A simple credit-style row: each pass
// unlocks the toolset for 24 hours. Razorpay is the gateway; webhook flips
// status to active. Self-bootstrapping schema.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;
export function ensureToolPassSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tool_day_passes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        candidate_email VARCHAR(200),
        amount_chf DECIMAL(10,2) NOT NULL DEFAULT 1.00,
        razorpay_order_id VARCHAR(120),
        razorpay_payment_id VARCHAR(120),
        razorpay_signature VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
          -- pending | active | expired | refunded
        activated_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tdp_user_idx ON tool_day_passes(user_id, status, expires_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

export async function hasActivePass(userId: string): Promise<boolean> {
  await ensureToolPassSchema();
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM tool_day_passes
      WHERE user_id = ${userId} AND status = 'active' AND expires_at > NOW()
      LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    return rows.length > 0;
  } catch (_) { return false; }
}

export async function activatePass(opts: { userId: string; orderId?: string; paymentId?: string; signature?: string }) {
  await ensureToolPassSchema();
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await db.execute(sql`
    INSERT INTO tool_day_passes (user_id, razorpay_order_id, razorpay_payment_id, razorpay_signature,
      status, activated_at, expires_at)
    VALUES (${opts.userId}, ${opts.orderId || null}, ${opts.paymentId || null}, ${opts.signature || null},
      'active', NOW(), ${expires}::timestamptz)
  `);
}
