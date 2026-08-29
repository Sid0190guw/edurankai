// A FAN-OUT OF DATABASE READS THAT CAN STILL BE CALLED OFF AFTER IT HAS STARTED.
//
// =================================================================================================
// THE DEFECT THIS EXISTS FOR
// =================================================================================================
//
// src/pages/portal/employee.astro fans out twenty-one reads and waits on them with one bounded
// barrier. The barrier is right and its docblock explains why it is the BARRIER that is bounded and
// not the members: bounding each read individually means a fan-out wider than the pool queues the
// surplus, every queued read blows its own fuse, and three in a row open the process-global circuit
// — which is how /admin/help came to answer "we cannot reach the database" while psql was being
// answered in 143ms.
//
// What that barrier cannot do is stop anything. Its members are STARTED PROMISES:
//
//     batch.push((async () => { ... await someLoader() ... })());
//                                                            ^^ invoked here, immediately
//
// By the time the array exists, all twenty-one are already in flight. So when the circuit opens
// midway — when the breaker has concluded the database is gone and every OTHER read in the instance
// is being refused without waiting — this page's remaining reads carry on being sent to it. They are
// not refused, because they call db.execute() directly and the circuit is only consulted by
// withDbTimeout() and withDbRetry(). They occupy connections that the wedge diagnosis in
// src/lib/db-timeout.ts shows may never be given back. The page is not just failing; it is feeding
// the failure.
//
// And there is a second, quieter cost in the same shape. withDbTimeout sheds the WAIT and not the
// WORK — it says so about itself. When the barrier bounds out at eight seconds the caller stops
// waiting, but the twenty-one members do not stop working, and any of them that had not yet reached
// its query still sends it, to a database nobody is listening to any more, on a connection somebody
// else's request needs.
//
// =================================================================================================
// WHAT THIS CHANGES, AND THE ONE THING IT DOES NOT
// =================================================================================================
//
// THUNKS, NOT PROMISES. That is the whole mechanism, and it is the same argument withDbRetry() makes
// for its own signature: a promise cannot be declined, and a function that took one would be a
// scheduler that schedules nothing. Every member is `() => Promise<unknown>` and is invoked only
// when this module decides to invoke it.
//
// THREE THINGS ARE CHECKED BEFORE EACH DISPATCH, and all three are cheap and local:
//
//   1. Has the wave been called off already. Once stopped it stays stopped — a circuit that closes
//      again mid-wave must NOT restart dispatch, because resuming into a database that has just
//      failed three reads in a row is the outage amplifier withDbRetry() refuses to become.
//   2. Is the circuit open. If the breaker has concluded the database is gone, the right number of
//      further statements to send is zero.
//   3. Has the deadline passed. The barrier's bound and the dispatcher's deadline are the same
//      instant, so nothing new is sent after the caller has stopped waiting.
//
// THE BARRIER IS STILL BOUNDED EXACTLY ONCE. One withDbTimeout over the whole wave, one label, one
// timeout in the breaker's evidence if it bounds out. Nothing here bounds an individual member, for
// precisely the reason the page's own docblock gives.
//
// CONCURRENCY IS CAPPED, which the started-promise version could not do either. Twenty-one reads
// released at once against a five-slot pool do not run at once; postgres-js queues sixteen of them
// where nothing can see or stop them, and on a COLD instance the first five each pay an ~810ms
// handshake that is measured to be swallowed by the pooler about a quarter of the time. Releasing
// four at a time is the same total work through the same pool, with the queue somewhere this module
// can look at it.
//
// WHAT IT DOES NOT DO: it does not cancel a query that has already been sent. Nothing in this
// deployment can — postgres-js has no cancellation and the pooler is the thing not answering. A
// member already in flight when the wave is called off stays in flight. This stops the ones that had
// not started, which on a twenty-one-member wave is most of them.
//
// =================================================================================================
// READS ONLY. THIS IS A CONDITION OF USE, NOT AN INCIDENTAL FACT.
// =================================================================================================
//
// A member may be SKIPPED ENTIRELY and the caller is told so rather than shown an error. That is
// correct for a read — the card renders "we could not read this" instead of a confident zero — and
// it is silently wrong for anything that writes, because a write that never happened leaves no trace
// and the request returns as though it did. withDbRetry() states the same condition for the same
// kind of reason; this one is stricter, because a skipped write is not even attempted once.
//
// Do not put an INSERT, an UPDATE, a DELETE or a schema ensure in a fan-out member.
import { DB_TIMEOUT_MS, DbTimeoutError, dbCircuitOpen, withDbTimeout } from '@/lib/db-timeout';
// AND THE HALF THE DISPATCH CHECK CANNOT REACH. A member is not one query — myTasksView() is two
// round trips, the clock block is three — so a member already in flight when the circuit opens goes
// on to send its next statement to a database every other read in the instance is being refused for.
// Running each member inside a scope makes every db.execute() it reaches, however many modules deep,
// refuse while the circuit is open. Scoped rather than global precisely so nothing outside this
// fan-out changes: src/lib/db-scope.ts sets out why a gate on db.execute() itself would be wrong.
import { inDbScope } from '@/lib/db-scope';

