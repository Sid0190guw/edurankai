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

async function run(): Promise<Response> {
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
  return json({
    ok,
    webhooks,
    steps: { claimed: steps.claimed, sent: steps.sent, failed: steps.failed },
    details: steps.details.slice(0, 20),
    errors: [webhookError, stepError].filter(Boolean),
    took_ms: Date.now() - started,
  }, ok ? 200 : 500);
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  return run();
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  if (isCronAuthorized(request, url)) return run();
  // The console's button. Same work, same response, an administrator instead of a scheduler.
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.dispatch' });
  if (denied) return denied;
  return run();
};
