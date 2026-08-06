// POST /api/auth/identity-setup
// First-time identity registration for an account that has no DOB and no face on file.
//
// Body: { email, name, dob, faceDescriptor: number[128], idDescriptor?: number[128],
//         idCardType, idNumber, idCardBlobUrl?, selfieDataUrl? }
//
// ═══ WHAT THIS ROUTE USED TO DO, AND WHY NONE OF IT COULD STAY ═══
//
// It read `matchDistance` OUT OF THE REQUEST BODY and treated it as the face-vs-ID verdict. An
// unauthenticated caller posting `{ matchDistance: 0 }` with 128 arbitrary floats, a victim's email,
// any name token overlapping users.name, and an ID number in the right FORMAT could:
//     * set that account's password_hash,
//     * set identity_verified = true and photo_verified = true,
//     * and enrol THEIR OWN face descriptor as a permanent sign-in factor on the victim's account.
// The sibling /api/auth/enroll-face had already been fixed to measure the distance server-side. This
// one had not.
//
// ═══ AND THE DEEPER FAULT, WHICH MEASURING THE DISTANCE SERVER-SIDE DOES NOT FIX ═══
//
// Both descriptors come from the same caller. Comparing them proves only that the selfie and the ID
// CARD show the same person — it says nothing about whether that person owns the account named in
// `email`. An attacker uploading their own ID and their own selfie passes a perfectly honest,
// perfectly server-side biometric check. The only things binding the request to the account were an
// email address (public) and nameMatches(), which returns true on a single three-character token
// overlap. That is two caller-supplied values compared with each other and called identity.
//
// ═══ WHAT IT DOES NOW ═══
//
//   1. THE SERVER MEASURES THE MATCH, with the shared euclid() every other face path uses. A
//      client-supplied distance, score or verdict is never read.
//   2. A PASS NO LONGER GRANTS ANYTHING. It does not set a password, it does not set
//      identity_verified or photo_verified, and it does not enrol a face. Enrolment of a biometric
//      factor from an unauthenticated request is exactly the persistence primitive this route was
//      being used as.
//   3. A PASS MAILS A ONE-TIME RESET LINK to the address already on the account (src/lib/auth/
//      recovery.ts): single-use, hashed at rest, expiring, purpose-bound. Control of the mailbox is
//      the binding to the account that the biometric check cannot supply. After signing in, the
//      person enrols their face through /api/auth/enroll-face, which is authenticated and measures
//      its own match.
//   4. A NON-PASS routes to manual review exactly as before — nobody dead-ends, and no automated
//      signal penalises anyone. A human decides.
//   5. NOTHING HERE WRITES THE `users` TABLE. The previous version let an unauthenticated caller
//      overwrite any account's photo_url, id_doc_url, id_card_type and id_number. The documents live
//      on the identity_verifications row, which is where the reviewer reads them from.
//   6. Rate limited per account and per IP through the shared Postgres limiter, and every response
//      about a possibly-unknown account is uniform.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyIdNumber, isIdType } from '@/lib/id-verify';
import { euclid, parseLiveDescriptor, causeOf, DESCRIPTOR_DIMS } from '@/lib/auth/face';
import { overRecoveryLimit, clearRecoveryLimit, issueAndMailReset, RECOVERY_TTL_MINUTES } from '@/lib/auth/recovery';

export const prerender = false;

// Declared before the handler that reads them — `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Face-api euclidean distance below which the selfie and the ID photo are the same person.
 * Unchanged from the value this flow already used (0.50). Retuning it would change who passes, which
 * is a policy decision, not part of a mechanism fix.
 */
const FACE_MATCH_THRESHOLD = 0.50;

/** One answer for "no such account", so this route is not an enumeration oracle. */
const UNIFORM_SUBMITTED = 'Your documents have been submitted. If they match an account, you will hear from us by email.';

