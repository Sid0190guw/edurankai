// src/lib/mailplatform/queue-observability.ts — queue depth, rates, ages, dead letters and the four
// alerts the brief names (Patch 8 §3).
//
// IT MEASURES THE QUEUE THIS REPOSITORY ACTUALLY HAS. That is `edu_jobs` (src/lib/job-queue.ts):
// Postgres, `FOR UPDATE SKIP LOCKED`, exponential backoff, a unique `dedup_key` for idempotency.
// Not Redis, not SQS. Building a second queue to observe would have been the wrong deliverable and
// the brief says not to rewrite core functionality.
//
// A GAP THIS MODULE FOUND, AND WHY IT IS AN ALERT RATHER THAN A FIX I APPLIED SILENTLY.
// claimBatch() flips a row to `processing` and nothing ever flips it back. If a worker is killed
// between the claim and the acknowledgement — a serverless timeout, an OOM, a deploy mid-batch —
// that row stays `processing` FOREVER. It is not pending, so no worker will claim it; it is not
// failed, so `retryFailed()` does not see it; `queueHealth()` counts it under `processing`, which on
// a healthy system is a small number that looks like work in flight. A message silently never sent,
// presenting as a healthy queue. `stalled_messages` below detects exactly this, and reclaimStalled()
// fixes it — but as an OPERATOR ACTION with a threshold the operator chooses, because the safe
// timeout depends on how long the longest legitimate job runs and this module cannot know that. Set
// it too low and a slow-but-working job is claimed twice.
//
// NO ZERO-AS-DEFAULT, ANYWHERE. Every read carries whether it succeeded. CLAUDE.md names this
// failure mode and /admin/mail/health has already been bitten by it: a queue panel that renders a
// confident `0 pending` because the COUNT threw is worse than a blank panel, because the operator
// stops looking.

import type { Labels } from './metrics';

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export interface QueueDepth {
  pending: number;
  processing: number;
  failed: number;
  done: number;
}

export interface QueueRates {
  /** Jobs created in the window, per second. */
  enqueuePerSec: number;
  /** Jobs claimed in the window, per second. The `dequeue rate` of §3. */
  dequeuePerSec: number;
  /** Jobs that reached `done` in the window, per second. The `processing rate` of §3. */
  processedPerSec: number;
  /** Jobs that exhausted max_attempts in the window, per second. */
  failedPerSec: number;
  /** Retry log entries in the window, per second. */
  retriedPerSec: number;
  windowSeconds: number;
}

export interface QueueSnapshot {
  at: string;
  windowSeconds: number;
  depth: QueueDepth;
  rates: QueueRates;
  /** Age of the oldest job still waiting to be claimed, in ms. Null when the queue is empty. */
  oldestPendingAgeMs: number | null;
  /** Age of the oldest row stuck in `processing`, in ms. This is the crashed-worker signal. */
  oldestProcessingAgeMs: number | null;
  /** Rows that exhausted their retries. `edu_jobs` has no separate DLQ table; `status='failed'` IS the dead letter. */
  deadLetterCount: number;
  /** Per-kind depth, so "the queue is backed up" can name WHICH work is backed up. */
  byKind: { kind: string; pending: number; processing: number; failed: number; oldestPendingAgeMs: number | null }[];
  /**
   * Which arms answered. An arm that failed leaves its numbers at their defaults, and those defaults
   * are meaningless — read this before reading anything above it.
   */
  read: { depth: boolean; rates: boolean; ages: boolean; byKind: boolean };
  errors: string[];
}

/** The shape a caller gets when the queue cannot be read at all. Distinct from an empty queue. */
export function unreadableSnapshot(reason: string, windowSeconds = 300): QueueSnapshot {
  return {
    at: new Date().toISOString(),
    windowSeconds,
    depth: { pending: 0, processing: 0, failed: 0, done: 0 },
    rates: { enqueuePerSec: 0, dequeuePerSec: 0, processedPerSec: 0, failedPerSec: 0, retriedPerSec: 0, windowSeconds },
    oldestPendingAgeMs: null,
    oldestProcessingAgeMs: null,
    deadLetterCount: 0,
    byKind: [],
    read: { depth: false, rates: false, ages: false, byKind: false },
    errors: [reason],
  };
}

