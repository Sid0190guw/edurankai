// POST /api/payments/create-order
// Body: { purpose, amountPaise, currency?, email, contact? }
// Returns: { ok, orderId, keyId, amountPaise, currency } for the browser checkout.
//
// =================================================================================================
// THIS ROUTE MAY NOT SELL ANYTHING THAT IS WORTH SOMETHING
// =================================================================================================
//
// It took `amountPaise`, `purpose`, `referenceType` and `referenceId` STRAIGHT OUT OF THE REQUEST
// BODY, with no session required, and wrote them into the `payments` row. Every entitlement in this
// product is then granted by reading that row back:
//
//   * applyPaidEffects() (src/lib/payment-effects.ts) dispatches on `purpose` OR `reference_type` —
//     `application` marks an application's fee paid and pushes it into the live queue, `user` sets
//     users.access_status = 'approved', `event_level` marks a level paid and can auto-issue the
//     credential behind it, `partnership_application` marks the CHF 100 Starter fee paid, and
//     `application_intent` materialises a whole application;
//   * /api/aquintutor/confirm-payment enrols the payer in the course named by `reference_id`, and
//     accepts any order whose `user_id` is null — which is exactly what an unauthenticated call here
//     produced;
//   * /aquintutor/test/[slug] unlocks a paid test on a paid row with reference_type 'test'.
//
// The minimum this endpoint accepted was 100 paise. So one rupee, posted by anybody, bought an
// approved account, a submitted application, an event credential, a partnership onboarding or a paid
// course — and the fact that the money really did arrive is what made it look legitimate afterwards.
//
// Every one of those flows already has its own endpoint that computes the price SERVER-SIDE from the
// fee it is charging (start-application-fee, start-registration-fee, start-event-level-fee,
// start-partnership, wallet-recharge, start-test-enrollment). Those are the ones the product calls;
// nothing in this repository has ever called this route.
//
// So what is left here is the only thing a caller-named amount can honestly be: a payment that buys
// NOTHING — a donation, or an ad-hoc collection reconciled by hand. A reference of any kind is
// refused outright, because a reference is the thing the effects read.
//
// THE PAYMENTS ROW IS NOT OPTIONAL EITHER. Its failure used to be logged and ignored, with the
// comment "Razorpay still has the order" — which is the problem, not the reassurance: the gateway
// takes the money and nothing on our side has any record of it, so no receipt renders
// (/receipt/[order] reads this row), no reconcile can find it, and no refund can be traced.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';

// Purposes that buy nothing. A caller may name the amount for these because the amount IS the
// intent — there is no fee being charged and no entitlement waiting on the other side.
const ALLOWED_PURPOSES = new Set(['donation', 'other']);
const ALLOWED_CURRENCIES = new Set(['INR', 'USD']);

// Where each refused purpose actually belongs, so the refusal is a direction rather than a wall.
const PRICED_ROUTE: Record<string, string> = {
  application_fee: '/api/payments/start-application-fee',
  application_fee_intent: '/api/payments/start-application-fee',
  registration_fee: '/api/payments/start-registration-fee',
  event: '/api/payments/start-event-level-fee',
  event_level: '/api/payments/start-event-level-fee',
  partnership_starter: '/api/payments/start-partnership',
  wallet_recharge: '/api/payments/wallet-recharge',
  aquintutor_test: '/api/aquintutor/start-test-enrollment',
  course_premium: '/api/aquintutor/start-enrollment',
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!isConfigured()) {
    return json({ ok: false, error: 'Payments not configured' }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const purpose = String(body?.purpose || '').trim();
  const amountPaise = Number(body?.amountPaise);
  const currency = (body?.currency || 'INR').toString().toUpperCase();
  const email = String(body?.email || '').trim().toLowerCase();
  const contact = body?.contact ? String(body.contact).trim() : null;

  if (!ALLOWED_PURPOSES.has(purpose)) {
    const route = PRICED_ROUTE[purpose];
    return json({
      ok: false,
      error: route
        ? 'That fee is priced by the server, not by the caller. Start it at ' + route + '.'
        : 'This endpoint only opens a payment that buys nothing (a donation or an ad-hoc collection). '
          + 'Anything that grants access, marks a fee paid or issues a credential has its own '
          + 'endpoint, which computes the amount itself.',
    }, 400);
  }

  // A REFERENCE IS WHAT THE EFFECTS READ. There is no reference that is safe to accept from a
  // request body here, so none is accepted at all — not even a harmless-looking one, because
  // applyPaidEffects() dispatches on `reference_type` alone, independently of `purpose`.
  if (body?.referenceType || body?.referenceId) {
    return json({
      ok: false,
      error: 'A payment opened here cannot be attached to an application, an account, a course, an '
        + 'event level or a wallet. Use the endpoint for that fee — it prices the payment itself and '
        + 'binds it to the record it pays for.',
    }, 400);
  }

  if (!ALLOWED_CURRENCIES.has(currency)) return json({ ok: false, error: 'invalid currency' }, 400);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) return json({ ok: false, error: 'amountPaise must be integer >= 100' }, 400);
  if (!email || !email.includes('@')) return json({ ok: false, error: 'valid email required' }, 400);

  // Local receipt id (also stored on Razorpay's side)
  const receipt = 'era_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const result = await createOrder({
    amountPaise,
    currency,
    receipt,
    notes: {
      purpose,
      email,
    },
  });
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }

  const userId = (locals as any)?.user?.id || null;
  try {
    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, contact, notes
      ) VALUES (
        ${result.order.id}, ${amountPaise}, ${currency}, 'created', ${purpose},
        NULL, NULL, ${userId}, ${email}, ${contact},
        ${sql.raw("'" + JSON.stringify({ receipt }).replace(/'/g, "''") + "'::jsonb")}
      )
    `);
  } catch (e: any) {
    // NOT SWALLOWED. Without this row the money can be captured with nothing on our side that knows
    // it exists: no receipt, nothing for reconcile to find, nothing to refund against. An unused
    // order at the gateway expires on its own and charges nobody, which is the cheaper failure.
    console.error('[payments] create-order could not record order', result.order.id, 'for', email,
      '-', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not start that payment just now, so nothing was charged. Try again in a moment.' }, 500);
  }

  return json({
    ok: true,
    orderId: result.order.id,
    keyId: getPublicKeyId(),
    amountPaise,
    currency,
  });
};
