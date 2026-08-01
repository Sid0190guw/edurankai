// POST /api/offer-verification/pay  { requestId }
//
// Opens checkout for a firm's verification request.
//
// THE AMOUNT IS COMPUTED HERE, NEVER ACCEPTED FROM THE CLIENT. A posted price is a posted price:
// anyone can change it before it is sent. The fee comes from FIRM_VERIFICATION_FEE_CHF and is
// converted at the live rate server-side.
//
// The order id is stored against the request BEFORE checkout opens, so confirmation can be matched
// back to the request that was actually paid for rather than trusting a browser-supplied id.
import type { APIRoute } from 'astro';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';
import { getRequest, setOrderId, isFreePath, FIRM_VERIFICATION_FEE_CHF } from '@/lib/offer-verification';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({} as any));
    const requestId = String(body?.requestId || '').trim();
    if (!requestId) return json({ ok: false, error: 'Missing request.' }, 400);

    const req = await getRequest(requestId);
    if (!req) return json({ ok: false, error: 'That request no longer exists.' }, 404);

    // A free path must never reach checkout — charging an individual or a university for verifying
    // their own credential is exactly what the two-path split exists to prevent.
    if (isFreePath(req.kind)) return json({ ok: false, error: 'This request is not chargeable.' }, 400);
    if (req.paid) return json({ ok: false, error: 'This request has already been paid for.' }, 409);

    if (!isConfigured()) {
      return json({ ok: false, error: 'Card payment is not available right now. Please write to hr@edurankai.in and we will invoice you instead.' }, 503);
    }

    // CHF -> INR at the live rate. convertToInrPaise expects MINOR units, so 5 CHF is 500 centimes.
    const fx = await convertToInrPaise('CHF', Math.round(FIRM_VERIFICATION_FEE_CHF * 100));

    // Same absurd-amount guard as the other checkout paths. A broken FX response must fail loudly
    // rather than take a token payment — a wrong charge is a refund and a reconciliation problem.
    if (!fx.paise || fx.paise < 1000) {
      console.error('[offer-verification/pay] refusing absurd amount', { paise: fx.paise, rate: fx.rate, live: fx.live });
      return json({ ok: false, error: 'We could not price this correctly, so no payment was taken. Please write to hr@edurankai.in.' }, 409);
    }

    const result = await createOrder({
      amountPaise: fx.paise,
      currency: 'INR',
      receipt: ('ovf_' + Date.now().toString(36) + '_' + requestId.slice(0, 8)).slice(0, 40),
      notes: {
        purpose: 'offer_verification',
        requestId,
        organisation: (req.organisation || '').slice(0, 100),
        email: req.requesterEmail,
      },
    });
    if (!result.ok) return json({ ok: false, error: result.error || 'Could not start the payment.' }, 502);

    await setOrderId(requestId, result.order.id);

    return json({
      ok: true,
      orderId: result.order.id,
      amountPaise: fx.paise,
      currency: 'INR',
      keyId: getPublicKeyId(),
      feeChf: FIRM_VERIFICATION_FEE_CHF,
      rate: fx.rate,
      rateLive: fx.live,
      name: req.requesterName,
      email: req.requesterEmail,
    });
  } catch (e: any) {
    console.error('[offer-verification/pay]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'Could not start the payment.' }, 500);
  }
};
