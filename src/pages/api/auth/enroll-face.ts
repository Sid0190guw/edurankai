// POST /api/auth/enroll-face
// Authenticated endpoint. Lets a logged-in user add a face descriptor to their
// account so 2FA can be enforced on every subsequent login.
// Body: { faceDescriptor: number[128], idDescriptor?: number[128], matchDistance?: number }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const FACE_MATCH_THRESHOLD = 0.55; // a hair more lenient for self-enrollment

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in first.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const descriptor = body?.faceDescriptor;
  const idDescriptor = body?.idDescriptor;
  const matchDistanceRaw = Number(body?.matchDistance);

  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    return json({ ok: false, error: 'Invalid selfie descriptor (need 128 floats).' }, 400);
  }
  if (!Array.isArray(idDescriptor) || idDescriptor.length !== 128) {
    return json({ ok: false, error: 'Invalid ID descriptor (need 128 floats).' }, 400);
  }
  if (!Number.isFinite(matchDistanceRaw)) {
    return json({ ok: false, error: 'Missing match distance.' }, 400);
  }
  if (matchDistanceRaw > FACE_MATCH_THRESHOLD) {
    return json({ ok: false, error: 'Face on ID does not match selfie closely enough (distance ' + matchDistanceRaw.toFixed(3) + '). Retry with better lighting / no glasses.' }, 400);
  }

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

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

    await db.execute(sql`
      UPDATE users SET identity_verified = true, identity_verified_at = NOW(), updated_at = NOW()
      WHERE id = ${user.id}
    `);

    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, claimed_name, face_match_distance, face_match_passed, verdict, method, ip_address, user_agent)
      VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${matchDistanceRaw}, true, 'verified', 'self_enroll', ${ip || null}, ${ua})
    `).catch(() => {});

    return json({ ok: true, message: 'Face enrolled. 2FA is active for your account.' });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
