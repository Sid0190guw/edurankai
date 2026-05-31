// Downstream effects of a captured payment, applied idempotently. Called from
// BOTH the browser-side verify (/api/payments/verify) and the Razorpay webhook
// (/api/payments/webhook) so a payment completes even if the browser never
// returns (tab closed, network drop). Safe to run more than once per order.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export async function applyPaidEffects(orderId: string, paymentId: string | null): Promise<void> {
  if (!orderId) return;
  const pay = rows(await db.execute(sql`SELECT purpose, reference_type, reference_id FROM payments WHERE order_id = ${orderId} LIMIT 1`))[0] as any;
  if (!pay || !pay.reference_id) return;

  // Application processing/verification fee -> mark application paid AND flip
  // pending_payment -> submitted so it joins the live queue. Without this flip
  // the candidate row stays hidden under the pending tab and admins never see it.
  if (pay.purpose === 'application_fee' || pay.reference_type === 'application') {
    await db.execute(sql`
      UPDATE applications SET
        fee_paid = true,
        fee_payment_id = ${paymentId},
        fee_paid_at = NOW(),
        status = CASE WHEN status = 'pending_payment' THEN 'submitted' ELSE status END,
        updated_at = NOW()
      WHERE id = ${pay.reference_id}
    `).catch(() => {});
    return;
  }

  // 1 CHF registration/activation fee -> approve the user's account.
  if (pay.purpose === 'registration_fee' || pay.reference_type === 'user') {
    await db.execute(sql`
      UPDATE users SET reg_fee_paid = true, reg_fee_payment_id = ${paymentId}, access_status = 'approved', updated_at = NOW()
      WHERE id = ${pay.reference_id}
    `).catch(() => {});
    return;
  }

  // Event level fee -> mark the progress paid + auto-issue (no-test levels).
  if (pay.purpose === 'event_level' || pay.reference_type === 'event_level') {
    await db.execute(sql`
      UPDATE event_level_progress SET fee_paid = true, fee_payment_id = ${paymentId}, fee_paid_at = NOW(), status = 'paid', updated_at = NOW()
      WHERE id = ${pay.reference_id}
    `).catch(() => {});
    try {
      const prog = rows(await db.execute(sql`
        SELECT elp.registration_id, elp.level_id, elp.event_id, el.auto_issue_artifact, el.test_id
        FROM event_level_progress elp JOIN event_levels el ON el.id = elp.level_id
        WHERE elp.id = ${pay.reference_id} LIMIT 1
      `))[0] as any;
      if (prog && prog.auto_issue_artifact && !prog.test_id) {
        const { issueArtifact } = await import('@/lib/issue-artifact');
        await issueArtifact({ registrationId: prog.registration_id, eventId: prog.event_id, levelId: prog.level_id, artifactType: prog.auto_issue_artifact, autoIssued: true });
      }
    } catch (_) {}
    return;
  }
}
