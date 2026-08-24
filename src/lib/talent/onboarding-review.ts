// src/lib/talent/onboarding-review.ts — THE REVIEW SIDE of onboarding. Spec sections 7, 11 and 33.
//
// WHY THIS IS NOT IN onboarding.ts. That module is the CANDIDATE's: it holds a session for somebody
// who has no account, strips the fields the organisation owns out of everything they POST, and
// refuses to let them near anything else. Putting the reviewer's powers in the same file gives the
// candidate-facing module an admin brain — one import away from a surface that must never hold one.
// So the reads and rules a reviewer needs live here, and the two candidate-side functions this desk
// genuinely shares (requestChanges, formProblems, missingDeclarations) are IMPORTED, never restated.
//
// ---------------------------------------------------------------------------------------------
// THE THREE ACTS, AND WHY THEY ARE THREE
// ---------------------------------------------------------------------------------------------
// APPROVE closes the admission and creates the organizational identity. It is the heaviest act on
//   the screen and the only one that makes somebody a member of this organisation.
// REQUEST CHANGES reopens the form. The candidate is still being admitted; they are being asked for
//   something. It is not a refusal and the copy must never let it read as one.
// REJECT closes the admission the other way. Nothing reopens. It needs a written reason because a
//   person will be told it, and "your onboarding was not approved" with no sentence after it is not
//   something anybody can act on.
//
// An operator who confuses the second and the third has either stranded somebody who was going to
// join, or turned away somebody they meant to keep. decideReview() below owns which of the three is
// legal from which status, as a PURE function, so the queue's buttons and the POST handler's refusal
// cannot drift apart.
//
// ---------------------------------------------------------------------------------------------
// EVERY LIST READ IN THIS FILE RETHROWS
// ---------------------------------------------------------------------------------------------
// "Nobody is waiting for review" and "we could not read who is waiting" render as the same empty
// table and mean opposite things. That confusion is the dominant defect class in this repository, so
// reviewQueue(), reviewCounts(), reviewDetail() and reviewDocuments() all log the real Postgres
// reason and rethrow. The page catches, prints the reason, and never draws an empty state it did not
// earn — the same shape as codeRegister() in src/lib/talent/codes.ts.
//
// NO DDL HERE. ensureTalentSchema() owns every tal_* table; this module only ever reads and updates.
import { ensureTalentSchema } from './schema';
import { logAudit } from '@/lib/audit';
import { emitTalentEvent, TALENT_EVENTS, TALENT_SUBJECT_KINDS } from './events';
import {
  DECLARATIONS, formProblems, missingDeclarations, requiredFormFields,
  identityTypeFromEmployment, requestChanges,
  type OnboardingApplication,
} from './onboarding';
import {
  rowsOf, reasonOf,
  ONBOARDING_SECTIONS, ONBOARDING_STATUS_LABELS,
  type DocumentRef, type Identity, type OnboardingStatus, type TalentResult,
} from './types';

// requestChanges is re-exported rather than reimplemented, so a review surface has ONE vocabulary
// for the three acts and cannot end up calling two different "send it back" functions.
export { requestChanges };

