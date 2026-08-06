// POST /api/payments/wallet-recharge  { amountInr }
// Creates a Razorpay order to top up the signed-in user's wallet. On verify,
// /api/payments/verify -> applyPaidEffects credits the account_credit ledger
// (idempotent on the order id).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in.' }, 401);
  if (!isConfigured()) return json({ ok: false, error: 'Top-ups are not available right now.' }, 503);

  let body: any = {};
  try { body = await request.json(); } catch {}
  let amountInr = Math.round(Number(body?.amountInr) || 0);
  if (!Number.isFinite(amountInr) || amountInr < 10) return json({ ok: false, error: 'Minimum top-up is Rs 10.' }, 400);
  if (amountInr > 200000) amountInr = 200000; // safety cap
  const amountPaise = amountInr * 100;
  const receipt = 'wal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const result = await createOrder({ amountPaise, currency: 'INR', receipt, notes: { purpose: 'wallet_recharge', userId: user.id } });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);

  // THE PAYMENTS ROW IS NOT OPTIONAL, AND ITS FAILURE MUST NOT BE SWALLOWED.
  //
  // This ended in `.catch(() => {})`. Everything downstream of a top-up is keyed on this row:
  // /api/payments/verify updates `payments WHERE order_id = ...`, and applyPaidEffects() reads the
  // order out of `payments` and returns immediately when there is none. So if the insert failed the
  // browser was still handed an order id, the user paid, and the money was captured by the gateway
  // with NOTHING credited to their balance and nothing written anywhere to reconcile it against.
  //
  // Refusing here costs an unused order at the gateway — which expires on its own and charges nobody
  // — and is the only answer that cannot take money for nothing.
  try {
    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email)
      VALUES (${result.order.id}, ${amountPaise}, 'INR', 'created', 'wallet_recharge', 'wallet', ${user.id}, ${user.id}, ${user.email || 'unknown@edurankai.in'})
    `);
  } catch (e: any) {
    console.error('[payments] wallet top-up order', result.order.id, 'could not be recorded for user', user.id, '-', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not start that top-up just now, so nothing was charged. Try again in a moment.' }, 500);
  }

  return json({ ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise, currency: 'INR', prefill: { name: user.name || '', email: user.email || '' } });
};
