// POST /api/admin/billing — registrar payments console (Prompt AP5b): refund a payment (real gateway
// refund + re-lock the enrolment) or grant complimentary access. Registrar-gated (manage) + audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { getGateway } from '@/lib/payment-gateway';
import { markRefunded, grantComp } from '@/lib/course-payments';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
// A REFUND IS THE ONE ACTION HERE THAT MOVES REAL MONEY, AND IT HAD NO IDEMPOTENCE AT ALL.
//
// The handler went straight to gw.refund(paymentId) without ever asking what state the payment was
// in, so pressing Refund twice issued a SECOND gateway refund against the same payment. Until today
// the button on /admin/billing looked dead on a timeout — no message, no reload, still clickable —
// which is precisely the shape that invites a second press. The client now refuses to re-enable
// itself, and this is the half that has to be true regardless of what any client does.
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'manage', { type: 'enrolment' });   // registrar; audited
  if (!gate.allow) return j({ ok: false, error: 'registrar only' }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }

  try {
    if (b.action === 'refund') {
      const paymentId = String(b.paymentId || ''); if (!paymentId) return j({ ok: false, error: 'no payment' }, 400);

      // READ THE STATE FIRST, AND REFUSE IF IT CANNOT BE READ.
      //
      // Failing CLOSED is the only defensible direction here: proceeding on an unknown state is how
      // a second refund gets issued, and the cost of refusing is that a registrar tries again in a
      // minute. Bounded because an unbounded read would hang the invocation and leave them with the
      // dead button this whole change exists to remove.
      let current: string | null = null;
      try {
        const r0: any = await withDbTimeout(
          db.execute(sql`SELECT status FROM edu_course_payments WHERE payment_id = ${paymentId} ORDER BY id DESC LIMIT 1`),
          'admin.billing.paymentStatus', 4000);
        const rows0 = Array.isArray(r0) ? r0 : (r0?.rows || []);
        if (rows0.length === 0) return j({ ok: false, error: 'No payment with that id was found. Nothing was refunded.' }, 404);
        current = String((rows0[0] as any).status || '').toLowerCase();
      } catch (e: any) {
        console.error('[admin/billing] payment status unreadable:', e?.cause?.message || e?.message);
        return j({
          ok: false,
          error: isDbUnavailable(e)
            ? 'The database did not answer, so we could not check whether this payment has already been refunded. Nothing was sent to the gateway. Try again in a moment.'
            : 'We could not check whether this payment has already been refunded. Nothing was sent to the gateway.',
        }, 503);
      }
      if (current === 'refunded' || current === 'partially_refunded') {
        return j({ ok: false, error: 'This payment is already recorded as ' + current + '. Nothing was sent to the gateway.' }, 409);
      }

      const gw = getGateway();
      const r = await gw.refund(paymentId, b.amountPaise ? Number(b.amountPaise) : undefined);
      if (!r.ok) return j({ ok: false, error: r.error || 'The gateway refused the refund. Nothing was changed.' }, 502);

      // FROM HERE THE MONEY IS GONE. A failure to record it must be shouted, not swallowed: the
      // gateway and our books now disagree, and the only thing that makes that recoverable is
      // somebody being told, with the payment id, immediately.
      try {
        await withDbTimeout(markRefunded(paymentId), 'admin.billing.markRefunded', 8000);
      } catch (e: any) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(), level: 'error', event: 'billing.refund_unrecorded',
          paymentId, reason: e?.cause?.message || e?.message || 'unknown',
        }));
        return j({
          ok: false,
          refundIssued: true,
          error: 'The refund WAS issued at the gateway, but we could not record it here, so the '
            + 'enrolment is still unlocked and this payment still reads as paid. Do not refund again. '
            + 'Payment id ' + paymentId + ' - reconcile this by hand.',
        }, 500);
      }
      return j({ ok: true });
    }
    if (b.action === 'comp') {
      if (!b.userId || !b.courseObjId) return j({ ok: false, error: 'user + course required' }, 400);
      await grantComp(String(b.userId), String(b.courseObjId), String(b.plan || 'course'), String(user.id));
      return j({ ok: true });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    // HTTP 200 for a failure meant every monitor and every status-code check read a failed refund as
    // a successful one; and e.cause is the driver's own message, which on a connection failure
    // carries the pooler hostname and the database role. The reason goes to the log.
    console.error('[admin/billing] failed:', e?.cause?.message || e?.message);
    return j({ ok: false, error: 'That action could not be completed. Nothing was changed.' }, isDbUnavailable(e) ? 503 : 500);
  }
};
