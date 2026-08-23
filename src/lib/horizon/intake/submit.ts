// src/lib/horizon/intake/submit.ts — THE TWO ENTRY POINTS THE APPLICATION FLOW CALLS.
//
// Everything below this file is a boundary with one job; this file is the ORCHESTRATION, kept
// separate so an .astro page never has to know the order the boundaries must be called in — and so
// that order is testable.
//
// TWO CALLS, AT TWO MOMENTS:
//
//   applyFoundationDecision()      on the personal-details step, where the person makes the choice.
//                                  Consent is timestamped WHEN THEY TICKED THE BOX, which is the
//                                  only timestamp that means anything.
//   announceApplicationSubmitted() at the end of the flow, after the submission is actually staged.
//
// =================================================================================================
// THE RULE THAT SHAPES ALL OF THIS: THE APPLICATION MUST NEVER FAIL BECAUSE OF THIS PATCH
// =================================================================================================
//
// This is optional information for an optional purpose. An applicant must never lose a submission,
// see a red error, or be blocked because a consent row would not write or a key was missing. So:
//
//   - every function here returns a RESULT and throws nothing;
//   - a failure to store produces a message the page shows ALONGSIDE a successful application, never
//     instead of one;
//   - and validation errors on this block are returned separately from the recruitment fields, so a
//     page can decide to surface them without failing the step.
//
// The one thing that is NOT softened is silence. A failure is logged with the real Postgres reason
// and reported back in the result. "It quietly did nothing" is the outcome this project has been
// bitten by most.
import {
  DEFAULT_ORGANISATION_ID,
  applicantSubject,
  type ActorRef,
  type OrganisationId,
  type SubjectRef,
} from '@/lib/horizon/ids';
import { validateFoundationSubmission } from './birth-input';
import { currentConsent, grantConsent, withdrawConsent } from './consent';
import { emitApplicationSubmitted, requestRecompute } from './events';
import { encryptionAvailable, getHoldings, purgeFoundation, storePersonalFoundation } from './foundation';
import { CURRENT_NOTICE } from './notice';
import {
  type ApplicationSubmittedPayload,
  type ConsentState,
  type FieldIssue,
  type FoundationHoldings,
  type RawFoundationSubmission,
} from './types';

// -------------------------------------------------------------------------------------------------
// SUBJECT
// -------------------------------------------------------------------------------------------------

/**
 * The subject for a signed-in applicant.
 *
 * Anchored on `user` — users.id — and NOT on an application id, because this information belongs to
 * the PERSON and outlives any one application. ids.ts records the same distinction: an applicant is
 * a person, an application is an event. When the identity patch's SubjectResolver lands, a subject
 * anchored on tal_person can be migrated to; nothing in this patch assumes the anchor.
 */
export function subjectForUser(
  userId: string,
  organisationId: OrganisationId = DEFAULT_ORGANISATION_ID,
): SubjectRef {
  return applicantSubject(userId, 'user', organisationId);
}

/** The actor for a person acting on their own record. */
export function actorForUser(userId: string, displayName?: string | null): ActorRef {
  return { kind: 'user', id: userId, displayName: displayName || null };
}

// -------------------------------------------------------------------------------------------------
// THE DECISION
// -------------------------------------------------------------------------------------------------

export interface FoundationDecisionArgs {
  userId: string;
  displayName?: string | null;
  /** True when the person ticked the authorisation box on this submission. */
  consented: boolean;
  /** The raw form fields. Ignored entirely when `consented` is false. */
  form: RawFoundationSubmission;
  /** The surface, e.g. 'apply/step-1'. */
  source: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  organisationId?: OrganisationId;
}

