// src/lib/attendance-verify-clockout.ts — THE GATE IN FRONT OF A CLOCK-OUT.
//
// =================================================================================================
// WHAT THIS FILE IS
// =================================================================================================
//
// A person clocks out only after two things have happened, in this order:
//
//   1. THEY RECORDED WHAT THEY DID. Three ways of giving the same thing are accepted, because
//      people already work in different tools and forcing one is how a form fills up with the word
//      "done": typed here, a Drive link, or a form-response link. At least one must be present, and
//      a LINK ALONE is only accepted with a one-line summary typed here — a reviewer scanning a
//      week must not have to open twelve tabs to find out what happened.
//
//   2. THEY RE-CONFIRMED WHO THEY ARE. A second factor, compared ON THE SERVER, reusing
//      src/lib/auth/two-factor.ts: a face descriptor, an authenticator code, or a recovery code.
//      The browser never sends a verdict and never receives an enrolled descriptor.
//
// =================================================================================================
// AND IT CANNOT TRAP ANYBODY AT WORK. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
// =================================================================================================
//
// If the second factor cannot be completed — camera refused, phone lost, an enrolment that is
// genuinely broken, our own server having a bad minute — THE PERSON STILL CLOCKS OUT. The attempt
// is recorded as what it was, the clock-out carries a label saying the identity check did not pass,
// and a human looks at it. Automated detection on this platform is ADVISORY: a person decides.
//
// A gate that can strand somebody clocked in overnight is worse than the fraud it prevents. There
// is deliberately NO branch in verifyClockOutIdentity() that returns "refused", and no branch in
// completeClockOut() that skips the punch because of an identity outcome.
//
// What is NOT waived is the work record. Typing a sentence about your own day is not a hurdle that
// can strand anybody, and the credit engine's week-completeness test reads exactly this row.
//
// =================================================================================================
// ONE STORE OF ONE FACT
// =================================================================================================
//
// The submission is written to hr_daily_reports — THE SAME ROW the daily-report module, the
// workspace widget and the reviewer screens already read (UNIQUE (employee_id, report_date)). It is
// not a second store of the same fact, and the credit engine reads the report it already reads.
//
// It does NOT call submitReport() in src/lib/daily-report.ts for one reason, stated so nobody
// "fixes" it later: submitReport() REQUIRES a Drive link (checkDriveLink refuses an empty URL), and
// the founder's first and default submission mode is typed text with no link at all. So this module
// writes the same row with the same revision discipline — snapshot the live row inside the
// transaction, FOR UPDATE, then upsert — and adds its own columns beside it. daily-report.ts is not
// edited by this file; its pure helpers (checkDriveLink, SHARING_WARNING, reviewerFor) are imported.
//
// =================================================================================================
// NOTHING BIOMETRIC IS STORED, HERE EITHER
// =================================================================================================
//
// No photograph, no descriptor, no distance, no threshold. hr_clock_out_checks has columns for the
// OUTCOME of an attempt and for a person's own words about why they could not complete it. There is
// no column that could hold a template, and adding one would defeat the feature: a password can be
// rotated, a face cannot.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Every read goes through rows(); never r.rows[0].
//   - The real Postgres reason is on e.cause; logged as e?.cause?.message || e?.message.
//   - NOTHING IS SWALLOWED ON A WRITE PATH. completeClockOut() returns the database's own words.
//   - Self-bootstrapping DDL only, inside an ensureOnce guard, with its own key, ADD COLUMN IF NOT
//     EXISTS only. Nothing is dropped and nothing is retyped.
//   - Every const is declared above the function that reads it. const is not hoisted.
//   - No emojis anywhere.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
import {
  punch,
  punchesOn,
  computeDay,
  punchRefusal,
  today as attendanceToday,
} from '@/lib/attendance';
import {
  needsHumanLook,
  verificationBadge,
  type PunchVerification,
  type VerifyOutcome,
} from '@/lib/attendance-verify';
import {
  checkDriveLink,
  ensureDailyReportSchema,
  reviewerFor,
  SHARING_WARNING,
  MIN_SUMMARY_CHARS,
} from '@/lib/daily-report';
import {
  verifyFaceSecondFactor,
  verifyLoginCode,
  availableSecondFactors,
  hasRecoveryCodesLeft,
  countAttempt,
  peekAttempts,
  clearAttempts,
} from '@/lib/auth/two-factor';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND SMALL HELPERS — ALL OF THEM ABOVE ANYTHING THAT READS THEM.
// -------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[attendance-clock-out] ' + tag, e?.cause?.message || e?.message);

const errText = (e: any, fallback: string): string => {
  const m = e?.cause?.message || e?.message;
  return m ? String(m) : fallback;
};

const text = (v: unknown, cap: number): string =>
  typeof v === 'string' ? v.trim().slice(0, cap) : '';

const isoAt = (d: any): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(String(d));
  return isNaN(dt.getTime()) ? null : dt.toISOString();
};

/** A typed report with no link has to stand on its own, so it is held to more than one line. */
export const STANDALONE_MIN_CHARS = 40;

/** A link is only accepted with at least this much typed beside it. Same floor daily-report uses. */
export const SUMMARY_MIN_CHARS = MIN_SUMMARY_CHARS;

/** Field caps. Generous, and only there so one paste cannot fill a column. */
export const WORK_TEXT_CAP = 8000;
export const SHORT_TEXT_CAP = 2000;
export const URL_CAP = 2048;

/**
 * Words that are not a report. Refused ONLY when one of them is the entire typed text, with a
 * sentence saying why — this is the failure mode the founder named ("how a form gets filled with
 * the word done"), and it is worth one honest refusal rather than a silent acceptance that makes
 * every later reading of that week worthless.
 */
