// src/lib/talentos/vocab.ts — the closed vocabularies of the Talent Operating System.
//
// WHY THESE LIVE IN TYPESCRIPT AND NOT IN POSTGRES CHECK CONSTRAINTS.
//
// This project has no migration runner. Every schema change is CREATE / ADD ... IF NOT EXISTS, run
// either by the app on first use or by the founder from db/*.sql. A CHECK constraint cannot be
// extended that way: adding one value to a vocabulary means ALTER TABLE ... DROP CONSTRAINT followed
// by ADD CONSTRAINT, by hand, against production, which is precisely the operation nobody performs
// safely under pressure. db/org-graph-schema.sql made the same call for the same reason and says so.
//
// The trade is stated rather than assumed away: the database will accept a typo written by a script
// that bypasses these helpers. db/talent-os-validate.sql detects exactly that, and every writer in
// src/lib/talentos/* goes through the assert* functions below.
//
// NOTHING IN THIS FILE TOUCHES THE DATABASE. It is pure data and pure functions so that the rules
// can be tested without a connection — the organisation-graph work already learned that lesson the
// hard way, when a transitive import of the db handle made pure arithmetic untestable.

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/**
 * The organizational identity types.
 *
 * EMPLOYMENT-BACKED vs NOT is the distinction that matters most here. EMPLOYEE and INTERN carry an
 * hr_employees row created through the existing completeHire(); everything else must NOT create one.
 * A fellow is not payroll, and a campus ambassador is not a member of staff.
 */
export const IDENTITY_TYPES = [
  'EMPLOYEE',
  'INTERN',
  'FELLOW',
  'MEMBER',
  'CAMPUS_AMBASSADOR',
  'CONTRACTOR',
  'CONSULTANT',
  'OTHER_AUTHORIZED_IDENTITY',
] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

/** The identity types that own an hr_employees row. Every other type MUST NOT create one. */
export const EMPLOYMENT_BACKED_TYPES: IdentityType[] = ['EMPLOYEE', 'INTERN'];

export function isEmploymentBacked(t: string): boolean {
  return (EMPLOYMENT_BACKED_TYPES as string[]).includes(t);
}

/** Code prefix per identity type. Each has its own independent sequence. */
const IDENTITY_PREFIX_PAIRS: ReadonlyArray<readonly [IdentityType, string]> = [
  ['EMPLOYEE', 'ERAI-EMP-'],
  ['INTERN', 'ERAI-INT-'],
  ['FELLOW', 'ERAI-FEL-'],
  ['MEMBER', 'ERAI-MEM-'],
  ['CAMPUS_AMBASSADOR', 'ERAI-CAM-'],
  ['CONTRACTOR', 'ERAI-CON-'],
  ['CONSULTANT', 'ERAI-CNS-'],
  ['OTHER_AUTHORIZED_IDENTITY', 'ERAI-OTH-'],
];

export function identityPrefix(t: string): string {
  const hit = IDENTITY_PREFIX_PAIRS.find((p) => p[0] === t);
  if (!hit) throw new Error('unknown identity type: ' + String(t));
  return hit[1];
}

/**
 * Identity status. ONLY 'active' AUTHORISES ANYTHING, ANYWHERE.
 *
 * 'pending'    created by onboarding approval, not yet started
 * 'active'     in force
 * 'suspended'  temporarily withdrawn; access revoked, record intact
 * 'expired'    ran past ended_on
 * 'terminated' ended deliberately
 */
