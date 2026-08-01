// POST /api/offer-verification/confirm  { orderId, paymentId, signature }
//
// Marks a verification request paid, but ONLY after the gateway's own signature checks out.
//
// The signature is the whole point: it is computed by Razorpay using a secret only our server
// holds, so it cannot be forged by whoever is posting to this endpoint. Without verifying it,
// anyone could call this with any order id and mark a request paid for free.
//
// The request is then found BY ORDER ID, not by an id supplied in the body. That closes the other
// half of the hole — a genuine payment for one request being pointed at a different one.
import type { APIRoute } from 'astro';
import { verifyPaymentSignature } from '@/lib/razorpay';
import { findByOrderId, markPaid, notifyNewRequest } from '@/lib/offer-verification';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({} as any));
    const orderId = String(body?.orderId || '').trim();
    const paymentId = String(body?.paymentId || '').trim();
    const signature = String(body?.signature || '').trim();
    if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'Incomplete payment confirmation.' }, 400);

    // Fail closed on a bad signature. Never mark anything paid on an unverified claim.
    if (!verifyPaymentSignature(orderId, paymentId, signature)) {
      console.error('[offer-verification/confirm] signature mismatch', { orderId, paymentId });
      return json({ ok: false, error: 'We could not verify that payment. Nothing has been charged to your card by us. Please write to hr@edurankai.in.' }, 400);
    }

    const req = await findByOrderId(orderId);
    if (!req) {
      // The money is real but we cannot tell what it was for — surface it loudly rather than
      // swallowing it, because someone has paid and is waiting.
      console.error('[offer-verification/confirm] no request for order', { orderId, paymentId });
      return json({ ok: false, error: 'Payment received but we could not match it to a request. Please write to hr@edurankai.in with your payment id and we will sort it out.' }, 409);
    }

    // markPaid is idempotent, so a retried callback or a webhook arriving after the browser
    // callback cannot double-count or reset the status.
    await markPaid(req.id, orderId);

    // Tell the team only now. Before payment the request was not actionable, so notifying at
    // submission would have queued work nobody could do.
    await notifyNewRequest({
      id: req.id, kind: req.kind, token: req.token,
      requesterName: req.requesterName, organisation: req.organisation,
    });

    return json({ ok: true, requestId: req.id });
  } catch (e: any) {
    console.error('[offer-verification/confirm]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'Could not confirm the payment.' }, 500);
  }
};
