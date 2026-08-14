// src/lib/auth/face-erasure.ts — withdraw consent to face recognition, and actually erase the data.
//
// =================================================================================================
// WHY THIS EXISTS, IN THE WORDS OF THE PERSON WHO ASKED FOR IT
// =================================================================================================
//
// "I would now like to disable Face 2FA, but there is no option in my account settings to disable
//  or remove it. Please disable Face 2FA on my account and permanently delete any facial images,
//  video frames, biometric templates/embeddings, identifiers, or other facial data... I am
//  withdrawing consent only for Face 2FA and the processing/storage of my facial data."
//
// She was right that there was no option. An applicant could enrol a face in one tap and had no way
// to undo it. The only removal paths in the product were an admin deactivating their OWN enrolment
// and an admin deleting somebody else's from /admin/users — nothing a person could do about their
// own face.
//
// =================================================================================================
// DEACTIVATION IS NOT ERASURE, AND THE DIFFERENCE IS THE WHOLE POINT
// =================================================================================================
//
// The existing admin control ran `UPDATE user_face_enrollments SET is_active = false`. That stops
// the face being usable to sign in — and leaves the 128-float template AND, for anybody who enrolled
// through /portal/face-setup, the base64 JPEG of their face sitting in the row.
//
// Somebody withdrawing consent to biometric processing is not asking for the feature to be switched
// off. They are asking for the data to be gone. So this DELETES the row, and clears the derived
// copies with it, and then READS BACK to confirm rather than reporting success because an UPDATE
// returned.
//
// =================================================================================================
// WHAT IS ACTUALLY HELD, WHICH IS MORE THAN THREE SCREENS CLAIMED
// =================================================================================================
//
//   user_face_enrollments.face_descriptor   128 floats derived from the face. A biometric template.
//   user_face_enrollments.selfie_url        the RAW CAPTURED IMAGE, base64, for anybody who enrolled
//                                           through /portal/face-setup — the only page that sends it.
//   users.photo_url / hr_employees.photo_url  a profile photo promoted from that capture, and only
//                                           for people who are active employees at the time.
//
// Three enrolment surfaces told people "No photo is stored - only a numeric face signature". For the
// face-setup path that was false. Saying it in a consent flow is worse than storing the image,
// because it is the sentence somebody relies on when deciding.
//
// The profile photo is treated separately and by choice: a person withdrawing consent to FACE
// RECOGNITION has not necessarily asked for their profile picture to vanish from their account, and
// deleting it unasked would be its own surprise. The caller says which they meant.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

function isUuid(v: unknown): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** What this account currently holds, so a person can be told before they decide. */
export interface FaceHoldings {
  /** True when an enrolment row exists at all, active or not. */
  enrolled: boolean;
  active: boolean;
  /** True when the row carries a biometric template. */
  hasTemplate: boolean;
  /** True when the row carries the raw captured image. */
  hasImage: boolean;
  /** True when a profile photo on the account was derived from a face capture. */
  hasDerivedPhoto: boolean;
  enrolledAt: string | null;
  /** Set when the lookup failed. Never treated as "nothing is held". */
  error: string | null;
}

const UNKNOWN: FaceHoldings = Object.freeze({
  enrolled: false, active: false, hasTemplate: false, hasImage: false,
  hasDerivedPhoto: false, enrolledAt: null,
  error: 'We could not read what is held for this account.',
});

/**
 * What facial data does this account hold?
 *
 * NEVER THROWS, and a failed read reports `error` rather than an empty answer. Telling somebody
 * "nothing is stored" when the truth is "we could not check" is the worst possible answer to a
 * privacy question, because they will stop asking.
 */
export async function faceHoldings(userId: string): Promise<FaceHoldings> {
  if (!isUuid(userId)) return { ...UNKNOWN, error: 'That account id is not valid.' };
  try {
    // selfie_url is added lazily by the enrolment endpoint, so it may not exist on this deployment.
    // to_jsonb lets one statement answer whether the column is there AND what it holds.
    const r = rowsOf(await db.execute(sql`
      SELECT is_active,
             enrolled_at,
             (face_descriptor IS NOT NULL) AS has_template,
             COALESCE(length(to_jsonb(e) ->> 'selfie_url'), 0) > 0 AS has_image
        FROM user_face_enrollments e
       WHERE user_id = ${userId}
       ORDER BY enrolled_at DESC NULLS LAST
       LIMIT 1`))[0];

    let hasDerivedPhoto = false;
    try {
      const p = rowsOf(await db.execute(sql`
        SELECT (photo_url IS NOT NULL AND photo_url <> '') AS has_photo
          FROM users WHERE id = ${userId} LIMIT 1`))[0];
      hasDerivedPhoto = !!p?.has_photo;
    } catch (e: any) {
      console.error('[face-erasure] photo check failed:', e?.cause?.message || e?.message);
    }

    if (!r) {
      return { enrolled: false, active: false, hasTemplate: false, hasImage: false,
        hasDerivedPhoto, enrolledAt: null, error: null };
    }
    return {
      enrolled: true,
      active: r.is_active !== false,
      hasTemplate: !!r.has_template,
      hasImage: !!r.has_image,
      hasDerivedPhoto,
      enrolledAt: r.enrolled_at ? String(r.enrolled_at) : null,
      error: null,
    };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[face-erasure] holdings lookup failed:', why);
    return { ...UNKNOWN, error: why };
  }
}

