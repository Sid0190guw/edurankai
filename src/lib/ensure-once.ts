// Run a schema-ensure (CREATE TABLE IF NOT EXISTS / ALTER ...) at most ONCE per
// server process. Many libs call ensureX() at the top of every function; those
// DDL round-trips add up and keep the database compute busy.
// Caching the "already ensured" state per process removes that chatter while
// staying correct (the tables only need creating once).
//
// We memoize the in-flight promise (not just a "done" flag) so that concurrent
// callers on a cold process share a single DDL run instead of each firing their
// own. A failed run is dropped from the cache so the next call retries — a
// transient DB hiccup must not poison the process for its lifetime.
const cache = new Map<string, Promise<void>>();

// A KILL SWITCH FOR EVERY SCHEMA BOOTSTRAP IN THE CODEBASE, SETTABLE WITHOUT A DEPLOY.
//
// There are ~192 ensureOnce() keys and ~689 CREATE/ALTER statements behind them, and every one of
// them runs on the request path of a cold serverless instance. That is survivable until it is not:
// on 2026-08-23 the site served nothing but its database-free pages for the better part of an hour,
// and there was no way to stop the DDL short of shipping a commit into an outage.
//
// Set SCHEMA_BOOTSTRAP=off in the platform's environment variables and every ensure becomes a
// resolved promise. Nothing else changes: callers already tolerate a missing table — that tolerance
// is why the swallow below exists — so the failure mode is a feature reporting no rows rather than a
// site that will not load. Turn it back on to let a genuinely new table create itself, then off.
//
// OFF IN PRODUCTION BY DEFAULT, AND THAT DEFAULT IS THE POINT.
//
// Measured on the live site, 2026-08-23. Twenty concurrent requests to the homepage alone: every one
// answered, slowest 3.7s. The same twenty with /careers mixed in: four answered and sixteen returned
// nothing at all before the client gave up at thirty seconds. The homepage runs one SELECT against
// `roles`. /careers runs eighteen ALTER TABLE ... ADD COLUMN IF NOT EXISTS against `roles` first.
//
// That is the whole mechanism. ALTER TABLE needs ACCESS EXCLUSIVE, so it waits for the reads already
// in flight -- and while it waits, every NEW read of `roles` queues behind it, because a pending
// exclusive lock is granted ahead of the shared locks requested after it. Under continuous traffic
// the table is readable in the gaps between bootstraps and not otherwise, and every request stuck in
// that queue is holding a transaction-pooler session it cannot give back. The lock_timeout added in
// guardedDdlBody() bounds how long the ALTER WAITS; it does nothing about the readers piled up behind it
// while it does, and the retry it triggers starts the queue again on the next request.
//
// So production stops running DDL where visitors can wait for it. This is not a workaround for one
// page: ~192 ensure keys and ~689 CREATE/ALTER statements sit on the request path of every cold
// serverless instance, and any of them can do to its own tables what /careers does to `roles`.
//
// SCHEMA_BOOTSTRAP=on turns it back on without a code change -- set it, deploy something that needs
// a new table, confirm /api/health reports missingCount 0, unset it. Off is also settable explicitly
// for non-production. Nothing else changes when it is off: every caller already tolerates a missing
// table, which is why ensureOnce swallows in the first place, so the failure mode is a feature with
// no rows rather than a site that will not load.
//
// Read per call, not once at module scope, so the value is whatever the environment says NOW rather
// than whatever it said when this instance happened to boot.
//
// THE PREDICATE ITSELF MOVED TO src/lib/schema-bootstrap.ts, unchanged, and this is now one of two
// callers. The other is the DDL guard on db.execute(), which exists because this kill switch only
// ever covered the bootstraps that went THROUGH ensureOnce -- about forty modules run their ALTER
// TABLEs from a page's frontmatter without it, and were never switched off at all. Two enforcement
// points asking the same question is fine; two definitions of the answer would have drifted.
//
// AND IT ASKS ddlPermitted(), NOT schemaBootstrapEnabled(). That distinction is the whole point of
// the escape hatch and it was wrong here first time round.
//
// schemaBootstrapEnabled() reads the environment only. ddlPermitted() reads the environment OR the
// AsyncLocalStorage scope that allowingDdl() opens around a deliberate operator action -- the Repair
// button on /admin/setup and POST /api/admin/ops/bootstrap. With the environment-only test, those two
// surfaces opened the scope, every ensureOnce() key still short-circuited to Promise.resolve(), and
// each module reported ok:true having created nothing.
//
// That is not a small bug. `auth-registry` (src/lib/auth/registry.ts) is the ONLY creator of
// audit_log anywhere in this repository, and `error-log` (src/lib/logger.ts) owns edu_error_log's
// columns and indexes. An operator pressing Repair during an incident would have watched every row
// go green while the verification step underneath kept reporting the same tables missing -- which is
// verbatim the "ok: true, ran: 8, failed: 0 while ten tables were missing" failure this file's own
// header cites as the reason the swallow below is never silent.
import { ddlPermitted } from '@/lib/schema-bootstrap';

