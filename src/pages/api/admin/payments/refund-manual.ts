// POST /api/admin/payments/refund-manual
// Body: { paymentRowId, reason, amountPaise? }
// Marks a payment row as refunded in our books WITHOUT calling Razorpay.
// Use when: refund was processed offline (bank transfer), Razorpay refund
// window has lapsed, or the Razorpay API is rejecting the refund and the
// money was returned through another channel. Audit-logged.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const paymentRowId = (body.paymentRowId || '').toString().trim();
  const reason = (body.reason || '').toString().trim().slice(0, 500);
  const amountPaise = body.amountPaise != null ? Number(body.amountPaise) : undefined;
  if (!paymentRowId) return json({ ok: false, error: 'paymentRowId required' }, 400);
  if (!reason || reason.length < 10) return json({ ok: false, error: 'reason required (min 10 chars) — this is a manual refund without API verification' }, 400);

  const pay = rows(await db.execute(sql`SELECT id, amount, status FROM payments WHERE id = ${paymentRowId} LIMIT 1`))[0] as any;
  if (!pay) return json({ ok: false, error: 'payment not found' }, 404);
  if (pay.status === 'refunded') return json({ ok: false, error: 'already refunded' }, 409);

  try {
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id VARCHAR(64)`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount BIGINT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_mode VARCHAR(20)`);
  } catch (_) {}

  const refundAmount = (amountPaise && amountPaise > 0) ? amountPaise : pay.amount;
  const newStatus = refundAmount < pay.amount ? 'partially_refunded' : 'refunded';

  await db.execute(sql`
    UPDATE payments
    SET status = ${newStatus},
        refund_id = ${'MANUAL-' + Date.now()},
        refund_amount = ${refundAmount},
        refunded_at = NOW(),
        refund_reason = ${'[MANUAL] ' + reason},
        refunded_by_user_id = ${user.id},
        refund_mode = 'manual'
    WHERE id = ${paymentRowId}
  `);

  try {
    await logAudit({
      userId: user.id,
      action: 'payment.refund_manual',
      entity: 'payment',
      entityId: paymentRowId,
      diff: { amount: refundAmount, reason, mode: 'manual', warning: 'No Razorpay API call — accounting-only entry' },
      ipAddress: clientAddress,
    });
  } catch (_) {}

  return json({ ok: true, refundId: 'MANUAL-' + Date.now(), amount: refundAmount, mode: 'manual' });
};
