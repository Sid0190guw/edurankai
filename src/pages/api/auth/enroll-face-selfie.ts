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
    return json({ ok: true, message: 'Face 2FA is now active for your account.' });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