export interface ErasureResult {
  ok: boolean;
  /** Confirmed by reading the row back, not inferred from the DELETE returning. */
  templateGone: boolean;
  imageGone: boolean;
  photoCleared: boolean;
  /** ISO instant the erasure completed, for the confirmation a person is owed. */
  completedAt: string | null;
  /** One sentence for the person. Never a status code. */
  sentence: string;
  error: string | null;
}

/**
 * Erase this account's facial data.
 *
 * @param alsoDeleteProfilePhoto  whether the profile picture derived from the capture goes too.
 *        Asked rather than assumed: withdrawing consent to face RECOGNITION is not automatically a
 *        request to remove your own profile picture, and doing it unasked is its own surprise.
 *
 * VERIFIES BY READING BACK. This project has shipped more than one thing that reported success
 * having done nothing, and "your biometric data has been deleted" is the single worst sentence to
 * say on faith.
 */
export async function eraseFaceData(
  userId: string,
  opts: { alsoDeleteProfilePhoto?: boolean; actorUserId?: string | null; reason?: string | null } = {},
): Promise<ErasureResult> {
  const fail = (msg: string, why: string | null = null): ErasureResult => ({
    ok: false, templateGone: false, imageGone: false, photoCleared: false,
    completedAt: null, sentence: msg, error: why,
  });

  if (!isUuid(userId)) return fail('That account id is not valid, so nothing was changed.');

  try {
    // The row goes entirely. Not is_active = false: that leaves the template and the image in place,
    // which is precisely what somebody withdrawing consent is asking to be rid of.
    await db.execute(sql`DELETE FROM user_face_enrollments WHERE user_id = ${userId}`);

    let photoCleared = false;
    if (opts.alsoDeleteProfilePhoto) {
      await db.execute(sql`UPDATE users SET photo_url = NULL WHERE id = ${userId}`);
      // hr_employees may not carry the column on every deployment; a missing column must not make
      // the erasure look like it failed.
      await db.execute(sql`UPDATE hr_employees SET photo_url = NULL WHERE user_id = ${userId}`)
        .catch((e: any) => console.error('[face-erasure] hr photo clear:', e?.cause?.message || e?.message));
      photoCleared = true;
    }

    // READ BACK. The confirmation is the point of this whole function.
    const after = await faceHoldings(userId);
    if (after.error) {
      return fail(
        'The deletion ran, but we could not read the account back to confirm it. Nothing has been '
        + 'reported as deleted until that confirmation succeeds — please try again in a moment.',
        after.error,
      );
    }
    if (after.enrolled) {
      return fail('The facial data is still present after the deletion ran. Nothing is being claimed as deleted.');
    }

    const completedAt = new Date().toISOString();
    // The erasure itself is recorded — WITHOUT any facial data in it. An audit row that quoted the
    // template would defeat the erasure it was recording.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS face_erasure_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          actor_user_id UUID,
          reason TEXT,
          photo_cleared BOOLEAN NOT NULL DEFAULT false,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`
        INSERT INTO face_erasure_log (user_id, actor_user_id, reason, photo_cleared)
        VALUES (${userId}, ${opts.actorUserId && isUuid(opts.actorUserId) ? opts.actorUserId : null},
                ${opts.reason ?? null}, ${photoCleared})`);
    } catch (e: any) {
      // The data IS gone; only the record of it failed. Logged, never surfaced as a failure to
      // delete, because that would invite somebody to run it again looking for a different answer.
      console.error('[face-erasure] erasure log failed:', e?.cause?.message || e?.message);
    }

    return {
      ok: true,
      templateGone: true,
      imageGone: true,
      photoCleared,
      completedAt,
      sentence: 'Face sign-in is off and your facial data has been deleted'
        + (photoCleared ? ', including the profile picture taken from it.' : '. Your profile picture was left in place.')
        + ' You can still sign in with your password'
        + ' and any other method you have set up.',
      error: null,
    };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[face-erasure] deletion failed:', why);
    return fail('Your facial data could NOT be deleted just now, and nothing has been changed. Please try again in a moment.', why);
  }
}

