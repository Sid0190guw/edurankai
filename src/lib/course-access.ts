// src/lib/course-access.ts — MAY THIS PERSON OPEN THIS THING, AND IF NOT, WHY.
//
// =================================================================================================
// ONE FUNCTION, AND WHY IT HAS TO BE ONE
// =================================================================================================
//
// Access to a course is decided by EIGHT facts at once: identity, enrolment, payment, waiver, course
// policy, cohort, content policy and time validity. Before this module they were decided in at least
// five places, each looking at a different subset:
//
//   /portal/courses/[slug].astro    access_type only, then auto-enrols the reader on page load.
//   /aquintutor/... learn pages     enrolment row only.
//   course-sessions.courseEntitlement  enrolment + payment + waiver receipt (for a session LINK).
//   course-payments.courseAccess    the kernel path: latest payment status, different key space.
//   nothing at all                  time validity, cohort start, preview, prerequisites, suspension.
//
// Five subsets means five different answers to the same question, and the ones that were missing
// were missing everywhere: nothing in this repository could express "your access ran out on the 3rd"
// or "this is waiting on your fee waiver", so a learner who could not open a course was shown a
// redirect. A learner blocked without a reason files a support ticket. A learner told the reason
// acts on it.
//
// decideAccess() below is PURE and holds the whole rule. courseAccess() gathers the facts and calls
// it. Every surface asks courseAccess() and prints decision.message; no surface re-derives anything.
//
// =================================================================================================
// PREVIEW IS INSIDE THE DECISION, NOT BESIDE IT — section 10
// =================================================================================================
//
// `training_lessons.preview_allowed` has existed since the authoring library was written and had NO
// READER anywhere in this repository: /api/aquintutor/lessons/[id]/meta writes it and nothing has
// ever asked it a question. This module is its first reader, and it reads it at step 4 of the ONE
// decision — never as a separate "is this previewable" branch a caller could reach on its own. A
// preview flag that authorized on its own path would be a second authorization system, and the
// second one is always the one that forgets the suspension check.
//
// =================================================================================================
// EXPIRY RESTRICTS. IT NEVER DELETES.
// =================================================================================================
//
// Every decision carries `retained`, and it is filled in whether the answer is yes or no. Somebody
// whose access lapsed still finished what they finished and still holds the certificate the ledger
// issued. Nothing in this module writes progress, writes completed_at, or touches a certificate:
// src/lib/learning-progress.ts is the single writer of completion and src/lib/certificates.ts owns
// the ledger. This module writes exactly two things — an enrolment's STATE and its access WINDOW —
// and it records every attempt to change the first, including the ones it refuses.
//
// =================================================================================================
// WHAT IT DEPENDS ON RATHER THAN DUPLICATES
// =================================================================================================
//
//   src/lib/course-pricing.ts   is the ONLY definition of what a course costs and who is in its
//                               audience. priceForUser() decides free/paid here; a second reading of
//                               those columns would be a second price.
//   src/lib/learning-object.ts  supplies the typed objects and their preview facet.
//   src/lib/workflow.ts         is the ONLY approval engine. This module starts nothing and approves
//                               nothing; it READS the instance state and applies the transition that
//                               the decision implies. There is no approve button here.
//   src/lib/org-graph.ts        would be the only source of a relationship, if this module needed
//                               one. It does not: entitlement to a course is not a reporting line.
//
// EduRankAI is the technology platform; accredited partners award credentials. No message below
// claims a qualification, names a provider, or frames the course around its price.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import {
  pricingFromRow, priceForUser, audienceAllows, accessTypeOf,
  type AccessType, type PricedUser,
} from '@/lib/course-pricing';
import { lessonObjects, isOpenToAnyone, type LearningObject } from '@/lib/learning-object';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND HELPERS — declared ABOVE everything that reads them. `const` is not hoisted, and a
// handler reaching a later declaration throws on its own first line while the page reports success.
// -------------------------------------------------------------------------------------------------

const MOD = 'course-access';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[' + MOD + '] ' + tag, causeOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const isMissingTable = (e: any): boolean =>
  String(e?.cause?.code || '') === '42P01' || /relation .* does not exist/i.test(causeOf(e));

const DAY_MS = 86400000;
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** The capabilities that let somebody open a course they are not enrolled on. All pre-existing. */
export const STAFF_ACCESS_KEYS = [
  'lessons.author',
  'lessons.publish',
  'learning.progress.view',
  'learning.enrolment.manage',
];

/** The key that changes an enrolment's state by hand. */
export const ENROLMENT_MANAGE_KEY = 'learning.enrolment.manage';

const iso = (v: any): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const ms = (v: any): number | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
};
const clip = (v: unknown, n: number): string =>
  (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const day = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString().slice(0, 10));

// =================================================================================================
// SECTION 31 — THE ENROLMENT STATES, AND THE TRANSITIONS BETWEEN THEM
// =================================================================================================
//
// BEFORE THIS, `training_enrollments` HAD NO STATE COLUMN AT ALL. Exactly two states were
// representable: the row exists ("active"), and completed_at is set ("completed"). Everything else
// was invisible — "started checkout and abandoned" was byte-identical to "never heard of this
// course", and a refunded learner kept full access because /api/admin/payments/refund refunds the
// money and touches no enrolment.
//
// The column added below is NULLABLE ON PURPOSE and there is NO BACKFILL. A NULL means "this row
// predates the state machine", and stateOf() reads it the way the old code did: completed_at set
// means completed, otherwise active. An UPDATE that stamped every existing row 'active' would have
// declared a finished learner unfinished, which is a rewrite of somebody's record dressed up as a
// migration.

export const ENROLMENT_STATES = [
  'applied',
  'pending_payment',
  'pending_approval',
  'active',
  'suspended',
  'completed',
  'expired',
  'cancelled',
  'refunded',
] as const;
export type EnrolmentState = (typeof ENROLMENT_STATES)[number];

export function isEnrolmentState(v: unknown): v is EnrolmentState {
  return typeof v === 'string' && (ENROLMENT_STATES as readonly string[]).indexOf(v) >= 0;
}