// ---------------------------------------------------------------------------------------------
// Declared before anything that uses them. `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/** The queue's tabs. `needs_identity` is not a status and covers both directions — see reviewQueue(). */
export const REVIEW_FILTERS = [
  { key: 'submitted', label: 'Awaiting review' },
  { key: 'changes_requested', label: 'Sent back' },
  { key: 'in_progress', label: 'Being filled in' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Not approved' },
  { key: 'needs_identity', label: 'Decision and identity disagree' },
  { key: 'all', label: 'Everything' },
] as const;

export type ReviewFilterKey = (typeof REVIEW_FILTERS)[number]['key'];

export function isReviewFilter(v: unknown): v is ReviewFilterKey {
  return typeof v === 'string' && REVIEW_FILTERS.some((f) => f.key === v);
}

/**
 * What a document's status means IN WORDS A REVIEWER CAN TRUST.
 *
 * 'verified' is deliberately NOT rendered as "verified by EduRankAI". This platform receives a LINK;
 * it does not open a registrar's records and it does not authenticate a certificate. What the column
 * actually records is that a human on this desk looked at it and marked it checked — spec 33.1 is
 * explicit that the system controls the reference and not the file, and the labels have to say the
 * same thing the architecture does.
 */
export const DOC_STATUS_LABELS: Record<string, string> = {
  submitted: 'Received, not yet checked',
  verified: 'Checked by a reviewer',
  rejected: 'Rejected by a reviewer',
  replaced: 'Replaced by a newer link',
  expired: 'Past its expiry date',
};

export type ReviewAction = 'approve' | 'reject' | 'request_changes';

async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

/**
 * An application reference — and a user reference — is a UUID column. PURE.
 *
 * Without this, a typed or truncated `?id=` reaches Postgres as `'nonsense'::uuid` and comes back as
 * error 22P02, which this desk would then print as "This onboarding could not be read" — the wording
 * reserved for a database that did not answer. A reference that is not a reference is a MISSING
 * record, and the two have to read differently or the operator learns to ignore both.
 */
const APPLICATION_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isApplicationRef(v: unknown): boolean {
  return APPLICATION_REF_RE.test(String(v || '').trim());
}

// ---------------------------------------------------------------------------------------------
// THE IDENTITY REGISTRY, RESOLVED AT RUNTIME AND NOT LINKED AT BUILD TIME
// ---------------------------------------------------------------------------------------------
// src/lib/talent/identity.ts is another module's deliverable (the /admin/talent/identity desk that
// src/lib/admin-nav.ts and src/middleware.ts already route to). IT IS NOW ON DISK, and its
// createIdentityFromOnboarding() has been read against this call site field for field:
//
//   createIdentityFromOnboarding(args: { onboardingApplicationId: string; actorUserId: string;
//     identityType?: string; startDate?: string | null }): Promise<TalentResult<Identity>>
//
// — the same four fields passed below, the same result shape read below, and identity.ts's own
// header states the matching half of the bargain: it requires the application to still be
// 'submitted', which is exactly the order approveOnboarding() writes in. It is also idempotent, so
// the retry this desk offers over a half-done approval returns the existing identity rather than
// minting a second.
//
// THE GLOB SEAM STAYS ANYWAY, and not out of habit. It was written when that file did not exist,
// where a static `import { createIdentityFromOnboarding } from './identity'` would have failed to
// resolve — which does not break this page, it breaks the BUILD, and with it every route on the
// site. Vite resolves import.meta.glob at BUILD time and it survives both worlds:
//   - identity.ts absent  -> the map is empty, nothing is linked, the build is green, and an
//                            approval refuses with a sentence naming exactly what is missing.
//   - identity.ts present -> the module is bundled properly and lazily imported here, which is what
//                            a plain dynamic import could NOT promise inside a serverless bundle.
// The shape is still checked at the CALL SITE rather than trusted to the type system, because the
// two modules are separate deliverables that can be edited apart; a mismatch is reported to the
// reviewer as a refusal, never assumed away and never flipped a status over.
export interface CreateIdentityInput {
  onboardingApplicationId: string;
  actorUserId: string;
  identityType?: string;
  startDate?: string | null;
}

type CreateIdentityFn = (input: CreateIdentityInput) => Promise<TalentResult<Identity>>;

const IDENTITY_MODULE = import.meta.glob('./identity.ts') as Record<string, () => Promise<any>>;

export interface RegistryStatus {
  /** An identity can be created on this deployment. */
  available: boolean;
  /** Why not, as a sentence naming which of the three failures it is. Empty when available. */
  problem: string;
}

/**
 * Whether this deployment can create an identity AT ALL, AND WHICH FAILURE IT IS. No database.
 *
 * A screen that offers "Approve and create the identity" on a deployment with no identity registry
 * in it is promising an act that will be refused after the reviewer has read a whole submission and
 * ticked the confirmation. Asked before the button is drawn, not after it is pressed.
 *
 * THREE FAILURES, NOT ONE, AND THEY MUST NOT BE REPORTED AS THE SAME THING. This used to answer a
 * bare boolean, so a registry that was PRESENT AND BROKEN — a module that throws while it loads —
 * was reported to the reviewer as a registry that "is not part of this deployment". That is a
 * swallowed error rendered as a confident claim: it sends somebody to ship a file that is already
 * there instead of to the exception that is actually stopping them. So:
 *   - absent   -> nothing to link. The desk still sends back and refuses; it cannot admit.
 *   - broken   -> present, and it threw on load. Named as a fault, with the real reason.
 *   - mismatch -> present and loaded, but exports no createIdentityFromOnboarding().
 */
export async function identityRegistryStatus(): Promise<RegistryStatus> {
  const { fn, problem } = await identityRegistry();
  return { available: fn !== null, problem };
}

/** The boolean alone, for callers that only need to know whether to draw the button. */
export async function identityRegistryAvailable(): Promise<boolean> {
  return (await identityRegistry()).fn !== null;
}

/** The registry's creator, or null with a sentence saying which way it was unavailable. */
async function identityRegistry(): Promise<{ fn: CreateIdentityFn | null; problem: string }> {
  const loader = IDENTITY_MODULE['./identity.ts'] || Object.values(IDENTITY_MODULE)[0];
  if (!loader) {
    return {
      fn: null,
      problem: 'The identity registry (src/lib/talent/identity.ts) is not part of this deployment, so '
        + 'no organizational identity can be created.',
    };
  }
  try {
    const mod: any = await loader();
    const fn = mod?.createIdentityFromOnboarding;
    if (typeof fn !== 'function') {
      return {
        fn: null,
        problem: 'src/lib/talent/identity.ts is part of this deployment but exports no '
          + 'createIdentityFromOnboarding(), which is the function this desk calls to create an '
          + 'identity. The two modules have drifted apart.',
      };
    }
    return { fn: fn as CreateIdentityFn, problem: '' };
  } catch (e: any) {
    const why = reasonOf(e);
    console.error('[talent-onboarding-review] identity registry failed to load: ' + why);
    return {
      fn: null,
      problem: 'The identity registry (src/lib/talent/identity.ts) IS part of this deployment but '
        + 'could not be loaded: ' + why + '. That is a fault in that module, not a missing one.',
    };
  }
}

// ---------------------------------------------------------------------------------------------
// PURE RULES. Nothing below this heading reaches a connection, which is what makes it testable
// without one — src/lib/talent/onboarding-review.test.ts exercises all of it.
// ---------------------------------------------------------------------------------------------

export interface ReviewDecision {
  allowed: boolean;
  /** Why not, as a sentence an operator can act on. Empty when the act is allowed. */
  reason: string;
}

/**
 * WHICH DECISION IS LEGAL FROM WHICH STATUS. The single source of truth for the buttons AND for the
 * refusal inside the POST handler.
 *
 * All three acts require 'submitted', and that is not an arbitrary narrowing:
 *  - 'in_progress' means the candidate has not finished. Approving a form nobody has submitted
 *    admits somebody on the strength of a half-filled draft.
 *  - 'changes_requested' means the ball is with the candidate. A second decision on top of the first
 *    would be taken while they are mid-edit, and their resubmission would land on a closed record.
 *  - 'approved' and 'rejected' are decided. Re-deciding them here would rewrite history with no
 *    reason recorded; a genuine reversal is a new, reasoned act and does not belong on this button.
 *  - 'suspended' and 'expired' are not reviewable states — something has to reopen them first.
 *
 * A hidden button is not a lock, so every caller asks this again on POST.
 */
export function decideReview(currentStatus: string, action: ReviewAction): ReviewDecision {
  const status = String(currentStatus || '');
  const verb = action === 'approve' ? 'approved'
    : action === 'reject' ? 'refused'
    : 'sent back for changes';

  if (status === 'submitted') return { allowed: true, reason: '' };

  if (status === 'in_progress') {
    return {
      allowed: false,
      reason: 'This onboarding has not been submitted yet — the candidate is still filling it in, so '
        + 'there is nothing here to be ' + verb + '.',
    };
  }
  if (status === 'changes_requested') {
    return {
      allowed: false,
      reason: 'This onboarding has already been sent back to the candidate and is open for them to '
        + 'edit. Wait for them to submit again before it can be ' + verb + '.',
    };
  }
  if (status === 'approved') {
    return {
      allowed: false,
      reason: 'This onboarding was approved and the identity was created from it. It cannot be '
        + verb + ' here; a reversal is a separate, reasoned act on the identity record.',
    };
  }
  if (status === 'rejected') {
    return {
      allowed: false,
      reason: 'This onboarding was already closed as not approved. It cannot be ' + verb + '.',
    };
  }
  if (status === 'suspended') {
    return {
      allowed: false,
      reason: 'This onboarding is suspended, usually because the selection behind it was withdrawn. '
        + 'It has to be reopened before any decision can be recorded.',
    };
  }
  if (status === 'expired') {
    return {
      allowed: false,
      reason: 'This onboarding expired before it was decided. It has to be reopened before it can be '
        + verb + '.',
    };
  }
  return {
    allowed: false,
    reason: 'This onboarding is in the state "' + status + '", which this desk does not know how to '
      + 'decide on. Nothing has been changed.',
  };
}

/**
 * A rejection is told to a person. PURE.
 *
 * The floor is not bureaucracy: "no" and "not suitable" are the two reasons this field collects when
 * nothing stops it, and neither one can be read out to a candidate or defended three months later
 * when they ask why. Twenty characters excluding whitespace is roughly four words — enough to have
 * said something, short enough that a genuine short reason ("Bank details name a different person")
 * passes on the first try. It counts NON-SPACE characters, so padding a two-word refusal out with
 * spaces defeats nothing.
 *
 * It is a floor on effort, not a judge of quality; nothing here can tell a good reason from a bad
 * one, and this function does not pretend to.
 */
export const MIN_REJECTION_REASON = 20;

export function rejectionProblem(reason: string): string | null {
  const why = String(reason || '').trim();
  if (!why) {
    return 'A rejection needs a written reason. It closes somebody\'s admission and they will be told why.';
  }
  if (why.replace(/\s+/g, '').length < MIN_REJECTION_REASON) {
    return 'Write a reason somebody could act on — a few words like "not suitable" is not something '
      + 'this desk can read back to a candidate, or defend when they ask.';
  }
  return null;
}

export interface SubmissionGaps {
  /** Required form fields that are still empty, in the candidate's own words. */
  fields: string[];
  /** Required declarations that were not accepted. */
  declarations: string[];
  /** Document-level gaps. This platform stores links, so the only gap it can see is "none linked". */
  documents: string[];
  total: number;
  clean: boolean;
}

/**
 * Everything still missing from a submission, in one list. PURE.
 *
 * COMPOSED, not restated. formProblems() and missingDeclarations() already own those two rules for
 * the candidate-facing form; a second copy here would be a second answer to "is this complete?", and
 * the two would disagree the first time a field was added.
 *
 * documentCount is PASSED IN rather than queried, so this stays a pure function with a test.
 */
export function submissionGaps(
  identityType: string,
  formData: Record<string, unknown>,
  declarations: Record<string, unknown>,
  documentCount: number,
): SubmissionGaps {
  const fields = formProblems(identityType, formData || {});
  const decls = missingDeclarations(declarations || {});
  const docs: string[] = [];
  if (!(Number(documentCount) > 0)) docs.push('No document link has been provided.');
  const total = fields.length + decls.length + docs.length;
  return { fields, declarations: decls, documents: docs, total, clean: total === 0 };
}

export interface AnswerView {
  key: string;
  label: string;
  value: string;
  required: boolean;
  missing: boolean;
}

export interface SectionView {
  key: string;
  label: string;
  /** TRUE means the organisation supplied these answers and the candidate could never write them. */
  orgControlled: boolean;
  answers: AnswerView[];
}

/**
 * The submitted answers, grouped into the sections the form actually had. PURE.
 *
 * WHY orgControlled IS CARRIED THROUGH. A reviewer reading "Department: Engineering" needs to know
 * whether the person typed that or whether it came off the selection record. One of those is a claim
 * to check and the other is our own data being read back to us, and checking the second is wasted
 * effort while trusting the first is how a wrong claim gets waved through. ONBOARDING_SECTIONS marks
 * which is which (spec 11 rule 3) and this function does not decide it a second time.
 *
 * The org-controlled section carries no candidate FieldDefs at all — it renders from the selection
 * snapshot — so it comes back with an empty answer list and the page fills it from reviewDetail().
 */
export function reviewSections(identityType: string, formData: Record<string, any>): SectionView[] {
  const data = formData || {};
  const fields = requiredFormFields(identityType);
  return ONBOARDING_SECTIONS.map((s) => {
    const answers: AnswerView[] = fields
      .filter((f) => f.section === s.key)
      .map((f) => {
        const raw = data[f.key];
        const value = raw === null || raw === undefined ? '' : String(raw).trim();
        return {
          key: f.key,
          label: f.label,
          value,
          required: f.required,
          missing: f.required && value === '',
        };
      });
    return { key: s.key, label: s.label, orgControlled: s.orgControlled === true, answers };
  }).filter((s) => s.answers.length > 0 || s.orgControlled);
}

export interface DeclarationView {
  key: string;
  label: string;
  required: boolean;
  accepted: boolean;
}

/**
 * Every declaration the form asked for, and whether it was accepted. PURE.
 *
 * Driven from DECLARATIONS rather than from the stored object, so a declaration that was added after
 * a candidate submitted shows up as NOT ACCEPTED instead of quietly vanishing from the review.
 */
export function declarationViews(declarations: Record<string, any>): DeclarationView[] {
  const given = declarations || {};
  return DECLARATIONS.map((d) => ({
    key: d.key,
    label: d.label,
    required: d.required,
    accepted: given[d.key] === true,
  }));
}

/**
 * The one sentence a reviewer without document.view_sensitive is entitled to. PURE.
 *
 * They may know documents EXIST and how many. They may not know what they are — spec 33.2 rule 4.
 * The count matters on its own: zero linked documents is a reason not to approve, and that judgement
 * must not require the sensitive key.
 */
export function documentSummary(total: number, sensitive: number): string {
  const n = Math.max(0, Number(total) || 0);
  const s = Math.max(0, Number(sensitive) || 0);
  if (n === 0) return 'No document link has been provided with this onboarding.';
  const head = n === 1 ? 'One document link has been provided' : n + ' document links have been provided';
  if (s === 0) return head + '. None of them is flagged identity-class.';
  if (s === 1) return head + ', one of which is flagged identity-class.';
  return head + ', ' + s + ' of which are flagged identity-class.';
}

/** Label for an onboarding status, from the owned map. PURE. */
export function onboardingStatusLabel(status: string): string {
  return (ONBOARDING_STATUS_LABELS as Record<string, string>)[String(status || '')] || String(status || '');
}

/** Label for a document status, from the owned map above. PURE. */
export function documentStatusLabel(status: string): string {
  return DOC_STATUS_LABELS[String(status || '')] || String(status || '');
}

// ---------------------------------------------------------------------------------------------
// READS. All of them rethrow.
// ---------------------------------------------------------------------------------------------

export interface ReviewQueueRow {
  id: string;
  codeRef: string;
  selectionId: string;
  selectionCode: string;
  personId: string;
  personName: string;
  personCode: string;
  personEmail: string;
  opportunityTitle: string;
  employmentType: string | null;
  /** TEXT, never a UUID — departments.id is varchar(50). A ::uuid cast here is a certain 500. */
  departmentId: string | null;
  proposedJoiningDate: string | null;
  selectionWithdrawnAt: string | null;
  status: OnboardingStatus;
  submittedAt: string | null;
  updatedAt: string | null;
  reviewedAt: string | null;
  reviewedByName: string;
  reviewNote: string | null;
  approvedAt: string | null;
  /** What the APPLICATION row records. Null on a record whose approval never landed. */
  identityId: string | null;
  /**
   * What the IDENTITY REGISTRY records against this application, which is not the same question.
   * The two disagreeing is the half-done approval — see reviewQueue()'s 'needs_identity'.
   */
  linkedIdentityId: string | null;
  identityCode: string | null;
  identityStatus: string | null;
  documentCount: number;
  sensitiveCount: number;
}

// One SELECT list, used by the queue and by the detail read, so the two can never describe the same
// row differently.
const QUEUE_COLUMNS = `ob.id, ob.onboarding_code_ref, ob.selection_id, ob.person_id, ob.status,
  ob.submitted_at, ob.updated_at, ob.reviewed_at, ob.review_note, ob.approved_at, ob.identity_id,
  COALESCE(p.display_name, '')  AS person_name,
  COALESCE(p.person_code, '')   AS person_code,
  COALESCE(p.primary_email, '') AS person_email,
  COALESCE(o.title, '')         AS opportunity_title,
  COALESCE(s.selection_code, '') AS selection_code,
  s.employment_type, s.department_id, s.proposed_joining_date, s.withdrawn_at,
  COALESCE(ru.name, '')         AS reviewed_by_name,
  i.id AS linked_identity_id, i.identity_code, i.status AS identity_status,
  (SELECT COUNT(*) FROM tal_document_ref d
    WHERE d.subject_kind = 'onboarding' AND d.subject_id = ob.id AND d.status <> 'replaced') AS document_count,
  (SELECT COUNT(*) FROM tal_document_ref d
    WHERE d.subject_kind = 'onboarding' AND d.subject_id = ob.id AND d.status <> 'replaced'
      AND d.is_sensitive) AS sensitive_count`;

// LEFT JOINS THROUGHOUT. An onboarding whose selection row is missing is a broken record that the
// review desk is exactly the right place to notice; an inner join would hide it instead.
//
// THE IDENTITY JOIN IS LATERAL, AND THAT IS NOT DECORATION. tal_identity carries no unique index on
// onboarding_application_id, so a plain LEFT JOIN multiplies the row: two identity rows against one
// application would list that candidate TWICE in the queue and count them twice in a filtered tab —
// a duplicate that reads as two people waiting. `ORDER BY created_at ASC LIMIT 1` is the SAME rule
// approveOnboarding() uses when it decides which existing identity to reuse, so the identity the
// queue names is the identity a repair would actually complete against, rather than whichever row
// the planner happened to return first.
const QUEUE_FROM = `FROM tal_onboarding_application ob
  LEFT JOIN tal_person p             ON p.id = ob.person_id
  LEFT JOIN tal_selection_decision s ON s.id = ob.selection_id
  LEFT JOIN tal_opportunity o        ON o.id = s.opportunity_id
  LEFT JOIN users ru                 ON ru.id = ob.reviewed_by
  LEFT JOIN LATERAL (
    SELECT i2.id, i2.identity_code, i2.status
      FROM tal_identity i2
     WHERE i2.onboarding_application_id = ob.id
     ORDER BY i2.created_at ASC
     LIMIT 1
  ) i ON TRUE`;

function toQueueRow(x: any): ReviewQueueRow {
  return {
    id: String(x.id),
    codeRef: String(x.onboarding_code_ref || ''),
    selectionId: String(x.selection_id || ''),
    selectionCode: String(x.selection_code || ''),
    personId: String(x.person_id || ''),
    personName: String(x.person_name || ''),
    personCode: String(x.person_code || ''),
    personEmail: String(x.person_email || ''),
    opportunityTitle: String(x.opportunity_title || ''),
    employmentType: x.employment_type ? String(x.employment_type) : null,
    departmentId: x.department_id ? String(x.department_id) : null,
    proposedJoiningDate: x.proposed_joining_date ? String(x.proposed_joining_date).slice(0, 10) : null,
    selectionWithdrawnAt: x.withdrawn_at ? new Date(x.withdrawn_at).toISOString() : null,
    status: String(x.status) as OnboardingStatus,
    submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
    updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : null,
    reviewedAt: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : null,
    reviewedByName: String(x.reviewed_by_name || ''),
    reviewNote: x.review_note ? String(x.review_note) : null,
    approvedAt: x.approved_at ? new Date(x.approved_at).toISOString() : null,
    identityId: x.identity_id ? String(x.identity_id) : null,
    linkedIdentityId: x.linked_identity_id ? String(x.linked_identity_id) : null,
    identityCode: x.identity_code ? String(x.identity_code) : null,
    identityStatus: x.identity_status ? String(x.identity_status) : null,
    documentCount: Number(x.document_count || 0),
    sensitiveCount: Number(x.sensitive_count || 0),
  };
}

export interface ReviewQueueFilter {
  filter?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * The review queue. RETHROWS — an empty array from here would read as "nothing to review".
 *
 * 'needs_identity' is not an onboarding status and is not stored anywhere. It lists the records where
 * THE DECISION AND THE IDENTITY DO NOT AGREE, and there are two of those, in opposite directions:
 *
 *   a) an identity row points at an application that is NOT marked approved. This is the half-done
 *      state approveOnboarding() can actually leave behind — the identity was created and the status
 *      update did not land — and it is the repairable one: the application is still 'submitted', so
 *      Approve is legal on it and the existing identity is REUSED rather than duplicated.
 *   b) an application marked approved with no identity recorded. Nothing in this module can produce
 *      it (the identity is created FIRST, on purpose) — it comes from an older approval or another
 *      writer. It is NOT repairable from the Approve button: decideReview() refuses to re-decide an
 *      approved record, and it is listed so somebody can fix it on the identity registry.
 *
 * The tab covers both, because a state nobody can list is a state nobody repairs — and because a
 * screen that offered "press Approve again" over (b) would be promising an act this desk refuses.
 */