export interface FoundationDecisionResult {
  /** What happened, in one word, so a page can branch without parsing a sentence. */
  outcome: 'stored' | 'withdrawn' | 'declined' | 'invalid' | 'unavailable' | 'failed';
  /** Safe to show the person. Never a stack trace, never blame. */
  message: string;
  /** Field-level problems with THIS block only. Never mixed with the recruitment fields. */
  errors: FieldIssue[];
  /** Honest notes about what could not be worked out. Not failures. */
  warnings: FieldIssue[];
  holdings: FoundationHoldings | null;
  consent: ConsentState | null;
  /** True when the stored content actually differs from what was held before. */
  changed: boolean;
  /** Passed straight into requestRecompute() by the caller at submission time. */
  inputHash: string | null;
}

/**
 * Apply what the person decided on this submission.
 *
 * FOUR PATHS, and the order within each one matters:
 *
 *   ticked + valid    validate -> record the grant -> store. The grant is written BEFORE the data,
 *                     because storePersonalFoundation() refuses without one and because a stored
 *                     record with no consent row would be exactly the thing this patch exists to
 *                     prevent.
 *   ticked + invalid  nothing is recorded at all. Recording a grant for data we then rejected leaves
 *                     an authorisation covering nothing.
 *   unticked + held   they have just told us to stop: record the withdrawal, then delete. Only when
 *                     a grant was actually in force, so a person who never opted in does not
 *                     accumulate withdrawal rows for a box they never ticked.
 *   unticked + none   nothing happens, and nothing is recorded. Declining is not an event.
 */
export async function applyFoundationDecision(
  args: FoundationDecisionArgs,
): Promise<FoundationDecisionResult> {
  const subject = subjectForUser(args.userId, args.organisationId);
  const actor = actorForUser(args.userId, args.displayName);
  const base = { errors: [] as FieldIssue[], warnings: [] as FieldIssue[], changed: false, inputHash: null };

  const existing = await currentConsent(subject);

  // ---- DECLINED, OR WITHDRAWN ----------------------------------------------------------------
  if (!args.consented) {
    if (!existing.granted) {
      return {
        ...base, outcome: 'declined', consent: existing, holdings: null,
        message: 'No personal profile information is held for you.',
      };
    }
    await withdrawConsent({
      subject, actor, source: args.source,
      ipAddress: args.ipAddress, userAgent: args.userAgent,
      reason: 'Authorisation not given on a later submission of the application form.',
    });
    const purge = await purgeFoundation({
      subject,
      // service is null and says so explicitly: this purge is asked for by a signed-in person on
      // the application form, never by an engine, and ReadActor keeps the two readers apart.
      actor: { userId: args.userId, service: null, ipAddress: args.ipAddress || null },
      reason: 'Authorisation withdrawn on the application form.',
      source: args.source,
    });
    return {
      ...base,
      outcome: 'withdrawn',
      consent: await currentConsent(subject),
      holdings: await getHoldings(subject),
      message: purge.sentence,
    };
  }

  // ---- AUTHORISED ------------------------------------------------------------------------------
  const validated = validateFoundationSubmission(args.form);
  if (!validated.ok) {
    return {
      ...base,
      outcome: 'invalid',
      errors: validated.errors,
      warnings: validated.warnings,
      consent: existing,
      holdings: await getHoldings(subject),
      message: 'Your application is fine. Only the optional personal profile section needs a correction.',
    };
  }

  // Asked BEFORE the grant is recorded: consenting to storage that cannot happen is not consent to
  // anything, and the person should be told rather than thanked.
  if (!encryptionAvailable()) {
    return {
      ...base,
      outcome: 'unavailable',
      warnings: validated.warnings,
      consent: existing,
      holdings: await getHoldings(subject),
      message: 'Secure storage for this optional section is not switched on right now, so nothing was '
        + 'saved from it. Your application is unaffected and you can add it later from your portal.',
    };
  }

  // Re-record the grant on every authorised submission. It is an append-only ledger, so this is not
  // a duplicate — it is the record that they authorised it again, on this date, against THIS notice
  // version, which is what makes a re-consent after a copy change provable.
  const granted = await grantConsent({
    subject, actor, notice: CURRENT_NOTICE, source: args.source,
    ipAddress: args.ipAddress, userAgent: args.userAgent,
  });
  if (!granted) {
    return {
      ...base,
      outcome: 'failed',
      warnings: validated.warnings,
      consent: existing,
      holdings: await getHoldings(subject),
      message: 'We could not record your authorisation just now, so nothing from the optional section '
        + 'was saved. Your application is unaffected.',
    };
  }

  const stored = await storePersonalFoundation({
    subject, input: validated.value, actor, source: args.source, ipAddress: args.ipAddress,
  });
  if (!stored.ok) {
    return {
      ...base,
      outcome: stored.reason === 'encryption-unavailable' ? 'unavailable' : 'failed',
      warnings: validated.warnings,
      consent: await currentConsent(subject),
      holdings: await getHoldings(subject),
      message: stored.message + ' Your application is unaffected.',
    };
  }

  return {
    outcome: 'stored',
    message: 'Saved. You can see or withdraw this at any time from your portal.',
    errors: [],
    warnings: validated.warnings,
    holdings: stored.holdings,
    consent: await currentConsent(subject),
    changed: stored.changed,
    inputHash: stored.inputHash,
  };
}

