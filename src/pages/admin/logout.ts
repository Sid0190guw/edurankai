// src/pages/admin/logout.ts — the admin console's sign-out.
//
// ═══ A GET NO LONGER ENDS A SESSION, AND IT USED TO ═══
//
// src/pages/portal/logout.ts was repaired for exactly this and spells out why: a GET that destroys
// state is fired by a link prefetch, an <img src>, a chat client unfurling a preview, a browser's
// speculative navigation, or any page anywhere embedding
// `<img src="https://www.edurankai.in/admin/logout">`. The console's half was left behind, so the
// highest-value session on the platform could be ended by any third-party page an administrator
// happened to open, with no interaction at all — and the symptom, "the admin panel randomly signs me
// out", is close to undiagnosable from a support ticket because the request looks like an ordinary
// navigation in the log. src/middleware.ts isExempt() lists '/admin/logout', so nothing stands in
// front of this file.
//
// GET now REDIRECTS to the sign-out confirmation instead. `src/layouts/AdminLayout.astro` renders
// `<a href="/admin/logout">Sign Out</a>` in the drawer (that file is out of bounds for edits), so
// the link keeps working and becomes safe on the way: it lands on a page that names who is signed in
// and carries the POST button. /portal/sign-out is the ONE confirmation page this codebase has and
// it is exempt in middleware, so an administrator reaches it signed in; the button on it posts to
// /portal/logout, which clears the same session cookie and deletes the same `sessions` row. A second
// confirmation page is how two sign-outs come to disagree about what "signed out" means.
//
// ═══ A FAILED DELETE IS NOT REPORTED AS A CLEAN SIGN-OUT ═══
//
// The POST arm previously had no error handling at all: a refused DELETE threw, the response was a
// 500, and the cookie was never cleared — so the person was left signed in on a page that looked
// broken. It now mirrors the portal exactly: log the real Postgres reason (which lives on e.cause,
// not e.message), clear the cookie regardless so the browser is at least signed out of THIS device,
// and land on a page that says plainly that the server side did not finish.
//
// 303, NOT 302, on the POST: the response to a POST must send the browser on with a GET, and 303 is
// the status that says so rather than the convention browsers happen to follow for 302.
import type { APIRoute, AstroCookies } from 'astro';
import { invalidateSession } from '@/lib/auth/session';
// THE SAME BOUND ITS PORTAL TWIN GOT, AND FOR THE SAME REASON.
//
// "The cookie is cleared either way" below is true of a delete that FAILS and false of one that
// never answers, which is the failure this deployment actually has: opening a connection costs
// ~810ms when it works and stalls past five seconds a share of the time. Unbounded, the invocation
// died at the gateway — no response, therefore no Set-Cookie, therefore clearSessionCookie() never
// reached the browser and an admin signing out of a shared machine walked away still signed in,
// with DONE_PARTIAL never rendered. A catch cannot catch a wait that never settles.
//
// withDbRetry, because a DELETE by primary key is idempotent and because what fails here is the
// connection rather than the statement: the abandoned attempt leaves the connection it was opening
// in the pool, so the second ask usually reuses it. Anything thrown still lands in the catch.
import { withDbRetry } from '@/lib/db-timeout';
import { readSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';

// Declared before the handlers that use them — `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down in this repo before.

/** Where a completed sign-out lands: the one confirmation page, one tap from the sign-in form. */
const DONE = '/portal/sign-out?done=1';
/** Same page, plus the honest admission that only the browser half worked. */
const DONE_PARTIAL = '/portal/sign-out?done=1&partial=1';
/** Where a GET lands: the same page, still signed in, showing WHO and offering the POST button. */
const CONFIRM = '/portal/sign-out';

/**
 * End the session. Returns true when the server-side row is gone, false when the delete failed.
 * The cookie is cleared either way — a browser holding a token it can no longer use is strictly
 * better than one that keeps a usable copy.
 */
async function endSession(cookies: AstroCookies): Promise<boolean> {
  const token = readSessionCookie(cookies);
  let serverSideEnded = true;
  if (token) {
    try {
      await withDbRetry(() => invalidateSession(token), 'adminLogout.invalidate');
    } catch (e: any) {
      serverSideEnded = false;
      // The real Postgres reason is on e.cause; e.message is only the failed SQL.
      console.error('[admin/logout] session delete failed', e?.cause?.message || e?.message);
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
 * `no-store` matters: without it a cached 302 could keep bouncing somebody to the confirmation page
 * after they have signed in again.
 */
export const GET: APIRoute = async ({ redirect }) => {
  const res = redirect(CONFIRM, 302);
  res.headers.set('cache-control', 'no-store');
  return res;
};
