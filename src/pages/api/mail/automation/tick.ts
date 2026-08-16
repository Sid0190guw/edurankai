// GET/POST /api/mail/automation/tick — the scheduled URL that moves the engine forward.
//
// This is the whole "worker". It emits due scheduled events, claims every run whose wait has ended,
// and advances each one. It holds nothing between invocations, which is why a 24-hour delay works on
// a platform where no process lives longer than a request.
//
// PROTECTED BY CRON_SECRET, FAILING CLOSED. It is the URL that makes the platform send mail on a
// timetable, so an open one is an anonymous send button. cronAuth() trims the configured value
// (a pasted newline has broken this project's deploys before) and compares in constant time; with
// no secret configured NOTHING runs, visibly, rather than the endpoint standing open. That trade is
// the same one /api/mail/scheduled-send makes and it is stated on /admin/mail/automation.
//
// Hobby-tier crons on this project are daily-only, so the vercel.json entry runs this once a day.
// A 24-hour delay resolved at 09:00 therefore fires on the next daily pass, not at 09:00 sharp —
// said plainly here and on the admin page, because an operator who believes otherwise will report a
// reminder as broken. Run it more often by calling this URL from any scheduler with the secret.
import type { APIRoute } from 'astro';
import { cronAuth } from '@/lib/auth/cron-auth';
import { pgStore } from '@/lib/mailplatform/pg-store';
import { ORG_ID } from '@/lib/mailplatform/service';
import { tick } from '@/lib/mailplatform/worker';
import { withPublisher } from '@/lib/mailplatform/router';
import { reasonOf } from '@/lib/mailplatform/errors';

const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const GET: APIRoute = async ({ request, url }) => {
  const gate = cronAuth(request, url);
  if (!gate.allowed) {
    // Two different facts, and an operator needs to tell them apart: a deployment that never had
    // the secret, and a caller sending the wrong one.
    return json({
      ok: false,
      error: gate.reason === 'not-configured'
        ? 'CRON_SECRET is not set on this deployment, so no automation runs. Nothing has been lost — every waiting run keeps its appointment and continues once the secret is set.'
        : 'unauthorized',
    }, 401);
  }
  try {
    const limit = Math.min(500, Number(url.searchParams.get('limit') || 100) || 100);
    const report = await tick(withPublisher({ store: pgStore }, 0), { orgId: ORG_ID, limit });
    return json({
      ok: true,
      scheduled_events: report.scheduledEvents,
      claimed: report.claimed,
      // Never implied to be "all of them". moreDue true means the limit was hit and there is more
      // waiting — a tick that quietly did the first hundred and reported success would look the same.
      more_due: report.moreDue,
      advanced: report.advanced.map((a) => ({ run_id: a.runId, state: a.state, stopped: a.stopped, steps: a.steps.length })),
      errors: report.errors,
    });
  } catch (e: any) {
    console.error('[api/mail/automation/tick]', reasonOf(e));
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};

export const POST = GET;
