// BOUNDED WAITS AND A CIRCUIT BREAKER FOR THE DATABASE — with no database in this file.
//
// WHY THIS EXISTS, AND WHY IT IS NOT IN src/lib/db/index.ts.
//
// withDbTimeout() was written for exactly the incident this file is named after: the transaction
// pooler accepts the TCP connection and completes authentication perfectly well, then never answers
// the QUERY, because it has no upstream session to hand it to. postgres-js has no query timeout of
// its own, so the await never settles. From outside, the page does not error — it hangs, and the
// PLATFORM decides what the visitor sees: FUNCTION_INVOCATION_TIMEOUT, 504, no log line naming a
// cause.
//
// It lived in src/lib/db/index.ts, which imports `postgres`, `drizzle` and `dotenv` at module scope.
// That is why it was used in exactly ONE file (src/pages/api/health.ts) and nowhere else: the
// modules that most need a bounded wait — page-safety.ts, the pure helpers, anything that documents
// itself as touching no database — cannot import the driver to get it. So every other route on this
// deployment, /admin included, awaited the database with no bound at all.
//
// This module has no imports. db/index.ts re-exports everything here, so existing call sites are
// unchanged.
//
// -------------------------------------------------------------------------------------------------
// THE CIRCUIT BREAKER, AND WHY A PER-QUERY TIMEOUT IS NOT ENOUGH ON ITS OWN
// -------------------------------------------------------------------------------------------------
//
// /admin issues roughly a dozen sequential reads: session validation, the admin gate, the face-2FA
// check, the layout's own two, then the dashboard's counts, pipeline, recent list and six setup
// COUNTs. Bounding each of them at 8 seconds turns a dead database into TWELVE consecutive 8-second
// waits — ninety-six seconds, which is still a gateway timeout, just a slower one.
//
// So the first timeout in a process opens a circuit, and while it is open every further wait is
// refused IMMEDIATELY rather than waited out. The dozen reads then cost one timeout plus eleven
// instant refusals, and the page renders its "we could not read this" states instead of dying.
//
// DELIBERATELY NOT A RETRY MECHANISM. Nothing here re-runs anything, so there is no backoff to get
// wrong and no loop to run away: it only ever converts a wait into a fast, loggable refusal. The
// cooldown is short because a serverless instance may live for minutes and the pooler usually
// recovers in seconds — and the FIRST call after the cooldown is allowed through to find out, which
// is what closes the circuit again.
//
// ONLY TIMEOUTS OPEN IT. An ordinary query error — a missing table, a bad column — is information
// about the statement, not about the database's ability to answer, and tripping on those would take
// working pages down over a self-bootstrapping table that was never created.

/** How long any single database wait may last. Deliberately shorter than any gateway timeout. */
export const DB_TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 8000);

/**
 * How long the circuit stays open after a timeout, before one probe is let through.
 *
 * Read per call, not once at module scope — the same rule ensure-once.ts states for SCHEMA_BOOTSTRAP,
 * and for the same reason: the value should be whatever the environment says NOW rather than whatever
 * it said when this instance happened to boot. It also makes the breaker testable without a five
 * second sleep in a unit test.
 */
function cooldownMs(): number {
  const n = Number(process.env.DB_CIRCUIT_COOLDOWN_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

export class DbTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super('database did not answer within ' + ms + 'ms (' + label + ')');
    this.name = 'DbTimeoutError';
  }
}

export class DbCircuitOpenError extends Error {
  constructor(label: string) {
    super('database is not answering; this read was refused without waiting (' + label + ')');
    this.name = 'DbCircuitOpenError';
  }
}

/** True for both shapes, so callers can tell "the database is unreachable" from "that query is wrong". */
export function isDbUnavailable(e: any): boolean {
  return e instanceof DbTimeoutError || e instanceof DbCircuitOpenError
    || e?.name === 'DbTimeoutError' || e?.name === 'DbCircuitOpenError';
}

let openedAt = 0;
let timeoutCount = 0;

/** Is the circuit currently refusing waits? */
export function dbCircuitOpen(): boolean {
  if (!openedAt) return false;
  if (Date.now() - openedAt >= cooldownMs()) {
    // Cooldown elapsed. Let the next call through to find out whether the database is back. The
    // consecutive counter is cleared too, so the probe gets a full run of OPEN_AFTER attempts to
    // prove the database is gone rather than re-opening on its first stumble.
    openedAt = 0;
    consecutiveTimeouts = 0;
    return false;
  }
  return true;
}

