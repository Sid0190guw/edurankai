// What a fan-out of database reads must and must not do once it has started.
//
// The defect these guard is in src/lib/db-fanout.ts's header: /portal/employee released twenty-one
// reads as STARTED PROMISES, so when the circuit opened midway — when the breaker had concluded the
// database was gone and every other read in the instance was being refused without waiting — this
// page's remaining reads carried on being sent to it, occupying connections that the wedge
// diagnosis in src/lib/db-timeout.ts shows may never be given back.
//
// Two things here are load-bearing and both are the kind a refactor quietly inverts. A member must
// not be INVOKED until the scheduler decides to invoke it — a version taking promises instead of
// thunks would pass every other assertion in this file while scheduling nothing. And a wave that has
// been called off must STAY called off, including after the bound elapses, because the workers are
// still alive at that point and the next undispatched read is one line away from being sent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runFanout, defaultFanoutConcurrency } from './db-fanout';
import { currentDbScope } from './db-scope';
import { withDbTimeout, dbCircuitState } from './db-timeout';

const never = () => new Promise<never>(() => {});
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The breaker is module-global by design, so a test that leaves it open fails the next one. */
async function resetCircuit() {
  const prev = process.env.DB_CIRCUIT_COOLDOWN_MS;
  process.env.DB_CIRCUIT_COOLDOWN_MS = '1';
  await settle(5);
  dbCircuitState();
  if (prev === undefined) delete process.env.DB_CIRCUIT_COOLDOWN_MS;
  else process.env.DB_CIRCUIT_COOLDOWN_MS = prev;
  await withDbTimeout(Promise.resolve(1), 'test.reset', 500);
}

/** Open the circuit from inside a member, the way a real read that times out would. */
async function openCircuitFromInside() {
  const prev = process.env.DB_CIRCUIT_OPEN_AFTER;
  process.env.DB_CIRCUIT_OPEN_AFTER = '1';
  try {
    await withDbTimeout(never(), 'test.opener', 5).catch(() => {});
  } finally {
    if (prev === undefined) delete process.env.DB_CIRCUIT_OPEN_AFTER;
    else process.env.DB_CIRCUIT_OPEN_AFTER = prev;
  }
}

/** A recorder that notes the ORDER members were invoked in, which is the only way to see dispatch. */
function tracker() {
  const invoked: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const member = (label: string, run: () => Promise<unknown>) => ({
    label,
    run: async () => {
      invoked.push(label);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await run(); } finally { inFlight -= 1; }
    },
  });
  return { invoked, member, peak: () => maxInFlight };
}

