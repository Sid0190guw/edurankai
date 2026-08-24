// src/pages/portal/logout.ts — THE portal sign-out. One mechanism, and this is it.
//
// There is no second session-clearing path in this codebase and there must not be one: /admin/logout
// does the same three things for the console (invalidateSession, clearSessionCookie, land somewhere
// safe) and every portal surface posts here. A second endpoint that "also signs you out" is how a
// session ends in the browser and survives on the server.
//
// WHAT CHANGED, AND WHY EACH CHANGE IS A SECURITY FIX RATHER THAN A TIDY-UP:
//
// 1. GET NO LONGER ENDS A SESSION. It used to. A GET that destroys state is triggered by a link
//    prefetch, an <img src>, a chat client unfurling a preview, a browser's speculative navigation,
//    or any page anywhere embedding <img src="https://.../portal/logout"> — and the symptom is
//    "the app randomly signs me out", which is close to undiagnosable from a support ticket because
//    the request looks exactly like a normal navigation in the log. GET now REDIRECTS to the
//    confirmation page, which shows who is signed in and carries the POST button. Every existing
//    `<a href="/portal/logout">` in the codebase (portal/index.astro, portal/profile.astro,
//    portal/courses/index.astro) therefore keeps working and becomes safe on the way, instead of
//    breaking into a 404 the day this file stopped answering GET.
//
// 2. THE SERVER-SIDE ROW IS DELETED, NOT JUST THE COOKIE. invalidateSession() hashes the token the
//    same way createSession() did and DELETEs that row from `sessions` (src/lib/auth/session.ts).
//    Dropping only the cookie would leave a token that is still valid to anyone who kept a copy of
//    it — which is precisely the shared/borrowed-phone case this control exists for.
//
// 3. A FAILED DELETE IS NEVER SWALLOWED. If the database refuses, this does NOT report a clean
//    sign-out: it logs the real Postgres reason (which lives on e.cause, not e.message), still
//    clears the cookie so the person is at least signed out of THIS browser, and lands them on a
//    page that says plainly that the server side did not finish and what to do about it. A bare
//    `catch {}` here would tell somebody on a borrowed phone that their session was ended when it
//    was not, which is the worst possible lie for this particular button to tell.
//
// 4. 303, NOT 302. The response to a POST must send the browser to the next page with a GET; 303 is
//    the status that says so. Browsers do it for 302 too, by convention rather than by spec, and
//    the convention is not worth relying on for the one request that must not be replayed.
// 5. THE DELETE IS BOUNDED, BECAUSE POINT 3 ABOVE WAS UNREACHABLE ON THE FAILURE THAT MATTERS.
//
//    "A failed delete is never swallowed" was true of a delete that FAILS. It was not true of one
//    that never answers, which is the failure this deployment actually has: opening a connection
//    costs ~810ms when it works and stalls past five seconds a fraction of the time. The await below
//    carried no bound, so a stall did not throw — the invocation died at the gateway instead. No
//    response, therefore no Set-Cookie, therefore clearSessionCookie() on the line after it never
//    reached the browser: the person on the borrowed phone got a hung tab and walked away still
//    signed in, on both halves, with the honest DONE_PARTIAL page never rendered. A catch cannot
//    catch a wait that never settles.
//
//    withDbRetry rather than withDbTimeout, and the distinction is not cosmetic: a DELETE by primary
//    key is idempotent, so asking twice is safe, and what fails here is the connection rather than
//    the statement — the abandoned first attempt leaves the connection it was opening in the pool,
//    so the second ask usually reuses it and answers in milliseconds. Worst case is 5s + 3s, well
//    inside the gateway, and anything thrown still lands in the catch below.
import type { APIRoute, AstroCookies } from 'astro';
import { invalidateSession } from '@/lib/auth/session';
import { withDbRetry } from '@/lib/db-timeout';
import { readSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';

// Declared before the handlers that use them — `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down in this repo before.

/** Where a completed sign-out lands: the confirmation, which is one tap from the sign-in form. */
const DONE = '/portal/sign-out?done=1';
/** Same page, plus the honest admission that only half of it worked. */
const DONE_PARTIAL = '/portal/sign-out?done=1&partial=1';
/** Where a GET lands: the same page, still signed in, showing WHO and offering the POST button. */
const CONFIRM = '/portal/sign-out';

/**
 * End the session. Returns true when the server-side row is gone, false when the delete failed.
 * The cookie is cleared either way — a browser that keeps holding a token it can no longer use is
 * strictly worse than one that drops it.
 */
async function endSession(cookies: AstroCookies): Promise<boolean> {
  const token = readSessionCookie(cookies);
  let serverSideEnded = true;
  if (token) {
    try {
      await withDbRetry(() => invalidateSession(token), 'logout.invalidate');
    } catch (e: any) {
      serverSideEnded = false;
      // The real Postgres reason is on e.cause; e.message is only the failed SQL. A DbTimeoutError or
      // a DbCircuitOpenError arrives here too, and lands in exactly the right place: the server side
      // is not known to have finished, so it is reported as not finished.
      console.error('[portal/logout] session delete failed', e?.cause?.message || e?.message);
    }
  }
  clearSessionCookie(cookies);
  return serverSideEnded;
}

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const ok = await endSession(cookies);
  return redirect(ok ? DONE : DONE_PARTIAL, 303);
};

/**
 * A GET signs NOBODY out. It only offers the control.
 *
 * `no-store` matters here: without it a cached 302 could keep bouncing somebody at the confirmation
 * page after they have signed in again.
 */
export const GET: APIRoute = async ({ redirect }) => {
  const res = redirect(CONFIRM, 302);
  res.headers.set('cache-control', 'no-store');
  return res;
};
