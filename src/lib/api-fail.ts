// src/lib/api-fail.ts — what an API route returns when something threw that it did not expect.
//
// TWELVE ROUTES ALL DID THIS, IDENTICALLY:
//
//     catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
//
// which is wrong twice over, and the two faults hide each other.
//
//   1. IT LOGS NOTHING AND DIAGNOSES NOTHING. On a drizzle/postgres-js error `e.message` is the SQL
//      THAT FAILED — not the reason it failed. The reason is on `e.cause.message`. So the one place
//      that knew something had gone wrong threw the explanation away and kept the question.
//
//   2. IT SENDS THE FAILED SQL TO THE BROWSER. `/admin/aquintutor/.../edit.astro` renders the field
//      straight into `alert('Upload failed: ' + d.error)`. A person authoring a lesson got a dialog
//      containing this application's table and column names, and so did anyone who could reach the
//      route and make it throw. Nothing here was ever written to be read by a caller.
//
// So: the real reason is LOGGED, with a label naming the route, and the caller gets a sentence a
// person can act on. That is the split /api/admin/knowledge.ts already made correctly and this is
// the same rule in one place instead of thirteen.
//
// This is deliberately NOT src/lib/mailapi/errors.ts. That module answers the PUBLIC transactional
// mail API and owns a documented error envelope — a `type`/`doc_url`/`request_id` body that external
// integrators parse. These are internal routes whose callers read `{ ok, error }`. Reshaping their
// bodies to borrow that envelope would break every caller to gain nothing.
import { dbReason } from '@/lib/page-safety';

/**
 * Log the real reason, return a safe sentence.
 *
 * @param label   what a person would search the logs for — name the route, e.g. '[lesson-blocks] create'.
 * @param e       whatever was thrown.
 * @param message the sentence the caller shows. Say what did not happen and whether anything changed.
 * @param status  defaults to 500. Pass 4xx only when the caller genuinely caused it.
 */
export function apiFail(label: string, e: unknown, message: string, status = 500): Response {
  // dbReason unwraps e.cause first, and falls back to e.message for a non-database throw.
  console.error(label + ' failed -', dbReason(e));
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
