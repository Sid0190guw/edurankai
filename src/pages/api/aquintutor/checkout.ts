// POST /api/aquintutor/checkout — paid enrolment (Prompt AP5a). 'create' opens a gateway order for a
// plan (+ optional course); 'confirm' verifies the payment signature and, only then, marks it paid +
// UNLOCKS the enrolment. A free plan unlocks directly. Keys come from env (Razorpay) or the labelled
// sandbox — a failed/unverified payment never unlocks. Signed-in users; minor guardian-auth in AP5b.
import type { APIRoute } from 'astro';
import { getGateway, planById, amountPaise, gatewayMode } from '@/lib/payment-gateway';
import { recordOrder, markPaid, markFailed, courseAccess } from '@/lib/course-payments';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const uid = String(user.id);

  try {
    if (b.action === 'create') {
      const plan = planById(String(b.planId || '')); if (!plan) return j({ ok: false, error: 'unknown plan' }, 400);
      const courseObjId = b.courseObjId ? String(b.courseObjId) : null;
      if (plan.kind === 'free') { const order = 'free_' + Date.now(); await recordOrder(uid, courseObjId, plan.id, order, 0, gatewayMode()); await markPaid(order, 'free'); return j({ ok: true, free: true, unlocked: true }); }
      const gw = getGateway();
      const res = await gw.createOrder(amountPaise(plan), 'c' + Date.now(), { userId: uid, plan: plan.id });
      if (!res.ok) return j({ ok: false, error: res.error });
      await recordOrder(uid, courseObjId, plan.id, res.order.id, res.order.amount, gw.mode);
      return j({ ok: true, orderId: res.order.id, amount: res.order.amount, currency: res.order.currency, keyId: res.order.keyId, mode: gw.mode });
    }
    if (b.action === 'confirm') {
      const orderId = String(b.orderId || ''), paymentId = String(b.paymentId || 'pay_sandbox'), signature = String(b.signature || '');
      const gw = getGateway();
      if (!gw.verify(orderId, paymentId, signature)) { await markFailed(orderId).catch(() => {}); return j({ ok: false, error: 'payment could not be verified', unlocked: false }); }
      const r = await markPaid(orderId, paymentId);
      return j({ ok: true, unlocked: r.ok });
    }
    if (b.action === 'access') {
      if (!b.courseObjId) return j({ ok: false, error: 'no course' }, 400);
      return j({ ok: true, ...(await courseAccess(uid, String(b.courseObjId))) });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