export async function reviewQueue(filter: ReviewQueueFilter = {}): Promise<ReviewQueueRow[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 100));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const key = isReviewFilter(filter.filter) ? filter.filter : 'submitted';
    const needsIdentity = key === 'needs_identity';
    const status = key === 'all' || needsIdentity ? null : String(key);
    const q = String(filter.q || '').trim();
    const term = q || null;
    // LIKE metacharacters escaped: a search term containing a per-cent sign must not silently become
    // a match-everything scan, which on screen reads as "the filter is broken".
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(QUEUE_COLUMNS)}
      ${sql.raw(QUEUE_FROM)}
       WHERE (${status}::text IS NULL OR ob.status = ${status})
         AND (${needsIdentity}::boolean IS NOT TRUE
              OR (ob.status = 'approved' AND ob.identity_id IS NULL)
              OR (ob.status <> 'approved' AND i.id IS NOT NULL))
         AND (${term}::text IS NULL
              OR p.display_name ILIKE ${like}
              OR p.person_code ILIKE ${like}
              OR p.primary_email ILIKE ${like}
              OR ob.onboarding_code_ref ILIKE ${like}
              OR s.selection_code ILIKE ${like})
       ORDER BY ob.submitted_at DESC NULLS LAST, ob.updated_at DESC
       LIMIT ${limit} OFFSET ${offset}`));
    return rows.map(toQueueRow);
  } catch (e: any) {
    console.error('[talent-onboarding-review] reviewQueue: ' + reasonOf(e));
    throw e;
  }
}

export interface ReviewCounts {
  total: number;
  awaitingReview: number;
  inProgress: number;
  changesRequested: number;
  approved: number;
  rejected: number;
  /**
   * Marked approved with NO identity recorded on the row. Not a state this module can produce, and
   * NOT repairable from the Approve button — decideReview() refuses to re-decide an approved record.
   */
  approvedWithoutIdentity: number;
  /**
   * The other direction, and the one an approval here can actually leave behind: an identity exists
   * in the registry against an application that was never moved off 'submitted'. Repairable — press
   * Approve again and the existing identity is reused, never duplicated.
   */
  identityWithoutApproval: number;
}

/** Counts for the header. RETHROWS, for the same reason reviewQueue() does. */
export async function reviewCounts(): Promise<ReviewCounts> {
  try {
    const { db, sql } = await ctx();
    // ONE round trip, seven numbers. Seven COUNT queries against one table is the shape that made
    // page latency here a function of how many tiles a header happened to have.
    const rows = rowsOf(await db.execute(sql`
      SELECT COUNT(*)                                                  AS total,
             COUNT(*) FILTER (WHERE ob.status = 'submitted')           AS awaiting_review,
             COUNT(*) FILTER (WHERE ob.status = 'in_progress')         AS in_progress,
             COUNT(*) FILTER (WHERE ob.status = 'changes_requested')   AS changes_requested,
             COUNT(*) FILTER (WHERE ob.status = 'approved')            AS approved,
             COUNT(*) FILTER (WHERE ob.status = 'rejected')            AS rejected,
             COUNT(*) FILTER (WHERE ob.status = 'approved'
                                AND ob.identity_id IS NULL)            AS approved_without_identity,
             COUNT(*) FILTER (WHERE ob.status <> 'approved'
                                AND EXISTS (SELECT 1 FROM tal_identity i
                                             WHERE i.onboarding_application_id = ob.id))
                                                                       AS identity_without_approval
        FROM tal_onboarding_application ob`));
    const r = (rows[0] || {}) as any;
    return {
      total: Number(r.total || 0),
      awaitingReview: Number(r.awaiting_review || 0),
      inProgress: Number(r.in_progress || 0),
      changesRequested: Number(r.changes_requested || 0),
      approved: Number(r.approved || 0),
      rejected: Number(r.rejected || 0),
      approvedWithoutIdentity: Number(r.approved_without_identity || 0),
      identityWithoutApproval: Number(r.identity_without_approval || 0),
    };
  } catch (e: any) {
    console.error('[talent-onboarding-review] reviewCounts: ' + reasonOf(e));
    throw e;
  }
}

/** The organisation's own snapshot of the engagement. NEVER writable by the candidate — spec 11 r3. */
export interface OrgSnapshot {
  opportunityTitle: string;
  employmentType: string | null;
  departmentId: string | null;
  /**
   * The department's NAME, resolved from `departments`. Empty when the id names no department row.
   *
   * A reviewer deciding an admission was being shown `department_id` under the word "Department" —
   * an identifier, not a department. Resolved the way every other talent surface resolves it
   * (`LEFT JOIN departments d ON d.id = ...`, no cast: departments.id is varchar(50) and
   * tal_selection_decision.department_id is TEXT), and left EMPTY rather than back-filled with the
   * id, so the page can say which of the two it is holding.
   */
  departmentName: string;
  level: string | null;
  positionId: string | null;
  /** The position's title, from org_positions. Empty when the selection names no position. */
  positionTitle: string;
  proposedJoiningDate: string | null;
  compensationNote: string | null;
  reportingManagerName: string;
  selectionReason: string;
  decidedAt: string | null;
  decidedByName: string;
}

export interface ReviewDetail {
  row: ReviewQueueRow;
  app: OnboardingApplication;
  org: OrgSnapshot;
  /** What this engagement makes somebody, derived once, in onboarding.ts, and reused here. */
  identityType: string;
  sections: SectionView[];
  declarations: DeclarationView[];
  gaps: SubmissionGaps;
}

/**
 * One submission, assembled: the header facts, the candidate's answers, the declarations, the
 * organisation's snapshot, and what is still missing.
 *
 * RETURNS NULL only when no such row exists. A read FAILURE rethrows — "there is no such onboarding"
 * and "the database did not answer" must not arrive at the page as the same value.
 *
 * DOCUMENTS ARE NOT HERE, deliberately. The counts are (they are not sensitive), but the links are
 * fetched separately by reviewDocuments() so that a caller who has not audited the access, or does
 * not hold document.view_sensitive, cannot end up holding them by accident.
 */
export async function reviewDetail(applicationId: string): Promise<ReviewDetail | null> {
  // A reference that is not a reference is a record that does not exist, NOT a read that failed.
  // Sent to Postgres it would come back as 22P02 and be printed under the wording this desk reserves
  // for a database that did not answer.
  if (!isApplicationRef(applicationId)) return null;
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(QUEUE_COLUMNS)},
             ob.form_data, ob.sections_complete, ob.declarations,
             ob.onboarding_code_id, ob.reviewed_by,
             s.level, s.position_id, s.compensation_note, s.reason AS selection_reason,
             s.decided_at,
             COALESCE(mu.name, '')   AS reporting_manager_name,
             COALESCE(du.name, '')   AS decided_by_name,
             COALESCE(dep.name, '')  AS department_name,
             COALESCE(pos.title, '') AS position_title
      ${sql.raw(QUEUE_FROM)}
        LEFT JOIN users mu ON mu.id = s.reporting_manager_user_id
        LEFT JOIN users du ON du.id = s.decided_by_user_id
        LEFT JOIN departments dep ON dep.id = s.department_id
        LEFT JOIN org_positions pos ON pos.id = s.position_id
       WHERE ob.id = ${applicationId}::uuid
       LIMIT 1`));
    if (!rows.length) return null;
    const x = rows[0] as any;
    const row = toQueueRow(x);

    const app: OnboardingApplication = {
      id: row.id,
      onboardingCodeId: String(x.onboarding_code_id || ''),
      onboardingCodeRef: row.codeRef,
      selectionId: row.selectionId,
      personId: row.personId,
      status: row.status,
      formData: (x.form_data && typeof x.form_data === 'object') ? x.form_data : {},
      sectionsComplete: Array.isArray(x.sections_complete) ? x.sections_complete.map(String) : [],
      declarations: (x.declarations && typeof x.declarations === 'object') ? x.declarations : {},
      submittedAt: row.submittedAt,
      reviewedBy: x.reviewed_by ? String(x.reviewed_by) : null,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      approvedAt: row.approvedAt,
      identityId: row.identityId,
    };

    const identityType = identityTypeFromEmployment(row.employmentType);

    return {
      row,
      app,
      identityType,
      org: {
        opportunityTitle: row.opportunityTitle,
        employmentType: row.employmentType,
        departmentId: row.departmentId,
        departmentName: String(x.department_name || ''),
        level: x.level ? String(x.level) : null,
        positionId: x.position_id ? String(x.position_id) : null,
        positionTitle: String(x.position_title || ''),
        proposedJoiningDate: row.proposedJoiningDate,
        compensationNote: x.compensation_note ? String(x.compensation_note) : null,
        reportingManagerName: String(x.reporting_manager_name || ''),
        selectionReason: String(x.selection_reason || ''),
        decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : null,
        decidedByName: String(x.decided_by_name || ''),
      },
      sections: reviewSections(identityType, app.formData),
      declarations: declarationViews(app.declarations),
      gaps: submissionGaps(identityType, app.formData, app.declarations, row.documentCount),
    };
  } catch (e: any) {
    console.error('[talent-onboarding-review] reviewDetail: ' + reasonOf(e));
    throw e;
  }
}