function bootstrapDisabled(): boolean {
  return !ddlPermitted();
}

// -------------------------------------------------------------------------------------------------
// WHAT ACTUALLY WENT WRONG, KEPT WHERE AN OPERATOR CAN READ IT
// -------------------------------------------------------------------------------------------------
//
// The swallow above is deliberate and stays. Its cost is that the ONE surface built to repair a
// schema — the "Create module tables" button on /admin/setup — could not see any of it: a module
// whose ensure went through ensureOnce reported success no matter what the database said, and the
// only failures the operator was shown belonged to the modules that happen NOT to memoise. On
// 2026-08-24 that produced a panel listing three innocent modules and the real one nowhere, because
// the module that actually broke had its reason logged to a console nobody can open in production.
//
// So the reason is kept here as well as logged. Bounded by the number of ensure keys (~192), one
// entry per key, overwritten by the next failure and deleted by the next success — a record of what
// is wrong NOW, never a growing log.
export interface EnsureFailure {
  key: string;
  /** The real Postgres reason (e.cause.message), never the failed SQL. */
  message: string;
  /** SQLSTATE where the driver gave one — '42P01' for a missing table, '25P02' for a poisoned connection. */
  code: string;
  at: string;
}
const failures = new Map<string, EnsureFailure>();

function recordEnsureFailure(key: string, e: any): void {
  failures.set(key, {
    key,
    message: String(e?.cause?.message || e?.message || e || 'unknown error').slice(0, 400),
    code: String(e?.cause?.code || e?.code || ''),
    at: new Date().toISOString(),
  });
}

/** Every ensure key that has failed in this process and not since succeeded. */
export function recentEnsureFailures(): EnsureFailure[] {
  return Array.from(failures.values());
}

/** Forget them — for an operator action that is about to re-run the ensures and wants a clean read. */
export function forgetEnsureFailures(): void {
  failures.clear();
}

export function ensureOnce(key: string, fn: () => Promise<void>): Promise<void> {
  if (bootstrapDisabled()) return Promise.resolve();
  let p = cache.get(key);
  if (!p) {
    p = fn().catch((e) => {
      cache.delete(key); // don't cache failures — retry on the next call
      throw e;
    });
    cache.set(key, p);
  }
  // Swallow here so callers keep their existing "tolerate missing schema"
  // behaviour; the retry-on-failure is handled by the cache.delete above.
  //
  // BUT NEVER SILENTLY. A resolved ensureOnce() proves only that the promise settled, not that any
  // DDL ran — and this project has already shipped a bootstrap endpoint that reported
  // `ok: true, ran: 8, failed: 0` while the health check said ten tables were missing, because the
  // ensures had all thrown into this catch. The swallow stays (callers depend on it); the SILENCE
  // does not. The real Postgres reason is on e.cause; e.message is just the failed statement.
  return p.then(
    () => { failures.delete(key); },
    (e: any) => {
      recordEnsureFailure(key, e);
      console.error('[ensure-once] ' + key + ' failed:', e?.cause?.message || e?.message || e);
    },
  );
}

