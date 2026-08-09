// src/lib/attendance-verify.ts — FACE VERIFICATION FOR A PUNCH, STORING NO IMAGE.
//
// =================================================================================================
// THE STORAGE RULE, WHICH IS THE POINT OF THIS FILE
// =================================================================================================
//
// NO PHOTOGRAPH IS EVER WRITTEN ANYWHERE BY THIS PATH. Not to disk, not to blob storage, not to a
// database column, not as a thumbnail, not as a base64 string, not "temporarily". The frame the
// camera produced is discarded IN THE BROWSER and is never uploaded at all — see the capture script
// in src/pages/portal/employee/attendance/index.astro, which stops the MediaStream tracks, clears
// the canvas and drops its reference before anything is POSTed.
//
// WHAT CROSSES THE WIRE is 128 floating point numbers: a descriptor. WHAT IS STORED is the OUTCOME
// of comparing them — true or false, by which method, at what time. The submitted descriptor is
// used for the comparison inside verifyPunchFace() and then goes out of scope. There is deliberately
// no column on hr_clock_events or hr_attendance that could hold one, and adding one would defeat the
// entire feature: a descriptor is a biometric template, and a template that is stored twice is a
// template that can leak twice. A password can be rotated. A face cannot.
//
// The one image this platform stores is the small profile photo that already existed. This file
// adds nothing to that list.
//
// SEE ALSO, AND NOT FIXED HERE: hr_clock_events.face_photo (db/hr-schema.sql:161) is a pre-existing
// column that the OLD clock-in widget in src/pages/portal/employee.astro:191 still fills with a
// base64 selfie of up to 300 kB, which /admin/hr/attendance renders as an <img>. That is a second,
// older punch path outside this module and it is the one thing that stops "this platform stores no
// attendance photograph" from being true today. Nothing in this file reads or writes that column.
// It is written up in full for whoever picks it up next; it needs a decision about the images
// already in the table, not just a code change, which is why it is not quietly done here.
//
// =================================================================================================
// THE SERVER NEVER TRUSTS A CLIENT VERDICT
// =================================================================================================
//
// The browser sends a descriptor and NOTHING ELSE about the result. It does not send a distance, a
// score, a `matched` boolean or a threshold. That exact defect is live in
// src/pages/api/auth/enroll-face.ts, which reads `matchDistance` out of the request body and admits
// anybody who posts `{ matchDistance: 0.01 }` — enrol as anyone. The comparison here happens on the
// server via matchEnrolledFace() in src/lib/auth/face.ts, which loads the enrolled descriptor, uses
// it, and does not return it.
//
// =================================================================================================
// A FAILED CHECK IS ADVISORY. IT NEVER REFUSES SOMEBODY THEIR ATTENDANCE.
// =================================================================================================
//
// Automated detection on this platform is advisory only, and attendance is the case where that
// matters most: a person who genuinely turned up, in a dark stairwell, on a phone whose front
// camera is scratched, must still be able to record that they were at work. Refusing the punch
// punishes the camera and bills the person. So EVERY outcome in this file, including 'no_match',
// still records the punch — the outcome is written beside it and a human reads it.
//
// There is no `is_valid`, `rejected` or `suspicious` column here, matching the discipline the
// geo/QR evidence already follows in src/lib/attendance-schema.ts: the moment a column states a
// verdict, a screen starts filtering on it and somebody loses a day's pay to a lighting problem.
// What is recorded is what was MEASURED. "Worth a look" is derived when somebody looks, by
// needsHumanLook() below, and a person decides what it means.
//
// The other half of that bargain: an unverified punch must be VISIBLY unverified, or the feature
// means nothing. verificationLine() phrases every outcome plainly and the portal and HR screens
// print it, so "verified" and "recorded, not verified" never look the same.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - Self-bootstrapping DDL only, inside an ensureOnce() guard with its own key. A new key is
//     required rather than more statements in 'attendance_v1': ensureOnce memoises per key per
//     PROCESS, so a running server that has already resolved that key would never execute
//     statements appended to it.
//   - postgres-js returns plain arrays. Never r.rows[0].
//   - The real Postgres reason is on e.cause; e.message is only the SQL that failed.
//   - Every const is declared above the function that reads it. `const` is not hoisted.
//   - This file imports NOTHING from src/lib/attendance.ts, deliberately: attendance.ts imports the
//     ensure and the type from here, and one direction only means no import cycle to reason about.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from './ensure-once';
import { matchEnrolledFace, causeOf } from './auth/face';

