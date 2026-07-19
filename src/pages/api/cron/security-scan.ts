// POST/GET /api/cron/security-scan — Block 11: scheduled threat scan. CRON_SECRET-guarded
// (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`). The serverless replacement for a
// resident "continuous monitoring" daemon — detection latency is bounded by the cron interval.
import type { APIRoute } from 'astro';
import { runSecurityScan } from '@/lib/security';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

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
