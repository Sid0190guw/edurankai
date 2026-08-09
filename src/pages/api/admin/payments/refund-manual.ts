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
import { ensureOnce } from '@/lib/ensure-once';

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

  // Six DDL round trips on every manual refund, inside a bare `catch (_) {}`, for columns that need
  // adding once — and a bootstrap failure nothing could see, followed by an UPDATE that needs those
  // columns and had no error handling of its own. Behind ensureOnce now; the write below reports its
  // own failure, which is what makes a missing column visible instead of a bare 500.
  try {
    await ensureOnce('payments.refund_columns_manual', async () => {
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id VARCHAR(64)`);
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount BIGINT`);
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_mode VARCHAR(20)`);
    });
  } catch (e: any) {
    console.error('[payments/refund-manual] refund columns could not be provisioned -', e?.cause?.message || e?.message);
  }

  // BOTH SIDES IN PAISE. refundAmount was `amountPaise` (paise) or `pay.amount` (which this file
  // believed to be rupees), and the comparison below then decided the status by comparing the two
  // against each other — so a manual entry of INR 100 against a payment of INR 500 compared 10000
  // with 500 and wrote 'refunded' on a payment four fifths of which had not been returned.
  const refundAmount = (amountPaise && amountPaise > 0) ? amountPaise : paidPaise;
  const newStatus = refundAmount < paidPaise ? 'partially_refunded' : 'refunded';
  // ONE reference, COMPUTED ONCE. `'MANUAL-' + Date.now()` was evaluated separately in the UPDATE and
  // again in the response, so the reference the operator was shown — and wrote against the bank
  // transfer they were reconciling — was a different number from the one stored on the row whenever
  // the two calls landed in different milliseconds. Nothing else anywhere carries this reference.
  const manualRef = 'MANUAL-' + Date.now();

  // GUARDED, AND THE ANSWER IS READ. The refusal above is a READ, so two operators recording the same
  // offline refund at the same moment both passed it and the second overwrote the first — and this
  // row holds ONE refund amount, so the earlier entry simply vanished. The guard is repeated on the
  // statement and zero rows back is reported instead of answered with "Marked refunded (manual)".
  let written: any[] = [];
  try {
    written = rows(await db.execute(sql`
      UPDATE payments
      SET status = ${newStatus},
          refund_id = ${manualRef},
          refund_amount = ${refundAmount},
          refunded_at = NOW(),
          refund_reason = ${'[MANUAL] ' + reason},
          refunded_by_user_id = ${user.id},
          refund_mode = 'manual'
      WHERE id = ${paymentRowId}
        AND status NOT IN ('refunded', 'partially_refunded')
      RETURNING id
    `));
  } catch (e: any) {
    console.error('[payments/refund-manual] payment', paymentRowId, 'was not marked refunded -', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'That refund could not be recorded. Nothing was changed. Try again in a moment.' }, 500);
  }
  if (written.length === 0) {
    return json({
      ok: false,
      error: 'This payment was recorded as refunded by somebody else a moment ago. Nothing was changed — check what has already gone back before recording anything more.',
    }, 409);
  }

  try {
    await logAudit({
      userId: user.id,
      action: 'payment.refund_manual',
      entity: 'payment',
      entityId: paymentRowId,
      diff: { amount: refundAmount, reason, mode: 'manual', refundId: manualRef, warning: 'No Razorpay API call — accounting-only entry' },
      ipAddress: clientAddress,
    });
  } catch (e: any) {
    // A refund written into the books by hand with nothing recording who wrote it is the entry nobody
    // can answer for later.
    console.error('[payments/refund-manual] the audit entry for', manualRef, 'on payment', paymentRowId, 'could not be written -', e?.cause?.message || e?.message);
  }

  return json({ ok: true, refundId: manualRef, amount: refundAmount, mode: 'manual' });
};
