// src/lib/pg-array.ts — safely write a JS string array into a Postgres text[] column.
//
// WHY THIS EXISTS. Interpolating a JS array into a drizzle `sql` template and casting it —
// `${jsArray}::text[]` — DOES NOT WORK. postgres-js/drizzle serialises a JS array as a row/record
// literal, so Postgres rejects the statement with "cannot cast type record to text[]". The pattern
// looks correct and even had a comment in role-aicte.ts claiming the cast was the fix for that very
// error, so it survived in four separate places and broke each of them silently for months:
//
//   role-aicte.ts       every AICTE field (keywords, learning_outcomes, qualifications,
//                       specialisations, perks, engagement_notes) stayed NULL on all 988 live roles
//   role-products.ts    product tags never saved, which also 500'd every role save in the admin
//   applicant-profile.ts an applicant who typed ANY skill could not save their profile at all
//   resume.ts           bulk delete of resume submissions silently did nothing
//
// Every one of those calls sat inside a try/catch, which is why nothing ever surfaced.
//
// THE FIX. Send the array as ONE ordinary text parameter (a JSON string) and let Postgres unpack it.
// This is injection-safe and needs no manual escaping of commas, quotes, braces or backslashes —
// all of which occur in real role and profile text. Hand-building a '{a,b,c}' array literal also
// works (see portal/meet/[id].astro) but only if that escaping is exactly right, which is not worth
// the risk on user-supplied input.
import { sql } from 'drizzle-orm';

/**
 * A text[] SQL fragment built from a JS string array.
 *
 * Do NOT add a `::text[]` cast at the call site — the fragment is already text[]-typed.
 *
 * @param xs            the strings; null/undefined and non-string entries are dropped
 * @param nullWhenEmpty return NULL instead of an empty array when there is nothing to write.
 *                      Use this only where the column's existing semantics distinguish
 *                      "no value" from "empty list" (applicant_profiles.skills does).
 */
export function textArray(xs: readonly unknown[] | null | undefined, nullWhenEmpty = false) {
  const arr = (xs || []).filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (!arr.length) return nullWhenEmpty ? sql`NULL::text[]` : sql`ARRAY[]::text[]`;
  return sql`(SELECT array_agg(t.x) FROM jsonb_array_elements_text(${JSON.stringify(arr)}::jsonb) AS t(x))`;
}

/**
 * An `IN (...)` membership fragment for matching a column against a JS string array.
 *
 * Callers must guard against an empty list themselves — `IN ()` is a syntax error, and silently
 * matching nothing (or everything) would be worse than an explicit early return.
 */
export function textIn(xs: readonly string[]) {
  return sql`(SELECT jsonb_array_elements_text(${JSON.stringify([...xs])}::jsonb))`;
}

/**
 * The same membership test for a UUID column.
 *
 * `WHERE id = ANY(${jsArray}::uuid[])` IS THE SAME BUG THIS FILE WAS WRITTEN ABOUT, and it was
 * still live in five places long after the text[] half was fixed. postgres-js serialises the array
 * as a record literal, so Postgres answers "cannot cast type record to uuid[]" and the statement
 * never runs. Every one of those five sat behind either a swallowing catch or a generic error
 * banner, so the controls simply did not work:
 *
 *   /admin/tests/attempts     the proctoring event counts for every attempt on the board
 *   /admin/users              bulk-approve of a SELECTED set of accounts (approve-all worked,
 *                             because that branch has no array)
 *   /admin/applications       the deleted_at half of bulk delete/archive — the write that actually
 *                             puts a row in Trash, run after the archive flag had already been set
 *   /admin/mail/analytics     recipient counts and delivery status
 *   /portal/index             pruning abandoned application intents, inside catch (_) {}
 *
 * Written as `IN (SELECT ...::uuid)` rather than `::text` comparison so the column's own index is
 * still usable.
 *
 * Callers must guard the empty case themselves, exactly as with textIn().
 */
export function uuidIn(xs: readonly string[]) {
  return sql`(SELECT t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify([...xs])}::jsonb) AS t(x))`;
}
