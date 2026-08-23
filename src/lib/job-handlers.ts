// src/lib/job-handlers.ts — job kinds + their delivery handlers (Prompt AP6). Notifications are
// ENQUEUED (idempotent) and delivered by the worker (in-app + email via the Prompt-18 pipeline,
// optional push) with retries + a delivery log. enqueueNotify() is the reliable send path callers use.
import { enqueue, dedupKey, logDelivery, rateLimited, recentNotifyCount, type JobHandler } from '@/lib/job-queue';
import { HORIZON_TEMPORAL_HANDLERS } from '@/lib/horizon/temporal';

const NOTIFY_CAP_PER_HOUR = 12;

/** Reliable notification: enqueue instead of sending inline. Idempotent via a dedup key, and
 *  rate-limited per user (over the hourly cap it is DEFERRED, not dropped — avoids floods). */
export async function enqueueNotify(userId: string, n: { type: string; title: string; body?: string; link?: string; dedup?: string }): Promise<number | null> {
  const key = dedupKey('notify', [userId, n.type, n.dedup || n.title]);
  const recent = await recentNotifyCount(userId, 60).catch(() => 0);
  const runAfterMs = rateLimited(recent, NOTIFY_CAP_PER_HOUR) ? 60 * 60 * 1000 : 0;   // over cap -> defer an hour
  return enqueue('notify', { userId, ...n }, { dedupKey: key, maxAttempts: 5, runAfterMs });
}
export async function enqueueGuardianAlert(minorId: string, n: { title: string; body?: string; link?: string; dedup?: string }): Promise<number | null> {
  return enqueue('notify-guardians', { minorId, ...n }, { dedupKey: dedupKey('gd', [minorId, n.dedup || n.title]), maxAttempts: 5 });
}


// -------------------------------------------------------------------------------------------------
// MAIL-PLATFORM HANDLERS
//
// THE DEFECT THESE CLOSE. src/lib/mailplatform enqueues four job kinds — mp.send_message,
// mp.campaign_batch, mp.webhook_delivery and mp.workflow_step — into the same edu_jobs table this
// registry drains. None of them had a handler. processJobs() therefore claimed each one, found no
// entry here, called fail() with "no handler for mp.send_message", and retried it with backoff until
// max_attempts before parking it in `failed`.
//
// What that looked like from outside: the API accepted a scheduled send and answered 202. The
// message was genuinely written to the queue. Then it quietly died over the following hours, and the
// only trace was a row in a table nobody reads. A campaign started, sent its first batch inline, and
// never sent the second. A webhook was queued and never delivered. A workflow run started and never
// advanced past its first node.
//
// The work these call was all already written and tested — sendStoredMessage, sendCampaignBatch,
// attemptDelivery, tick. The queue and the workers were built by different efforts and nothing
// joined them up. That join is this block.
//
// EACH HANDLER THROWS ON FAILURE, DELIBERATELY. processJobs() catches a throw, records the reason and
// retries with backoff; a handler that swallows its error and returns normally is marked `done` and
// the work is silently lost. So a result object carrying `ok: false` is converted into a throw here
// rather than being logged and dropped — that conversion is the whole contract between these
// functions and the retry machinery.
// -------------------------------------------------------------------------------------------------

/** Payload guard. A malformed payload is permanent: retrying it produces the identical failure. */
function requireFields(payload: any, fields: string[], kind: string): void {
  const missing = fields.filter((f) => !payload || typeof payload[f] !== 'string' || !payload[f]);
  if (missing.length) {
    throw new Error(`${kind}: payload is missing ${missing.join(', ')}. This job cannot succeed and will exhaust its retries.`);
  }
}

