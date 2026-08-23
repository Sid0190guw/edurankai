// src/lib/horizon/pg.ts — the two postgres-js facts every HORIZON module has to know, in one place.
//
// Both of these are house rules recorded in CLAUDE.md, and both have cost this project production
// incidents. They live in their own module because they are PURE — no database import, so any file
// that needs them stays unit-testable without a connection.

/**
 * postgres-js `execute()` resolves to a PLAIN ARRAY, never a `{ rows }` object.
 *
 * `r.rows[0]` therefore reads `undefined[0]` and throws, or — worse — reads nothing and reports an
 * empty result. Every raw-SQL read in this codebase normalises through a helper exactly like this
 * one; HORIZON keeps its own copy rather than importing another patch's internals, because a shared
 * helper across a module boundary is a coupling nobody signed up for.
 */
export function rowsOf(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/**
 * The REAL Postgres error is on `e.cause`. `e.message` is just the SQL that failed.
 *
 * An operator reading a log line that contains an INSERT statement and no reason cannot tell it from
 * noise. This is the difference between a diagnosable incident and an afternoon.
 */
export function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || e || 'unknown error');
}

/** Clamp a free-text error to a size a column can hold. Diagnosis, not an archive. */
export function truncateReason(s: string, max = 500): string {
  const t = String(s || '');
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}