/** What a person reads. Plain sentences; the state name is for code. */
export const ENROLMENT_STATE_LABELS: Record<EnrolmentState, string> = {
  applied: 'Applied',
  pending_payment: 'Waiting on payment',
  pending_approval: 'Waiting on a decision',
  active: 'Enrolled',
  suspended: 'Paused',
  completed: 'Completed',
  expired: 'Access ended',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/**
 * THE LEGAL TRANSITIONS. An edge that is not here is REFUSED — never silently applied, and never
 * quietly turned into a different one.
 *
 * THREE OF THESE DESERVE THEIR REASONING WRITTEN DOWN:
 *
 *   completed -> expired IS LEGAL, and it is the whole point of section 30. A time-limited course
 *   whose window closes stops opening; the completion, the lesson ledger and the certificate are
 *   untouched. Access and achievement are different facts and this edge is where that shows.
 *
 *   cancelled -> active and refunded -> active ARE LEGAL, deliberately. A cancellation reversed by
 *   the desk, or a learner who pays again after a refund, must land back on the SAME row carrying
 *   the SAME progress. The alternative is a second enrolment row, and this table has no unique key
 *   to stop it becoming a third.
 *
 *   NOTHING TRANSITIONS *TO* completed HERE. Completion is decided by lessons and rules in
 *   src/lib/learning-progress.ts and src/lib/learning-admin.ts, which already disagree with each
 *   other about it (see the map). A third writer of that fact would be the joke telling itself.
 *   syncCompletionState() below only MIRRORS a completed_at that one of those two already wrote.
 */
export const LEGAL_TRANSITIONS: Record<EnrolmentState, EnrolmentState[]> = {
  applied: ['pending_payment', 'pending_approval', 'active', 'cancelled', 'expired'],
  pending_payment: ['active', 'pending_approval', 'cancelled', 'expired'],
  pending_approval: ['active', 'pending_payment', 'cancelled'],
  active: ['suspended', 'completed', 'expired', 'cancelled', 'refunded'],
  suspended: ['active', 'cancelled', 'expired', 'refunded'],
  completed: ['expired', 'refunded', 'active'],
  expired: ['active', 'cancelled'],
  cancelled: ['active'],
  refunded: ['active'],
};

/** States in which the learner may open course content, all other checks being equal. */
export const OPEN_STATES: EnrolmentState[] = ['active', 'completed'];

export interface TransitionCheck {
  ok: boolean;
  /** Empty when ok. A sentence naming what was refused and what is possible instead. */
  reason: string;
  /** True when from === to: nothing to do, and NOT an error. */
  noop: boolean;
}

/**
 * May this enrolment move from one state to the other? Pure, and the only judge of that question.
 *
 * A transition to the state it is already in is a NO-OP, not a failure: two people pressing Suspend
 * within a second of each other must not produce an error for the second one.
 */
export function canTransitionEnrolment(from: unknown, to: unknown): TransitionCheck {
  if (!isEnrolmentState(from)) {
    return { ok: false, noop: false, reason: 'This enrolment is in a state this system does not recognise, so it will not be moved.' };
  }
  if (!isEnrolmentState(to)) {
    return { ok: false, noop: false, reason: 'That is not an enrolment state.' };
  }
  if (from === to) return { ok: true, noop: true, reason: '' };
  const allowed = LEGAL_TRANSITIONS[from] || [];
  if (allowed.indexOf(to) >= 0) return { ok: true, noop: false, reason: '' };
  return {
    ok: false,
    noop: false,
    reason: 'An enrolment that is ' + ENROLMENT_STATE_LABELS[from].toLowerCase()
      + ' cannot become ' + ENROLMENT_STATE_LABELS[to].toLowerCase()
      + '. What it can become: '
      + (allowed.length ? allowed.map((s) => ENROLMENT_STATE_LABELS[s].toLowerCase()).join(', ') : 'nothing')
      + '.',
  };
}

/**
 * The state of an enrolment ROW, including one written before this module existed.
 *
 * NULL is not 'active' by assumption — it is read exactly as every existing surface reads such a
 * row: finished if completed_at is set, otherwise enrolled. That keeps this machine compatible with
 * every row already in the table without a single UPDATE.
 */
export function stateOf(row: any): EnrolmentState {
  const stored = row?.status;
  if (isEnrolmentState(stored)) return stored;
  return row?.completed_at ? 'completed' : 'active';
}

// =================================================================================================
// SECTION 30 — TIME-BASED ACCESS
// =================================================================================================

export const ACCESS_MODELS = ['lifetime', 'duration', 'dates', 'cohort', 'trial'] as const;
export type AccessModel = (typeof ACCESS_MODELS)[number];

export const ACCESS_MODEL_LABELS: Record<AccessModel, string> = {
  lifetime: 'Open for as long as the course exists',
  duration: 'Open for a fixed number of days from enrolment',
  dates: 'Open between two dates',
  cohort: 'Open for the length of the cohort',
  trial: 'A trial period, then it closes',
};

export function accessModelOf(v: unknown): AccessModel {
  return typeof v === 'string' && (ACCESS_MODELS as readonly string[]).indexOf(v) >= 0
    ? (v as AccessModel)
    : 'lifetime';
}

/** The course's own policy. Every field optional; a course that has never been configured is lifetime. */
export interface AccessPolicy {
  model: AccessModel;
  /** For 'duration' and 'trial': days from the moment of enrolment. */
  days: number | null;
  /** For 'dates' and 'cohort': the window the course itself is open. */
  startsAt: number | null;
  endsAt: number | null;
  /** Days of continued access AFTER the window closes. Never negative. */
  graceDays: number;
}

/** What this particular learner's window is, which may differ from the course default. */
export interface EnrolmentWindow {
  startsAt: number | null;
  endsAt: number | null;
  /** A trial that ends before the main window. */
  trialEndsAt: number | null;
  graceDays: number | null;
  enrolledAt: number | null;
}

export type AccessPhase = 'open_ended' | 'not_started' | 'trial' | 'within' | 'grace' | 'expired';

export interface ComputedWindow {
  model: AccessModel;
  phase: AccessPhase;
  startsAt: number | null;
  /** When access stops, before any grace. Null means it does not. */
  endsAt: number | null;
  /** When access really stops, grace included. Null means it does not. */
  closesAt: number | null;
  /** Whole days until closesAt. Null when it never closes. Negative once it has passed. */
  daysLeft: number | null;
  /** One sentence a person can read. Never empty. */
  explanation: string;
}

/**
 * WHEN THIS PERSON'S ACCESS IS OPEN. Pure, and the whole of section 30 in one function.
 *
 * The enrolment's own dates WIN over the course policy wherever they are set, which is what makes an
 * extension possible without changing the course for everybody. Grace is added at the end and never
 * moves the recorded end date: "your access ended on the 3rd, you have until the 10th" is two facts,
 * and a screen that showed only the second would be lying about the first.
 */
export function computeAccessWindow(
  policy: AccessPolicy,
  win: EnrolmentWindow,
  now: number = Date.now(),
): ComputedWindow {
  const model = accessModelOf(policy?.model);
  const graceDays = Math.max(0, Math.floor(Number(win?.graceDays ?? policy?.graceDays ?? 0) || 0));

  let startsAt: number | null = win?.startsAt ?? null;
  let endsAt: number | null = win?.endsAt ?? null;

  if (model === 'lifetime') {
    // Even a lifetime course honours an explicitly set window on ONE enrolment: that is how a single
    // suspension-with-an-end-date or a granted extension is expressed without repricing the course.
    if (startsAt === null && endsAt === null) {
      return {
        model, phase: 'open_ended', startsAt: null, endsAt: null, closesAt: null, daysLeft: null,
        explanation: 'Your access to this course does not expire.',
      };
    }
  } else if (model === 'dates' || model === 'cohort') {
    if (startsAt === null) startsAt = policy?.startsAt ?? null;
    if (endsAt === null) endsAt = policy?.endsAt ?? null;
  } else if (model === 'duration' || model === 'trial') {
    const base = startsAt ?? win?.enrolledAt ?? policy?.startsAt ?? null;
    startsAt = base;
    const days = Math.max(0, Math.floor(Number(policy?.days ?? 0) || 0));
    if (endsAt === null && base !== null && days > 0) endsAt = base + days * DAY_MS;
  }

  // A trial end never extends the main window; it can only bring it forward.
  const trialEnd = win?.trialEndsAt ?? null;
  const effectiveEnd = trialEnd !== null && (endsAt === null || trialEnd < endsAt) ? trialEnd : endsAt;
  const closesAt = effectiveEnd === null ? null : effectiveEnd + graceDays * DAY_MS;

  if (startsAt !== null && now < startsAt) {
    return {
      model, phase: 'not_started', startsAt, endsAt: effectiveEnd, closesAt,
      daysLeft: closesAt === null ? null : Math.ceil((closesAt - now) / DAY_MS),
      explanation: model === 'cohort'
        ? 'This cohort starts on ' + day(startsAt) + '. The course opens then.'
        : 'Your access to this course opens on ' + day(startsAt) + '.',
    };
  }

  if (effectiveEnd === null) {
    return {
      model, phase: 'open_ended', startsAt, endsAt: null, closesAt: null, daysLeft: null,
      explanation: 'Your access to this course does not expire.',
    };
  }

  const daysLeft = Math.ceil(((closesAt as number) - now) / DAY_MS);

  if (now > (closesAt as number)) {
    return {
      model, phase: 'expired', startsAt, endsAt: effectiveEnd, closesAt, daysLeft,
      explanation: 'Your access to this course ended on ' + day(effectiveEnd)
        + (graceDays > 0 ? ', with the extra ' + graceDays + ' days ending on ' + day(closesAt) : '')
        + '. Everything you finished is still on your record.',
    };
  }

  if (now > effectiveEnd) {
    return {
      model, phase: 'grace', startsAt, endsAt: effectiveEnd, closesAt, daysLeft,
      explanation: 'Your access ended on ' + day(effectiveEnd) + '. You have until ' + day(closesAt)
        + ' to finish.',
    };
  }

  if (trialEnd !== null && effectiveEnd === trialEnd) {
    return {
      model, phase: 'trial', startsAt, endsAt: effectiveEnd, closesAt, daysLeft,
      explanation: 'You are in the trial period for this course, which runs until ' + day(trialEnd) + '.',
    };
  }

  return {
    model, phase: 'within', startsAt, endsAt: effectiveEnd, closesAt, daysLeft,
    explanation: 'Your access to this course runs until ' + day(effectiveEnd) + '.',
  };
}

// =================================================================================================
// SECTION 29 — THE DECISION
// =================================================================================================

export const ACCESS_REASONS = [
  'ok',
  'unreadable',
  'course_not_found',
  'course_unavailable',
  'not_signed_in',
  'content_restricted',
  'not_enrolled',
  'approval_pending',
  'payment_incomplete',
  'waiver_pending',
  'prerequisite_incomplete',
  'cohort_not_started',
  'access_expired',
  'enrolment_suspended',
  'enrolment_cancelled',
  'enrolment_refunded',
] as const;
export type AccessReason = (typeof ACCESS_REASONS)[number];

/** Why access was GRANTED, when it was. A screen shows this; a log keeps it. */
export type AccessBasis =
  | 'staff' | 'preview' | 'free' | 'employee' | 'paid' | 'waived' | 'trial' | 'grace' | null;

export interface RetainedRecord {
  /** True when a completion is on the record, whatever today's access says. */
  completed: boolean;
  completedAt: string | null;
  /** The signed ledger's number, when one has been issued. Never minted here. */
  certNumber: string | null;
  /** A verification link, never an upload. */
  verificationUrl: string | null;
}

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  /** One sentence the learner reads. Never a database message, never a redirect. */
  message: string;
  /** Why it was allowed. Null when it was not. */
  basis: AccessBasis;
  /** True when the grant covers only the parts marked open. The rest stays protected. */
  previewOnly: boolean;
  /** True only when the answer was "we could not tell" — a 503, never a 403. */
  retryable: boolean;
  /** The enrolment state as it stands. Null when there is no enrolment row. */
  state: EnrolmentState | null;
  window: ComputedWindow | null;
  /** What this person keeps regardless of the answer above. Always filled in. */
  retained: RetainedRecord;
  /** What the learner can DO about it. Null when there is nothing to do. */
  next: { label: string; href: string | null } | null;
  /** For an administrator reading a diagnostics screen. Never shown to a learner. */
  detail: string;
}