// ---------------------------------------------------------------------------
// Alerts (pure)
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  /** What was measured, in words a person on call can act on. */
  detail: string;
  /** What to do. An alert without one is a notification. */
  action: string;
  value: number | null;
  threshold: number | null;
}

export interface QueueThresholds {
  /** Depth above which backlog is worth a warning. */
  depthWarn: number;
  depthCritical: number;
  /** Oldest pending age, ms, above which the queue is not keeping up regardless of depth. */
  oldestPendingWarnMs: number;
  oldestPendingCriticalMs: number;
  /** A row in `processing` older than this is presumed abandoned by a dead worker. */
  stalledProcessingMs: number;
  /** Dead letters above this need a human. */
  deadLetterWarn: number;
  /** Retries per second above this, AND exceeding retryStormRatio of processed, is a storm. */
  retryStormMinPerSec: number;
  retryStormRatio: number;
  /** Below this processed rate with a non-empty backlog, workers are presumed down. */
  workerIdleMinProcessedPerSec: number;
}

/**
 * Defaults sized for the deployment this runs on TODAY: one Vercel cron draining `edu_jobs` in
 * batches. They are starting points to be re-derived from a real benchmark — capacity.ts turns a
 * measured drain rate into a defensible depth threshold, and this comment is here so nobody reads
 * these as measurements.
 */
export const DEFAULT_QUEUE_THRESHOLDS: QueueThresholds = {
  depthWarn: 1000,
  depthCritical: 10000,
  oldestPendingWarnMs: 5 * 60 * 1000,
  oldestPendingCriticalMs: 30 * 60 * 1000,
  stalledProcessingMs: 15 * 60 * 1000,
  deadLetterWarn: 25,
  retryStormMinPerSec: 1,
  retryStormRatio: 0.5,
  workerIdleMinProcessedPerSec: 0.01,
};

/**
 * Evaluate the four alert classes §3 names, plus dead letters. Pure: snapshot in, alerts out, so
 * every branch is unit-testable without a queue.
 *
 * ORDERED MOST SEVERE FIRST, and a failed read produces an alert of its OWN rather than silently
 * suppressing the others. "I cannot see the queue" is an incident, not a quiet period.
 */
