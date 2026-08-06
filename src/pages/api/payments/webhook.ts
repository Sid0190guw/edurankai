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

  // WHICH ROW THIS EVENT IS ABOUT.
  //
  // A refund entity carries no order id — it carries the PAYMENT id it refunded — and this used to
  // put that payment id into `orderId` and then match `WHERE order_id = ...`. payments.order_id holds
  // a Razorpay ORDER id (order_...), never a payment id (pay_...), so every refund.created and
  // refund.processed webhook matched zero rows: the status was never written, refunded_at stayed
  // null, and no screen in the product could ever say a payment had been refunded. The two entities
  // are now matched on their own columns.
  const orderId: string | null = paymentEntity?.order_id || null;
  const refundedPaymentId: string | null = refundEntity?.payment_id || paymentEntity?.id || null;
  const isRefund = eventType === 'refund.created' || eventType === 'refund.processed';

  if (!orderId && !(isRefund && refundedPaymentId)) {
    // Not all webhook types relate to a stored order - acknowledge anyway
    return new Response('ok', { status: 200 });
  }
  /** The WHERE clause that names this event's row: by order for payments, by payment id for refunds. */
  const match = isRefund && !orderId
    ? sql`razorpay_payment_id = ${refundedPaymentId}`
    : sql`order_id = ${orderId}`;

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
      WHERE ${match}
    `);

    if (nextStatus) {
      // A FAILED ATTEMPT MUST NOT UNDO A CAPTURE.
      //
      // Razorpay allows several attempts against one order: a card declines, the payer retries, the
      // second attempt is captured. Webhook deliveries are not ordered, so payment.failed for the
      // first attempt can arrive AFTER payment.captured for the second — and this statement, which
      // wrote `status = 'failed'` unconditionally, then turned a paid order into a failed one. The
      // payer had paid; the product said they had not. 'paid' and 'refunded' are terminal here and
      // only a refund event moves a payment off 'paid'.
      //
      // AND A REFUND MUST NOT BE UNDONE BY A REDELIVERY. The `failed` arm was guarded and the `paid`
      // arm was not, but Razorpay redelivers webhooks — up to 24 hours, and again whenever a
      // dashboard operator resends one. A payment.captured redelivered AFTER the refund it was
      // refunded by wrote 'refunded' back to 'paid', cleared nothing, and then fell through to
      // applyPaidEffects() below, which re-approved the account or re-marked the fee paid. The
      // refund had actually left the company; only the record of it was reversed.
      //
      // 'partially_refunded' is in the guard for the same reason: a partial refund is money already
      // returned, and a redelivery that relabels it a clean capture hides the part that went back.
      const guard = nextStatus === 'failed'
        ? sql`AND status NOT IN ('paid', 'refunded', 'partially_refunded')`
        : nextStatus === 'paid'
          ? sql`AND status NOT IN ('refunded', 'partially_refunded')`
          : sql``;
      await db.execute(sql`
        UPDATE payments SET
          status = ${nextStatus},
          razorpay_payment_id = COALESCE(${paymentEntity?.id || null}, razorpay_payment_id),
          failure_reason = COALESCE(${failureReason}, failure_reason),
          refunded_at = COALESCE(${refundedAt}::timestamptz, refunded_at),
          refund_amount_paise = COALESCE(${refundAmount}, refund_amount_paise),
          updated_at = NOW()
        WHERE ${match} ${guard}
      `);
    }

    // On capture, apply the same downstream effects as the browser verify so
    // the payment completes even if the user never returned to the site.
    //
    // NOT FOR A REFUNDED ORDER. The status guard above stops the ROW being relabelled, but the
    // effects are what actually give somebody the thing they paid for, and they were applied from
    // the event alone. A redelivered payment.captured on a refunded order re-approved the account
    // and re-marked the fee paid without the row ever changing — the guard has to cover both.
    if (orderId && (eventType === 'payment.captured' || eventType === 'order.paid')) {
      const cur = await db.execute(sql`SELECT status FROM payments WHERE order_id = ${orderId} LIMIT 1`);
      const curRows = Array.isArray(cur) ? cur : ((cur as any)?.rows || []);
      const curStatus = String(curRows[0]?.status || '');
      if (curStatus === 'refunded' || curStatus === 'partially_refunded') {
        console.error('[payments webhook]', eventType, 'redelivered for REFUNDED order', orderId, '- no effect was applied');
      } else {
        const { applyPaidEffects } = await import('@/lib/payment-effects');
        await applyPaidEffects(orderId, paymentEntity?.id || null);
      }
    }
  } catch (e: any) {
    // The real Postgres reason is on `.cause`; `.message` is only the failed SQL text.
    console.error('[payments webhook] db update failed:', e?.cause?.message || e?.message);
    // Still return 200 to prevent Razorpay retry storms - log + alert separately
  }

  return new Response('ok', { status: 200 });
};
