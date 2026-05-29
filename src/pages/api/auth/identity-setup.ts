// POST /api/auth/identity-setup
// First-time identity registration. Used by users (admins or applicants) who
// don't yet have DOB / face on file - they upload an ID card, take a selfie,
// the client matches face descriptors (face-api.js) and on a passing match
// submits here. We save the DOB + face descriptor + new password and mark
// users.identity_verified = true.
//
// Body: {
//   email: string,
//   name: string,           // must match users.name (case-insensitive, fuzzy)
//   dob: string,            // YYYY-MM-DD
//   newPassword: string,    // at least 8 chars
//   faceDescriptor: number[],  // 128-float vector from selfie (face-api.js)
//   matchDistance: number,  // computed by client from ID-face vs selfie-face
//   idCardType?: string,    // 'aadhaar' | 'pan' | 'passport' | 'driving' | 'other'
//   idCardBlobUrl?: string  // optional - if client uploaded to @vercel/blob first
// }

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyIdNumber, isIdType } from '@/lib/id-verify';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 64;

// Pass threshold: face-api euclidean distance under this is considered a match.
// 0.45 is strict but reduces false-positives for ID verification.
const FACE_MATCH_THRESHOLD = 0.50;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN);
  return salt.toString('hex') + ':' + derived.toString('hex');
}