export interface AccessFacts {
  now: number;
  signedIn: boolean;
  userId: string | null;
  /** Holds one of STAFF_ACCESS_KEYS. Resolved by the CALLER, never by this module. */
  isStaff: boolean;
  course: {
    id: string;
    slug: string | null;
    title: string | null;
    published: boolean;
    archived: boolean;
    accessType: AccessType;
    /** From course-pricing.priceForUser — the only definition of what this costs. */
    inAudience: boolean;
    isPaid: boolean;
    payableMinor: number;
    priceReason: string;
  } | null;
  policy: AccessPolicy;
  enrolment: { state: EnrolmentState; window: EnrolmentWindow } | null;
  settlement: {
    /** A captured, non-refunded payment against this course. */
    paid: boolean;
    /** The zero-value receipt an approved waiver writes. */
    waived: boolean;
    /** A checkout that was opened and never finished. */
    orderPending: boolean;
  };
  /** A fee-waiver request that has not been decided. */
  waiverPending: boolean;
  prerequisites: {
    /** Course ids this course requires. Empty when none are configured. */
    required: string[];
    /** Of those, the ones this learner has not completed. */
    missing: string[];
    /** Titles for the message. Same order as `missing`. */
    missingTitles: string[];
    /** False when the prerequisite read failed — the decision then does not block on it. */
    readable: boolean;
  };
  target: {
    kind: 'course' | 'lesson' | 'object';
    /** The lesson or object is marked publicly previewable. Section 10. */
    previewable: boolean;
    label: string;
  };
  retained: RetainedRecord;
  /** True when a read this decision needed did not run. Produces a 503, never a denial. */
  readFailed: boolean;
}

const M = {
  unreadable: 'We could not check your access just now, so nothing has been opened or closed. This is '
    + 'a fault on our side, not a change to your place on the course. Try again in a moment.',
  notFound: 'That course is not here.',
  unavailable: 'This course is not open at the moment. If it was assigned to you, tell whoever '
    + 'assigned it.',
  signIn: 'Please sign in to open this course.',
  restricted: 'This course is not open to your account.',
  notEnrolled: 'You are not enrolled on this course yet.',
  approval: 'Your place on this course is waiting on a decision. Nothing more is needed from you '
    + 'until somebody answers.',
  payment: 'This course has a fee, and no completed payment is recorded against your account. If you '
    + 'paid and were interrupted, open the course page — an unfinished checkout is picked up there.',
  waiver: 'Your fee-waiver request has not been decided yet. The course opens as soon as it is, and '
    + 'you do not need to pay while it is outstanding.',
  suspended: 'Your place on this course is paused. Everything you have finished is still on your '
    + 'record. Ask whoever manages the course to lift it.',
  cancelled: 'This enrolment was cancelled. Everything you finished before it was cancelled is still '
    + 'on your record.',
  refunded: 'This course was refunded, so it is no longer open. Everything you finished is still on '
    + 'your record.',
};

/**
 * THE WHOLE RULE, PURE.
 *
 * THE ORDER IS THE DESIGN, and it is checked in exactly this sequence:
 *
 *    0  a read that did not run          -> retryable, never a denial
 *    1  no such course                   -> not found
 *    2  staff                            -> allowed; an author must be able to open their own draft
 *    3  unpublished or archived          -> content restricted
 *    4  PREVIEW                          -> allowed, preview only, SIGNED IN OR NOT (section 10)
 *    5  not signed in                    -> sign in
 *    6  audience                         -> content restricted (course-pricing decides audience)
 *    7  no enrolment row                 -> not enrolled
 *    8  enrolment state                  -> the section-31 machine answers
 *    9  prerequisites                    -> prerequisite incomplete
 *   10  payment and waiver               -> payment incomplete / waiver pending
 *   11  time validity                    -> cohort not started / access expired / trial / grace
 *   12  allowed
 *
 * Step 4 sits above step 5 because a preview is PUBLIC by definition; if it required a session it
 * would not be a preview. Step 2 sits above step 3 because an author has to be able to open the
 * thing they have not published yet. Steps 9-11 sit below step 8 because "you were suspended" is a
 * more useful sentence than "you have not paid" for somebody who paid and was then suspended.
 */
