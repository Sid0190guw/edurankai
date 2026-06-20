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

  await db.execute(sql`
    INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email)
    VALUES (${result.order.id}, ${amountPaise}, 'INR', 'created', 'wallet_recharge', 'wallet', ${user.id}, ${user.id}, ${user.email || 'unknown@edurankai.in'})
  `).catch(() => {});

  return json({ ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise, currency: 'INR', prefill: { name: user.name || '', email: user.email || '' } });
};
