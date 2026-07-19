// GET|POST /api/jobs/run — the background worker (Prompt AP6a). Processes a batch of due jobs (claim
// -> deliver -> complete/retry). Callable by the daily Vercel cron with ?key=CRON_SECRET, or by an
// admin (administer). Idempotent + retrying, so a repeat run never double-sends. Reports a summary.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { processJobs, queueHealth, retryFailed } from '@/lib/job-queue';
import { HANDLERS } from '@/lib/job-handlers';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

async function authorized(url: URL, locals: any): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && (url.searchParams.get('key') === secret)) return true;   // cron
  const user = locals?.user; if (!user) return false;
  return (await can(user, 'administer', { type: 'platform' })).allow;    // or an admin
}

const handle = async (url: URL, locals: any) => {
  if (!(await authorized(url, locals))) return j({ ok: false, error: 'unauthorized' }, 403);
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

export const GET: APIRoute = ({ url, locals }) => handle(url, locals);
export const POST: APIRoute = ({ url, locals }) => handle(url, locals);