function normaliseName(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Corroborating only. It was never a gate and is even less of one now that a pass grants nothing on
// its own — it just keeps obviously-wrong submissions out of the reviewer's queue.
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
  const idCardType = (body?.idCardType || '').toString().slice(0, 50);
  const idCardBlobUrl = body?.idCardBlobUrl ? body.idCardBlobUrl.toString().slice(0, 1000) : null;
  const idNumberRaw = (body?.idNumber || '').toString().slice(0, 60);

  // Compact selfie data URL captured at verification. Kept on the VERIFICATION ROW for the reviewer;
  // it is never written to users.photo_url from here. Size-guarded so a tampered payload cannot
  // bloat the row.
  let selfieDataUrl = (body?.selfieDataUrl || '').toString();
  if (!(selfieDataUrl.startsWith('data:image/') && selfieDataUrl.length <= 250000)) selfieDataUrl = '';

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  // ===== Basic validation =====
  if (!email || !email.includes('@')) return json({ ok: false, error: 'Valid email required' }, 400);
  if (!claimedName || claimedName.length < 2) return json({ ok: false, error: 'Name required' }, 400);
  if (!claimedDob || !/^\d{4}-\d{2}-\d{2}$/.test(claimedDob)) return json({ ok: false, error: 'DOB must be YYYY-MM-DD' }, 400);

  // parseLiveDescriptor enforces what "a descriptor" means: exactly 128 finite numbers, not all
  // zeros. All-zero is a "no face found" result, not a face.
  const descriptor = parseLiveDescriptor(body?.faceDescriptor);
  if (!descriptor) {
    return json({ ok: false, error: 'Invalid selfie descriptor (need ' + DESCRIPTOR_DIMS + ' numbers, and a face must be visible).' }, 400);
  }

  // ID type + number must be present and structurally consistent with the chosen type.
  if (!isIdType(idCardType)) return json({ ok: false, error: 'Select a valid government ID type' }, 400);
  const idCheck = verifyIdNumber(idCardType as any, idNumberRaw);
  if (!idCheck.valid) return json({ ok: false, error: idCheck.reason || 'ID number does not match the selected ID type' }, 400);

  // MEASURED HERE. `body.matchDistance` is deliberately never read. A missing or unusable ID
  // descriptor means "the automatic match could not run" — which routes to manual review, never to a
  // pass and never to a dead end.
  const idDescriptor = parseLiveDescriptor(body?.idDescriptor);
  const measured = idDescriptor ? euclid(descriptor, idDescriptor) : null;
  const autoMatched = measured != null && Number.isFinite(measured) && measured <= FACE_MATCH_THRESHOLD;

  const limit = await overRecoveryLimit(email, ip, 'password-reset');
  if (limit.blocked) {
    return json({
      ok: false,
      error: 'Too many verification attempts. Wait an hour and try again, or email hr@edurankai.in and a person will help.',
    }, 429);
  }

  try {
    const uRows = rowsOf(await db.execute(sql`SELECT id, email, name, role, identity_verified FROM users WHERE LOWER(email) = ${email} LIMIT 1`));
    if (uRows.length === 0) {
      await db.execute(sql`
        INSERT INTO identity_verifications (email, claimed_name, claimed_dob, id_card_type, face_match_distance, face_match_passed, verdict, reject_reason, ip_address, user_agent)
        VALUES (${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${measured}, ${autoMatched}, 'rejected', 'no user with that email', ${ip || null}, ${ua})
      `).catch((e: any) => console.error('[api/auth/identity-setup] audit(no-user)', causeOf(e)));
      // Same shape and status as a successful submission: whether the address exists is not
      // something this route should confirm.
      return json({ ok: true, reviewPending: true, message: UNIFORM_SUBMITTED });
    }
    const user = uRows[0] as any;

    if (user.identity_verified) {
      return json({ ok: false, error: 'That account is already identity-verified. Use password recovery, or contact hr@edurankai.in.' }, 409);
    }

    const metaBase = {
      selfie: selfieDataUrl || null,
      measuredDistance: measured,
      autoMatch: idDescriptor ? (autoMatched ? 'passed' : 'below_threshold') : 'unavailable',
      idNumber: idCheck.normalised,
      // Recorded so an investigator can see that the browser's own number was ignored.
      clientClaimedDistance: body?.matchDistance == null ? null : String(body.matchDistance).slice(0, 32),
    };

    if (!nameMatches(claimedName, user.name || '')) {
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, id_card_blob_url, face_match_distance, face_match_passed, verdict, reject_reason, metadata, ip_address, user_agent)
        VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${idCardBlobUrl}, ${measured}, ${autoMatched}, 'pending', 'name does not match account - manual review', ${JSON.stringify(metaBase)}::jsonb, ${ip || null}, ${ua})
      `).catch((e: any) => console.error('[api/auth/identity-setup] audit(name)', causeOf(e)));
      return json({ ok: true, reviewPending: true, message: UNIFORM_SUBMITTED });
    }

    // ── NOT an automatic match: manual review, exactly as before ──────────────
    if (!autoMatched) {
      await db.execute(sql`
        INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, id_card_blob_url, face_match_distance, face_match_passed, verdict, reject_reason, metadata, ip_address, user_agent)
        VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${idCardBlobUrl}, ${measured}, false, 'pending',
                ${idDescriptor ? 'auto-match below threshold - manual review' : 'no auto-match - manual review'},
                ${JSON.stringify(metaBase)}::jsonb, ${ip || null}, ${ua})
      `).catch((e: any) => console.error('[api/auth/identity-setup] audit(no-match)', causeOf(e)));
      const why = idDescriptor
        ? 'We could not automatically match your face to the ID.'
        : 'We could not run the automatic face match.';
      return json({
        ok: true,
        reviewPending: true,
        message: why + ' Your documents have been securely submitted for manual review - our team will verify and email you. You can also retry with brighter, even lighting and no glasses or mask.',
      });
    }

    // ── AUTOMATIC MATCH ──────────────────────────────────────────────────────
    // The selfie and the ID show the same person. That is everything this check can honestly say,
    // and it is not "this is the account holder": both images came from the caller. So nothing is
    // granted here. A one-time link goes to the address already on the account, and control of that
    // mailbox is what finally binds the request to the account.
    const origin = new URL(request.url).origin;
    const outcome = await issueAndMailReset(user, origin, { ip, method: 'id_face_match' });

    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, claimed_name, claimed_dob, id_card_type, id_card_blob_url, face_match_distance, face_match_passed, verdict, reject_reason, metadata, ip_address, user_agent)
      VALUES (${user.id}, ${email}, ${claimedName}, ${claimedDob}, ${idCardType || null}, ${idCardBlobUrl}, ${measured}, true, 'pending',
              'auto-match passed - reset link mailed, awaiting human sign-off for identity_verified',
              ${JSON.stringify({ ...metaBase, delivery: outcome })}::jsonb, ${ip || null}, ${ua})
    `).catch((e: any) => console.error('[api/auth/identity-setup] audit(match)', causeOf(e)));

    if (outcome === 'no-address') {
      return json({ ok: false, error: 'That account has no email address on file, so a link cannot be delivered. Email hr@edurankai.in to recover it manually.' }, 409);
    }
    if (outcome === 'no-transport') {
      return json({ ok: false, error: 'We could not send the email just now. Your documents are saved and nothing on your account has changed. Try again shortly, or email hr@edurankai.in.' }, 503);
    }

    await clearRecoveryLimit(email, ip, 'password-reset');
    return json({
      ok: true,
      mailed: true,
      message: 'Your face matched the ID. We have emailed a one-time link to the address on that account - open it within ' + RECOVERY_TTL_MINUTES + ' minutes to choose a password. You can add face sign-in from your account once you are in.',
    });
  } catch (e: any) {
    // Real Postgres reason is on e.cause; logged, not returned.
    console.error('[api/auth/identity-setup]', causeOf(e));
    return json({ ok: false, error: 'We could not process that submission. Try again shortly.' }, 500);
  }
};
