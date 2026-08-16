// GET /api/metrics — Prometheus text exposition for the mail subsystem (Patch 8 §11).
//
// TWO WAYS IN, AND BOTH FAIL CLOSED.
//
//   1. An operator SESSION holding `administer` on the platform — the same capability behind
//      /api/health/deep and /admin/ops, so this URL can never answer more than the page it belongs to.
//   2. A bearer token, for the scraper. Prometheus has no session and cannot get one, so a
//      session-only metrics endpoint is a metrics endpoint that is never scraped — which would make
//      §11 a decoration.
//
// THE TOKEN PATH IS THE DANGEROUS ONE AND IS WRITTEN ACCORDINGLY. /api/health/deep's header says it
// plainly: "a secret in a header is not a role, and every fail-open guard on this project was
// written as a condition that short-circuits when the secret is unset." So:
//
//   - If METRICS_TOKEN is unset or shorter than 32 characters, token auth DOES NOT EXIST. It is not
//     "allow anyone"; it is "this door is not there". An unset secret must never widen access.
//   - The comparison is length-checked first, then constant-time over the bytes. A `===` on a secret
//     leaks its prefix through timing to anyone who can measure a few thousand requests.
//   - A failed token attempt is recorded. A scraper misconfigured for a week and a probe look
//     identical in a 401 count; they do not look identical in the error log.
//
// WHAT IT DISCLOSES, AND WHY THAT NEEDS A GATE AT ALL. Volumes, failure rates, queue depth, node
// health and per-tenant labels. Together that is a traffic profile of the business and an outage map
// for an attacker. It is not public data.
//
// THE PROCESS-LOCAL CAVEAT IS IN THE OUTPUT, NOT ONLY IN THIS COMMENT. On serverless each instance
// keeps its own registry and is recycled without warning, so a single scrape sees ONE instance since
// ITS last cold start. `edurankai_mail_registry_age_seconds` is emitted for exactly that reason: a
// young registry explains a low counter, and without it a scrape after a deploy looks like a traffic
// collapse. Counters here are not cluster totals and must not be alerted on as if they were — use
// the queue and database gauges, which are read from Postgres and therefore ARE global.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac/guard';
import { getRegistry, toPrometheus, type Snapshot } from '@/lib/mailplatform/metrics';
import { GAUGES, COUNTERS } from '@/lib/mailplatform/instrument';
import { readQueueSnapshot } from '@/lib/mailplatform/queue-observability';

export const prerender = false;

// Declared before the handler that uses them: `const` is not hoisted, and that has taken pages down here.
const TEXT_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const MIN_TOKEN_LENGTH = 32;

const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { 'Content-Type': TEXT_CONTENT_TYPE, 'cache-control': 'no-store, max-age=0' } });

/** Constant-time equality. Length is compared first and separately — lengths are not secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Token check. Returns false when NO token is configured — the door does not exist rather than
 * standing open. This is the single most important line in the file.
 */
function tokenAccepted(request: Request): boolean {
  const configured = String(process.env.METRICS_TOKEN || '').trim();
  if (configured.length < MIN_TOKEN_LENGTH) return false;
  const header = request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  return timingSafeEqual(presented, configured);
}