/**
 * Run a block of idempotent DDL in ONE round trip instead of one per statement.
 *
 * WHY. These bootstraps are written as a sequence of `await db.execute(...)` calls, and each one is
 * a separate round trip to the database. That is invisible when the database is next door and
 * expensive when it is not: measured from the deployed function, a round trip costs ~177ms, so a
 * 21-statement bootstrap spends ~3.7s before the page runs its first real query. /careers paid
 * exactly that on every cold instance — its floor was 5s and its worst was 32s, on a public page
 * that job applicants land on.
 *
 * The statements are joined and sent over the SIMPLE protocol, which is what allows more than one
 * statement per message. postgres-js only accepts that through `unsafe()`, so the text is never
 * built from user input — every caller passes a string literal of `... IF NOT EXISTS` DDL.
 *
 * ONE IMPLICIT TRANSACTION. A batch sent this way succeeds or rolls back as a whole. For idempotent
 * DDL that is an improvement — a failure leaves nothing half-made, and ensureOnce drops the cache
 * entry so the next call retries the whole thing. But it means a batch is the WRONG shape wherever
 * a statement is deliberately allowed to fail on its own: some bootstraps here wrap an index in its
 * own try/catch precisely so a failure does not abort the rest. Keep those as separate calls.
 */
export function ensureBatch(key: string, ddl: string): Promise<void> {
  return ensureOnce(key, async () => {
    // A BATCH THAT CANNOT GET ITS LOCK MUST GIVE UP, NOT QUEUE.
    //
    // This is the part batching got wrong, and it took the site down on 2026-08-23. Every statement
    // here is idempotent and nearly all of them are no-ops in production — the table exists, the
    // column exists — but ALTER TABLE takes its ACCESS EXCLUSIVE lock BEFORE it evaluates IF NOT
    // EXISTS, and inside one transaction it holds every lock it takes until commit. One batch
    // therefore holds an exclusive lock on `roles` (thirteen ALTERs) for the length of the whole
    // batch, and a pending exclusive lock queues AHEAD of readers: every SELECT on that table waits
    // behind it. As separate statements each lock was taken and released in turn, so this never
    // showed.
    //
    // A deploy is what makes it fatal, because a deploy makes every instance cold at the same
    // moment: they all run these bootstraps at once and contend with each other on the same tables.
    // Each one blocked on a lock is also holding a session on the transaction pooler, which is how a
    // schema bootstrap becomes an empty connection pool and a site that answers only on the pages
    // that never touch the database.
    //
    // An EXPLICIT transaction, not the implicit one a multi-statement simple query already creates:
    // SET LOCAL has no effect outside a transaction block, and being certain of that is the whole
    // point of the statement. 3 seconds is far longer than an uncontended no-op ALTER needs and far
    // shorter than a request can afford to spend queuing. On timeout the batch rolls back whole,
    // ensureOnce drops the key, and the next request retries — by which time whoever held the lock
    // has almost certainly finished.
    await runGuardedDdl(ddl);
  });
}

