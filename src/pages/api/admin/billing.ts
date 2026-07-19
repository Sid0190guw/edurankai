// POST /api/admin/billing — registrar payments console (Prompt AP5b): refund a payment (real gateway
// refund + re-lock the enrolment) or grant complimentary access. Registrar-gated (manage) + audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { getGateway } from '@/lib/payment-gateway';
import { markRefunded, grantComp } from '@/lib/course-payments';

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
      const gw = getGateway();
      const r = await gw.refund(paymentId, b.amountPaise ? Number(b.amountPaise) : undefined);
      if (!r.ok) return j({ ok: false, error: r.error || 'refund failed' });
      await markRefunded(paymentId);   // re-locks the enrolment
      return j({ ok: true });
    }
    if (b.action === 'comp') {
      if (!b.userId || !b.courseObjId) return j({ ok: false, error: 'user + course required' }, 400);
      await grantComp(String(b.userId), String(b.courseObjId), String(b.plan || 'course'), String(user.id));
      return j({ ok: true });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
