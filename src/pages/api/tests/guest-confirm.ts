// POST /api/tests/guest-confirm
// Finalises a guest premium-test payment: verifies the Razorpay signature,
// marks the payment paid, creates the guest attempt, sets the guest cookie.
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, testSlug, name, email, phone }

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature } from '@/lib/razorpay';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, cookies }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const orderId = String(b?.razorpay_order_id || '').trim();
  const paymentId = String(b?.razorpay_payment_id || '').trim();
  const signature = String(b?.razorpay_signature || '').trim();
  const testSlug = String(b?.testSlug || '').trim();
  const name = String(b?.name || '').trim();
  const email = String(b?.email || '').trim().toLowerCase();
  const phone = String(b?.phone || '').trim();
  if (!orderId || !paymentId || !signature || !testSlug) return json({ ok: false, error: 'missing fields' }, 400);

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    await db.execute(sql`UPDATE payments SET status = 'signature_mismatch', updated_at = NOW() WHERE order_id = ${orderId}`).catch(() => {});
    return json({ ok: false, error: 'signature mismatch' }, 400);
  }

  try {
    await db.execute(sql`UPDATE payments SET razorpay_payment_id = ${paymentId}, razorpay_signature = ${signature}, status = 'paid', updated_at = NOW() WHERE order_id = ${orderId}`);
    const test = rows(await db.execute(sql`SELECT id, slug, total_marks FROM tests WHERE slug = ${testSlug} LIMIT 1`))[0] as any;
    if (!test) return json({ ok: false, error: 'Test not found' }, 404);
    const att = rows(await db.execute(sql`
      INSERT INTO test_attempts (test_id, candidate_id, candidate_email, candidate_name, candidate_phone, status, max_score)
      VALUES (${test.id}, NULL, ${email}, ${name}, ${phone || null}, 'in_progress', ${test.total_marks || 0})
      RETURNING id`))[0] as any;
    cookies.set('gat_' + test.id, att.id, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 6 });
    return json({ ok: true, redirect: '/aquintutor/test/' + test.slug + '/run' });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
