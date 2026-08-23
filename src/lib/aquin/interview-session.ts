// src/lib/aquin/interview-session.ts — proving that a caller is the candidate whose interview
// session this is.
//
// =================================================================================================
// THE HOLE THIS CLOSES
// =================================================================================================
//
// Five endpoints under /api/aquintutor/interview/ took a `sessionId` out of the request body and did
// the work. That string is the WHOLE credential, and /api/ has no structural gate — src/middleware.ts
// exempts it, so whatever a route checks for itself is the only thing in front of it. Each of those
// five files carried a note saying exactly this and deferring the fix:
//
//   enroll-face   overwrite the BIOMETRIC REFERENCE DESCRIPTOR of an in-progress interview and set
//                 preflight_passed = true, i.e. substitute your own face as the candidate's
//                 reference, which every later identity check is measured against
//   id-doc        replace the government ID photograph a reviewer will look at, and, on the way, an
//                 unauthenticated 12 MB upload into the public blob store
//   log-event     drive another person's risk_score, strikes_count and tab_switches, and trip the
//                 auto-termination in their name — into a pipeline CLAUDE.md says a human reads as
//                 evidence
//   turn          append transcript turns to a named candidate's record
//   end           end somebody else's interview and push a "completed" notification naming them
//
// =================================================================================================
// WHY A COOKIE, AND WHY THIS IS NOT THE SIGN-IN THOSE NOTES WERE WAITING FOR
// =================================================================================================
//
// The deferral reason given was that binding the session to a signed-in user "changes who can call
// the route". It would — candidates take these interviews without an account, and requiring one is a
// policy decision. This is not that. The session is bound to THE BROWSER THAT STARTED IT: /start
// mints a signature over the new session id and sets it as an HttpOnly cookie, and the five writers
// require it back. The same anonymous candidate may still do everything they could do before; what
// stops working is doing it to a session that is not yours.
//
// A cookie rather than a token in the URL, because the session id already travels as ?session= from
// page to page — a credential in a query string lands in history, in a referrer and over somebody's
// shoulder. HttpOnly also keeps it out of reach of page script, so an XSS on the interview screen
// cannot read it out and replay it elsewhere. SameSite=Lax means a cross-site POST does not carry
// it, which is the CSRF half of the same problem.
//
// FAILS CLOSED WITH NO SECRET. Without SESSION_SECRET nothing can be signed, so nothing verifies and
// every guarded write is refused. That is not a new outage: SESSION_SECRET is already a blocking
// requirement (src/lib/deployment-readiness.ts) because without it nobody can stay signed in either.
//
// THE ONE COST, STATED PLAINLY: a session already in progress when this ships has no cookie, so its
// next write is refused and that candidate has to start again. There is no way to grant a grace
// period without a column to record "this session was never bound", and an absent cookie treated as
// permission is the hole itself. Deploy it when no interview is being sat.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';

export const INTERVIEW_COOKIE = 'era_interview';

/** How long the cookie lives. Longer than any interview, shorter than a shared machine's day. */
export const INTERVIEW_COOKIE_MAX_AGE_SECONDS = 6 * 60 * 60;

/** Domain-separated so a signature minted here can never be replayed as some other token. */
const PREFIX = 'aquin-interview:v1:';

function secret(): string {
  return String(process.env.SESSION_SECRET || '').trim();
}

/** Is this deployment able to bind a session at all? False means every guarded write is refused. */
export function canBindSessions(): boolean {
  return secret().length > 0;
}

/**
 * The signature for one session id.
 *
 * Truncated to 32 base64url characters — 192 bits, far past guessing, and short enough that the
 * cookie stays small. Returns '' when there is no secret, which callers must treat as "cannot".
 */
export function signSession(sessionId: string, key = secret()): string {
  const id = String(sessionId || '');
  if (!key || !id) return '';
  return createHmac('sha256', key).update(PREFIX + id, 'utf8').digest('base64url').slice(0, 32);
}

/** The cookie's value: the session it is for, then its signature. */
export function cookieValueFor(sessionId: string, key = secret()): string {
  const sig = signSession(sessionId, key);
  return sig ? String(sessionId) + '.' + sig : '';
}

/** Split a cookie value without trusting its shape. A session id never contains a dot. */
export function parseCookieValue(raw: unknown): { sessionId: string; signature: string } | null {
  const s = String(raw || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return null;
  return { sessionId: s.slice(0, dot), signature: s.slice(dot + 1) };
}

/** Constant-time comparison that cannot throw on a length mismatch. */
function sameSignature(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Does this cookie value prove the holder started THIS session?
 *
 * Both halves are checked: the cookie must name the same session the request is acting on, and its
 * signature must be the one this deployment would have minted for it. Naming a different session is
 * refused even when the signature is genuine, which is what stops one legitimately held cookie from
 * being pointed at somebody else's interview.
 */
export function cookieProvesSession(rawCookie: unknown, sessionId: string, key = secret()): boolean {
  if (!key) return false;
  const id = String(sessionId || '');
  if (!id) return false;
  const parsed = parseCookieValue(rawCookie);
  if (!parsed || parsed.sessionId !== id) return false;
  return sameSignature(parsed.signature, signSession(id, key));
}

/** Bind a freshly created session to the browser that asked for it. */
export function bindSession(cookies: AstroCookies, sessionId: string): boolean {
  const value = cookieValueFor(sessionId);
  if (!value) return false;
  try {
    cookies.set(INTERVIEW_COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: import.meta.env.PROD,
      path: '/',
      maxAge: INTERVIEW_COOKIE_MAX_AGE_SECONDS,
    });
    return true;
  } catch {
    return false;
  }
}

export type SessionGuard =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * The check every interview writer runs before it touches a row.
 *
 * The refusal says what is wrong without saying whether the session exists — "not yours" and "no
 * such session" are the same sentence here, because the difference is a way to enumerate live
 * interviews. The route's own 404 for a missing session still fires afterwards for a caller who
 * does hold the cookie.
 */
export function guardInterviewSession(cookies: AstroCookies, sessionId: string): SessionGuard {
  if (!canBindSessions()) {
    // Said out loud: this is a configuration failure, not a candidate's mistake, and it stops every
    // interview on the deployment until it is fixed.
    console.error('[interview] SESSION_SECRET is not set, so no interview session can be bound or verified; refusing the write.');
    return { ok: false, status: 503, error: 'This deployment cannot verify interview sessions right now. Nothing was recorded.' };
  }
  let raw: string | undefined;
  try { raw = cookies.get(INTERVIEW_COOKIE)?.value; } catch { raw = undefined; }
  if (cookieProvesSession(raw, sessionId)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'This browser did not start that interview session. Start the interview again from its own page.',
  };
}
