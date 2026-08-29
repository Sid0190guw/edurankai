// THE HALF OF "CIRCUIT-AWARE" THAT A SCHEDULER CANNOT REACH ON ITS OWN.
//
// src/lib/db-fanout.ts stops DISPATCHING members once the breaker has concluded the database is
// gone. That closes most of the gap on /portal/employee, where twenty-one members were released at
// once and the ones that had not started were the majority. It does not close all of it, because a
// member is not one query:
//
//     myTasksView()        readMyTasks, then readTaskCounts          2 round trips, sequential
//     the clock block      today, then punchLog, then punchesOn      3 round trips, sequential
//     credit               termsFor, then ledgerFor                  2 round trips, sequential
//
// A member already in flight when the circuit opens goes on to send its NEXT statement, and the one
// after that, to a database every other read in the instance is being refused for. Those statements
// are the ones that occupy connections the wedge diagnosis in src/lib/db-timeout.ts shows may never
// come back — so the fan-out was still feeding the failure, just less of it.
//
// =================================================================================================
// WHY A SCOPE AND NOT A GATE ON db.execute()
// =================================================================================================
//
// The obvious fix is to make db.execute() itself refuse while the circuit is open. It is also the
// wrong one, and the blast radius is the reason: db.execute() is the chokepoint EVERY query in this
// deployment goes through, writes included. A breaker opened by three slow READS would then refuse a
// sign-in write, a punch, a payroll row — and this project has already shipped one chokepoint change
// that passed its own tests and broke its callers.
//
// So the refusal is scoped to the code that asked for it. A fan-out member runs inside
// `inDbScope({ refuseWhenCircuitOpen: true }, ...)` and every db.execute() it reaches — however many
// modules deep, because AsyncLocalStorage follows the await chain — is refused while the circuit is
// open. Nothing outside that scope changes at all.
//
// ASYNCLOCALSTORAGE AND NOT A MODULE-LEVEL FLAG, for the reason src/lib/schema-bootstrap.ts already
// states about its own DDL scope: one warm serverless instance serves concurrent invocations, and a
// module-level flag set by one request would be read by another request that never asked for it.
//
// THIS MODULE IMPORTS NOTHING FROM THE PROJECT, deliberately. src/lib/db/index.ts reads the scope
// from inside its execute() guard and src/lib/db-fanout.ts opens it; if either of them owned it, the
// other would have to import the driver or the scheduler to see it, and db-fanout.ts would stop
// being testable without a database — the exact mistake src/lib/db-timeout.ts's header describes as
// the reason the bounded wait was used on one route in the whole deployment.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface DbScope {
  /**
   * Refuse this scope's queries, without waiting, while the circuit breaker is open.
   *
   * READS ONLY. A refused statement is not attempted even once, so a caller that writes inside such
   * a scope would return as though it had written and leave no trace. src/lib/db-fanout.ts states
   * the same condition on its members and for the same reason.
   */
  refuseWhenCircuitOpen: boolean;
  /** Names the refusal, so the error says which read was declined rather than "a query". */
  label: string;
}

const scope = new AsyncLocalStorage<DbScope>();

/** Run `fn` with this scope in force for everything it awaits, however deep. */
export function inDbScope<T>(value: DbScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(value, fn);
}

/** The scope in force for the current async context, or undefined outside one. */
export function currentDbScope(): DbScope | undefined {
  return scope.getStore();
}

/**
 * Should a query running right now be refused, given whether the circuit is open?
 *
 * The circuit state is PASSED IN rather than read here, so this module keeps its promise to import
 * nothing and stays a pure function a test can drive with both answers.
 */
export function scopeRefusesQuery(circuitOpen: boolean, current = currentDbScope()): boolean {
  return circuitOpen && current?.refuseWhenCircuitOpen === true;
}
