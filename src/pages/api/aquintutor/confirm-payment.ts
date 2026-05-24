// POST /api/aquintutor/confirm-payment
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, courseSlug }
// Verifies the HMAC, marks the payment as paid, then creates the enrollment.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';

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
    } catch (_) {}
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
    const p = await db.execute(sql`SELECT id, user_id, reference_id, amount_paise FROM payments WHERE order_id = ${orderId} LIMIT 1`);
    const pRows = Array.isArray(p) ? p : (p?.rows || []);
    if (pRows.length === 0) return json({ ok: false, error: 'Payment record missing' }, 404);
    const payment = pRows[0] as any;

    if (payment.user_id && payment.user_id !== user.id) {
      return json({ ok: false, error: 'Payment belongs to another account' }, 403);
    }

    const courseId = payment.reference_id;
    if (!courseId) return json({ ok: false, error: 'Payment not linked to a course' }, 400);

    // Mark payment paid
    await db.execute(sql`
      UPDATE payments SET razorpay_payment_id = ${paymentId}, razorpay_signature = ${signature},
        status = 'paid', updated_at = NOW()
      WHERE order_id = ${orderId}
    `);

    // Create enrollment
    await db.execute(sql`
      INSERT INTO training_enrollments (course_id, user_id, progress_pct, payment_id, amount_paid_paise)
      VALUES (${courseId}, ${user.id}, 0, ${payment.id}, ${payment.amount_paise})
      ON CONFLICT (course_id, user_id) DO UPDATE SET payment_id = EXCLUDED.payment_id, amount_paid_paise = EXCLUDED.amount_paid_paise
    `);
    await db.execute(sql`UPDATE training_courses SET enrolled_count = enrolled_count + 1 WHERE id = ${courseId}`).catch(() => {});

    return json({ ok: true, redirect: '/portal/courses/' + courseSlug });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
