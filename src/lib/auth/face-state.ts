// src/lib/auth/face-state.ts — is there a photo to match against, and is it still any good?
//
// =================================================================================================
// WHY THIS EXISTS
// =================================================================================================
//
// Everything needed to match a face already exists: matchEnrolledFace() compares a live descriptor
// against the enrolled one, hasActiveFaceEnrolment() says whether there is one, user_face_enrollments
// carries enrolled_at, and four separate pages can capture an enrolment.
//
// What did NOT exist is the thing that joins them. A person with no enrolment reached a clock-out
// screen that told them the face check could not run and left them there. The route to fix it —
// enrol, then match against that — was never offered, so the dead end was permanent for anybody who
// had never been through onboarding's capture step.
//
// So this module answers one question in one place: what state is this person's face enrolment in,
// and what should the screen in front of them offer? Every surface asks it rather than each deciding
// for itself, because five screens each reasoning about enrolment is five chances to disagree about
// whether somebody can clock out.
//
// =================================================================================================
// STALENESS IS A PROMPT, NEVER A LOCK
// =================================================================================================
//
// A photo from two years ago still matches most people, and the ones it stops matching are the ones
// who have changed — grown a beard, changed glasses, aged, been ill. Those are exactly the people a
// hard expiry would lock out of their own working day, on a morning when they have done nothing
// wrong and have no idea why.
//
// So a stale enrolment is REFRESHABLE, not expired: the person is told it is old and offered the
// thirty seconds to replace it, and the old one keeps working until they do. The only thing that
// ever blocks somebody is having no enrolment at all — and even then the answer is a link, not a
// refusal.

import { hasActiveFaceEnrolment } from '@/lib/auth/face';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST. `const` is not hoisted; a binding under its first reader has taken pages down.
// -------------------------------------------------------------------------------------------------

/**
 * After this long, the person is asked whether they would like to replace their photo. Nothing
 * expires and nothing is refused — see the header. A year is roughly the point at which a face has
 * changed enough that a failed match starts being about the photo rather than the person.
 */
export const REFRESH_AFTER_DAYS = 365;

/** Where somebody goes to capture or replace one. The portal route, which works on a phone. */
export const ENROL_HREF = '/portal/face-setup';

export type FaceState = 'none' | 'fresh' | 'ageing' | 'unknown';

export interface FaceEnrolmentState {
  state: FaceState;
  enrolled: boolean;
  enrolledAt: string | null;
  ageDays: number | null;
  /** True only when there is nothing to match against at all. */
  mustEnrol: boolean;
  /** True when a replacement is worth offering. Never blocks anything. */
  shouldRefresh: boolean;
  /** One sentence for the person in front of the screen, in their terms, never a status code. */
  sentence: string;
  enrolHref: string;
  /** Set when the lookup itself failed. Not the same as having no enrolment, and never treated so. */
  error: string | null;
}

function isUuid(v: unknown): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/**
 * What state is this person's face enrolment in?
 *
 * NEVER THROWS, and a failed read is reported as 'unknown' rather than as 'none'. Those are
 * different facts and confusing them is the expensive direction: telling somebody who IS enrolled
 * that they must enrol sends them to capture a photo they already have, and telling somebody the
 * check is unavailable when they simply never enrolled leaves them stuck. Both sentences are wrong
 * in a way the person cannot argue with.
 */
export async function faceEnrolmentState(userId: string): Promise<FaceEnrolmentState> {
  const base: FaceEnrolmentState = {
    state: 'unknown', enrolled: false, enrolledAt: null, ageDays: null,
    mustEnrol: false, shouldRefresh: false, enrolHref: ENROL_HREF, error: null,
    sentence: 'Whether you have a photo on file could not be checked.',
  };
  if (!isUuid(userId)) return base;

  let enrolled = false;
  try {
    enrolled = await hasActiveFaceEnrolment(userId);
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[face-state] enrolment lookup failed:', why);
    return { ...base, error: why };
  }

  if (!enrolled) {
    return {
      ...base,
      state: 'none',
      mustEnrol: true,
      sentence: 'There is no photo on file for you yet, so there is nothing to compare against. '
        + 'Capturing one takes about half a minute and only a signature is stored — the picture '
        + 'itself never leaves your device.',
    };
  }

  // The age is a nicety and must never decide whether somebody can work, so a failure to read it
  // leaves the enrolment fresh rather than turning a date problem into a person problem.
  let enrolledAt: string | null = null;
  let ageDays: number | null = null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT enrolled_at,
             EXTRACT(DAY FROM (NOW() - enrolled_at))::int AS age_days
        FROM user_face_enrollments
       WHERE user_id = ${userId} AND is_active = true
       LIMIT 1`))[0];
    if (r?.enrolled_at) {
      enrolledAt = String(r.enrolled_at);
      ageDays = Number(r.age_days ?? 0);
    }
  } catch (e: any) {
    console.error('[face-state] age lookup failed:', e?.cause?.message || e?.message);
  }

  const ageing = ageDays !== null && ageDays >= REFRESH_AFTER_DAYS;
  return {
    state: ageing ? 'ageing' : 'fresh',
    enrolled: true,
    enrolledAt,
    ageDays,
    mustEnrol: false,
    shouldRefresh: ageing,
    enrolHref: ENROL_HREF,
    error: null,
    sentence: ageing
      ? 'Your photo was taken about ' + Math.round((ageDays || 0) / 30) + ' months ago. It still '
        + 'works, and you can replace it whenever you like — worth doing if the check has started '
        + 'failing more often than it used to.'
      : 'You have a photo on file, so the check compares against that.',
  };
}
