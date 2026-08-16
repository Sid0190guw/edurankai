// The retry curve. These numbers decide how long a temporarily-unreachable recipient waits and how
// hard a recovering server gets hit, so they are asserted exactly rather than "roughly increasing".

import { describe, it, expect } from 'vitest';
import { backoffMs, nextAttemptAt, isExhausted, maximumQueueLifetimeMs, humanDuration, type RetryPolicy } from '../src/queue/retry.js';
import { fixedRandom } from './helpers/harness.js';

/** The shipped defaults, mirrored here so a change to them fails a test rather than passing quietly. */
const policy: RetryPolicy = {
  maxAttempts: 9,
  baseDelayMs: 60_000,
  factor: 3,
  maxDelayMs: 6 * 60 * 60 * 1000,
  jitter: 0,
};

describe('backoffMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffMs(policy, 1)).toBe(60_000);        // 1m after the first failure
    expect(backoffMs(policy, 2)).toBe(180_000);       // 3m
    expect(backoffMs(policy, 3)).toBe(540_000);       // 9m
    expect(backoffMs(policy, 4)).toBe(1_620_000);     // 27m
  });

  it('never exceeds the ceiling', () => {
    // Without the cap, attempt 8 would be 60_000 * 3^7 = 131 hours.
    expect(backoffMs(policy, 8)).toBe(policy.maxDelayMs);
    expect(backoffMs(policy, 20)).toBe(policy.maxDelayMs);
  });

  it('applies jitter symmetrically around the base curve', () => {
    const jittered = { ...policy, jitter: 0.2 };
    expect(backoffMs(jittered, 2, fixedRandom(0))).toBe(144_000);    // -20%
    expect(backoffMs(jittered, 2, fixedRandom(0.5))).toBe(180_000);  // no change
    expect(backoffMs(jittered, 2, fixedRandom(1))).toBe(216_000);    // +20%
  });

  it('keeps a jittered delay at least one second', () => {
    const tiny = { ...policy, baseDelayMs: 100, jitter: 0.9 };
    expect(backoffMs(tiny, 1, fixedRandom(0))).toBeGreaterThanOrEqual(1000);
  });

  it('spreads a herd of simultaneous deferrals', () => {
    // The property that actually prevents a retry storm: a thousand messages deferred at the same
    // instant must not all become due at the same instant.
    const jittered = { ...policy, jitter: 0.2 };
    const dueTimes = new Set<number>();
    for (let i = 0; i < 1000; i++) dueTimes.add(nextAttemptAt(jittered, 3, 1_000_000));
    expect(dueTimes.size).toBeGreaterThan(500);
  });
});

describe('isExhausted', () => {
  it('stops at maxAttempts', () => {
    expect(isExhausted(policy, 8)).toBe(false);
    expect(isExhausted(policy, 9)).toBe(true);
    expect(isExhausted(policy, 10)).toBe(true);
  });
});

describe('maximumQueueLifetimeMs', () => {
  it('spans about a day with the shipped defaults', () => {
    // The number a receiving postmaster expects before a sender gives up, and the reason the default
    // is nine attempts rather than eight: eight lands at 18 hours, which abandons a recipient whose
    // server was down overnight. If a change to the policy moves this away from ~24h, that should be
    // a decision someone makes on purpose, so it fails here first.
    const hours = maximumQueueLifetimeMs(policy) / 3_600_000;
    expect(Math.round(hours)).toBe(24);
  });
});

describe('humanDuration', () => {
  it('reads the way an operator would say it', () => {
    expect(humanDuration(900)).toBe('900ms');
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(180_000)).toBe('3m');
    expect(humanDuration(3_600_000)).toBe('1h');
    expect(humanDuration(5_400_000)).toBe('1h 30m');
    expect(humanDuration(3 * 24 * 3_600_000)).toBe('3d');
  });
});
