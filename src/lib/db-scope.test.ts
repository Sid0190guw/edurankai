// The scoped refusal, and the two things that make it safe.
//
// It exists because a fan-out member that was ALREADY RUNNING when the circuit opened goes on to
// send its second and third statements — myTasksView() is two round trips, the clock block is three
// — into a database every other read in the instance is being refused for. Those statements hold
// connections that src/lib/db-timeout.ts's wedge diagnosis shows may never come back.
//
// The two things a refactor must not lose:
//   1. OUTSIDE a scope, nothing is refused. db.execute() is the chokepoint every write in this
//      deployment goes through, and a breaker opened by three slow reads must never refuse a
//      sign-in, a punch or a payroll row.
//   2. The scope follows the AWAIT CHAIN. A member calls a loader which calls a helper which calls
//      db.execute() four modules away; if the scope did not survive that, the guard would protect
//      exactly the code that does not need it.
import { describe, it, expect } from 'vitest';
import { inDbScope, currentDbScope, scopeRefusesQuery } from './db-scope';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('db scope', () => {
  it('is undefined outside a scope, so nothing outside a fan-out is ever refused', () => {
    expect(currentDbScope()).toBeUndefined();
    expect(scopeRefusesQuery(true)).toBe(false);
    expect(scopeRefusesQuery(false)).toBe(false);
  });

  it('refuses only when BOTH the circuit is open and the scope asked to be refused', () => {
    const on = { refuseWhenCircuitOpen: true, label: 'x' };
    const off = { refuseWhenCircuitOpen: false, label: 'x' };
    expect(scopeRefusesQuery(true, on)).toBe(true);
    expect(scopeRefusesQuery(false, on)).toBe(false);
    expect(scopeRefusesQuery(true, off)).toBe(false);
    expect(scopeRefusesQuery(true, undefined)).toBe(false);
  });

  it('follows the await chain, several calls deep', async () => {
    // This is what makes the guard reach db.execute() inside a loader inside a dynamic import.
    const deep = async () => { await tick(); return currentDbScope()?.label; };
    const middle = async () => { await tick(); return deep(); };
    const seen = await inDbScope({ refuseWhenCircuitOpen: true, label: 'batch/tasks' }, middle);
    expect(seen).toBe('batch/tasks');
    // And it is gone again once the scope closes.
    expect(currentDbScope()).toBeUndefined();
  });

  it('keeps concurrent scopes apart, which a module-level flag could not', async () => {
    // One warm serverless instance serves concurrent invocations. A flag set by one request would be
    // read by another that never asked for it — the reason src/lib/schema-bootstrap.ts gives for its
    // own DDL scope being AsyncLocalStorage.
    const label = async (l: string) =>
      inDbScope({ refuseWhenCircuitOpen: true, label: l }, async () => {
        await tick();
        return currentDbScope()?.label;
      });
    const [a, b, c] = await Promise.all([label('a'), label('b'), label('c')]);
    expect([a, b, c]).toEqual(['a', 'b', 'c']);
  });

  it('returns whatever the scoped function returns, and propagates its rejection', async () => {
    const v = await inDbScope({ refuseWhenCircuitOpen: true, label: 'x' }, async () => 42);
    expect(v).toBe(42);
    await expect(
      inDbScope({ refuseWhenCircuitOpen: true, label: 'x' }, async () => { throw new Error('nope'); }),
    ).rejects.toThrow('nope');
    expect(currentDbScope()).toBeUndefined();
  });
});
