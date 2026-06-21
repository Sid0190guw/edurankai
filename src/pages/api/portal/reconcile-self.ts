// POST /api/portal/reconcile-self
// Runs the "settle my paid-but-pending orders" reconcile for the signed-in user
// in the BACKGROUND (called client-side after the portal loads) so page render is
// never blocked on Razorpay API round-trips. Returns { ok, n } where n is how many
// orders were settled — the client reloads only when n > 0.
import type { APIRoute } from 'astro';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const { reconcileUserPending } = await import('@/lib/payment-effects');
    const n = await reconcileUserPending(user.id);
    return json({ ok: true, n: Number(n) || 0 });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.cause?.message || e?.message || e) }, 500);
  }
};
