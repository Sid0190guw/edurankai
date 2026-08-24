// What withDbRetry() must and must not re-run.
//
// The retry exists because the measured failure on this deployment is opening a connection, not
// answering a query (src/lib/db-timeout.ts records the numbers). That makes exactly two things
// load-bearing, and both are the kind of thing a refactor quietly inverts: it retries a TIMEOUT, and
// it retries NOTHING ELSE. A version that also retried ordinary query errors would re-run a
// statement that failed for a reason of its own; a version that retried an open circuit would turn
// the breaker into a load amplifier during the outage it exists to survive.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  withDbRetry, withDbTimeout, DbTimeoutError, DbCircuitOpenError, isDbUnavailable, dbCircuitState,
} from './db-timeout';

const never = () => new Promise<never>(() => {});
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The breaker is module-global by design, so a test that leaves it open fails the next one. Both
 * knobs are read per call precisely so a suite can do this without reloading the module.
 */
async function resetCircuit() {
  const prev = process.env.DB_CIRCUIT_COOLDOWN_MS;
  process.env.DB_CIRCUIT_COOLDOWN_MS = '1';
  await settle(5);
  dbCircuitState();
  if (prev === undefined) delete process.env.DB_CIRCUIT_COOLDOWN_MS;
  else process.env.DB_CIRCUIT_COOLDOWN_MS = prev;
  // One success closes it and clears the consecutive counter.
  await withDbTimeout(Promise.resolve(1), 'test.reset', 500);
}

describe('withDbRetry', () => {
  beforeEach(async () => { await resetCircuit(); });
  afterEach(async () => { await resetCircuit(); });

  it('does not run the work twice when the first attempt answers', async () => {
    let calls = 0;
    const r = await withDbRetry(async () => { calls++; return 'ok'; }, 'test.happy', 200, 200);
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('asks a second time when the first attempt times out, and returns the second answer', async () => {
    let calls = 0;
    const r = await withDbRetry(() => {
      calls++;
      return calls === 1 ? never() : Promise.resolve('second');
    }, 'test.retry', 30, 200);
    expect(r).toBe('second');
    expect(calls).toBe(2);
  });

  it('takes a FACTORY, so the second attempt is genuinely new work', async () => {
    // The signature is the guard here: a version taking a promise could not re-run anything, and
    // would have silently retried nothing at all.
    const seen: number[] = [];
    let n = 0;
    await withDbRetry(() => { n++; seen.push(n); return n === 1 ? never() : Promise.resolve(n); },
      'test.factory', 30, 200);
    expect(seen).toEqual([1, 2]);
  });

  it('surfaces a DbTimeoutError when BOTH attempts time out', async () => {
    let calls = 0;
    await expect(withDbRetry(() => { calls++; return never(); }, 'test.both', 20, 20))
      .rejects.toSatisfy((e: any) => isDbUnavailable(e));
    expect(calls).toBe(2);
  });

  it('does NOT retry an ordinary query error — that would re-run a failed statement', async () => {
    let calls = 0;
    const boom = new Error('column "nope" does not exist');
    await expect(withDbRetry(() => { calls++; return Promise.reject(boom); }, 'test.queryerr', 200, 200))
      .rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it('does NOT retry when the circuit is already open', async () => {
    // Open it deliberately: one timeout is enough with the threshold set to 1.
    const prev = process.env.DB_CIRCUIT_OPEN_AFTER;
    process.env.DB_CIRCUIT_OPEN_AFTER = '1';
    try {
      await withDbTimeout(never(), 'test.open', 10).catch(() => {});
      expect(dbCircuitState().open).toBe(true);
      let calls = 0;
      await expect(withDbRetry(() => { calls++; return Promise.resolve('never reached'); }, 'test.refused', 50, 50))
        .rejects.toBeInstanceOf(DbCircuitOpenError);
      // Refused without waiting AND without running the work even once.
      expect(calls).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DB_CIRCUIT_OPEN_AFTER;
      else process.env.DB_CIRCUIT_OPEN_AFTER = prev;
    }
  });

  it('a timeout is still a DbTimeoutError, so every isDbUnavailable() gate keeps working', async () => {
    const e = await withDbRetry(() => never(), 'test.shape', 20, 20).catch((x) => x);
    expect(e).toBeInstanceOf(DbTimeoutError);
    expect(isDbUnavailable(e)).toBe(true);
  });
});
