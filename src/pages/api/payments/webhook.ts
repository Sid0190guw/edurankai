// POST /api/payments/webhook
// Razorpay calls this for: payment.captured, payment.failed, refund.created, etc.
// Verifies signature, appends event to payments.webhook_events, updates status.
// Configure webhook URL in Razorpay dashboard + set RAZORPAY_WEBHOOK_SECRET.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyWebhookSignature } from '@/lib/razorpay';

export const POST: APIRoute = async ({ request }) => {
  // Read raw body (NOT request.json()) - signature is over the exact bytes.
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') || '';

  if (!verifyWebhookSignature(rawBody, signature)) {
    return new Response('invalid signature', { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }

  const eventType = event?.event as string;
  const paymentEntity = event?.payload?.payment?.entity;
  const refundEntity = event?.payload?.refund?.entity;

  // Find the order_id from the most relevant entity
  const orderId = paymentEntity?.order_id || refundEntity?.payment_id || null;

  if (!orderId) {
    // Not all webhook types relate to a stored order - acknowledge anyway
    return new Response('ok', { status: 200 });
  }

  // Compute the new status
  let nextStatus: string | null = null;
  let failureReason: string | null = null;
  let refundedAt: string | null = null;
  let refundAmount: number | null = null;

  if (eventType === 'payment.captured') {
    nextStatus = 'paid';
  } else if (eventType === 'payment.failed') {
    nextStatus = 'failed';
    failureReason = paymentEntity?.error_description || paymentEntity?.error_reason || 'unknown';
  } else if (eventType === 'refund.created' || eventType === 'refund.processed') {
    nextStatus = 'refunded';
    refundedAt = new Date().toISOString();
    refundAmount = refundEntity?.amount || null;
  }

  try {
    // Append event to webhook_events JSONB array regardless
    await db.execute(sql`
      UPDATE payments SET
        webhook_events = webhook_events || ${sql.raw("'" + JSON.stringify([{ at: new Date().toISOString(), event: eventType, payment_id: paymentEntity?.id || null }]).replace(/'/g, "''") + "'::jsonb")},
        updated_at = NOW()
      WHERE order_id = ${orderId}
    `);

    if (nextStatus) {
      await db.execute(sql`
        UPDATE payments SET
          status = ${nextStatus},
          razorpay_payment_id = COALESCE(${paymentEntity?.id || null}, razorpay_payment_id),
          failure_reason = COALESCE(${failureReason}, failure_reason),
          refunded_at = COALESCE(${refundedAt}::timestamptz, refunded_at),
          refund_amount_paise = COALESCE(${refundAmount}, refund_amount_paise),
          updated_at = NOW()
        WHERE order_id = ${orderId}
      `);
    }

    // On capture, apply the same downstream effects as the browser verify so
    // the payment completes even if the user never returned to the site.
    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      const { applyPaidEffects } = await import('@/lib/payment-effects');
      await applyPaidEffects(orderId, paymentEntity?.id || null);
    }
  } catch (e: any) {
    console.error('[payments webhook] db update failed:', e?.message);
    // Still return 200 to prevent Razorpay retry storms - log + alert separately
  }

  return new Response('ok', { status: 200 });
};
