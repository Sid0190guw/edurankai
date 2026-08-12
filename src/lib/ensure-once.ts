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
