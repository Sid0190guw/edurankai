// POST /api/aquintutor/confirm-payment
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, courseSlug }
// Verifies the HMAC, marks the payment as paid, then creates the enrollment.
//
// =================================================================================================
// A REFUND IS TERMINAL, AND THIS ROUTE COULD UNDO ONE
// =================================================================================================
//
// The three values in the body are the ones Razorpay handed the payer's own browser, so the payer
// keeps them forever: the HMAC is over `order|payment` and nothing else, so it never expires. The
// UPDATE below had no state guard, so a learner whose course payment had been REFUNDED
// (/api/admin/payments/refund, /api/admin/payments/refund-manual, or a refund webhook) could post
// the same triple a month later and write 'refunded' straight back to 'paid' — and the enrolment was
// re-created underneath it. The course was theirs again for nothing.
//
// /api/payments/verify already carries exactly this guard, and reconcileOrder() in
// payment-effects.ts carries it too (`AND status NOT IN ('paid','refunded')`). markPaid() in
// src/lib/course-payments.ts was repaired for the same replay. These two AquinTutor confirmation
// routes were the ones still without it.
//
// The check is a READ of the stored row rather than a claim on the UPDATE, because the answer also
// decides whether the ENROLMENT is written: writing nothing and then enrolling anyway would leave
// the same hole.
//
// =================================================================================================
// THE ENROLMENT ITSELF IS NO LONGER WRITTEN HERE, AND THE STATEMENT IT USED COULD NOT HAVE WORKED
// =================================================================================================
//
// It was `INSERT ... ON CONFLICT (course_id, user_id) DO UPDATE`, with the seat counter driven off
// `xmax = 0`. But training_enrollments HAS NO UNIQUE KEY on (course_id, user_id) — four other files
// in this repository say so in their own comments, which is why ensureEnrolment() uses
// INSERT ... WHERE NOT EXISTS instead. Postgres answers an ON CONFLICT naming columns with no
// matching constraint by refusing the whole statement, so this route threw on every paid enrolment,
// the catch below turned it into "we could not finish that enrolment", and the money was already
// taken.
//
// The write now goes through completeCoursePurchase() in src/lib/course-purchase.ts — the SAME
// function applyPaidEffects() calls, so the browser, the Razorpay webhook and the reconcile backstop
// all finish a purchase the same way. Before that, course confirmation existed only here: a learner
// whose tab closed after paying was charged and never enrolled, and nothing else could complete it.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';
import { completeCoursePurchase } from '@/lib/course-purchase';

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
  const courseSlug = (body?.courseSlug || '').toString();

  if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'missing payment fields' }, 400);

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try {
      await db.execute(sql`UPDATE payments SET status = 'signature_mismatch', updated_at = NOW() WHERE order_id = ${orderId}`);
    } catch (e: any) {
      console.error('[aquintutor/confirm-payment] could not flag the signature mismatch on order', orderId, '-', causeOf(e));
    }
    return json({ ok: false, error: 'Signature mismatch' }, 400);
  }

  // Defence-in-depth: confirm with Razorpay
  const remote = await fetchPayment(paymentId);
  const captured = remote && (remote.status === 'captured' || remote.status === 'authorized');
  if (!captured) {
    return json({ ok: false, error: 'Payment not captured yet. Try again in a moment.' }, 402);
  }

  try {
    // Look up payment + course
    const pRows = rowsOf(await db.execute(sql`SELECT id, user_id, reference_id, amount_paise, status FROM payments WHERE order_id = ${orderId} LIMIT 1`));
    if (pRows.length === 0) return json({ ok: false, error: 'Payment record missing' }, 404);
    const payment = pRows[0] as any;

    if (payment.user_id && payment.user_id !== user.id) {
      return json({ ok: false, error: 'Payment belongs to another account' }, 403);
    }

    if (TERMINAL.indexOf(String(payment.status || '')) >= 0) {
      console.error('[aquintutor/confirm-payment] replayed against a REFUNDED order', orderId, '- nothing was changed');
      return json({ ok: false, error: 'This payment has been refunded. Nothing was changed.' }, 409);
    }

    const courseId = payment.reference_id;
    if (!courseId) return json({ ok: false, error: 'Payment not linked to a course' }, 400);

    // Mark payment paid. The guard is repeated on the statement so a refund landing between the read
    // above and this write still wins.
    await db.execute(sql`
      UPDATE payments SET razorpay_payment_id = ${paymentId}, razorpay_signature = ${signature},
        status = 'paid', updated_at = NOW()
      WHERE order_id = ${orderId}
        AND status NOT IN ('refunded', 'partially_refunded')
    `);

    // THE ENROLMENT, THROUGH THE ONE WRITER. Idempotent: a replayed confirmation enrols nobody a
    // second time, does not move the seat counter, and does not spend the waiver twice.
    const done = await completeCoursePurchase(orderId, paymentId);
    if (done.refunded) {
      return json({ ok: false, error: 'This payment has been refunded. Nothing was changed.' }, 409);
    }
    if (!done.applied) {
      // The payment is marked paid above and the learner is NOT enrolled. Never silent: the log
      // names the order, and the sentence tells them not to pay again.
      console.error('[aquintutor/confirm-payment] order', orderId, 'is paid but no course enrolment was applied');
      return json({
        ok: false,
        error: 'Your payment went through but we could not open the course. Do not pay again - email connect@edurankai.in with your payment id and we will fix it.',
      }, 500);
    }

    return json({ ok: true, redirect: '/portal/courses/' + courseSlug });
  } catch (e: any) {
    // e.message on a postgres-js error is only the failed SQL — the schema, handed to whoever posted.
    // The real reason is on e.cause and belongs in the log, not in the response.
    console.error('[aquintutor/confirm-payment] order', orderId, '-', causeOf(e));
    return json({ ok: false, error: 'We could not finish that enrolment. Do not pay again - email connect@edurankai.in with your payment id.' }, 500);
  }
};
