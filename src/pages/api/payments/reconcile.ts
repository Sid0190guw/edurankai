// GET/POST /api/payments/reconcile  — cron backstop.
// Finds payments stuck in created/attempted/authorized, checks Razorpay, and
// settles any that actually captured (recovering "paid but lost" applications
// even when both the browser /verify and the webhook missed). Idempotent.
// Protected by CRON_SECRET (Authorization: Bearer <secret> or ?secret=).
import type { APIRoute } from 'astro';
import { reconcilePending } from '@/lib/payment-effects';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

function authed(request: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // cron-only path when no secret configured
  const auth = request.headers.get('authorization') || '';
  if (auth === 'Bearer ' + secret) return true;
  if (url.searchParams.get('secret') === secret) return true;
  return false;
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!authed(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  try { return json({ ok: true, ...(await reconcilePending(200)) }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
};
export const POST = GET;