/** For /api/health and /admin/ops: how many bounded waits have timed out in this process. */
export function dbCircuitState(): { open: boolean; timeouts: number; msRemaining: number } {
  const open = dbCircuitOpen();
  return {
    open,
    timeouts: timeoutCount,
    msRemaining: open ? Math.max(0, cooldownMs() - (Date.now() - openedAt)) : 0,
  };
}

/**
 * HOW MANY TIMEOUTS IN A ROW MEAN THE DATABASE IS GONE, rather than one query being slow.
 *
 * This was 1, and 1 was wrong. It turned a single slow read into a whole-instance outage: the
 * breaker is process-global, so one page that fanned out more reads than the pool had slots would
 * queue the surplus, the queued ones would blow their 8s fuse, and every subsequent read in that
 * instance — including the middleware session gate on the next request — was refused instantly.
 * /admin/help answering "we cannot reach the database" while the database was answering psql in
 * 143ms is what that looks like from outside.
 *
 * It is a CONSECUTIVE count, reset by any success, because that is the distinction that matters:
 * three failures in a row is a database that has gone away, three failures spread among successes
 * is a slow query and nothing more.
 */
function openAfter(): number {
  // Read per call, not once at module scope — the same rule cooldownMs() above follows, and for the
  // same two reasons: the value should be whatever the environment says NOW, and a threshold frozen
  // at import time cannot be exercised by a test without reloading the module. The first draft of
  // this was a module-level const and the suite caught it immediately.
  const n = Number(process.env.DB_CIRCUIT_OPEN_AFTER);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 3;
}

let consecutiveTimeouts = 0;

/** Close the circuit. Called on any bounded wait that SUCCEEDS. */
function noteSuccess(): void {
  openedAt = 0;
  consecutiveTimeouts = 0;
}

function noteTimeout(label: string): void {
  timeoutCount += 1;
  consecutiveTimeouts += 1;
  // Only the run of failures opens it. A single slow read is logged and otherwise costs nothing:
  // its own caller already received a DbTimeoutError and will degrade that one panel.
  const threshold = openAfter();
  if (consecutiveTimeouts >= threshold) openedAt = Date.now();
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'error', event: 'db.timeout',
    label, timeouts: timeoutCount, consecutive: consecutiveTimeouts,
    opened: consecutiveTimeouts >= threshold, openAfter: threshold, cooldownMs: cooldownMs(),
  }));
}

/**
 * Bound one database wait.
 *
 * The losing promise keeps running; only the WAITING stops. Clearing the timer matters because a
 * pending timeout keeps a serverless instance's event loop alive after the response is sent.
 */
export function withDbTimeout<T>(work: Promise<T>, label: string, ms: number = DB_TIMEOUT_MS): Promise<T> {
  if (dbCircuitOpen()) {
    // Do not leave `work` unobserved: an unhandled rejection on a promise nobody awaits can take the
    // process down. Swallow it here — the caller is being told the circuit is open instead.
    Promise.resolve(work).catch(() => {});
    return Promise.reject(new DbCircuitOpenError(label));
  }
  // ONLY THE WINNER OF THE RACE MAY RECORD ANYTHING.
  //
  // Promise.race settles on the first promise, but the other one KEEPS RUNNING — that is stated two
  // comments up and its consequence was missed. Without this flag, a query that finally came back at
  // twelve seconds still ran noteSuccess() and CLOSED the circuit that its own eight-second timeout
  // had opened four seconds earlier, after the caller had already been handed a DbTimeoutError.
  //
  // That defeats the breaker in precisely the condition it exists for. On a degraded database
  // queries do not fail, they crawl — so every straggler reopened the gate, the next read blew its
  // fuse again, and the circuit flapped instead of holding. The whole point is that ONE timeout
  // makes the next reads instant refusals; a breaker that a latecomer can reset is just a slower
  // timeout.
  //
  // Both sides check and set the same flag, so whichever settles first claims the outcome and the
  // loser becomes a no-op. `settled` is per-call, not shared.
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    Promise.resolve(work).then((v) => {
      if (!settled) { settled = true; noteSuccess(); }
      return v;
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        noteTimeout(label);
        reject(new DbTimeoutError(label, ms));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
