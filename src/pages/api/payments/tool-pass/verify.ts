// POST /api/payments/tool-pass/verify — confirm a Razorpay payment for a 24-hour tool day pass.
//
// THE BUG THIS CLOSES. The signature check ran, and then activatePass() INSERTED a fresh active pass
// UNCONDITIONALLY — whether or not the UPDATE above it had matched any row. So one valid triple
// could be replayed forever, each replay minting another 24-hour pass, and a triple from ANY other
// order the caller had paid worked just as well because nothing tied the order to a pending row
// belonging to this user.
//
// THE FIX. The pending row created by ./order.ts (user_id + razorpay_order_id + status 'pending') is
// promoted IN PLACE by a single guarded UPDATE. If it matches nothing — wrong user, unknown order,
// or already activated — no pass is created. That makes the route idempotent and removes the
// unconditional INSERT entirely; activatePass() is no longer called from here, so there is no path
// left that grants a pass without a matching pending order.
import type { APIRoute } from 'astro';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureToolPassSchema } from '@/lib/tool-pass';

export const prerender = false;

// Declared before the handler that uses them — `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const json = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorised' }, 401);
  const secret = import.meta.env.RAZORPAY_KEY_SECRET;
  if (!secret) return json({ ok: false, error: 'not configured' }, 500);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const orderId = (body.razorpay_order_id || '').toString();
  const paymentId = (body.razorpay_payment_id || '').toString();
  const sig = (body.razorpay_signature || '').toString();
  if (!orderId || !paymentId || !sig) return json({ ok: false, error: 'missing fields' }, 400);

  const expected = createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ ok: false, error: 'invalid signature' }, 400);

  try {
    await ensureToolPassSchema();
    // ONE guarded statement does the whole thing. The pass exists only if a pending order belonging
    // to THIS user carried THIS order id.
    const activated = rowsOf(await db.execute(sql`
      UPDATE tool_day_passes
      SET razorpay_payment_id = ${paymentId},
          razorpay_signature = ${sig},
          status = 'active',
          activated_at = NOW(),
          expires_at = NOW() + INTERVAL '24 hours',
          updated_at = NOW()
      WHERE razorpay_order_id = ${orderId}
        AND user_id = ${user.id}
        AND status = 'pending'
      RETURNING id, expires_at
    `));

    if (activated.length === 0) {
      // Either the order is not this user's, or it has already been activated. Tell those apart for
      // the caller's benefit without confirming anything about somebody else's order.
      const mine = rowsOf(await db.execute(sql`
        SELECT status FROM tool_day_passes WHERE razorpay_order_id = ${orderId} AND user_id = ${user.id} LIMIT 1
      `))[0];
      if (mine && String(mine.status) === 'active') {
        return json({ ok: true, alreadyActive: true });
      }
      console.error('[payments/tool-pass/verify] no pending order matched', { order: orderId, user: String(user.id) });
      return json({ ok: false, error: 'That payment does not match a pending pass on this account.' }, 409);
    }

    return json({ ok: true, expiresAt: activated[0]?.expires_at || null });
  } catch (e: any) {
    // Real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[payments/tool-pass/verify]', causeOf(e));
    return json({ ok: false, error: 'We could not activate that pass. Do not pay again - email connect@edurankai.in with your payment id.' }, 500);
  }
};
