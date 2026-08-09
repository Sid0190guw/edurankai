// POST /api/auth/enroll-face
// Authenticated endpoint. Lets a logged-in user add a face descriptor to their
// account so face can be used as a sign-in method and as a second step.
// Body: { faceDescriptor: number[128], idDescriptor: number[128] }
//
// THE SERVER MEASURES THE MATCH. IT DOES NOT ACCEPT ONE.
//
// This route used to read `matchDistance` straight out of the request body and
// admit anybody who posted `{ matchDistance: 0.01 }` — so the check that the
// selfie belongs to the same person as the ID could be skipped by typing a
// number. The consequence was not abstract: it let somebody enrol ANY face
// (a colleague's, a photograph) against their own account and be marked
// identity_verified, which is exactly the assertion that attendance face checks
// and face sign-in are later trusted to have made.
//
// The comparison now happens HERE with the shared euclid() every other face
// path uses, and a client-supplied distance, score or verdict is ignored — the
// same rule /api/auth/face-match and /api/portal/attendance/punch follow.
//
// AND THE PART THAT MEASURING THE DISTANCE SERVER-SIDE DOES NOT FIX.
//
// BOTH descriptors come from the same caller. Comparing them proves only that whoever posted them
// posted two similar arrays - a request carrying { faceDescriptor: X, idDescriptor: X } measures a
// distance of exactly zero and passes every check this route can make. That is the shape
// /api/auth/identity-setup already names in its own header: two caller-supplied values compared to
// each other and called identity.
//
// It mattered because of what the write underneath it was. The INSERT is
// ON CONFLICT (user_id) DO UPDATE, and user_face_enrollments is not a preference: that row is
// simultaneously an accepted FIRST factor at the sign-in surfaces, the 'face' SECOND factor
// verifyFaceSecondFactor() reads, and what /api/portal/attendance/punch trusts when it marks
// somebody present. So any signed-in session - including a stolen one - could REPLACE the enrolled
// face outright, and be stamped identity_verified on the way. That is persistence surviving a
// password change, a standalone sign-in method for the attacker, the real owner's face locked out,
// and attendance fraud on somebody else's likeness.
//
// The other two doors into this table were closed for exactly this and this one was left open:
// /api/auth/enroll-face-selfie and /portal/enroll-face both gate REPLACEMENT on matchEnrolledFace().
// A guard that one door out of three skips is not a guard - and this was the door the other two
// point people at.
//
// THE RULE NOW, IDENTICAL TO BOTH SIBLINGS:
//   - FIRST enrolment is unchanged. No active row, no obstacle. That is the daily path (middleware
//     forces it on a first protected page load) and nobody loses it.
//   - RE-ENROLMENT must match the face already on file. Re-capturing in better light, on a new
//     phone, or after a haircut still passes. A genuinely different face does not, and the refusal
//     names the route out - a human reviewer - so nobody whose appearance really has changed is
//     dead-ended. That is where /api/auth/identity-setup sends a non-match too: a person decides.
//   - Two descriptors that are the SAME capture are refused outright. A live selfie and a photograph
//     of a document never produce a distance of zero; only a hand-made request does.
//   - The measured distance stays in the log and the audit row and out of every response body: a
//     numeric distance is a gradient an attacker can hill-climb toward the stored template.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { euclid, matchEnrolledFace, parseLiveDescriptor, causeOf, DESCRIPTOR_DIMS } from '@/lib/auth/face';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// Declared before the handler that reads them — `const` is not hoisted.
const FACE_MATCH_THRESHOLD = 0.55; // a hair more lenient for self-enrollment

/**
 * Below this, the two descriptors are not two captures - they are one array sent twice.
 *
 * face-api returns 128 floats computed from pixels; a live camera frame and a photograph of a
 * document differ in lighting, pose and sensor noise, so a genuine pair never lands here. Refusing
 * it costs no honest enrolment and removes the one-line forgery. It is a validity test on the input,
 * not a retune of FACE_MATCH_THRESHOLD, which is a policy number and is left exactly as it was.
 */