// -------------------------------------------------------------------------------------------------
// SUBMISSION
// -------------------------------------------------------------------------------------------------

export interface AnnounceSubmissionArgs {
  userId: string;
  applicationNumber?: string | null;
  applicationRef?: string | null;
  applicationRefKind?: 'application' | 'application_intent' | null;
  roleId?: string | null;
  roleTitle?: string | null;
  correlationId?: string | null;
  organisationId?: OrganisationId;
}

export interface AnnounceSubmissionResult {
  /** The event went out. */
  announced: boolean;
  /** A recomputation was asked for, and the ask is on the queue. */
  recomputeRequested: boolean;
  /** Null when nothing is held for this person — the normal case for anyone who declined. */
  requestId: string | null;
}

/**
 * Announce a completed submission, and ask for a recomputation if there is anything to recompute.
 *
 * CALLED AFTER THE SUBMISSION IS STAGED, never before. A subscriber that hears application.submitted
 * and then finds nothing in the database has been lied to.
 *
 * NO RECOMPUTATION IS ASKED FOR when the person declined or nothing is stored: queueing work against
 * an empty record would produce a queue full of requests an engine can only refuse, and a refusal
 * that was never worth making is noise that hides the real ones.
 *
 * NEVER THROWS. The application has already committed by the time this runs; an event that could not
 * be published is logged and reported in the result, and it is never allowed to fail a submission.
 */
export async function announceApplicationSubmitted(
  args: AnnounceSubmissionArgs,
): Promise<AnnounceSubmissionResult> {
  const subject = subjectForUser(args.userId, args.organisationId);
  const out: AnnounceSubmissionResult = { announced: false, recomputeRequested: false, requestId: null };

  let holdings: FoundationHoldings | null = null;
  try {
    holdings = await getHoldings(subject);
  } catch {
    holdings = null;
  }
  const hasFoundation = !!holdings?.hasStoredData;

  const payload: ApplicationSubmittedPayload = {
    subject,
    applicationNumber: args.applicationNumber || null,
    applicationRef: args.applicationRef || null,
    applicationRefKind: args.applicationRefKind || null,
    roleId: args.roleId || null,
    roleTitle: args.roleTitle || null,
    submittedAt: new Date().toISOString(),
    hasPersonalFoundation: hasFoundation,
  };

  try {
    await emitApplicationSubmitted(payload, args.correlationId || null);
    out.announced = true;
  } catch (e: any) {
    console.error('[horizon/intake] announce failed:', e?.cause?.message || e?.message);
  }

  if (!hasFoundation) return out;

  const req = await requestRecompute({
    subject,
    reason: 'application.submitted',
    applicationRef: args.applicationRef || null,
    correlationId: args.correlationId || null,
    actor: actorForUser(args.userId),
  });
  out.recomputeRequested = req.ok;
  out.requestId = req.request?.id || null;
  return out;
}