const EMPTY_PHRASES = [
  'done', 'work done', 'workdone', 'completed', 'complete', 'finished', 'ok', 'okay', 'nil',
  'na', 'n/a', 'nothing', 'as usual', 'same as yesterday', 'daily work', 'regular work', 'work',
];

/** How many failed identity attempts before we stop asking and let the person go, flagged. */
export const MAX_IDENTITY_ATTEMPTS = 10;
export const IDENTITY_WINDOW_SECONDS = 900;

const identityBucket = (userId: string) => 'clockout2fa:' + userId;

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * Additive only, and on the table that already exists.
 *
 * Its own ensureOnce key: ensureOnce memoises per key per PROCESS, so statements appended to
 * 'daily_report_v1' would never run on a server that had already resolved that key.
 *
 * ensureDailyReportSchema() is awaited FIRST because these ALTERs are against the table it creates.
 * On an existing database both are no-ops.
 *
 * Re-throws after logging, so ensureOnce drops the failed run from its cache and the next call
 * retries rather than a transient error poisoning the process for its lifetime.
 */
export function ensureClockOutSchema(): Promise<void> {
  return ensureOnce('attendance_clock_out_v1', async () => {
    try {
      await ensureDailyReportSchema();

      // WHICH OF THE THREE WAYS THE WORK ARRIVED, so a reviewer knows before opening anything
      // whether there is anything to open. 'typed', 'drive_link', 'form_response', joined by '+'.
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS work_source TEXT`);
      // The form-response link, kept SEPARATELY from report_url so a Drive doc and a form response
      // can both be present and neither overwrites the other.
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS form_response_url TEXT`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS form_service TEXT`);
      // True when this row was filed at the clock-out gate rather than from the reports screen.
      // The credit engine reads the ROW, not this flag; this is here so a human can tell where a
      // record came from six months later.
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS filed_at_clock_out BOOLEAN NOT NULL DEFAULT FALSE`);

      // -------------------------------------------------------------------------------------------
      // THE IDENTITY ATTEMPT. One row per clock-out attempt that got as far as being checked.
      //
      // NOTE WHAT IS ABSENT: no descriptor, no distance, no photo, no score, and no
      // "suspicious"/"rejected" column. needs_human_look is DERIVED by needsHumanLook(outcome) when
      // somebody looks — the same discipline the geo evidence and the punch verification already
      // follow. The moment a verdict becomes a column, a screen starts filtering on it and somebody
      // loses a day to a lighting problem.
      //
      // reviewed_* IS stored, because a human's decision is a fact worth keeping.
      // -------------------------------------------------------------------------------------------
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS hr_clock_out_checks (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          employee_id     UUID NOT NULL,
          user_id         UUID,
          work_date       DATE NOT NULL,
          checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          method          TEXT NOT NULL,
          outcome         TEXT NOT NULL,
          passed          BOOLEAN NOT NULL DEFAULT FALSE,
          declined_reason TEXT,
          work_source     TEXT,
          report_id       UUID,
          clock_out_written BOOLEAN NOT NULL DEFAULT FALSE,
          reviewed_at     TIMESTAMPTZ,
          reviewed_by_user_id UUID,
          review_note     TEXT
        )`);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS hr_clock_out_checks_emp_idx
          ON hr_clock_out_checks (employee_id, work_date DESC)`);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS hr_clock_out_checks_outcome_idx
          ON hr_clock_out_checks (outcome, checked_at DESC)`);
    } catch (e: any) {
      logFail('ensureClockOutSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// THE FORM-RESPONSE LINK — RECOGNISED BY NAME, NEVER SILENTLY ACCEPTED
// -------------------------------------------------------------------------------------------------

export type FormService = 'google_forms' | 'zoho_forms';

export interface FormLinkCheck {
  ok: boolean;
  /** The link as it would be stored, with a scheme. Empty when it could not be read. */
  url: string;
  host: string | null;
  service: FormService | null;
  /** The service in words, for the sentence shown back to the person. */
  serviceName: string;
  /** Why it was refused. Empty when ok. */
  problem: string;
  /** Things worth saying that are NOT refusals. */
  notes: string[];
}

const GOOGLE_FORM_HOSTS = ['docs.google.com', 'forms.gle'];
const ZOHO_FORM_HOST_RE = /(^|\.)(zohopublic|zoho|zohoforms)\.(com|in|eu|com\.au|com\.cn|jp|sa)$/i;

const emptyFormCheck: FormLinkCheck = {
  ok: false, url: '', host: null, service: null, serviceName: '', problem: '', notes: [],
};

/**
 * Does this look like a form RESPONSE, and from which service?
 *
 * PURE, so the hint under the field and the check the write path runs are the same function. A
 * client-side regex beside a server-side one is how a form starts accepting what the server refuses.
 *
 * IT NAMES THE SERVICE IT RECOGNISED, because "accepted" with no name is indistinguishable from a
 * random URL being waved through. Anything it cannot place is REFUSED with a sentence, not stored.
 *
 * WHAT IT CANNOT DO: prove a response was actually submitted, or that the reviewer may open it. A
 * blank /viewform address is accepted with a note saying exactly that, rather than being refused —
 * some deployments genuinely hand people that link — but the note is not optional.
 */
export function checkFormResponseLink(raw: unknown): FormLinkCheck {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ...emptyFormCheck, problem: 'Paste the link to your form response.' };
  if (value.length > URL_CAP) {
    return { ...emptyFormCheck, problem: 'That is far longer than a form link. Copy it again from the confirmation page.' };
  }
  if (/\s/.test(value)) {
    return { ...emptyFormCheck, url: value, problem: 'That has a space in it, so it is not a single link.' };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ...emptyFormCheck, url: value, problem: 'That is not a web address.' };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ...emptyFormCheck, url: value, host: parsed.hostname,
      problem: 'Use the https:// address. A form service always gives you one.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const notes: string[] = [];

  if (GOOGLE_FORM_HOSTS.includes(host)) {
    const isForm = host === 'forms.gle' || /^\/forms\//.test(path);
    if (!isForm) {
      return {
        ...emptyFormCheck, url: withScheme, host,
        problem: 'That is a Google address but not a form. If it is a Drive document, paste it in the Drive link box instead.',
      };
    }
    const isEditResponse = parsed.searchParams.has('edit2') || /edit/i.test(parsed.hash || '');
    const isSubmitted = /\/formResponse$/.test(path);
    if (isEditResponse) {
      notes.push('Recognised as an edit-response link, which is the one Google gives you after you submit.');
    } else if (isSubmitted) {
      notes.push('Recognised as a submitted-response confirmation link.');
    } else {
      notes.push('This is the address of the form itself rather than of your response, so it does not by itself show that you submitted anything. Your typed summary is what the reviewer will read.');
    }
    return { ok: true, url: withScheme, host, service: 'google_forms', serviceName: 'Google Forms', problem: '', notes };
  }

  if (ZOHO_FORM_HOST_RE.test(host)) {
    const looksLikeForm = /\/(formperma|reports|form)\//i.test(path) || host.startsWith('forms.') || host.startsWith('survey.');
    if (!looksLikeForm) {
      return {
        ...emptyFormCheck, url: withScheme, host,
        problem: 'That is a Zoho address but we could not see a form in it. Copy the link from the response confirmation page.',
      };
    }
    notes.push('Recognised as a Zoho Forms link.');
    return { ok: true, url: withScheme, host, service: 'zoho_forms', serviceName: 'Zoho Forms', problem: '', notes };
  }

  return {
    ...emptyFormCheck, url: withScheme, host,
    problem: 'We did not recognise that as a Google Form or a Zoho Form response, so it is not stored as one. '
      + 'If it is a Drive document, use the Drive link box. If it is something else, describe it in the box '
      + 'above and paste the address there - a link nobody can place is worse than a sentence.',
  };
}

// -------------------------------------------------------------------------------------------------
// THE SUBMISSION — PURE VALIDATION, THE SAME RULE ON BOTH SIDES
// -------------------------------------------------------------------------------------------------

export type WorkSourceKind = 'typed' | 'drive_link' | 'form_response';

export interface WorkSubmissionInput {
  /** What was worked on. The default mode, and the only one that can stand alone. */
  typed?: string;
  /** What is finished. */
  finished?: string;
  /** What is blocked. Stored in the blockers column the reviewer screens already read. */
  blocked?: string;
  /** Hours against tasks, in the person's own words. */
  hours?: string;
  driveUrl?: string;
  sharingAck?: boolean;
  formUrl?: string;
}

export interface WorkSubmissionCheck {
  ok: boolean;
  /** The one sentence to show when it is not ok. Empty when ok. */
  problem: string;
  sources: WorkSourceKind[];
  typed: string;
  finished: string;
  blocked: string;
  hours: string;
  driveUrl: string;
  driveWarning: string;
  formUrl: string;
  formService: FormService | null;
  formServiceName: string;
  /** Notes and warnings that do NOT refuse the submission but must be shown. */
  notes: string[];
  /** What goes into work_done: readable on its own, without opening a link. */
  composed: string;
}

const emptySubmission: WorkSubmissionCheck = {
  ok: false, problem: '', sources: [], typed: '', finished: '', blocked: '', hours: '',
  driveUrl: '', driveWarning: '', formUrl: '', formService: null, formServiceName: '',
  notes: [], composed: '',
};

/** Is the whole typed text one of the words that means nothing? */
function isEmptyPhrase(t: string): boolean {
  const flat = t.toLowerCase().replace(/[.!\s-]+/g, ' ').trim();
  return EMPTY_PHRASES.includes(flat);
}

/**
 * Fold the typed answers into ONE readable block for work_done.
 *
 * The reviewer screens that already exist render work_done and nothing else, so anything left only
 * in a side column would be invisible to them. Blockers are deliberately NOT folded in — they have
 * their own column, which those same screens already read separately.
 */
function composeWorkText(typed: string, finished: string, hours: string): string {
  const parts: string[] = [];
  if (typed) parts.push(typed);
  if (finished) parts.push('Finished: ' + finished);
  if (hours) parts.push('Hours against tasks: ' + hours);
  return parts.join('\n\n');
}

/**
 * VALIDATE A CLOCK-OUT SUBMISSION. Pure: no database, no clock, no session.
 *
 * The rules, each one the founder's and each one stated in the sentence it produces:
 *   - at least one of the three ways must be present;
 *   - a link ALONE is accepted only with a one-line summary typed here;
 *   - typed alone must be complete enough to stand alone;
 *   - a form link must be recognisable as one, and the service is named back.
 *
 * The Drive sharing warning is returned on SUCCESS, every time, never suppressed — it is the one
 * failure the submitter cannot detect themselves, because their own link always opens for them.
 */
export function checkWorkSubmission(input: WorkSubmissionInput): WorkSubmissionCheck {
  const typed = text(input?.typed, WORK_TEXT_CAP);
  const finished = text(input?.finished, SHORT_TEXT_CAP);
  const blocked = text(input?.blocked, SHORT_TEXT_CAP);
  const hours = text(input?.hours, SHORT_TEXT_CAP);
  const driveRaw = text(input?.driveUrl, URL_CAP);
  const formRaw = text(input?.formUrl, URL_CAP);

  const notes: string[] = [];
  const sources: WorkSourceKind[] = [];

  let driveUrl = '';
  let driveWarning = '';
  if (driveRaw) {
    const link = checkDriveLink(driveRaw);
    if (!link.ok) {
      return { ...emptySubmission, typed, finished, blocked, hours, problem: link.problem };
    }
    driveUrl = link.url;
    driveWarning = link.warning || SHARING_WARNING;
    for (const n of link.notes) notes.push(n);
    if (input?.sharingAck !== true) {
      notes.push('You have not confirmed that this Drive link is shared as "Anyone with the link". It is stored either way, and if it is left restricted your reviewer sees an access-denied page and cannot tell that apart from a report you never filed.');
    }
    sources.push('drive_link');
  }

  let formUrl = '';
  let formService: FormService | null = null;
  let formServiceName = '';
  if (formRaw) {
    const form = checkFormResponseLink(formRaw);
    if (!form.ok) {
      return { ...emptySubmission, typed, finished, blocked, hours, driveUrl, driveWarning, problem: form.problem };
    }
    formUrl = form.url;
    formService = form.service;
    formServiceName = form.serviceName;
    for (const n of form.notes) notes.push(n);
    sources.push('form_response');
  }

  const hasLink = !!driveUrl || !!formUrl;
  const typedCounts = typed.length > 0 && !isEmptyPhrase(typed);

  if (typed && !typedCounts) {
    return {
      ...emptySubmission, typed, finished, blocked, hours, driveUrl, driveWarning, formUrl,
      formService, formServiceName,
      problem: 'One word is not a record of a day. Write what you actually worked on - a reviewer '
        + 'reading this in three months, or a university reading a completion letter built on it, '
        + 'has nothing else to go on.',
    };
  }

  if (!typedCounts && !hasLink) {
    return {
      ...emptySubmission, typed, finished, blocked, hours,
      problem: 'Record what you did before you clock out: type it here, paste a Drive link, or paste '
        + 'a form-response link. At least one of the three.',
    };
  }

  if (!typedCounts && hasLink) {
    return {
      ...emptySubmission, typed, finished, blocked, hours, driveUrl, driveWarning, formUrl,
      formService, formServiceName,
      problem: 'A link on its own is not enough. Write one line here saying what it contains, so the '
        + 'week can be read without opening twelve tabs.',
    };
  }

  const floor = hasLink ? SUMMARY_MIN_CHARS : STANDALONE_MIN_CHARS;
  if (typed.length < floor) {
    return {
      ...emptySubmission, typed, finished, blocked, hours, driveUrl, driveWarning, formUrl,
      formService, formServiceName,
      problem: hasLink
        ? 'Write one full line about what the link contains.'
        : 'This is the whole record of your day, so it needs to stand on its own. Say what you worked '
          + 'on, what is finished and what is blocked.',
    };
  }

  sources.unshift('typed');

  return {
    ok: true, problem: '', sources, typed, finished, blocked, hours,
    driveUrl, driveWarning, formUrl, formService, formServiceName, notes,
    composed: composeWorkText(typed, finished, hours),
  };
}

// -------------------------------------------------------------------------------------------------
// THE SECOND FACTOR — SERVER SIDE, AND IT NEVER REFUSES A CLOCK-OUT
// -------------------------------------------------------------------------------------------------

/** How the person offered to prove who they are. 'none' is the honest declined path. */
export type IdentityAttempt =
  | { method: 'face'; descriptor: unknown }
  | { method: 'code'; code: string }
  | { method: 'none'; reason: string };

export interface ClockOutIdentity {
  /** Written beside the punch by punch(). Contains no descriptor, no distance, no image. */
  verification: PunchVerification;
  passed: boolean;
  /** Derived, never stored. True when somebody should glance at this - never "reject this". */
  needsLook: boolean;
  /** The person's own words about why they could not complete the check. */
  declinedReason: string | null;
  /** A sentence for the person, phrased so it accuses nobody. */
  line: string;
}

const passVerification = (outcome: VerifyOutcome, method: 'face' | 'code'): PunchVerification => ({
  verified: true, method, outcome, at: new Date().toISOString(),
});

const failVerification = (outcome: VerifyOutcome, method: 'face' | 'code' | 'none'): PunchVerification => ({
  verified: false, method, outcome, at: new Date().toISOString(),
});

/**
 * Which second factors this account could actually complete right now, and whether it can complete
 * any at all. Read-only, and it never blocks anything: a person with nothing enrolled sees the
 * "I cannot complete this check" path from the start instead of a control that would do nothing.
 *
 * Fails closed to "nothing available", which renders as the honest escape route rather than as an
 * accusation, and never as a locked door.
 */
export async function clockOutFactors(userId: string): Promise<{
  face: boolean; code: boolean; recovery: boolean; any: boolean;
}> {
  const none = { face: false, code: false, recovery: false, any: false };
  if (!userId) return none;
  try {
    const methods = await availableSecondFactors(userId);
    const recovery = await hasRecoveryCodesLeft(userId);
    const face = methods.includes('face');
    const code = methods.includes('totp') || recovery;
    return { face, code, recovery, any: face || code };
  } catch (e: any) {
    logFail('clockOutFactors', e);
    return none;
  }
}

/**
 * RUN THE CHECK. It returns an OUTCOME. It never returns a refusal, because there is nothing here
 * that is entitled to refuse somebody the record of having finished work.
 *
 * The browser sends a descriptor or a code and NOTHING about the result — no distance, no score, no
 * matched flag. The comparison happens here, through src/lib/auth/two-factor.ts, against an enrolled
 * descriptor that is never handed back out. A caller that posted { passed: true } would find no code
 * path that reads it.
 *
 * NOTHING IS SWALLOWED INTO A FALSE. A thrown database error becomes 'unavailable' WITH the real
 * reason on the server log — "our server had a bad minute" and "that is not your face" are different
 * sentences and only one of them is about the person.
 */
export async function verifyClockOutIdentity(
  userId: string,
  attempt: IdentityAttempt,
): Promise<ClockOutIdentity> {
  const decided = (verification: PunchVerification, reason: string | null): ClockOutIdentity => ({
    verification,
    passed: verification.verified === true,
    needsLook: needsHumanLook(verification.outcome),
    declinedReason: reason,
    line: identityLine(verification.outcome),
  });

  if (!userId) {
    return decided(failVerification('unavailable', 'none'), null);
  }

  if (!attempt || attempt.method === 'none') {
    const reason = attempt && attempt.method === 'none' ? text(attempt.reason, SHORT_TEXT_CAP) : '';
    return decided(failVerification('declined', 'none'), reason || null);
  }

  // The ceiling is PEEKED, not spent, so simply arriving on the screen costs nothing. Passing it
  // does not lock anybody out of anything: it stops us asking, and the clock-out still happens.
  try {
    const spent = await peekAttempts(identityBucket(userId), IDENTITY_WINDOW_SECONDS);
    if (spent > MAX_IDENTITY_ATTEMPTS) {
      return decided(failVerification('too_many_attempts', attempt.method === 'face' ? 'face' : 'code'), null);
    }
  } catch (e: any) {
    // A counter we cannot read must not decide anything here. Logged, and the real check proceeds.
    logFail('verifyClockOutIdentity.peek', e);
  }

  if (attempt.method === 'face') {
    try {
      const factors = await availableSecondFactors(userId);
      if (!factors.includes('face')) {
        return decided(failVerification('not_enrolled', 'face'), null);
      }
      const result = await verifyFaceSecondFactor(userId, attempt.descriptor);
      if (result.matched) {
        await clearAttempts(identityBucket(userId)).catch(() => {});
        return decided(passVerification('match', 'face'), null);
      }
      // The distance goes to the server log and no further. Returning it would let a caller
      // hill-climb toward the enrolled template one probe at a time.
      console.warn(
        '[attendance-clock-out] clock-out face did not match for user', userId,
        'distance=' + (Number.isFinite(result.distance) ? result.distance.toFixed(3) : 'n/a'),
      );
      await countAttempt(identityBucket(userId), IDENTITY_WINDOW_SECONDS).catch(() => {});
      return decided(failVerification('no_match', 'face'), null);
    } catch (e: any) {
      logFail('verifyClockOutIdentity.face', e);
      return decided(failVerification('unavailable', 'face'), null);
    }
  }

  const code = text(attempt.code, 64);
  if (!code) {
    return decided(failVerification('no_capture', 'code'), null);
  }
  try {
    // verifyLoginCode covers BOTH a live authenticator code and a one-time recovery code, which is
    // why a lost phone is not a locked door.
    const passed = await verifyLoginCode(userId, code);
    if (passed) {
      await clearAttempts(identityBucket(userId)).catch(() => {});
      return decided(passVerification('code_match', 'code'), null);
    }
    await countAttempt(identityBucket(userId), IDENTITY_WINDOW_SECONDS).catch(() => {});
    return decided(failVerification('code_no_match', 'code'), null);
  } catch (e: any) {
    logFail('verifyClockOutIdentity.code', e);
    return decided(failVerification('unavailable', 'code'), null);
  }
}

/** A sentence for the person, at the moment they clock out. None of these accuses anybody. */
export function identityLine(outcome: string | null | undefined): string {
  if (outcome === 'match') {
    return 'Identity confirmed by face. No photo was taken or kept - only a mathematical signature was compared, and it has been discarded.';
  }
  if (outcome === 'code_match') {
    return 'Identity confirmed by your code.';
  }
  if (outcome === 'no_match') {
    return 'You are clocked out. The face check did not match the face on your account, so the clock-out is marked for someone to look at. Nothing is deducted and nothing is decided by this - lighting, a camera angle or an out-of-date enrolment all cause it.';
  }
  if (outcome === 'code_no_match') {
    return 'You are clocked out. The code did not match, so the clock-out is marked for someone to look at. Nothing is deducted and nothing is decided by this.';
  }
  if (outcome === 'not_enrolled') {
    return 'You are clocked out. There is no face enrolled on your account to compare against, so there was nothing to check. That is not a problem and nothing is marked against you.';
  }
  if (outcome === 'no_capture') {
    return 'You are clocked out, without an identity check, because none was given. Your work record is filed and nothing is marked against you.';
  }
  if (outcome === 'declined') {
    return 'You are clocked out. You told us you could not complete the identity check, and your reason is kept with it for a person to read. Nothing is deducted and nothing is decided automatically.';
  }
  if (outcome === 'too_many_attempts') {
    return 'You are clocked out. There have been several failed identity checks on this account in the last few minutes, so we stopped asking rather than keep you here. It is marked for a person to look at.';
  }
  if (outcome === 'unavailable') {
    return 'You are clocked out. We could not run the identity check just now - that is our side, not yours, and nothing is marked against you.';
  }
  return 'You are clocked out.';
}

/** A short label for a list. Reuses the punch vocabulary so one word does not mean two things. */
export function identityBadge(outcome: string | null | undefined): string {
  if (outcome === 'code_match') return 'Identity confirmed by code';
  if (outcome === 'code_no_match') return 'Code did not match';
  if (outcome === 'declined') return 'Identity check not completed';
  if (outcome === 'too_many_attempts') return 'Identity check stopped';
  return verificationBadge(outcome);
}

// -------------------------------------------------------------------------------------------------
// THE WRITE
// -------------------------------------------------------------------------------------------------

export interface CompleteClockOutInput {
  employeeId: string;
  userId: string | null;
  submission: WorkSubmissionInput;
  attempt: IdentityAttempt;
  /** Evidence the punch already accepts. None of it can refuse anything. */
  lat?: number | null;
  lon?: number | null;
  accuracy?: number | null;
  qrCode?: string | null;
  workMode?: string | null;
  ipAddress?: string | null;
  deviceInfo?: string | null;
}

export interface CompleteClockOutResult {
  ok: boolean;
  /** The database's own words when something failed. Never a rewritten reassurance. */
  error: string;
  /** True when the work record was written. */
  reportSaved: boolean;
  reportId: string | null;
  revision: number;
  /** True when the clock-out punch itself was written. */
  clockedOut: boolean;
  outcome: VerifyOutcome | null;
  identityPassed: boolean;
  needsLook: boolean;
  /** Sentences for the person: the identity line first, then anything advisory. */
  identityLine: string;
  advisory: string | null;
  notes: string[];
  dateIso: string;
}

const failResult = (error: string): CompleteClockOutResult => ({
  ok: false, error, reportSaved: false, reportId: null, revision: 0, clockedOut: false,
  outcome: null, identityPassed: false, needsLook: false, identityLine: '', advisory: null,
  notes: [], dateIso: '',
});

/**
 * WRITE A CLOCK-OUT, AND ONLY AFTER BOTH THINGS HAVE HAPPENED.
 *
 * Order, and every step of it is deliberate:
 *   1. Resolve the day FROM POSTGRES. A serverless region in another timezone must not decide which
 *      day somebody's work belongs to.
 *   2. Re-check that a clock-out is even possible for this day. A rendered button is not an
 *      authorisation; punch() re-checks the same rule again on the value that arrives.
 *   3. Validate the submission with the SAME pure function the form used. An invalid submission
 *      writes NOTHING - no report, no punch - and the screen keeps what was typed.
 *   4. Run the identity check. It CANNOT refuse. It produces a label.
 *   5. Write the work record. If this fails the clock-out is NOT written and the failure is
 *      returned in the database's own words: a clock-out with no record of the work is exactly the
 *      state this gate exists to prevent, and a silent half-write is worse than a refused submit.
 *   6. Write the punch, carrying the identity outcome beside it.
 *   7. Record the attempt, audit it, tell the reviewer. All three AFTER the punch is committed, and
 *      none of them may take the clock-out down - it has happened by now, and saying otherwise
 *      would make somebody clock out twice.
 *
 * IDEMPOTENT ENOUGH TO PRESS TWICE: the report is an upsert on (employee_id, report_date), and a
 * second clock-out for a day that already has one is refused by punchRefusal() with a sentence.
 */
export async function completeClockOut(input: CompleteClockOutInput): Promise<CompleteClockOutResult> {
  const employeeId = String(input?.employeeId || '');
  const userId = isUuid(input?.userId) ? String(input.userId) : null;

  if (!isUuid(employeeId)) return failResult('We could not tell whose clock-out this is.');

  const dateIso = await attendanceToday();
  if (!isDateIso(dateIso)) {
    return failResult(
      'We could not read today\'s date from the database, so we will not guess which day this '
      + 'clock-out belongs to. Nothing has been recorded and nothing is lost - try again in a moment.',
    );
  }

  // Step 2. Told before anything is written, so a stale tab does not file a report for a day it
  // cannot clock out of.
  try {
    const before = computeDay(await punchesOn(employeeId, dateIso));
    const refusal = punchRefusal('clock_out', before);
    if (refusal) return { ...failResult(refusal), dateIso };
  } catch (e: any) {
    logFail('completeClockOut.precheck', e);
    return { ...failResult(errText(e, 'We could not read your day, so nothing has been recorded.')), dateIso };
  }

  // Step 3.
  const check = checkWorkSubmission(input?.submission || {});
  if (!check.ok) return { ...failResult(check.problem), dateIso };

  // Step 4. No branch below is allowed to read `identity.passed` and skip the punch.
  const identity = await verifyClockOutIdentity(String(userId || ''), input?.attempt || { method: 'none', reason: '' });

  // Step 5.
  let reportId: string | null = null;
  let revision = 0;
  try {
    await ensureClockOutSchema();
    const sourceWord = check.sources.join('+');
    // report_url keeps the Drive link when there is one; a form response has its own column, so
    // neither overwrites the other and an existing reader of report_url still sees a Drive link.
    const primaryUrl = check.driveUrl || null;

    let written: any[] = [];
    await db.transaction(async (tx: any) => {
      // The snapshot copies what the row ACTUALLY holds at this instant, under a row lock, so two
      // submits cannot both snapshot the same revision and lose the text in between. Same discipline
      // as submitReport() in src/lib/daily-report.ts, against the same trail table.
      await tx.execute(sql`
        INSERT INTO hr_daily_report_revisions
          (report_id, employee_id, report_date, revision, report_url, work_done, blockers, replaced_by_user_id)
        SELECT r.id, r.employee_id, r.report_date, COALESCE(r.revision_count, 0),
               r.report_url, r.work_done, r.blockers, ${userId}::uuid
          FROM hr_daily_reports r
         WHERE r.employee_id = ${employeeId}::uuid AND r.report_date = ${dateIso}::date
         FOR UPDATE`);

      written = rows(await tx.execute(sql`
        INSERT INTO hr_daily_reports
          (employee_id, report_date, work_done, progress, blockers, report_url, sharing_ack,
           revision_count, submitted_by_user_id, work_source, form_response_url, form_service,
           filed_at_clock_out, updated_at)
        VALUES
          (${employeeId}::uuid, ${dateIso}::date, ${check.composed}, ${check.finished || null},
           ${check.blocked || null}, ${primaryUrl}, ${input?.submission?.sharingAck === true},
           0, ${userId}::uuid, ${sourceWord}, ${check.formUrl || null}, ${check.formService},
           TRUE, NOW())
        ON CONFLICT (employee_id, report_date) DO UPDATE
          SET work_done            = EXCLUDED.work_done,
              progress             = EXCLUDED.progress,
              blockers             = EXCLUDED.blockers,
              report_url           = COALESCE(EXCLUDED.report_url, hr_daily_reports.report_url),
              sharing_ack          = EXCLUDED.sharing_ack,
              revision_count       = hr_daily_reports.revision_count + 1,
              last_revised_at      = NOW(),
              submitted_by_user_id = EXCLUDED.submitted_by_user_id,
              work_source          = EXCLUDED.work_source,
              form_response_url    = COALESCE(EXCLUDED.form_response_url, hr_daily_reports.form_response_url),
              form_service         = COALESCE(EXCLUDED.form_service, hr_daily_reports.form_service),
              filed_at_clock_out   = TRUE,
              updated_at           = NOW()
        RETURNING id, revision_count`));
    });

    reportId = written.length && written[0]?.id ? String(written[0].id) : null;
    revision = written.length && written[0]?.revision_count != null ? Number(written[0].revision_count) || 0 : 0;
  } catch (e: any) {
    // NEVER SWALLOWED, AND THE CLOCK-OUT IS NOT WRITTEN EITHER. The person keeps what they typed and
    // is told the real reason.
    logFail('completeClockOut.report', e);
    return {
      ...failResult(errText(e, 'Your work record could not be saved, so you have NOT been clocked out. Nothing you typed is lost - press the button again.')),
      dateIso,
    };
  }

  // Step 6.
  const punched = await punch(employeeId, 'clock_out', {
    lat: input?.lat ?? null,
    lon: input?.lon ?? null,
    accuracy: input?.accuracy ?? null,
    qrCode: input?.qrCode ?? null,
    workMode: input?.workMode || 'remote',
    ipAddress: input?.ipAddress || null,
    deviceInfo: input?.deviceInfo || null,
    note: 'Clock-out with work submitted (' + check.sources.join('+') + '); identity check: ' + identity.verification.outcome,
    verification: identity.verification,
  });

  // Step 7. The attempt is recorded whether the punch landed or not, because a failed clock-out that
  // ran an identity check is exactly the thing somebody will need to reconstruct later.
  await recordIdentityCheck({
    employeeId, userId, dateIso, identity,
    workSource: check.sources.join('+'),
    reportId,
    clockOutWritten: punched.ok === true,
  });

  if (!punched.ok) {
    return {
      ok: false,
      error: (punched.error || 'The clock-out could not be recorded.')
        + ' Your work record for today IS saved, so pressing the button again will not lose it.',
      reportSaved: true, reportId, revision, clockedOut: false,
      outcome: identity.verification.outcome, identityPassed: identity.passed,
      needsLook: identity.needsLook, identityLine: identity.line, advisory: null,
      notes: check.notes, dateIso,
    };
  }

  try {
    await logAudit({
      userId,
      action: 'attendance.clock_out',
      entity: 'hr_clock_events',
      entityId: reportId || undefined,
      // The shape of the evidence, never the text of somebody's day.
      diff: {
        date: dateIso,
        workSource: check.sources.join('+'),
        identityOutcome: identity.verification.outcome,
        identityPassed: identity.passed,
        reportRevision: revision,
      },
    });
  } catch (e: any) {
    logFail('completeClockOut.audit', e);
  }

  try {
    await notifyReviewerOfSubmission(employeeId, dateIso, revision > 0);
  } catch (e: any) {
    logFail('completeClockOut.notify', e);
  }

  return {
    ok: true, error: '', reportSaved: true, reportId, revision, clockedOut: true,
    outcome: identity.verification.outcome, identityPassed: identity.passed,
    needsLook: identity.needsLook, identityLine: identity.line,
    advisory: punched.advisory || null, notes: check.notes, dateIso,
  };
}

/**
 * Keep the attempt. EVIDENCE STORED WITH THE DECISION: an identity check read six months from now
 * must still be able to say what it was, by what method, and what the person said if they could not
 * complete it.
 *
 * Non-fatal by design and logged when it fails: this runs AFTER the clock-out is committed, and
 * telling somebody their clock-out failed because a note about it did not save would make them
 * clock out twice.
 */
async function recordIdentityCheck(args: {
  employeeId: string;
  userId: string | null;
  dateIso: string;
  identity: ClockOutIdentity;
  workSource: string;
  reportId: string | null;
  clockOutWritten: boolean;
}): Promise<void> {
  try {
    await ensureClockOutSchema();
    await db.execute(sql`
      INSERT INTO hr_clock_out_checks
        (employee_id, user_id, work_date, method, outcome, passed, declined_reason,
         work_source, report_id, clock_out_written)
      VALUES
        (${args.employeeId}::uuid, ${args.userId}::uuid, ${args.dateIso}::date,
         ${String(args.identity.verification.method)}, ${String(args.identity.verification.outcome)},
         ${args.identity.passed === true}, ${args.identity.declinedReason},
         ${args.workSource}, ${args.reportId}::uuid, ${args.clockOutWritten})`);
  } catch (e: any) {
    logFail('recordIdentityCheck', e);
  }
}

/**
 * Tell the reviewer a report arrived, through the ONE notifier this project has (src/lib/push.ts)
 * and only to the person the organization graph names. Silent when the graph names nobody: picking
 * somebody would be a guess about who may read another person's day.
 *
 * The tag matches the one daily-report.ts uses, so a report filed here and one filed there collapse
 * into a single notification rather than arriving twice.
 */
async function notifyReviewerOfSubmission(employeeId: string, dateIso: string, wasRevision: boolean): Promise<void> {
  const resolved = await reviewerFor(employeeId);
  const to = resolved.person?.userId;
  if (!to) return;

  let name = 'A team member';
  try {
    const r = rows(await db.execute(sql`
      SELECT full_name FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (r.length && r[0]?.full_name) name = String(r[0].full_name);
  } catch (e: any) {
    logFail('notifyReviewerOfSubmission.name', e);
  }

  await sendPushToUser(to, {
    type: 'daily_report_filed',
    title: wasRevision ? 'Daily report revised at clock-out' : 'Daily report filed at clock-out',
    body: name + ' - ' + dateIso,
    url: '/portal/employee/reports/team?d=' + dateIso,
    tag: 'daily-report-' + employeeId + '-' + dateIso,
  });
}

