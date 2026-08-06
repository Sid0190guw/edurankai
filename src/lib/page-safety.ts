// PAGE SAFETY — the difference between "none" and "unknown", made mechanical.
//
// Every helper here exists because a specific page told a specific lie:
//
//   * `safeRows()` — a top-level `await db.execute(...)` with no catch takes the WHOLE page down
//     with a bare 500 when its table has not been created yet, and a `catch (_) {}` around the same
//     read renders an empty list that is indistinguishable from a genuinely empty one. Neither is
//     acceptable. safeRows returns BOTH the rows and whether the read succeeded, so the page can
//     say "you have none" or "we could not read this" and never confuse the two.
//
//   * `jsString()` — names were being interpolated into inline `onsubmit="return confirm('...')"`
//     with `.replace(/'/g, '')`, which DELETES the apostrophe. The admin was asked to confirm
//     deleting the record of "OBrien" — a person who does not exist, which is the one thing a
//     confirmation dialog is for. A name containing a newline terminated the JS string literal
//     outright, the handler became a syntax error, `confirm()` never fired, and the destructive form
//     submitted with no confirmation at all.
//
//   * `pageParam()` — `parseInt(url.searchParams.get('page') || '1')` bound straight into OFFSET.
//     `?page=abc` gives NaN, `?page=0` gives OFFSET -20, and Postgres refuses both: the register
//     500s on a URL anybody can type.
//
//   * `isoDate()` / `uuidish()` — a query-string value bound into `WHERE a.date = ${x}` or
//     `employee_id = ${x}` reaches Postgres as an invalid literal and raises 22007 / 22P02. The
//     fix is not a try/catch, it is refusing to build the query from a value that cannot be one.
//
//   * `dbReason()` — the house rule, in one place. On a drizzle/postgres-js error `.message` is the
//     failed SQL text; the real reason is on `.cause`.
//
// Nothing here touches a database, and nothing here decides authorization.

/** The real Postgres reason. `e.message` on a drizzle error is only the SQL that failed. */
export function dbReason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown database error');
}

/**
 * The outcome of one read, with "empty" and "failed" kept apart.
 *
 * `ok:false` means WE DO NOT KNOW what is there. `rows` is empty in that case too, which is exactly
 * why the flag has to be carried: a caller that looks only at `rows.length` cannot tell the
 * difference, and every "confident empty list" bug on this project came from that.
 */
export type ReadResult<T = any> = {
  ok: boolean;
  rows: T[];
  /** Present only when ok is false. The real Postgres reason, already unwrapped from `.cause`. */
  error: string | null;
};

/** postgres-js hands back a plain array; drizzle's own driver wraps it in `.rows`. Accept both. */
export function toRows<T = any>(r: any): T[] {
  return (Array.isArray(r) ? r : r?.rows || []) as T[];
}

/**
 * Run a read and report whether it worked. Never throws.
 *
 * `label` is what gets logged, so make it the thing a human would search for
 * ("[hr-attendance] day roster"), not "query failed".
 */
export async function safeRows<T = any>(label: string, run: () => Promise<any>): Promise<ReadResult<T>> {
  try {
    return { ok: true, rows: toRows<T>(await run()), error: null };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error(label + ' could not be read -', reason);
    return { ok: false, rows: [], error: reason };
  }
}

/** The single-row shape of the same idea. `row` is null both when there is none and when the read failed. */
export async function safeRow<T = any>(label: string, run: () => Promise<any>): Promise<{ ok: boolean; row: T | null; error: string | null }> {
  const res = await safeRows<T>(label, run);
  return { ok: res.ok, row: res.rows[0] ?? null, error: res.error };
}

