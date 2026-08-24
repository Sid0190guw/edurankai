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
// THE BREAKER RE-RUNS NOTHING. withDbTimeout() only ever converts a wait into a fast, loggable
// refusal, so there is no backoff in it to get wrong and no loop to run away. The cooldown is short
// because a serverless instance may live for minutes and the pooler usually recovers in seconds —
// and the FIRST call after the cooldown is allowed through to find out, which is what closes the
// circuit again.
//
// withDbRetry() at the bottom of this file is the one thing here that does re-run work, and it is a
// SINGLE second attempt on a timeout only. Its own header sets out the measurement that justifies
// it — briefly: what fails on this deployment is opening a connection, not answering a query, so a
// second ask succeeds where a longer wait does not. It never retries an open circuit and never
// retries an ordinary query error, which is what keeps the two mechanisms from fighting.
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
  // The label was only ever in the prose of the message, so the one endpoint that reports these had
  // to publish the whole sentence in order to name the gate that failed — and publicErrorSummary()
  // then read `health.quick` as a hostname and replaced it with `<host>`. Carrying it as a field
  // lets the reason be scrubbed and the gate still be named.
  readonly label: string;
  constructor(label: string, ms: number) {
    super('database did not answer within ' + ms + 'ms (' + label + ')');
    this.name = 'DbTimeoutError';
    this.label = label;
  }
}

export class DbCircuitOpenError extends Error {
  readonly label: string;
  constructor(label: string) {
    super('database is not answering; this read was refused without waiting (' + label + ')');
    this.name = 'DbCircuitOpenError';
    this.label = label;
  }
}

/** True for both shapes, so callers can tell "the database is unreachable" from "that query is wrong". */
export function isDbUnavailable(e: any): boolean {
  return e instanceof DbTimeoutError || e instanceof DbCircuitOpenError
    || e?.name === 'DbTimeoutError' || e?.name === 'DbCircuitOpenError';
}

let openedAt = 0;
let timeoutCount = 0;

// -------------------------------------------------------------------------------------------------
// WHAT THE DATABASE ACTUALLY SAID, KEPT WHERE SOMEBODY CAN READ IT
// -------------------------------------------------------------------------------------------------
//
// The header of src/lib/db/index.ts is four consecutive changes to one number — max:1, then 5/60,
// then 2/15, then 5/15 — and it says of itself that each "was diagnosed from the same 5s-timeout
// symptom that all four settings produce". That is the real defect, and it is in THIS file: the
// symptom is all there is. "database did not answer within 5000ms" is what a visitor sees, and what
// the logs record, whether the pooler is refusing connections, the instance has run out of disk, the
// password is wrong, or the host does not exist. The driver separates all four in a single sentence,
// and that sentence was being thrown away — withDbTimeout below shows exactly where.
//
// One slot, overwritten, nothing allocated on the happy path. It lives as long as the serverless
// instance does, which is the scope of every other counter in this file.
//
// `reason` IS DELIBERATELY NOT SCRUBBED HERE. A Postgres connection error carries the pooler
// hostname, the role and the port; the function logs should keep those and an anonymous caller must
// not see them. That is the reader's decision, not this module's — /api/health puts it through
// publicErrorSummary() before publishing it. Scrubbing at the point of capture would destroy the
// half operators need, to protect a half only one caller ever exposes.
export interface DbFailureRecord {
  at: string;
  label: string;
  /** The driver's own message, unscrubbed. Scrub before showing it to anyone unauthenticated. */
  reason: string;
  /** How long the attempt ran before it failed. */
  afterMs: number;
  /**
   * `raced` — it failed before the bound elapsed, so its own caller received this error and could
   * report it. `abandoned` — the bound elapsed first, the caller was handed a DbTimeoutError, and
   * this is the real reason arriving afterwards with nobody left to tell. The second case is the one
   * this record exists for.
   */
  phase: 'raced' | 'abandoned';
}

let lastFailure: DbFailureRecord | null = null;

/**
 * The most recent driver-level failure this process saw, or null.
 *
 * IT SURVIVES THE RECOVERY, which is the point. The circuit closes and the consecutive counter
 * resets the moment one read succeeds, so ten minutes after an outage the only honest answer to
 * "what actually failed" was a shrug. This is the one thing that still remembers.
 */
export function lastDbFailure(): DbFailureRecord | null {
  return lastFailure ? { ...lastFailure } : null;
}

/** For tests, and for an operator screen that has just acted on a fault and wants a clean slate. */
export function clearDbFailure(): void {
  lastFailure = null;
}

/** The real Postgres reason lives on `e.cause`; `e.message` is only the statement that failed. */
function driverReason(e: any): string {
  const code = e?.code || e?.cause?.code || e?.errno;
  const text = String(e?.cause?.message || e?.message || e || 'unknown failure').replace(/\s+/g, ' ').trim();
  return (code && !text.includes(String(code)) ? String(code) + ': ' : '') + text;
}

