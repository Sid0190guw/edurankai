/**
 * src/lib/workforce/scale.ts — THE PRIMITIVES THAT LET THE EMPLOYEE PORTAL SURVIVE A LARGE ROLL.
 *
 * =================================================================================================
 * WHY THIS FILE EXISTS
 * =================================================================================================
 *
 * Nothing in here is clever. Every function is three lines of SQL construction. They are gathered
 * into one module because the three defects they fix were each written independently, in good
 * faith, in more than a dozen places — and each of them is invisible on a database with a hundred
 * employees and fatal on one with ten million.
 *
 * THE THREE DEFECTS.
 *
 * 1. `WHERE employee_id::text = $1`. A cast on the COLUMN. Postgres cannot use a plain btree index
 *    on `employee_id` to answer a predicate on `employee_id::text`, so the planner takes a
 *    sequential scan. `hr_attendance` carries one row per person per day: at ten million people
 *    that table gains roughly two and a half billion rows a year, and the "days recorded this
 *    month" card on the workspace home page reads it with exactly that predicate. The cast was
 *    added for a real reason — it cannot throw on a malformed id, where `$1::uuid` would — and the
 *    reason is kept. `idEq()` validates the shape in JavaScript FIRST and then emits the plain
 *    comparison, which is index-usable and equally incapable of throwing.
 *
 * 2. `SELECT ..., COUNT(*) OVER ()::int AS total ... LIMIT 8`. A window function is evaluated ABOVE
 *    the scan and BELOW the limit, so asking for eight names makes Postgres find and count every
 *    matching row first. `departmentRoster()` shows eight colleagues; on a department of eighty
 *    thousand it counted eighty thousand rows to do it. `countUpTo()` answers the same question
 *    against a ceiling — "500+" instead of an exact 83,417 — which is the only honest answer a page
 *    that shows eight rows was ever entitled to, and it stops reading at the ceiling.
 *
 * 3. `LIMIT n OFFSET n*page`. Not yet present in this portal, and this module exists partly to keep
 *    it that way: `keysetAfter()` is the paging primitive, because OFFSET makes page 900 read all
 *    of pages 1..899 to throw them away.
 *
 * =================================================================================================
 * WHAT THIS FILE MUST NEVER BECOME
 * =================================================================================================
 *
 * It builds SQL FRAGMENTS from values. It does not build them from column names supplied by a
 * caller's request, it does not interpolate anything unparameterised, and it holds no authorization
 * logic whatsoever. Every predicate here narrows; none of them grants. A screen that used one of
 * these to decide WHO may be read rather than WHICH ROWS to fetch would be putting an authorization
 * decision in a performance helper, which is exactly how a scope quietly widens.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';

/** postgres-js resolves to a plain array, never a `{ rows }` object. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
/** The real Postgres reason is on `e.cause`; `e.message` is only the failed statement. */
const logFail = (tag: string, e: any) =>
  console.error('[workforce/scale] ' + tag, e?.cause?.message || e?.message || e);

// -------------------------------------------------------------------------------------------------
// IDENTIFIERS
// -------------------------------------------------------------------------------------------------

/**
 * The canonical 8-4-4-4-12 form, any version, case-insensitive. Deliberately NOT the permissive
 * `[0-9a-f-]+` shape: a string that is merely uuid-ISH still throws when Postgres binds it as a
 * uuid, and the whole point of testing here is that nothing downstream can throw.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this string safe to hand Postgres where a uuid is expected? */