const logFail = (tag: string, e: any) =>
  console.error('[attendance-verify] ' + tag, causeOf(e));

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * WHAT WAS MEASURED when this punch was recorded. Five facts, not five verdicts.
 *
 *   match         the submitted descriptor matched the enrolled one, server-side.
 *   no_match      it did not. THE PUNCH IS STILL RECORDED. This is the only outcome that is worth a
 *                 human look, and even then it is a look, not a finding: a sibling in frame, a
 *                 changed beard, a 2 a.m. corridor and an old enrolment all produce it.
 *   not_enrolled  this person has no active face enrolment, so there was nothing to compare
 *                 against. Not their fault and not a failure — they are invited to enrol.
 *   no_capture    the camera was refused, unavailable, or the person chose to skip it. A punch made
 *                 from the plain form with JavaScript switched off lands here too.
 *   unavailable   we could not run the check at all — the database was unreachable, the model would
 *                 not load. Explicitly NOT folded into no_match: "our server had a bad minute" and
 *                 "that is not your face" are different sentences and only one of them is about
 *                 the person.
 *
 * FOUR MORE, ADDED FOR THE CLOCK-OUT GATE (src/lib/attendance-verify-clockout.ts), where the second
 * factor may also be an authenticator or a recovery code, and where a person must be able to say "I
 * cannot do this" and still go home. They are ADDITIVE: every value above keeps exactly the meaning
 * it had, so nothing already written to face_verify_outcome changes meaning.
 *
 *   code_match         an authenticator code or a one-time recovery code, verified server-side.
 *   code_no_match      it did not match. THE CLOCK-OUT IS STILL RECORDED.
 *   declined           the person could not complete the check — camera denied, phone lost, an
 *                      enrolment that is genuinely broken — and said so. Their own words are kept
 *                      with it. This is the escape hatch that stops the gate stranding somebody at
 *                      work overnight, and it is a fact about an attempt, never an accusation.
 *   too_many_attempts  several checks failed within a few minutes, so we stopped asking rather than
 *                      keep somebody clocked in. Also still recorded.
 */
export const VERIFY_OUTCOMES = [
  'match',
  'no_match',
  'not_enrolled',
  'no_capture',
  'unavailable',
  'code_match',
  'code_no_match',
  'declined',
  'too_many_attempts',
] as const;
export type VerifyOutcome = (typeof VERIFY_OUTCOMES)[number];

const OUTCOME_SET = new Set<string>(VERIFY_OUTCOMES);
export function isVerifyOutcome(v: unknown): v is VerifyOutcome {
  return typeof v === 'string' && OUTCOME_SET.has(v);
}

/**
 * How the check was attempted.
 *
 *   face  a descriptor compared against the enrolment, server-side.
 *   code  an authenticator code or a one-time recovery code, verified server-side. One value for
 *         both deliberately: verifyLoginCode() accepts either and does not say which it was, and a
 *         label that guessed from the shape of what was typed would sometimes be wrong about how
 *         somebody proved who they were.
 *   none  no check was attempted, or the person said they could not complete one.
 */
