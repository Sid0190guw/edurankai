// GET|POST /api/cron/hr-sweep — the recurring HR sweep.
//
// WHAT IT DOES. Runs the attendance-lapse assessment across every active employee and raises a
// Level-1 flag for anyone at a warning boundary or past the lapse threshold.
//
// WHY IT EXISTS. src/lib/attendance-lapse.ts was complete, tested, and called by nothing: the
// detection only ran when a human opened a screen, which is the moment it is least useful because
// somebody has already noticed by then. This is the door.
//
// IT CHANGES NO ACCESS. The sweep raises flags and stops. Suspending a profile stays a human action
// on a human screen — see the header of src/lib/hr/scheduled.ts for why that separation is
// load-bearing rather than timid.
//
// THE HANDLER CAME FIRST. A scheduler entry pointing at a route that does not work is a guaranteed
// nightly failure, and red an operator cannot act on trains them to ignore the panel. The library
// function and its tests landed before this file, and this file landed before the vercel.json entry.
import type { APIRoute } from 'astro';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { withCronRun } from '@/lib/observability-health';
import { runAttendanceLapseSweep } from '@/lib/hr/scheduled';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

const CRON_ID = '/api/cron/hr-sweep';

async function run(request: Request, url: URL): Promise<Response> {
  // Auth outside the telemetry: an unauthorised probe must not be able to write an execution row
  // and fabricate a healthy run history for a job that never ran.
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  // A dry run reports what the sweep WOULD raise and writes nothing. It records no execution
  // either — a preview is not a run, and counting it as one would make the ops view show the sweep
  // as having executed on a day it only looked.
  const dry = url.searchParams.get('dry') === '1';
  if (dry) {
    const { assessAll } = await import('@/lib/attendance-lapse');
    const { lapseNoticesFor } = await import('@/lib/hr/scheduled');
    const { rows, error } = await assessAll();
    if (error) return json({ ok: false, dryRun: true, error }, 500);
    const notices = lapseNoticesFor(rows);
    return json({
      ok: true, dryRun: true, assessed: rows.length,
      wouldRaise: notices.length,
      // Counts and day-buckets only. A JSON list of who has stopped turning up, served from a URL,
      // is not a thing to produce casually.
      byKind: notices.reduce((m: Record<string, number>, n) => { m[n.kind] = (m[n.kind] || 0) + 1; return m; }, {}),
    });
  }

  return withCronRun(CRON_ID, async () => {
    const r = await runAttendanceLapseSweep();

    if (!r.ok && r.assessed === 0) {
      // The assessment itself could not run, so nothing was examined. Reporting zero absences here
      // would be the calm zero over a failed read.
      return {
        outcome: { status: 'failed' as const, errorMessage: r.errors[0] || 'assessment did not run' },
        // `...r` carries SweepReport.ok, which is already false on this branch. Writing
        // `{ ok: false, ...r }` would put the literal BEFORE the spread and let r.ok
        // silently overwrite it — a shape that reads as a guarantee and is not one.
        value: json({ ...r, ok: false }, 500),
      };
    }

    return {
      outcome: {
        processed: r.assessed,
        succeeded: r.assessed - r.failed,
        failed: r.failed,
        detail: `${r.raised} raised, ${r.alreadyRaised} already flagged, ${r.warned} warnings, ${r.lapsed} lapsed`,
        errorMessage: r.errors[0],
      },
      value: json({ ...r }, r.ok ? 200 : 207),
    };
  });
}

export const GET: APIRoute = ({ request, url }) => run(request, url);
export const POST: APIRoute = ({ request, url }) => run(request, url);