export function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * `column = value`, written so the index on `column` can answer it.
 *
 * THE WHOLE TRICK, and it is worth stating plainly because the wrong version of it is written more
 * than a hundred times in this repository: the cast goes on the PARAMETER, never on the COLUMN.
 * `col::text = $1` is a sequential scan. `col = $1` — with `$1` a well-formed uuid that Postgres
 * binds to the column's own type — is an index lookup. Same answer, different plan, and at ten
 * million rows the difference is the difference between a portal and an outage.
 *
 * WHEN THE VALUE IS NOT A UUID. Two of this product's id columns are genuinely ambiguous:
 * `departments.id` is UUID in db/hr-schema.sql and varchar(50) in src/lib/db/schema.ts, and the
 * schema file's own header says the live types win. So a department key can legitimately be a slug.
 * For a non-uuid value this falls back to `column::text = $1` — the old, scan-y form — because on a
 * text-typed column that is both correct and index-usable, and on a uuid-typed column it matches
 * nothing rather than throwing. The fast path is the one that actually runs in production.
 *
 * @param column  a STATIC fragment written by the caller (sql`e.department_id`). Never request input.
 * @param value   the id to compare against.
 * @param onEmpty what to emit when `value` is blank — `false` (match nothing) by default, which is
 *                how every scope helper in this codebase fails closed.
 */
export function idEq(column: SQL, value: unknown, onEmpty: SQL = sql`false`): SQL {
  const v = String(value ?? '').trim();
  if (!v) return onEmpty;
  if (UUID_RE.test(v)) return sql`${column} = ${v}`;
  return sql`${column}::text = ${v}`;
}

/**
 * `column IN (…)`, index-usable, for the handful of places that fan out over a set of ids.
 *
 * Blank and malformed entries are dropped rather than smuggled in as text comparisons: a list read
 * is a bulk path, and one bad entry must not turn the whole statement into a scan.
 *
 * IN, NOT `= ANY(array)`, and the reason is a drizzle detail worth writing down: a JavaScript array
 * interpolated into a `sql` template is expanded into a PARAMETER LIST — `($1, $2)` — not bound as a
 * single array value. So `= ANY(${list})` renders `= ANY(($1, $2))`, which Postgres reads as a row
 * constructor and rejects. `IN` consumes that same parameter list correctly, and the planner
 * rewrites it to `= ANY` internally anyway, so the plan is identical to the one intended.
 */
export function idIn(column: SQL, values: readonly unknown[]): SQL {
  const list = (values || [])
    .map((v) => String(v ?? '').trim())
    .filter((v) => UUID_RE.test(v));
  if (list.length === 0) return sql`false`;
  return sql`${column} IN ${list}`;
}

// -------------------------------------------------------------------------------------------------
// COUNTING
// -------------------------------------------------------------------------------------------------

/** The default ceiling. Past this, a screen that renders a handful of rows says "500+" and means it. */
export const COUNT_CEILING = 500;

export interface BoundedCount {
  /** Rows counted, never more than `ceiling`. */
  count: number;
  /** True when the ceiling was reached, so `count` is a floor and not a total. */
  atLeast: boolean;
  /** False when the read did not happen. `count` is then 0 and means nothing — say so on screen. */
  ok: boolean;
}

/**
 * How many rows match, counted no further than a ceiling.
 *
 * WHAT IT REPLACES. `COUNT(*) OVER ()` riding along on a LIMITed query, which is where this portal
 * was hiding its full scans: the window is computed over the entire matching set before the limit
 * is applied, so the query reads every row in a department to print eight names and a total.
 *
 * The subquery form (`SELECT 1 ... LIMIT ceiling`) is what bounds the work — the planner stops
 * reading at the ceiling, so the cost is fixed no matter how large the table grows.
 *
 * @param from a complete `FROM ... WHERE ...` fragment, ORDER BY omitted (ordering a count is waste).
 */
