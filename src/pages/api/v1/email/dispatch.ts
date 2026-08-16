// GET|POST /api/v1/email/dispatch — the transactional worker.
//
// Drains, in one invocation: scheduled sends that have come due, deferred retries, messages a dying
// process left claimed, pending and retrying webhook deliveries, and the expired idempotency and
// rate-limit rows.
//
// AUTHORISATION IS CRON_SECRET OR AN ADMIN — never an API key. A customer's key must not be able to
// drive other organizations' queues, and this endpoint does exactly that by design.
//
// HOW OFTEN IT RUNS IS A REAL CONSTRAINT AND IT IS STATED, NOT GLOSSED. Vercel's Hobby plan allows a
// cron only once per day. A once-a-day worker is fine for the housekeeping and useless for a
// deferred password reset — so an ordinary send does NOT depend on this endpoint: POST /v1/email/send
// hands the message to SMTP inside the request and returns the real outcome. This worker exists for
// scheduled sends, retries and webhook redelivery, and it should be invoked every minute or two by
// any external scheduler with ?key=CRON_SECRET. Until it is, `scheduled_at` more than a day out and
// a retry after a transient SMTP failure will be late. That is a deployment fact, not a design
// preference, and pretending otherwise would be the kind of reported-success this project has been
// bitten by before.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { dispatchMessages } from '@/lib/mailapi/send';
import { dispatchWebhooks } from '@/lib/mailapi/webhooks';
import { pruneIdempotency } from '@/lib/mailapi/idempotency';
import { pruneRateWindows } from '@/lib/mailapi/ratelimit';
import { ensureMailApiSchema, dbReason } from '@/lib/mailapi/schema';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function authorized(url: URL, request: Request, locals: any): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (url.searchParams.get('key') === secret) return true;
    const auth = request.headers.get('authorization') || '';
    if (auth === 'Bearer ' + secret) return true;
  }
  const user = locals?.user;
  if (!user) return false;
  try {
    return (await can(user, 'administer', { type: 'platform' })).allow;
  } catch {
    return false;
  }
}

const handle = async (url: URL, request: Request, locals: any) => {
  if (!(await authorized(url, request, locals))) return json({ ok: false, error: 'unauthorized' }, 403);
  const started = Date.now();
  const budgetMs = Math.min(45_000, Math.max(5_000, Number(url.searchParams.get('budget_ms')) || 25_000));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));

  try {
    await ensureMailApiSchema();
    // Messages first: a delivery event is worth more to a customer than a webhook about an older one.
    const messages = await dispatchMessages(limit, Math.floor(budgetMs * 0.6));
    const webhooks = await dispatchWebhooks(limit, Math.max(2000, budgetMs - (Date.now() - started)));
    const housekeeping = url.searchParams.get('prune') === 'false'
      ? null
      : { idempotency_rows_expired: await pruneIdempotency(), rate_windows_pruned: await pruneRateWindows() };

    return json({ ok: true, duration_ms: Date.now() - started, messages, webhooks, housekeeping });
  } catch (e: any) {
    // Reported as a failure with the real reason. A worker that answers `ok: true` while its queue
    // grows is worse than one that is plainly broken.
    console.error('[mailapi] dispatch failed:', dbReason(e));
    return json({ ok: false, error: dbReason(e), duration_ms: Date.now() - started }, 500);
  }
};

export const GET: APIRoute = ({ url, request, locals }) => handle(url, request, locals);
export const POST: APIRoute = ({ url, request, locals }) => handle(url, request, locals);
