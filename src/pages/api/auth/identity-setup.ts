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

//
// SECURITY NOTE — READ BEFORE CHANGING THE FLAG BELOW.
// This route has NO SESSION CHECK (compare enroll-face.ts, which requires locals.user), and
// src/middleware.ts exempts every /api/ path from the session and face gates. It was therefore fully
// unauthenticated, and its auto-pass branch set users.password_hash TO A PASSWORD CHOSEN IN THE
// REQUEST BODY. The three things standing between a stranger and that branch were: a STRUCTURAL check
// of the ID number (a format test in src/lib/id-verify.ts, not an issuer check), a name match that
// returns true on ONE shared token of three or more characters ("prasad" matches "Siddharth Prasad"),
// and `matchPassed`, which was derived entirely from a number in the request body. Worse than
// enroll-face.ts's version of that defect, because this route receives only ONE descriptor — the
// selfie — so there is no ID descriptor to compare it against and the match CANNOT be verified
// server-side at all. One POST took over any not-yet-verified account, including a super_admin, and
// enrolled the caller's own face as its second factor at the same time.
//
// It cannot be made safe by tightening the fuzzy matcher, so the auto-pass branch is now behind
// IDENTITY_SETUP_AUTO_PASS and DEFAULTS TO OFF. With it off, every submission takes the branch that
// already existed for a failed match: documents are stored and a human reviews them at
// /admin/identity-verifications. Nothing auto-sets a password. Turning it back on needs a deliberate
// environment change and the sign-off of whoever owns this flow.
import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyIdNumber, isIdType } from '@/lib/id-verify';
import { checkRateLimit, clientIpOf, isPrivilegedAccount, recordAttempt } from '@/lib/auth/recovery';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 64;

// Pass threshold: face-api euclidean distance under this is considered a match.
// 0.45 is strict but reduces false-positives for ID verification.
const FACE_MATCH_THRESHOLD = 0.50;

// The real Postgres reason is on e.cause; e.message is only the SQL that failed.
const causeOf = (e: any): string => e?.cause?.message || e?.message || 'unknown error';

const ROUTE = 'identity_setup' as const;

/**
 * THE FLAG. Off unless the environment says the exact string 'true'.
 *
 * OFF  (default) - no submission ever sets a password. Everything routes to manual review, which is
 *                  the branch that already exists and which the client page already handles
 *                  (identity-setup.astro checks `d.ok && d.reviewPending`).
 * ON             - restores the previous self-serve behaviour, WHICH IS STILL CLIENT-ATTESTED. Only
 *                  turn it on if somebody has decided that risk is acceptable.
 *
 * Declared here, above the handler, because `const` is not hoisted and a handler reaching a later
 * declaration has taken pages down on this project.
 */