export async function countUpTo(from: SQL, ceiling = COUNT_CEILING): Promise<BoundedCount> {
  const cap = Math.max(1, Math.min(Math.trunc(ceiling) || COUNT_CEILING, 100000));
  try {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM (SELECT 1 ${from} LIMIT ${cap}) probe`);
    const n = Number(rowsOf(r)[0]?.n);
    const count = Number.isFinite(n) ? n : 0;
    return { count, atLeast: count >= cap, ok: true };
  } catch (e: any) {
    logFail('countUpTo', e);
    return { count: 0, atLeast: false, ok: false };
  }
}

/** "8", "500+", or "" when the count is not known. Never invents a number it did not read. */
export function countLabel(c: BoundedCount | null | undefined): string {
  if (!c || !c.ok) return '';
  return c.atLeast ? c.count + '+' : String(c.count);
}

// -------------------------------------------------------------------------------------------------
// PAGING
// -------------------------------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  /** True when at least one more row exists past the last item. Read from a cap+1 probe, not a count. */
  hasMore: boolean;
  /** Opaque cursor for the next page, or null at the end. */
  next: string | null;
  ok: boolean;
}

/**
 * Fetch `cap + 1`, return `cap`, and report whether the extra row existed.
 *
 * This is the honest replacement for a total on any list a person scrolls: it costs one extra row
 * instead of a full count, and it answers the only question the UI actually asks, which is whether
 * to draw a "next" control.
 */
export function probeMore<T>(fetched: readonly T[], cap: number): { items: T[]; hasMore: boolean } {
  const items = (fetched || []).slice(0, cap);
  return { items, hasMore: (fetched || []).length > cap };
}

/**
 * Keyset paging, never OFFSET.
 *
 * OFFSET n reads and discards n rows. On page 900 of a directory that is 22,500 rows read to show
 * 25, and it gets worse linearly forever. A keyset asks "after this exact row", which the same index
 * that produced the order can answer in one seek at any depth.
 *
 * The cursor is `(sortValue, id)` — the id is the tie-break, and it is REQUIRED. Sorting people by
 * `full_name` alone, with duplicates in the set (and at this scale there will be thousands of exact
 * duplicate names), produces a page boundary that can repeat or skip a person on every load.
 *
 * @param sortColumn static fragment, e.g. sql`e.full_name`
 * @param idColumn   static fragment, e.g. sql`e.id`
 * @param cursor     from `encodeCursor()`, or null/invalid for the first page.
 */
export function keysetAfter(sortColumn: SQL, idColumn: SQL, cursor: string | null | undefined): SQL {
  const c = decodeCursor(cursor);
  if (!c) return sql`true`;
  // ROW(...) > ROW(...) is the lexicographic comparison the composite index answers directly.
  return sql`(${sortColumn}, ${idColumn}) > (${c.sort}, ${c.id}::uuid)`;
}

/** Opaque, tamper-evident-enough for paging: it carries no authority, only a position. */
export function encodeCursor(sortValue: unknown, id: unknown): string {
  const payload = JSON.stringify([String(sortValue ?? ''), String(id ?? '')]);
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Null for anything malformed, and the caller then renders page one. A bad cursor is a stale link or
 * a typed URL, not an error worth a screen — but it must never become an unbounded read, which is
 * what happens if a decode failure is allowed to fall through into "no WHERE clause".
 */
export function decodeCursor(cursor: string | null | undefined): { sort: string; id: string } | null {
  const raw = String(cursor || '').trim();
  if (!raw || raw.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const sort = String(parsed[0] ?? '');
    const id = String(parsed[1] ?? '');
    // The id half is compared against a uuid column, so a malformed one would throw at bind time.
    if (!UUID_RE.test(id) || sort.length > 300) return null;
    return { sort, id };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// SEARCH
// -------------------------------------------------------------------------------------------------

/** Below this, a substring search over a large table is a scan with no selectivity to offer. */
export const MIN_SEARCH_CHARS = 2;

/**
 * A leading-anchored pattern (`term%`) rather than `%term%`.
 *
 * WHY IT MATTERS HERE. A btree index answers `col ILIKE 'sha%'` through a prefix range scan; it can
 * do nothing at all with `col ILIKE '%sha%'`, which reads every row and runs the matcher on each.
 * The portal's global search uses the unanchored form throughout, which is correct for a small
 * table and untenable for ten million people unless a pg_trgm GIN index is present — see
 * db/hr-scale-indexes.sql, which creates exactly that and is the reason the unanchored search is
 * left alone rather than quietly narrowed underneath the people using it.
 *
 * Both forms escape the LIKE metacharacters, so a person typing `100%` searches for `100%`.
 */
export function prefixPattern(term: string): string {
  return escapeLike(String(term || '').trim()) + '%';
}

export function containsPattern(term: string): string {
  return '%' + escapeLike(String(term || '').trim()) + '%';
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => '\\' + c);
}
