// POST /api/forms/confirm — finalise a paid form submission.
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature } from '@/lib/razorpay';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const orderId = String(b?.razorpay_order_id || '').trim();
  const paymentId = String(b?.razorpay_payment_id || '').trim();
  const signature = String(b?.razorpay_signature || '').trim();
  if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'missing fields' }, 400);

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    await db.execute(sql`UPDATE form_responses SET payment_status = 'signature_mismatch' WHERE order_id = ${orderId}`).catch(() => {});
    return json({ ok: false, error: 'signature mismatch' }, 400);
  }
  await db.execute(sql`UPDATE form_responses SET payment_status = 'paid', payment_id = ${paymentId} WHERE order_id = ${orderId}`);
  const fr: any = rows(await db.execute(sql`SELECT f.success_message FROM form_responses r JOIN forms f ON f.id = r.form_id WHERE r.order_id = ${orderId} LIMIT 1`))[0];
  return json({ ok: true, message: (fr?.success_message) || 'Payment received — your response has been recorded.' });
};
