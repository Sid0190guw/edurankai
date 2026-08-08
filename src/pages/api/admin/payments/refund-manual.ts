// POST /api/admin/payments/refund-manual
// Body: { paymentRowId, reason, amountPaise? }
// Marks a payment row as refunded in our books WITHOUT calling Razorpay.
// Use when: refund was processed offline (bank transfer), Razorpay refund
// window has lapsed, or the Razorpay API is rejecting the refund and the
// money was returned through another channel. Audit-logged.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  // Same capability as the gateway refund, deliberately. This one does not call Razorpay, but it
  // writes the books to say a refund happened — and a payment marked refunded that never was is a
  // finance record nobody can trust. See refund.ts for why `role !== 'applicant'` was not a gate.
  const denied = await denyAdminApi(locals, { permission: 'payments.refund', label: 'payments.refund-manual' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const paymentRowId = (body.paymentRowId || '').toString().trim();
  const reason = (body.reason || '').toString().trim().slice(0, 500);
  const amountPaise = body.amountPaise != null ? Number(body.amountPaise) : undefined;
  if (!paymentRowId) return json({ ok: false, error: 'paymentRowId required' }, 400);
  if (!reason || reason.length < 10) return json({ ok: false, error: 'reason required (min 10 chars) — this is a manual refund without API verification' }, 400);

  // amount_paise, NOT amount — see the note in refund.ts. Nothing in this codebase creates or writes
  // a `payments.amount` column; every row is inserted with amount_paise and every other reader reads
  // it. These two endpoints were the only two that named `amount`.
  const pay = rows(await db.execute(sql`SELECT id, amount_paise, status FROM payments WHERE id = ${paymentRowId} LIMIT 1`))[0] as any;
  if (!pay) return json({ ok: false, error: 'payment not found' }, 404);
  // A PART-REFUNDED PAYMENT IS ALSO ALREADY REFUNDED, for this endpoint's purposes. Only the fully
  // refunded state was refused, and this path has NO gateway behind it to refuse anything: a second
  // manual entry simply overwrote refund_amount with the later figure, so a payment refunded twice
  // read in the books as refunded once, for whichever amount was typed last. There is nowhere else
  // the total is kept.
  if (pay.status === 'refunded' || pay.status === 'partially_refunded') {
    return json({
      ok: false,
      error: 'This payment is already recorded as ' + String(pay.status).replace('_', ' ')
        + '. This record holds one refund amount, so a second entry would replace the first rather '
        + 'than add to it. Nothing was changed.',
    }, 409);
  }

  const paidPaise = Number(pay.amount_paise) || 0;
  // AND IT CANNOT SAY MORE WENT BACK THAN CAME IN. There is no gateway on this path to reject it:
  // whatever is typed here becomes the finance record.
  if (amountPaise != null && Number.isFinite(amountPaise) && amountPaise > paidPaise) {
    return json({
      ok: false,
      error: 'That is more than this payment was for (' + paidPaise + ' paise). Nothing was recorded.',
    }, 400);
  }

  try {
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id VARCHAR(64)`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount BIGINT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_mode VARCHAR(20)`);
  } catch (_) {}

  // BOTH SIDES IN PAISE. refundAmount was `amountPaise` (paise) or `pay.amount` (which this file
  // believed to be rupees), and the comparison below then decided the status by comparing the two
  // against each other — so a manual entry of INR 100 against a payment of INR 500 compared 10000
  // with 500 and wrote 'refunded' on a payment four fifths of which had not been returned.
  const refundAmount = (amountPaise && amountPaise > 0) ? amountPaise : paidPaise;
  const newStatus = refundAmount < paidPaise ? 'partially_refunded' : 'refunded';

  await db.execute(sql`
    UPDATE payments
    SET status = ${newStatus},
        refund_id = ${'MANUAL-' + Date.now()},
        refund_amount = ${refundAmount},
        refunded_at = NOW(),
        refund_reason = ${'[MANUAL] ' + reason},
        refunded_by_user_id = ${user.id},
        refund_mode = 'manual'
    WHERE id = ${paymentRowId}
  `);

  try {
    await logAudit({
      userId: user.id,
      action: 'payment.refund_manual',
      entity: 'payment',
      entityId: paymentRowId,
      diff: { amount: refundAmount, reason, mode: 'manual', warning: 'No Razorpay API call — accounting-only entry' },
      ipAddress: clientAddress,
    });
  } catch (_) {}

  return json({ ok: true, refundId: 'MANUAL-' + Date.now(), amount: refundAmount, mode: 'manual' });
};
