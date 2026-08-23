// GET/POST /api/cron/mailint-dispatch — the one job the integration platform needs running.
//
// Two queues, one claim pattern, one endpoint:
//   1. webhook deliveries that are due (the shipped dispatcher in src/lib/mailapi/webhooks.ts)
//   2. delayed workflow steps that are due (src/lib/mailint/router.ts)
//
// Kept together deliberately. Two crons would mean two places a stuck queue can hide, and on this
// hosting plan cron entries are scarce — Hobby schedules are daily-only, which is written up in the
// project notes. The console's "Run dispatcher now" button calls THIS endpoint, so a manual run and
// a scheduled run are the same code doing the same work.
//
// AUTHORISATION HAS TWO DOORS, BOTH CLOSED BY DEFAULT:
//   - the cron presents CRON_SECRET, checked by the shared helper that FAILS CLOSED when the secret
//     is unset (src/lib/auth/cron-auth.ts — written after four job endpoints were found admitting
//     everybody whenever the variable was missing);
//   - a signed-in administrator with `mail.manage` may run it by hand, which is what the button uses.
//
// Nothing else reaches it. `/api/` is exempt from the middleware's admin gate, so this endpoint's own
// check IS the gate.
import type { APIRoute } from 'astro';
import { withCronRun, type CronOutcome } from '@/lib/observability-health';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { dispatchWebhooks } from '@/lib/mailapi/webhooks';
import { runScheduledActions } from '@/lib/mailint/router';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

/**
 * A serverless invocation has a wall clock, and an overrun is a killed process holding claimed rows
 * until their five-minute stale window expires. The limits below leave room: 25 deliveries at a
 * 10-second timeout is the worst case the shipped dispatcher is already sized for, and it hands
 * unfinished rows back rather than leaving them claimed.
 */
const WEBHOOK_LIMIT = 25;
const STEP_LIMIT = 25;

async function run(): Promise<{ response: Response; outcome: CronOutcome }> {
  const started = Date.now();
  // Each half is independently guarded: a fault in the webhook dispatcher must not stop the delayed
  // steps, because those are messages a candidate is waiting for.
  let webhooks = { attempted: 0, delivered: 0, retried: 0, dead: 0 };
  let webhookError: string | null = null;
  try {
    webhooks = await dispatchWebhooks(WEBHOOK_LIMIT, 20_000);
  } catch (e: any) {
    webhookError = String(e?.cause?.message || e?.message || e).slice(0, 300);
    console.error('[cron/mailint-dispatch] webhook dispatch failed:', webhookError);
  }

  let steps = { claimed: 0, sent: 0, failed: 0, details: [] as string[] };
  let stepError: string | null = null;
  try {
    steps = await runScheduledActions(STEP_LIMIT);
  } catch (e: any) {
    stepError = String(e?.cause?.message || e?.message || e).slice(0, 300);
    console.error('[cron/mailint-dispatch] scheduled steps failed:', stepError);
  }

  // `ok` is false when either half FAILED — not when either half had nothing to do. A green result
  // over a broken queue is the exact failure this project keeps writing down: a script reporting
  // success proves the script ran, not that it did the work.
  const ok = !webhookError && !stepError;
  const response = json({
    ok,
    webhooks,
    steps: { claimed: steps.claimed, sent: steps.sent, failed: steps.failed },
    details: steps.details.slice(0, 20),
    errors: [webhookError, stepError].filter(Boolean),
    took_ms: Date.now() - started,
  }, ok ? 200 : 500);

  // THE OUTCOME IS RETURNED ALONGSIDE THE RESPONSE, not parsed back out of it. Both halves are
  // counted together because both are this job's work; a run that delivered every webhook and sent
  // no scheduled step is PARTIAL, and that distinction is the whole point of reporting counts
  // rather than a boolean.
  const processed = webhooks.attempted + steps.claimed;
  const failedCount = webhooks.dead + steps.failed + (webhookError ? 1 : 0) + (stepError ? 1 : 0);
  const outcome: CronOutcome = {
    status: (!ok && processed === 0) ? 'failed' : undefined,
    processed,
    succeeded: webhooks.delivered + steps.sent,
    failed: failedCount,
    detail: `webhooks ${webhooks.delivered}/${webhooks.attempted}, steps ${steps.sent}/${steps.claimed}`,
    errorMessage: [webhookError, stepError].filter(Boolean).join('; ') || undefined,
  };
  return { response, outcome };
}

// Auth is checked BEFORE the telemetry wrapper in every arm: an unauthorised probe must not be
// able to write an execution row and fabricate a healthy run history.
const CRON_ID = '/api/cron/mailint-dispatch';

export const GET: APIRoute = async ({ request, url }) => {
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  return withCronRun(CRON_ID, async () => {
    const { response, outcome } = await run();
    return { outcome, value: response };
  });
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  if (isCronAuthorized(request, url)) {
    return withCronRun(CRON_ID, async () => {
      const { response, outcome } = await run();
      return { outcome, value: response };
    });
  }
  // The console's button. Same work, same response, an administrator instead of a scheduler — and
  // it is recorded as a run of the same job, because it is one. An operator pressing dispatch and
  // the scheduler firing it do identical work, and an ops view that only saw one of them would
  // report the queue as idle while somebody was draining it by hand.
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.dispatch' });
  if (denied) return denied;
  return withCronRun(CRON_ID, async () => {
    const { response, outcome } = await run();
    return { outcome, value: response };
  });
};
