// GET/POST /api/cron/engagement-completion - THE DAILY PASS OF THE COMPLETION ENGINE.
//
// A week before an internship or contract ends, the lead is asked (web push) to review, approve or
// hold, and write a letter of recommendation. On the end date the engagement is measured; if every
// criterion passes the certificate is issued and emailed, otherwise it is held for a person with the
// reason. See src/lib/hr/completion-engine.ts. ?dry=1 reports what it would do and writes nothing.
import type { APIRoute } from 'astro';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { withCronRun } from '@/lib/observability-health';
import { runEngine } from '@/lib/hr/completion-engine';

export const prerender = false;

const CRON_ID = '/api/cron/engagement-completion';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

async function run(request: Request, url: URL): Promise<Response> {
  // Auth outside the telemetry, so an unauthorised probe cannot write a run row.
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (url.searchParams.get('dry') === '1') {
    const r = await runEngine({ dryRun: true });
    // Counts by step only. Names of people about to finish are not served from a URL.
    const byStep: Record<string, number> = {};
    for (const l of r.lines) byStep[l.step] = (byStep[l.step] || 0) + 1;
    return json({ ok: r.ok, dryRun: true, error: r.error, byStep });
  }
  return withCronRun(CRON_ID, async () => {
    const r = await runEngine({});
    const byStep: Record<string, number> = {};
    for (const l of r.lines) byStep[l.step] = (byStep[l.step] || 0) + 1;
    const failed = r.lines.filter((l) => /^Could not|not issued|not notified/i.test(l.result)).length;
    if (!r.ok) {
      return { outcome: { status: 'failed' as const, errorMessage: r.error || 'the engine did not run' }, value: json({ ok: false, error: r.error }, 500) };
    }
    return {
      outcome: {
        processed: r.lines.length,
        succeeded: r.lines.length - failed,
        failed,
        detail: Object.keys(byStep).map((k) => byStep[k] + ' ' + k).join(', ') || 'nothing due',
      },
      value: json({ ok: true, byStep }),
    };
  });
}

export const GET: APIRoute = ({ request, url }) => run(request, url);
export const POST: APIRoute = ({ request, url }) => run(request, url);
