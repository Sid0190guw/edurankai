// src/lib/talent/types.ts — THE OWNED CONTRACT for the Talent-to-Organization platform.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md
//
// Every module under src/lib/talent/ imports its shapes from here and NOTHING defines its own copy.
// Extend this file additively — a second definition of CandidateStatus somewhere else is how two
// screens end up disagreeing about what "selected" means.
//
// NOTHING IN THIS FILE TOUCHES THE DATABASE. It is types, unions, labels and pure helpers, so the
// arithmetic below can be unit-tested without a connection. src/lib/db/index.ts is deliberately not
// imported: a transitive import of the connection has already made pure logic untestable here once.

// ---------------------------------------------------------------------------------------------
// IDENTIFIERS — spec section 26A.
//
// F10: the brief used ERAI-INT-* for BOTH an internship opportunity and an intern identity. Two
// namespaces, one segment, and both get pasted into the same search box. Opportunities take OPP.
// ---------------------------------------------------------------------------------------------

export const ID_PREFIX = {
  person: 'ERAI-PER',
  candidate: 'ERAI-CAN',
  application: 'ERAI-APP',
  opportunity: 'ERAI-OPP',
  selection: 'ERAI-SEL',
  onboarding: 'ERAI-ONB',
  onboardingCode: 'ERAI-ONBCODE',
  employee: 'ERAI-EMP',
  intern: 'ERAI-INT',
  fellow: 'ERAI-FEL',
  member: 'ERAI-MEM',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** Series that carry NO year segment: an identity outlives the year it was issued in. */
export const YEARLESS_SERIES: readonly IdKind[] = ['employee', 'intern', 'fellow', 'member'];

/** Zero-padding width per identifier kind. */
export const ID_PAD: Record<IdKind, number> = {
  person: 6, candidate: 6, application: 6, opportunity: 5, selection: 6,
  onboarding: 6, onboardingCode: 6, employee: 6, intern: 6, fellow: 6, member: 6,
};

// ---------------------------------------------------------------------------------------------
// IDENTITY TYPES AND SERIES
// ---------------------------------------------------------------------------------------------

export const IDENTITY_TYPES = [
  'employee', 'intern', 'fellow', 'member',
  'contractor', 'consultant', 'volunteer', 'campus_ambassador',
] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export const IDENTITY_TYPE_LABELS: Record<IdentityType, string> = {
  employee: 'Employee',
  intern: 'Intern',
  fellow: 'Fellow',
  member: 'Member',
  contractor: 'Contractor',
  consultant: 'Consultant',
  volunteer: 'Volunteer',
  campus_ambassador: 'Campus ambassador',
};

/**
 * Which code series an identity type draws from. The four primary types have their own; everything
 * else is registered on the employee series, because inventing a series per engagement produces
 * codes nobody can read and a counter nobody maintains.
 */
export const SERIES_FOR_TYPE: Record<IdentityType, IdKind> = {
  employee: 'employee',
  intern: 'intern',
  fellow: 'fellow',
  member: 'member',
  contractor: 'employee',
  consultant: 'employee',
  volunteer: 'member',
  campus_ambassador: 'member',
};

// ---------------------------------------------------------------------------------------------
// CANDIDATE STATUS — spec section 24.
//
// DERIVED, never typed independently. deriveCandidateStatus() below is the only correct way to
// compute it; a status column that can disagree with the stage history is two sources of truth.
// ---------------------------------------------------------------------------------------------

export const CANDIDATE_STATUSES = [
  'application_received', 'under_review', 'shortlisted',
  'assessment_pending', 'assessment_completed',
  'interview_pending', 'interview_completed',
  'final_review',
  'selected', 'waitlisted', 'rejected',
  'onboarding_invited', 'onboarding_started', 'onboarding_pending', 'onboarding_approved',
  'active',
  'withdrawn',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  application_received: 'Application received',
  under_review: 'Under review',
  shortlisted: 'Shortlisted',
  assessment_pending: 'Assessment pending',
  assessment_completed: 'Assessment completed',
  interview_pending: 'Interview pending',
  interview_completed: 'Interview completed',
  final_review: 'Final review',
  selected: 'Selected',
  waitlisted: 'Waitlisted',
  rejected: 'Not selected',
  onboarding_invited: 'Invited to onboarding',
  onboarding_started: 'Onboarding started',
  onboarding_pending: 'Onboarding under review',
  onboarding_approved: 'Onboarding approved',
  active: 'Active',
  withdrawn: 'Withdrawn',
};

/** The only status a candidate may set on themselves. Spec 24 rule 1. */
export const CANDIDATE_SELF_SETTABLE: readonly CandidateStatus[] = ['withdrawn'];

/** Nothing moves out of these except by an explicit, reasoned correction. */
export const CANDIDATE_TERMINAL: readonly CandidateStatus[] = ['rejected', 'withdrawn', 'active'];

export function candidateStatusLabel(s: string): string {
  return (CANDIDATE_STATUS_LABELS as Record<string, string>)[s] || s;
}

export function isCandidateStatus(v: unknown): v is CandidateStatus {
  return typeof v === 'string' && (CANDIDATE_STATUSES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// THE SIX-STEP TRACKER BRIDGE — spec F4 and section 24 rule 8.
//
// /policy/recruitment publishes "Six steps. No surprises." and src/lib/application-stages.ts is the
// implementation candidates already see. Custom pipelines must not break that page, so the mapping
// from the richer status model back to the six published steps is a PURE FUNCTION with a test.
// ---------------------------------------------------------------------------------------------

export type LegacyStageKey =
  | 'submitted' | 'review' | 'assessment' | 'interview' | 'decision' | 'onboarded'
  | 'decision_no' | 'withdrawn';

export function legacyStageForStatus(status: CandidateStatus): LegacyStageKey {
  switch (status) {
    case 'application_received': return 'submitted';
    case 'under_review':
    case 'shortlisted': return 'review';
    case 'assessment_pending':
    case 'assessment_completed': return 'assessment';
    case 'interview_pending':
    case 'interview_completed': return 'interview';
    case 'final_review':
    case 'selected':
    case 'waitlisted': return 'decision';
    case 'rejected': return 'decision_no';
    case 'withdrawn': return 'withdrawn';
    case 'onboarding_invited':
    case 'onboarding_started':
    case 'onboarding_pending':
    case 'onboarding_approved':
    case 'active': return 'onboarded';
  }
}

// ---------------------------------------------------------------------------------------------
// PIPELINE — spec section 6A.
// ---------------------------------------------------------------------------------------------

export const STAGE_TYPES = [
  'screening', 'review', 'assessment', 'assignment', 'functional_evaluation',
  'interview', 'panel', 'final_review', 'decision',
] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const STAGE_TYPE_LABELS: Record<StageType, string> = {
  screening: 'Eligibility screening',
  review: 'Initial review',
  assessment: 'Assessment',
  assignment: 'Assignment',
  functional_evaluation: 'Functional evaluation',
  interview: 'Interview',
  panel: 'Panel evaluation',
  final_review: 'Final review',
  decision: 'Selection decision',
};

/**
 * Which evaluation record a stage type EXPECTS. A stage whose evaluation is missing is an
 * incomplete stage, not a silent pass — spec 6A "Stage types".
 */
export const STAGE_EXPECTS_EVALUATION: Record<StageType, EvaluationType | 'interview' | null> = {
  screening: null,
  review: null,
  assessment: 'assessment',
  assignment: 'assignment',
  functional_evaluation: 'functional',
  interview: 'interview',
  panel: 'interview',
  final_review: null,
  decision: null,
};

export interface PipelineStage {
  id: string;
  pipelineId: string;
  ordinal: number;
  key: string;
  label: string;
  candidateBlurb: string;
  stageType: StageType;
  ownerRole: string | null;
  slaHours: number | null;
  isTerminal: boolean;
  config: Record<string, any>;
}

export interface Pipeline {
  id: string;
  slug: string;
  name: string;
  version: number;
  isDefault: boolean;
  isActive: boolean;
  stages: PipelineStage[];
}

export type StageOutcome = 'pass' | 'fail' | 'waived' | 'reverted';

export interface ApplicationStage {
  id: string;
  applicationId: string;
  stageKey: string;
  ordinal: number;
  enteredAt: string;
  dueAt: string | null;
  completedAt: string | null;
  outcome: StageOutcome | null;
  ownerUserId: string | null;
  note: string | null;
  actorUserId: string | null;
}

// ---------------------------------------------------------------------------------------------
// EVALUATION AND INTERVIEW — spec section 26.4.
//
// F12: recommendation is ADVISORY. Nothing derived from it may write a selection decision.
// ---------------------------------------------------------------------------------------------

export const EVALUATION_TYPES = ['assessment', 'assignment', 'functional', 'portfolio'] as const;
export type EvaluationType = (typeof EVALUATION_TYPES)[number];

export type EvaluationRecommendation = 'advance' | 'hold' | 'decline';
export type EvaluationStatus = 'pending' | 'submitted' | 'waived';

export interface Evaluation {
  id: string;
  applicationId: string;
  stageKey: string;
  evaluationType: EvaluationType;
  evaluatorUserId: string | null;
  rubric: Record<string, any>;
  scores: Record<string, number>;
  totalScore: number | null;
  /** ADVISORY ONLY. A human decides — spec F12. */
  recommendation: EvaluationRecommendation | null;
  comments: string | null;
  isAutomated: boolean;
  status: EvaluationStatus;
  submittedAt: string | null;
}

export interface Interview {
  id: string;
  applicationId: string;
  stageKey: string;
  scheduledAt: string | null;
  durationMinutes: number | null;
  mode: 'online' | 'in_person' | null;
  panel: string[];
  outcome: string | null;
  notes: string | null;
  recordedBy: string | null;
}

// ---------------------------------------------------------------------------------------------
// SELECTION — spec section 26.4.
// ---------------------------------------------------------------------------------------------

export type SelectionDecisionValue = 'selected' | 'waitlisted' | 'rejected';

export interface SelectionDecision {
  id: string;
  selectionCode: string;
  applicationId: string;
  personId: string;
  opportunityId: string;
  decision: SelectionDecisionValue;
  reason: string;
  /** NOT NULL in the schema. There is no automated-selection path — spec F12. */
  decidedByUserId: string;
  decidedAt: string;
  // The organisational snapshot the onboarding form renders read-only.
  positionId: string | null;
  departmentId: string | null;
  employmentType: string | null;
  level: string | null;
  reportingManagerUserId: string | null;
  proposedJoiningDate: string | null;
  compensationNote: string | null;
  approvedForOnboardingAt: string | null;
  approvedForOnboardingBy: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
}

// ---------------------------------------------------------------------------------------------
// ONBOARDING CODE — spec section 16. The load-bearing module.
// ---------------------------------------------------------------------------------------------

export type OnboardingCodeStatus = 'active' | 'consumed' | 'expired' | 'revoked' | 'closed';

/**
 * Every way a redemption can be refused. The CANDIDATE is told one thing for all of the rejecting
 * outcomes (see UNIFORM_REJECTION) — spec 16.5. This union exists for the audit log and the admin
 * console, which are entitled to the truth.
 */
export type RedeemOutcome =
  | 'ok'
  | 'unknown'
  | 'expired'
  | 'revoked'
  | 'exhausted'
  | 'not_yet_valid'
  | 'subject_mismatch'
  | 'selection_not_approved'
  | 'selection_withdrawn'
  | 'rate_limited';

/**
 * ONE MESSAGE FOR EVERY FAILURE. Wrong, expired, revoked, exhausted and never-existed must be
 * indistinguishable, or the endpoint is an oracle telling an attacker which codes are real.
 */
export const UNIFORM_REJECTION =
  'That code is not valid for onboarding. If you were told to expect one, reply to the message you '
  + 'received from EduRankAI and the people desk will check it for you.';

/**
 * Unambiguous alphabet: no 0/O and no 1/I. 32 symbols, 15 characters, ~75 bits — spec 16.1.
 *
 * L IS IN THIS ALPHABET, AND THIS COMMENT USED TO SAY IT WAS NOT. Every surface that tells a
 * candidate which characters a code cannot contain either reads CODE_ALPHABET or repeats this
 * sentence, and /apply/gateway repeated the wrong version — telling somebody holding a perfectly
 * good code containing L that they had mistyped it. Dropping L from the alphabet instead would make
 * every already-issued code containing one permanently unredeemable, so the alphabet is canonical
 * and the words follow it. Count it: 8 digits plus 24 letters, I and O removed, is 32.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_GROUP_LEN = 5;
export const CODE_GROUPS = 3;
export const CODE_BODY_LEN = CODE_GROUP_LEN * CODE_GROUPS;

/**
 * The human-facing prefix a code is DISPLAYED with: ERA-SEL-XXXXX-XXXXX-XXXXX.
 *
 * NOT PART OF THE SECRET AND NEVER STORED. formatSecret() adds it, normaliseCode() strips it, and
 * the hash is taken over the 15-character body alone — so a code issued before this prefix existed
 * still redeems, and a candidate who pastes the prefix and one who drops it both get in.
 *
 * IT EXISTS BECAUSE THE FRONT DOOR ALREADY PROMISED IT. /apply/gateway has told every candidate
 * since launch that they were "sent a code beginning ERA-SEL", while issueCode() minted a bare body
 * with no prefix at all — so the people desk was sharing codes that did not look like the thing the
 * candidate had been told to expect. One of the two had to become true. Making the display match
 * the promise costs no entropy and breaks nothing already issued.
 */
export const CODE_DISPLAY_PREFIX = 'ERA-SEL';

export const CODE_LIMITS = {
  /** Per IP, per window. Spec 16.5. */
  perIpAttempts: 5,
  perIpWindowMinutes: 10,
  /** Lifetime failures against one code before it auto-revokes. */
  perCodeFailures: 10,
  /** Failures from one IP inside the window before a CAPTCHA is demanded. */
  captchaAfter: 3,
  /** Default validity at issue, and the hard ceiling an extension may not pass. */
  defaultValidityDays: 14,
  maxValidityDays: 60,
  /** Sensitive positions: tighter on both axes. Spec 16.2. */
  sensitiveMaxValidityDays: 7,
  sensitiveMaxUses: 1,
} as const;

export interface OnboardingCode {
  id: string;
  codeId: string;
  codePrefix: string;
  selectionId: string;
  personId: string;
  boundEmailNorm: string;
  opportunityId: string;
  positionId: string | null;
  departmentId: string | null;
  employmentType: string | null;
  maxUses: number;
  usedCount: number;
  requiresIdentityConfirmation: boolean;
  validFrom: string;
  validUntil: string;
  status: OnboardingCodeStatus;
  multiUseReason: string | null;
  issuedBy: string;
  issuedAt: string;
  deliveredAt: string | null;
  deliveryChannel: string | null;
  deliveryError: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  supersedesCodeId: string | null;
  failedAttempts: number;
}

/** What issue() hands back. The secret appears here ONCE and is never persisted in plaintext. */
export interface IssuedCode {
  code: OnboardingCode;
  /** Shown exactly once, to the issuing administrator. Never logged, never emailed in a link. */
  secret: string;
}

// ---------------------------------------------------------------------------------------------
// ONBOARDING APPLICATION AND DOCUMENTS — spec sections 11 and 33.
// ---------------------------------------------------------------------------------------------

export const ONBOARDING_STATUSES = [
  'in_progress', 'submitted', 'changes_requested', 'approved', 'rejected', 'suspended', 'expired',
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  in_progress: 'In progress',
  submitted: 'Submitted for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Not approved',
  suspended: 'Suspended',
  expired: 'Expired',
};

/**
 * The form, section by section. `orgControlled` sections render READ-ONLY from the selection
 * snapshot — spec 11 rule 3. A candidate POSTing at them is refused server-side, not merely
 * prevented by a disabled input.
 */
export const ONBOARDING_SECTIONS = [
  { key: 'personal', label: 'Personal information', orgControlled: false },
  { key: 'identity', label: 'Identity information', orgControlled: false },
  { key: 'academic', label: 'Academic information', orgControlled: false },
  { key: 'professional', label: 'Professional information', orgControlled: false },
  { key: 'organizational', label: 'Your position at EduRankAI', orgControlled: true },
  { key: 'documents', label: 'Documents', orgControlled: false },
  { key: 'declarations', label: 'Declarations', orgControlled: false },
] as const;
export type OnboardingSectionKey = (typeof ONBOARDING_SECTIONS)[number]['key'];

/** Fields the organisation owns. Sourced from the selection record; never writable by a candidate. */
export const ORG_CONTROLLED_FIELDS: readonly string[] = [
  'position', 'positionId', 'department', 'departmentId', 'employmentType', 'level',
  'reportingManager', 'reportingManagerUserId', 'joiningDate', 'compensation', 'identityType',
];

export interface OnboardingApplication {
  id: string;
  onboardingCodeId: string;
  onboardingCodeRef: string;
  selectionId: string;
  personId: string;
  status: OnboardingStatus;
  formData: Record<string, any>;
  sectionsComplete: string[];
  declarations: Record<string, any>;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  approvedAt: string | null;
  identityId: string | null;
}

export type DocumentStatus = 'submitted' | 'verified' | 'rejected' | 'replaced' | 'expired';

export interface DocumentRef {
  id: string;
  subjectKind: 'onboarding' | 'identity' | 'candidate';
  subjectId: string;
  personId: string;
  docType: string;
  title: string;
  driveUrl: string;
  /** Identity-class documents. Gated behind document.view_sensitive — spec 33.2 rule 4. */
  isSensitive: boolean;
  status: DocumentStatus;
  version: number;
  replacesId: string | null;
  expiresOn: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/**
 * Which document types carry identity-class data. Spec 33: these are flagged sensitive on write, so
 * a reviewer needs document.view_sensitive and the read is audited BEFORE the link is revealed.
 */
export const SENSITIVE_DOC_TYPES: readonly string[] = ['identity', 'tax_registration'];

// ---------------------------------------------------------------------------------------------
// ORGANIZATIONAL STATUS — spec section 25.
// ---------------------------------------------------------------------------------------------

export const IDENTITY_STATUSES = [
  'invited_for_onboarding', 'onboarding_started', 'onboarding_pending', 'verification',
  'active', 'on_leave', 'suspended', 'notice', 'exited', 'terminated', 'archived', 'converted',
] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export const IDENTITY_STATUS_LABELS: Record<IdentityStatus, string> = {
  invited_for_onboarding: 'Invited for onboarding',
  onboarding_started: 'Onboarding started',
  onboarding_pending: 'Onboarding pending',
  verification: 'Verification',
  active: 'Active',
  on_leave: 'On leave',
  suspended: 'Suspended',
  notice: 'Serving notice',
  exited: 'Exited',
  terminated: 'Terminated',
  archived: 'Archived',
  converted: 'Converted to another identity',
};

/**
 * THE ACCESS GATE. Spec 21.2: gate(identity_status) is evaluated FIRST — a non-active identity
 * resolves to the empty set before any other term is computed. A suspended department head is not
 * a department head.
 *
 * `notice` keeps access until the last working day; the scheduled revocation handles the rest, so
 * nobody has to remember. `on_leave` keeps ACCESS but loses APPROVAL AUTHORITY — that second part
 * is holdsApprovalAuthority() below, not this function.
 */
export function statusGrantsAccess(status: IdentityStatus): boolean {
  return status === 'active' || status === 'notice';
}

/** Spec 25 rule 2: an approval queue must not silently wait on somebody who is away. */
export function holdsApprovalAuthority(status: IdentityStatus): boolean {
  return status === 'active';
}

export function canSignIn(status: IdentityStatus): boolean {
  return status === 'active' || status === 'on_leave' || status === 'notice';
}

export interface Identity {
  id: string;
  identityCode: string;
  codeSeries: string;
  codeIsLegacy: boolean;
  personId: string;
  identityType: IdentityType;
  employmentType: string | null;
  userId: string | null;
  hrEmployeeId: string | null;
  username: string | null;
  workEmail: string | null;
  departmentId: string | null;
  positionId: string | null;
  status: IdentityStatus;
  startDate: string | null;
  endDate: string | null;
  onboardingApplicationId: string | null;
  selectionId: string | null;
  previousIdentityId: string | null;
  statusReason: string | null;
}

// ---------------------------------------------------------------------------------------------
// ACCESS — spec sections 21 to 23.
// ---------------------------------------------------------------------------------------------

export type AccessClassification = 'public' | 'internal' | 'restricted' | 'classified';

export type AccessSource = 'department' | 'position' | 'type' | 'manual' | 'request';

export interface AccessGroup {
  id: string;
  key: string;
  name: string;
  description: string;
  departmentId: string | null;
  classification: AccessClassification;
  /** Permission keys from src/lib/auth/permissions.ts. Never a second vocabulary. */
  capabilities: string[];
  systems: string[];
  isActive: boolean;
}

export interface AccessPolicy {
  id: string;
  subjectKind: 'department' | 'position' | 'identity_type';
  subjectKey: string;
  accessGroupId: string;
  version: number;
  isActive: boolean;
  changeReason: string | null;
}

export interface GrantedAccess {
  accessGroupId: string;
  source: AccessSource;
  reason: string | null;
  validUntil: string | null;
}

/** What evaluateAccess() returns — a proposal, with the reason for every element. Spec 23.2. */
export interface AccessProposal {
  identityId: string;
  granted: GrantedAccess[];
  /** Empty-set explanation when status gates everything off, so a screen never shows a bare zero. */
  gatedReason: string | null;
}

export type ProvisioningStatus =
  | 'proposed' | 'awaiting_review' | 'approved' | 'provisioning'
  | 'provisioned' | 'partially_failed' | 'failed';

export type AccessRequestStatus =
  | 'pending' | 'manager' | 'department' | 'security' | 'approved' | 'rejected' | 'expired';

export const ACCESS_REQUEST_LIMITS = {
  defaultGrantDays: 90,
  maxGrantDays: 365,
} as const;

// ---------------------------------------------------------------------------------------------
// RECRUITMENT SOURCES — spec section 15.
//
// F5: PROVENANCE (the system an application arrived through), never ATTRIBUTION ("how did you hear
// about us", which is src/lib/application-sources.ts and stays where it is). Merging them
// double-counts every source report.
// ---------------------------------------------------------------------------------------------

export const SOURCE_CATEGORIES = [
  'platform', 'government', 'institution', 'referral', 'community', 'partner', 'direct',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const INGEST_MODES = ['api', 'webhook', 'csv', 'manual'] as const;
export type IngestMode = (typeof INGEST_MODES)[number];

export interface RecruitmentSource {
  id: string;
  slug: string;
  /** Internal display only. NEVER rendered on a public surface — spec 15 rule 6. */
  name: string;
  category: SourceCategory;
  ingestMode: IngestMode;
  isActive: boolean;
}

// ---------------------------------------------------------------------------------------------
// OPPORTUNITY — spec section 5A.
// ---------------------------------------------------------------------------------------------

export type OpportunityStatus = 'draft' | 'published' | 'unpublished' | 'closed' | 'archived';

export const COMPENSATION_KINDS = ['unpaid', 'stipend', 'salary', 'grant'] as const;
export type CompensationKind = (typeof COMPENSATION_KINDS)[number];

export interface Opportunity {
  id: string;
  opportunityCode: string;
  positionId: string | null;
  departmentId: string;
  roleId: string | null;
  title: string;
  employmentType: string;
  level: string | null;
  headcount: number | null;
  eligibleIdentityTypes: IdentityType[];
  internalVisibleToManager: boolean;
  pipelineId: string;
  pipelineVersion: number;
  hiringManagerId: string | null;
  compensationKind: CompensationKind;
  compensationNote: string | null;
  onboardingPack: string | null;
  status: OpportunityStatus;
  deadlineAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
}

/**
 * Compensation copy that is honest for the engagement — spec 10 rule 3 and CLAUDE.md ("internships
 * are unpaid unless a stipend is explicitly recorded"). No invented range, no "competitive".
 */
export function compensationLine(kind: CompensationKind, note: string | null): string {
  const n = String(note || '').trim();
  if (kind === 'unpaid') return 'Unpaid' + (n ? ' — ' + n : '');
  if (!n) {
    // A paid engagement with nothing recorded must not print a number nobody agreed to.
    return kind === 'stipend' ? 'Stipend, to be confirmed'
      : kind === 'grant' ? 'Grant, to be confirmed'
      : 'Compensation to be confirmed';
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// PERSON — spec sections 17 and 26.1.
// ---------------------------------------------------------------------------------------------

export const IDENTIFIER_KINDS = ['email', 'phone', 'external', 'user_account', 'identity'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export interface Person {
  id: string;
  personCode: string;
  displayName: string;
  preferredName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  country: string | null;
  mergedIntoId: string | null;
}

export interface PersonIdentifier {
  id: string;
  personId: string;
  kind: IdentifierKind;
  valueNorm: string;
  sourceId: string | null;
  isVerified: boolean;
}

export type MergeStatus = 'proposed' | 'confirmed' | 'rejected';

/**
 * A PROPOSED merge. F2: matching on email alone merges two people who shared a college address and
 * splits one person who changed jobs, so nothing here is ever applied unattended.
 */
export interface PersonMerge {
  id: string;
  keepPersonId: string;
  mergePersonId: string;
  confidence: number;
  evidence: Record<string, any>;
  status: MergeStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------------------------
// NORMALISATION — one implementation, because two normalisers is two answers to "same person?".
// ---------------------------------------------------------------------------------------------

export function normEmail(raw: unknown): string {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Digits only, with a leading + preserved. Deliberately NOT a full E.164 parser: guessing a country
 * code from a bare 10-digit number is how two different people end up merged.
 */
export function normPhone(raw: unknown): string {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D+/g, '');
  if (!digits) return '';
  return (plus ? '+' : '') + digits;
}

export function normIdentifier(kind: IdentifierKind, value: unknown): string {
  if (kind === 'email') return normEmail(value);
  if (kind === 'phone') return normPhone(value);
  return String(value || '').trim();
}

// ---------------------------------------------------------------------------------------------
// SHARED RESULT SHAPE. Every write in this platform answers the same way, so a caller never has to
// guess whether a falsy return meant "refused" or "threw".
// ---------------------------------------------------------------------------------------------

export interface TalentResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

export const okResult = <T>(data?: T): TalentResult<T> => ({ ok: true, data });
export const failResult = <T = undefined>(error: string): TalentResult<T> => ({ ok: false, error });

/** postgres-js returns a plain array from execute(). Never `r.rows[0]`. */
export const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on e.cause; e.message is just the failed statement. */
export const reasonOf = (e: any): string =>
  String(e?.cause?.message || e?.message || 'unknown error');
