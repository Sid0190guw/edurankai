// GET|POST /api/jobs/run — the background worker (Prompt AP6a). Processes a batch of due jobs (claim
// -> deliver -> complete/retry). Callable by the daily Vercel cron with ?key=CRON_SECRET, or by an
// admin (administer). Idempotent + retrying, so a repeat run never double-sends. Reports a summary.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { processJobs, queueHealth, retryFailed } from '@/lib/job-queue';
import { HANDLERS } from '@/lib/job-handlers';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// THE CRON HALF ONLY ACCEPTED `?key=`, AND NOTHING SENDS THAT.
//
// Vercel Cron authenticates with `Authorization: Bearer <CRON_SECRET>`; the GitHub Actions runners
// in .github/workflows do the same. A scheduler pointed at this URL would therefore have been
// refused 403 on every run, and the fix would have looked like "the queue is broken" rather than
// "the door only opens for a query parameter". This is also the second-to-last of the divergent
// cron checks: the shared helper compares in constant time, trims a pasted newline, accepts the
// Bearer header, the x-cron-secret header AND the ?key= / ?secret= parameter this route already
// took, and — unlike four earlier local copies — refuses everybody when CRON_SECRET is unset.
async function authorized(request: Request, url: URL, locals: any): Promise<boolean> {
  if (isCronAuthorized(request, url)) return true;                      // the scheduler
  const user = locals?.user; if (!user) return false;
  return (await can(user, 'administer', { type: 'platform' })).allow;   // or an admin, by hand
}

const handle = async (request: Request, url: URL, locals: any) => {
  if (!(await authorized(request, url, locals))) return j({ ok: false, error: 'unauthorized' }, 403);
  if (url.searchParams.get('action') === 'retry') { const n = await retryFailed(); return j({ ok: true, requeued: n, health: await queueHealth() }); }
  const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
  try {
    let total = { processed: 0, done: 0, retried: 0, failed: 0 };
    for (let pass = 0; pass < 4; pass++) {   // drain a few batches per invocation
      const r = await processJobs(HANDLERS, limit);
      total = { processed: total.processed + r.processed, done: total.done + r.done, retried: total.retried + r.retried, failed: total.failed + r.failed };
      if (r.processed === 0) break;
    }
    return j({ ok: true, ...total, health: await queueHealth() });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};

export const GET: APIRoute = ({ request, url, locals }) => handle(request, url, locals);
export const POST: APIRoute = ({ request, url, locals }) => handle(request, url, locals);
