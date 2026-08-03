// POST /api/auth/face-match
//
// The interactive half of the login face gate. The browser captures a descriptor from the camera
// and asks "is this the enrolled face?". The server loads the enrolled descriptor, compares, and
// answers with a BOOLEAN. The enrolled descriptor never leaves this process.
//
// This endpoint exists because the comparison used to happen in the browser, which required
// shipping the enrolled biometric template to the browser (see src/lib/auth/face.ts for the full
// account). Moving the arithmetic here is the whole point; the descriptor stays behind.
//
// WHAT THIS ENDPOINT DOES NOT DO: it does not sign anybody in. It sets no cookie, creates no
// session, and touches no session table. It is a UX affordance that tells the camera loop when to
// stop scanning. The authoritative check is re-run from scratch by the `face_verified` form POST
// in the login page, which is the only place a session is minted. A caller who lies to themselves
// about this response gains nothing.
//
// Body: { liveDescriptor: number[128] | string, scope?: 'admin' | 'portal' | 'aquintutor' | 'hei' }
// Returns: { ok: true, matched: boolean } — never a distance, never a descriptor.
import type { APIRoute } from 'astro';
import { matchEnrolledFace, causeOf } from '@/lib/auth/face';

// Every const is declared above the handler. `const` is not hoisted and a handler reaching a later
// declaration has taken pages down on this project before.

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * WHICH USER IS BEING TESTED IS DECIDED BY AN httpOnly COOKIE, NEVER BY THE REQUEST BODY.
 *
 * Each login surface sets its own short-lived pending cookie only after a correct password, so a
 * caller cannot aim this endpoint at an arbitrary account: they must already hold a valid pending
 * cookie for that account. There is no userId parameter, deliberately.
 */
const PENDING_COOKIES: Record<string, string> = {
  admin: 'face_pending_user',
  portal: 'portal_face_pending',
  aquintutor: 'aquintutor_face_pending',
  hei: 'hei_face_pending',
};

/** Try the named scope first, then any other pending cookie that happens to be present. */
const resolvePending = (cookies: any): string => {
  for (const name of Object.values(PENDING_COOKIES)) {
    const v = cookies.get(name)?.value || '';
    if (v) return v;
  }
  return '';
};

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const scope = typeof body?.scope === 'string' ? body.scope : '';
  const named = PENDING_COOKIES[scope] ? cookies.get(PENDING_COOKIES[scope])?.value || '' : '';
  const userId = named || resolvePending(cookies);

  if (!userId) {
    // No pending cookie: the password step has not been completed (or it expired — the cookie is
    // short-lived). Nothing to compare against.
    return json({ ok: false, error: 'No pending sign-in. Start again from the password step.' }, 401);
  }

  try {
    const result = await matchEnrolledFace(userId, body?.liveDescriptor);

    // The distance is logged, not returned. Returning it would let a caller hill-climb toward the
    // enrolled template one probe at a time — the same biometric disclosure by a slower road.
    if (!result.matched) {
      console.warn(
        '[face-match] no match for pending user',
        userId,
        'enrolled=' + result.enrolled,
        'distance=' + (Number.isFinite(result.distance) ? result.distance.toFixed(3) : 'n/a')
      );
    }

    return json({ ok: true, matched: result.matched });
  } catch (e: any) {
    // Never swallowed: an auth path that hides its reason has hidden a total sign-in outage here
    // before. The real Postgres reason is on e.cause.
    console.error('[face-match] failed for pending user', userId, ':', causeOf(e));
    // Reported as an error, NOT as `matched: false`. A database problem is not a face mismatch,
    // and the camera loop must not read it as one and keep retrying forever.
    return json({ ok: false, error: 'Could not check your face right now. Try again, or use your password.' }, 500);
  }
};
