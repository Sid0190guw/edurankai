// src/lib/campus-intake.ts — shared plumbing for the public campus intake forms.
//
// =================================================================================================
// WHY THIS EXISTS
// =================================================================================================
//
// Six forms across the campus pages posted to endpoints that had never been written. Each page
// created its own table, drew its own form, and pointed at a URL that answered 404. Two of them
// then told the person it had worked anyway:
//
//   test-centres  "Booking received. We will reach out via email within 24 h to confirm payment
//                  + seat."          — printed in the failure branch, with a comment saying so
//   forge         "Slot reserved. Operator will confirm via email within 30 minutes."
//   commons       "Saved locally. We will sync it shortly."  — nothing syncs anything
//
// A candidate who read the first of those believed a test seat was held for them. Nothing was
// stored anywhere, and nobody was ever going to email.
//
// So these endpoints exist to make those sentences true, and this module holds the parts all six
// need, so that six public write endpoints do not each invent their own validation.
//
// =================================================================================================
// THESE ARE PUBLIC, UNAUTHENTICATED WRITES
// =================================================================================================
//
// The campus pages have no login gate — that is deliberate, they are how somebody first reaches the
// place. So every one of these endpoints accepts input from anybody on the internet, and the rules
// below are the whole defence: cap every string, refuse anything that is not an email in the field
// called email, and never echo back what was stored.
//
// tooFast() counts attempts in the database, not in process memory. It used to be a Map, honestly
// labelled as bounding one instance rather than the fleet — but on serverless "bounds one instance"
// means it bounds nothing, because concurrent requests land on instances that each start empty. See
// the note above the function itself.
import { createHash } from 'node:crypto';

const rowsOfRaw = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
export const rowsOf = rowsOfRaw;

export function json(d: any, status = 200): Response {
  return new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Trim, cap, and treat blank as absent. Returns null rather than '' so NOT NULL columns bite. */
export function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s.length ? s : null;
}

/** Shape only. Deliverability is not knowable here and pretending otherwise would reject real addresses. */
export function email(v: unknown): string | null {
  const s = text(v, 200);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s.toLowerCase() : null;
}

/** A timestamp the database will accept, or null. Never passes an unparseable string through. */
export function when(v: unknown): string | null {
  const s = text(v, 64);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function num(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// -------------------------------------------------------------------------------------------------
// Flood guard, counted in the database because this runs on serverless.
//
// This was a Map in module memory. On Vercel that is not a weak rate limit, it is NO rate limit
// wearing the shape of one: concurrent requests land on different instances that each start with an
// empty Map, a cold start wipes the count, and `hits.clear()` at 5000 keys let anyone reset every
// bucket at once by spraying distinct keys. Seven unauthenticated write endpoints treat this
// function as their only ceiling, and each returns a 429 that made them look protected in review.
// src/lib/talent/codes.ts:35 states the rule this broke: attempts are recorded in a table, because
// an in-memory counter on serverless is the same as having no rate limit while looking like it has
// one.
//
// countAttempt() is the project's one attempt counter (src/lib/auth/two-factor.ts) — a single
// atomic INSERT ... ON CONFLICT DO UPDATE RETURNING, so two concurrent lambdas cannot both see "1".
// Reused rather than duplicated, for the reason src/lib/auth/recovery.ts gives: one limiter, one
// table, one place to raise a threshold.
// -------------------------------------------------------------------------------------------------
const WINDOW_SECONDS = 60;
const MAX_IN_WINDOW = 6;

/** Hashed so the attempt table never becomes an incidental log of who submitted what. */
export function intakeBucket(bucket: string, who: string): string {
  return 'intake:' + bucket + ':' + createHash('sha256').update(who || 'unknown').digest('hex').slice(0, 32);
}

/** The decision itself, kept pure so it is testable without a database. */
export function overIntakeLimit(attempts: number): boolean {
  return attempts > MAX_IN_WINDOW;
}

/**
 * Count this submission and say whether the caller has run out of allowance.
 *
 * FAILS OPEN. If the counter cannot be reached, let the submission through: these are the forms by
 * which somebody first reaches the place, and the write they guard is one cheap validated INSERT.
 * A counter outage must not become "nobody can sign up". (Compare overRecoveryLimit(), which fails
 * CLOSED — waving an attacker through there costs an account, which is the opposite trade.)
 */
export async function tooFast(bucket: string, who: string): Promise<boolean> {
  try {
    // Imported HERE, not at module scope. src/lib/auth/two-factor.ts reads import.meta.env at module
    // scope, which is undefined outside Vite — so importing it at the top of this file made the pure
    // validators below unloadable in the shim test runner and took the whole suite down with them.
    // src/lib/db/index.ts carries the same scar. tooFast is already async, so this costs nothing.
    const { countAttempt } = await import('@/lib/auth/two-factor');
    return overIntakeLimit(await countAttempt(intakeBucket(bucket, who), WINDOW_SECONDS));
  } catch (e: any) {
    logFail('campus-intake/limiter', e);
    return false;
  }
}

/** The real Postgres reason is on e.cause; e.message is only the failed statement. */
export function logFail(where: string, e: any): void {
  console.error('[' + where + '] ' + (e?.cause?.message || e?.message || String(e)));
}

/** Read a JSON body without throwing on a malformed one. */
export async function bodyOf(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}
