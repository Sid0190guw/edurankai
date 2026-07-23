// POST /api/auth/enroll-face-selfie
// Lightweight 2FA face enrollment for already-authenticated users (e.g. right
// after an applicant submits their application). Stores a selfie face
// descriptor so 2FA can be enforced on subsequent logins. This does NOT set
// identity_verified - that requires the heavier ID-match flow in
// /api/auth/enroll-face. Here, identity is already established by the account.
// Body: { faceDescriptor: number[128] }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in first.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const descriptor = body?.faceDescriptor;
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    return json({ ok: false, error: 'Invalid face descriptor (need 128 floats).' }, 400);
  }
  // Reject all-zero / degenerate descriptors
  const nonZero = descriptor.some((n: any) => Number.isFinite(n) && Math.abs(n) > 1e-6);
  if (!nonZero) return json({ ok: false, error: 'No face detected. Try again with better lighting.' }, 400);

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);

  try {
    await db.execute(sql`
      INSERT INTO user_face_enrollments (user_id, face_descriptor, device_info, is_active)
      VALUES (${user.id}, ${sql.raw("'" + JSON.stringify(descriptor).replace(/'/g, "''") + "'::jsonb")}, ${ua}, true)
      ON CONFLICT (user_id) DO UPDATE SET
        face_descriptor = EXCLUDED.face_descriptor,
        device_info = EXCLUDED.device_info,
        is_active = true,
        enrolled_at = NOW()
    `);

    // EMPLOYEES ONLY: the photo taken at face verification becomes their profile picture, so the
    // picture on record is the verified one. Other roles enrol for 2FA without a photo being kept.
    let photoSaved = false;
    const selfie = typeof body?.selfie === 'string' ? body.selfie : '';
    if (/^data:image\/(jpeg|png);base64,/.test(selfie) && selfie.length < 900_000) {
      try {
        // ORDERING: face-2FA enrolment is forced by middleware on the FIRST protected page load,
        // which for a new hire happens BEFORE their hr_employees row exists. So always retain the
        // enrolment selfie against the enrolment itself; it is promoted to a profile photo either
        // now (already an employee) or at employee-record creation (see promoteEnrolmentPhoto).
        await db.execute(sql`ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS selfie_url TEXT`).catch(() => {});
        await db.execute(sql`UPDATE user_face_enrollments SET selfie_url = ${selfie} WHERE user_id = ${user.id}`).catch(() => {});

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
          } catch (_) { /* keep the inline image */ }
          await db.execute(sql`UPDATE users SET photo_url = ${photoUrl} WHERE id = ${user.id}`);
          await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url TEXT`).catch(() => {});
          await db.execute(sql`UPDATE hr_employees SET photo_url = ${photoUrl} WHERE user_id = ${user.id}`).catch(() => {});
          photoSaved = true;
        }
      } catch (_) { /* never block 2FA enrolment because a photo failed to save */ }
    }
    return json({ ok: true, photoSaved, message: 'Face 2FA is now active for your account.' });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