export const MAILPLATFORM_HANDLERS: Record<string, JobHandler> = {
  /** A message stored by the platform and scheduled, or retried after an inline send failed. */
  async 'mp.send_message'(payload, job) {
    requireFields(payload, ['messageId', 'orgId'], 'mp.send_message');
    const { sendStoredMessage } = await import('@/lib/mailplatform/send');
    const r = await sendStoredMessage(String(payload.messageId), String(payload.orgId));
    if (!r || (r as any).ok === false) {
      const reason = (r as any)?.error || 'send reported failure with no reason';
      await logDelivery(job.id, 'mp.send_message', 'smtp', 'retry', String(reason));
      throw new Error('mp.send_message: ' + reason);
    }
    await logDelivery(job.id, 'mp.send_message', 'smtp', 'sent', String(payload.messageId));
  },

  /**
   * One batch of a campaign. sendCampaignBatch() re-enqueues itself while work remains, so this
   * handler advances the campaign by one batch and returns; the queue drives the rest.
   */
  async 'mp.campaign_batch'(payload, job) {
    requireFields(payload, ['campaignId', 'orgId'], 'mp.campaign_batch');
    const { sendCampaignBatch } = await import('@/lib/mailplatform/campaigns');
    const r = await sendCampaignBatch(String(payload.orgId), String(payload.campaignId));
    if (!r.ok) {
      await logDelivery(job.id, 'mp.campaign_batch', 'campaign', 'retry', String(r.error || 'batch failed'));
      throw new Error('mp.campaign_batch: ' + (r.error || 'batch failed'));
    }
    // A PARTIAL BATCH IS NOT A FAILURE. Some recipients failing is normal — a suppressed address, a
    // hard bounce — and throwing here would re-send the whole batch to everybody who succeeded.
    // The per-recipient outcome is already recorded by the campaign engine.
    await logDelivery(job.id, 'mp.campaign_batch', 'campaign', r.failed > 0 ? 'partial' : 'done',
      `sent ${r.sent}, failed ${r.failed}, ${r.remaining} remaining`);
  },

  /** One attempt at one webhook delivery. attemptDelivery() schedules its own retry. */
  async 'mp.webhook_delivery'(payload, job) {
    requireFields(payload, ['deliveryId', 'orgId'], 'mp.webhook_delivery');
    const { attemptDelivery } = await import('@/lib/mailplatform/webhooks');
    const r = await attemptDelivery(String(payload.deliveryId), String(payload.orgId));
    // NOT A THROW ON FAILURE, and this is the one place that is correct. attemptDelivery() owns the
    // webhook retry schedule and re-enqueues itself with its own backoff; throwing would add the job
    // queue's retry on top of it and deliver the same webhook twice on every failure.
    await logDelivery(job.id, 'mp.webhook_delivery', 'webhook', r.ok ? 'sent' : 'retry',
      r.ok ? `status ${r.status}` : String(r.error || `status ${r.status}`));
  },

  /**
   * Advance automation runs for an organisation.
   *
   * The payload names a run, but tick() works per organisation and claims whatever is due — which is
   * correct here: a run waiting on a delay wakes when its delay elapses, not when a job says so, and
   * per-run jobs would starve any run whose own job had already been consumed.
   */
  async 'mp.workflow_step'(payload, job) {
    requireFields(payload, ['orgId'], 'mp.workflow_step');
    const { pgStore } = await import('@/lib/mailplatform/pg-store');
    const { withPublisher } = await import('@/lib/mailplatform/router');
    const { tick } = await import('@/lib/mailplatform/worker');
    const report = await tick(withPublisher({ store: pgStore }, 0), { orgId: String(payload.orgId) });
    if (report.errors.length) {
      await logDelivery(job.id, 'mp.workflow_step', 'automation', 'retry', report.errors.slice(0, 3).join('; '));
      throw new Error('mp.workflow_step: ' + report.errors[0]);
    }
    await logDelivery(job.id, 'mp.workflow_step', 'automation', 'done',
      `advanced ${report.advanced.length}, claimed ${report.claimed}`);
  },
};

const CORE_HANDLERS: Record<string, JobHandler> = {
  async notify(payload, job) {
    const { notify } = await import('@/lib/edu-notify');
    await notify(String(payload.userId), { type: payload.type || 'general', title: payload.title, body: payload.body, link: payload.link });
    await logDelivery(job.id, 'notify', 'in-app+email', 'sent', String(payload.userId));
  },
  async 'notify-guardians'(payload, job) {
    const { notifyGuardians } = await import('@/lib/edu-notify');
    const n = await notifyGuardians(String(payload.minorId), { title: payload.title, body: payload.body, link: payload.link });
    await logDelivery(job.id, 'notify-guardians', 'guardian', 'sent', String(n) + ' guardians');
  },
  async push(payload, job) {
    try { const push = await import('@/lib/push'); if ((push as any).sendPush) await (push as any).sendPush(payload.userId, payload); await logDelivery(job.id, 'push', 'push', 'sent'); }
    catch (e: any) { await logDelivery(job.id, 'push', 'push', 'skip', e?.message || 'push unavailable'); }
  },
};

/**
 * THE ONE REGISTRY THE WORKER DRAINS.
 *
 * Every kind anything enqueues into edu_jobs must appear here. It is not a convention: the queue
 * accepts any string as a kind, so a kind with no entry is accepted, retried to exhaustion and
 * parked in `failed` — which is exactly how four mail-platform kinds spent their existence.
 * src/lib/job-handlers.test.ts scans the repository for enqueue() call sites and fails if one names
 * a kind that is not a key of this object, so the gap cannot reopen silently.
 */
export const HANDLERS: Record<string, JobHandler> = {
  ...CORE_HANDLERS,
  ...MAILPLATFORM_HANDLERS,
  // PATCH 07 Time Intelligence. Additive: the module owns its own kinds and this file only composes
  // them, so the patch can change its handlers without this registry being edited again.
  ...HORIZON_TEMPORAL_HANDLERS,
};

/** Every kind the worker can process. Exported so a route can refuse to enqueue an unknown one. */
export const HANDLED_KINDS: readonly string[] = Object.keys(HANDLERS);

/**
 * Is there a worker for this kind.
 *
 * Call this BEFORE answering 202 to anything. A queued job with no handler is a promise the system
 * cannot keep, and the caller finds out hours later — or never.
 */
export function hasHandler(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}