/**
 * How many members may be in flight at once, by default.
 *
 * FOUR AND NOT FIVE, against a POOL_MAX of 5. The number is deliberately one short of the pool: a
 * page's own fan-out must not be able to take every slot the instance has, because the same warm
 * instance is serving other requests concurrently and one of them is somebody's session gate. Five
 * would let one page render while the next request in the same process waits for a connection that
 * this page is holding all five of.
 *
 * It is NOT imported from src/lib/db/index.ts even though POOL_MAX lives there, and that is on
 * purpose: importing it would pull `postgres`, `drizzle` and `dotenv` into this module and make it
 * untestable without a driver — the exact mistake src/lib/db-timeout.ts's header describes as the
 * reason the bounded wait was used on one route in the whole deployment. A caller that wants the
 * pool's real width can pass it.
 *
 * Read per call rather than frozen at module scope, the same rule cooldownMs() and openAfter()
 * follow in src/lib/db-timeout.ts: the value should be whatever the environment says now, and a
 * constant captured at import time cannot be exercised by a test.
 */
export function defaultFanoutConcurrency(): number {
  const n = Number(process.env.DB_FANOUT_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 4;
}

/** One read in the wave. `run` is invoked by the scheduler, or never. */
export interface FanoutMember {
  /**
   * Names this read in the log line and in `unread`. It is not decoration: when a wave is called off
   * the only thing anybody can say about the empty cards is which reads never happened, and a member
   * called 'member 14' cannot be traced back to a screen.
   */
  label: string;
  run: () => Promise<unknown>;
}

/** Why a member never ran. `null` means it did. */
export type FanoutSkip = 'circuit' | 'deadline' | null;

export interface FanoutOutcome {
  label: string;
  /** True if `run()` was invoked at all. */
  ran: boolean;
  /** True if `run()` was invoked AND has since settled. False with ran=true means still in flight. */
  settled: boolean;
  /** Why it was never invoked, or null. */
  skipped: FanoutSkip;
  /** True if `run()` rejected. Members are expected to swallow; one that does not is worth seeing. */
  threw: boolean;
  /** How long `run()` took, for members that settled. */
  ms: number;
}

export interface FanoutResult {
  /**
   * THE ONE FIELD A PAGE ACTUALLY RENDERS FROM. True when any member did not answer — skipped,
   * still in flight when the bound elapsed, or rejected. False means every read in the wave
   * completed, so an empty card genuinely means the person has none of that thing.
   */
  degraded: boolean;
  /** Labels of every member that did not answer, in declaration order. For the log, and for a page that wants to name them. */
  unread: string[];
  ran: number;
  settled: number;
  skippedCircuit: number;
  skippedDeadline: number;
  /** Invoked, still not settled when the bound elapsed. These are the ones holding connections. */
  inFlight: number;
  threw: number;
  /** True when the barrier bounded out rather than every dispatched member settling. */
  timedOut: boolean;
  /** True when the wave was refused or called off because the breaker had concluded the database was gone. */
  calledOff: boolean;
  /** Whatever the bounded wait rejected with, or null. Never re-thrown: this function does not throw. */
  error: unknown;
  outcomes: FanoutOutcome[];
  /** Wall clock for the whole wave. */
  ms: number;
}

export interface FanoutOptions {
  /** The barrier's label, e.g. 'portalEmployee.batch'. One timeout under this name if it bounds out. */
  label: string;
  /** The bound for the whole wave, and the dispatcher's deadline. Defaults to DB_TIMEOUT_MS. */
  ms?: number;
  /** How many members may be in flight at once. Defaults to defaultFanoutConcurrency(). */
  concurrency?: number;
}

/**
 * Run a wave of database reads with a bounded concurrency, one bounded barrier, and the ability to
 * decline the members that have not started yet.
 *
 * NEVER THROWS AND NEVER REJECTS. Every caller of this is a page composing a screen out of parts
 * that are individually allowed to be missing; a scheduler that could itself fail the render would
 * be a worse fault than any of the reads it is scheduling. The barrier's error is RETURNED, on
 * `error`, for the caller that wants to log it.
 */
export async function runFanout(members: FanoutMember[], opts: FanoutOptions): Promise<FanoutResult> {
  const startedAt = Date.now();
  const ms = opts.ms ?? DB_TIMEOUT_MS;
  const label = opts.label;
  const deadline = startedAt + ms;

  const outcomes: FanoutOutcome[] = members.map((m) => ({
    label: m.label, ran: false, settled: false, skipped: null, threw: false, ms: 0,
  }));

  // Nothing to schedule. Returned rather than special-cased further down so that a page whose every
  // widget is ineligible does not report itself degraded — an empty wave answered completely.
  if (members.length === 0) {
    return {
      degraded: false, unread: [], ran: 0, settled: 0, skippedCircuit: 0, skippedDeadline: 0,
      inFlight: 0, threw: 0, timedOut: false, calledOff: false, error: null, outcomes, ms: 0,
    };
  }

  const width = Math.max(1, Math.min(
    Math.floor(opts.concurrency ?? defaultFanoutConcurrency()) || 1,
    members.length,
  ));

  // `let`, and declared above every reader of them. `const` is not hoisted and that has taken pages
  // down on this project; these are mutated by the workers below and read by the summary after.
  let cursor = 0;
  let stopped = false;
  let stopReason: 'circuit' | 'deadline' = 'deadline';

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= members.length) return;
      const o = outcomes[i];

      // ONCE CALLED OFF, STAYS CALLED OFF. A circuit that closes again while this wave is draining
      // must not restart dispatch: the breaker opened because three consecutive reads timed out, and
      // resuming a fan-out into that is how a retry becomes an outage amplifier.
      if (stopped) { o.skipped = stopReason; continue; }

      // THE BREAKER, ASKED BEFORE THE STATEMENT IS SENT rather than after it has been waited for.
      // This is the check the started-promise version could not make at all.
      if (dbCircuitOpen()) { stopped = true; stopReason = 'circuit'; o.skipped = 'circuit'; continue; }

      // THE CALLER HAS STOPPED WAITING, so there is nobody left for a new statement to answer.
      if (Date.now() >= deadline) { stopped = true; stopReason = 'deadline'; o.skipped = 'deadline'; continue; }

      o.ran = true;
      const at = Date.now();
      try {
        // THE SCOPE IS OPENED PER MEMBER, not once around the whole wave, so the label on a refusal
        // names the read that was declined rather than the barrier it happened to belong to.
        await inDbScope({ refuseWhenCircuitOpen: true, label: label + '/' + members[i].label },
          () => members[i].run());
      } catch {
        // A member is expected to swallow its own failure and set its own card's state — that is how
        // every one of them on /portal/employee is written. One that throws anyway must not take
        // down the other twenty; it is counted, and the wave is degraded for it.
        o.threw = true;
      } finally {
        o.settled = true;
        o.ms = Date.now() - at;
      }
    }
  };

  const all = Promise.all(Array.from({ length: width }, () => worker()));

  let error: unknown = null;
  let timedOut = false;
  try {
    // ONE BOUND OVER THE WHOLE WAVE. Not one per member — see the header, and the docblock on the
    // barrier this replaces.
    await withDbTimeout(all, label, ms);
  } catch (e: any) {
    error = e;
    timedOut = e instanceof DbTimeoutError || e?.name === 'DbTimeoutError';
  }

  // THE WAVE IS OVER THE INSTANT THE CALLER STOPS WAITING, and this line is what makes that true of
  // the DISPATCHER and not only of the wait. Without it a worker whose member finally answered three
  // seconds after the bound would calmly pick up the next undispatched read and send it.
  stopped = true;

  // Anything a worker never reached — because every worker was stuck on a member that has not
  // answered — is unread for the same reason the wave ended. Claimed here so `run()` can no longer
  // be invoked for it above.
  for (const o of outcomes) {
    if (!o.ran && !o.skipped) o.skipped = stopReason;
  }

  const skippedCircuit = outcomes.filter((o) => o.skipped === 'circuit').length;
  const skippedDeadline = outcomes.filter((o) => o.skipped === 'deadline').length;
  const ran = outcomes.filter((o) => o.ran).length;
  const settled = outcomes.filter((o) => o.settled).length;
  const inFlight = outcomes.filter((o) => o.ran && !o.settled).length;
  const threw = outcomes.filter((o) => o.threw).length;
  const unread = outcomes.filter((o) => !o.settled || o.threw).map((o) => o.label);
  const calledOff = skippedCircuit > 0 || (!!error && !timedOut);

  const result: FanoutResult = {
    degraded: unread.length > 0,
    unread, ran, settled, skippedCircuit, skippedDeadline, inFlight, threw,
    timedOut, calledOff, error, outcomes, ms: Date.now() - startedAt,
  };

  // ONE LINE, AND ONLY WHEN SOMETHING WAS MISSED. A wave that answered completely is the ordinary
  // case and does not need a log entry; a wave that did not is the only evidence anybody will have
  // about a screen that rendered half empty, and "which reads never happened" is the part that
  // cannot be reconstructed afterwards.
  if (result.degraded) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'db.fanout_degraded',
      label, members: members.length, concurrency: width, ms: result.ms, boundMs: ms,
      ran, settled, inFlight, skippedCircuit, skippedDeadline, threw, timedOut, calledOff,
      unread: unread.slice(0, 24),
    }));
  }

  return result;
}