/**
 * The document REFERENCES for one onboarding. RETHROWS.
 *
 * WHY NOT listDocuments() FROM onboarding.ts. That one returns [] when the read fails, which is the
 * right call on the candidate's own form — they can see their list is empty and add the link again.
 * On a review desk the same [] says "this person supplied nothing", which is a reason to refuse
 * somebody, and it would be a lie told by a failed query. Same table, same columns, opposite failure
 * requirement, so this read is its own function rather than a flag on theirs.
 *
 * THE CALLER MUST AUDIT FIRST. Spec 33.2 rule 5 and the legal-hold precedent in this codebase: the
 * audit row is written and confirmed BEFORE the link is revealed, never after.
 */
export async function reviewDocuments(applicationId: string): Promise<DocumentRef[]> {
  // Refused rather than sent to Postgres as a cast that cannot work: [] out of THIS function has to
  // keep meaning "this onboarding has no document links", and it cannot also mean "bad reference".
  if (!isApplicationRef(applicationId)) {
    throw new Error('reviewDocuments was given "' + String(applicationId) + '", which is not an onboarding reference.');
  }
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, subject_kind, subject_id, person_id, doc_type, title, drive_url, is_sensitive,
             status, version, replaces_id, expires_on, review_note, reviewed_by, reviewed_at
        FROM tal_document_ref
       WHERE subject_kind = 'onboarding' AND subject_id = ${applicationId}::uuid
         AND status <> 'replaced'
       ORDER BY is_sensitive DESC, created_at ASC`));
    return rows.map((x: any) => ({
      id: String(x.id),
      subjectKind: 'onboarding' as const,
      subjectId: String(x.subject_id),
      personId: String(x.person_id),
      docType: String(x.doc_type),
      title: String(x.title || ''),
      driveUrl: String(x.drive_url),
      isSensitive: x.is_sensitive === true,
      status: String(x.status) as DocumentRef['status'],
      version: Number(x.version || 1),
      replacesId: x.replaces_id ? String(x.replaces_id) : null,
      expiresOn: x.expires_on ? String(x.expires_on).slice(0, 10) : null,
      reviewNote: x.review_note ? String(x.review_note) : null,
      reviewedBy: x.reviewed_by ? String(x.reviewed_by) : null,
      reviewedAt: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : null,
    }));
  } catch (e: any) {
    console.error('[talent-onboarding-review] reviewDocuments: ' + reasonOf(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// DECISIONS
// ---------------------------------------------------------------------------------------------

export interface ApprovalOutcome {
  ok: boolean;
  error?: string;
  /**
   * The full record, and ONLY when this call created it. A reused identity is reported through
   * identityId/identityCode below rather than reconstructed from two columns and passed off as a
   * complete Identity — a half-populated object of that shape is exactly how a caller ends up
   * rendering an empty department as though it were an empty department.
   */
  identity?: Identity;
  identityId?: string;
  identityCode?: string;
  /** The identity exists and the application could NOT be marked approved. Approve again to finish. */
  needsRepair?: boolean;
  /** The identity already existed when this ran — a previous attempt got half way. */
  reusedIdentity?: boolean;
  /** The decision stands, but the audit row did not. Surfaced, never swallowed. */
  auditWarning?: string;
}

/**
 * APPROVE: close the admission and create the organizational identity.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO WRITES, TWO MODULES, NO TRANSACTION — AND WHY THAT IS THE HONEST CHOICE
 * ---------------------------------------------------------------------------------------------
 * The spec (section 7) draws approval and identity creation as one arrow, and one transaction would
 * be the ideal shape. It is not available: createIdentityFromOnboarding() lives in
 * src/lib/talent/identity.ts, owns its own statements and takes no transaction handle, so there is
 * no seam to pass one through. Wrapping only MY update in a transaction would buy nothing — it is
 * a single statement, which is already atomic.
 *
 * So the two writes are ORDERED so that the failure is visible and recoverable:
 *
 *   1. Create the identity FIRST, while the application still says 'submitted'.
 *   2. Mark the application approved and record the identity on it.
 *
 * If step 1 fails, NOTHING has happened: the row is untouched, it is still in the queue, and the
 * reviewer is told the approval did not go through. That is the common failure and it leaves no
 * half-state at all.
 *
 * If step 2 fails, the identity exists and the application still says 'submitted' — so it stays in
 * the queue where somebody will look at it again. To make that retry SAFE rather than a machine for
 * minting duplicate identities, this function looks for an existing identity on the application
 * BEFORE creating one, and reuses it. A second approval attempt therefore completes the half-done
 * work instead of doubling it.
 *
 * The opposite order — flip the status first, then create the identity — was rejected precisely
 * because its failure mode is invisible: the screen would say "Approved" over a person who does not
 * exist in the organisation, which is the divergence between reported success and observable result
 * that CLAUDE.md's verification section is written about.
 *
 * A GREEN MESSAGE IS NEVER RETURNED OVER A HALF-DONE ADMISSION. ok is false whenever either half is
 * missing, and the message says which half happened.
 */
export async function approveOnboarding(
  applicationId: string,
  actorUserId: string,
): Promise<ApprovalOutcome> {
  const id = String(applicationId || '').trim();
  const actor = String(actorUserId || '').trim();
  if (!id) return { ok: false, error: 'No onboarding was named.' };
  if (!actor) return { ok: false, error: 'An approval has to carry the name of the person making it.' };
  if (!isApplicationRef(id)) {
    return { ok: false, error: 'That is not an onboarding reference, so nothing has been approved.' };
  }
  if (!isApplicationRef(actor)) {
    return { ok: false, error: 'The reviewer could not be identified, so nothing has been approved.' };
  }

  let db: any;
  let sql: any;
  let current: any;
  try {
    const c = await ctx();
    db = c.db; sql = c.sql;
    const cur = rowsOf(await db.execute(sql`
      SELECT ob.id, ob.status, ob.identity_id, ob.selection_id, ob.person_id,
             s.employment_type, s.proposed_joining_date, s.withdrawn_at
        FROM tal_onboarding_application ob
        LEFT JOIN tal_selection_decision s ON s.id = ob.selection_id
       WHERE ob.id = ${id}::uuid LIMIT 1`));
    if (!cur.length) {
      return { ok: false, error: 'That onboarding record could not be found. Nothing has been changed.' };
    }
    current = cur[0];
  } catch (e: any) {
    return { ok: false, error: 'The onboarding could not be read, so nothing was approved: ' + reasonOf(e) };
  }

  const gate = decideReview(String(current.status), 'approve');
  if (!gate.allowed) return { ok: false, error: gate.reason };

  if (current.withdrawn_at) {
    return {
      ok: false,
      error: 'The selection behind this onboarding has been withdrawn, so nobody can be admitted on '
        + 'it. Reinstate the selection first if the withdrawal was wrong.',
    };
  }

  // Does an identity already exist for this application? Two ways it can: a previous approval got
  // half way, or somebody created it directly on the identity registry. Either way, creating a
  // second one is the failure this check exists to prevent.
  let identity: Identity | undefined;
  let identityId = '';
  let identityCode = '';
  let reused = false;
  try {
    const existing = rowsOf(await db.execute(sql`
      SELECT id, identity_code FROM tal_identity
       WHERE onboarding_application_id = ${id}::uuid
       ORDER BY created_at ASC LIMIT 1`));
    if (existing.length) {
      reused = true;
      identityId = String((existing[0] as any).id);
      identityCode = String((existing[0] as any).identity_code || '');
    }
  } catch (e: any) {
    return {
      ok: false,
      error: 'Could not check whether an identity already exists for this onboarding, and creating a '
        + 'second one is not a risk worth taking. Nothing has been changed: ' + reasonOf(e),
    };
  }

  if (!identityId) {
    // Resolved here, not imported at the top of the file. If this deployment has no identity
    // registry in it, the approval is REFUSED and says so — it does not flip a status and leave
    // "Approved" standing over somebody who was never given an identity.
    const registry = await identityRegistry();
    const createIdentity = registry.fn;
    if (!createIdentity) {
      return {
        ok: false,
        error: 'This onboarding has NOT been approved and nothing was changed. ' + registry.problem
          + ' An approval without an identity would mark somebody admitted who does not exist in the '
          + 'organisation.',
      };
    }

    // The identity type and the start date are passed EXPLICITLY, from the selection snapshot this
    // screen has already shown the reviewer. Leaving them to be derived again inside identity.ts
    // would mean the screen promises one thing and the registry records another the day the two
    // derivations drift; identityTypeFromEmployment() is the single mapping and both sides use it.
    let created: any;
    try {
      created = await createIdentity({
        onboardingApplicationId: id,
        actorUserId: actor,
        identityType: identityTypeFromEmployment(current.employment_type),
        startDate: current.proposed_joining_date ? String(current.proposed_joining_date).slice(0, 10) : null,
      });
    } catch (e: any) {
      return {
        ok: false,
        error: 'The identity registry threw while creating the identity, so this onboarding has NOT '
          + 'been approved: ' + reasonOf(e) + '. If an identity was nevertheless created, pressing '
          + 'Approve again reuses it rather than minting a second.',
      };
    }
    if (!created || typeof created.ok !== 'boolean') {
      return {
        ok: false,
        error: 'The identity registry answered in a shape this desk does not recognise, so nothing '
          + 'here can say whether an identity was created. This onboarding has NOT been marked '
          + 'approved. Check src/lib/talent/identity.ts against createIdentityFromOnboarding() as it '
          + 'is called from src/lib/talent/onboarding-review.ts before approving again.',
      };
    }
    if (!created.ok || !created.data) {
      return {
        ok: false,
        error: 'The identity could not be created, so this onboarding has NOT been approved and '
          + 'nothing was changed: ' + (created.error || 'unknown reason'),
      };
    }
    identity = created.data;
    identityId = String(created.data.id || '');
    identityCode = String(created.data.identityCode || '');
    if (!identityId) {
      return {
        ok: false,
        error: 'The identity registry reported success but returned no identity, so this onboarding '
          + 'has NOT been approved. Check the identity registry before trying again.',
      };
    }
  }

  // Step 2. Guarded on status = 'submitted' so two reviewers pressing Approve at the same moment
  // cannot both record a decision; the loser is told the state moved under them.
  let moved: any[] = [];
  try {
    moved = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_application
         SET status = 'approved', approved_at = NOW(), identity_id = ${identityId}::uuid,
             reviewed_by = ${actor}::uuid, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ${id}::uuid AND status = 'submitted'
       RETURNING id`));
  } catch (e: any) {
    await logAudit({
      userId: actor, action: 'onboarding.approval_half_done',
      entity: 'tal_onboarding_application', entityId: id,
      diff: { identityId, identityCode, reason: reasonOf(e) },
    });
    return {
      ok: false, needsRepair: true, identity, identityId, identityCode,
      error: 'HALF DONE. The identity ' + (identityCode || identityId) + ' WAS created, but '
        + 'this onboarding could not be marked approved: ' + reasonOf(e) + '. Nothing is lost — press '
        + 'Approve again and the identity that already exists will be reused, not duplicated.',
    };
  }

  if (!moved.length) {
    await logAudit({
      userId: actor, action: 'onboarding.approval_half_done',
      entity: 'tal_onboarding_application', entityId: id,
      diff: { identityId, identityCode, reason: 'status moved under the update' },
    });
    return {
      ok: false, needsRepair: true, identity, identityId, identityCode,
      error: 'HALF DONE. The identity ' + (identityCode || identityId) + ' WAS created, but '
        + 'the onboarding was no longer marked submitted when the approval was written, so its status '
        + 'was not changed. Somebody may have decided it at the same moment. Reload before acting '
        + 'again; the existing identity will be reused, not duplicated.',
    };
  }

  // The decision is recorded. From here on the work stands, and anything that fails is REPORTED
  // rather than allowed to unwind an admission.
  const audit = await logAudit({
    userId: actor,
    action: 'onboarding.approved',
    entity: 'tal_onboarding_application',
    entityId: id,
    diff: {
      identityId,
      identityCode: identityCode || null,
      reusedExistingIdentity: reused,
      reason: reused
        ? 'Onboarding reviewed and approved; the identity from an earlier half-completed approval was reused.'
        : 'Onboarding reviewed and approved; organizational identity created.',
    },
  });

  // ONBOARDING_APPROVED only. Not ONBOARDING_COMPLETED: the catalogue reserves that for the end of
  // the whole journey — identity created AND access proposed — and access provisioning is a separate
  // act on a separate desk (spec 7, spec 35). Emitting it here would tell every subscriber that
  // somebody is provisioned when nobody has looked at their access yet.
  await emitTalentEvent(
    TALENT_EVENTS.ONBOARDING_APPROVED,
    TALENT_SUBJECT_KINDS.ONBOARDING,
    id,
    { identityId, reusedExistingIdentity: reused },
    actor,
  );

  return {
    ok: true,
    identity,
    identityId,
    identityCode,
    reusedIdentity: reused,
    auditWarning: audit.ok ? undefined
      : 'The approval went through, but the audit entry for it did not: ' + (audit.error || 'unknown reason'),
  };
}