function recordDriverFailure(label: string, e: any, afterMs: number, phase: 'raced' | 'abandoned'): void {
  // Our own two errors are not evidence about the database — they are this file describing itself.
  // Recording one would overwrite the driver's reason with the symptom, which is the entire problem
  // this record exists to end.
  if (isDbUnavailable(e)) return;
  const reason = driverReason(e);
  lastFailure = { at: new Date().toISOString(), label, reason, afterMs, phase };
  console.error(JSON.stringify({
    ts: lastFailure.at, level: 'error', event: 'db.driver_error', label, phase, afterMs, reason,
  }));
}

/** The abandoned attempt answering late. Logged, and deliberately not fed to the breaker. */
function noteLateAnswer(label: string, afterMs: number, boundMs: number): void {
  console.warn(JSON.stringify({
    ts: new Date().toISOString(), level: 'warn', event: 'db.late_answer', label, afterMs, boundMs,
    note: 'the database answered after the caller had given up: slow, not gone',
  }));
}

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

/**
 * A READ NOTHING ON THE SCREEN DEPENDS ON MUST NOT BE ABLE TO REFUSE THE READS THAT EVERYTHING
 * DEPENDS ON.
 *
 * The breaker is process-global by design, and that is what makes it worth having: a dozen reads on
 * one page cost one timeout and eleven instant refusals instead of a gateway timeout. It is also
 * what makes it dangerous to feed from the wrong place. src/layouts/AdminLayout.astro reads one
 * column of hr_employees to choose an ACCENT COLOUR, on every one of ~160 admin surfaces. Nothing is
 * wrong on the screen when that read fails — the layout already defaults the colour — but three of
 * them in a row opened the circuit, and from that moment every real read in the instance was refused
 * without waiting. A cosmetic detail was able to take the console's data down.
 *
 * `cosmetic` says: bound this, log it, hand the caller its error — and do not count it as evidence
 * about the database. It is still REFUSED while the circuit is open, because that is exactly the
 * situation in which a colour is not worth a connection.
 *
 * Use it only where the failure changes nothing a reader would notice. If a panel would render
 * empty, or a number would render as zero, it is not cosmetic.
 */
export interface DbWaitOptions { cosmetic?: boolean }

