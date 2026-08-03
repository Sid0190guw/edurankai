// POST /api/auth/enroll-face
// Authenticated endpoint. Lets a logged-in user add a face descriptor to their
// account so 2FA can be enforced on every subsequent login, and — because the
// selfie is matched against the face on their government ID — marks the account
// identity-verified.
// Body: { faceDescriptor: number[128], idDescriptor: number[128] }
//
// WHAT CHANGED, AND WHY.
// The match used to be a NUMBER IN THE REQUEST BODY. `Number(body?.matchDistance)` was compared to
// the threshold and nothing between that line and the INSERT did any arithmetic at all: the two
// descriptors were checked only for being 128-element arrays and were never compared to each other.
// So `{faceDescriptor: X, idDescriptor: X, matchDistance: 0}` passed — the same array twice, with the
// caller's own verdict attached. That wrote user_face_enrollments (the exact row middleware.ts:168-174
// reads to satisfy the face gate), set users.identity_verified = true on a purely client-attested
// claim, and filed an identity_verifications audit row recording the attacker's number as the measured
// distance, poisoning the evidence a human reviewer would later rely on.
//
// The distance is now computed HERE, from the two descriptors, and the body's matchDistance is
// ignored entirely — it is kept only as a metadata field so a divergence between what the browser
// claimed and what the server measured is visible rather than invisible.
//
// Scope note, so this is not mistaken for more than it is: this does NOT stop a session-holder from
// satisfying the middleware face gate. /api/auth/enroll-face-selfie is an intentional session-only
// enrolment path that writes the same row with no ID match by design. What this removes is the
// ability to forge identity_verified and its audit trail.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

const FACE_MATCH_THRESHOLD = 0.55; // a hair more lenient for self-enrollment

// The real Postgres reason is on e.cause; e.message is only the SQL that failed.
const causeOf = (e: any): string => e?.cause?.message || e?.message || 'unknown error';

/**
 * Euclidean distance over two face-api descriptors — the same measure the browser computes with
 * faceapi.euclideanDistance, so a legitimate enrolment that passes today still passes.
 *
 * Declared above the handler deliberately: `const` is not hoisted, and a handler reaching a later
 * declaration has taken pages down on this project before.
 */
const euclid = (a: number[], b: number[]): number => {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (Number(a[i]) || 0) - (Number(b[i]) || 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
};

/** A descriptor of all-zeros (or near it) is a "no face detected" result, not a face. */
const isDegenerate = (v: number[]): boolean => !v.some((n: any) => Number.isFinite(n) && Math.abs(n) > 1e-6);

/**
 * An exact zero means the SAME vector was submitted for both the selfie and the ID photo. A real
 * camera and a real scanned ID never produce identical 128-float vectors, so this is the signature of
 * the forgery above rather than of an unusually good match.
 */
const IDENTICAL_EPSILON = 1e-6;

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in first.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const descriptor = body?.faceDescriptor;
  const idDescriptor = body?.idDescriptor;
  // Recorded, never trusted. Nothing below branches on it.
  const clientClaimedDistance = Number(body?.matchDistance);

  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    return json({ ok: false, error: 'Invalid selfie descriptor (need 128 floats).' }, 400);
  }
  if (!Array.isArray(idDescriptor) || idDescriptor.length !== 128) {
    return json({ ok: false, error: 'Invalid ID descriptor (need 128 floats).' }, 400);
  }
  if (descriptor.some((n: any) => !Number.isFinite(Number(n))) || idDescriptor.some((n: any) => !Number.isFinite(Number(n)))) {
    return json({ ok: false, error: 'Descriptor contains non-numeric values.' }, 400);
  }
  if (isDegenerate(descriptor)) {
    return json({ ok: false, error: 'No face detected in the selfie. Try again with better lighting.' }, 400);
  }
  if (isDegenerate(idDescriptor)) {
    return json({ ok: false, error: 'No face detected on the ID image. Retake the ID photo with the face clearly visible.' }, 400);
  }

  // THE MEASUREMENT. Server-side, from the two vectors, ignoring anything the caller asserted.
  const matchDistance = euclid(descriptor, idDescriptor);

  if (matchDistance < IDENTICAL_EPSILON) {
    return json({ ok: false, error: 'The selfie and the ID photo produced an identical face reading. Capture the selfie live and photograph the ID separately.' }, 400);
  }
  if (matchDistance > FACE_MATCH_THRESHOLD) {
    return json({ ok: false, error: 'Face on ID does not match selfie closely enough (distance ' + matchDistance.toFixed(3) + '). Retry with better lighting / no glasses.' }, 400);
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

    // The SERVER'S number goes in the evidence column. The browser's claim is kept beside it, so a
    // client that reports something different from what the vectors actually say is visible to a
    // reviewer instead of overwriting the truth.
    const meta = JSON.stringify({
      serverMatchDistance: Number(matchDistance.toFixed(6)),
      clientClaimedDistance: Number.isFinite(clientClaimedDistance) ? Number(clientClaimedDistance.toFixed(6)) : null,
      threshold: FACE_MATCH_THRESHOLD,
      computedBy: 'server',
    });
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, claimed_name, face_match_distance, face_match_passed, verdict, method, metadata, ip_address, user_agent)
      VALUES (${user.id}, ${user.email || null}, ${user.name || null}, ${matchDistance}, true, 'verified', 'self_enroll', ${meta}::jsonb, ${ip || null}, ${ua})
    `).catch((e: any) => { console.error('[enroll-face] audit insert failed:', causeOf(e)); });

    return json({ ok: true, matchDistance: Number(matchDistance.toFixed(3)), message: 'Face enrolled. 2FA is active for your account.' });
  } catch (e: any) {
    // Never swallowed: the real Postgres reason reaches the log.
    console.error('[enroll-face] failed:', causeOf(e));
    return json({ ok: false, error: 'We could not save your enrolment. Try again, or email hr@edurankai.in.' }, 500);
  }
};