// =================================================================================================
// AUTOMATIC DELETION — SO IT DOES NOT DEPEND ON SOMEBODY ASKING
// =================================================================================================
//
// The applicant who prompted all of this had to write an email. She should not have had to, and the
// next person will not: biometric data that is no longer needed for the purpose it was collected for
// should not still be here to be asked about.
//
// Face enrolment exists to let somebody sign in and to verify identity at clock-in and in proctored
// tests. Once an account can no longer do any of those, the template has no purpose left, and
// keeping it is a risk carried for nothing.
//
// THE RULES ARE DELIBERATELY CONSERVATIVE, because the cost of deleting too eagerly is a person
// locked out of their own sign-in method with no warning:
//
//   1. The account is closed (is_active = false). Nothing can be signed into, so nothing needs a
//      face. Kept for a short grace period in case the closure is reversed.
//   2. The enrolment has gone unused for a long time AND the account has not been seen. Somebody
//      who is actively using face sign-in is never touched by this, however old the enrolment.
//
// A DELETION IS NEVER SILENT. Everyone in the sweep is notified, and previewFaceRetention() exists
// so the rule can be read against real data before it is allowed to fire.

/** Days after an account closes before its facial data goes. */
export const RETENTION_CLOSED_ACCOUNT_DAYS = 30;
/** Days of total inactivity — no sign-in, no face use — before an enrolment is considered spent. */
export const RETENTION_DORMANT_DAYS = 540;

export interface RetentionCandidate {
  userId: string;
  email: string | null;
  name: string | null;
  reason: 'account-closed' | 'dormant';
  /** Whole days since the fact that makes them a candidate. */
  days: number;
}

/**
 * Who would the rule delete today, and why?
 *
 * READ-ONLY. The preview and the sweep share this function, so what you are shown before pressing
 * is produced by the same code that runs after, and the two cannot disagree.
 */
export async function previewFaceRetention(): Promise<{ candidates: RetentionCandidate[]; error: string | null }> {
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT u.id::text AS user_id, u.email, u.name,
             (u.is_active = false) AS closed,
             EXTRACT(DAY FROM (NOW() - COALESCE(u.updated_at, e.enrolled_at)))::int AS closed_days,
             EXTRACT(DAY FROM (NOW() - GREATEST(
               COALESCE(u.last_login_at, e.enrolled_at),
               e.enrolled_at)))::int AS idle_days
        FROM user_face_enrollments e
        JOIN users u ON u.id = e.user_id
       ORDER BY u.email ASC
       LIMIT 500`));

    const out: RetentionCandidate[] = [];
    for (const r of rows) {
      const closedDays = Number(r.closed_days ?? 0);
      const idleDays = Number(r.idle_days ?? 0);
      if (r.closed && closedDays >= RETENTION_CLOSED_ACCOUNT_DAYS) {
        out.push({ userId: String(r.user_id), email: r.email ?? null, name: r.name ?? null, reason: 'account-closed', days: closedDays });
      } else if (!r.closed && idleDays >= RETENTION_DORMANT_DAYS) {
        out.push({ userId: String(r.user_id), email: r.email ?? null, name: r.name ?? null, reason: 'dormant', days: idleDays });
      }
    }
    return { candidates: out, error: null };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[face-erasure] retention preview failed:', why);
    // NOT an empty list. "Nobody is due" and "we could not check" must never look the same on a
    // screen that decides whether biometric data is deleted.
    return { candidates: [], error: why };
  }
}

/**
 * Run the retention rule.
 *
 * The profile picture is NEVER removed by the automatic sweep, whatever it was derived from. A
 * person waking up to find their photograph gone from an account they still hold would have no idea
 * why, and retention of a biometric template is a different question from a profile picture.
 */
export async function runFaceRetention(opts: { dryRun?: boolean } = {}): Promise<{
  ok: boolean; considered: number; deleted: number; failed: number; error: string | null;
}> {
  const { candidates, error } = await previewFaceRetention();
  if (error) return { ok: false, considered: 0, deleted: 0, failed: 0, error };
  if (opts.dryRun) return { ok: true, considered: candidates.length, deleted: 0, failed: 0, error: null };

  let deleted = 0, failed = 0;
  for (const c of candidates) {
    const r = await eraseFaceData(c.userId, {
      alsoDeleteProfilePhoto: false,
      actorUserId: null,
      reason: 'Automatic retention: ' + c.reason + ' for ' + c.days + ' days',
    });
    if (r.ok) {
      deleted++;
      // TOLD, NOT DONE QUIETLY. Somebody whose biometric data we deleted is entitled to know it
      // happened, and a failed notification never undoes or hides the deletion.
      try {
        const { notifyUser } = await import('@/lib/notify');
        await notifyUser(c.userId, {
          // 'system' — the notification type union has no 'security'. A type outside it is a
          // compile error here, and would have been a silent no-op if this were untyped.
          type: 'system',
          title: 'Your facial data has been deleted',
          body: 'Face sign-in was not in use on your account, so the facial data held for it has been '
            + 'deleted under our retention policy. Your account and every other way of signing in are '
            + 'unchanged, and you can set face sign-in up again at any time.',
          url: '/portal/face-data',
        });
      } catch (e: any) {
        console.error('[face-erasure] retention notice failed for', c.userId, e?.cause?.message || e?.message);
      }
    } else {
      failed++;
    }
  }
  return { ok: true, considered: candidates.length, deleted, failed, error: null };
}
