// src/lib/job-queue.ts — reliable background jobs (Prompt AP6). A swap-ready queue INTERFACE
// (enqueue / claim / complete / fail) implemented against Postgres (a real, serverless-safe queue —
// atomic claim via UPDATE...RETURNING, retries with backoff, a dedup key for idempotency, and a
// delivery log). A dedicated broker (SQS/Redis/RabbitMQ) is the follow-up ONLY for very high volume /
// sub-second latency — this Postgres queue is genuinely reliable at normal scale; we don't claim broker
// throughput from it. Workers process delivery (in-app + email + optional push).

// ---- pure retry/backoff/idempotency (tested) ----
export function backoffMs(attempt: number): number { return Math.min(300000, 1000 * Math.pow(2, Math.max(0, attempt))); }   // 1s,2s,4s… capped 5m
export function shouldRetry(attempts: number, maxAttempts: number): boolean { return attempts < maxAttempts; }
export function dedupKey(kind: string, parts: (string | number)[]): string { return kind + ':' + parts.map(String).join(':'); }
/** The outcome for a processed job (pure): success = done; failure retries until max, then fails. */
export function jobOutcome(attempts: number, maxAttempts: number, ok: boolean): 'done' | 'retry' | 'failed' {
  if (ok) return 'done';
  return shouldRetry(attempts, maxAttempts) ? 'retry' : 'failed';
}

// ---- pure batching + rate-limiting (Prompt AP6b): don't flood a user ----
export function rateLimited(recentCount: number, maxPerWindow: number): boolean { return recentCount >= maxPerWindow; }
/** Collapse many notifications for one user into a single digest (title + body). Pure. */
export function digestSummary(items: { title: string }[]): { title: string; body: string } | null {
  if (!items || items.length === 0) return null;
  if (items.length === 1) return { title: items[0].title, body: '' };
  return { title: items.length + ' updates', body: items.slice(0, 6).map((i) => '• ' + i.title).join('\n') + (items.length > 6 ? '\n…and ' + (items.length - 6) + ' more' : '') };
}

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';
export interface Job { id: number; kind: string; payload: any; attempts: number; maxAttempts: number }

const JOB_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_jobs (
    id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', dedup_key text UNIQUE,
    status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
    run_after timestamptz NOT NULL DEFAULT now(), last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS edu_jobs_claim_idx ON edu_jobs (status, run_after)`,
  `CREATE TABLE IF NOT EXISTS edu_job_log (
    id bigserial PRIMARY KEY, job_id bigint, kind text, channel text, status text, detail text, created_at timestamptz NOT NULL DEFAULT now()
  )`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); if (!_ready) { for (const d of JOB_DDL) await db.execute(sql.raw(d)); _ready = true; } return { db, sql }; }

/** Enqueue a job. A dedup_key makes it IDEMPOTENT — a repeat enqueue is ignored (no double send). */
export async function enqueue(kind: string, payload: any, opts: { dedupKey?: string; maxAttempts?: number; runAfterMs?: number } = {}): Promise<number | null> {
  const { db, sql } = await ctx();
  const runAfter = opts.runAfterMs ? new Date(Date.now() + opts.runAfterMs) : new Date();
  const r = rows(await db.execute(sql`INSERT INTO edu_jobs (kind, payload, dedup_key, max_attempts, run_after)
    VALUES (${kind}, ${JSON.stringify(payload || {})}::jsonb, ${opts.dedupKey || null}, ${opts.maxAttempts ?? 5}, ${runAfter})
    ON CONFLICT (dedup_key) DO NOTHING RETURNING id`));
  return r[0] ? Number(r[0].id) : null;   // null => deduped (already enqueued)
}

/** Atomically claim a batch of due jobs (sets them 'processing' so no other worker takes them). */
export async function claimBatch(limit = 20): Promise<Job[]> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`UPDATE edu_jobs SET status = 'processing', attempts = attempts + 1, updated_at = now()
    WHERE id IN (SELECT id FROM edu_jobs WHERE status = 'pending' AND run_after <= now() ORDER BY id ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, payload, attempts, max_attempts`));
  return r.map((j: any) => ({ id: Number(j.id), kind: String(j.kind), payload: j.payload, attempts: Number(j.attempts), maxAttempts: Number(j.max_attempts) }));
}
export async function complete(id: number): Promise<void> { const { db, sql } = await ctx(); await db.execute(sql`UPDATE edu_jobs SET status = 'done', updated_at = now() WHERE id = ${id}`); }
/** Fail a job: retry with backoff until max_attempts, then mark failed. */
export async function fail(job: Job, error: string): Promise<void> {
  const { db, sql } = await ctx();
  if (shouldRetry(job.attempts, job.maxAttempts)) {
    await db.execute(sql`UPDATE edu_jobs SET status = 'pending', run_after = ${new Date(Date.now() + backoffMs(job.attempts))}, last_error = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${job.id}`);
  } else {
    await db.execute(sql`UPDATE edu_jobs SET status = 'failed', last_error = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${job.id}`);
  }
}
export async function logDelivery(jobId: number, kind: string, channel: string, status: string, detail = ''): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_job_log (job_id, kind, channel, status, detail) VALUES (${jobId}, ${kind}, ${channel}, ${status}, ${detail.slice(0, 300)})`);
}

export type JobHandler = (payload: any, job: Job) => Promise<void>;
/** Process a batch: claim -> run the handler for each kind -> complete or retry. Returns a summary. */
export async function processJobs(handlers: Record<string, JobHandler>, limit = 20): Promise<{ processed: number; done: number; retried: number; failed: number }> {
  const jobs = await claimBatch(limit);
  let done = 0, retried = 0, failed = 0;
  for (const job of jobs) {
    const h = handlers[job.kind];
    if (!h) { await fail(job, 'no handler for ' + job.kind); (shouldRetry(job.attempts, job.maxAttempts) ? retried++ : failed++); continue; }
    try { await h(job.payload, job); await complete(job.id); await logDelivery(job.id, job.kind, 'job', 'done'); done++; }
    catch (e: any) { const msg = e?.cause?.message || e?.message || 'error'; await fail(job, msg); await logDelivery(job.id, job.kind, 'job', 'retry', msg); (shouldRetry(job.attempts, job.maxAttempts) ? retried++ : failed++); }
  }
  return { processed: jobs.length, done, retried, failed };
}

export async function queueHealth(): Promise<{ pending: number; processing: number; failed: number; done: number }> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT status, COUNT(*)::int AS c FROM edu_jobs GROUP BY status`));
  const m: any = { pending: 0, processing: 0, failed: 0, done: 0 };
  for (const row of r) m[String(row.status)] = Number(row.c);
  return m;
}
/** Requeue failed jobs (admin recovery) — resets attempts so they run again. */
export async function retryFailed(): Promise<number> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`UPDATE edu_jobs SET status = 'pending', attempts = 0, run_after = now(), updated_at = now() WHERE status = 'failed' RETURNING id`));
  return r.length;
}
/** Count a user's recent notify jobs in a window (for rate-limiting / batching). */
export async function recentNotifyCount(userId: string, windowMinutes = 60): Promise<number> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_jobs WHERE kind = 'notify' AND payload->>'userId' = ${userId} AND created_at > now() - (${windowMinutes} || ' minutes')::interval`));
  return Number(r[0]?.c || 0);
}
export async function recentJobLog(limit = 50): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT job_id, kind, channel, status, detail, created_at FROM edu_job_log ORDER BY id DESC LIMIT ${limit}`));
}
