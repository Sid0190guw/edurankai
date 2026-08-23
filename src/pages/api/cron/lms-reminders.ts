// GET/POST /api/cron/lms-reminders — deadline reminders for unsubmitted coursework.
//
// A due date nobody is reminded about is a due date that catches people out, and every other part
// of this spine assumed something would send the reminder. This is that something.
//
// IDEMPOTENT BY CONSTRUCTION. A cron will run twice — Vercel retries, and a manual trigger during
// an incident is normal — and a learner must not be told twice about the same deadline. Each send
// writes a marker statement (verb `reminded`, object `reminder:<assignment>:<user>`) and the query
// skips anybody who already has one. See src/lib/lms/notify.ts.
//
// Protected by CRON_SECRET through the shared guard, which FAILS CLOSED: no secret configured means
// no caller is authorised, including the cron itself.
import type { APIRoute } from 'astro';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { sendDueReminders } from '@/lib/lms/notify';
import { withCronRun } from '@/lib/observability-health';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

async function run(request: Request, url: URL) {
  // AUTH FIRST, OUTSIDE THE TELEMETRY. An unauthorised probe must not write an execution row, or a
  // stranger with the URL can fabricate a healthy-looking run history for a job that never ran.
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'not authorised' }, 401);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') || 48)));
  return withCronRun('/api/cron/lms-reminders', async () => {
    try {
      const result = await sendDueReminders(hours);
      const processed = Number((result as any)?.considered ?? (result as any)?.sent ?? 0);
      const failed = Number((result as any)?.failed ?? 0);
      return {
        outcome: { processed, failed, succeeded: Math.max(0, processed - failed), detail: `window ${hours}h` },
        value: json({ ok: true, window_hours: hours, ...result }),
      };
    } catch (e: any) {
      // Loud, with the real Postgres reason. A reminder job that fails quietly is one nobody notices
      // until a cohort misses a deadline. The 500 is still returned; the telemetry records why.
      const reason = e?.cause?.message || e?.message;
      console.error('[cron/lms-reminders]', reason);
      return {
        outcome: { status: 'failed' as const, errorCode: e?.cause?.code, errorMessage: reason },
        value: json({ ok: false, error: reason || 'failed' }, 500),
      };
    }
  });
}

export const GET: APIRoute = async ({ request, url }) => run(request, url);
export const POST: APIRoute = async ({ request, url }) => run(request, url);
