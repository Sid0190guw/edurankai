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
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { euclid, parseLiveDescriptor, causeOf, DESCRIPTOR_DIMS } from '@/lib/auth/face';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// Declared before the handler that reads them — `const` is not hoisted.
const FACE_MATCH_THRESHOLD = 0.55; // a hair more lenient for self-enrollment

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

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
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
      VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${matchDistance}, true, 'verified', 'self_enroll', ${ip || null}, ${ua})
    `).catch(() => {});

    return json({ ok: true, message: 'Face enrolled. You can now use it to sign in.' });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[api/auth/enroll-face]', causeOf(e));
    return json({ ok: false, error: 'We could not save that enrolment. Please try again.' }, 500);
  }
};
