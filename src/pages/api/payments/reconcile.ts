// GET/POST /api/payments/reconcile  — cron backstop.
// Finds payments stuck in created/attempted/authorized, checks Razorpay, and
// settles any that actually captured (recovering "paid but lost" applications
// even when both the browser /verify and the webhook missed). Idempotent.
// Protected by CRON_SECRET (Authorization: Bearer <secret> or ?secret=).
import type { APIRoute } from 'astro';
import { reconcilePending } from '@/lib/payment-effects';
import { isCronAuthorized } from '@/lib/auth/cron-auth';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// THE GUARD USED TO FAIL OPEN: `if (!secret) return true`. An absent or empty CRON_SECRET admitted
// every caller to a route that walks pending payments and settles them against the gateway.
// Replaced by the one shared, fail-closed helper (src/lib/auth/cron-auth.ts), which still accepts
// the same Bearer header and ?secret= query this endpoint already took.
export const GET: APIRoute = async ({ request, url }) => {
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  try { return json({ ok: true, ...(await reconcilePending(200)) }); }
  catch (e: any) {
    // The real Postgres/gateway reason is on e.cause; e.message is only the failed SQL.
    console.error('[payments/reconcile]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'reconcile failed' }, 500);
  }
};
export const POST = GET;
