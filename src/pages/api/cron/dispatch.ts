// GET/POST /api/cron/dispatch — one cron entry that fans out to every daily job.
//
// WHY THIS EXISTS. Vercel's Hobby plan allows a maximum of 2 cron jobs per project. This repo has
// seven daily/weekly jobs. Declaring all seven in vercel.json is rejected at deploy time, and the
// whole deployment fails — not just the crons. So vercel.json now declares two entries: this
// dispatcher (daily) and the weekly league settle, and the dispatcher runs the rest.
//
// PARALLEL, NOT SEQUENTIAL. A Hobby function is capped at 60s. Run sequentially, six jobs would
// blow that ceiling and the last ones would silently never run. Each task here is an independent
// HTTP call that lands in its OWN function with its own 60s budget, so the dispatcher's wall time
// is the slowest single task rather than the sum of all of them.
//
// The jobs are genuinely independent — mail polling, payment reconciliation, nudges, reminders,
// directory refresh — so there is no ordering requirement between them.
//
// EVERY OUTCOME IS REPORTED. A cron that fails quietly is worse than one that does not run, because
// nobody finds out until the thing it was maintaining has drifted. Each task's status comes back in
// the response and a failure is logged, so a broken job is visible in the Vercel cron log.
import type { APIRoute } from 'astro';

export const prerender = false;

// Hobby's ceiling. The dispatcher only waits on the fan-out, so it needs the headroom of the
// slowest task, not of all tasks combined.
export const maxDuration = 60;

/** The daily jobs, formerly seven separate cron entries in vercel.json. */
const DAILY_TASKS = [
  '/api/mail/imap-poll',
  '/api/mail/scheduled-send',
  '/api/payments/reconcile',
  '/api/aquintutor/streak-nudge',
  '/api/hiring/draft-reminders',
  '/api/cron/hei-refresh',
] as const;

// Below the function ceiling, so a hung task is abandoned while there is still time to collect and
// report the results of the ones that did finish.
const PER_TASK_TIMEOUT_MS = 50_000;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Same guard as every individual job, so the dispatcher is exactly as protected as what it calls.
function authed(request: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // cron-only path when no secret configured
  const auth = request.headers.get('authorization') || '';
  if (auth === 'Bearer ' + secret) return true;
  if (url.searchParams.get('secret') === secret) return true;
  return false;
}

async function runTask(origin: string, path: string): Promise<{ path: string; ok: boolean; status?: number; error?: string }> {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Forward the secret so the downstream job authorises. Vercel sets this header on the incoming
    // cron request when CRON_SECRET is configured; we re-send it rather than relying on it being
    // present, so a manual run with ?secret= works identically.
    if (process.env.CRON_SECRET) headers.authorization = 'Bearer ' + process.env.CRON_SECRET;

    const res = await fetch(origin + path, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(PER_TASK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[cron/dispatch] task failed', path, res.status);
      return { path, ok: false, status: res.status };
    }
    return { path, ok: true, status: res.status };
  } catch (e: any) {
    // A timeout or a network fault on one job must not take down the others, so it is caught here
    // and reported rather than thrown.
    const error = e?.name === 'TimeoutError' ? 'timed out' : String(e?.message || e);
    console.error('[cron/dispatch] task errored', path, error);
    return { path, ok: false, error };
  }
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!authed(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  // The deployment's own origin. Taken from the request so it is correct on preview deployments and
  // on the production domain alike, without needing an env var that could drift.
  const origin = url.origin;

  const started = Date.now();
  const results = await Promise.all(DAILY_TASKS.map((p) => runTask(origin, p)));
  const failed = results.filter((r) => !r.ok);

  // 207: some jobs ran, some did not. A flat 200 would make a partial failure look like a clean
  // night in the cron log, which is how a broken job goes unnoticed for weeks.
  return json(
    {
      ok: failed.length === 0,
      ran: results.length,
      failed: failed.length,
      ms: Date.now() - started,
      results,
    },
    failed.length ? 207 : 200,
  );
};

export const POST = GET;
