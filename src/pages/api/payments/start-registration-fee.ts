// POST /api/payments/start-registration-fee
// One-time 1 CHF account-activation fee for the signed-in user. On successful
// verify, /api/payments/verify marks the user reg_fee_paid + access_status
// 'approved'. If already approved, returns a redirect.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

const REGISTRATION_FEE_CHF = 1;

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in.', loginUrl: '/portal/login' }, 401);

  try {
    const u = rows(await db.execute(sql`SELECT id, email, name, access_status, reg_fee_paid FROM users WHERE id = ${user.id} LIMIT 1`))[0] as any;
    if (!u) return json({ ok: false, error: 'User not found' }, 404);
    if (u.access_status === 'approved' || u.reg_fee_paid) return json({ ok: true, alreadyPaid: true, redirect: '/portal' });

    // Universal account credit: cover the registration fee from the wallet.
    {
      const fxC = await convertToInrPaise('CHF', REGISTRATION_FEE_CHF * 100);
      const { coverWithCredit } = await import('@/lib/account-credit');
      const cov = await coverWithCredit({ userId: u.id, amountPaise: fxC.paise, purpose: 'registration_fee', referenceType: 'user', referenceId: u.id, email: u.email || '', label: 'Registration fee' });
      if (cov.covered) return json({ ok: true, alreadyPaid: true, paidWithCredit: true, redirect: '/portal' });
    }

    if (!isConfigured()) return json({ ok: false, error: 'Payments not yet configured. You can request a fee waiver instead.' }, 503);

    const fx = await convertToInrPaise('CHF', REGISTRATION_FEE_CHF * 100);
    const amountPaise = fx.paise;
    const receipt = 'reg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    const result = await createOrder({
      amountPaise, currency: 'INR', receipt,
      notes: { purpose: 'registration_fee', userId: u.id, email: u.email || '', feeChf: String(REGISTRATION_FEE_CHF) },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);

    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
      VALUES (${result.order.id}, ${amountPaise}, 'INR', 'created', 'registration_fee', 'user', ${u.id}, ${u.id}, ${u.email || 'unknown@edurankai.in'},
        ${sql.raw("'" + JSON.stringify({ receipt, feeChf: REGISTRATION_FEE_CHF, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live }).replace(/'/g, "''") + "'::jsonb")})
    `).catch(() => {});

    return json({ ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise, currency: 'INR', feeChf: REGISTRATION_FEE_CHF, prefill: { name: u.name || '', email: u.email || '' } });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
