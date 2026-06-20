import type { APIRoute } from 'astro';
import { ensureToolPassSchema } from '@/lib/tool-pass';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// 1 CHF in centimes = 100. Razorpay needs INR for India; we convert 1 CHF
// roughly to ~100 INR (100 paise). The existing CHF→INR converter used in the
// rest of the codebase normalises this; here we hardcode a safe rounded value
// because the unit is fixed.
const PASS_INR_PAISE = 10000; // 100 INR

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorised' }, 401);

  await ensureToolPassSchema();

  // Universal account credit: activate the day pass straight from the wallet
  // (no card charge, works even if Razorpay isn't configured).
  try {
    const { getCreditBalance, grantCredit } = await import('@/lib/account-credit');
    if ((await getCreditBalance(user.id)) >= PASS_INR_PAISE) {
      await grantCredit(user.id, -PASS_INR_PAISE, 'Paid with credit: Tool day pass');
      const { activatePass } = await import('@/lib/tool-pass');
      await activatePass({ userId: user.id, orderId: 'CREDIT-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), paymentId: 'credit', signature: 'credit' });
      return json({ ok: true, paidWithCredit: true });
    }
  } catch (_) {}

  const keyId = import.meta.env.RAZORPAY_KEY_ID || import.meta.env.PUBLIC_RAZORPAY_KEY_ID;
  const secret = import.meta.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) return json({ ok: false, error: 'Razorpay not configured' }, 500);

  try {
    const auth = Buffer.from(keyId + ':' + secret).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + auth },
      body: JSON.stringify({ amount: PASS_INR_PAISE, currency: 'INR', notes: { kind: 'tool_pass', user_id: user.id } }),
    });
    const j = await r.json();
    if (!j.id) return json({ ok: false, error: j?.error?.description || 'order create failed' }, 500);
    await db.execute(sql`
      INSERT INTO tool_day_passes (user_id, candidate_email, amount_chf, razorpay_order_id, status)
      VALUES (${user.id}, ${user.email}, 1.00, ${j.id}, 'pending')
    `);
    return json({ ok: true, key: keyId, orderId: j.id, amount: PASS_INR_PAISE, currency: 'INR' });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500);
  }
};
