// src/lib/auth/attempt-access.ts — "does this caller own this exam attempt?"
//
// WHY THIS EXISTS. /api/tests/save-progress, /api/tests/submit and /api/tests/log-event took an
// attemptId out of a request body and wrote to that row with no authorisation of any kind.
// log-event.ts even said so in its header: "No auth required ... we scope writes by attemptId only".
// Scoping by an identifier the caller supplies is not scoping. Anyone holding (or stumbling onto) an
// attempt id could overwrite another candidate's answers, submit and grade their paper for them, and
// write into test_attempt_events — the record a human later reviews when deciding whether somebody
// cheated. CLAUDE.md is explicit that proctoring is advisory and a human decides; a human deciding on
// evidence that anyone could forge is worse than no evidence, because it looks authoritative.
//
// WHAT OWNERSHIP MEANS HERE. There are exactly three writers of test_attempts
// (src/pages/aquintutor/test/[slug]/run.astro, /api/tests/guest-start, /api/tests/guest-confirm) and
// between them they create exactly two kinds of attempt:
//
//   1. candidate_id IS NOT NULL — a signed-in candidate. The session must BE that candidate.
//   2. candidate_id IS NULL     — a guest attempt. Both guest writers set an httpOnly cookie
//                                 `gat_<test_id>` holding the attempt id, and run.astro reads that
//                                 same cookie to resume. So the cookie is the guest's proof, and it
//                                 is the only proof they have. Requiring it changes nothing for a
//                                 real guest and removes the ability to act on someone else's paper.
//
// FAILS CLOSED. Unreadable attempt, malformed id, missing cookie, database error -> denied. A
// candidate who is wrongly refused re-opens the runner and their attempt resumes; a stranger who is
// wrongly allowed has already rewritten somebody's exam.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';

// Declared before the functions that use them — `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down on this project.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** The columns an ownership decision needs, and no others. */
export interface AttemptRow {
  id: string;
  test_id: string;
  candidate_id: string | null;
  status: string | null;
  submitted_at: string | null;
}

export type AttemptAccess =
  | { ok: true; attempt: AttemptRow; kind: 'candidate' | 'guest' }
  | { ok: false; status: 400 | 401 | 403 | 404 | 500; error: string };

/** Guest attempts are tied to the browser by this cookie. One name, used by every reader. */
export const guestAttemptCookieName = (testId: string): string => 'gat_' + String(testId);

/**
 * Resolve the attempt and decide whether this caller may act on it.
 *
 * `cookies` is Astro's cookie store from the route context. It is only consulted for guest
 * attempts, and only to compare against the attempt id the caller already sent.
 */
export async function attemptAccess(
  attemptId: string,
  locals: any,
  cookies: { get(name: string): { value?: string } | undefined } | null | undefined,
): Promise<AttemptAccess> {
  const id = String(attemptId || '').trim();
  if (!id) return { ok: false, status: 400, error: 'attemptId required' };
  // test_attempts.id is a UUID. A malformed value makes the query throw, and a thrown authorisation
  // check is a 500 whose meaning the caller has to guess — so it is refused as input instead.
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return { ok: false, status: 400, error: 'attemptId required' };
  }

  let found: any[];
  try {
    // Five columns. Not SELECT *: an authorisation check has no business pulling a candidate's
    // answers, score or contact details into the request context to decide one boolean.
    found = rows(await db.execute(sql`
      SELECT id, test_id, candidate_id, status, submitted_at
        FROM test_attempts
       WHERE id = ${id}::uuid
       LIMIT 1`));
  } catch (e: any) {
    logEvent('error', 'tests.attempt-access.lookup-failed', { attemptId: id, message: reason(e) });
    return { ok: false, status: 500, error: 'could not verify this attempt' };
  }

  if (found.length === 0) return { ok: false, status: 404, error: 'attempt not found' };

  const attempt: AttemptRow = {
    id: String(found[0].id),
    test_id: String(found[0].test_id),
    candidate_id: found[0].candidate_id == null ? null : String(found[0].candidate_id),
    status: found[0].status == null ? null : String(found[0].status),
    submitted_at: found[0].submitted_at == null ? null : String(found[0].submitted_at),
  };

  if (attempt.candidate_id) {
    const meId = String(locals?.user?.id || '');
    if (!meId) return { ok: false, status: 401, error: 'sign in to continue this attempt' };
    if (meId !== attempt.candidate_id) {
      logEvent('warn', 'tests.attempt-access.refused', {
        attemptId: attempt.id, userId: meId, reason: 'not-the-candidate',
      });
      return { ok: false, status: 403, error: 'this attempt belongs to someone else' };
    }
    return { ok: true, attempt, kind: 'candidate' };
  }

  // Guest attempt: the httpOnly cookie the runner set when the attempt was created.
  const cookieValue = String(cookies?.get(guestAttemptCookieName(attempt.test_id))?.value || '');
  if (!cookieValue || cookieValue !== attempt.id) {
    logEvent('warn', 'tests.attempt-access.refused', {
      attemptId: attempt.id, userId: String(locals?.user?.id || '') || null, reason: 'no-guest-cookie',
    });
    return { ok: false, status: 403, error: 'this attempt belongs to someone else' };
  }
  return { ok: true, attempt, kind: 'guest' };
}
