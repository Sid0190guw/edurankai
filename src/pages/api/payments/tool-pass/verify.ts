import type { APIRoute } from 'astro';
import { createHmac } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { activatePass } from '@/lib/tool-pass';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

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
  if (expected !== sig) return json({ ok: false, error: 'invalid signature' }, 400);

  try {
    await db.execute(sql`
      UPDATE tool_day_passes
      SET razorpay_payment_id = ${paymentId}, razorpay_signature = ${sig}, updated_at = NOW()
      WHERE razorpay_order_id = ${orderId} AND user_id = ${user.id}
    `);
    await activatePass({ userId: user.id, orderId, paymentId, signature: sig });
    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500);
  }
};