// -------------------------------------------------------------------------------------------------
// READING IT BACK
// -------------------------------------------------------------------------------------------------

export interface ClockOutCheckRow {
  id: string;
  employeeId: string;
  dateIso: string;
  checkedAt: string | null;
  method: string;
  outcome: string;
  passed: boolean;
  declinedReason: string | null;
  workSource: string | null;
  clockOutWritten: boolean;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** DERIVED when somebody looks, never stored. */
  needsLook: boolean;
}

function mapCheck(row: any): ClockOutCheckRow {
  const outcome = row?.outcome ? String(row.outcome) : '';
  return {
    id: String(row?.id ?? ''),
    employeeId: String(row?.employee_id ?? ''),
    dateIso: row?.work_date ? String(row.work_date).slice(0, 10) : '',
    checkedAt: isoAt(row?.checked_at),
    method: row?.method ? String(row.method) : 'none',
    outcome,
    passed: row?.passed === true,
    declinedReason: row?.declined_reason ? String(row.declined_reason) : null,
    workSource: row?.work_source ? String(row.work_source) : null,
    clockOutWritten: row?.clock_out_written === true,
    reviewedAt: isoAt(row?.reviewed_at),
    reviewNote: row?.review_note ? String(row.review_note) : null,
    // DERIVED HERE, EVERY TIME, from the one function that decides it. A second opinion written
    // beside this line is how two screens start disagreeing about the same row.
    needsLook: needsHumanLook(outcome),
  };
}

