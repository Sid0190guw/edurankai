// GET|POST /api/jobs/run — the background worker (Prompt AP6a). Processes a batch of due jobs (claim
// -> deliver -> complete/retry). Callable by the daily Vercel cron with ?key=CRON_SECRET, or by an
// admin (administer). Idempotent + retrying, so a repeat run never double-sends. Reports a summary.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { withCronRun } from '@/lib/observability-health';
import { withDbTimeout } from '@/lib/db-timeout';
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

const CRON_ID = '/api/jobs/run';

/**
 * How long the drain may keep CLAIMING new batches. Checked BETWEEN passes and never mid-batch, and
 * that distinction is the whole safety argument: declining to claim strands nothing, whereas
 * abandoning a batch in flight would leave its rows sitting in `processing` for somebody to notice.
 * Reclamation of stalled claims is a deliberate operator action on /admin/mail/performance
 * (reclaimStalled() in src/lib/mailplatform/queue-observability.ts) — this route should not be
 * manufacturing work for it.
 *
 * .github/workflows/jobs-drain.yml runs this every 15 minutes, so whatever a pass leaves behind is
 * claimed by the next run rather than lost.
 */
const DRAIN_BUDGET_MS = 8000;

/**
 * Queue counts for the answer. Bounded, because this read runs AFTER the work is done: a drain that
 * delivered everything and then hung here would be killed by the platform with its cron row still
 * reading `running` — a successful run recorded as a timeout.
 *
 * On failure it says so instead of returning zeros. `{ pending: 0 }` over a failed read is the calm
 * zero this project keeps banning: it reads as "the queue is empty".
 */
async function health(): Promise<any> {
  try {
    return await withDbTimeout(queueHealth(), 'jobs-run.queueHealth', 4000);
  } catch (e: any) {
    return { error: 'the queue counts could not be read: ' + (e?.cause?.message || e?.message || 'the database did not answer') };
  }
}

const handle = async (request: Request, url: URL, locals: any) => {
  if (!(await authorized(request, url, locals))) return j({ ok: false, error: 'unauthorized' }, 403);

  // A manual requeue is not a scheduled run, so it stays outside withCronRun: recording it would put
  // a healthy-looking execution row on the ops panel for an interval on which the drain never ran.
  if (url.searchParams.get('action') === 'retry') {
    try {
      const n = await withDbTimeout(retryFailed(), 'jobs-run.retryFailed', 6000);
      return j({ ok: true, requeued: n, health: await health() });
    } catch (e: any) {
      // Never answer "requeued" for a write that was not confirmed. The UPDATE either ran or did
      // not, and whoever pressed the button has to be able to tell which before pressing it again.
      const reason = e?.cause?.message || e?.message || 'the database did not answer';
      return j({ ok: false, error: 'The failed jobs were not confirmed requeued (' + reason + '). Nothing here is certain either way — check the queue before pressing this again.' }, 500);
    }
  }

  const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
  try {
    // WRAPPED, BECAUSE 96 INVOCATIONS A DAY WERE LEAVING NO TRACE OF THEMSELVES.
    //
    // /api/jobs/run is in CONFIGURED_CRONS and called every 15 minutes by jobs-drain.yml, and it
    // called neither withCronRun nor recordCronRun — so /admin/ops reported `never_run` for the only
    // consumer of edu_jobs, permanently, whether it was draining the queue or failing on every pass.
    return await withCronRun(CRON_ID, async () => {
      const startedAt = Date.now();
      let total = { processed: 0, done: 0, retried: 0, failed: 0 };
      let passes = 0;
      let stoppedEarly = false;
      for (let pass = 0; pass < 4; pass++) {   // drain a few batches per invocation
        const r = await processJobs(HANDLERS, limit);
        passes++;
        total = { processed: total.processed + r.processed, done: total.done + r.done, retried: total.retried + r.retried, failed: total.failed + r.failed };
        if (r.processed === 0) break;
        if (Date.now() - startedAt > DRAIN_BUDGET_MS) { stoppedEarly = true; break; }
      }
      const h = await health();
      const detail = [
        total.retried + ' retried',
        passes + ' pass(es)',
        stoppedEarly ? 'stopped on the time budget with work still queued' : '',
        h?.error ? 'queue counts unread' : '',
      ].filter(Boolean).join(', ');
      return {
        outcome: {
          // Stated by hand rather than derived: the counts alone say `success` for a drain that
          // stopped with jobs still due, and a run that did some of the work is not a complete one.
          status: stoppedEarly && total.failed === 0 ? ('partial' as const) : undefined,
          processed: total.processed,
          succeeded: total.done,
          failed: total.failed,
          detail,
        },
        // `ok` stays TRUE here on purpose: it answers "did the drain run", and it did. Jobs that
        // exhausted their retries are counted in `failed` and are on the queue for /admin/jobs to
        // show — flipping ok to false for them would paint the red box on that page with no error
        // text to put in it. What must not be silent is a run that stopped short or lost jobs, and
        // that is what `stoppedEarly`, `note` and the cron outcome above carry.
        value: j({ ok: true, ...total, passes, stoppedEarly, health: h, note: detail }),
      };
    });
  } catch (e: any) {
    // 500, NOT 200. jobs-drain.yml inspects only the status code, so the 200 this used to return
    // made a total failure of the drain print "Success." in the Actions log — 96 times a day, for
    // as long as it was broken. The `>= 500` branch there raises a warning instead.
    return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 500);
  }
};

export const GET: APIRoute = ({ request, url, locals }) => handle(request, url, locals);
export const POST: APIRoute = ({ request, url, locals }) => handle(request, url, locals);
