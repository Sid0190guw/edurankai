// POST /api/payments/start-test-payment
// Admin-only Rs 1 sanity check of the live Razorpay integration. Creates a
// 100-paise order; no downstream effect (purpose 'test_ping'). Use the finance
// dashboard / Razorpay dashboard to confirm capture + webhook delivery.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { can } from '@/lib/auth/permissions';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  // WAS a literal role list, `['super_admin','hr'].includes(user.role)`, on a route that creates a
  // REAL Razorpay order and writes a payments row. Now the ability by name.
  //
  // POPULATION-IDENTICAL, and that is why can() is used rather than denyAdminApi({ permission }).
  // PERMS_BY_ROLE grants `payments.view` to exactly super_admin and hr — the two roles the literal
  // list named — and can() reads that matrix and nothing else, so no custom role gains the endpoint
  // and no built-in role loses it. denyAdminApi would move the set in BOTH directions: it runs
  // canOpenAdmin() first (removing an intern-flagged super_admin, who passes today) and then falls
  // through to the registry (adding every custom role explicitly granted payments.view). Either may
  // be the right policy; neither is a mechanism swap, so neither ships here.
  //
  // FAILS CLOSED without touching the database: no session, an inactive account, or a role absent
  // from the matrix all answer false. A financial endpoint that opens when the database blinks is
  // not a gate — can() is the one test on this project that cannot blink.
  if (!can(user, 'payments.view')) return json({ ok: false, error: 'Admins only' }, 403);
  if (!isConfigured()) return json({ ok: false, error: 'Razorpay keys not present in THIS environment. They are set in Vercel production - run this test on the deployed site, not locally.' }, 503);

  const receipt = 'ping_' + Date.now().toString(36);
  const result = await createOrder({ amountPaise: 100, currency: 'INR', receipt, notes: { purpose: 'test_ping', by: user.id } });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);

  // THE WHOLE POINT OF THIS ROUTE IS TO ANSWER "DOES THE PAYMENT PATH WORK", and the payments row is
  // half of that path — /api/payments/verify updates the row by order id, and the finance console
  // reads it back. `.catch(() => {})` meant a ping whose OWN record failed still reported success,
  // which is the one answer a diagnostic must never give. The order is real either way, so it is
  // reported rather than refused, and the response says which half worked.
  let recorded = true;
  try {
    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
      VALUES (${result.order.id}, 100, 'INR', 'created', 'test_ping', 'test_ping', ${user.id}, ${user.id}, ${user.email || 'admin@edurankai.in'},
        ${sql.raw("'" + JSON.stringify({ receipt }).replace(/'/g, "''") + "'::jsonb")})
    `);
  } catch (e: any) {
    recorded = false;
    console.error('[payments] test ping order', result.order.id, 'was created at the gateway but NOT recorded in payments -',
      e?.cause?.message || e?.message);
  }

  return json({
    ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise: 100, currency: 'INR',
    recorded,
    warning: recorded ? undefined
      : 'The order was created at the gateway but could not be written to the payments table, so this '
        + 'ping will not appear in the finance console and /api/payments/verify will have nothing to update.',
    prefill: { name: user.name || '', email: user.email || '' },
  });
};
