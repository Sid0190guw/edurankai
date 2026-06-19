// POST /api/payments/verify
// Called by the browser AFTER Razorpay checkout returns success.
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies HMAC, updates payments row, returns { ok }.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const orderId = String(body?.razorpay_order_id || '').trim();
  const paymentId = String(body?.razorpay_payment_id || '').trim();
  const signature = String(body?.razorpay_signature || '').trim();

  if (!orderId || !paymentId || !signature) {
    return json({ ok: false, error: 'missing fields' }, 400);
  }

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try {
      await db.execute(sql`
        UPDATE payments SET status = 'signature_mismatch', updated_at = NOW()
        WHERE order_id = ${orderId}
      `);
    } catch (_) {}
    return json({ ok: false, error: 'signature mismatch' }, 400);
  }

  // Defence-in-depth: ask Razorpay if the payment is actually captured.
  const remote = await fetchPayment(paymentId);
  const captured = remote && (remote.status === 'captured' || remote.status === 'authorized');

  try {
    await db.execute(sql`
      UPDATE payments SET
        razorpay_payment_id = ${paymentId},
        razorpay_signature = ${signature},
        status = ${captured ? 'paid' : 'attempted'},
        updated_at = NOW()
      WHERE order_id = ${orderId}
    `);
  } catch (e: any) {
    console.error('[payments] verify update failed:', e?.message);
  }

  // Apply downstream effects (mark application/registration/event paid, etc.).
  // Shared with the webhook so a payment completes regardless of which path
  // confirms it first; idempotent.
  let applicationId: string | undefined;
  let materialiseFailed = false;
  if (captured) {
    try {
      const { applyPaidEffects } = await import('@/lib/payment-effects');
      const r = await applyPaidEffects(orderId, paymentId);
      applicationId = (r && (r as any).applicationId) || undefined;
      materialiseFailed = !!(r && (r as any).failed);
    } catch (e: any) {
      console.error('[payments] paid effects failed:', e?.message);
      materialiseFailed = true;
    }
  }

  // `pending`: payment captured but no application row yet (materialisation
  // failed or is being retried by the webhook). The UI shows a "payment
  // received, finalising" message instead of a broken confirmation page.
  return json({
    ok: true,
    status: captured ? 'paid' : 'attempted',
    applicationId,
    pending: captured && !applicationId,
    materialiseFailed,
  });
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
