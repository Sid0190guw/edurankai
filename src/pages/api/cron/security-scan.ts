// POST/GET /api/cron/security-scan — Block 11: scheduled threat scan. CRON_SECRET-guarded
// (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`). The serverless replacement for a
// resident "continuous monitoring" daemon — detection latency is bounded by the cron interval.
import type { APIRoute } from 'astro';
import { runSecurityScan } from '@/lib/security';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// EXAMINED AND NOT CHANGED — NO CAPABILITY APPLIES (a shared secret is not a role), BUT THE GUARD
// BELOW FAILS OPEN and it is worth seeing why it is easy to miss: the `secret &&` prefix means that
// when CRON_SECRET is absent or empty the whole condition short-circuits to false and EVERY caller
// is admitted, and running the security scan then returns its findings to them. Written as a
// condition rather than a helper, it does not match a grep for `if (!secret) return true`.
//
// Same rule, four spellings: see the fuller note in src/pages/api/cron/activity-digest.ts. Decide it
// once, for all of them, with the deployed environment confirmed — this copy may not read .env*.
const handler: APIRoute = async ({ request }) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || request.headers.get('x-cron-secret') || '';
  if (secret && auth !== `Bearer ${secret}` && auth !== secret) return j({ ok: false, error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const windowMinutes = Math.min(1440, Math.max(5, Number(url.searchParams.get('window')) || 60));
  const result = await runSecurityScan(windowMinutes);
  return j({ ok: true, ...result });
};

export const POST = handler;
export const GET = handler;   // Vercel Cron issues GET
