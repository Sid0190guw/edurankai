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
// enrolled_count WAS BUMPED ON EVERY CALL, INCLUDING THE ONES THAT ENROLLED NOBODY
// =================================================================================================
//
// The enrolment INSERT is `ON CONFLICT (course_id, user_id) DO UPDATE`, so a replay or a double-tap
// creates no new learner — but the `enrolled_count = enrolled_count + 1` beneath it ran regardless,
// so the seat counter climbed every time and no query could ever reconcile it back. It is now driven
// by whether the INSERT actually inserted (xmax = 0 on the returned row), which is the only way to
// tell an insert from an ON CONFLICT update in one statement.
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

    // Create enrollment. `xmax = 0` is true only for a row this statement actually INSERTED, so a
    // repeat that lands on ON CONFLICT does not move the seat counter.
    const enrolled = rowsOf(await db.execute(sql`
      INSERT INTO training_enrollments (course_id, user_id, progress_pct, payment_id, amount_paid_paise)
      VALUES (${courseId}, ${user.id}, 0, ${payment.id}, ${payment.amount_paise})
      ON CONFLICT (course_id, user_id) DO UPDATE SET payment_id = EXCLUDED.payment_id, amount_paid_paise = EXCLUDED.amount_paid_paise
      RETURNING (xmax = 0) AS inserted
    `));
    const isNew = !!(enrolled[0] as any)?.inserted;
    if (isNew) {
      await db.execute(sql`UPDATE training_courses SET enrolled_count = enrolled_count + 1 WHERE id = ${courseId}`)
        .catch((e: any) => console.error('[aquintutor/confirm-payment] seat counter not incremented for course', courseId, '-', causeOf(e)));
    }

    return json({ ok: true, redirect: '/portal/courses/' + courseSlug });
  } catch (e: any) {
    // e.message on a postgres-js error is only the failed SQL — the schema, handed to whoever posted.
    // The real reason is on e.cause and belongs in the log, not in the response.
    console.error('[aquintutor/confirm-payment] order', orderId, '-', causeOf(e));
    return json({ ok: false, error: 'We could not finish that enrolment. Do not pay again - email connect@edurankai.in with your payment id.' }, 500);
  }
};