export function decideAccess(f: AccessFacts): AccessDecision {
  const retained: RetainedRecord = f?.retained || {
    completed: false, completedAt: null, certNumber: null, verificationUrl: null,
  };
  const state = f?.enrolment?.state ?? null;
  const win = f?.enrolment
    ? computeAccessWindow(f.policy, f.enrolment.window, f.now)
    : null;

  const deny = (
    reason: AccessReason, message: string, detail: string,
    next: AccessDecision['next'] = null, retryable = false,
  ): AccessDecision => ({
    allowed: false, reason, message, basis: null, previewOnly: false, retryable,
    state, window: win, retained, next, detail,
  });
  const allow = (basis: AccessBasis, detail: string, previewOnly = false): AccessDecision => ({
    allowed: true, reason: 'ok', message: '', basis, previewOnly, retryable: false,
    state, window: win, retained, next: null, detail,
  });

  // 0 -------------------------------------------------------------------------------------------
  if (f?.readFailed) return deny('unreadable', M.unreadable, 'a read this decision needs did not run', null, true);

  // 1 -------------------------------------------------------------------------------------------
  const c = f?.course;
  if (!c) return deny('course_not_found', M.notFound, 'no course row');

  const courseHref = c.slug ? '/portal/courses/' + encodeURIComponent(c.slug) : null;

  // 2 -------------------------------------------------------------------------------------------
  if (f.isStaff && f.signedIn) {
    return allow('staff', 'holds one of ' + STAFF_ACCESS_KEYS.join(', '));
  }

  // 3 -------------------------------------------------------------------------------------------
  if (!c.published || c.archived) {
    return deny('course_unavailable', M.unavailable,
      c.archived ? 'course archived' : 'course not published');
  }

  // 4 -------------------------------------------------------------------------------------------
  // THE ONLY PREVIEW CHECK IN THIS CODEBASE. It cannot be reached except through this function.
  if (f.target?.previewable) {
    return allow('preview', 'target marked previewable', true);
  }

  // 5 -------------------------------------------------------------------------------------------
  if (!f.signedIn) {
    return deny('not_signed_in', M.signIn, 'no session', { label: 'Sign in', href: '/portal/login' });
  }

  // 6 -------------------------------------------------------------------------------------------
  if (!c.inAudience) {
    return deny('content_restricted', M.restricted, 'access_type ' + c.accessType);
  }

  // 7 -------------------------------------------------------------------------------------------
  if (!f.enrolment) {
    return deny('not_enrolled', M.notEnrolled, 'no enrolment row',
      { label: 'Open the course', href: courseHref });
  }

  // 8 -------------------------------------------------------------------------------------------
  const s = f.enrolment.state;
  if (s === 'cancelled') return deny('enrolment_cancelled', M.cancelled, 'state cancelled');
  if (s === 'refunded') return deny('enrolment_refunded', M.refunded, 'state refunded');
  if (s === 'suspended') return deny('enrolment_suspended', M.suspended, 'state suspended');
  if (s === 'applied' || s === 'pending_approval') {
    return deny('approval_pending', M.approval, 'state ' + s);
  }
  if (s === 'pending_payment') {
    return f.waiverPending
      ? deny('waiver_pending', M.waiver, 'state pending_payment, waiver outstanding')
      : deny('payment_incomplete', M.payment, 'state pending_payment',
          { label: 'Finish checkout', href: courseHref });
  }
  // 'expired' as a STORED state is confirmed against the clock at step 11 rather than trusted here:
  // a window that was extended after the state was written must open the course again without
  // anybody having to remember to flip the column back.

  // 9 -------------------------------------------------------------------------------------------
  const pre = f.prerequisites;
  if (pre && pre.readable && pre.missing.length > 0) {
    const names = pre.missingTitles.length ? pre.missingTitles : pre.missing;
    return deny('prerequisite_incomplete',
      'This course asks you to finish ' + names.join(', ') + ' first.',
      'missing prerequisites: ' + pre.missing.join(', '));
  }

  // 10 ------------------------------------------------------------------------------------------
  // A PAID COURSE NEEDS SETTLEMENT, AND ENROLMENT IS NOT SETTLEMENT. /portal/courses/[slug] enrols
  // every signed-in reader on page load, so "enrolled" is a fact anybody can manufacture by opening
  // a URL. course-sessions.ts reached the same conclusion for session links; the reading is the same
  // one here so the two cannot drift apart.
  let settledBasis: AccessBasis = null;
  if (!c.isPaid) settledBasis = c.payableMinor === 0 && c.isPaid === false ? 'free' : 'free';
  else if (f.settlement?.paid) settledBasis = 'paid';
  else if (f.settlement?.waived) settledBasis = 'waived';

  if (c.isPaid && settledBasis === null) {
    if (f.waiverPending) return deny('waiver_pending', M.waiver, 'paid course, waiver outstanding');
    return deny('payment_incomplete', M.payment,
      'paid course, no settlement' + (f.settlement?.orderPending ? ' (checkout open)' : ''),
      { label: f.settlement?.orderPending ? 'Finish checkout' : 'Open the course', href: courseHref });
  }
  // An employee on an employees-free course is 'free' by policy; the sentence names it so a screen
  // can say why nothing was charged.
  if (!c.isPaid && c.payableMinor === 0 && c.priceReason.indexOf('team') >= 0) settledBasis = 'employee';

  // 11 ------------------------------------------------------------------------------------------
  const w = win as ComputedWindow;
  if (w.phase === 'not_started') {
    return deny('cohort_not_started', w.explanation, 'window not started');
  }
  if (w.phase === 'expired') {
    return deny('access_expired', w.explanation, 'window expired',
      { label: 'See what you finished', href: courseHref });
  }
  if (w.phase === 'grace') return allow('grace', 'inside grace period');
  if (w.phase === 'trial') return allow('trial', 'inside trial period');

  // 12 ------------------------------------------------------------------------------------------
  return allow(settledBasis, 'state ' + s + ', window ' + w.phase);
}

// =================================================================================================
// SCHEMA — ADDITIVE ONLY, never DROP, its own ensureOnce key.
// =================================================================================================

export function ensureCourseAccessSchema(): Promise<void> {
  return ensureOnce('course-access:v1', async () => {
    const ex = async (q: any, tag: string) => {
      try { await db.execute(q); } catch (e: any) { logFail('ensure:' + tag, e); }
    };

    // THE STATE COLUMN. NULLABLE, NO DEFAULT, NO BACKFILL — see the section-31 header above.
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS status VARCHAR(20)`, 'en_status');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS status_reason TEXT`, 'en_status_reason');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ`, 'en_status_at');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS status_changed_by UUID`, 'en_status_by');
    // The per-learner window. All nullable: an unset window means the course policy decides.
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS access_starts_at TIMESTAMPTZ`, 'en_starts');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS access_ends_at TIMESTAMPTZ`, 'en_ends');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ`, 'en_trial');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS grace_days INT`, 'en_grace');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ`, 'en_enrolled_at');
    // The approval this enrolment is waiting on, when it is waiting on one. A POINTER into
    // src/lib/workflow.ts, never a second approval mechanism.
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS approval_instance_id UUID`, 'en_wf');

    // THE COURSE POLICY. Named apart from the pricing columns course-pricing.ts owns, so the two
    // modules never write the same field.
    await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS access_model VARCHAR(20)`, 'c_model');
    await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS access_days INT`, 'c_days');
    await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS access_starts_at TIMESTAMPTZ`, 'c_starts');
    await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS access_ends_at TIMESTAMPTZ`, 'c_ends');
    await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS access_grace_days INT`, 'c_grace');
    // Machine-readable prerequisites. The existing `prerequisites` column is FREE PROSE written for a
    // human and is never parsed here — reading a sentence and deciding somebody may not open a course
    // is how a course becomes unreachable for a comma.
    await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS prereq_course_ids JSONB DEFAULT '[]'::jsonb`, 'c_prereq');

    // EVERY TRANSITION, INCLUDING THE REFUSED ONES.
    //
    // A refused transition is recorded with outcome 'refused'. Somebody tried to reinstate a
    // cancelled enrolment, or to suspend one that was already refunded, and the fact that they tried
    // is exactly as much a part of the record as the ones that landed. A ledger that holds only what
    // succeeded cannot answer "who has been trying to do this".
    await ex(sql`CREATE TABLE IF NOT EXISTS training_enrolment_transitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      enrollment_id UUID,
      user_id UUID NOT NULL,
      course_id UUID NOT NULL,
      from_state VARCHAR(20),
      to_state VARCHAR(20) NOT NULL,
      outcome VARCHAR(10) NOT NULL DEFAULT 'applied',
      reason TEXT NOT NULL,
      refusal TEXT,
      actor_user_id UUID,
      source VARCHAR(40) NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`, 'transitions');
    await ex(sql`CREATE INDEX IF NOT EXISTS tet_user_course_idx
      ON training_enrolment_transitions(user_id, course_id, created_at DESC)`, 'transitions_idx');
  });
}

