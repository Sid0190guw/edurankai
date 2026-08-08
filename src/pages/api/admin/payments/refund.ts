// POST /api/admin/payments/refund
// Body: { paymentRowId, amountPaise?, reason? }
// Issues a refund via Razorpay. Full refund if amountPaise is omitted.
// Marks the payments row + records the refund metadata + writes an audit log.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { refundPayment } from '@/lib/razorpay';
import { logAudit } from '@/lib/audit';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  // MONEY LEAVES THE COMPANY BELOW THIS LINE, so the gate is here and not further down.
  //
  // This used to be `if (!user || user.role === 'applicant') return 403` — the whole authorisation
  // on an endpoint that issues a real Razorpay refund. Three failures stacked on one URL: the test
  // admits every internal role including `editor` (the role offer-signing handed to interns);
  // /api/* is not matched by isAdminPath in src/middleware.ts, so canOpenAdmin, the section gate and
  // the 2FA gate were all absent; and the AquinTutor partner/teacher/moderator scopes that the
  // middleware bounces off /admin reached this URL unimpeded.
  //
  // `payments.refund` is held by super_admin and hr — which is exactly who /admin/finance, the only
  // page that calls this endpoint, has always admitted. The capability records that policy; it does
  // not change it.
  const denied = await denyAdminApi(locals, { permission: 'payments.refund', label: 'payments.refund' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const paymentRowId = (body.paymentRowId || '').toString().trim();
  const reason = (body.reason || '').toString().trim().slice(0, 500) || null;
  const amountPaise = body.amountPaise != null ? Number(body.amountPaise) : undefined;
  if (!paymentRowId) return json({ ok: false, error: 'paymentRowId required' }, 400);

  // THE COLUMN IS amount_paise, AND IT ALWAYS WAS.
  //
  // This selected `amount`. Nothing in this codebase creates that column and nothing writes it —
  // every INSERT INTO payments in the product (create-order, start-application-fee, wallet-recharge,
  // fee-waiver, account-credit, the AquinTutor enrolment starts) names amount_paise, and every other
  // read of the figure — applyPaidEffects, /admin/finance, the partnership screen — reads
  // amount_paise. These two refund endpoints were the only readers of `amount` anywhere.
  //
  // It also fixed the UNIT. Razorpay hands refund.amount back in PAISE, and the partial-refund test
  // below compared that against a value this file believed to be an amount in rupees. A refund of
  // INR 100 against a payment of INR 500 compared 10000 with 500, decided 10000 was not smaller, and
  // wrote status 'refunded' on a payment that is four fifths unrefunded. Both sides are paise now, so
  // the comparison means what it reads.
  const pay = rows(await db.execute(sql`
    SELECT id, razorpay_payment_id, status, amount_paise, currency, reference_type, reference_id
    FROM payments WHERE id = ${paymentRowId} LIMIT 1
  `))[0] as any;
  if (!pay) return json({ ok: false, error: 'payment not found' }, 404);
  if (!pay.razorpay_payment_id) return json({ ok: false, error: 'this payment has no razorpay_payment_id (was not captured via Razorpay)' }, 400);
  // 'partially_refunded' WAS NOT TERMINAL AND HAD TO BE. Only the fully-refunded state was refused,
  // so a payment already part-refunded could be part-refunded again, and again: each pass overwrote
  // refund_amount with the LATEST refund rather than the running total, so the books recorded the
  // smallest of them while the gateway had sent all of them. Razorpay refuses to over-refund, which
  // is the only thing that ever stopped it — and that is a supplier's guard, not ours.
  if (pay.status === 'refunded' || pay.status === 'partially_refunded') {
    return json({
      ok: false,
      error: 'This payment is already recorded as ' + String(pay.status).replace('_', ' ')
        + '. A second refund against it is not issued from here, because this record keeps one refund '
        + 'amount and would overwrite the first. Check the Razorpay dashboard for what has already '
        + 'gone back before refunding anything more.',
    }, 409);
  }

  // AN ADMIN CANNOT REFUND MORE THAN WAS PAID. Razorpay refuses an over-refund, so this was a 502
  // with a supplier's error message in it rather than a wrong refund — but the guard belongs here,
  // where the number the operator typed can be named back to them.
  const paidPaise = Number(pay.amount_paise) || 0;
  if (amountPaise != null && Number.isFinite(amountPaise) && amountPaise > paidPaise) {
    return json({
      ok: false,
      error: 'That is more than this payment was for (' + paidPaise + ' paise). Nothing was refunded.',
    }, 400);
  }

  const result = await refundPayment({
    paymentId: pay.razorpay_payment_id,
    amountPaise: amountPaise && amountPaise > 0 ? amountPaise : undefined,
    notes: { reason: reason || 'Admin refund', adminUserId: user.id, adminEmail: user.email || '' },
  });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);

  const refund = result.refund;
  try {
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id VARCHAR(64)`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount BIGINT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
  } catch (_) {}

  await db.execute(sql`
    UPDATE payments
    SET status = ${refund?.amount && refund.amount < paidPaise ? 'partially_refunded' : 'refunded'},
        refund_id = ${refund?.id || null},
        refund_amount = ${refund?.amount || paidPaise},
        refunded_at = NOW(),
        refund_reason = ${reason},
        refunded_by_user_id = ${user.id}
    WHERE id = ${paymentRowId}
  `);

  try {
    await logAudit({
      userId: user.id,
      action: 'payment.refund',
      entity: 'payment',
      entityId: paymentRowId,
      diff: { refundId: refund?.id, amount: refund?.amount, reason, razorpayPaymentId: pay.razorpay_payment_id },
      ipAddress: clientAddress,
    });
  } catch (_) {}

  return json({ ok: true, refundId: refund?.id, amount: refund?.amount, status: refund?.status });
};
