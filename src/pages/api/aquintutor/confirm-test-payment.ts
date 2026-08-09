// POST /api/aquintutor/confirm-test-payment
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, testSlug }
// Verifies the HMAC + remote payment status, marks the payments row 'paid'.
// The test page then sees the paid row and unlocks the test runner.
//
// THE SAME REFUND REPLAY AS ./confirm-payment.ts, ON THE SAME SHAPE OF ROUTE. The (order, payment,
// signature) triple is the payer's own and never expires, and the UPDATE had no state guard — so a
// refunded test fee could be written back to 'paid' and the runner unlocked again for nothing. The
// guard here matches the one /api/payments/verify already carries.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';

// Declared before the handler that uses them — `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const TERMINAL = ['refunded', 'partially_refunded'];

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const orderId = (body?.razorpay_order_id || '').toString();
  const paymentId = (body?.razorpay_payment_id || '').toString();
  const signature = (body?.razorpay_signature || '').toString();
  const testSlug = (body?.testSlug || '').toString();

  if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'missing payment fields' }, 400);

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try {
      await db.execute(sql`UPDATE payments SET status = 'signature_mismatch', updated_at = NOW() WHERE order_id = ${orderId}`);
    } catch (e: any) {
      console.error('[aquintutor/confirm-test-payment] could not flag the signature mismatch on order', orderId, '-', causeOf(e));
    }
    return json({ ok: false, error: 'Signature mismatch' }, 400);
  }

  const remote = await fetchPayment(paymentId);
  const captured = remote && (remote.status === 'captured' || remote.status === 'authorized');
  if (!captured) {
    return json({ ok: false, error: 'Payment not captured yet. Try again in a moment.' }, 402);
  }

  try {
    const pRows = rowsOf(await db.execute(sql`SELECT id, user_id, reference_id, status FROM payments WHERE order_id = ${orderId} LIMIT 1`));
    if (pRows.length === 0) return json({ ok: false, error: 'Payment record missing' }, 404);
    const payment = pRows[0] as any;

    if (payment.user_id && payment.user_id !== user.id) {
      return json({ ok: false, error: 'Payment belongs to another account' }, 403);
    }

    if (TERMINAL.indexOf(String(payment.status || '')) >= 0) {
      console.error('[aquintutor/confirm-test-payment] replayed against a REFUNDED order', orderId, '- nothing was changed');
      return json({ ok: false, error: 'This payment has been refunded. Nothing was changed.' }, 409);
    }

    await db.execute(sql`
      UPDATE payments SET razorpay_payment_id = ${paymentId}, razorpay_signature = ${signature},
        status = 'paid', updated_at = NOW()
      WHERE order_id = ${orderId}
        AND status NOT IN ('refunded', 'partially_refunded')
    `);

    return json({ ok: true, redirect: '/aquintutor/test/' + testSlug + '/run' });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL and is never returned.
    console.error('[aquintutor/confirm-test-payment] order', orderId, '-', causeOf(e));
    return json({ ok: false, error: 'We could not record that payment. Do not pay again - email connect@edurankai.in with your payment id.' }, 500);
  }
};
