// POST /api/payments/start-test-payment
// Admin-only Rs 1 sanity check of the live Razorpay integration. Creates a
// 100-paise order; no downstream effect (purpose 'test_ping'). Use the finance
// dashboard / Razorpay dashboard to confirm capture + webhook delivery.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user || !['super_admin', 'hr'].includes(user.role)) return json({ ok: false, error: 'Admins only' }, 403);
  if (!isConfigured()) return json({ ok: false, error: 'Razorpay keys not present in THIS environment. They are set in Vercel production - run this test on the deployed site, not locally.' }, 503);

  const receipt = 'ping_' + Date.now().toString(36);
  const result = await createOrder({ amountPaise: 100, currency: 'INR', receipt, notes: { purpose: 'test_ping', by: user.id } });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);

  await db.execute(sql`
    INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
    VALUES (${result.order.id}, 100, 'INR', 'created', 'test_ping', 'test_ping', ${user.id}, ${user.id}, ${user.email || 'admin@edurankai.in'},
      ${sql.raw("'" + JSON.stringify({ receipt }).replace(/'/g, "''") + "'::jsonb")})
  `).catch(() => {});

  return json({ ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise: 100, currency: 'INR', prefill: { name: user.name || '', email: user.email || '' } });
};