export interface RejectionOutcome extends TalentResult<undefined> {
  auditWarning?: string;
}

/**
 * REJECT: close the admission, with a reason the person can be told.
 *
 * NOT THE SAME ACT AS requestChanges(). That one reopens the form and expects the candidate back;
 * this one ends it. Nothing here reopens, no identity is created, and the reason is stored in
 * review_note because it is the sentence somebody will read.
 *
 * The code is already spent by this point — submitOnboarding() consumes it — so a rejection does not
 * need to revoke anything. Nothing in this function can let the candidate back in, which is the
 * point of it.
 */
export async function rejectOnboarding(
  applicationId: string,
  actorUserId: string,
  reason: string,
): Promise<RejectionOutcome> {
  const id = String(applicationId || '').trim();
  const actor = String(actorUserId || '').trim();
  const why = String(reason || '').trim();
  if (!id) return { ok: false, error: 'No onboarding was named.' };
  if (!actor) return { ok: false, error: 'A rejection has to carry the name of the person making it.' };

  const problem = rejectionProblem(why);
  if (problem) return { ok: false, error: problem };

  if (!isApplicationRef(id)) {
    return { ok: false, error: 'That is not an onboarding reference, so nothing has been changed.' };
  }
  if (!isApplicationRef(actor)) {
    return { ok: false, error: 'The reviewer could not be identified, so nothing has been changed.' };
  }

  try {
    const { db, sql } = await ctx();

    const cur = rowsOf(await db.execute(sql`
      SELECT status FROM tal_onboarding_application WHERE id = ${id}::uuid LIMIT 1`));
    if (!cur.length) {
      return { ok: false, error: 'That onboarding record could not be found. Nothing has been changed.' };
    }
    const gate = decideReview(String((cur[0] as any).status), 'reject');
    if (!gate.allowed) return { ok: false, error: gate.reason };

    const moved = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_application
         SET status = 'rejected', reviewed_by = ${actor}::uuid, reviewed_at = NOW(),
             review_note = ${why.slice(0, 2000)},
             session_token_hash = NULL, session_expires_at = NULL, updated_at = NOW()
       WHERE id = ${id}::uuid AND status = 'submitted'
       RETURNING id`));
    if (!moved.length) {
      return {
        ok: false,
        error: 'The onboarding was no longer marked submitted when the rejection was written, so '
          + 'nothing was changed. Reload and look at its current state before acting again.',
      };
    }

    const audit = await logAudit({
      userId: actor,
      action: 'onboarding.rejected',
      entity: 'tal_onboarding_application',
      entityId: id,
      diff: { reason: why.slice(0, 2000) },
    });

    // NO EVENT IS EMITTED. The catalogue in src/lib/talent/events.ts has no name for a rejected
    // onboarding, emitTalentEvent() refuses a name it does not know, and inventing one here would put
    // a string into tal_event that nothing subscribes to and no ops screen lists. The audit row above
    // is the record. Adding the name belongs in events.ts, which this module does not own.

    return {
      ok: true,
      auditWarning: audit.ok ? undefined
        : 'The rejection was recorded, but the audit entry for it was not: ' + (audit.error || 'unknown reason'),
    };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}