export const GET: APIRoute = async ({ request, locals }) => {
  let allowed = false;
  let via = '';

  if (tokenAccepted(request)) { allowed = true; via = 'token'; }

  if (!allowed) {
    const user = (locals as { user?: { id?: string } } | undefined)?.user;
    if (user) {
      try {
        const gate = await can(user, 'administer', { type: 'platform' });
        allowed = gate.allow === true;
        via = 'session';
      } catch (e) {
        // A refusal that writes nothing anywhere is the incident this pattern exists to prevent:
        // the deny happened, and afterwards nobody could tell it had.
        const { trackError } = await import('@/lib/logger');
        await trackError('metrics.authz_failed', e, { userId: user?.id ?? null });
        allowed = false;
      }
    }
  }

  if (!allowed) {
    const presentedToken = (request.headers.get('authorization') || '').startsWith('Bearer ');
    if (presentedToken) {
      // A scraper misconfigured for a week and a probe look identical in a 401 count. They do not
      // look identical in the error log, so the attempt is recorded either way.
      const { trackError } = await import('@/lib/logger');
      await trackError('metrics.token_rejected', new Error('bearer token rejected'), {
        configured: String(process.env.METRICS_TOKEN || '').trim().length >= MIN_TOKEN_LENGTH,
      });
    }
    return text('# forbidden: /api/metrics requires the platform `administer` capability or a valid METRICS_TOKEN bearer token\n', 403);
  }

  try {
    const registry = getRegistry();

    // Queue gauges are read from POSTGRES, not from this process, so unlike the in-process counters
    // they are a true cluster-wide view. That distinction is stated in the HELP text because the two
    // kinds of number sit in the same scrape and an operator will otherwise treat them alike.
    const queue = await readQueueSnapshot(300);
    if (queue.read.depth) {
      const depth = registry.gauge(GAUGES.queueDepth, 'Jobs in the queue by status. Read from Postgres: cluster-wide, not process-local.');
      depth.set(queue.depth.pending, { queue: 'edu_jobs', status: 'pending' });
      depth.set(queue.depth.processing, { queue: 'edu_jobs', status: 'processing' });
      depth.set(queue.depth.failed, { queue: 'edu_jobs', status: 'failed' });
      for (const k of queue.byKind) {
        depth.set(k.pending, { queue: 'edu_jobs', status: 'pending', kind: k.kind });
        depth.set(k.failed, { queue: 'edu_jobs', status: 'failed', kind: k.kind });
      }
    }
    if (queue.read.ages) {
      // NULL means the queue is empty, which is a real answer and NOT zero age. Emitting 0 for an
      // empty queue would make "nothing is waiting" and "the head is fresh" the same series value.
      const oldest = registry.gauge(GAUGES.queueOldestAgeMs, 'Age of the oldest job. Absent when the queue is empty — an absent series and a zero mean different things here.', 'ms');
      if (queue.oldestPendingAgeMs !== null) oldest.set(queue.oldestPendingAgeMs, { queue: 'edu_jobs', state: 'pending' });
      if (queue.oldestProcessingAgeMs !== null) oldest.set(queue.oldestProcessingAgeMs, { queue: 'edu_jobs', state: 'processing' });
    }
    if (queue.read.rates) {
      const rate = registry.gauge('queue_rate_per_second', 'Queue rates over the last 300s, computed in Postgres.', 'ratio');
      rate.set(queue.rates.enqueuePerSec, { queue: 'edu_jobs', op: 'enqueue' });
      rate.set(queue.rates.processedPerSec, { queue: 'edu_jobs', op: 'processed' });
      rate.set(queue.rates.retriedPerSec, { queue: 'edu_jobs', op: 'retried' });
      rate.set(queue.rates.failedPerSec, { queue: 'edu_jobs', op: 'failed' });
    }

    // MTA node health. Emitted here rather than left to the send path because a gauge that is only
    // written when mail flows reads as "no healthy nodes" during a quiet hour — indistinguishable
    // from an outage, and `MailNodesUnhealthy` alerts on exactly this series. Derived from the
    // configured transport, which is the same thing /admin/mail/performance shows.
    try {
      const { getMailConfig } = await import('@/lib/mail');
      const { singleNodePool, poolSummary } = await import('@/lib/mailplatform/mta-pool');
      const cfg = await getMailConfig();
      const summary = poolSummary(singleNodePool({ host: cfg.smtpHost || '', port: cfg.smtpPort || 0 }), Date.now());
      // With no relay configured there is no node to be healthy about. Zero here is a true zero.
      const healthy = cfg.smtpHost ? summary.healthy : 0;
      registry.gauge(GAUGES.mtaNodesHealthy, 'Delivery nodes that are active and not held out by a circuit breaker. Derived from the configured transport on every scrape, so it is cluster-wide rather than process-local.').set(healthy);
      registry.gauge('mta_nodes_total', 'Delivery nodes configured.').set(cfg.smtpHost ? summary.total : 0);
    } catch (e) {
      // Non-fatal: the rest of the scrape is still worth serving. But it must not silently leave the
      // gauge at a stale value, so the failure is recorded rather than swallowed.
      const { trackError } = await import('@/lib/logger');
      await trackError('metrics.mta_gauge_failed', e, {});
    }

    // A scrape that could not read the queue must be distinguishable from a quiet queue. This gauge
    // is the machine-readable form of the banner the admin screen shows.
    registry.gauge('telemetry_readable', 'Whether the queue telemetry could be read this scrape. 0 means the numbers above are defaults, not measurements.')
      .set(queue.read.depth && queue.read.rates && queue.read.ages ? 1 : 0, { source: 'queue' });

    registry.gauge('registry_age_seconds', 'Seconds since this process created its metric registry. In-process COUNTERS are only meaningful relative to this — after a cold start they legitimately read near zero.', 'count')
      .set(Math.round((Date.now() - registry.createdAt) / 1000));

    const snapshots: Snapshot[] = registry.snapshot();
    const body = toPrometheus(snapshots, {
      // No hostname: it would be unbounded cardinality on serverless, where every instance is new.
      // The region and the serving commit are bounded and are what a reader actually needs to tell
      // one deploy's numbers from another's.
      region: process.env.VERCEL_REGION || undefined,
      release: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || undefined,
    });

    const header =
      '# EduRankAI Mail metrics. Counters and latency histograms are PROCESS-LOCAL (see registry_age_seconds);\n' +
      '# queue_* gauges are read from Postgres and are cluster-wide.\n' +
      (via === 'token' ? '' : '# Scraped with an operator session rather than a token.\n');
    return text(header + body, 200);
  } catch (e: unknown) {
    const { trackError } = await import('@/lib/logger');
    await trackError('metrics.render_failed', e, {});
    const err = e as { cause?: { message?: string }; message?: string };
    // A metrics endpoint that 500s silently is one a scraper will report as "down" with no reason.
    // The class of failure goes in the body as a comment, which is valid exposition and grep-able.
    return text('# error rendering metrics: ' + String(err?.cause?.message || err?.message || 'unknown').replace(/\n/g, ' ').slice(0, 200) + '\n', 503);
  }
};

/** Referenced so the counter-name catalogue stays reachable from the exposition surface. */
export const EXPOSED_COUNTERS = COUNTERS;
