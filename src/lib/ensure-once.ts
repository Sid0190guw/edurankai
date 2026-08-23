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
// guardedDdl() bounds how long the ALTER WAITS; it does nothing about the readers piled up behind it
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
function bootstrapDisabled(): boolean {
  const v = String(process.env.SCHEMA_BOOTSTRAP || '').toLowerCase();
  if (v === 'on') return false;
  if (v === 'off') return true;
  // Local dev and the test suite create their schema as they go and depend on it.
  return process.env.NODE_ENV === 'production';
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
  return p.catch((e: any) => {
    console.error('[ensure-once] ' + key + ' failed:', e?.cause?.message || e?.message || e);
  });
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
    const { sqlClient } = await import('@/lib/db');
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
    await sqlClient().unsafe(guardedDdl(ddl)).simple();
  });
}

/**
 * Wrap a block of idempotent DDL so it cannot hold a table — or a pooler session — indefinitely.
 *
 * Exported because several bootstraps send their DDL through sqlClient().unsafe().simple() directly
 * rather than through ensureBatch(), and a guard that only half the batches use is not a guard.
 *
 * An EXPLICIT transaction, not the implicit one a multi-statement simple query already creates:
 * SET LOCAL has no effect outside a transaction block, and being certain of that is the whole point
 * of the statement.
 */
export function guardedDdl(ddl: string): string {
  const body = ddl.trim().replace(/;[ \t\r\n]*$/, '');
  return `BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
${body};
COMMIT;`;
}