export interface AccessSchemaState {
  ok: boolean;
  /** Columns this module writes that are NOT on the live table. */
  missing: string[];
  /**
   * Whether training_enrollments carries a unique index on (course_id, user_id).
   *
   * THIS IS THE ONE ANSWER EVERYTHING ELSE HANGS ON, AND IT IS NOT KNOWN FROM THE SOURCE.
   * /api/aquintutor/confirm-payment.ts runs an INSERT ... ON CONFLICT (course_id, user_id), which
   * REQUIRES a matching unique index. Four separate modules assert in prose that no such index
   * exists. If they are right, that statement raises SQLSTATE 42P10 on every paid enrolment — AFTER
   * the payment has been marked paid. Money taken, no enrolment.
   *
   * null means the check itself could not run. It is never assumed either way.
   */
  hasUniqueEnrolmentKey: boolean | null;
  error: string | null;
}

/**
 * VERIFY AGAINST information_schema. NEVER TRUST THE ENSURE.
 *
 * src/lib/ensure-once.ts swallows a DDL failure by design so that callers keep their "tolerate
 * missing schema" behaviour. That makes its return value worth nothing as evidence, and a module
 * that wrote a state into a column which does not exist would report a suspension that never
 * happened. This is the read that answers it, and transitionEnrolment() calls it before it writes.
 */