export function evaluateQueueAlerts(s: QueueSnapshot, t: QueueThresholds = DEFAULT_QUEUE_THRESHOLDS): Alert[] {
  const alerts: Alert[] = [];

  if (!s.read.depth || !s.read.rates || !s.read.ages) {
    alerts.push({
      id: 'queue_unreadable',
      severity: 'critical',
      title: 'Queue telemetry unreadable',
      detail: 'One or more queue reads failed, so the numbers below are defaults and not measurements: ' + (s.errors.join('; ') || 'no reason recorded'),
      action: 'Check database reachability (/api/health) before trusting any queue panel.',
      value: null,
      threshold: null,
    });
  }

  // 1. QUEUE GROWTH. Depth alone is not growth — a deep queue that is draining is fine and a shallow
  //    one that is filling is not. Both are reported, with the arrival-vs-drain comparison as the
  //    thing that says which way it is going.
  if (s.read.depth) {
    const depth = s.depth.pending;
    if (depth >= t.depthCritical) {
      alerts.push({ id: 'queue_depth_critical', severity: 'critical', title: 'Queue backlog critical', detail: depth.toLocaleString() + ' jobs pending.', action: 'Raise worker concurrency or add workers; check for a poison job kind in the per-kind table.', value: depth, threshold: t.depthCritical });
    } else if (depth >= t.depthWarn) {
      alerts.push({ id: 'queue_depth_warn', severity: 'warning', title: 'Queue backlog growing', detail: depth.toLocaleString() + ' jobs pending.', action: 'Watch the drain rate; if arrival exceeds it, scale workers before the age alert fires.', value: depth, threshold: t.depthWarn });
    }
    if (s.read.rates && s.rates.enqueuePerSec > s.rates.processedPerSec && s.depth.pending > 0) {
      const deficit = s.rates.enqueuePerSec - s.rates.processedPerSec;
      // Drain time is only meaningful while the deficit persists; it is a rate of change, not an ETA.
      alerts.push({
        id: 'queue_growth',
        severity: s.depth.pending >= t.depthWarn ? 'critical' : 'warning',
        title: 'Arrival rate exceeds drain rate',
        detail: 'Enqueue ' + s.rates.enqueuePerSec.toFixed(2) + '/s vs processed ' + s.rates.processedPerSec.toFixed(2) + '/s over the last ' + s.windowSeconds + 's — backlog is growing by ' + deficit.toFixed(2) + '/s.',
        action: 'Scale worker concurrency until processed >= enqueue. Depth will keep rising until it does.',
        value: deficit,
        threshold: 0,
      });
    }
  }

  // 2. WORKER FAILURE. The signal is work waiting and nothing being completed. Neither half alone
  //    says anything: an idle worker with an empty queue is correct behaviour.
  if (s.read.depth && s.read.rates && s.depth.pending > 0 && s.rates.processedPerSec <= t.workerIdleMinProcessedPerSec) {
    alerts.push({
      id: 'worker_failure',
      severity: 'critical',
      title: 'Workers not draining the queue',
      detail: s.depth.pending.toLocaleString() + ' jobs pending but ' + s.rates.processedPerSec.toFixed(3) + '/s completed over the last ' + s.windowSeconds + 's.',
      action: 'Check the worker cron is firing (/admin/ops cron panel) and that /api/jobs/run returns 200. On Hobby the cron is DAILY — see docs/mail-scaling.md.',
      value: s.rates.processedPerSec,
      threshold: t.workerIdleMinProcessedPerSec,
    });
  }

  // 3. STALLED MESSAGES — the crashed-worker gap described in the header.
  if (s.read.ages && s.oldestProcessingAgeMs !== null && s.oldestProcessingAgeMs > t.stalledProcessingMs) {
    alerts.push({
      id: 'stalled_messages',
      severity: 'critical',
      title: 'Jobs stuck in processing',
      detail: 'Oldest claimed-but-unacknowledged job is ' + formatAge(s.oldestProcessingAgeMs) + ' old. Nothing reclaims these: a worker that died mid-batch leaves them here permanently, and they are counted as work in flight rather than as lost.',
      action: 'Confirm no worker is legitimately running that long, then reclaim them (Reclaim stalled on /admin/mail/performance, or reclaimStalled()).',
      value: s.oldestProcessingAgeMs,
      threshold: t.stalledProcessingMs,
    });
  }

  // 4. RETRY STORM. A ratio, not a count: 50 retries against 5000 successes is noise, 50 against 60
  //    is a dependency that is down and a queue that is spending its whole budget re-failing.
  if (s.read.rates && s.rates.retriedPerSec >= t.retryStormMinPerSec) {
    const denom = s.rates.processedPerSec + s.rates.retriedPerSec;
    const ratio = denom > 0 ? s.rates.retriedPerSec / denom : 1;
    if (ratio >= t.retryStormRatio) {
      alerts.push({
        id: 'retry_storm',
        severity: 'warning',
        title: 'Retry storm',
        detail: (ratio * 100).toFixed(0) + '% of job outcomes in the last ' + s.windowSeconds + 's were retries (' + s.rates.retriedPerSec.toFixed(2) + '/s). Backoff is exponential and capped at 5 minutes, so this will not resolve itself if the dependency stays down.',
        action: 'Read the last_error column for the dominant kind; the cause is usually one dependency (SMTP relay, storage) rather than the jobs.',
        value: ratio,
        threshold: t.retryStormRatio,
      });
    }
  }

  // Oldest pending age — the SLO signal. Depth can be small while the OLDEST item is hours old, if a
  // job kind at the head keeps failing and being re-queued behind fresher work.
  if (s.read.ages && s.oldestPendingAgeMs !== null) {
    if (s.oldestPendingAgeMs >= t.oldestPendingCriticalMs) {
      alerts.push({ id: 'queue_age_critical', severity: 'critical', title: 'Oldest queued job is stale', detail: 'Oldest pending job has waited ' + formatAge(s.oldestPendingAgeMs) + '.', action: 'Recipients are waiting this long for mail. Scale workers or pause campaign enqueues to let transactional mail through.', value: s.oldestPendingAgeMs, threshold: t.oldestPendingCriticalMs });
    } else if (s.oldestPendingAgeMs >= t.oldestPendingWarnMs) {
      alerts.push({ id: 'queue_age_warn', severity: 'warning', title: 'Queue latency rising', detail: 'Oldest pending job has waited ' + formatAge(s.oldestPendingAgeMs) + '.', action: 'Compare arrival and drain rates above.', value: s.oldestPendingAgeMs, threshold: t.oldestPendingWarnMs });
    }
  }

  if (s.read.depth && s.deadLetterCount >= t.deadLetterWarn) {
    alerts.push({
      id: 'dead_letters',
      severity: 'warning',
      title: 'Dead-lettered jobs need review',
      detail: s.deadLetterCount.toLocaleString() + ' jobs exhausted their retries and will never run again without an operator.',
      action: 'Read them before requeueing: retryFailed() resets attempts for ALL of them at once, so a poison job returns with the rest.',
      value: s.deadLetterCount,
      threshold: t.deadLetterWarn,
    });
  }

  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Human age, coarse on purpose: "3h" is more readable than "3h 14m 6s" on an alert line. */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/** Metric labels for a queue series. Exported so the exposition endpoint and the screen agree. */
export function queueLabels(kind?: string): Labels {
  return kind ? { queue: 'edu_jobs', kind } : { queue: 'edu_jobs' };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const rows = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] })?.rows || []));
