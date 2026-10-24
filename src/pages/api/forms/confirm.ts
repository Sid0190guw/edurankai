// POST /api/forms/confirm — finalise a paid form submission.
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature } from '@/lib/razorpay';
import { clientIp, overPublicFormLimit } from '@/lib/public-form-limit';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function dbErrorMessage(error: unknown): string {
  const cause = (error as any)?.cause;
  return String(cause?.message || (error as any)?.message || 'unknown error');
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const spend = await overPublicFormLimit('forms-confirm', clientIp(request.headers) || String(clientAddress || ''), { whenUnavailable: 'refuse' });
  if (spend.blocked) return json({ ok: false, error: 'Too many payment confirmations from this connection. Please try again later.' }, 429);

  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const orderId = String(b?.razorpay_order_id || '').trim();
  const paymentId = String(b?.razorpay_payment_id || '').trim();
  const signature = String(b?.razorpay_signature || '').trim();
  if (!orderId || !paymentId || !signature || orderId.length > 200 || paymentId.length > 200 || signature.length > 200) {
    return json({ ok: false, error: 'missing or invalid fields' }, 400);
  }

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try {
      await db.execute(sql`UPDATE form_responses SET payment_status = 'signature_mismatch' WHERE order_id = ${orderId}`);
    } catch (error) {
      console.error('[forms/confirm] failed to record signature mismatch:', dbErrorMessage(error));
      return json({ ok: false, error: 'Payment verification is temporarily unavailable. Please retry.' }, 503);
    }
    return json({ ok: false, error: 'signature mismatch' }, 400);
  }
  let updated: any;
  try {
    updated = rows(await db.execute(sql`
      UPDATE form_responses
      SET payment_status = 'paid', payment_id = ${paymentId}
      WHERE order_id = ${orderId}
      RETURNING order_id
    `))[0];
  } catch (error) {
    console.error('[forms/confirm] paid response update failed:', dbErrorMessage(error));
    return json({ ok: false, error: 'Payment confirmation is temporarily unavailable. Please retry.' }, 503);
  }
  if (!updated) return json({ ok: false, error: 'Payment order not found.' }, 404);

  let fr: any;
  try {
    fr = rows(await db.execute(sql`SELECT f.success_message FROM form_responses r JOIN forms f ON f.id = r.form_id WHERE r.order_id = ${orderId} LIMIT 1`))[0];
  } catch (error) {
    console.error('[forms/confirm] success message lookup failed:', dbErrorMessage(error));
    return json({ ok: false, error: 'Payment was recorded, but the confirmation message could not be loaded. Please reload.' }, 503);
  }
  return json({ ok: true, message: (fr?.success_message) || 'Payment received — your response has been recorded.' });
};
