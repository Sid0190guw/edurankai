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
  lastDbFailure, clearDbFailure,
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

  it('a COSMETIC timeout never opens the circuit, however many of them there are', async () => {
    // The whole point: three real timeouts in a row open it, three cosmetic ones must not — a colour
    // must never be able to refuse the reads a page actually renders from.
    const prev = process.env.DB_CIRCUIT_OPEN_AFTER;
    process.env.DB_CIRCUIT_OPEN_AFTER = '1';
    try {
      for (let i = 0; i < 3; i++) {
        await withDbTimeout(never(), 'test.cosmetic', 10, { cosmetic: true }).catch(() => {});
      }
      expect(dbCircuitState().open).toBe(false);
      // ...and the very next NON-cosmetic timeout still opens it, so nothing was disarmed.
      await withDbTimeout(never(), 'test.real', 10).catch(() => {});
      expect(dbCircuitState().open).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DB_CIRCUIT_OPEN_AFTER;
      else process.env.DB_CIRCUIT_OPEN_AFTER = prev;
    }
  });

  it('a cosmetic read is still REFUSED while the circuit is open', async () => {
    const prev = process.env.DB_CIRCUIT_OPEN_AFTER;
    process.env.DB_CIRCUIT_OPEN_AFTER = '1';
    try {
      await withDbTimeout(never(), 'test.open', 10).catch(() => {});
      expect(dbCircuitState().open).toBe(true);
      await expect(withDbTimeout(Promise.resolve('x'), 'test.cosmetic.refused', 50, { cosmetic: true }))
        .rejects.toBeInstanceOf(DbCircuitOpenError);
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

// -------------------------------------------------------------------------------------------------
// THE DRIVER'S OWN REASON MUST SURVIVE THE BOUND THAT STOPPED WAITING FOR IT
// -------------------------------------------------------------------------------------------------
//
// The failure this covers is not hypothetical and it is not a logging nicety. On 2026-08-24 every
// database-backed surface answered "we cannot reach the database right now" for several minutes,
// and the only sentence available anywhere -- to the visitor, in the function logs, and on
// /api/health -- was "database did not answer within 5000ms". That sentence is written by us. It is
// identical whether the pooler refused the connection, the instance ran out of disk, or the
// credentials were wrong, which is precisely why src/lib/db/index.ts carries four consecutive
// changes to one number, each diagnosed from it.
//
// The `abandoned` case is the whole point: the caller has already been handed a DbTimeoutError and
// walked away, and the real reason arrives afterwards with nobody left to tell. Before this it was
// absorbed by a settled Promise.race and lost.
describe('lastDbFailure', () => {
  beforeEach(async () => { await resetCircuit(); clearDbFailure(); });
  afterEach(async () => { await resetCircuit(); clearDbFailure(); });

  it('records the driver reason when the work rejects inside the bound', async () => {
    const e: any = new Error('write CONNECT_TIMEOUT');
    e.cause = { message: 'Max client connections reached' };
    await withDbTimeout(Promise.reject(e), 'test.raced', 500).catch(() => {});
    const f = lastDbFailure();
    expect(f?.label).toBe('test.raced');
    expect(f?.phase).toBe('raced');
    // e.cause, not e.message: the message is only the statement that failed.
    expect(f?.reason).toContain('Max client connections reached');
  });

  it('records the reason that arrives AFTER the caller was handed a timeout', async () => {
    const slowFailure = new Promise((_, rej) => setTimeout(() => {
      const e: any = new Error('CONNECT_TIMEOUT');
      e.cause = { message: 'no space left on device' };
      rej(e);
    }, 40));
    const thrown = await withDbTimeout(slowFailure, 'test.abandoned', 10).catch((x) => x);
    // The caller still gets our timeout, unchanged -- every isDbUnavailable() gate depends on it.
    expect(thrown).toBeInstanceOf(DbTimeoutError);
    expect(lastDbFailure()).toBeNull(); // nothing to report yet; the attempt is still running
    await settle(60);
    const f = lastDbFailure();
    expect(f?.phase).toBe('abandoned');
    expect(f?.reason).toContain('no space left on device');
  });

  it('never overwrites the driver reason with our own timeout or circuit error', async () => {
    const e: any = new Error('the real one');
    e.cause = { message: 'password authentication failed' };
    await withDbTimeout(Promise.reject(e), 'test.real-cause', 500).catch(() => {});
    // A later timeout, and a later refusal by the open circuit, are this file describing itself.
    const prev = process.env.DB_CIRCUIT_OPEN_AFTER;
    process.env.DB_CIRCUIT_OPEN_AFTER = '1';
    try {
      await withDbTimeout(never(), 'test.symptom', 10).catch(() => {});
      await withDbTimeout(Promise.resolve(1), 'test.refused', 50).catch(() => {});
    } finally {
      if (prev === undefined) delete process.env.DB_CIRCUIT_OPEN_AFTER;
      else process.env.DB_CIRCUIT_OPEN_AFTER = prev;
    }
    expect(lastDbFailure()?.reason).toContain('password authentication failed');
    expect(lastDbFailure()?.label).toBe('test.real-cause');
  });

  it('carries the label as a field, so a reporter need not parse it out of the prose', async () => {
    const prev = process.env.DB_CIRCUIT_OPEN_AFTER;
    process.env.DB_CIRCUIT_OPEN_AFTER = '1';
    try {
      const t = await withDbTimeout(never(), 'middleware.session', 10).catch((x) => x);
      expect(t).toBeInstanceOf(DbTimeoutError);
      expect(t.label).toBe('middleware.session');
      // That one timeout opened the circuit, so the next read is refused rather than waited out.
      const c = await withDbTimeout(Promise.resolve(1), 'admin.gate', 50).catch((x) => x);
      expect(c).toBeInstanceOf(DbCircuitOpenError);
      expect(c.label).toBe('admin.gate');
    } finally {
      if (prev === undefined) delete process.env.DB_CIRCUIT_OPEN_AFTER;
      else process.env.DB_CIRCUIT_OPEN_AFTER = prev;
    }
  });
});