describe('runFanout', () => {
  beforeEach(async () => { await resetCircuit(); });
  afterEach(async () => { await resetCircuit(); });

  it('runs every member and reports a complete wave as NOT degraded', async () => {
    const t = tracker();
    const r = await runFanout(
      ['a', 'b', 'c', 'd', 'e'].map((k) => t.member(k, async () => k)),
      { label: 'test.all', ms: 500 },
    );
    expect(t.invoked.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.degraded).toBe(false);
    expect(r.unread).toEqual([]);
    expect(r.ran).toBe(5);
    expect(r.settled).toBe(5);
    expect(r.inFlight).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('never has more members in flight than the concurrency it was given', async () => {
    const t = tracker();
    const members = Array.from({ length: 12 }, (_, i) => t.member('m' + i, () => settle(10)));
    const r = await runFanout(members, { label: 'test.width', ms: 2000, concurrency: 3 });
    expect(r.degraded).toBe(false);
    expect(t.peak()).toBeLessThanOrEqual(3);
    expect(t.invoked.length).toBe(12);
  });

  it('takes THUNKS, so a member the wave never reaches is never invoked at all', async () => {
    // The signature is the guard. A version taking started promises could not decline anything, and
    // every other assertion in this file would still pass.
    const t = tracker();
    const members = [
      t.member('first', async () => { await openCircuitFromInside(); }),
      t.member('second', async () => 'should never run'),
      t.member('third', async () => 'should never run'),
    ];
    const r = await runFanout(members, { label: 'test.thunks', ms: 500, concurrency: 1 });
    expect(t.invoked).toEqual(['first']);
    expect(r.degraded).toBe(true);
    expect(r.unread).toEqual(['second', 'third']);
    expect(r.skippedCircuit).toBe(2);
  });

  it('stops dispatching the moment the circuit opens midway through the wave', async () => {
    const t = tracker();
    const members = Array.from({ length: 8 }, (_, i) =>
      t.member('m' + i, i === 2 ? (async () => { await openCircuitFromInside(); }) : (async () => i)));
    const r = await runFanout(members, { label: 'test.midway', ms: 1000, concurrency: 1 });
    expect(t.invoked).toEqual(['m0', 'm1', 'm2']);
    expect(r.skippedCircuit).toBe(5);
    expect(r.calledOff).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('stays called off even if the circuit closes again while the wave is draining', async () => {
    // Resuming a fan-out into a database that has just failed three reads in a row is the outage
    // amplifier withDbRetry() refuses to become. Once off, off.
    const t = tracker();
    const members = [
      t.member('m0', async () => { await openCircuitFromInside(); }),
      // Closing the circuit from inside a member is exactly what a late-answering read would do.
      t.member('m1', async () => { await resetCircuit(); }),
      t.member('m2', async () => 'must not run'),
      t.member('m3', async () => 'must not run'),
    ];
    const r = await runFanout(members, { label: 'test.sticky', ms: 1000, concurrency: 1 });
    expect(t.invoked).toEqual(['m0']);
    expect(r.skippedCircuit).toBe(3);
  });

  it('sends nothing new after the bound has elapsed, even though the workers are still alive', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. When the barrier bounds out the caller stops waiting, but
    // the worker awaiting a slow member is still there — and one line later it would pick up the
    // next undispatched read and send it to a database nobody is listening to any more.
    const t = tracker();
    const members = [
      t.member('slow', () => settle(120)),
      t.member('after1', async () => 'must not run'),
      t.member('after2', async () => 'must not run'),
    ];
    const r = await runFanout(members, { label: 'test.deadline', ms: 25, concurrency: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.inFlight).toBe(1);
    expect(t.invoked).toEqual(['slow']);
    // The slow member now answers. The wave is over; nothing may be dispatched on its way out.
    await settle(180);
    expect(t.invoked).toEqual(['slow']);
    expect(r.unread).toEqual(['slow', 'after1', 'after2']);
  });

  it('counts a member that throws instead of swallowing, and lets the rest of the wave finish', async () => {
    const t = tracker();
    const r = await runFanout([
      t.member('ok1', async () => 1),
      t.member('boom', async () => { throw new Error('relation "nope" does not exist'); }),
      t.member('ok2', async () => 2),
    ], { label: 'test.throws', ms: 500, concurrency: 1 });
    expect(t.invoked).toEqual(['ok1', 'boom', 'ok2']);
    expect(r.threw).toBe(1);
    expect(r.degraded).toBe(true);
    expect(r.unread).toEqual(['boom']);
    expect(r.ran).toBe(3);
  });

  it('never throws — the barrier’s error is returned, not raised', async () => {
    const r = await runFanout([{ label: 'hang', run: () => never() }], { label: 'test.noraise', ms: 20 });
    expect(r.error).toBeTruthy();
    expect(r.timedOut).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('an empty wave answered completely, and is not degraded', async () => {
    // A person for whom no widget is eligible must not be told part of their page could not be read.
    const r = await runFanout([], { label: 'test.empty', ms: 500 });
    expect(r.degraded).toBe(false);
    expect(r.unread).toEqual([]);
    expect(r.ran).toBe(0);
  });

  it('refuses the whole wave without invoking anything when the circuit is ALREADY open', async () => {
    const t = tracker();
    await openCircuitFromInside();
    const r = await runFanout(
      ['a', 'b', 'c'].map((k) => t.member(k, async () => k)),
      { label: 'test.already', ms: 500 },
    );
    expect(t.invoked).toEqual([]);
    expect(r.skippedCircuit).toBe(3);
    expect(r.calledOff).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('reports unread labels in declaration order, so a log names the screens and not the workers', async () => {
    const t = tracker();
    const members = Array.from({ length: 6 }, (_, i) =>
      t.member('card' + i, i === 1 ? (async () => { await openCircuitFromInside(); }) : (async () => i)));
    const r = await runFanout(members, { label: 'test.order', ms: 800, concurrency: 1 });
    expect(r.unread).toEqual(['card2', 'card3', 'card4', 'card5']);
  });

  it('runs each member inside a refusing scope, named for the read and not the barrier', async () => {
    // The dispatch check stops members that have not STARTED. This is the other half: a member
    // already running when the circuit opens must not send its second and third statements either,
    // and the only thing that can reach a db.execute() four modules down is the scope.
    const seen: Array<string | undefined> = [];
    const deep = async () => { await settle(1); return currentDbScope()?.label; };
    await runFanout([
      { label: 'tasks', run: async () => { seen.push(await deep()); } },
      { label: 'clock events', run: async () => { seen.push(await deep()); } },
    ], { label: 'portalEmployee.batch', ms: 500, concurrency: 1 });
    expect(seen).toEqual(['portalEmployee.batch/tasks', 'portalEmployee.batch/clock events']);
    // And the scope does not outlive the wave.
    expect(currentDbScope()).toBeUndefined();
  });

  it('honours DB_FANOUT_CONCURRENCY, and falls back to four', async () => {
    const prev = process.env.DB_FANOUT_CONCURRENCY;
    try {
      delete process.env.DB_FANOUT_CONCURRENCY;
      expect(defaultFanoutConcurrency()).toBe(4);
      process.env.DB_FANOUT_CONCURRENCY = '2';
      expect(defaultFanoutConcurrency()).toBe(2);
      const t = tracker();
      const r = await runFanout(
        Array.from({ length: 6 }, (_, i) => t.member('m' + i, () => settle(10))),
        { label: 'test.env', ms: 2000 },
      );
      expect(r.degraded).toBe(false);
      expect(t.peak()).toBeLessThanOrEqual(2);
    } finally {
      if (prev === undefined) delete process.env.DB_FANOUT_CONCURRENCY;
      else process.env.DB_FANOUT_CONCURRENCY = prev;
    }
  });
});
