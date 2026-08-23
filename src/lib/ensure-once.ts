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

export function ensureOnce(key: string, fn: () => Promise<void>): Promise<void> {
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
    await sqlClient().unsafe(ddl).simple();
  });
}