const AUTO_PASS_ENABLED = String(process.env.IDENTITY_SETUP_AUTO_PASS || '').trim().toLowerCase() === 'true';

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

  const ipEarly = clientIpOf(request, clientAddress);
  const identifierEarly = (body?.email || '').toString().trim().toLowerCase();
  // Shared-state ceiling. Unauthenticated document submission with no cap is how a fuzzy name matcher
  // gets ground down; the per-identifier budget is the tight one, the per-IP budget is loose enough
  // for a shared office address.
  if (identifierEarly) {
    const limit = await checkRateLimit(ROUTE, identifierEarly, ipEarly);
    if (!limit.allowed) {
      await recordAttempt({ route: ROUTE, identifier: identifierEarly, ip: ipEarly, outcome: 'rate_limited', detail: limit.scope });
      return json({
        ok: false,
        error: 'Too many identity-setup attempts. Wait ' + Math.ceil(limit.retryAfterSeconds / 60) + ' minutes and try again, or email hr@edurankai.in.',
      }, 429);
    }
  }

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
  if (descriptor.some((n: any) => !Number.isFinite(Number(n)))) return json({ ok: false, error: 'Face descriptor contains non-numeric values' }, 400);
  // An all-zero vector is a "no face detected" result, not a face. Rejected the same way
  // enroll-face-selfie.ts already rejects it, so a blank enrolment cannot be stored.
  if (!descriptor.some((n: any) => Number.isFinite(Number(n)) && Math.abs(Number(n)) > 1e-6)) {
    return json({ ok: false, error: 'No face detected in the selfie. Retake it with better lighting.' }, 400);
  }
  // Auto-match is advisory: it may be absent (no face detectable on the ID, or the
  // models did not load). A present, in-range distance under threshold is an instant
  // self-serve pass; anything else routes to manual review rather than dead-ending.
  //
  // IT IS ALSO CLIENT-ATTESTED AND UNVERIFIABLE HERE. Only the selfie descriptor is posted, so there
  // is no ID descriptor to measure against; this number is whatever the caller said. That is why the
  // branch it controls is behind AUTO_PASS_ENABLED and off by default.
  const hasMatch = Number.isFinite(matchDistanceRaw) && matchDistanceRaw >= 0 && matchDistanceRaw <= 2;

  // ID type + number must be present and the number must structurally match
  // the chosen ID type (no junk/empty IDs).
  if (!isIdType(idCardType)) return json({ ok: false, error: 'Select a valid government ID type' }, 400);
  const idCheck = verifyIdNumber(idCardType as any, idNumberRaw);
  if (!idCheck.valid) return json({ ok: false, error: idCheck.reason || 'ID number does not match the selected ID type' }, 400);
  const idNumber = idCheck.normalised;
  // ID image storage is best-effort (the face match + ID number are the actual
  // verification). If blob storage is unavailable the image URL may be empty.

  // The client's own verdict, recorded in the audit rows below exactly as before. It is NOT the gate:
  // see autoPass, which is resolved after the account is known.
  const matchPassed = hasMatch && matchDistanceRaw <= FACE_MATCH_THRESHOLD;

  try {
    // Find user
    const u = await db.execute(sql`SELECT id, email, name, role, is_active, assigned_department_id, identity_verified FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
    const uRows = Array.isArray(u) ? u : (u?.rows || []);
    if (uRows.length === 0) {
      // Log attempt + reject
      await db.execute(sql`
        INSERT INTO identity_verifications (email, claimed_name, claimed_dob, id_card_type, face_match_distance, face_match_passed, verdict, reject_reason, ip_address, user_agent)
        VALUES (${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${matchDistanceRaw}, ${matchPassed}, 'rejected', 'no user with that email', ${ip || null}, ${ua})
      `).catch(() => {});
      await recordAttempt({ route: ROUTE, identifier: email, ip, outcome: 'no_account' });
      return json({ ok: false, error: 'No account with that email. If you are new, sign up first.' }, 404);
    }
    const user = uRows[0] as any;

    // Already verified? Don't allow overwrite via this flow.
    if (user.identity_verified) {
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId: user.id, outcome: 'already_verified' });
      return json({ ok: false, error: 'Account already identity-verified. Use the regular password reset, or contact hr@edurankai.in.' }, 409);
    }

    // WHO MAY NEVER TAKE THE AUTO-PASS BRANCH, whatever the flag says.
    //
    // A privileged account is the one whose takeover costs the most, and the only thing standing in
    // front of this branch is a name-token match on a name that is public for staff. A deactivated
    // account must not be revived by an unauthenticated request either. Both still submit their
    // documents and both still reach a human — they are refused the SHORTCUT, not the flow.
    const privileged = await isPrivilegedAccount({
      id: user.id, email: user.email, name: user.name, role: user.role,
      isActive: user.is_active, assignedDepartmentId: user.assigned_department_id,
    });
    const inactive = user.is_active === false;
    const autoPass = AUTO_PASS_ENABLED && matchPassed && !privileged && !inactive;

    // Name match
    if (!nameMatches(claimedName, user.name || '')) {
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, face_match_distance, face_match_passed, verdict, reject_reason, ip_address, user_agent)
        VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${matchDistanceRaw}, ${matchPassed}, 'rejected', 'name does not match account', ${ip || null}, ${ua})
      `).catch(() => {});
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId: user.id, outcome: 'name_mismatch' });
      return json({ ok: false, error: 'Name does not match the account on file.' }, 400);
    }

    // Manual review — the branch that now runs for EVERYTHING unless AUTO_PASS_ENABLED is on and the
    // account is an ordinary, active, unverified one. We don't dead-end: the documents (ID image +
    // selfie) are stored securely and a human evaluator compares the ID face to the selfie at
    // /admin/identity-verifications. Nothing is auto-penalised, and no password is written here.
    if (!autoPass) {
      const reviewReason = privileged
        ? 'privileged account - manual review required'
        : inactive
          ? 'deactivated account - manual review required'
          : !AUTO_PASS_ENABLED
            ? 'self-serve auto-pass disabled - manual review'
            : hasMatch ? 'auto-match below threshold - manual review' : 'no auto-match - manual review';
      const meta = JSON.stringify({
        selfie: selfieDataUrl || null,
        matchDistance: hasMatch ? matchDistanceRaw : null,
        autoMatch: hasMatch ? (matchPassed ? 'client_claimed_pass' : 'below_threshold') : 'unavailable',
        matchSource: 'client',
        autoPassEnabled: AUTO_PASS_ENABLED,
        privileged,
        inactive,
      });
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, id_card_blob_url, face_match_distance, face_match_passed, verdict, reject_reason, metadata, ip_address, user_agent)
        VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${idCardBlobUrl}, ${hasMatch ? matchDistanceRaw : null}, false, 'pending', ${reviewReason}, ${meta}::jsonb, ${ip || null}, ${ua})
      `).catch((e: any) => { console.error('[identity-setup] review audit insert failed:', causeOf(e)); });
      // Stash the documents on the user record too, so the reviewer always has them.
      await db.execute(sql`
        UPDATE users SET
          id_doc_url = COALESCE(${idCardBlobUrl}, id_doc_url),
          photo_url = COALESCE(${selfieDataUrl || null}, photo_url),
          id_card_type = COALESCE(${idCardType || null}, id_card_type),
          id_number = COALESCE(${idNumber}, id_number),
          updated_at = NOW()
        WHERE id = ${user.id}
      `).catch((e: any) => { console.error('[identity-setup] document stash failed:', causeOf(e)); });
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId: user.id, outcome: 'review_pending', detail: reviewReason });
      // Honest about which of these actually happened, because "we could not match your face" would
      // be a lie when the truth is that self-serve setup is switched off.
      const why = (!AUTO_PASS_ENABLED || privileged || inactive)
        ? 'Identity setup on this account is completed by a person, not automatically.'
        : hasMatch
          ? 'We could not automatically match your face to the ID (distance ' + matchDistanceRaw.toFixed(3) + ').'
          : 'We could not run the automatic face match.';
      return json({ ok: true, reviewPending: true, message: why + ' Your documents have been securely submitted for review - our team will verify and email you. Your password has not been changed.' });
    }

    // ===== PASS - commit identity =====
    // Only reachable with IDENTITY_SETUP_AUTO_PASS=true on an ordinary, active, unverified account.
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
        updated_at = NOW()
      WHERE id = ${user.id}
    `);
    // `is_active = true` USED TO BE IN THAT LIST. It is gone: reviving a deliberately deactivated
    // account is an administrator's decision, not a side effect of an unauthenticated form post. A
    // deactivated account never reaches this branch anyway (see `inactive` above).

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
    `).catch((e: any) => { console.error('[identity-setup] verified audit insert failed:', causeOf(e)); });
    await recordAttempt({ route: ROUTE, identifier: email, ip, userId: user.id, outcome: 'auto_pass_committed', detail: 'client distance ' + matchDistanceRaw });

    return json({
      ok: true,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      message: 'Identity verified. Your password and face login are set. Sign in below.',
    });
  } catch (e: any) {
    // Never swallowed: the real Postgres reason is on e.cause, and e.message is only the failed SQL.
    console.error('[identity-setup] failed:', causeOf(e));
    await recordAttempt({ route: ROUTE, identifier: email, ip, outcome: 'error', detail: causeOf(e) }).catch(() => {});
    return json({ ok: false, error: 'We could not process that submission. Try again, or email hr@edurankai.in.' }, 500);
  }
};
