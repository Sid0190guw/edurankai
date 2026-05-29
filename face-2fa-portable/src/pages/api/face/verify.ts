// POST /api/face/verify
// Body: { userId: string, descriptor: number[128] }
//   OR  { email: string,  descriptor: number[128] }
// Returns: { ok: true, distance } if the descriptor matches the stored one.
//
// SERVER-side comparison so a malicious client can't claim success without
// actually presenting a matching face. The threshold is enforced here.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { faceDistance, normalizeDescriptor, isValidDescriptor, FACE_MATCH_THRESHOLD } from '@/lib/face';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const descriptor = body.descriptor;
  if (!isValidDescriptor(descriptor)) return json({ ok: false, error: 'invalid face descriptor' }, 400);

  // Resolve the target user by id or email.
  let userId: string | null = body.userId || null;
  if (!userId && body.email) {
    const u = rows(await db.execute(sql`SELECT id FROM users WHERE lower(email) = ${String(body.email).toLowerCase()} LIMIT 1`));
    userId = u[0]?.id || null;
  }
  if (!userId) return json({ ok: false, error: 'user not found' }, 404);

  const row = rows(await db.execute(sql`
    SELECT face_descriptor FROM user_face_enrollments
    WHERE user_id = ${userId} AND is_active = true LIMIT 1
  `))[0];
  if (!row) return json({ ok: false, error: 'not enrolled' }, 404);

  const stored = normalizeDescriptor(row.face_descriptor);
  if (stored.length !== 128) return json({ ok: false, error: 'stored descriptor corrupt' }, 500);

  const distance = faceDistance(descriptor, stored);
  const passed = distance < FACE_MATCH_THRESHOLD;

  const ua = request.headers.get('user-agent') || '';
  await db.execute(sql`
    INSERT INTO face_verifications (user_id, distance, passed, method, ip_address, user_agent)
    VALUES (${userId}, ${distance}, ${passed}, 'login', ${clientAddress || null}, ${ua})
  `);
  if (passed) {
    await db.execute(sql`UPDATE user_face_enrollments SET last_used_at = NOW() WHERE user_id = ${userId}`);
  }

  // NOTE: we deliberately return userId so the next step (your session creator)
  // can mint a session cookie. Wire that into your existing login flow.
  return passed
    ? json({ ok: true, userId, distance })
    : json({ ok: false, error: 'face not recognised', distance }, 401);
};
