// POST/GET /api/cron/security-scan — Block 11: scheduled threat scan. CRON_SECRET-guarded
// (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`). The serverless replacement for a
// resident "continuous monitoring" daemon — detection latency is bounded by the cron interval.
import type { APIRoute } from 'astro';
import { runSecurityScan } from '@/lib/security';
import { isCronAuthorized } from '@/lib/auth/cron-auth';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// THE GUARD USED TO FAIL OPEN in a spelling that does not match a grep for `if (!secret) return
// true`: the `secret &&` prefix meant that when CRON_SECRET was absent or empty the whole condition
// short-circuited to false and EVERY caller was admitted — and running the security scan then
// returned its findings to them.
//
// It now uses the one shared, fail-closed helper (src/lib/auth/cron-auth.ts), which still accepts
// all three shapes this endpoint accepted: Bearer header, x-cron-secret header, ?secret=/?key=.
const handler: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  if (!isCronAuthorized(request, url)) return j({ ok: false, error: 'unauthorized' }, 401);
  const windowMinutes = Math.min(1440, Math.max(5, Number(url.searchParams.get('window')) || 60));
  const result = await runSecurityScan(windowMinutes);
  // ok REFLECTS WHETHER THE SCAN COULD SEE, not merely whether it ran.
  //
  // `ok: true, inserted: 0` used to be the answer when every source read had failed — the scan had
  // looked at nothing and reported no threats, and the cron inventory on /admin/ops recorded a
  // healthy run. A monitor cannot tell a quiet night from a blind one unless this line does.
  return j({
    ok: result.complete,
    ...result,
    ...(result.complete ? {} : {
      error: 'Scan incomplete: ' + result.sourcesFailed.join(', ') + ' could not be read. '
        + 'The zero below is the number of signals RAISED, not a finding that there were none.',
    }),
  }, result.complete ? 200 : 503);
};

export const POST = handler;
export const GET = handler;   // Vercel Cron issues GET