function noteTimeout(label: string, cosmetic = false): void {
  timeoutCount += 1;
  if (cosmetic) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'db.timeout.cosmetic',
      label, timeouts: timeoutCount, note: 'not counted toward the circuit breaker',
    }));
    return;
  }
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
export function withDbTimeout<T>(work: Promise<T>, label: string, ms: number = DB_TIMEOUT_MS, opts?: DbWaitOptions): Promise<T> {
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
  //
  // AND BOTH OUTCOMES OF THE WORK ARE OBSERVED, INCLUDING THE ONE NOBODY IS WAITING FOR ANY MORE.
  //
  // This attached an onFulfilled handler and nothing else. A REJECTION therefore travelled into
  // Promise.race, arrived after the race had already settled on the timeout, and was absorbed with
  // nothing written down anywhere. That rejection is the driver's own account of the failure —
  // CONNECT_TIMEOUT, "Max client connections reached", "remaining connection slots are reserved",
  // "no space left on device", an authentication failure — and it is the only sentence in the system
  // that tells those apart. Every one of them reached the visitor, the logs and /api/health as the
  // identical "database did not answer within 5000ms".
  //
  // Recording it changes nothing about what the caller receives: the rejection is re-thrown
  // untouched, and the flag below still decides which side claims the outcome.
  const startedAt = Date.now();
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const observed = Promise.resolve(work).then(
    (v) => {
      if (!settled) { settled = true; noteSuccess(); return v; }
      // The abandoned attempt landing after its caller gave up. It must NOT close the circuit — the
      // paragraph above is entirely about why — but it is the difference between a database that is
      // slow and one that is gone, and that is worth one line.
      noteLateAnswer(label, Date.now() - startedAt, ms);
      return v;
    },
    (e) => {
      recordDriverFailure(label, e, Date.now() - startedAt, settled ? 'abandoned' : 'raced');
      throw e;
    },
  );
  return Promise.race([
    observed,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        noteTimeout(label, opts?.cosmetic === true);
        reject(new DbTimeoutError(label, ms));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

// -------------------------------------------------------------------------------------------------
// ONE RETRY, BECAUSE THE MEASURED FAILURE IS OPENING A CONNECTION AND NOT ANSWERING A QUERY
// -------------------------------------------------------------------------------------------------
//
// MEASURED ON THE LIVE SITE, 2026-08-24. /api/health runs exactly two statements and bounds them at
// 5s. Requests to it fall into two clean populations and nothing in between:
//
//   latencyMs = 132-154   ->  the instance already had a connection. 100% of these answered.
//   latencyMs = 950-991   ->  the instance had to OPEN one. ~810ms of that is the handshake alone.
//   no answer at 5000ms   ->  roughly a QUARTER of the attempts that had to open one.
//
// The failure rate does not rise with concurrency — two parallel requests produced one failure while
// ten produced none, and fourteen produced three. That rules out pool exhaustion and pooler
// queueing, which are load-proportional by definition, and it is why three rounds of tuning `max`
// in src/lib/db/index.ts never fixed this: every one of them was tuning the wrong variable. What
// actually fails is each individual attempt to establish a connection, at a roughly fixed rate,
// whatever else is happening.
//
// So the honest bound for a gate is not "wait longer". Waiting longer on a connection that is not
// coming just moves the gateway timeout. It is: ask again, quickly.
//
// THE RETRY IS NEARLY FREE, AND THAT IS THE POINT. withDbTimeout sheds the WAIT and not the WORK —
// it says so itself above: "The losing promise keeps running". The connection the abandoned attempt
// was opening therefore still lands in the pool, so the second attempt usually finds it already
// there and answers in the 132ms population rather than paying another handshake.
//
// ONLY A TIMEOUT IS RETRIED.
//   - DbCircuitOpenError is NOT: the circuit is open precisely because the database has already
//     failed repeatedly, and retrying into that is how a retry becomes an outage amplifier.
//   - An ordinary query error is NOT: a missing table or a bad column will fail identically the
//     second time, and this must never re-run a statement that failed for a reason of its own.
//
// THE PAIR COSTS EXACTLY WHAT THE SINGLE WAIT COST, AND THAT IS DELIBERATE — 5000 + 3000 = the
// DB_TIMEOUT_MS 8000 it replaces at the gates. No gate can become slower than it is today, and the
// retry is bought entirely out of the budget the first attempt was already allowed to spend.
//
// THE FIRST BOUND IS 5s AND NOT 3s, WHICH THE FIRST DRAFT OF THIS GOT WRONG. Three seconds looks
// generous against a healthy read (154ms warm, 991ms cold) and it is — but a burst of fourteen
// requests through the real session gate on the live site produced three that took 3.09-3.22s end to
// end and every one of them SUCCEEDED. A 3s bound would have converted those into timeouts, and a
// timeout is not free: it increments the breaker's consecutive counter, three in a row open the
// circuit, and an open circuit refuses every read in that instance instantly. Tightening the bound
// past the observed success tail would have manufactured exactly the instance-wide refusal this is
// here to stop. 5s sits above everything measured that works and below the 5s+ population that does
// not, which is the only place the line can honestly go.

/** First attempt's bound. Above the slowest measured SUCCESS (~3.2s), below the population that stalls. */
export const DB_TRY_MS = Number(process.env.DB_TRY_MS || 5000);
/**
 * Second attempt's bound. Shorter, so the pair spends no more than the single DB_TIMEOUT_MS wait it
 * replaces — and it does not need more: a connection is usually in flight for it to reuse by now,
 * and opening a fresh one measured ~950ms.
 */
export const DB_RETRY_MS = Number(process.env.DB_RETRY_MS || 3000);

/**
 * Bound a database read, and if it TIMES OUT, run it once more.
 *
 * Takes a FACTORY, not a promise: a promise cannot be re-awaited into a second attempt, and a
 * signature that took one would silently retry nothing. Every call site therefore passes `() => …`.
 *
 * The work must be idempotent. Every current caller is a read or an idempotent upsert
 * (validateSessionToken's sliding renewal writes the same expiry twice; canOpenAdmin and
 * getViewableSectionKeys are pure reads), and that is a condition of using this rather than an
 * incidental fact — do not reach for it around an INSERT.
 */
export async function withDbRetry<T>(
  work: () => Promise<T>,
  label: string,
  firstMs: number = DB_TRY_MS,
  secondMs: number = DB_RETRY_MS,
): Promise<T> {
  // REFUSED BEFORE THE WORK IS STARTED, which withDbTimeout cannot do for itself: by the time it is
  // handed a promise its caller has already sent the statement, so all it can refuse is the WAIT. A
  // factory can do the thing the breaker is actually for — while the circuit is open the right
  // number of statements to send is zero.
  if (dbCircuitOpen()) return Promise.reject(new DbCircuitOpenError(label));
  try {
    return await withDbTimeout(work(), label, firstMs);
  } catch (e: any) {
    const timedOut = e instanceof DbTimeoutError || e?.name === 'DbTimeoutError';
    if (!timedOut) throw e;
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'db.retry',
      label, afterMs: firstMs, retryMs: secondMs,
    }));
    // May itself throw DbCircuitOpenError if the first attempt's timeout was the one that opened the
    // circuit. That is the correct answer and it is passed straight through: three timeouts in a row
    // is a database that has gone away, and this is not the place to argue with the breaker.
    return await withDbTimeout(work(), label + '.retry', secondMs);
  }
}
