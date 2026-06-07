import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const requestId = (body.requestId || '').toString();
  const orderId = (body.razorpay_order_id || '').toString();
  const paymentId = (body.razorpay_payment_id || '').toString();
  const signature = (body.razorpay_signature || '').toString();

  if (!requestId || !orderId || !paymentId || !signature) return json({ ok: false, error: 'missing fields' }, 400);

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return json({ ok: false, error: 'gateway not configured' }, 500);

  const expected = crypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
  if (expected !== signature) return json({ ok: false, error: 'bad signature' }, 400);

  try {
    await db.execute(sql`
      UPDATE hr_application_support
      SET payment_status = 'paid', razorpay_payment_id = ${paymentId}, paid_at = NOW(), updated_at = NOW()
      WHERE id = ${requestId}
    `);
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }

  return json({ ok: true });
};
