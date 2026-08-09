// src/pages/aquintutor/logout.ts — the AquinTutor surface's sign-out.
//
// ═══ A GET NO LONGER ENDS A SESSION ═══
//
// This file carried the same destructive GET that src/pages/portal/logout.ts was repaired for and
// that src/pages/admin/logout.ts has now been repaired for: a GET that destroys state is fired by a
// link prefetch, an <img src>, a chat client unfurling a link preview, or a browser's speculative
// navigation, so any page anywhere could sign a learner out by embedding
// `<img src="https://www.edurankai.in/aquintutor/logout">` — and "the site keeps signing me out"
// is close to undiagnosable from the logs, because the request looks like an ordinary navigation.
//
// NOTHING LOSES A WAY OUT. The only caller in the codebase is the POST form on
// src/pages/aquintutor/profile.astro, which is untouched. A GET now lands on /portal/sign-out — the
// one confirmation page this codebase has, exempt in src/middleware.ts — which names who is signed
// in and carries the POST button. A second confirmation page is how two sign-outs come to disagree
// about what "signed out" means, so this reuses that one rather than adding another.
//
// ═══ A FAILED DELETE IS NOT REPORTED AS A CLEAN SIGN-OUT ═══
//
// There was no error handling at all: a refused DELETE threw, the response was a 500, and the cookie
// was never cleared, so the person stayed signed in on a page that merely looked broken. Now the
// real Postgres reason (which lives on e.cause, not e.message) is logged, the cookie is cleared
// regardless so the browser is at least signed out of THIS device, and a partial sign-out says so
// on the confirmation page instead of passing for a complete one.
import type { APIRoute, AstroCookies } from 'astro';
import { invalidateSession } from '@/lib/auth/session';
import { readSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';

// Declared before the handlers that use them — `const` is not hoisted.

/** Where a clean sign-out lands: back on the AquinTutor front, signed out. */
const DONE = '/aquintutor';
/** The server side did not finish, so the person is told rather than reassured. */
const DONE_PARTIAL = '/portal/sign-out?done=1&partial=1';
/** Where a GET lands: still signed in, shown WHO, offered the POST button. */
const CONFIRM = '/portal/sign-out';

/**
 * End the session. Returns true when the server-side row is gone, false when the delete failed.
 * The cookie is cleared either way.
 */
async function endSession(cookies: AstroCookies): Promise<boolean> {
  const token = readSessionCookie(cookies);
  let serverSideEnded = true;
  if (token) {
    try {
      await invalidateSession(token);
    } catch (e: any) {
      serverSideEnded = false;
      console.error('[aquintutor/logout] session delete failed', e?.cause?.message || e?.message);
    }
  }
  clearSessionCookie(cookies);
  return serverSideEnded;
}

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const ok = await endSession(cookies);
  // 303: the response to a POST must send the browser on with a GET, and 303 is the status that
  // says so rather than the convention browsers happen to follow for 302.
  return redirect(ok ? DONE : DONE_PARTIAL, 303);
};

/** A GET signs NOBODY out. It only offers the control. */
export const GET: APIRoute = async ({ redirect }) => {
  const res = redirect(CONFIRM, 302);
  res.headers.set('cache-control', 'no-store');
  return res;
};
