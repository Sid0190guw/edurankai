// POST /api/aquintutor/checkout — paid enrolment (Prompt AP5a). 'create' opens a gateway order for a
// plan (+ optional course); 'confirm' verifies the payment signature and, only then, marks it paid +
// UNLOCKS the enrolment. A free plan unlocks directly. Keys come from env (Razorpay) or the labelled
// sandbox — a failed/unverified payment never unlocks. Signed-in users; minor guardian-auth in AP5b.
import type { APIRoute } from 'astro';
import { getGateway, planById, amountPaise, gatewayMode, requiresGuardianAuth } from '@/lib/payment-gateway';
import { recordOrder, markPaid, markFailed, courseAccess, authorizeGuardian, paymentByOrder } from '@/lib/course-payments';
import { resolvePrincipal } from '@/lib/rbac';
import { accessSummary } from '@/lib/rbac/access';

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
      // AP5b child-safety: a minor may not pay directly — record the order needing guardian auth
      let isMinor = false; try { isMinor = accessSummary(await resolvePrincipal(user)).isMinor; } catch {}
      const needsGuardian = requiresGuardianAuth(isMinor, plan);
      const gw = getGateway();
      const res = await gw.createOrder(amountPaise(plan), 'c' + Date.now(), { userId: uid, plan: plan.id });
      if (!res.ok) return j({ ok: false, error: res.error });
      await recordOrder(uid, courseObjId, plan.id, res.order.id, res.order.amount, gw.mode, { needsGuardian });
      if (needsGuardian) return j({ ok: true, needsGuardian: true, orderId: res.order.id, message: 'A guardian must authorize this payment before it can be completed.' });
      return j({ ok: true, orderId: res.order.id, amount: res.order.amount, currency: res.order.currency, keyId: res.order.keyId, mode: gw.mode });
    }
    if (b.action === 'confirm') {
      const orderId = String(b.orderId || ''), paymentId = String(b.paymentId || 'pay_sandbox'), signature = String(b.signature || '');
      const gw = getGateway();
      if (!gw.verify(orderId, paymentId, signature)) { await markFailed(orderId).catch(() => {}); return j({ ok: false, error: 'payment could not be verified', unlocked: false }); }
      const r = await markPaid(orderId, paymentId);
      return j({ ok: r.ok, unlocked: r.ok, error: r.error });
    }
    if (b.action === 'authorize') {
      // a guardian authorizes a linked minor's pending order
      const orderId = String(b.orderId || ''); const row = await paymentByOrder(orderId);
      if (!row) return j({ ok: false, error: 'no such order' }, 404);
      const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm');
      const res = await db.execute(sql`SELECT 1 AS ok FROM rbac_guardian_links WHERE guardian_user_id = ${uid}::uuid AND minor_user_id = ${String(row.user_id)}::uuid LIMIT 1`);
      const linked = (Array.isArray(res) ? res : (res as any)?.rows || []).length > 0;
      if (!linked) return j({ ok: false, error: 'you are not the linked guardian' }, 403);
      await authorizeGuardian(orderId, uid);
      return j({ ok: true, authorized: true });
    }
    if (b.action === 'access') {
      if (!b.courseObjId) return j({ ok: false, error: 'no course' }, 400);
      return j({ ok: true, ...(await courseAccess(uid, String(b.courseObjId))) });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
