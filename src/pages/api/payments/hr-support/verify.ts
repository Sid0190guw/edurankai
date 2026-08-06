// POST /api/payments/hr-support/verify — confirm a Razorpay payment for an HR support request.
//
// THE BUG THIS CLOSES. The HMAC over (order_id | payment_id) proves that SOME payment happened and
// that the gateway signed it. It says nothing about WHICH request the money was for. `requestId`
// came out of the request body and was never bound to the order, so anyone who completed any cheap
// payment of their own could replay their own (order_id, payment_id, signature) triple with an
// arbitrary requestId and mark any hr_application_support row paid, for free, as many times as they
// liked.
//
// THE FIX IS TO STOP TRUSTING THE BODY FOR IDENTITY. The row is now selected BY THE ORDER ID, which
// is the value the signature actually covers and which src/pages/payments/hr-support/[id].astro
// writes onto the row when the order is created. `requestId` is still accepted, but only as a
// cross-check: if it is present and names a different row, the request is refused rather than
// silently applied to whichever row the order pointed at.
//
// It is also idempotent. The UPDATE matches only while payment_status is not already 'paid', so a
// replayed triple updates nothing and reports the same success the first call did — a double-submit
// from a flaky network must not look like a failure, and must not re-run the effect.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

export const prerender = false;

// Declared before the handler that uses them — `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const json = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const claimedRequestId = (body.requestId || '').toString();
  const orderId = (body.razorpay_order_id || '').toString();
  const paymentId = (body.razorpay_payment_id || '').toString();
  const signature = (body.razorpay_signature || '').toString();

  if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'missing fields' }, 400);

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return json({ ok: false, error: 'gateway not configured' }, 500);

  const expected = crypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
  // Constant-time. Both sides are hex of a fixed length, so a length mismatch is itself a mismatch.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json({ ok: false, error: 'bad signature' }, 400);

  try {
    // THE ORDER NAMES THE ROW. Not the body.
    const target = rowsOf(await db.execute(sql`
      SELECT id, payment_status FROM hr_application_support WHERE razorpay_order_id = ${orderId} LIMIT 1
    `))[0];
    if (!target) {
      return json({ ok: false, error: 'That payment does not match any support request.' }, 404);
    }
    if (claimedRequestId && String(target.id) !== claimedRequestId) {
      // The caller asked us to mark a row the order was not for. Refuse loudly; this is the exact
      // shape of the replay the route used to accept.
      console.error('[payments/hr-support/verify] order/request mismatch', { order: orderId, claimed: claimedRequestId, actual: String(target.id) });
      return json({ ok: false, error: 'That payment does not belong to this request.' }, 409);
    }

    const updated = rowsOf(await db.execute(sql`
      UPDATE hr_application_support
      SET payment_status = 'paid', razorpay_payment_id = ${paymentId}, paid_at = NOW(), updated_at = NOW()
      WHERE id = ${String(target.id)} AND COALESCE(payment_status, '') <> 'paid'
      RETURNING id
    `));
    // Nothing matched means it was already paid — the same success, without re-running the effect.
    return json({ ok: true, requestId: String(target.id), alreadyPaid: updated.length === 0 });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL. Logged, not returned.
    console.error('[payments/hr-support/verify]', causeOf(e));
    return json({ ok: false, error: 'We could not record that payment. Do not pay again - email hr@edurankai.in with your payment id.' }, 500);
  }
};