export const IDENTITY_STATUSES = ['pending', 'active', 'suspended', 'expired', 'terminated'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export function isAuthorisingStatus(s: string): boolean {
  return s === 'active';
}

// ---------------------------------------------------------------------------------------------
// Application pathway
// ---------------------------------------------------------------------------------------------

/**
 * WHAT "APPLY" MEANS, made explicit in data.
 *
 *   recruitment        the person is entering the seven-stage evaluation
 *   direct_onboarding  the person arrived holding a valid authorization code and is completing
 *                      the formal onboarding record for a role they were already selected for
 *
 * The interface must say which of these the person is in. The same button word covering both
 * meanings, with nothing distinguishing them, is the confusion this whole system exists to remove.
 */
export const PATHWAYS = ['recruitment', 'direct_onboarding'] as const;
export type Pathway = (typeof PATHWAYS)[number];

export const APPLICANT_TYPES = ['external', 'internal'] as const;
export type ApplicantType = (typeof APPLICANT_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// The seven-stage framework
// ---------------------------------------------------------------------------------------------

/** Seven slots. The framework. What occupies a slot is configuration; that there are seven is not. */
export const SLOT_NUMBERS = [1, 2, 3, 4, 5, 6, 7] as const;
export type SlotNo = (typeof SLOT_NUMBERS)[number];

export function isSlotNo(n: unknown): n is SlotNo {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 7;
}

export const STAGE_KINDS = [
  'screening',
  'assessment',
  'assignment',
  'interview',
  'review',
  'reference',
  'decision',
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * Stage run states.
 *
 * 'waived'  a slot deliberately not applied to this candidate, with an override record.
 * 'skipped' a slot the ROLE does not use (is_required = false). It still exists as a row, so the
 *           audit shows seven slots for every candidate rather than a ragged list that has to be
 *           interpreted.
 */
export const STAGE_RUN_STATES = [
  'not_started',
  'invited',
  'in_progress',
  'submitted',
  'under_review',
  'passed',
  'failed',
  'waived',
  'skipped',
] as const;
export type StageRunState = (typeof STAGE_RUN_STATES)[number];

/** A stage run in one of these states is finished and will not change without an override. */
export const TERMINAL_RUN_STATES: StageRunState[] = ['passed', 'failed', 'waived', 'skipped'];

export function isTerminalRunState(s: string): boolean {
  return (TERMINAL_RUN_STATES as string[]).includes(s);
}

// ---------------------------------------------------------------------------------------------
// Selection and onboarding
// ---------------------------------------------------------------------------------------------

export const SELECTION_DECISIONS = ['selected', 'rejected', 'waitlisted', 'withdrawn'] as const;
export type SelectionDecision = (typeof SELECTION_DECISIONS)[number];

export const ONBOARDING_STATES = [
  'invited',
  'started',
  'pending',
  'submitted',
  'verification',
  'approved',
  'identity_created',
  'access_provisioned',
  'active',
  'rejected',
  'withdrawn',
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

// ---------------------------------------------------------------------------------------------
// Code validation outcomes
// ---------------------------------------------------------------------------------------------

/**
 * The machine-readable result of a code redemption attempt. One value per rung of the validation
 * ladder, so tos_code_attempt.outcome answers "why" without anyone re-deriving it from timestamps.
 *
 * THESE ARE NOT MESSAGES. What an unauthenticated visitor is told is deliberately coarser than
 * this, so that guessing codes reveals nothing about which ones exist. The mapping from result to
 * message lives with the verifier, not here.
 */
export const CODE_RESULTS = [
  'ok',
  'malformed',
  'not_found',
  'revoked',
  'expired',
  'consumed',
  'candidate_mismatch',
  'opportunity_mismatch',
  'selection_not_approved',
  'selection_suspended',
  'opportunity_closed',
  'identity_inactive',
  'rate_limited',
  'identity_unproven',
] as const;
export type CodeResult = (typeof CODE_RESULTS)[number];

/** The only result that permits passage to onboarding. Everything else is a refusal. */
export function grantsPassage(r: string): boolean {
  return r === 'ok';
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

function assertIn<T extends string>(list: readonly T[], value: unknown, what: string): T {
  const v = String(value ?? '');
  if (!(list as readonly string[]).includes(v)) {
    throw new Error('invalid ' + what + ': ' + JSON.stringify(value));
  }
  return v as T;
}

export const assertIdentityType = (v: unknown) => assertIn(IDENTITY_TYPES, v, 'identity type');
export const assertIdentityStatus = (v: unknown) => assertIn(IDENTITY_STATUSES, v, 'identity status');
export const assertPathway = (v: unknown) => assertIn(PATHWAYS, v, 'pathway');
export const assertApplicantType = (v: unknown) => assertIn(APPLICANT_TYPES, v, 'applicant type');
export const assertStageKind = (v: unknown) => assertIn(STAGE_KINDS, v, 'stage kind');
export const assertStageRunState = (v: unknown) => assertIn(STAGE_RUN_STATES, v, 'stage run state');
export const assertSelectionDecision = (v: unknown) => assertIn(SELECTION_DECISIONS, v, 'selection decision');
export const assertOnboardingState = (v: unknown) => assertIn(ONBOARDING_STATES, v, 'onboarding state');
export const assertCodeResult = (v: unknown) => assertIn(CODE_RESULTS, v, 'code result');