const SAME_CAPTURE_DISTANCE = 1e-6;

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in first.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  // parseLiveDescriptor enforces what "a descriptor" means: exactly 128 finite
  // numbers, not all zeros (all zeros is a "no face found" result, not a face).
  // The old check was `Array.isArray(x) && x.length === 128`, which accepted 128
  // strings and wrote them into the jsonb column, where they would never match
  // anything again.
  const descriptor = parseLiveDescriptor(body?.faceDescriptor);
  const idDescriptor = parseLiveDescriptor(body?.idDescriptor);

  if (!descriptor) {
    return json({ ok: false, error: 'Invalid selfie descriptor (need ' + DESCRIPTOR_DIMS + ' numbers, and a face must be visible).' }, 400);
  }
  if (!idDescriptor) {
    return json({ ok: false, error: 'Invalid ID descriptor (need ' + DESCRIPTOR_DIMS + ' numbers, and a face must be visible on the document).' }, 400);
  }

  // MEASURED HERE. `body.matchDistance` is deliberately never read.
  const matchDistance = euclid(descriptor, idDescriptor);
  if (!Number.isFinite(matchDistance) || matchDistance > FACE_MATCH_THRESHOLD) {
    return json({ ok: false, error: 'The face on the ID does not match the selfie closely enough. Retry with better lighting and no glasses.' }, 400);
  }
  if (matchDistance < SAME_CAPTURE_DISTANCE) {
    // Not a near miss and not worth a soft word: the selfie and the document are the same array.
    console.warn('[api/auth/enroll-face] identical selfie and ID descriptors from user ' + user.id + ' - refused');
    return json({ ok: false, error: 'Capture your selfie and your ID separately - those two readings are identical, so the document check could not run.' }, 400);
  }

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
    // REPLACEMENT IS GATED, EXACTLY AS IT IS ON THE OTHER TWO DOORS.
    //
    // matchEnrolledFace() reads the stored template, compares on the server and returns a boolean;
    // `enrolled` is false when there is no active row, which is first enrolment and passes straight
    // through. It THROWS rather than reporting a false negative when the database cannot be reached -
    // an auth path must not turn "the database is down" into "your face is wrong" - and the catch
    // below reports that honestly instead of enrolling anyway.
    const existing = await matchEnrolledFace(String(user.id), descriptor);
    if (existing.enrolled && !existing.matched) {
      // The distance the SERVER measured goes to the audit row and the log, never to the response.
      console.warn('[api/auth/enroll-face] replacement refused for user ' + user.id + ' (distance ' + existing.distance.toFixed(4) + ')');
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, face_match_distance, face_match_passed, verdict, method, reject_reason, ip_address, user_agent)
        VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${existing.distance}, false, 'rejected', 'self_enroll_replace', 'live capture does not match the enrolled face', ${ip || null}, ${ua})
      `).catch((e: any) => console.error('[api/auth/enroll-face] audit', causeOf(e)));
      return json({
        ok: false,
        error: 'That does not match the face already enrolled on this account, so nothing has been changed. If your appearance has genuinely changed, email hr@edurankai.in - a person reviews the document and updates it.',
      }, 403);
    }

    // Bound as a parameter and cast, not spliced into the statement as text.
    await db.execute(sql`
      INSERT INTO user_face_enrollments (user_id, face_descriptor, device_info, is_active)
      VALUES (${user.id}, ${JSON.stringify(descriptor)}::jsonb, ${ua}, true)
      ON CONFLICT (user_id) DO UPDATE SET
        face_descriptor = EXCLUDED.face_descriptor,
        device_info = EXCLUDED.device_info,
        is_active = true,
        enrolled_at = NOW()
    `);

    await db.execute(sql`
      UPDATE users SET identity_verified = true, identity_verified_at = NOW(), updated_at = NOW()
      WHERE id = ${user.id}
    `);

    // The distance recorded here is the one the SERVER measured, so the audit row
    // says what happened rather than what the browser claimed happened.
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, claimed_name, face_match_distance, face_match_passed, verdict, method, ip_address, user_agent)
      VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${matchDistance}, true, 'verified', ${existing.enrolled ? 'self_enroll_replace' : 'self_enroll'}, ${ip || null}, ${ua})
    `).catch(() => {});

    return json({ ok: true, message: 'Face enrolled. You can now use it to sign in.' });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[api/auth/enroll-face]', causeOf(e));
    return json({ ok: false, error: 'We could not save that enrolment. Please try again.' }, 500);
  }
};