export async function courseAccessSchemaState(): Promise<AccessSchemaState> {
  await ensureCourseAccessSchema();
  const out: AccessSchemaState = { ok: false, missing: [], hasUniqueEnrolmentKey: null, error: null };
  try {
    const cols = new Set(rowsOf(await db.execute(sql`
      SELECT table_name || '.' || column_name AS c FROM information_schema.columns
       WHERE table_name IN ('training_enrollments', 'training_courses')`)).map((r: any) => String(r.c)));
    const want = [
      'training_enrollments.status',
      'training_enrollments.status_reason',
      'training_enrollments.access_ends_at',
      'training_enrollments.trial_ends_at',
      'training_enrollments.grace_days',
      'training_courses.access_model',
      'training_courses.prereq_course_ids',
    ];
    out.missing = want.filter((c) => !cols.has(c));
    out.ok = out.missing.length === 0;
  } catch (e: any) {
    logFail('schemaState/columns', e);
    out.error = causeOf(e);
    return out;
  }
  try {
    const idx = rowsOf(await db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'training_enrollments'`));
    out.hasUniqueEnrolmentKey = idx.some((r: any) => {
      const d = String(r.indexdef || '');
      return /UNIQUE/i.test(d) && /course_id/.test(d) && /user_id/.test(d);
    });
  } catch (e: any) {
    logFail('schemaState/index', e);
    out.hasUniqueEnrolmentKey = null;
  }
  return out;
}

// =================================================================================================
// GATHERING THE FACTS
// =================================================================================================

export interface AccessRequest {
  courseId?: string | null;
  courseSlug?: string | null;
  /** When set, the decision is about THIS lesson, and its preview flag is read. */
  lessonId?: string | null;
  /** When set with lessonId, the decision is about one object inside that lesson. */
  objectRef?: string | null;
  /**
   * The caller's capability check — a can(user, key) wrapper. Passed IN so this module imports no
   * authorization engine and cannot become a second one. Exactly the shape learning-admin.ts uses.
   */
  holds?: (key: string) => boolean;
  now?: number;
}

/** Read a course's own time policy off its row. Tolerates a row that predates every column. */
export function policyFromRow(row: any): AccessPolicy {
  return {
    model: accessModelOf(row?.access_model),
    days: row?.access_days === null || row?.access_days === undefined ? null : Number(row.access_days) || null,
    startsAt: ms(row?.access_starts_at),
    endsAt: ms(row?.access_ends_at),
    graceDays: Math.max(0, Math.floor(Number(row?.access_grace_days ?? 0) || 0)),
  };
}

/** Read one learner's window off their enrolment row. */
export function windowFromRow(row: any): EnrolmentWindow {
  return {
    startsAt: ms(row?.access_starts_at),
    endsAt: ms(row?.access_ends_at),
    trialEndsAt: ms(row?.trial_ends_at),
    graceDays: row?.grace_days === null || row?.grace_days === undefined ? null : Number(row.grace_days) || 0,
    enrolledAt: ms(row?.enrolled_at) ?? ms(row?.created_at) ?? ms(row?.last_accessed_at),
  };
}

function parseIdList(v: any): string[] {
  let raw: any = v;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x)).filter(isUuid).slice(0, 20);
}

/**
 * The record-id convention for a course fee-waiver request in src/lib/workflow.ts.
 *
 * DECLARED HERE BECAUSE THIS MODULE IS THE FIRST TO ASK. The `fee_waiver` domain exists in
 * workflow.ts and src/lib/course-waiver.ts is named in permissions.ts, but that module is not in the
 * repository yet, so nothing has fixed the format. Both spellings are tried; a lookup that matches
 * neither simply finds nothing, and finding nothing NEVER grants access — it only means the learner
 * is told "no payment is recorded" instead of "your waiver is still being decided". A softer
 * sentence is the only thing at stake, which is why guessing is safe here and would not be anywhere
 * else in this file.
 */
export function waiverRecordIds(courseId: string, userId: string): string[] {
  return [courseId + ':' + userId, 'training_course:' + courseId + ':' + userId];
}

async function waiverIsPending(courseId: string, userId: string): Promise<boolean> {
  try {
    const { instanceForRecord } = await import('@/lib/workflow');
    for (const rec of waiverRecordIds(courseId, userId)) {
      const inst = await instanceForRecord('fee_waiver', rec);
      if (inst && (inst.state === 'pending' || inst.state === 'in_progress' || inst.state === 'halted')) {
        return true;
      }
    }
  } catch (e: any) {
    // A waiver engine that cannot be reached must not block a learner who has paid.
    logFail('waiverIsPending', e);
  }
  return false;
}

/**
 * Is the target of this request marked publicly previewable?
 *
 * A LESSON'S FLAG COVERS ITS OBJECTS. That is the reading `preview_allowed` was written to have —
 * "the first lesson is open, the rest is not" — and an object may narrow it or extend it through the
 * facet overlay in learning-object.ts. Whatever the answer, it is returned as a FACT and decided at
 * step 4 of decideAccess(); this function grants nothing.
 */
async function targetPreview(
  req: AccessRequest,
): Promise<{ kind: 'course' | 'lesson' | 'object'; previewable: boolean; label: string; failed: boolean }> {
  const lessonId = req?.lessonId ? String(req.lessonId) : '';
  if (!isUuid(lessonId)) return { kind: 'course', previewable: false, label: 'the course', failed: false };

  const read = await lessonObjects(lessonId);
  if (!read.ok) return { kind: 'lesson', previewable: false, label: 'this lesson', failed: true };

  const ref = req?.objectRef ? String(req.objectRef) : '';
  if (ref) {
    const obj = read.objects.find((o: LearningObject) => o.id === ref) || null;
    return {
      kind: 'object',
      previewable: !!obj && isOpenToAnyone(obj.access),
      label: obj ? obj.title : 'this item',
      failed: false,
    };
  }
  // A lesson is previewable when it is itself marked open. An object marked open inside an otherwise
  // protected lesson opens THAT OBJECT, not the lesson around it — which is exactly what section 10
  // asks for and what a naive "any previewable child" test would get wrong.
  const lessonOpen = read.objects.length > 0 && read.objects.every((o) => isOpenToAnyone(o.access));
  return { kind: 'lesson', previewable: lessonOpen, label: read.lessonTitle || 'this lesson', failed: false };
}

/**
 * Gather everything decideAccess() needs. ONE course read, one enrolment read, one settlement read,
 * one prerequisite read, and the preview read only when a lesson was named.
 *
 * Every read is tolerated separately and the ones that matter set readFailed, which produces a
 * retryable answer rather than a denial. A learner told "you are not enrolled" because a SELECT
 * timed out is the failure mode this whole file exists to avoid.
 */
export async function readAccessFacts(user: any, req: AccessRequest): Promise<AccessFacts> {
  const now = Number(req?.now) || Date.now();
  const userId = user?.id ? String(user.id) : null;
  const signedIn = !!userId;

  let isStaff = false;
  if (signedIn && typeof req?.holds === 'function') {
    try {
      isStaff = STAFF_ACCESS_KEYS.some((k) => req.holds!(k) === true);
    } catch {
      isStaff = false; // a holds() that throws is a broken composition, not a grant. Fail closed.
    }
  }

  const facts: AccessFacts = {
    now, signedIn, userId, isStaff,
    course: null,
    policy: { model: 'lifetime', days: null, startsAt: null, endsAt: null, graceDays: 0 },
    enrolment: null,
    settlement: { paid: false, waived: false, orderPending: false },
    waiverPending: false,
    prerequisites: { required: [], missing: [], missingTitles: [], readable: true },
    target: { kind: 'course', previewable: false, label: 'the course' },
    retained: { completed: false, completedAt: null, certNumber: null, verificationUrl: null },
    readFailed: false,
  };

  await ensureCourseAccessSchema();

  // ---- the course ------------------------------------------------------------------------------
  let row: any = null;
  try {
    const byId = isUuid(req?.courseId || '');
    row = rowsOf(await db.execute(byId
      ? sql`SELECT * FROM training_courses WHERE id = ${String(req.courseId)}::uuid LIMIT 1`
      : sql`SELECT * FROM training_courses WHERE slug = ${clip(req?.courseSlug, 200)} LIMIT 1`))[0] || null;
  } catch (e: any) {
    logFail('readAccessFacts/course', e);
    facts.readFailed = true;
    return facts;
  }
  if (!row) return facts;

  const pricing = pricingFromRow(row);
  const priced: PricedUser = { id: userId, role: user?.role ?? null };
  const price = priceForUser(pricing, priced);
  const courseId = String(row.id);

  facts.course = {
    id: courseId,
    slug: row.slug ? String(row.slug) : null,
    title: row.title ? String(row.title) : null,
    published: row.is_published === true,
    archived: !!row.archived_at,
    accessType: accessTypeOf(row.access_type),
    inAudience: audienceAllows(accessTypeOf(row.access_type), priced),
    // "Paid" is course-pricing's answer for THIS person, not a column read twice. An employee on an
    // employees-free course is not on a paid course, and must never be asked for a payment record.
    isPaid: price.allowed && !price.free && price.payableMinor > 0,
    payableMinor: price.payableMinor,
    priceReason: price.reason,
  };
  facts.policy = policyFromRow(row);
  facts.prerequisites.required = parseIdList(row.prereq_course_ids);

  // ---- the preview flag ------------------------------------------------------------------------
  const t = await targetPreview(req);
  facts.target = { kind: t.kind, previewable: t.previewable, label: t.label };
  if (t.failed) facts.readFailed = true;

  if (!signedIn) return facts;

  // ---- the enrolment ---------------------------------------------------------------------------
  try {
    // ORDER BY: with duplicate rows the FINISHED one, then the OPEN one, is the truth. A second row
    // that says nothing must never erase a completion recorded on the first — the same reading
    // learning-progress.courseProgress() applies for the same reason.
    const en = rowsOf(await db.execute(sql`
      SELECT * FROM training_enrollments
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
       ORDER BY completed_at DESC NULLS LAST, id ASC`));
    if (en.length) {
      const best = en.find((r: any) => OPEN_STATES.indexOf(stateOf(r)) >= 0) || en[0];
      facts.enrolment = { state: stateOf(best), window: windowFromRow(best) };
      facts.retained.completed = !!best.completed_at;
      facts.retained.completedAt = iso(best.completed_at);
    }
  } catch (e: any) {
    logFail('readAccessFacts/enrolment', e);
    facts.readFailed = true;
    return facts;
  }

  // ---- settlement ------------------------------------------------------------------------------
  // The same reading as course-sessions.courseEntitlement(): a captured non-zero payment is a
  // purchase, and the zero-value 'paid' row src/lib/fee-waiver.ts writes is an approved waiver.
  if (facts.course.isPaid) {
    try {
      const p = rowsOf(await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'paid' AND COALESCE(amount_paise, 0) > 0)::int AS paid,
          COUNT(*) FILTER (WHERE status = 'paid' AND COALESCE(amount_paise, 0) = 0)::int AS waived,
          COUNT(*) FILTER (WHERE status = 'created')::int AS pending
          FROM payments
         WHERE user_id = ${userId}::uuid
           AND reference_type = 'training_course'
           AND reference_id::text = ${courseId}`))[0] || {};
      facts.settlement = {
        paid: Number(p.paid || 0) > 0,
        waived: Number(p.waived || 0) > 0,
        orderPending: Number(p.pending || 0) > 0,
      };
    } catch (e: any) {
      // FAIL CLOSED ON MONEY, and say so. An unreadable payment table must not open a paid course,
      // and it must not be reported as "you did not pay" either — hence readFailed, which produces
      // the retryable answer.
      logFail('readAccessFacts/settlement', e);
      facts.readFailed = true;
      return facts;
    }
    if (!facts.settlement.paid && !facts.settlement.waived) {
      facts.waiverPending = await waiverIsPending(courseId, userId as string);
    }
  }

  // ---- prerequisites ---------------------------------------------------------------------------
  if (facts.prerequisites.required.length > 0) {
    try {
      const ids = facts.prerequisites.required.map((id) => sql`${id}::uuid`);
      let joined = ids[0];
      for (let i = 1; i < ids.length; i++) joined = sql`${joined}, ${ids[i]}`;
      const done = rowsOf(await db.execute(sql`
        SELECT c.id::text AS id, c.title,
               EXISTS (SELECT 1 FROM training_enrollments e
                        WHERE e.course_id = c.id AND e.user_id = ${userId}::uuid
                          AND e.completed_at IS NOT NULL) AS finished
          FROM training_courses c
         WHERE c.id IN (${joined})`));
      const missing: string[] = [];
      const titles: string[] = [];
      for (const r of done) {
        if (r.finished !== true) {
          missing.push(String(r.id));
          titles.push(r.title ? String(r.title) : 'another course');
        }
      }
      facts.prerequisites.missing = missing;
      facts.prerequisites.missingTitles = titles;
    } catch (e: any) {
      // A prerequisite read that did not run must not lock somebody out of a course they may well
      // have earned. It is reported as unreadable and step 9 then does not block.
      logFail('readAccessFacts/prereq', e);
      facts.prerequisites.readable = false;
    }
  }

  // ---- what they keep --------------------------------------------------------------------------
  // THROUGH THE LEDGER'S OWNER. A query of our own against course_certificates would be a second
  // reader of a hash chain whose whole value is that there is one.
  try {
    const { getCertificatesForUser } = await import('@/lib/certificates');
    const certs = await getCertificatesForUser(userId as string);
    const mine = (certs || []).find((x: any) => String(x?.course_id || '') === courseId);
    if (mine && mine.cert_number) {
      facts.retained.certNumber = String(mine.cert_number);
      facts.retained.verificationUrl = '/verify/' + String(mine.cert_number);
    }
  } catch (e: any) {
    // A certificate we could not read is not a certificate that does not exist, and it is not a
    // reason to close the course. Logged, never fatal.
    logFail('readAccessFacts/certificates', e);
  }

  return facts;
}

