// GET|POST /api/cron/horizon-signals — the recurring signal sweep. PATCH 08.
//
// WHAT IT DOES. Runs every detector across every active employee, raises what the admission gate
// allows, and expires signals whose time has run out.
//
// WHY IT EXISTS. Detection that only runs when somebody opens a screen runs at the moment it is
// least useful, because a human has already noticed by then. This is the door.
//
// IT CHANGES NO ACCESS AND DECIDES NOTHING. The sweep writes signals and stops. Every one of them is
// an observation addressed to a person, and the six consequential decisions stay behind
// src/lib/ai-boundary.ts with a named human and a written reason.
//
// THE HANDLER CAME AFTER THE LIBRARY. runSignalSweep() and its tests landed first; a scheduler entry
// pointing at a route that does not work is a guaranteed nightly failure, and red an operator cannot
// act on trains them to ignore the panel.
import type { APIRoute } from 'astro';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { withCronRun } from '@/lib/observability-health';
import { runSignalSweep } from '@/lib/horizon/signal-engine';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
}

const CRON_ID = '/api/cron/horizon-signals';

async function run(request: Request, url: URL): Promise<Response> {
  // Auth outside the telemetry: an unauthorised probe must not be able to write an execution row and
  // fabricate a healthy run history for a job that never ran.
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  const dry = url.searchParams.get('dry') === '1';
  if (dry) {
    // A preview is not a run, and counting it as one would make the ops view show the sweep as having
    // executed on a day it only looked. So a dry run records no execution.
    const r = await runSignalSweep({ dryRun: true });
    return json({
      ok: r.ok,
      dryRun: true,
      error: r.error,
      employeesRead: r.employeesRead,
      eventsRead: r.eventsRead,
      truncated: r.truncated,
      candidates: r.candidates,
      refused: r.refused,
      // COUNTS AND REASONS ONLY. A JSON list of what the system has noticed about named people,
      // served from a URL, is not a thing to produce casually.
      byAction: r.byAction,
      refusalReasons: r.refusalReasons,
      detectorErrors: r.detectorErrors,
    });
  }

  return withCronRun(CRON_ID, async () => {
    const r = await runSignalSweep({ limit: 2000 });
    const raised = (r.byAction.insert || 0) + (r.byAction.reactivate || 0);
    return {
      outcome: {
        status: r.ok ? ('success' as const) : ('failed' as const),
        processed: r.employeesRead,
        detail:
          raised +
          ' raised, ' +
          (r.byAction.escalate || 0) +
          ' escalated, ' +
          (r.byAction.suppress || 0) +
          ' suppressed, ' +
          r.refused +
          ' refused, ' +
          r.expired +
          ' expired' +
          (r.truncated ? ' (event read hit its cap — the oldest events for some people were not seen)' : ''),
      },
      value: json({
        ok: r.ok,
        error: r.error,
        employeesConsidered: r.employeesConsidered,
        employeesRead: r.employeesRead,
        eventsRead: r.eventsRead,
        truncated: r.truncated,
        candidates: r.candidates,
        refused: r.refused,
        expired: r.expired,
        byAction: r.byAction,
        detectorErrors: r.detectorErrors,
      }, r.ok ? 200 : 500),
    };
  });
}

export const GET: APIRoute = ({ request, url }) => run(request, url);
export const POST: APIRoute = ({ request, url }) => run(request, url);