const reason = (e: unknown): string => {
  const err = e as { cause?: { message?: string }; message?: string };
  return String(err?.cause?.message || err?.message || 'unknown error');
};
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

/**
 * Read the queue.
 *
 * FOUR STATEMENTS, NOT FOURTEEN. On the Supabase transaction pooler a connection is the scarce
 * resource and this runs on every load of the performance screen, so depth, ages and the rate window
 * are aggregated server-side into as few round trips as the shapes allow. Each is wrapped
 * separately, because one unreadable arm must not blank the other three.
 */
export async function readQueueSnapshot(windowSeconds = 300): Promise<QueueSnapshot> {
  let db: Awaited<ReturnType<typeof ctx>>['db'];
  let sql: Awaited<ReturnType<typeof ctx>>['sql'];
  try { ({ db, sql } = await ctx()); } catch (e) { return unreadableSnapshot('database module unavailable: ' + reason(e), windowSeconds); }

  const snap = unreadableSnapshot('', windowSeconds);
  snap.errors = [];

  try {
    const r = rows(await db.execute(sql`SELECT status, COUNT(*)::int AS c FROM edu_jobs GROUP BY status`));
    const d: QueueDepth = { pending: 0, processing: 0, failed: 0, done: 0 };
    for (const row of r) {
      const k = String(row.status);
      if (k === 'pending' || k === 'processing' || k === 'failed' || k === 'done') d[k] = n(row.c);
    }
    snap.depth = d;
    snap.deadLetterCount = d.failed;
    snap.read.depth = true;
  } catch (e) { snap.errors.push('depth: ' + reason(e)); }

  try {
    const r = rows(await db.execute(sql`
      SELECT
        (SELECT EXTRACT(EPOCH FROM (now() - MIN(run_after))) FROM edu_jobs WHERE status = 'pending' AND run_after <= now()) AS oldest_pending_s,
        (SELECT EXTRACT(EPOCH FROM (now() - MIN(updated_at))) FROM edu_jobs WHERE status = 'processing') AS oldest_processing_s
    `))[0] || {};
    // MIN over an empty set is NULL, and NULL here means "nothing is waiting" — a real answer, not a
    // failed read. It must stay null rather than becoming 0, or an empty queue reports age zero and
    // an unread queue reports age zero and the screen cannot tell them apart.
    snap.oldestPendingAgeMs = r.oldest_pending_s === null || r.oldest_pending_s === undefined ? null : Math.max(0, n(r.oldest_pending_s) * 1000);
    snap.oldestProcessingAgeMs = r.oldest_processing_s === null || r.oldest_processing_s === undefined ? null : Math.max(0, n(r.oldest_processing_s) * 1000);
    snap.read.ages = true;
  } catch (e) { snap.errors.push('ages: ' + reason(e)); }

  try {
    const w = Math.max(1, Math.floor(windowSeconds));
    const r = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM edu_jobs WHERE created_at > now() - (${w} || ' seconds')::interval) AS enqueued,
        (SELECT COUNT(*)::int FROM edu_jobs WHERE status = 'done' AND updated_at > now() - (${w} || ' seconds')::interval) AS done,
        (SELECT COUNT(*)::int FROM edu_jobs WHERE status = 'failed' AND updated_at > now() - (${w} || ' seconds')::interval) AS failed,
        (SELECT COUNT(*)::int FROM edu_job_log WHERE status = 'retry' AND created_at > now() - (${w} || ' seconds')::interval) AS retried,
        (SELECT COUNT(*)::int FROM edu_job_log WHERE created_at > now() - (${w} || ' seconds')::interval) AS logged
    `))[0] || {};
    // DEQUEUE RATE IS AN APPROXIMATION AND IS LABELLED AS ONE. `edu_jobs` records no claim timestamp
    // — claimBatch() bumps updated_at, which every later transition also bumps — so the number of
    // CLAIMS in a window is not recoverable from the table. edu_job_log gets one row per finished
    // job, so log volume is the closest honest proxy: it is the rate jobs LEFT the worker, which
    // equals the claim rate in steady state and understates it during a burst.
    snap.rates = {
      enqueuePerSec: n(r.enqueued) / w,
      dequeuePerSec: n(r.logged) / w,
      processedPerSec: n(r.done) / w,
      failedPerSec: n(r.failed) / w,
      retriedPerSec: n(r.retried) / w,
      windowSeconds: w,
    };
    snap.read.rates = true;
  } catch (e) { snap.errors.push('rates: ' + reason(e)); }

  try {
    const r = rows(await db.execute(sql`
      SELECT kind,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        EXTRACT(EPOCH FROM (now() - MIN(run_after) FILTER (WHERE status = 'pending'))) AS oldest_s
      FROM edu_jobs
      WHERE status <> 'done'
      GROUP BY kind
      ORDER BY pending DESC, failed DESC
      LIMIT 25
    `));
    snap.byKind = r.map((row) => ({
      kind: String(row.kind),
      pending: n(row.pending),
      processing: n(row.processing),
      failed: n(row.failed),
      oldestPendingAgeMs: row.oldest_s === null || row.oldest_s === undefined ? null : Math.max(0, n(row.oldest_s) * 1000),
    }));
    snap.read.byKind = true;
  } catch (e) { snap.errors.push('byKind: ' + reason(e)); }

  snap.at = new Date().toISOString();
  return snap;
}

/**
 * Return abandoned `processing` rows to `pending`. The fix for the gap in the header.
 *
 * IT DOES NOT RESET `attempts`, deliberately. claimBatch() already incremented the counter when the
 * job was claimed, so a job that keeps killing its worker still walks toward max_attempts and
 * eventually dead-letters instead of cycling forever. A reclaim that reset attempts would turn one
 * poison message into an infinite loop that also looks like healthy throughput.
 *
 * Returns the ids it moved, so the operator sees exactly what was reclaimed.
 */
export async function reclaimStalled(olderThanMs = DEFAULT_QUEUE_THRESHOLDS.stalledProcessingMs): Promise<{ ok: boolean; reclaimed: number[]; error?: string }> {
  try {
    const { db, sql } = await ctx();
    const seconds = Math.max(60, Math.floor(olderThanMs / 1000));
    const r = rows(await db.execute(sql`
      UPDATE edu_jobs SET status = 'pending', run_after = now(), updated_at = now(),
        last_error = COALESCE(last_error, '') || ' [reclaimed: claimed but never acknowledged]'
      WHERE status = 'processing' AND updated_at < now() - (${seconds} || ' seconds')::interval
      RETURNING id`));
    return { ok: true, reclaimed: r.map((x) => Number(x.id)) };
  } catch (e) {
    return { ok: false, reclaimed: [], error: reason(e) };
  }
}