/**
 * MAY THIS PERSON OPEN THIS THING, AND IF NOT, WHY. The one function.
 *
 * Call it with a course, or with a course and a lesson, or with a course, a lesson and one object.
 * The answer always carries a sentence the learner can read and, where there is one, something they
 * can do about it.
 */
export async function courseAccess(user: any, req: AccessRequest): Promise<AccessDecision> {
  try {
    return decideAccess(await readAccessFacts(user, req));
  } catch (e: any) {
    // Never a bare denial from an exception. An unreadable answer is a 503 with the reason in the
    // log, not a 403 telling somebody they are not enrolled on a course they paid for.
    logFail('courseAccess', e);
    return {
      allowed: false, reason: 'unreadable', message: M.unreadable, basis: null, previewOnly: false,
      retryable: true, state: null, window: null,
      retained: { completed: false, completedAt: null, certNumber: null, verificationUrl: null },
      next: null, detail: causeOf(e),
    };
  }
}

// =================================================================================================
// THE ONE WRITER OF ENROLMENT STATE
// =================================================================================================

export interface TransitionInput {
  userId: string;
  courseId: string;
  to: EnrolmentState;
  reason: string;
  actorUserId?: string | null;
  /** Where the transition came from: 'admin', 'payment', 'refund', 'expiry', 'workflow', 'learner'. */
  source?: string;
  /** Set or clear this learner's window in the same statement. */
  window?: {
    startsAt?: string | Date | null;
    endsAt?: string | Date | null;
    trialEndsAt?: string | Date | null;
    graceDays?: number | null;
  };
  /** The workflow instance this enrolment is waiting on, when moving to pending_approval. */
  approvalInstanceId?: string | null;
  /** Create the enrolment row when there is none — for 'applied' and 'pending_payment'. */
  createIfMissing?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  /** True when the state was already the requested one. NOT an error. */
  noop: boolean;
  from: EnrolmentState | null;
  to: EnrolmentState | null;
  error?: string;
}

const REASON_REQUIRED =
  'Write down why. An enrolment that changed state with no reason is a change nobody can answer for.';

/**
 * Move an enrolment from one state to another, or REFUSE and say why.
 *
 * NOTHING IS SWALLOWED. A write path that fails quietly is how a console reports work it did not do,
 * and this one changes whether somebody can open a course they may have paid for.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   progress_pct   — src/lib/learning-progress.ts is the single writer.
 *   completed_at   — written by learning-progress.ts and learning-admin.ts, which already disagree
 *                    about what it means. A third writer would make it unanswerable. Moving to
 *                    'expired' or 'suspended' therefore leaves a completion exactly where it is,
 *                    which is section 30's requirement stated as code rather than as a promise.
 *   any certificate — src/lib/certificates.ts owns the ledger.
 *
 * A REFUSAL IS RECORDED. It writes a row with outcome 'refused' and returns ok:false. Somebody
 * trying repeatedly to reinstate a cancelled enrolment leaves a trail.
 */
export async function transitionEnrolment(input: TransitionInput): Promise<TransitionResult> {
  const userId = String(input?.userId || '');
  const courseId = String(input?.courseId || '');
  const to = input?.to;
  const reason = clip(input?.reason, 2000);
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const source = clip(input?.source, 40) || 'admin';

  if (!isUuid(userId) || !isUuid(courseId)) {
    return { ok: false, noop: false, from: null, to: null, error: 'That enrolment does not exist.' };
  }
  if (!isEnrolmentState(to)) {
    return { ok: false, noop: false, from: null, to: null, error: 'That is not an enrolment state.' };
  }
  if (!reason) return { ok: false, noop: false, from: null, to: null, error: REASON_REQUIRED };

  try {
    const schema = await courseAccessSchemaState();
    if (!schema.ok) {
      // The ensure SWALLOWS its failures, so this is the only honest check. Writing a state into a
      // column that is not there would report a suspension that never happened.
      return {
        ok: false, noop: false, from: null, to: null,
        error: 'This enrolment cannot be changed yet: the state columns are not on the database ('
          + (schema.missing.join(', ') || schema.error || 'unknown') + '). Nothing was changed.',
      };
    }

    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM training_enrollments
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
       ORDER BY completed_at DESC NULLS LAST, id ASC`));

    if (!rows.length) {
      if (input?.createIfMissing !== true) {
        return { ok: false, noop: false, from: null, to, error: 'There is no enrolment on this course to change.' };
      }
      // THE FUNNEL GETS AN ENDING. A learner who opened checkout and stopped now has a row that says
      // so, instead of being indistinguishable from somebody who never heard of the course. The test
      // and the write are ONE statement, because this table has no unique key to stop a double tap.
      const made = rowsOf(await db.execute(sql`
        INSERT INTO training_enrollments (course_id, user_id, progress_pct, status, status_reason,
                                          status_changed_at, status_changed_by, enrolled_at)
        SELECT ${courseId}::uuid, ${userId}::uuid, 0, ${to}, ${reason}, NOW(), ${actor}::uuid, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM training_enrollments
            WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid)
        RETURNING id`));
      await recordTransition({
        enrollmentId: made.length ? String(made[0].id) : null,
        userId, courseId, from: null, to, outcome: 'applied', reason, refusal: null, actor, source,
      });
      return { ok: true, noop: false, from: null, to };
    }

    const current = rows.find((r: any) => OPEN_STATES.indexOf(stateOf(r)) >= 0) || rows[0];
    const from = stateOf(current);
    const check = canTransitionEnrolment(from, to);

    if (!check.ok) {
      await recordTransition({
        enrollmentId: String(current.id), userId, courseId, from, to,
        outcome: 'refused', reason, refusal: check.reason, actor, source,
      });
      return { ok: false, noop: false, from, to, error: check.reason };
    }
    if (check.noop && !input?.window && !input?.approvalInstanceId) {
      return { ok: true, noop: true, from, to };
    }

    // EVERY ROW FOR THIS PAIR, not one. Duplicates can exist (no unique key), and two rows holding
    // two different states is how a suspended learner keeps their access through the other row.
    const win = input?.window || {};
    const setStarts = win.startsAt === undefined ? sql`access_starts_at` : sql`${win.startsAt ? new Date(win.startsAt).toISOString() : null}::timestamptz`;
    const setEnds = win.endsAt === undefined ? sql`access_ends_at` : sql`${win.endsAt ? new Date(win.endsAt).toISOString() : null}::timestamptz`;
    const setTrial = win.trialEndsAt === undefined ? sql`trial_ends_at` : sql`${win.trialEndsAt ? new Date(win.trialEndsAt).toISOString() : null}::timestamptz`;
    const setGrace = win.graceDays === undefined ? sql`grace_days` : sql`${win.graceDays === null ? null : Math.max(0, Math.floor(Number(win.graceDays) || 0))}::int`;
    const setWf = input?.approvalInstanceId === undefined
      ? sql`approval_instance_id`
      : sql`${isUuid(input.approvalInstanceId) ? String(input.approvalInstanceId) : null}::uuid`;

    await db.execute(sql`
      UPDATE training_enrollments
         SET status = ${to},
             status_reason = ${reason},
             status_changed_at = NOW(),
             status_changed_by = ${actor}::uuid,
             enrolled_at = COALESCE(enrolled_at, NOW()),
             access_starts_at = ${setStarts},
             access_ends_at = ${setEnds},
             trial_ends_at = ${setTrial},
             grace_days = ${setGrace},
             approval_instance_id = ${setWf},
             updated_at = NOW()
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid`);

    await recordTransition({
      enrollmentId: String(current.id), userId, courseId, from, to,
      outcome: 'applied', reason, refusal: null, actor, source,
    });

    await logAudit({
      userId: actor,
      action: 'learning.enrolment.transition',
      entity: 'training_enrollments',
      entityId: String(current.id),
      diff: { learnerUserId: userId, courseId, from, to, reason, source },
    });

    return { ok: true, noop: false, from, to };
  } catch (e: any) {
    logFail('transitionEnrolment', e);
    return { ok: false, noop: false, from: null, to, error: causeOf(e) || WRITE_FAILED };
  }
}

/**
 * The transition ledger row. Written for applied AND refused attempts.
 *
 * It is allowed to fail without failing the transition — the state IS changed and refusing to
 * acknowledge that would be worse — but it is never allowed to fail in silence.
 */
async function recordTransition(t: {
  enrollmentId: string | null;
  userId: string;
  courseId: string;
  from: EnrolmentState | null;
  to: EnrolmentState;
  outcome: 'applied' | 'refused';
  reason: string;
  refusal: string | null;
  actor: string | null;
  source: string;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO training_enrolment_transitions
        (enrollment_id, user_id, course_id, from_state, to_state, outcome, reason, refusal,
         actor_user_id, source)
      VALUES (${t.enrollmentId}::uuid, ${t.userId}::uuid, ${t.courseId}::uuid, ${t.from}, ${t.to},
              ${t.outcome}, ${t.reason}, ${t.refusal}, ${t.actor}::uuid, ${t.source})`);
  } catch (e: any) {
    logFail('recordTransition:' + t.outcome, e);
  }
}

