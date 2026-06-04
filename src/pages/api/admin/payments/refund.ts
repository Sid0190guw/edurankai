// POST /api/admin/payments/refund
// Body: { paymentRowId, amountPaise?, reason? }
// Issues a refund via Razorpay. Full refund if amountPaise is omitted.
// Marks the payments row + records the refund metadata + writes an audit log.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { refundPayment } from '@/lib/razorpay';
import { logAudit } from '@/lib/audit';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const paymentRowId = (body.paymentRowId || '').toString().trim();
  const reason = (body.reason || '').toString().trim().slice(0, 500) || null;
  const amountPaise = body.amountPaise != null ? Number(body.amountPaise) : undefined;
  if (!paymentRowId) return json({ ok: false, error: 'paymentRowId required' }, 400);

  // Load the payment row + its razorpay_payment_id
  const pay = rows(await db.execute(sql`
    SELECT id, razorpay_payment_id, status, amount, currency, reference_type, reference_id
    FROM payments WHERE id = ${paymentRowId} LIMIT 1
  `))[0] as any;
  if (!pay) return json({ ok: false, error: 'payment not found' }, 404);
  if (!pay.razorpay_payment_id) return json({ ok: false, error: 'this payment has no razorpay_payment_id (was not captured via Razorpay)' }, 400);
  if (pay.status === 'refunded') return json({ ok: false, error: 'already refunded' }, 409);

  const result = await refundPayment({
    paymentId: pay.razorpay_payment_id,
    amountPaise: amountPaise && amountPaise > 0 ? amountPaise : undefined,
    notes: { reason: reason || 'Admin refund', adminUserId: user.id, adminEmail: user.email || '' },
  });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);

  const refund = result.refund;
  try {
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id VARCHAR(64)`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount BIGINT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
  } catch (_) {}

  await db.execute(sql`
    UPDATE payments
    SET status = ${refund?.amount && refund.amount < pay.amount ? 'partially_refunded' : 'refunded'},
        refund_id = ${refund?.id || null},
        refund_amount = ${refund?.amount || pay.amount},
        refunded_at = NOW(),
        refund_reason = ${reason},
        refunded_by_user_id = ${user.id}
    WHERE id = ${paymentRowId}
  `);

  try {
    await logAudit({
      userId: user.id,
      action: 'payment.refund',
      entity: 'payment',
      entityId: paymentRowId,
      diff: { refundId: refund?.id, amount: refund?.amount, reason, razorpayPaymentId: pay.razorpay_payment_id },
      ipAddress: clientAddress,
    });
  } catch (_) {}

  return json({ ok: true, refundId: refund?.id, amount: refund?.amount, status: refund?.status });
};