const CHECK_COLS = sql`id, employee_id::text AS employee_id, work_date, checked_at, method, outcome,
  passed, declined_reason, work_source, clock_out_written, reviewed_at, review_note`;

/** One person's identity checks over a range. Pure read; fails closed to an empty list. */
export async function clockOutChecksFor(
  employeeId: string,
  from: string,
  to: string,
): Promise<ClockOutCheckRow[]> {
  if (!isUuid(employeeId) || !isDateIso(from) || !isDateIso(to) || to < from) return [];
  try {
    await ensureClockOutSchema();
    const r = await db.execute(sql`
      SELECT ${CHECK_COLS} FROM hr_clock_out_checks
       WHERE employee_id = ${employeeId}::uuid
         AND work_date >= ${from}::date
         AND work_date <= ${to}::date
       ORDER BY checked_at DESC
       LIMIT 200`);
    return rows(r).map(mapCheck);
  } catch (e: any) {
    logFail('clockOutChecksFor', e);
    return [];
  }
}

/** The most recent check for one person on one day, or null. */
export async function latestClockOutCheck(employeeId: string, dateIso: string): Promise<ClockOutCheckRow | null> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return null;
  try {
    await ensureClockOutSchema();
    const r = await db.execute(sql`
      SELECT ${CHECK_COLS} FROM hr_clock_out_checks
       WHERE employee_id = ${employeeId}::uuid AND work_date = ${dateIso}::date
       ORDER BY checked_at DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapCheck(list[0]) : null;
  } catch (e: any) {
    logFail('latestClockOutCheck', e);
    return null;
  }
}

/**
 * Clock-outs whose identity check did not pass and that no human has looked at yet.
 *
 * FOR A PERSON TO READ, and that is all it is for. Nothing in this module consumes this list, and
 * nothing is deducted, flagged on a record or decided by appearing in it. The filter is on the
 * OUTCOME that was measured; "worth a look" is still derived here rather than stored, so no screen
 * can start filtering on a verdict column that does not exist.
 */
export async function unreviewedClockOutChecks(limit = 50): Promise<ClockOutCheckRow[]> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
  try {
    await ensureClockOutSchema();
    const r = await db.execute(sql`
      SELECT ${CHECK_COLS} FROM hr_clock_out_checks
       WHERE passed = FALSE
         AND reviewed_at IS NULL
         AND outcome IN ('no_match', 'code_no_match', 'declined', 'too_many_attempts')
       ORDER BY checked_at DESC
       LIMIT ${cap}`);
    return rows(r).map(mapCheck);
  } catch (e: any) {
    logFail('unreviewedClockOutChecks', e);
    return [];
  }
}