/** Every state change on one enrolment, newest first, refusals included. */
export async function transitionHistory(
  userId: string, courseId: string, limit = 100,
): Promise<any[]> {
  if (!isUuid(userId) || !isUuid(courseId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  try {
    await ensureCourseAccessSchema();
    return rowsOf(await db.execute(sql`
      SELECT from_state, to_state, outcome, reason, refusal, actor_user_id::text AS actor_user_id,
             source, created_at
        FROM training_enrolment_transitions
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
       ORDER BY created_at DESC
       LIMIT ${lim}`)).map((r: any) => ({
        from: r.from_state ? String(r.from_state) : null,
        to: String(r.to_state),
        outcome: String(r.outcome || 'applied'),
        reason: String(r.reason || ''),
        refusal: r.refusal ? String(r.refusal) : null,
        actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
        source: String(r.source || 'admin'),
        at: iso(r.created_at),
      }));
  } catch (e: any) {
    if (!isMissingTable(e)) logFail('transitionHistory', e);
    return [];
  }
}

/**
 * MIRROR a completion that one of the two completion writers has already recorded.
 *
 * It reads completed_at and moves the state to 'completed'. It NEVER writes completed_at and it
 * never decides what completion means — src/lib/learning-progress.ts and src/lib/learning-admin.ts
 * own that fact and already disagree about it. This only stops the state column from saying 'active'
 * about somebody the record says has finished.
 */
export async function syncCompletionState(userId: string, courseId: string): Promise<TransitionResult> {
  if (!isUuid(userId) || !isUuid(courseId)) {
    return { ok: false, noop: false, from: null, to: null, error: 'That enrolment does not exist.' };
  }
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT completed_at FROM training_enrollments
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
         AND completed_at IS NOT NULL LIMIT 1`));
    if (!r.length) return { ok: true, noop: true, from: null, to: null };
    return await transitionEnrolment({
      userId, courseId, to: 'completed', source: 'progress',
      reason: 'Every lesson this course records as required is recorded as finished.',
    });
  } catch (e: any) {
    logFail('syncCompletionState', e);
    return { ok: false, noop: false, from: null, to: null, error: causeOf(e) };
  }
}

/**
 * Enrolments whose window has closed and whose state has not caught up.
 *
 * A READ. It changes nothing — expiry is a fact about the clock, and decideAccess() already applies
 * it at step 11 whatever the column says, so a learner is never left with access they should not
 * have while this is waiting to be run. Its purpose is the console: somebody should be able to see
 * who lapsed this week, and expireLapsed() below writes the state so a list query can filter on it
 * without recomputing a window per row.
 */
export async function lapsedEnrolments(limit = 200): Promise<any[]> {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  try {
    await ensureCourseAccessSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT e.user_id::text AS user_id, e.course_id::text AS course_id, e.status, e.completed_at,
             e.access_starts_at, e.access_ends_at, e.trial_ends_at, e.grace_days, e.enrolled_at,
             c.title, c.access_model, c.access_days, c.access_grace_days,
             c.access_starts_at AS c_starts, c.access_ends_at AS c_ends
        FROM training_enrollments e
        JOIN training_courses c ON c.id = e.course_id
       WHERE COALESCE(e.status, 'active') NOT IN ('cancelled', 'refunded', 'expired')
         AND (e.access_ends_at IS NOT NULL OR e.trial_ends_at IS NOT NULL
              OR c.access_ends_at IS NOT NULL OR c.access_days IS NOT NULL)
       LIMIT ${lim}`));
    const now = Date.now();
    return rows.map((r: any) => {
      const w = computeAccessWindow(
        policyFromRow({
          access_model: r.access_model, access_days: r.access_days,
          access_starts_at: r.c_starts, access_ends_at: r.c_ends,
          access_grace_days: r.access_grace_days,
        }),
        windowFromRow(r), now,
      );
      return {
        userId: String(r.user_id), courseId: String(r.course_id),
        courseTitle: r.title ? String(r.title) : 'A course',
        state: stateOf(r), window: w,
        completed: !!r.completed_at,
      };
    }).filter((x: any) => x.window.phase === 'expired');
  } catch (e: any) {
    logFail('lapsedEnrolments', e);
    return [];
  }
}

/**
 * Write 'expired' onto the enrolments whose window has closed. Idempotent, and it deletes nothing.
 *
 * Section 30 in one sentence: this restricts access and touches neither progress nor completion nor
 * any certificate. A learner who finished the course keeps the completion, keeps the certificate,
 * and keeps them visible — the decision still carries `retained` after the state says expired.
 */
export async function expireLapsed(actorUserId: string | null, limit = 200): Promise<{
  ok: boolean; expired: number; refused: number; error?: string;
}> {
  try {
    const lapsed = await lapsedEnrolments(limit);
    let expired = 0;
    let refused = 0;
    for (const l of lapsed) {
      const r = await transitionEnrolment({
        userId: l.userId, courseId: l.courseId, to: 'expired', actorUserId, source: 'expiry',
        reason: 'The access window for this course closed on ' + (day(l.window.closesAt) || 'its end date')
          + '. Nothing recorded against this learner was changed.',
      });
      if (r.ok && !r.noop) expired++;
      else if (!r.ok) refused++;
    }
    return { ok: true, expired, refused };
  } catch (e: any) {
    logFail('expireLapsed', e);
    return { ok: false, expired: 0, refused: 0, error: causeOf(e) };
  }
}
