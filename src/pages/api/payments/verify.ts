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

  // -----------------------------------------------------------------------------------------------
  // A REFUND IS TERMINAL, AND THIS ENDPOINT USED TO BE ABLE TO UNDO ONE.
  //
  // The body of this request is the three values Razorpay handed the payer's own browser, so the
  // payer keeps them: order id, payment id, signature. They stay valid forever — the HMAC is over
  // `order|payment` and nothing else — so posting them again a month later passed every check above.
  // The UPDATE then had no guard, so a payment that had since been REFUNDED (by
  // /api/admin/payments/refund, or by a refund webhook) was written straight back to 'paid', and
  // applyPaidEffects() re-ran underneath it: the account that was deactivated after the refund was
  // approved again, the application fee read as paid again, the wallet top-up was re-credited.
  //
  // reconcileOrder() in payment-effects.ts already carries exactly this guard
  // (`AND status NOT IN ('paid','refunded')`), and the webhook carries it for the failed->paid case.
  // This was the one confirmation path without it.
  //
  // The check is a READ of the stored row rather than a claim on the update, because the answer also
  // has to decide whether the downstream effects run at all — writing nothing and then applying the
  // effects anyway would leave the same hole.
  let alreadyRefunded = false;
  try {
    const prior = await db.execute(sql`SELECT status FROM payments WHERE order_id = ${orderId} LIMIT 1`);
    const priorRows = Array.isArray(prior) ? prior : ((prior as any)?.rows || []);
    const priorStatus = String(priorRows[0]?.status || '');
    alreadyRefunded = priorStatus === 'refunded' || priorStatus === 'partially_refunded';
  } catch (e: any) {
    // Unknown is not "not refunded". If the row cannot be read, nothing is written and no effect is
    // applied — the webhook and the reconcile cron both settle this order on their own, and neither
    // of them can be replayed by whoever holds a browser payload.
    console.error('[payments] verify could not read the current status of order', orderId, '-', e?.cause?.message || e?.message);
    return json({ ok: true, status: 'attempted', pending: true, materialiseFailed: false });
  }

  if (alreadyRefunded) {
    console.error('[payments] verify replayed against REFUNDED order', orderId, '- nothing was changed');
    return json({ ok: false, error: 'This payment has been refunded. Nothing was changed.' }, 409);
  }

  try {
    await db.execute(sql`
      UPDATE payments SET
        razorpay_payment_id = ${paymentId},
        razorpay_signature = ${signature},
        status = ${captured ? 'paid' : 'attempted'},
        updated_at = NOW()
      WHERE order_id = ${orderId}
        AND status NOT IN ('refunded', 'partially_refunded')
    `);
  } catch (e: any) {
    // The real Postgres reason is on `.cause`; `.message` is only the failed SQL text.
    console.error('[payments] verify update failed for order', orderId, '-', e?.cause?.message || e?.message);
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