function normaliseName(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Lenient fuzzy name match: covers (a) exact equality, (b) one string contained
// in the other (handles "Siddharth" account vs "SIDDHARTH PRASAD" on gov ID),
// (c) at least one substantial token (>= 3 chars) overlap. Face match is the
// strongest signal; the name check is corroborating, not gatekeeping.
function nameMatches(claimed: string, stored: string): boolean {
  const a = normaliseName(claimed);
  const b = normaliseName(stored);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
  const aTokens = a.split(' ').filter(t => t.length >= 3);
  const bTokens = b.split(' ').filter(t => t.length >= 3);
  for (const t of aTokens) {
    if (bTokens.indexOf(t) !== -1) return true;
  }
  return false;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const email = (body?.email || '').toString().trim().toLowerCase();
  const claimedName = (body?.name || '').toString().trim();
  const claimedDob = (body?.dob || '').toString().trim();
  const newPassword = (body?.newPassword || '').toString();
  const descriptor = body?.faceDescriptor;
  const matchDistanceRaw = Number(body?.matchDistance);
  const idCardType = (body?.idCardType || '').toString().slice(0, 50);
  const idCardBlobUrl = body?.idCardBlobUrl ? body.idCardBlobUrl.toString().slice(0, 1000) : null;
  const idNumberRaw = (body?.idNumber || '').toString().slice(0, 60);
  // Compact selfie data URL captured at verification -> stored as profile photo.
  // Guard size (~200KB) so a tampered payload can't bloat the row.
  let selfieDataUrl = (body?.selfieDataUrl || '').toString();
  if (!(selfieDataUrl.startsWith('data:image/') && selfieDataUrl.length <= 250000)) selfieDataUrl = '';

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  // ===== Basic validation =====
  if (!email || !email.includes('@')) return json({ ok: false, error: 'Valid email required' }, 400);
  if (!claimedName || claimedName.length < 2) return json({ ok: false, error: 'Name required' }, 400);
  if (!claimedDob || !/^\d{4}-\d{2}-\d{2}$/.test(claimedDob)) return json({ ok: false, error: 'DOB must be YYYY-MM-DD' }, 400);
  if (!newPassword || newPassword.length < 8) return json({ ok: false, error: 'Password must be 8+ characters' }, 400);
  if (newPassword.length > 200) return json({ ok: false, error: 'Password too long' }, 400);
  if (!Array.isArray(descriptor) || descriptor.length !== 128) return json({ ok: false, error: 'Invalid face descriptor (need 128 floats)' }, 400);
  if (!Number.isFinite(matchDistanceRaw) || matchDistanceRaw < 0 || matchDistanceRaw > 2) return json({ ok: false, error: 'Invalid match distance' }, 400);

  // ID type + number must be present and the number must structurally match
  // the chosen ID type (no junk/empty IDs).
  if (!isIdType(idCardType)) return json({ ok: false, error: 'Select a valid government ID type' }, 400);
  const idCheck = verifyIdNumber(idCardType as any, idNumberRaw);
  if (!idCheck.valid) return json({ ok: false, error: idCheck.reason || 'ID number does not match the selected ID type' }, 400);
  const idNumber = idCheck.normalised;
  // ID image storage is best-effort (the face match + ID number are the actual
  // verification). If blob storage is unavailable the image URL may be empty.

  // Don't allow the user to "verify" with a face that doesn't match the ID
  const matchPassed = matchDistanceRaw <= FACE_MATCH_THRESHOLD;

  try {
    // Find user
    const u = await db.execute(sql`SELECT id, email, name, role, identity_verified FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
    const uRows = Array.isArray(u) ? u : (u?.rows || []);
    if (uRows.length === 0) {
      // Log attempt + reject
      await db.execute(sql`
        INSERT INTO identity_verifications (email, claimed_name, claimed_dob, id_card_type, face_match_distance, face_match_passed, verdict, reject_reason, ip_address, user_agent)
        VALUES (${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${matchDistanceRaw}, ${matchPassed}, 'rejected', 'no user with that email', ${ip || null}, ${ua})
      `).catch(() => {});
      return json({ ok: false, error: 'No account with that email. If you are new, sign up first.' }, 404);
    }
    const user = uRows[0] as any;

    // Already verified? Don't allow overwrite via this flow.
    if (user.identity_verified) {
      return json({ ok: false, error: 'Account already identity-verified. Use the regular password reset, or contact hr@edurankai.in.' }, 409);
    }

    // Name match
    if (!nameMatches(claimedName, user.name || '')) {
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, face_match_distance, face_match_passed, verdict, reject_reason, ip_address, user_agent)
        VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${matchDistanceRaw}, ${matchPassed}, 'rejected', 'name does not match account', ${ip || null}, ${ua})
      `).catch(() => {});
      return json({ ok: false, error: 'Name does not match the account on file.' }, 400);
    }

    // Face match
    if (!matchPassed) {
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, face_match_distance, face_match_passed, verdict, reject_reason, ip_address, user_agent)
        VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${matchDistanceRaw}, false, 'rejected', 'face on ID does not match selfie', ${ip || null}, ${ua})
      `).catch(() => {});
      return json({ ok: false, error: 'Face on ID does not match the live selfie (distance ' + matchDistanceRaw.toFixed(3) + '). Try better lighting, no glasses/mask, hold ID steady.' }, 400);
    }

    // ===== PASS - commit identity =====
    const passwordHash = await hashPassword(newPassword);

    await db.execute(sql`
      UPDATE users SET
        password_hash = ${passwordHash},
        dob = ${claimedDob}::date,
        identity_verified = true,
        identity_verified_at = NOW(),
        id_card_type = ${idCardType || null},
        id_number = ${idNumber},
        id_doc_url = ${idCardBlobUrl},
        photo_url = COALESCE(${selfieDataUrl || null}, photo_url),
        photo_verified = ${selfieDataUrl ? true : false},
        is_active = true,
        updated_at = NOW()
      WHERE id = ${user.id}
    `);

    // Save face descriptor for future face-login
    await db.execute(sql`
      INSERT INTO user_face_enrollments (user_id, face_descriptor, device_info, is_active)
      VALUES (${user.id}, ${sql.raw("'" + JSON.stringify(descriptor).replace(/'/g, "''") + "'::jsonb")}, ${ua}, true)
      ON CONFLICT (user_id) DO UPDATE SET
        face_descriptor = EXCLUDED.face_descriptor,
        device_info = EXCLUDED.device_info,
        is_active = true,
        enrolled_at = NOW()
    `);

    // Audit log - verified
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, id_card_blob_url, face_match_distance, face_match_passed, verdict, ip_address, user_agent)
      VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${idCardBlobUrl}, ${matchDistanceRaw}, true, 'verified', ${ip || null}, ${ua})
    `).catch(() => {});

    return json({
      ok: true,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      message: 'Identity verified. Your password and face login are set. Sign in below.',
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