export const VERIFY_METHODS = ['face', 'code', 'none'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

/**
 * The result of a verification attempt, ready to be written beside a punch.
 *
 * IT CONTAINS NO DESCRIPTOR, NO DISTANCE AND NO IMAGE, and it never will. The distance is measured
 * inside verifyPunchFace(), logged to the server log, and dropped: returning a number would let a
 * caller hill-climb toward the enrolled template one probe at a time, which is the same biometric
 * disclosure by a slower road (see the note on FaceMatchResult in src/lib/auth/face.ts).
 *
 * ONLY verifyPunchFace() AND declinedVerification() PRODUCE ONE. Nothing parses this shape out of a
 * request body, so a browser cannot hand the server a finished `{ verified: true }` and be believed.
 */
export interface PunchVerification {
  /** true ONLY for a server-measured match. Every other outcome is false. */
  verified: boolean;
  method: VerifyMethod;
  outcome: VerifyOutcome;
  /** When the check ran, ISO. Not when the punch was inserted — usually a second or two earlier. */
  at: string;
}

// -------------------------------------------------------------------------------------------------
// STORAGE — FOUR COLUMNS OF OUTCOME, AND NOT ONE OF BIOMETRICS
// -------------------------------------------------------------------------------------------------

/**
 * Add the outcome columns. Idempotent, safe on every request, its own ensureOnce key.
 *
 * ADD COLUMN IF NOT EXISTS only — nothing is created, retyped or dropped, so this is a no-op against
 * the production tables and only completes a fresh environment.
 *
 * NOTE WHAT IS ABSENT: there is no descriptor column, no photo column, no distance column and no
 * "rejected" column. All four omissions are the design and not an oversight.
 *
 * Re-throws after logging, exactly as ensureAttendanceSchema() does, so ensureOnce drops the failed
 * run from its cache and the next call retries instead of a transient error poisoning the process.
 * ensureOnce then swallows the rejection for the caller, so a punch is never lost to a DDL hiccup —
 * it is recorded with the columns it can write.
 */
export function ensureFaceVerifySchema(): Promise<void> {
  return ensureOnce('attendance_face_verify_v1', async () => {
    try {
      // The punch. This is where verification actually happens — a person verifies at 09:02 and
      // again at 18:30, and those are two separate facts about two separate events.
      await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verified BOOLEAN`);
      await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verify_method TEXT`);
      await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verify_outcome TEXT`);
      await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verified_at TIMESTAMPTZ`);

      // The day. A SUMMARY of the punches above, recomputed from them on every punch exactly as
      // work_hours already is — never incremented, so a double-fire cannot corrupt it and a
      // repaired event log repairs the day the next time anybody punches.
      //
      // NULL means "no verification information for this day" (an HR-entered row, an approved
      // leave day, a punch made before this feature existed). NULL is not "unverified": a screen
      // that renders a missing answer as a failure is the screen this whole file argues against.
      await db.execute(sql`ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS face_verified BOOLEAN`);
      await db.execute(sql`ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS face_verify_method TEXT`);
      await db.execute(sql`ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS face_verified_at TIMESTAMPTZ`);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS hr_clock_events_verify_idx
          ON hr_clock_events (employee_id, face_verify_outcome)`);
    } catch (e: any) {
      logFail('ensureFaceVerifySchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// THE CHECK
// -------------------------------------------------------------------------------------------------

/** Someone who did not or could not use the camera. A fact about the attempt, not about the person. */
export function declinedVerification(outcome: VerifyOutcome = 'no_capture'): PunchVerification {
  return {
    verified: false,
    method: 'none',
    outcome: isVerifyOutcome(outcome) ? outcome : 'no_capture',
    at: new Date().toISOString(),
  };
}

/**
 * COMPARE A LIVE DESCRIPTOR AGAINST THE ENROLLED ONE, ON THE SERVER.
 *
 * `liveRaw` is whatever arrived in the request body. It is validated by parseLiveDescriptor() inside
 * src/lib/auth/face.ts (128 finite floats, not all zeros) and a bad one produces 'no_capture' rather
 * than 'no_match' — a browser that failed to find a face in the frame did not fail a face check.
 *
 * THE DESCRIPTOR IS NOT RETURNED, NOT LOGGED AND NOT STORED. It is a parameter that goes out of
 * scope when this function returns.
 *
 * NOTHING IS SWALLOWED. A thrown database error becomes 'unavailable' WITH the real reason on the
 * server log, never a quiet `verified: false` — a bare catch that turned an outage into a plausible
 * "wrong password" hid a total sign-in failure on this project for hours, and turning an outage into
 * "that is not your face" is the same mistake pointed at somebody's attendance.
 */
export async function verifyPunchFace(userId: string, liveRaw: unknown): Promise<PunchVerification> {
  const at = new Date().toISOString();

  if (!userId) return { verified: false, method: 'none', outcome: 'no_capture', at };

  try {
    const result = await matchEnrolledFace(userId, liveRaw);

    if (!result.enrolled) {
      return { verified: false, method: 'none', outcome: 'not_enrolled', at };
    }
    if (result.matched) {
      return { verified: true, method: 'face', outcome: 'match', at };
    }

    // The distance goes to the server log and no further. It is not returned to the caller and
    // there is no column for it.
    console.warn(
      '[attendance-verify] face did not match for user',
      userId,
      'distance=' + (Number.isFinite(result.distance) ? result.distance.toFixed(3) : 'n/a'),
    );
    return { verified: false, method: 'face', outcome: 'no_match', at };
  } catch (e: any) {
    logFail('verifyPunchFace', e);
    return { verified: false, method: 'face', outcome: 'unavailable', at };
  }
}

/**
 * Does this person have a face to check against? Used to decide whether to OFFER the camera and
 * whether to invite them to enrol. Returns a boolean and nothing else — no screen ever needs the
 * descriptor to draw a viewfinder.
 *
 * Fails closed to false: "we could not tell" renders the same invitation to enrol as "no", which is
 * a harmless sentence, and never blocks the punch either way.
 */
export async function hasFaceEnrolment(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM user_face_enrollments
       WHERE user_id = ${userId} AND is_active = true
       LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('hasFaceEnrolment', e);
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// READING IT BACK
// -------------------------------------------------------------------------------------------------

export interface DayVerification {
  /** Punches recorded today. */
  punches: number;
  /** Punches whose face check passed on the server. */
  verified: number;
  /** Punches where a check ran and did not match. The only number worth a human look. */
  mismatched: number;
  /**
   * true when every punch today was verified, false when at least one was not, and NULL when there
   * is no verification information at all. Three states, deliberately: absent is not failed.
   */
  allVerified: boolean | null;
  /** The most recent method that produced a match today, for the day row. */
  method: VerifyMethod | null;
  /** When the most recent successful check ran, ISO. */
  at: string | null;
}

const EMPTY_DAY: DayVerification = {
  punches: 0,
  verified: 0,
  mismatched: 0,
  allVerified: null,
  method: null,
  at: null,
};

/**
 * Summarise a day's punches. Pure read; writes nothing.
 *
 * Fails closed to EMPTY_DAY, whose allVerified is NULL — so a database problem renders as "nothing
 * recorded about verification", never as "this person failed a check".
 */
export async function dayVerification(employeeId: string, dateIso: string): Promise<DayVerification> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return EMPTY_DAY;
  try {
    await ensureFaceVerifySchema();
    const r = await db.execute(sql`
      SELECT face_verified, face_verify_method, face_verify_outcome, face_verified_at
        FROM hr_clock_events
       WHERE employee_id = ${employeeId}::uuid
         AND event_time >= ${dateIso}::date
         AND event_time < (${dateIso}::date + INTERVAL '1 day')
       ORDER BY event_time ASC
       LIMIT 200`);

    const list = rows(r);
    if (list.length === 0) return EMPTY_DAY;

    let verified = 0;
    let mismatched = 0;
    let known = 0;
    let method: VerifyMethod | null = null;
    let at: string | null = null;

    for (const row of list) {
      const outcome = row?.face_verify_outcome ? String(row.face_verify_outcome) : '';
      if (outcome) known++;
      if (row?.face_verified === true) {
        verified++;
        method = 'face';
        at = row?.face_verified_at ? new Date(row.face_verified_at).toISOString() : at;
      }
      if (outcome === 'no_match') mismatched++;
    }

    return {
      punches: list.length,
      verified,
      mismatched,
      // No punch today carries any verification information: say nothing rather than "unverified".
      allVerified: known === 0 ? null : verified === list.length,
      method,
      at,
    };
  } catch (e: any) {
    logFail('dayVerification', e);
    return EMPTY_DAY;
  }
}

/**
 * Is this outcome worth a person's attention? DERIVED, never stored — the same discipline the geo
 * evidence follows. Only a check that RAN and did not match qualifies. Not enrolled, no camera and
 * an unavailable server are all ordinary and none of them is about the employee.
 *
 * A true answer means "somebody should glance at this", never "reject this", never "dock this".
 *
 * THE CLOCK-OUT OUTCOMES follow the same line exactly. A code that did not match is the same kind of
 * fact as a face that did not match. 'declined' and 'too_many_attempts' are here because the gate
 * PROMISES the person that a human will look — the escape hatch out of a broken enrolment is only
 * honest if somebody actually reads it — and for no other reason: appearing in this list deducts
 * nothing, decides nothing and is not a finding about anybody.
 */
export function needsHumanLook(outcome: string | null | undefined): boolean {
  return outcome === 'no_match'
    || outcome === 'code_no_match'
    || outcome === 'declined'
    || outcome === 'too_many_attempts';
}

/**
 * Phrase an outcome for the person it is about, in their own words, on their own screen.
 *
 * These strings are read by the employee, so none of them accuses anybody and none of them implies
 * a consequence that does not exist. Every one of them ends with the punch being recorded, because
 * in every case the punch WAS recorded.
 */
export function verificationLine(outcome: string | null | undefined): string {
  if (outcome === 'match') {
    return 'Face check passed. No photo was taken or kept - only a mathematical signature was compared, and it has been discarded.';
  }
  if (outcome === 'no_match') {
    return 'Your punch is recorded. The face check did not match the face on your account, so it is marked for someone to look at. Nothing is deducted and nothing is decided by this - lighting, a camera angle or an out-of-date enrolment all cause it. Re-enrol your face if you have changed how you look.';
  }
  if (outcome === 'not_enrolled') {
    return 'Your punch is recorded, without a face check: there is no face enrolled on your account to compare against. You can add one whenever you like, and your attendance works exactly the same either way.';
  }
  if (outcome === 'no_capture') {
    return 'Your punch is recorded, without a face check, because the camera was not used. That is not a problem and nothing is marked against you.';
  }
  if (outcome === 'unavailable') {
    return 'Your punch is recorded. We could not run the face check just now - that is our side, not yours, and nothing is marked against you.';
  }
  if (outcome === 'code_match') {
    return 'Your punch is recorded and your identity was confirmed by the code you entered.';
  }
  if (outcome === 'code_no_match') {
    return 'Your punch is recorded. The code did not match, so it is marked for someone to look at. Nothing is deducted and nothing is decided by this.';
  }
  if (outcome === 'declined') {
    return 'Your punch is recorded. You told us you could not complete the identity check, and your reason is kept with it for a person to read. Nothing is deducted and nothing is decided automatically.';
  }
  if (outcome === 'too_many_attempts') {
    return 'Your punch is recorded. Several identity checks failed on this account in the last few minutes, so we stopped asking rather than keep you here. It is marked for a person to look at.';
  }
  return '';
}

/** A short label for a list or a table cell. Never abbreviates a failure into an accusation. */
export function verificationBadge(outcome: string | null | undefined): string {
  if (outcome === 'match') return 'Face verified';
  if (outcome === 'no_match') return 'Face check did not match';
  if (outcome === 'not_enrolled') return 'No face enrolled';
  if (outcome === 'no_capture') return 'No face check';
  if (outcome === 'unavailable') return 'Face check unavailable';
  if (outcome === 'code_match') return 'Confirmed by code';
  if (outcome === 'code_no_match') return 'Code did not match';
  if (outcome === 'declined') return 'Identity check not completed';
  if (outcome === 'too_many_attempts') return 'Identity check stopped';
  return 'Not recorded';
}
