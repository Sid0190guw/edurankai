// mail-engine/src/queue/retry.ts — when to try again, and when to stop.
//
// PREVENTING A RETRY STORM IS THE WHOLE JOB. The failure mode this guards against is not one message
// retrying too often; it is ten thousand messages all deferred by the same outage at the same
// second, all becoming due again at the same second, and hitting the recovering server hard enough
// to defer them all again. Three properties together prevent it:
//
//   1. Exponential growth      — 1m, 3m, 9m, 27m, ... so a long outage is not hammered.
//   2. A cap                   — no single wait longer than retryMaxDelayMs, so a message that could
//                                have gone out at 4am does not wait until Tuesday.
//   3. Jitter                  — ±20% by default, so the herd that was deferred together does not
//                                come back together. This is the one that actually breaks the storm.
//
// Total time in the queue matters more than the attempt count: with the defaults below, eight
// attempts spans roughly 24 hours, which is what a receiving postmaster expects before a sender
// gives up. maxAttempts is a backstop against pathological cases, not the real policy.

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  /** 0.2 = up to ±20% applied to each delay. */
  jitter: number;
}

/**
 * Delay before attempt N+1, given that N attempts have been made.
 * `rand` is injectable so the tests can assert on exact numbers instead of on ranges.
 */
export function backoffMs(policy: RetryPolicy, attemptsMade: number, rand: () => number = Math.random): number {
  const n = Math.max(0, attemptsMade);
  const raw = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, n - 1));
  const capped = Math.min(raw, policy.maxDelayMs);
  if (policy.jitter <= 0) return Math.round(capped);
  // rand() in [0,1) maps to a multiplier in [1-jitter, 1+jitter).
  const multiplier = 1 + (rand() * 2 - 1) * policy.jitter;
  return Math.max(1000, Math.round(capped * multiplier));
}

export function nextAttemptAt(policy: RetryPolicy, attemptsMade: number, now = Date.now(), rand: () => number = Math.random): number {
  return now + backoffMs(policy, attemptsMade, rand);
}

/** True when the message has run out of road and belongs in the dead-letter directory. */
export function isExhausted(policy: RetryPolicy, attemptsMade: number): boolean {
  return attemptsMade >= policy.maxAttempts;
}

/**
 * Longest possible time a message can stay in the queue under this policy, ignoring jitter. Printed
 * at startup, because "how long will you keep trying before you tell me it failed" is the first
 * question anyone asks about a mail queue and the answer should not require arithmetic.
 */
export function maximumQueueLifetimeMs(policy: RetryPolicy): number {
  let total = 0;
  for (let i = 1; i <= policy.maxAttempts; i++) {
    total += Math.min(policy.baseDelayMs * Math.pow(policy.factor, i - 1), policy.maxDelayMs);
  }
  return total;
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return rem ? `${h}h ${rem}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