// -------------------------------------------------------------------------------------------------
// THE SEND, AND WHY THE TRANSACTION MAY NOT BE PART OF THE TEXT
// -------------------------------------------------------------------------------------------------
//
// THIS IS THE 2026-08-24 /admin/setup BUG, AND IT WAS NOT A BUG IN ANY BOOTSTRAP.
//
// The wrapper below used to emit the transaction as text — `BEGIN; SET LOCAL ...; <ddl>; COMMIT;` —
// and every batch in this repository sent it through `sqlClient().unsafe(...).simple()`, one simple
// -protocol message. That is correct exactly as long as nothing fails.
//
// When a statement in a multi-statement simple query fails, PostgreSQL ABANDONS THE REST OF THE
// MESSAGE. The COMMIT at the end is one of the statements it abandons. The explicit BEGIN, however,
// has already run, so the connection is left sitting inside an ABORTED TRANSACTION — and postgres-js
// hands that connection straight back to the pool. Every later query that lands on it, in this
// request or anybody else's, is answered with
//
//     25P02  current transaction is aborted, commands ignored until end of transaction block
//
// until something sends ROLLBACK or the session is closed. That is not a 15-second window either:
// idle_in_transaction_session_timeout measures time spent IDLE, and a poisoned connection under
// traffic is never idle for long — each new query fails instantly and restarts the clock.
//
// WHAT IT LOOKED LIKE FROM OUTSIDE. On /admin/setup, one module's DDL failed for its own ordinary
// reason and then THREE more modules, the verification query and all six checklist counts reported
// `current transaction is aborted` — a screen full of errors with the real cause nowhere on it. Off
// that page it was worse: /admin/login answered "Sign-in is temporarily unavailable" for anyone
// whose request happened to draw the poisoned connection out of a five-slot pool.
//
// Reproduced and fixed against a real PostgreSQL (PGlite over TCP, never the production database):
// the old shape leaves 25P02 behind on the next two queries; the shape below rolls back, reports the
// REAL error (42P01 relation does not exist), and the very next query succeeds.
//
// SO THE DRIVER OWNS THE TRANSACTION NOW. postgres-js's begin() sends BEGIN on a reserved connection
// and, on any rejection from the callback, sends ROLLBACK on that same connection before rethrowing.
// The statements still travel as ONE simple-protocol message inside it, so the round-trip saving
// that batching exists for is unchanged, and SET LOCAL still runs inside a real transaction block.

/**
 * Send a block of idempotent DDL as one round trip, inside a transaction the DRIVER owns.
 *
 * The only sender in this repository. Nothing else may call `.simple()` on DDL: see the reckoning
 * above, and src/lib/ddl-transaction.test.ts, which fails the build if a second one appears.
 *
 * WHY THE TRANSACTION AT ALL — the lock argument, which has not changed. Every statement here is
 * idempotent and nearly all are no-ops in production, but ALTER TABLE takes its ACCESS EXCLUSIVE
 * lock BEFORE it evaluates IF NOT EXISTS, and a PENDING exclusive lock is granted ahead of shared
 * locks requested after it: every SELECT on that table queues behind a no-op ALTER. A deploy makes
 * every instance cold at once, so they all run these bootstraps together and contend on the same
 * tables — which is how a schema bootstrap became an empty connection pool on 2026-08-23. SET LOCAL
 * lock_timeout bounds the wait at 3 seconds; on timeout the batch rolls back whole, ensureOnce drops
 * the key, and the next request retries by which time the holder has almost certainly finished.
 *
 * Rejects with the real Postgres error. Callers decide whether that is fatal; this only guarantees
 * that a failure cannot be left behind on the connection.
 */
export async function runGuardedDdl(ddl: string): Promise<void> {
  const { sqlClient, healAbortedTransactions } = await import('@/lib/db');
  try {
    await sqlClient().begin(async (tx: any) => {
      await tx.unsafe(guardedDdlBody(ddl)).simple();
    });
  } catch (e: any) {
    // begin() has already sent ROLLBACK by the time this runs. The sweep is for the one case it
    // cannot cover — a connection that dropped, or a ROLLBACK that itself failed — and it is cheap
    // and debounced. Never let the recovery replace the real error.
    await healAbortedTransactions().catch(() => {});
    throw e;
  }
}

/**
 * The guarded DDL body: bounded locks, no transaction control.
 *
 * NO BEGIN AND NO COMMIT, and that absence is the fix. Whoever sends this must open the transaction
 * through the driver so that a failure is rolled back rather than left on the connection.
 */
export function guardedDdlBody(ddl: string): string {
  const body = ddl.trim().replace(/;[ \t\r\n]*$/, '');
  return `SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
${body};`;
}

/**
 * The same block as a script for a human to run — `psql -v ON_ERROR_STOP=1 -f`.
 *
 * This is the ONLY caller of BEGIN/COMMIT as text left in the repository, and it must never be sent
 * through `.simple()`: psql executes a file statement by statement and stops on the first error with
 * ON_ERROR_STOP, which is a different mechanism entirely from the one that poisoned the pool.
 */
export function guardedDdlScript(ddl: string): string {
  return `BEGIN;\n${guardedDdlBody(ddl)}\nCOMMIT;`;
}
