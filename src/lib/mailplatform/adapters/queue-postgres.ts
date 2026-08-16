// src/lib/mailplatform/adapters/queue-postgres.ts — QueueProvider over Postgres.
//
// Wraps src/lib/job-queue.ts, which is already a real queue: atomic claim via
// `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, attempt counting,
// exponential backoff and a UNIQUE dedup key that makes an enqueue idempotent.
//
// It is deliberately NOT presented as broker-grade. Postgres is genuinely reliable at this volume;
// what it does not give is sub-second fan-out to hundreds of workers. When campaign volume needs
// that, a Kafka adapter implements these same five methods and ../providers.ts changes one line.

import type { EnqueueOptions, OperationResult, ProviderInfo, QueueJob, QueueProvider } from '../interfaces';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** Job kinds this platform enqueues. Named here so a worker and a producer cannot drift apart. */
export const MAIL_JOB_KINDS = {
  sendMessage: 'mp.send_message',
  campaignBatch: 'mp.campaign_batch',
  campaignRecipient: 'mp.campaign_recipient',
  webhookDelivery: 'mp.webhook_delivery',
  domainVerify: 'mp.domain_verify',
  workflowStep: 'mp.workflow_step',
  inboundPoll: 'mp.inbound_poll',
} as const;

export function postgresQueue(): QueueProvider {
  return {
    info(): ProviderInfo {
      return {
        kind: 'postgres-queue',
        enabled: !!process.env.DATABASE_URL,
        detail: process.env.DATABASE_URL
          ? 'Postgres-backed queue (edu_jobs): atomic claim, retry with backoff, unique dedup key.'
          : 'DATABASE_URL is not set — nothing can be enqueued and no worker can claim.',
      };
    },

    async enqueue<T>(kind: string, payload: T, opts: EnqueueOptions = {}): Promise<OperationResult<{ id: string | null; deduped: boolean }>> {
      try {
        const { enqueue } = await import('@/lib/job-queue');
        const id = await enqueue(kind, payload, {
          dedupKey: opts.dedupKey,
          maxAttempts: opts.maxAttempts,
          runAfterMs: opts.delayMs,
        });
        // A null id means the dedup key already existed. That is SUCCESS, not failure — the work is
        // already scheduled — but the caller is told which of the two happened, because "queued" and
        // "already queued" mean different things on a retry screen.
        return { ok: true, data: { id: id === null ? null : String(id), deduped: id === null } };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'enqueue_failed' };
      }
    },

    async claim(limit = 20): Promise<QueueJob[]> {
      try {
        const { claimBatch } = await import('@/lib/job-queue');
        const jobs = await claimBatch(limit);
        return jobs.map((j) => ({
          id: String(j.id),
          kind: j.kind,
          payload: j.payload,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
        }));
      } catch (e: any) {
        console.error('[mailplatform/queue] claim failed -', causeOf(e));
        return [];
      }
    },

    async complete(jobId: string): Promise<void> {
      try {
        const { complete } = await import('@/lib/job-queue');
        await complete(Number(jobId));
      } catch (e: any) {
        // Loud. A job that ran but could not be marked done will be claimed again after its
        // visibility window and re-run — which for a send means a duplicate message. The dedup key
        // guards the common case; this line is how anyone finds out it happened at all.
        console.error('[mailplatform/queue] could not mark job', jobId, 'complete -', causeOf(e));
      }
    },

    async fail(job: QueueJob, error: string): Promise<void> {
      try {
        const { fail } = await import('@/lib/job-queue');
        await fail(
          { id: Number(job.id), kind: job.kind, payload: job.payload, attempts: job.attempts, maxAttempts: job.maxAttempts },
          error,
        );
      } catch (e: any) {
        console.error('[mailplatform/queue] could not record failure for job', job.id, '-', causeOf(e));
      }
    },

    async health() {
      try {
        const { queueHealth } = await import('@/lib/job-queue');
        return await queueHealth();
      } catch {
        return { pending: 0, processing: 0, failed: 0, done: 0 };
      }
    },
  };
}

/** Synchronous in-memory queue for tests. Runs nothing; records what would have been enqueued. */
export function memoryQueue(sink?: { kind: string; payload: unknown; dedupKey?: string }[]): QueueProvider {
  const jobs: QueueJob[] = [];
  const seen = new Set<string>();
  let nextId = 1;
  return {
    info: () => ({ kind: 'memory-queue', enabled: true, detail: 'In-memory test queue. Not durable.' }),
    async enqueue(kind, payload, opts = {}) {
      if (opts.dedupKey && seen.has(opts.dedupKey)) return { ok: true, data: { id: null, deduped: true } };
      if (opts.dedupKey) seen.add(opts.dedupKey);
      const id = String(nextId++);
      jobs.push({ id, kind, payload, attempts: 0, maxAttempts: opts.maxAttempts ?? 5 });
      sink?.push({ kind, payload, dedupKey: opts.dedupKey });
      return { ok: true, data: { id, deduped: false } };
    },
    async claim(limit = 20) {
      return jobs.splice(0, limit);
    },
    async complete() {},
    async fail() {},
    async health() {
      return { pending: jobs.length, processing: 0, failed: 0, done: 0 };
    },
  };
}
