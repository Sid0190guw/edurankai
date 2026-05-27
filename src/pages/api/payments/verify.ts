// POST /api/payments/verify
// Called by the browser AFTER Razorpay checkout returns success.
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies HMAC, updates payments row, returns { ok }.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const orderId = String(body?.razorpay_order_id || '').trim();
  const paymentId = String(body?.razorpay_payment_id || '').trim();
  const signature = String(body?.razorpay_signature || '').trim();

  if (!orderId || !paymentId || !signature) {
    return json({ ok: false, error: 'missing fields' }, 400);
  }

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try {
      await db.execute(sql`
        UPDATE payments SET status = 'signature_mismatch', updated_at = NOW()
        WHERE order_id = ${orderId}
      `);
    } catch (_) {}
    return json({ ok: false, error: 'signature mismatch' }, 400);
  }

  // Defence-in-depth: ask Razorpay if the payment is actually captured.
  const remote = await fetchPayment(paymentId);
  const captured = remote && (remote.status === 'captured' || remote.status === 'authorized');

  try {
    await db.execute(sql`
      UPDATE payments SET
        razorpay_payment_id = ${paymentId},
        razorpay_signature = ${signature},
        status = ${captured ? 'paid' : 'attempted'},
        updated_at = NOW()
      WHERE order_id = ${orderId}
    `);
  } catch (e: any) {
    console.error('[payments] verify update failed:', e?.message);
  }

  // If this was an application processing/verification fee, mark the application
  // as paid so it can move forward.
  if (captured) {
    try {
      const r = await db.execute(sql`SELECT purpose, reference_type, reference_id FROM payments WHERE order_id = ${orderId} LIMIT 1`);
      const rows = Array.isArray(r) ? r : (r?.rows || []);
      const pay: any = rows[0];
      if (pay && (pay.purpose === 'application_fee' || pay.reference_type === 'application') && pay.reference_id) {
        await db.execute(sql`
          UPDATE applications SET fee_paid = true, fee_payment_id = ${paymentId}, fee_paid_at = NOW(), updated_at = NOW()
          WHERE id = ${pay.reference_id}
        `);
      } else if (pay && (pay.purpose === 'event_level' || pay.reference_type === 'event_level') && pay.reference_id) {
        // reference_id is the event_level_progress row id.
        await db.execute(sql`
          UPDATE event_level_progress SET fee_paid = true, fee_payment_id = ${paymentId}, fee_paid_at = NOW(), status = 'paid', updated_at = NOW()
          WHERE id = ${pay.reference_id}
        `);
        // Auto-issue for levels that grant an artifact on payment alone (no test gate).
        try {
          const lr = await db.execute(sql`
            SELECT elp.registration_id, elp.level_id, elp.event_id, el.auto_issue_artifact, el.test_id
            FROM event_level_progress elp JOIN event_levels el ON el.id = elp.level_id
            WHERE elp.id = ${pay.reference_id} LIMIT 1
          `);
          const lrows = Array.isArray(lr) ? lr : (lr?.rows || []);
          const prog: any = lrows[0];
          if (prog && prog.auto_issue_artifact && !prog.test_id) {
            const { issueArtifact } = await import('@/lib/issue-artifact');
            await issueArtifact({ registrationId: prog.registration_id, eventId: prog.event_id, levelId: prog.level_id, artifactType: prog.auto_issue_artifact, autoIssued: true });
          }
        } catch (e2: any) { console.error('[payments] event auto-issue failed:', e2?.message); }
      }
    } catch (e: any) {
      console.error('[payments] application fee mark failed:', e?.message);
    }
  }

  return json({ ok: true, status: captured ? 'paid' : 'attempted' });
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
