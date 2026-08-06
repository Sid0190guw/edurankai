// POST /api/auth/enroll-face-selfie
// Lightweight face enrolment for an already-authenticated user (e.g. right after an applicant
// submits their application, or when middleware forces enrolment on a first protected page load).
// Stores a selfie descriptor so face can be used as a sign-in method and as a second step. It does
// NOT set identity_verified — that requires the heavier ID-match flow in /api/auth/enroll-face.
// Body: { faceDescriptor: number[128], selfie?: dataURL }
//
// ═══ WHAT CHANGED, AND WHY ═══
//
// The INSERT carried `ON CONFLICT (user_id) DO UPDATE`, with nothing compared against anything. So a
// stolen or borrowed session could REPLACE the enrolled face outright — and that descriptor is
// simultaneously an accepted FIRST factor at the sign-in surfaces, the 'face' SECOND factor in
// src/lib/auth/two-factor.ts, and what /api/portal/attendance/punch trusts. Swapping it is
// persistence that survives a password change, and it enables attendance fraud on somebody else's
// likeness. A password can be rotated; the consequences of the wrong face on an account cannot.
//
// FIRST ENROLMENT is unchanged: no active row, no obstacle. That is the daily path (middleware
// forces it on a new hire's first protected page load) and nobody loses it.
//
// RE-ENROLMENT must now match the face already on file. matchEnrolledFace() reads the stored
// template, compares server-side, and returns a boolean — the template is never serialised into a
// response, which is the rule src/lib/auth/face.ts exists to enforce. Re-capturing in better light,
// on a new phone, or after a haircut still passes. A genuinely different face does not, and the
// refusal points at /api/auth/enroll-face, which requires a government ID and measures its own
// match — so a person whose appearance really has changed is never dead-ended.
//
// The descriptor is also bound as a parameter and cast, instead of being spliced into the statement
// as text with hand-rolled quote escaping.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { matchEnrolledFace, parseLiveDescriptor, causeOf, DESCRIPTOR_DIMS } from '@/lib/auth/face';

export const prerender = false;

// Declared before the handler that reads it — `const` is not hoisted.
const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in first.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  // parseLiveDescriptor enforces what "a descriptor" means: exactly 128 finite numbers, not all
  // zeros (all zeros is a "no face found" result, not a face). The old check accepted 128 strings
  // and wrote them into the jsonb column, where they would never match anything again.
  const descriptor = parseLiveDescriptor(body?.faceDescriptor);
  if (!descriptor) {
    return json({ ok: false, error: 'No usable face in that capture (need ' + DESCRIPTOR_DIMS + ' numbers, and a face must be visible). Try again with better lighting.' }, 400);
  }

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
    // REPLACEMENT IS GATED. The match runs against the enrolled template on the server; `enrolled`
    // is false when there is no active row, which is the first-enrolment case and passes straight
    // through. Throws (rather than reporting a false negative) if the database is unreachable — an
    // auth path must not turn "the database is down" into "your face is wrong" — and the catch below
    // reports that honestly instead of enrolling anyway.
    const existing = await matchEnrolledFace(String(user.id), descriptor);
    if (existing.enrolled && !existing.matched) {
      // Recorded with the distance the SERVER measured. The number stays in the audit row and out of
      // the response: a numeric distance is a gradient an attacker can hill-climb toward the stored
      // template one probe at a time.
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, face_match_distance, face_match_passed, verdict, method, reject_reason, ip_address, user_agent)
        VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${existing.distance}, false, 'rejected', 'self_enroll_replace', 'live capture does not match the enrolled face', ${ip || null}, ${ua})
      `).catch((e: any) => console.error('[api/auth/enroll-face-selfie] audit', causeOf(e)));
      return json({
        ok: false,
        error: 'That does not match the face already enrolled on this account. If your appearance has changed, re-verify with a government ID at /identity-setup or from your account settings.',
      }, 403);
    }

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
      INSERT INTO identity_verifications (user_id, email, claimed_name, face_match_distance, face_match_passed, verdict, method, ip_address, user_agent)
      VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${existing.enrolled ? existing.distance : null}, true, 'verified', ${existing.enrolled ? 'self_enroll_replace' : 'self_enroll'}, ${ip || null}, ${ua})
    `).catch((e: any) => console.error('[api/auth/enroll-face-selfie] audit', causeOf(e)));

    // EMPLOYEES ONLY: the photo taken at face verification becomes their profile picture, so the
    // picture on record is the verified one. Other roles enrol without a photo being kept.
    let photoSaved = false;
    const selfie = typeof body?.selfie === 'string' ? body.selfie : '';
    if (/^data:image\/(jpeg|png);base64,/.test(selfie) && selfie.length < 900_000) {
      try {
        // ORDERING: enrolment is forced by middleware on the FIRST protected page load, which for a
        // new hire happens BEFORE their hr_employees row exists. So always retain the enrolment
        // selfie against the enrolment itself; it is promoted to a profile photo either now (already
        // an employee) or at employee-record creation (see promoteEnrolmentPhoto).
        await db.execute(sql`ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS selfie_url TEXT`).catch(() => {});
        await db.execute(sql`UPDATE user_face_enrollments SET selfie_url = ${selfie} WHERE user_id = ${user.id}`).catch((e: any) => console.error('[api/auth/enroll-face-selfie] selfie', causeOf(e)));

        const emp = await db.execute(sql`SELECT id FROM hr_employees WHERE user_id = ${user.id} AND is_active = true LIMIT 1`);
        const isEmployee = (Array.isArray(emp) ? emp : (emp as any)?.rows || []).length > 0;
        if (isEmployee) {
          let photoUrl = selfie;   // fall back to the inline image when no blob store is configured
          try {
            if (process.env.BLOB_READ_WRITE_TOKEN) {
              const { put } = await import('@vercel/blob');
              const bin = Buffer.from(selfie.split(',')[1], 'base64');
              const res = await put('employee-photos/' + user.id + '-' + Date.now() + '.jpg', bin, { access: 'public', contentType: 'image/jpeg', addRandomSuffix: false });
              if ((res as any)?.url) photoUrl = (res as any).url;
            }
          } catch (e: any) { console.error('[api/auth/enroll-face-selfie] blob', causeOf(e)); }
          await db.execute(sql`UPDATE users SET photo_url = ${photoUrl} WHERE id = ${user.id}`);
          await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url TEXT`).catch(() => {});
          await db.execute(sql`UPDATE hr_employees SET photo_url = ${photoUrl} WHERE user_id = ${user.id}`).catch((e: any) => console.error('[api/auth/enroll-face-selfie] hr photo', causeOf(e)));
          photoSaved = true;
        }
      } catch (e: any) {
        // Never block enrolment because a photo failed to save — but say why in the log.
        console.error('[api/auth/enroll-face-selfie] photo', causeOf(e));
      }
    }
    return json({ ok: true, photoSaved, replaced: existing.enrolled, message: 'Face sign-in is now active for your account.' });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[api/auth/enroll-face-selfie]', causeOf(e));
    return json({ ok: false, error: 'We could not save that enrolment. Please try again.' }, 500);
  }
};