/**
 * Escape a value for use inside a SINGLE-QUOTED JavaScript string in an HTML attribute.
 *
 * Both layers matter and both have burned this codebase:
 *   - backslash and quote escaping stops a name like O'Brien ending the literal, and
 *   - the newline/paragraph-separator escapes stop a pasted multi-line name doing the same thing
 *     invisibly (a raw newline is not legal inside a JS string literal at all, so the handler
 *     becomes a syntax error and confirm() silently never runs).
 *   - `<` is escaped as well so the text can never close a surrounding script or open a tag.
 *
 * The apostrophe SURVIVES — it is escaped, not deleted. A confirmation that renames the person it
 * is asking about is worse than no confirmation.
 */
export function jsString(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003C');
}

/**
 * A whole `onsubmit` value: `return confirm('...')`, with the message escaped once, here.
 *
 * Callers build the message as ordinary text and never think about quoting. A very long value
 * (a pasted 4,000-character "name") is clipped so the dialog stays readable — the underlying record
 * is untouched and the full value is still on the page itself.
 */
export function confirmAttr(message: string): string {
  return "return confirm('" + jsString(clip(message, 600)) + "')";
}

/**
 * Clip for display. Returns the value unchanged when it fits, so nothing is marked truncated that
 * is not. The caller keeps the full value and should still render it somewhere reachable (a title
 * attribute, the detail page) — this is a display cap, never a data cap.
 */
export function clip(value: unknown, max = 120): string {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  // Cut on a character boundary, not a code UNIT boundary: slicing a surrogate pair in half
  // produces a lone surrogate, which renders as a replacement box in the middle of a name.
  return Array.from(s).slice(0, Math.max(1, max - 1)).join('') + '…';
}

/** True when the clipped form differs from the original, so a page can offer the full value. */
export function isClipped(value: unknown, max = 120): boolean {
  return String(value ?? '').length > max;
}

/**
 * The first word of a name, for a compact chip — WITHOUT assuming there is one.
 * `full_name.split(' ')[0]` throws on a null name, and a mononym or a script that does not space
 * its words is not an error. Falls back to a stated placeholder rather than an empty chip.
 */
export function firstWord(value: unknown, fallback = 'Unnamed'): string {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  const head = s.split(/\s+/)[0];
  return head || fallback;
}

/** A page number that is always a positive integer, whatever the query string says. */
export function pageParam(raw: string | null | undefined, totalPages?: number): number {
  const n = Math.floor(Number(raw));
  let page = Number.isFinite(n) && n >= 1 ? n : 1;
  if (typeof totalPages === 'number' && totalPages >= 1 && page > totalPages) page = totalPages;
  return page;
}

/** YYYY-MM-DD, and a date that actually exists. '2026-02-31' passes the regex and fails here. */
export function isoDate(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return s;
}

/** A value safe to bind against a UUID column. Returns null rather than letting Postgres raise 22P02. */
export function uuidish(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s) ? s : null;
}

/**
 * Today in a named zone, as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0,10)` is UTC. On a Supabase/Vercel process that is five and a
 * half hours behind IST, so between 00:00 and 05:29 local "today" is yesterday on every
 * day-partitioned screen. This asks Intl for the civil date in the zone instead.
 *
 * It does NOT change what the database computes — CURRENT_DATE is still the session's zone. It only
 * fixes the value a page derives for itself, which is the part a page owns.
 */
export function civilToday(timeZone = 'Asia/Kolkata'): string {
  return civilDate(new Date(), timeZone);
}

/**
 * Any instant as its civil date in a named zone, YYYY-MM-DD.
 *
 * The companion civilToday needed for the OTHER end of a default window. A range built as
 * `civilToday()` back to `new Date(Date.now() - 30*86400000).toISOString().slice(0,10)` mixes two
 * calendars, and in the IST small hours its two ends are computed a day apart from each other.
 */
export function civilDate(when: Date | number | string, timeZone = 'Asia/Kolkata'): string {
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d.getTime())) return '';
  try {
    // en-CA formats as YYYY-MM-DD, which is the shape every date column here wants.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** N days before today, as a civil date in the same zone. Default report windows use this. */
export function civilDaysAgo(days: number, timeZone = 'Asia/Kolkata'): string {
  return civilDate(Date.now() - Math.max(0, Number(days) || 0) * 86400000, timeZone);
}
