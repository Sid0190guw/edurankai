// POST /api/face/enroll
// Body: { descriptor: number[128] }
// Auth: requires Astro.locals.user (your existing session).
//
// Stores the user's face descriptor. Idempotent: re-enrolling replaces the
// previous descriptor (so a user can re-take their selfie any time).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';                   // <-- adapt to your DB client
import { sql } from 'drizzle-orm';               // <-- or remove if not using drizzle
import { isValidDescriptor } from '@/lib/face';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const descriptor = body.descriptor;
  if (!isValidDescriptor(descriptor)) return json({ ok: false, error: 'invalid face descriptor' }, 400);

  const ua = request.headers.get('user-agent') || '';
  const descriptorJson = JSON.stringify(descriptor);

  await db.execute(sql`
    INSERT INTO user_face_enrollments (user_id, face_descriptor, device_info, is_active, enrolled_at)
    VALUES (${user.id}, ${descriptorJson}::jsonb, ${ua.slice(0, 500)}, true, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET face_descriptor = EXCLUDED.face_descriptor,
          device_info     = EXCLUDED.device_info,
          is_active       = true,
          enrolled_at     = NOW()
  `);
  await db.execute(sql`UPDATE users SET face_enrolled = true, face_enrolled_at = NOW() WHERE id = ${user.id}`);
  await db.execute(sql`
    INSERT INTO face_verifications (user_id, distance, passed, method, ip_address, user_agent)
    VALUES (${user.id}, NULL, true, 'enroll', ${clientAddress || null}, ${ua})
  `);
  return json({ ok: true });
};
