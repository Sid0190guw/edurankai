// src/lib/evidence-graph.ts — WHY DOES THE SYSTEM BELIEVE THIS PERSON HAS THIS CAPABILITY.
//
// =================================================================================================
// THE ONE QUESTION, AND THE SHAPE OF ITS ANSWER
// =================================================================================================
//
// whyDoesTheSystemBelieve() answers it in one call, and the answer is a chain of ROWS:
//
//     claim -> evidence -> source -> document -> page or section -> timestamp -> verification status
//     -----    --------    ------    --------    ----------------   ---------   -------------------
//     capability_claims    capability_evidence.owner_module / source_table / source_id
//                          capability_evidence.document_url (a LINK; this project never stores an
//                          upload), .locator (page, section, lesson, commit, certificate number),
//                          .occurred_at, .verification_status, and capability_verifications for the
//                          named human who said so and why.
//
// WHERE THERE IS NO CHAIN, THE ANSWER IS THE SENTENCE THAT THERE IS NONE. "This is a stated claim
// and nothing on record supports it" is a complete, correct, useful answer. Inventing a plausible
// one is the failure this whole module exists to prevent.
//
// AND "NOTHING ON RECORD" IS NOT THE SAME AS "WE COULD NOT READ IT". Every result carries
// `unreadable`, on the precedent /admin/tests/attempts already set by printing EVIDENCE UNREADABLE
// rather than a score it could not compute. An empty chain rendered from a failed query is a lie
// about a person.
//
// =================================================================================================
// SEVEN EVIDENCE LEVELS, NEVER COLLAPSED, AND ONLY ONE OF THEM IS FREE
// =================================================================================================
//
//   claimed                    somebody said so. A skill on a CV. This is the floor and it is where
//                              every keyword lands, forever, until something else happens.
//   explicit                   the person provided it as structured data about themselves, knowing
//                              it was a record. Still their word.
//   inferred                   the system worked it out from an edge in src/lib/skill-ontology.ts.
//                              Advisory. Carries the edge that produced it.
//   demonstrated               they did something and this platform holds the record: a completed
//                              course, a passed assessment, a reviewed submission, accepted
//                              internship evidence.
//   professionally_demonstrated  they did it as employed work and a named human who answers for that
//                              work said so in writing.
//   production_demonstrated    it went into production, and a named human recorded what and where.
//   externally_verified        a THIRD PARTY confirmed it. Not us. A background check with a
//                              recorded consent and an evidence link, or an external credential a
//                              named human verified against the issuing body.
//
// A KEYWORD IS NEVER PROOF OF COMPETENCE. That is not a comment, it is the arithmetic: the level of
// a claim is CALCULATED from its evidence rows and cannot be passed in by any caller. recordClaim()
// has no level parameter. attachEvidence() takes the level from EVIDENCE_KINDS, never from the form.
// The only ways above 'inferred' are a fact this platform owns and re-read through its owning
// module, or a named human's written verdict.
//
// =================================================================================================
// WHAT THIS FILE DOES NOT OWN, BECAUSE SOMETHING ELSE ALREADY DOES
// =================================================================================================
//
// THE LEVEL OF RECORD. `hr_employee_skills.level` is the skill matrix and src/lib/skills.ts is its
// only writer. There is NO level column on capability_claims, deliberately: two tables holding a
// person's skill level is how this repository already lost a year to XP, to course progress and to
// chat_messages. whyDoesTheSystemBelieve() READS the matrix level through skills.ts and prints it
// BESIDE the evidence level, kept apart in words: "recorded at level 3 (Independent) by the
// employee; the evidence on record supports demonstrated."
//
// THE INTERN EVIDENCE CHAIN. src/lib/eims-evidence.ts owns eims_evidence / _links / _reviews and its
// mentor-verdict rules, and another workflow is writing it right now. This module does NOT fork it
// and does not copy a row out of it: an internship evidence item enters the graph as a REFERENCE
// (owner_module + source_id), and attaching one calls evidenceChain() to confirm the item is
// accepted and belongs to this person. The intern chain stays the authority on intern hours; this
// graph adds the one thing it cannot express, which is that the work evidences a NAMED SKILL for a
// person who may not be an intern at all.
//
// THE PROVENANCE VOCABULARY. src/lib/provenance.ts owns the seven words for how a value came to be
// known (factual, explicitly_provided, inferred, calculated, verified, predicted, recommended).
// This module does not redeclare them. ASSERTION_BY_EVIDENCE_LEVEL below is the SINGLE point where
// the two vocabularies meet, and it is typed as string on purpose so that when provenance.ts lands
// its exported union, one line changes in one place instead of a second copy drifting for a year.
//
// AUTHORIZATION. Who may verify something about a person is a RELATIONSHIP, resolved per row from
// src/lib/org-graph.ts through canSeePerformanceOf() — exactly as src/lib/skills.ts does it — plus
// an org-wide capability the CALLER checks and passes in. This module reads no permission engine.
//
// APPROVALS. A human overriding a recommendation, a promotion, a termination: src/lib/workflow.ts.
// There is no pending/approved state here.
//
// AUDIT. src/lib/audit.ts logAudit(). There is no second log.
//
// =================================================================================================
// THE ONE-PERSON PROBLEM, STATED RATHER THAN PAPERED OVER
// =================================================================================================
//
// There is no person root in this codebase. A human occupies four id spaces (users.id,
// applications.id, hr_employees.id, and the learner account) joined by nullable, unenforced
// pointers, one of which is resolved by lowercasing an email address at hire time. So a claim here
// names a SUBJECT KIND and a SUBJECT ID, and this module joins ONLY what a stored column already
// says:
//
//   employee  -> learner    hr_employees.user_id. A column. Joined, and the join is named in the chain.
//   candidate -> learner    applications.applicant_user_id. A column. Joined, and named.
//   candidate -> employee   NOT JOINED. The only link is an email comparison inside an INSERT in
//                           src/lib/hire-transfer.ts, and an email match is not evidence of identity.
//                           IDENTITY_NOT_JOINED says so on the screen rather than quietly returning
//                           a shorter chain.
//
// When a person root lands, this table gains a person_id column by ADD COLUMN IF NOT EXISTS and the
// subject columns stay as the record of what was known at the time.
//
// =================================================================================================
// WHAT CANNOT BE BUILT ON THIS, AND WHY THE SEAM IS ABSENT RATHER THAN UNIMPLEMENTED
// =================================================================================================
//
// A claim is about an hr_skills node. There is no free-text capability column, no attribute column,
// and no place to put race, religion, caste, politics, sexual orientation, disability, health,
// pregnancy or marital status — not as a claim, not as evidence, not as an inference. Nothing here
// reads communication volume, activity, keystrokes or any monitoring signal, and there is no field
// for one to arrive through.
//
// NOTHING HERE PRODUCES A MATCH SCORE. requirementCoverage() returns a named status per requirement
// and refuses to total them, because a percentage over two vocabularies that have never been joined
// is keyword overlap wearing a number, and a number is what people act on.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Every read goes through rowsOf(). Never r.rows[0].
//   - The real Postgres reason is on e.cause. logFail() prints e?.cause?.message || e?.message.
//   - NO WRITE PATH SWALLOWS AN EXCEPTION. Every one logs and returns a sentence a person can read.
//   - Every const is declared ABOVE the function that reads it. const is not hoisted.
//   - DDL additive only, one ensureOnce guard, a NEW key — and ensureOnce SWALLOWS, so
//     verifyEvidenceGraphSchema() asks information_schema instead of trusting that it returned.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import {
  canSeePerformanceOf,
  clean,
  isUuid,
  logFail,
  rowsOf,
  type PerfViewer,
} from '@/lib/performance-scope';
import { SKILL_LEVEL_LABELS, SKILL_SOURCE_LABELS, skillsForEmployee } from '@/lib/skills';
import {
  impliedBy,
  requirementResolution,
  resolveSkillNode,
  skillNode,
  type RequirementResolution,
} from '@/lib/skill-ontology';
import { completionEvidence, resolveLearnerUserId } from '@/lib/learning-progress';
import { verifyAssessmentEvidence } from '@/lib/learning-doors';
import { getCertificatesForUser } from '@/lib/certificates';
import { getSubmission } from '@/lib/submissions';
import { evidenceColumnFor, getBgvRecord } from '@/lib/hr-bgv';

const MOD = 'evidence-graph';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/**
 * A refusal or a verdict needs enough words to be read back in six months. The intern chain uses the
 * same floor (MIN_REASON in src/lib/eims-evidence.ts); it is restated as a number here rather than
 * imported so that this module does not pull a 100 KB file into every page that renders a claim.
 */
const MIN_REASON_CHARS = 12;

/** Printed whenever an employee record is read, because the omission is the honest part. */
export const IDENTITY_NOT_JOINED =
  'This covers the records this codebase can prove belong to the same person. A candidate record for '
  + 'the same human, if there is one, is not included: candidate and employee records are joined by '
  + 'an email comparison at hire time, and an email match is not evidence of identity.';

// =================================================================================================
// THE LADDER
// =================================================================================================

export const EVIDENCE_LEVELS = [
  'claimed',
  'explicit',
  'inferred',
  'demonstrated',
  'professionally_demonstrated',
  'production_demonstrated',
  'externally_verified',
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export function isEvidenceLevel(v: unknown): v is EvidenceLevel {
  return typeof v === 'string' && (EVIDENCE_LEVELS as readonly string[]).includes(v);
}

export const EVIDENCE_LEVEL_LABELS: Record<EvidenceLevel, string> = {
  claimed: 'Claimed',
  explicit: 'Explicitly provided',
  inferred: 'Inferred',
  demonstrated: 'Demonstrated',
  professionally_demonstrated: 'Professionally demonstrated',
  production_demonstrated: 'Demonstrated in production',
  externally_verified: 'Externally verified',
};

/** One sentence per level, printed beside it. A word nobody can define is a word everybody games. */
export const EVIDENCE_LEVEL_MEANING: Record<EvidenceLevel, string> = {
  claimed: 'Somebody wrote it down. Nothing on record supports it yet.',
  explicit: 'The person provided it about themselves as a record. It is still their word.',
  inferred: 'Worked out from a relation between skills. Advisory, and it carries the relation it rests on.',
  demonstrated: 'They did something and this platform holds the record of it.',
  professionally_demonstrated: 'They did it as employed work, and a named human who answers for that work said so.',
  production_demonstrated: 'It went into production, and a named human recorded what and where.',
  externally_verified: 'A third party outside this platform confirmed it.',
};

/**
 * ORDERING, NOT SCORING. The rank exists so strongestLevel() can pick one; it must never reach a
 * screen as a number, because a 3-out-of-7 beside somebody's name is precisely the opaque score the
 * spec forbids on a high-impact decision.
 */
const LEVEL_RANK: Record<EvidenceLevel, number> = {
  claimed: 0,
  explicit: 1,
  inferred: 2,
  demonstrated: 3,
  professionally_demonstrated: 4,
  production_demonstrated: 5,
  externally_verified: 6,
};

/** Pure. The stronger of two levels, by the ladder above. */
export function strongestLevel(a: EvidenceLevel, b: EvidenceLevel): EvidenceLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Pure. Is this level at or above that one? Used to decide what a screen may assert, never to score. */
export function atLeast(level: EvidenceLevel, floor: EvidenceLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[floor];
}

/**
 * THE SINGLE POINT WHERE THIS MODULE'S LADDER MEETS THE SYSTEM PROVENANCE VOCABULARY.
 *
 * The seven words on the right belong to src/lib/provenance.ts, which is the only file allowed to
 * define them. This map is typed as string rather than as that module's union ON PURPOSE: when
 * provenance.ts exports its type, this one declaration is retyped and every consumer is checked,
 * instead of a second copy of the vocabulary drifting quietly for a year.
 */
export const ASSERTION_BY_EVIDENCE_LEVEL: Record<EvidenceLevel, string> = {
  claimed: 'explicitly_provided',
  explicit: 'explicitly_provided',
  inferred: 'inferred',
  demonstrated: 'factual',
  professionally_demonstrated: 'verified',
  production_demonstrated: 'verified',
  externally_verified: 'verified',
};

// =================================================================================================
// WHAT COUNTS AS EVIDENCE, AND WHAT EACH KIND IS ALLOWED TO SUPPORT
// =================================================================================================

/** What has to happen before a kind may support its level. */
export type EvidenceNeed = 'none' | 'owner_confirmation' | 'human_verdict';

export interface EvidenceKindSpec {
  kind: string;
  label: string;
  /** The most this kind can ever support. Read from here, NEVER from a caller or a form. */
  supports: EvidenceLevel;
  needs: EvidenceNeed;
  /** The module that owns the underlying fact. This graph never re-queries around it. */
  ownerModule: string;
  /** The table the fact lives in, for the chain to name. Null where there is no row but a person's word. */
  sourceTable: string | null;
  description: string;
}

/**
 * THE REGISTRY. Adding a kind is how this graph learns about a new source of evidence; there is no
 * other way in, and nothing accepts a kind that is not here.
 *
 * Note what a platform certificate does NOT do. It is hash-chained and Ed25519-signed and it is
 * still OURS: EduRankAI is the technology platform and accredited partners award credentials, so a
 * certificate we issued is a demonstration on this platform and not an external verification. The
 * only externally_verified rows come from a third party.
 */
export const EVIDENCE_KINDS: EvidenceKindSpec[] = [
  {
    kind: 'cv_statement',
    label: 'Listed on a CV or an application',
    supports: 'claimed',
    needs: 'none',
    ownerModule: '(the person or the recruiter who typed it)',
    sourceTable: null,
    description: 'A skill somebody wrote down. It is a claim, and it stays a claim.',
  },
  {
    kind: 'profile_statement',
    label: 'Provided in a profile',
    supports: 'explicit',
    needs: 'none',
    ownerModule: 'src/lib/profile.ts, src/lib/applicant-profile.ts',
    sourceTable: 'hr_employee_profile / applicant_profiles',
    description: 'The person entered it about themselves as structured data. Still their word.',
  },
  {
    kind: 'manager_statement',
    label: 'Assessed by a manager',
    supports: 'claimed',
    needs: 'none',
    ownerModule: 'src/lib/skills.ts',
    sourceTable: 'hr_employee_skills',
    description: 'Somebody who answers for the work recorded a level. It is a judgement, not a record of work.',
  },
  {
    kind: 'ontology_inference',
    label: 'Inferred from a related skill',
    supports: 'inferred',
    needs: 'none',
    ownerModule: 'src/lib/skill-ontology.ts',
    sourceTable: 'skill_relations',
    description: 'Derived from a broader-skill edge, and only ever from a demonstrated capability.',
  },
  {
    kind: 'course_completion',
    label: 'Completed a course on this platform',
    supports: 'demonstrated',
    needs: 'owner_confirmation',
    ownerModule: 'src/lib/learning-progress.ts',
    sourceTable: 'training_courses',
    description: 'Confirmed against the learner record through completionEvidence().',
  },
  {
    kind: 'platform_certificate',
    label: 'Certificate issued on this platform',
    supports: 'demonstrated',
    needs: 'owner_confirmation',
    ownerModule: 'src/lib/certificates.ts',
    sourceTable: 'course_certificates',
    description: 'A signed, hash-chained certificate verifiable at /verify. Issued by this platform, not by an awarding body.',
  },
  {
    kind: 'assessment_pass',
    label: 'Passed an assessment on this platform',
    supports: 'demonstrated',
    needs: 'owner_confirmation',
    ownerModule: 'src/lib/learning-doors.ts',
    sourceTable: 'test_attempts',
    description: 'Confirmed as a passed, submitted attempt belonging to this learner.',
  },
  {
    kind: 'reviewed_submission',
    label: 'Work sample a reviewer accepted',
    supports: 'demonstrated',
    needs: 'owner_confirmation',
    ownerModule: 'src/lib/submissions.ts',
    sourceTable: 'portal_submissions',
    description: 'Original work, submitted as a link, and approved by a named reviewer.',
  },
  {
    kind: 'internship_evidence',
    label: 'Internship evidence a mentor accepted',
    supports: 'demonstrated',
    needs: 'owner_confirmation',
    ownerModule: 'src/lib/eims-evidence.ts',
    sourceTable: 'eims_evidence',
    description: 'A reference to the intern evidence chain. That chain stays the authority on hours.',
  },
  {
    kind: 'employment_work_evidence',
    label: 'Employed work, confirmed by a named human',
    supports: 'professionally_demonstrated',
    needs: 'human_verdict',
    ownerModule: '(this graph, on a named human verdict)',
    sourceTable: 'capability_verifications',
    description: 'Work done in the job, with a link to it, confirmed in writing by somebody who answers for that work.',
  },
  {
    kind: 'production_reference',
    label: 'Shipped to production, confirmed by a named human',
    supports: 'production_demonstrated',
    needs: 'human_verdict',
    ownerModule: '(this graph, on a named human verdict)',
    sourceTable: 'capability_verifications',
    description: 'A named artefact that went live, and the human who recorded what it was and where.',
  },
  {
    kind: 'background_check',
    label: 'Background verification',
    supports: 'externally_verified',
    needs: 'owner_confirmation',
    ownerModule: 'src/lib/hr-bgv.ts',
    sourceTable: 'hr_bgv_records',
    description: 'A third-party check recorded as clear, with an evidence link and a recorded consent.',
  },
  {
    kind: 'external_credential',
    label: 'Credential from an outside body',
    supports: 'externally_verified',
    needs: 'human_verdict',
    ownerModule: '(this graph, on a named human verdict)',
    sourceTable: 'capability_verifications',
    description: 'A credential this platform did not issue, checked against the issuing body by a named human.',
  },
];

const KIND_BY_NAME = new Map<string, EvidenceKindSpec>(EVIDENCE_KINDS.map((k) => [k.kind, k]));

export function evidenceKindSpec(kind: unknown): EvidenceKindSpec | null {
  return KIND_BY_NAME.get(String(kind || '')) || null;
}

// =================================================================================================
// SUBJECTS, SOURCES, VERDICTS
// =================================================================================================

export const SUBJECT_KINDS = ['employee', 'candidate', 'learner'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_KIND_LABELS: Record<SubjectKind, string> = {
  employee: 'Employee record',
  candidate: 'Candidate record',
  learner: 'Learner account',
};

export interface ClaimSubject {
  kind: SubjectKind;
  /** hr_employees.id, applications.id or users.id. Three id spaces; this module never merges them. */
  id: string;
}

export function isSubjectKind(v: unknown): v is SubjectKind {
  return typeof v === 'string' && (SUBJECT_KINDS as readonly string[]).includes(v);
}

/** Where the CLAIM came from. Not where the evidence came from — that is the evidence kind. */
export const CLAIM_SOURCES = [
  'self_statement',
  'cv',
  'application',
  'profile',
  'manager',
  'skill_matrix_import',
  'ontology_inference',
] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

export const CLAIM_SOURCE_LABELS: Record<ClaimSource, string> = {
  self_statement: 'The person recorded it',
  cv: 'Listed on a CV',
  application: 'Entered on an application',
  profile: 'Entered in a profile',
  manager: 'Recorded by a manager',
  skill_matrix_import: 'Carried over from the skill matrix',
  ontology_inference: 'Inferred from a related skill',
};

/** The floor a claim sits at with no evidence rows at all. Never above 'explicit' for a human's word. */
const FLOOR_BY_SOURCE: Record<ClaimSource, EvidenceLevel> = {
  self_statement: 'claimed',
  cv: 'claimed',
  application: 'claimed',
  profile: 'explicit',
  manager: 'claimed',
  skill_matrix_import: 'claimed',
  ontology_inference: 'inferred',
};

export function isClaimSource(v: unknown): v is ClaimSource {
  return typeof v === 'string' && (CLAIM_SOURCES as readonly string[]).includes(v);
}

export const VERIFICATION_STATUSES = ['unverified', 'confirmed_by_owner', 'human_verified', 'refused'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  unverified: 'Not checked',
  confirmed_by_owner: 'Confirmed against the record that owns it',
  human_verified: 'Confirmed in writing by a named person',
  refused: 'A named person said it does not support this',
};

export const VERDICTS = ['supports', 'does_not_support', 'insufficient'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  supports: 'This evidence supports the capability',
  does_not_support: 'This evidence does not support the capability',
  insufficient: 'Not enough to say either way',
};

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

// =================================================================================================
// TYPES
// =================================================================================================

export interface ClaimRow {
  id: string;
  subject: ClaimSubject;
  skillId: string;
  skillName: string;
  category: string;
  source: ClaimSource;
  sourceDetail: string | null;
  evidenceLevel: EvidenceLevel;
  evidenceLevelLabel: string;
  /** The provenance word src/lib/provenance.ts owns, for this level. */
  assertion: string;
  levelComputedAt: string | null;
  createdAt: string | null;
  /** How this subject was reached from the one that was asked about. Null when it was asked about. */
  linkedVia: string | null;
}

export interface ChainStep {
  id: string;
  claimId: string;
  kind: string;
  kindLabel: string;
  ownerModule: string;
  sourceTable: string | null;
  sourceId: string | null;
  documentUrl: string | null;
  locator: string | null;
  occurredAt: string | null;
  supports: EvidenceLevel;
  /** What this row actually contributes today, after its verification status is taken into account. */
  contributes: EvidenceLevel | null;
  verificationStatus: VerificationStatus;
  confirmedDetail: string | null;
  confirmedAt: string | null;
  note: string | null;
  addedByUserId: string | null;
  createdAt: string | null;
  sentence: string;
}

export interface VerificationRow {
  id: string;
  claimId: string;
  evidenceId: string | null;
  verifierUserId: string | null;
  verifierName: string | null;
  verifierVia: string | null;
  verdict: Verdict;
  reason: string;
  createdAt: string | null;
}

export interface RecordedLevel {
  level: number;
  levelLabel: string;
  source: string;
  sourceLabel: string;
  evidence: string | null;
  evidenceUrl: string | null;
  assessedAt: string | null;
}

export interface BeliefAnswer {
  /** False when there is no claim at all. Distinct from an empty chain on a claim that exists. */
  found: boolean;
  /** True when a read failed. An empty chain from a failed query must never render as "no evidence". */
  unreadable: boolean;
  subject: ClaimSubject;
  skillId: string;
  skillName: string;
  claims: ClaimRow[];
  chain: ChainStep[];
  verifications: VerificationRow[];
  /** The strongest level anything on record supports. Null when nothing does. */
  level: EvidenceLevel | null;
  levelLabel: string | null;
  assertion: string | null;
  /** The skill matrix figure, for an employee. A different statement, printed separately. */
  recordedLevel: RecordedLevel | null;
  /** Named joins that were followed, e.g. hr_employees.user_id. */
  joins: string[];
  sentence: string;
  /** The identity caveat, always, so nobody reads this as everything about a human. */
  identityNote: string;
}

export interface GraphWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** The level after the write, recomputed from rows. Never what the caller hoped for. */
  level?: EvidenceLevel;
}

// =================================================================================================
// SCHEMA — additive, one guard, a NEW key, verified afterwards rather than trusted
// =================================================================================================

const CLAIM_COLUMNS = [
  'id', 'subject_kind', 'subject_id', 'skill_id', 'source', 'source_detail',
  'evidence_level', 'level_computed_at', 'created_by_user_id', 'created_at', 'updated_at',
];
const EVIDENCE_COLUMNS = [
  'id', 'claim_id', 'evidence_kind', 'owner_module', 'source_table', 'source_id', 'document_url',
  'locator', 'occurred_at', 'supports_level', 'verification_status', 'confirmed_detail',
  'confirmed_at', 'note', 'added_by_user_id', 'created_at',
];
const VERIFICATION_COLUMNS = [
  'id', 'claim_id', 'evidence_id', 'verifier_user_id', 'verifier_name', 'verifier_via',
  'verdict', 'reason', 'created_at',
];

export function ensureEvidenceGraphSchema(): Promise<void> {
  return ensureOnce('capability_evidence_graph_v1', async () => {
    try {
      await createGraphTables();
    } catch (e: any) {
      // Logged and RE-THROWN: ensureOnce drops a failed run so the next call retries instead of
      // remembering the failure for the life of the process, and then swallows for the caller.
      logFail(MOD, 'ensureEvidenceGraphSchema', e);
      throw e;
    }
  });
}

async function createGraphTables(): Promise<void> {
  await ensurePerformanceSchema();

  // NO LEVEL COLUMN. hr_employee_skills.level is the level of record and skills.ts is its writer.
  // SUBJECT_ID IS TEXT because the three id spaces a human occupies here are not one type and are
  // not one person; a uuid column would be a promise this codebase cannot keep.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS capability_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'self_statement',
    source_detail TEXT,
    evidence_level TEXT NOT NULL DEFAULT 'claimed',
    level_computed_at TIMESTAMPTZ,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT capability_claims_key UNIQUE (subject_kind, subject_id, skill_id)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS capability_claims_subject_idx
    ON capability_claims (subject_kind, subject_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS capability_claims_skill_idx
    ON capability_claims (skill_id, evidence_level)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS capability_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES capability_claims(id) ON DELETE CASCADE,
    evidence_kind TEXT NOT NULL,
    owner_module TEXT NOT NULL,
    source_table TEXT,
    source_id TEXT,
    document_url TEXT,
    locator TEXT,
    occurred_at TIMESTAMPTZ,
    supports_level TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    confirmed_detail TEXT,
    confirmed_at TIMESTAMPTZ,
    note TEXT,
    added_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS capability_evidence_claim_idx
    ON capability_evidence (claim_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS capability_evidence_source_idx
    ON capability_evidence (evidence_kind, source_id)`);

  // APPEND-ONLY. Never updated, never deleted. The status on the evidence row is a projection of the
  // latest verdict here; the history is what lets somebody ask, six months later, who decided what.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS capability_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES capability_claims(id) ON DELETE CASCADE,
    evidence_id UUID,
    verifier_user_id UUID,
    verifier_name TEXT,
    verifier_via TEXT,
    verdict TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS capability_verifications_claim_idx
    ON capability_verifications (claim_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS capability_verifications_verifier_idx
    ON capability_verifications (verifier_user_id, created_at DESC)`);

  // Its own try/catch: a unique index is the one statement here that can fail on DATA. Every write
  // path checks for the collision itself first, so this is insurance against a concurrent double
  // submit rather than the mechanism.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS capability_evidence_uidx
      ON capability_evidence (claim_id, evidence_kind, COALESCE(source_id, ''))`);
  } catch (e: any) {
    logFail(MOD, 'capability_evidence_uidx', e);
  }
}

export interface GraphSchemaReport {
  ok: boolean;
  tables: { table: string; present: boolean; columns: string[]; missingColumns: string[] }[];
  sentence: string;
  error?: string;
}

/** What is ACTUALLY in the database. ensureOnce swallows; this asks. */
export async function verifyEvidenceGraphSchema(): Promise<GraphSchemaReport> {
  const want = [
    { table: 'capability_claims', columns: CLAIM_COLUMNS },
    { table: 'capability_evidence', columns: EVIDENCE_COLUMNS },
    { table: 'capability_verifications', columns: VERIFICATION_COLUMNS },
  ];
  try {
    const names = want.map((w) => w.table);
    const cols = rowsOf(await db.execute(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY(${names})`));
    const byTable = new Map<string, Set<string>>();
    for (const c of cols) {
      const t = String(c.table_name);
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t)!.add(String(c.column_name));
    }
    const tables = want.map((w) => {
      const have = byTable.get(w.table) || new Set<string>();
      return {
        table: w.table,
        present: have.size > 0,
        columns: Array.from(have).sort(),
        missingColumns: w.columns.filter((c) => !have.has(c)),
      };
    });
    const bad = tables.filter((t) => !t.present || t.missingColumns.length > 0);
    return {
      ok: bad.length === 0,
      tables,
      sentence: bad.length === 0
        ? 'The evidence graph tables are present with every column this module reads.'
        : bad.map((t) => t.present
          ? t.table + ' exists but is missing ' + t.missingColumns.join(', ')
          : t.table + ' does not exist').join('. ') + '.',
    };
  } catch (e: any) {
    logFail(MOD, 'verifyEvidenceGraphSchema', e);
    return {
      ok: false,
      tables: [],
      sentence: 'We could not read the database schema, so we cannot say what is present.',
      error: e?.cause?.message || e?.message || 'unreadable',
    };
  }
}

// =================================================================================================
// MAPPERS AND SENTENCES — pure, so the words can be checked without a database
// =================================================================================================

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function day(v: string | null): string | null {
  return v ? v.slice(0, 10) : null;
}

/**
 * What one evidence row contributes TODAY. Null means nothing: a refused row stays on the record and
 * stops counting, which is the difference between deleting evidence and disagreeing with it.
 */
export function contributionOf(kind: string, status: VerificationStatus): EvidenceLevel | null {
  const spec = evidenceKindSpec(kind);
  if (!spec) return null;
  if (status === 'refused') return null;
  if (spec.needs === 'none') return spec.supports;
  if (spec.needs === 'owner_confirmation') {
    return status === 'confirmed_by_owner' || status === 'human_verified' ? spec.supports : 'claimed';
  }
  return status === 'human_verified' ? spec.supports : 'claimed';
}

/** Pure. The words for one row of the chain. */
export function chainStepSentence(step: {
  kindLabel: string;
  ownerModule: string;
  sourceTable: string | null;
  sourceId: string | null;
  documentUrl: string | null;
  locator: string | null;
  occurredAt: string | null;
  verificationStatus: VerificationStatus;
  confirmedDetail: string | null;
  contributes: EvidenceLevel | null;
}): string {
  const parts: string[] = [step.kindLabel];
  if (step.confirmedDetail) parts.push(step.confirmedDetail);
  if (step.sourceTable) parts.push('recorded in ' + step.sourceTable + (step.sourceId ? ' row ' + step.sourceId : ''));
  if (step.documentUrl) parts.push('document: ' + step.documentUrl);
  if (step.locator) parts.push('at ' + step.locator);
  const when = day(step.occurredAt);
  if (when) parts.push('dated ' + when);
  parts.push(VERIFICATION_STATUS_LABELS[step.verificationStatus] || step.verificationStatus);
  parts.push(step.contributes
    ? 'supports: ' + EVIDENCE_LEVEL_LABELS[step.contributes].toLowerCase()
    : 'supports nothing at present');
  return parts.join('. ') + '.';
}

/**
 * Pure. The one paragraph that answers the question, built only from what was passed in.
 *
 * It never says "qualified", "certified" or "accredited": EduRankAI is the technology platform and
 * accredited partners award credentials. It says what was done and where it is recorded.
 */
export function beliefSentence(input: {
  skillName: string;
  found: boolean;
  unreadable: boolean;
  level: EvidenceLevel | null;
  stepCount: number;
  strongestStep: string | null;
  verifierName: string | null;
  recordedLevel: RecordedLevel | null;
}): string {
  if (input.unreadable) {
    return 'We could not read the records behind ' + input.skillName + '. This is not a statement that '
      + 'there is no evidence; it is a statement that the evidence is unreadable right now.';
  }
  if (!input.found) {
    return 'Nothing on record connects this person to ' + input.skillName + '. No claim has been made and '
      + 'no evidence has been attached.';
  }
  const matrix = input.recordedLevel
    ? ' The skill matrix separately records level ' + input.recordedLevel.level + ' ('
      + input.recordedLevel.levelLabel + '), ' + input.recordedLevel.sourceLabel.toLowerCase()
      + '. That is a recorded judgement and it is not the same statement as the evidence below.'
    : '';
  if (!input.level || input.stepCount === 0) {
    return input.skillName + ' is a stated claim. Nothing on record supports it yet, so the system '
      + 'believes only that somebody wrote it down.' + matrix;
  }
  const lead = input.skillName + ' is recorded as ' + EVIDENCE_LEVEL_LABELS[input.level].toLowerCase()
    + '. ' + EVIDENCE_LEVEL_MEANING[input.level];
  const on = ' It rests on ' + input.stepCount + ' record' + (input.stepCount === 1 ? '' : 's')
    + (input.strongestStep ? ', the strongest being: ' + input.strongestStep : '.');
  const who = input.verifierName ? ' ' + input.verifierName + ' confirmed it in writing.' : '';
  return lead + on + who + matrix;
}

function mapClaim(r: any, linkedVia: string | null): ClaimRow {
  const level: EvidenceLevel = isEvidenceLevel(r?.evidence_level) ? r.evidence_level : 'claimed';
  const source: ClaimSource = isClaimSource(r?.source) ? r.source : 'self_statement';
  return {
    id: String(r?.id ?? ''),
    subject: {
      kind: isSubjectKind(r?.subject_kind) ? r.subject_kind : 'employee',
      id: String(r?.subject_id ?? ''),
    },
    skillId: String(r?.skill_id ?? ''),
    skillName: r?.skill_name ? String(r.skill_name) : '',
    category: r?.category ? String(r.category) : 'general',
    source,
    sourceDetail: r?.source_detail ? String(r.source_detail) : null,
    evidenceLevel: level,
    evidenceLevelLabel: EVIDENCE_LEVEL_LABELS[level],
    assertion: ASSERTION_BY_EVIDENCE_LEVEL[level],
    levelComputedAt: iso(r?.level_computed_at),
    createdAt: iso(r?.created_at),
    linkedVia,
  };
}

function mapStep(r: any): ChainStep {
  const kind = String(r?.evidence_kind || '');
  const spec = evidenceKindSpec(kind);
  const status: VerificationStatus = (VERIFICATION_STATUSES as readonly string[]).includes(String(r?.verification_status))
    ? (String(r.verification_status) as VerificationStatus)
    : 'unverified';
  const supports: EvidenceLevel = isEvidenceLevel(r?.supports_level) ? r.supports_level : 'claimed';
  const contributes = contributionOf(kind, status);
  const step: ChainStep = {
    id: String(r?.id ?? ''),
    claimId: String(r?.claim_id ?? ''),
    kind,
    kindLabel: spec ? spec.label : kind,
    ownerModule: String(r?.owner_module || (spec ? spec.ownerModule : 'unknown')),
    sourceTable: r?.source_table ? String(r.source_table) : null,
    sourceId: r?.source_id ? String(r.source_id) : null,
    documentUrl: r?.document_url ? String(r.document_url) : null,
    locator: r?.locator ? String(r.locator) : null,
    occurredAt: iso(r?.occurred_at),
    supports,
    contributes,
    verificationStatus: status,
    confirmedDetail: r?.confirmed_detail ? String(r.confirmed_detail) : null,
    confirmedAt: iso(r?.confirmed_at),
    note: r?.note ? String(r.note) : null,
    addedByUserId: r?.added_by_user_id ? String(r.added_by_user_id) : null,
    createdAt: iso(r?.created_at),
    sentence: '',
  };
  step.sentence = chainStepSentence(step);
  return step;
}

function mapVerification(r: any): VerificationRow {
  return {
    id: String(r?.id ?? ''),
    claimId: String(r?.claim_id ?? ''),
    evidenceId: r?.evidence_id ? String(r.evidence_id) : null,
    verifierUserId: r?.verifier_user_id ? String(r.verifier_user_id) : null,
    verifierName: r?.verifier_name ? String(r.verifier_name) : null,
    verifierVia: r?.verifier_via ? String(r.verifier_via) : null,
    verdict: isVerdict(r?.verdict) ? r.verdict : 'insufficient',
    reason: String(r?.reason || ''),
    createdAt: iso(r?.created_at),
  };
}

// =================================================================================================
// IDENTITY — only the joins a stored column already makes
// =================================================================================================

export interface LinkedSubject {
  subject: ClaimSubject;
  /** The column that made the join, named so a screen can print it. */
  via: string;
}

/**
 * The other records this codebase can PROVE belong to the same person, and nothing else.
 *
 * Each join is a stored column. There is no email comparison here, no name match and no fuzzy
 * anything: the candidate-to-employee link in src/lib/hire-transfer.ts is a lower(email) comparison
 * inside an INSERT, and running that logic here would turn a hiring convenience into an assertion
 * about who somebody is.
 */
export async function linkedSubjects(subject: ClaimSubject): Promise<LinkedSubject[]> {
  const out: LinkedSubject[] = [];
  if (!subject || !isSubjectKind(subject.kind)) return out;
  try {
    if (subject.kind === 'employee' && isUuid(subject.id)) {
      const learner = await resolveLearnerUserId(subject.id);
      if (isUuid(learner || '')) {
        out.push({
          subject: { kind: 'learner', id: String(learner) },
          via: 'hr_employees.user_id',
        });
      }
    } else if (subject.kind === 'candidate' && isUuid(subject.id)) {
      const r = rowsOf(await db.execute(sql`
        SELECT applicant_user_id::text AS user_id FROM applications
         WHERE id = ${subject.id}::uuid LIMIT 1`));
      const learner = r.length ? r[0]?.user_id : null;
      if (isUuid(String(learner || ''))) {
        out.push({
          subject: { kind: 'learner', id: String(learner) },
          via: 'applications.applicant_user_id',
        });
      }
    }
  } catch (e: any) {
    logFail(MOD, 'linkedSubjects', e);
  }
  return out;
}

// =================================================================================================
// WRITING A CLAIM
// =================================================================================================

/**
 * Record that somebody is said to have a capability. THE LEVEL IS NOT A PARAMETER.
 *
 * A claim starts at the floor for its source and moves only when evidence lands. There is no
 * argument on this function, and there is deliberately no other function, that lets a caller state
 * how strong a claim is — that is the whole mechanism by which a keyword cannot become proof.
 *
 * Recording a claim is not a judgement about a person and needs no relationship: a recruiter reading
 * a CV, a person filling in their own profile, and an importer carrying over the skill matrix are all
 * legitimate. What needs authority is VERIFYING one, and that is recordVerification().
 */
export async function recordClaim(input: {
  subject: ClaimSubject;
  skillId: string;
  source: ClaimSource;
  sourceDetail?: string | null;
  actorUserId?: string | null;
}): Promise<GraphWriteResult> {
  const subject = input?.subject;
  if (!subject || !isSubjectKind(subject.kind) || !clean(subject.id, 80)) {
    return { ok: false, error: 'Say whose record this is.' };
  }
  const skillId = String(input?.skillId || '');
  if (!isUuid(skillId)) return { ok: false, error: 'Choose a skill from the catalogue.' };
  const source: ClaimSource = isClaimSource(input?.source) ? input.source : 'self_statement';
  const detail = clean(input?.sourceDetail, 500) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const floor = FLOOR_BY_SOURCE[source];
  try {
    await ensureEvidenceGraphSchema();
    const exists = rowsOf(await db.execute(sql`
      SELECT id::text AS id FROM hr_skills WHERE id = ${skillId}::uuid LIMIT 1`));
    if (!exists.length) return { ok: false, error: 'That skill is not in the catalogue.' };

    // The floor is only ever applied to a NEW row. An existing claim keeps the level its evidence
    // earned: somebody re-typing a skill on a form must not quietly reset a demonstrated capability
    // back to claimed.
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO capability_claims
        (subject_kind, subject_id, skill_id, source, source_detail, evidence_level, level_computed_at, created_by_user_id)
      VALUES
        (${subject.kind}, ${String(subject.id)}, ${skillId}::uuid, ${source}, ${detail}::text,
         ${floor}, NOW(), ${actor}::uuid)
      ON CONFLICT (subject_kind, subject_id, skill_id) DO UPDATE
        SET source_detail = COALESCE(EXCLUDED.source_detail, capability_claims.source_detail),
            updated_at = NOW()
      RETURNING id::text AS id, evidence_level`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    const id = String(rows[0].id);
    await logAudit({
      userId: actor,
      action: 'capability.claim.record',
      entity: 'capability_claims',
      entityId: id,
      diff: { subjectKind: subject.kind, subjectId: String(subject.id), skillId, source },
    });
    const level = isEvidenceLevel(rows[0].evidence_level) ? rows[0].evidence_level : floor;
    return { ok: true, id, level };
  } catch (e: any) {
    logFail(MOD, 'recordClaim', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export interface KeywordClaimReport {
  ok: boolean;
  recorded: { keyword: string; skillId: string; skillName: string; claimId: string }[];
  /** Words that matched no node. NOT invented as new skills, NOT dropped silently. */
  unresolved: { keyword: string; sentence: string }[];
  sentence: string;
  error?: string;
}

/**
 * Turn a list of written skill words into claims. THE CONVERGENCE PATH for the six free-text skill
 * vocabularies in this codebase (a role's skills array, an application's tech_skills blob, a
 * profile's skills list, a requisition's free text).
 *
 * EVERY ROW IT WRITES IS 'claimed' OR 'explicit'. That is the entire point: this is the function most
 * likely to be pointed at a CV, and a CV is a claim. Nothing here reads a document, extracts a skill
 * or scores a person, and words it cannot resolve are RETURNED rather than invented as new catalogue
 * entries — a taxonomy that grows itself from whatever candidates type is not a taxonomy.
 */
export async function recordClaimsFromKeywords(input: {
  subject: ClaimSubject;
  keywords: readonly unknown[];
  source: ClaimSource;
  sourceDetail?: string | null;
  actorUserId?: string | null;
}): Promise<KeywordClaimReport> {
  const report: KeywordClaimReport = { ok: false, recorded: [], unresolved: [], sentence: '' };
  const source: ClaimSource = isClaimSource(input?.source) ? input.source : 'cv';
  if (source === 'ontology_inference') {
    return { ...report, sentence: 'An inference is not a keyword. Use inferFromOntology().' };
  }
  const words = (input?.keywords || []).slice(0, 100);
  try {
    for (const w of words) {
      const text = clean(w, 160);
      if (!text) continue;
      const resolved = await resolveSkillNode(text);
      if (!resolved.node) {
        report.unresolved.push({ keyword: text, sentence: resolved.sentence });
        continue;
      }
      const made = await recordClaim({
        subject: input.subject,
        skillId: resolved.node.id,
        source,
        sourceDetail: clean(input?.sourceDetail, 400)
          || (resolved.matchedBy === 'alias' ? 'Written as "' + text + '"' : null),
        actorUserId: input?.actorUserId,
      });
      if (made.ok && made.id) {
        report.recorded.push({
          keyword: text, skillId: resolved.node.id, skillName: resolved.node.name, claimId: made.id,
        });
      } else {
        report.unresolved.push({ keyword: text, sentence: made.error || WRITE_FAILED });
      }
    }
    return {
      ...report,
      ok: true,
      sentence: report.recorded.length + ' skill word' + (report.recorded.length === 1 ? '' : 's')
        + ' recorded as claims. A skill written down is claimed, not demonstrated.'
        + (report.unresolved.length
          ? ' ' + report.unresolved.length + ' word' + (report.unresolved.length === 1 ? ' was' : 's were')
            + ' not in the catalogue and nothing was recorded for them.'
          : ''),
    };
  } catch (e: any) {
    logFail(MOD, 'recordClaimsFromKeywords', e);
    return {
      ...report,
      ok: false,
      sentence: 'Nothing was recorded.',
      error: e?.cause?.message || e?.message || 'unknown error',
    };
  }
}

// =================================================================================================
// ATTACHING EVIDENCE — confirmed through the module that owns the fact, or refused
// =================================================================================================

interface OwnerConfirmation {
  ok: boolean;
  detail?: string;
  documentUrl?: string | null;
  locator?: string | null;
  occurredAt?: string | null;
  error?: string;
}

/**
 * Re-read the fact through its OWNER, never from the form.
 *
 * This is the contract src/lib/skills.ts already set when it started accepting course and assessment
 * evidence: a hidden field is not evidence, and a reference that does not confirm is REFUSED rather
 * than quietly downgraded — a level silently saved as a claim when somebody meant to attach proof is
 * a quieter kind of wrong.
 */
async function confirmWithOwner(
  kind: string,
  sourceId: string,
  subject: ClaimSubject,
  extra: { checkKey?: string | null } = {},
): Promise<OwnerConfirmation> {
  const learnerId = subject.kind === 'learner'
    ? subject.id
    : (await linkedSubjects(subject)).find((l) => l.subject.kind === 'learner')?.subject.id || null;

  const needsLearner = kind === 'course_completion' || kind === 'platform_certificate'
    || kind === 'assessment_pass' || kind === 'reviewed_submission';
  if (needsLearner && !isUuid(String(learnerId || ''))) {
    return {
      ok: false,
      error: 'This record has no linked learning account, so nothing on it can be confirmed. '
        + 'The skill can still be recorded as a stated claim.',
    };
  }

  if (kind === 'course_completion') {
    const ev = await completionEvidence(String(learnerId), sourceId);
    if (!ev) return { ok: false, error: 'We could not read that course record just now, so nothing was saved.' };
    if (!ev.complete) {
      return {
        ok: false,
        error: 'That course is not recorded as complete on this record, so it cannot be evidence. '
          + 'A skill recorded without evidence is kept as a stated claim, which is an honest thing to record.',
      };
    }
    return {
      ok: true,
      detail: ev.evidence,
      documentUrl: ev.evidenceUrl || null,
      locator: ev.certNumber ? 'certificate ' + ev.certNumber : (ev.totalLessons ? ev.lessonsCompleted + ' of ' + ev.totalLessons + ' lessons' : null),
      occurredAt: ev.completedAt || null,
    };
  }

  if (kind === 'platform_certificate') {
    const certs = await getCertificatesForUser(String(learnerId));
    const mine = (certs || []).find((c: any) => String(c?.id || '') === sourceId || String(c?.cert_number || '') === sourceId);
    if (!mine) {
      return { ok: false, error: 'That certificate is not on this learning record, so it cannot be evidence.' };
    }
    const num = String(mine.cert_number || '');
    return {
      ok: true,
      detail: 'Certificate ' + num + ' for ' + String(mine.course_title || 'a course') + ', issued on the EduRankAI platform',
      documentUrl: '/verify/' + num,
      locator: 'certificate ' + num,
      occurredAt: iso(mine.issued_at),
    };
  }

  if (kind === 'assessment_pass') {
    const ev = await verifyAssessmentEvidence(String(learnerId), sourceId);
    if (!ev) {
      return { ok: false, error: 'That assessment result is not a passed attempt on this record, so it cannot be evidence.' };
    }
    return { ok: true, detail: ev.label, documentUrl: ev.url || null, locator: null, occurredAt: null };
  }

  if (kind === 'reviewed_submission') {
    const row = await getSubmission(sourceId);
    if (!row) return { ok: false, error: 'That submission does not exist.' };
    if (String(row.submitter_user_id || '') !== String(learnerId)) {
      return { ok: false, error: 'That submission belongs to a different account, so it cannot be evidence here.' };
    }
    if (String(row.status || '') !== 'approved') {
      return {
        ok: false,
        error: 'That submission has not been accepted by a reviewer, so it is work on record rather than '
          + 'evidence of a capability.',
      };
    }
    return {
      ok: true,
      detail: 'Work sample "' + String(row.title || 'untitled') + '" accepted by a reviewer',
      documentUrl: row.drive_url ? String(row.drive_url) : (row.external_url ? String(row.external_url) : null),
      locator: row.kind ? String(row.kind) : null,
      occurredAt: iso(row.reviewed_at || row.submitted_at),
    };
  }

  if (kind === 'internship_evidence') {
    // Imported here rather than at the top of the file: eims-evidence.ts is a large module owned by
    // another workflow, and a claim page that never touches internship evidence should not pay for
    // loading it — nor should this module fail to load while that file is mid-edit.
    const { evidenceChain } = await import('@/lib/eims-evidence');
    const chain = await evidenceChain(sourceId);
    if (!chain?.evidence) return { ok: false, error: 'That internship evidence item does not exist.' };
    if (subject.kind === 'employee' && String(chain.evidence.employeeId || '') !== String(subject.id)) {
      return { ok: false, error: 'That evidence belongs to a different person.' };
    }
    if (String(chain.evidence.status || '') !== 'accepted') {
      return {
        ok: false,
        error: 'That internship evidence has not been accepted by a mentor, so it cannot support a capability yet.',
      };
    }
    return {
      ok: true,
      detail: chain.sentence || ('Internship evidence "' + String(chain.evidence.title || '') + '" accepted by a mentor'),
      documentUrl: chain.evidence.url ? String(chain.evidence.url) : null,
      locator: chain.evidence.typeKey ? String(chain.evidence.typeKey) : null,
      occurredAt: iso(chain.evidence.reviewedAt || chain.evidence.occurredOn),
    };
  }

  if (kind === 'background_check') {
    const rec = await getBgvRecord(sourceId);
    if (!rec) return { ok: false, error: 'That background verification record does not exist.' };
    if (rec.consent_given !== true) {
      return {
        ok: false,
        error: 'That background verification has no recorded consent, so it must not be used as evidence '
          + 'about a person.',
      };
    }
    const checkKey = clean(extra?.checkKey, 40);
    const col = evidenceColumnFor(checkKey);
    if (!checkKey || !col) {
      return { ok: false, error: 'Say which background check this is (for example the education check).' };
    }
    const status = String(rec[checkKey] || '');
    if (status !== 'clear') {
      return {
        ok: false,
        error: 'That check is recorded as "' + (status || 'not run') + '", not clear, so it does not verify anything.',
      };
    }
    const url = rec[col] ? String(rec[col]) : null;
    if (!url) {
      return {
        ok: false,
        error: 'That check is clear but has no evidence link recorded, so there is nothing for anybody to read back.',
      };
    }
    return {
      ok: true,
      detail: 'Background verification recorded clear by a third party',
      documentUrl: url,
      locator: checkKey.replace('check_', ''),
      occurredAt: iso(rec.updated_at || rec.created_at),
    };
  }

  return { ok: true };
}

/**
 * Attach one piece of evidence to a claim, and recompute what the claim rests on.
 *
 * WHO MAY DO THIS: anybody who may see the record, INCLUDING the person themselves. Attaching is not
 * asserting — a person adding a link to their own work is how a portfolio works, and the attachment
 * on its own moves nothing. What moves the level is either the owning module confirming the fact, or
 * a named human's verdict, and neither of those is in the caller's gift.
 *
 * `supports_level` is taken from EVIDENCE_KINDS. There is no parameter for it and there must never
 * be one.
 */
export async function attachEvidence(input: {
  claimId: string;
  kind: string;
  /** The id of the row in the owning module's table. Required for every confirmable kind. */
  sourceId?: string | null;
  /** A link. This project never stores an upload; documents are links with access already granted. */
  documentUrl?: string | null;
  /** Page, section, lesson, commit, certificate number — where in the document to look. */
  locator?: string | null;
  occurredAt?: string | null;
  note?: string | null;
  /** For a background check: which of the eight checks this is. */
  checkKey?: string | null;
  actorUserId?: string | null;
}): Promise<GraphWriteResult> {
  const claimId = String(input?.claimId || '');
  if (!isUuid(claimId)) return { ok: false, error: 'That claim does not exist.' };
  const spec = evidenceKindSpec(input?.kind);
  if (!spec) return { ok: false, error: 'That is not a kind of evidence this system knows about.' };
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const sourceId = clean(input?.sourceId, 120) || null;
  let documentUrl = clean(input?.documentUrl, 1000) || null;
  let locator = clean(input?.locator, 200) || null;
  let occurredAt = clean(input?.occurredAt, 40) || null;
  const note = clean(input?.note, 1000) || null;

  if (documentUrl && !/^(https?:\/\/|\/)/i.test(documentUrl)) {
    return { ok: false, error: 'A document link must start with http://, https:// or /.' };
  }
  if (spec.needs === 'owner_confirmation' && !sourceId) {
    return { ok: false, error: 'Name the record this rests on. Evidence without a record to read back is not evidence.' };
  }

  try {
    await ensureEvidenceGraphSchema();
    const claimRows = rowsOf(await db.execute(sql`
      SELECT id::text AS id, subject_kind, subject_id, skill_id::text AS skill_id
        FROM capability_claims WHERE id = ${claimId}::uuid LIMIT 1`));
    if (!claimRows.length) return { ok: false, error: 'That claim does not exist.' };
    const subject: ClaimSubject = {
      kind: isSubjectKind(claimRows[0].subject_kind) ? claimRows[0].subject_kind : 'employee',
      id: String(claimRows[0].subject_id),
    };

    let status: VerificationStatus = 'unverified';
    let confirmedDetail: string | null = null;
    if (spec.needs === 'owner_confirmation') {
      const confirmation = await confirmWithOwner(spec.kind, String(sourceId), subject, { checkKey: input?.checkKey });
      if (!confirmation.ok) {
        return { ok: false, error: confirmation.error || 'That record could not be confirmed, so nothing was attached.' };
      }
      status = 'confirmed_by_owner';
      confirmedDetail = confirmation.detail || null;
      // Written from the CONFIRMED record, never from the form, so two screens cannot word the same
      // completion differently.
      documentUrl = confirmation.documentUrl ?? documentUrl;
      locator = confirmation.locator ?? locator;
      occurredAt = confirmation.occurredAt ?? occurredAt;
    }

    const already = rowsOf(await db.execute(sql`
      SELECT id::text AS id FROM capability_evidence
       WHERE claim_id = ${claimId}::uuid AND evidence_kind = ${spec.kind}
         AND COALESCE(source_id, '') = ${sourceId || ''} LIMIT 1`));
    if (already.length) {
      return { ok: false, id: String(already[0].id), error: 'That evidence is already attached to this claim.' };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO capability_evidence
        (claim_id, evidence_kind, owner_module, source_table, source_id, document_url, locator,
         occurred_at, supports_level, verification_status, confirmed_detail, confirmed_at, note, added_by_user_id)
      VALUES
        (${claimId}::uuid, ${spec.kind}, ${spec.ownerModule}, ${spec.sourceTable}::text, ${sourceId}::text,
         ${documentUrl}::text, ${locator}::text, ${occurredAt}::timestamptz, ${spec.supports}, ${status},
         ${confirmedDetail}::text, ${status === 'confirmed_by_owner' ? sql`NOW()` : sql`NULL`}, ${note}::text, ${actor}::uuid)
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    const id = String(rows[0].id);

    const level = await recomputeClaimLevel(claimId);
    await logAudit({
      userId: actor,
      action: 'capability.evidence.attach',
      entity: 'capability_evidence',
      entityId: id,
      diff: { claimId, kind: spec.kind, sourceId, status, level },
    });
    return { ok: true, id, level: level || undefined };
  } catch (e: any) {
    logFail(MOD, 'attachEvidence', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Recompute a claim's level FROM ITS ROWS. The only writer of capability_claims.evidence_level.
 *
 * It is a calculation, so it is repeatable, and it is repeated after every write rather than being
 * nudged: a level that can be set is a level that can be set wrongly.
 */
export async function recomputeClaimLevel(claimId: string): Promise<EvidenceLevel | null> {
  if (!isUuid(claimId)) return null;
  try {
    await ensureEvidenceGraphSchema();
    const claim = rowsOf(await db.execute(sql`
      SELECT source FROM capability_claims WHERE id = ${claimId}::uuid LIMIT 1`));
    if (!claim.length) return null;
    const source: ClaimSource = isClaimSource(claim[0].source) ? claim[0].source : 'self_statement';
    let level: EvidenceLevel = FLOOR_BY_SOURCE[source];

    const links = rowsOf(await db.execute(sql`
      SELECT evidence_kind, verification_status FROM capability_evidence
       WHERE claim_id = ${claimId}::uuid LIMIT 500`));
    for (const l of links) {
      const status: VerificationStatus = (VERIFICATION_STATUSES as readonly string[]).includes(String(l.verification_status))
        ? (String(l.verification_status) as VerificationStatus)
        : 'unverified';
      const contributes = contributionOf(String(l.evidence_kind || ''), status);
      if (contributes) level = strongestLevel(level, contributes);
    }

    await db.execute(sql`
      UPDATE capability_claims
         SET evidence_level = ${level}, level_computed_at = NOW(), updated_at = NOW()
       WHERE id = ${claimId}::uuid`);
    return level;
  } catch (e: any) {
    logFail(MOD, 'recomputeClaimLevel', e);
    return null;
  }
}

// =================================================================================================
// A NAMED HUMAN'S VERDICT
// =================================================================================================

/**
 * Record a person's written verdict on a claim, or on one piece of its evidence.
 *
 * THREE RULES, ALL ENFORCED HERE RATHER THAN ON THE PAGE:
 *
 *   1. NOBODY VERIFIES THEIR OWN CAPABILITY. Ever, at any capability level, including an org-wide
 *      one. "I verify that I can do this" is not a verification, it is a claim with extra steps.
 *   2. AUTHORITY IS A RELATIONSHIP, resolved per row from the Organization Graph through
 *      canSeePerformanceOf(), or an org-wide capability the CALLER checked and passes in as
 *      `orgWide`. It is passed in rather than read here for the same reason src/lib/skills.ts passes
 *      it: this module must not become a second authorization engine.
 *   3. EVERY VERDICT CARRIES A WRITTEN REASON, including a positive one. A verification with no
 *      reason is an opaque judgement on a high-impact record, which is the exact thing the spec
 *      forbids. Somebody must be able to read in six months WHY this was accepted.
 *
 * The verdict row is APPEND-ONLY. Changing your mind writes another row; nothing is edited away.
 */
export async function recordVerification(
  viewer: PerfViewer,
  input: {
    claimId: string;
    evidenceId?: string | null;
    verdict: Verdict;
    reason: string;
    /** True when the CALLER holds `skills.manage`. Not read here, and not PerfViewer.managesOrg. */
    orgWide?: boolean;
  },
): Promise<GraphWriteResult> {
  const claimId = String(input?.claimId || '');
  if (!isUuid(claimId)) return { ok: false, error: 'That claim does not exist.' };
  if (!isVerdict(input?.verdict)) return { ok: false, error: 'Choose a verdict.' };
  const reason = clean(input?.reason, 2000);
  if (reason.length < MIN_REASON_CHARS) {
    return {
      ok: false,
      error: 'Write the reason in a sentence somebody can read back in six months. '
        + 'A verdict on somebody\'s capability without a reason is exactly what this system refuses to store.',
    };
  }
  const evidenceId = clean(input?.evidenceId, 60) || null;
  if (evidenceId && !isUuid(evidenceId)) return { ok: false, error: 'That evidence item does not exist.' };
  const orgWide = input?.orgWide === true;

  try {
    await ensureEvidenceGraphSchema();
    const claim = rowsOf(await db.execute(sql`
      SELECT c.id::text AS id, c.subject_kind, c.subject_id, s.name AS skill_name
        FROM capability_claims c
        JOIN hr_skills s ON s.id = c.skill_id
       WHERE c.id = ${claimId}::uuid LIMIT 1`));
    if (!claim.length) return { ok: false, error: 'That claim does not exist.' };
    const subjectKind: SubjectKind = isSubjectKind(claim[0].subject_kind) ? claim[0].subject_kind : 'employee';
    const subjectId = String(claim[0].subject_id);

    // RULE 1, before authority, because an org-wide capability must not buy its way past it.
    const ownEmployee = subjectKind === 'employee' && viewer.employeeId === subjectId;
    const ownLearner = subjectKind === 'learner' && viewer.userId === subjectId;
    let ownCandidate = false;
    if (subjectKind === 'candidate' && isUuid(subjectId)) {
      const r = rowsOf(await db.execute(sql`
        SELECT applicant_user_id::text AS user_id FROM applications WHERE id = ${subjectId}::uuid LIMIT 1`));
      ownCandidate = r.length ? String(r[0]?.user_id || '') === String(viewer.userId) : false;
    }
    if (ownEmployee || ownLearner || ownCandidate) {
      return {
        ok: false,
        error: 'You cannot verify your own capability. Somebody who saw the work has to say so.',
      };
    }

    let via = '';
    if (orgWide) {
      via = 'organization-wide skills authority';
    } else if (subjectKind === 'employee' && await canSeePerformanceOf(viewer, subjectId)) {
      via = 'the Organization Graph records you as answering for this person\'s work';
    } else {
      return {
        ok: false,
        error: subjectKind === 'employee'
          ? (viewer.initialized
            ? 'The Organization Graph does not record you as answering for this person\'s work, so you cannot verify their capability.'
            : 'The Organization Graph has not been set up yet, so no reporting line can be confirmed and nothing can be verified against one.')
          : 'A ' + SUBJECT_KIND_LABELS[subjectKind].toLowerCase() + ' has no reporting line to resolve, so verifying '
            + 'a capability on it needs organization-wide skills authority.',
      };
    }

    if (evidenceId) {
      const owned = rowsOf(await db.execute(sql`
        SELECT id::text AS id FROM capability_evidence
         WHERE id = ${evidenceId}::uuid AND claim_id = ${claimId}::uuid LIMIT 1`));
      if (!owned.length) return { ok: false, error: 'That evidence item does not belong to this claim.' };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO capability_verifications
        (claim_id, evidence_id, verifier_user_id, verifier_name, verifier_via, verdict, reason)
      VALUES
        (${claimId}::uuid, ${evidenceId}::uuid, ${viewer.userId}::uuid, ${viewer.fullName}::text,
         ${via}, ${input.verdict}, ${reason})
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    const id = String(rows[0].id);

    if (evidenceId) {
      const nextStatus: VerificationStatus = input.verdict === 'supports'
        ? 'human_verified'
        : (input.verdict === 'does_not_support' ? 'refused' : 'unverified');
      await db.execute(sql`
        UPDATE capability_evidence SET verification_status = ${nextStatus}
         WHERE id = ${evidenceId}::uuid AND claim_id = ${claimId}::uuid`);
    }

    const level = await recomputeClaimLevel(claimId);
    await logAudit({
      userId: viewer.userId,
      action: 'capability.verification.record',
      entity: 'capability_verifications',
      entityId: id,
      diff: { claimId, evidenceId, verdict: input.verdict, subjectKind, subjectId, level },
    });
    return { ok: true, id, level: level || undefined };
  } catch (e: any) {
    logFail(MOD, 'recordVerification', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// =================================================================================================
// INFERENCE — from a demonstration only, and it stops at inferred
// =================================================================================================

export interface InferenceReport {
  ok: boolean;
  created: { skillId: string; skillName: string; fromSkillName: string; claimId: string }[];
  skipped: string[];
  sentence: string;
  error?: string;
}

/**
 * Walk the ontology upward from what this person has DEMONSTRATED and record the broader skills as
 * inferred claims.
 *
 * TWO CEILINGS, AND NEITHER IS ADJUSTABLE:
 *
 *   1. IT ONLY READS DEMONSTRATED CLAIMS OR STRONGER. A skill somebody typed on a CV implies nothing
 *      about anything. Without this rule a keyword would produce an inference, and an inference
 *      ranks above a claim, so a CV would quietly manufacture a stronger record than the CV.
 *   2. WHAT IT WRITES CAN NEVER RISE ABOVE 'inferred' BY THIS ROUTE. The claim's source is
 *      ontology_inference, whose floor is inferred, and the evidence row it attaches is of kind
 *      ontology_inference, which supports exactly inferred and nothing else. To go higher, the
 *      person has to actually do something.
 *
 * Nothing here is automatic. It is a call somebody makes, and every row it writes is visible as an
 * inference on the screen, with the relation that produced it in the chain.
 */
export async function inferFromOntology(input: {
  subject: ClaimSubject;
  actorUserId?: string | null;
}): Promise<InferenceReport> {
  const report: InferenceReport = { ok: false, created: [], skipped: [], sentence: '' };
  const subject = input?.subject;
  if (!subject || !isSubjectKind(subject.kind) || !clean(subject.id, 80)) {
    return { ...report, sentence: 'Say whose record this is.' };
  }
  try {
    await ensureEvidenceGraphSchema();
    const demonstrated = rowsOf(await db.execute(sql`
      SELECT c.id::text AS id, c.skill_id::text AS skill_id, c.evidence_level, s.name AS skill_name
        FROM capability_claims c
        JOIN hr_skills s ON s.id = c.skill_id
       WHERE c.subject_kind = ${subject.kind} AND c.subject_id = ${String(subject.id)}
       LIMIT 300`))
      .filter((r: any) => isEvidenceLevel(r.evidence_level) && atLeast(r.evidence_level, 'demonstrated'));

    if (!demonstrated.length) {
      return {
        ...report,
        ok: true,
        sentence: 'Nothing on this record has been demonstrated, so there is nothing to infer from. '
          + 'A skill somebody wrote down does not imply a broader one.',
      };
    }

    const held = new Set(demonstrated.map((r: any) => String(r.skill_id)));
    for (const row of demonstrated) {
      const implied = await impliedBy(String(row.skill_id));
      for (const node of implied) {
        if (held.has(node.skillId)) {
          report.skipped.push(node.name + ' is already held directly, so no inference was recorded.');
          continue;
        }
        const made = await recordClaim({
          subject,
          skillId: node.skillId,
          source: 'ontology_inference',
          sourceDetail: 'Inferred from ' + String(row.skill_name),
          actorUserId: input?.actorUserId,
        });
        if (!made.ok || !made.id) {
          report.skipped.push('Could not record an inference for ' + node.name + ': ' + (made.error || 'unknown reason'));
          continue;
        }
        const attached = await attachEvidence({
          claimId: made.id,
          kind: 'ontology_inference',
          sourceId: node.path.length ? node.path.join(' > ') : node.skillId,
          locator: 'skill graph: ' + String(row.skill_name) + ' sits under ' + node.name,
          note: node.sentence,
          actorUserId: input?.actorUserId,
        });
        if (attached.ok) {
          report.created.push({
            skillId: node.skillId, skillName: node.name, fromSkillName: String(row.skill_name), claimId: made.id,
          });
        } else if (attached.error) {
          report.skipped.push(node.name + ': ' + attached.error);
        }
      }
    }
    return {
      ...report,
      ok: true,
      sentence: report.created.length + ' broader skill' + (report.created.length === 1 ? '' : 's')
        + ' recorded as inferred from demonstrated work. An inference is advisory: it says the person '
        + 'has plainly used the broader skill, not that they demonstrated it.',
    };
  } catch (e: any) {
    logFail(MOD, 'inferFromOntology', e);
    return { ...report, ok: false, sentence: 'Nothing was inferred.', error: e?.cause?.message || e?.message || 'unknown error' };
  }
}

// =================================================================================================
// CARRYING OVER WHAT THE SKILL MATRIX ALREADY KNOWS
// =================================================================================================

export interface MatrixImportReport {
  ok: boolean;
  claims: number;
  evidence: number;
  notes: string[];
  sentence: string;
  error?: string;
}

/**
 * Bring an employee's existing skill matrix rows into the graph as claims.
 *
 * THE LEVEL IS NOT COPIED. hr_employee_skills.level stays the level of record and this graph never
 * holds a second one. What is carried over is the part the matrix already got right and could not
 * express further: HOW the row was established. `source = 'course'` or `'assessment'` on a matrix row
 * could only have been written by src/lib/skills.ts AFTER it re-read the fact through the owning
 * module, so those rows arrive as confirmed evidence — with a note saying the confirmation happened
 * at write time and that the underlying record id was not stored on that row, so the chain names the
 * sentence rather than a row somebody can re-walk. That is a real limit and it is written down
 * rather than smoothed over.
 */
export async function importFromSkillMatrix(
  employeeId: string,
  actorUserId?: string | null,
): Promise<MatrixImportReport> {
  const report: MatrixImportReport = { ok: false, claims: 0, evidence: 0, notes: [], sentence: '' };
  if (!isUuid(employeeId)) return { ...report, sentence: 'That employee record does not exist.' };
  const subject: ClaimSubject = { kind: 'employee', id: employeeId };
  try {
    const rows = await skillsForEmployee(employeeId);
    if (!rows.length) {
      return { ...report, ok: true, sentence: 'This person has no rows in the skill matrix, so there was nothing to carry over.' };
    }
    for (const row of rows) {
      const source: ClaimSource = row.source === 'self' ? 'self_statement'
        : row.source === 'manager' ? 'manager'
          : 'skill_matrix_import';
      const made = await recordClaim({
        subject,
        skillId: row.skillId,
        source,
        sourceDetail: 'Skill matrix: level ' + row.level + ' (' + row.levelLabel + '), '
          + (SKILL_SOURCE_LABELS[row.source] || row.source).toLowerCase(),
        actorUserId,
      });
      if (!made.ok || !made.id) {
        report.notes.push('Could not carry over ' + row.skillName + ': ' + (made.error || 'unknown reason'));
        continue;
      }
      report.claims += 1;

      const kind = row.source === 'course' ? 'course_completion'
        : row.source === 'assessment' ? 'assessment_pass'
          : row.source === 'manager' ? 'manager_statement'
            : 'cv_statement';
      // The confirmable kinds cannot be re-walked: the matrix row kept a sentence and a link, not the
      // id of the course or the attempt. Rather than pretend, they are attached as the statement they
      // are, marked with where the confirmation actually happened.
      if (kind === 'course_completion' || kind === 'assessment_pass') {
        const written = await db.execute(sql`
          INSERT INTO capability_evidence
            (claim_id, evidence_kind, owner_module, source_table, source_id, document_url, locator,
             occurred_at, supports_level, verification_status, confirmed_detail, confirmed_at, note, added_by_user_id)
          SELECT ${made.id}::uuid, ${kind}, 'src/lib/skills.ts', 'hr_employee_skills', ${row.id},
                 ${row.evidenceUrl}::text, NULL, ${row.assessedAt}::timestamptz, 'demonstrated',
                 'confirmed_by_owner', ${row.evidence}::text, NOW(),
                 'Carried over from the skill matrix. The confirmation was made by src/lib/skills.ts when the row was written; the underlying record id was not stored on it, so this step cannot be re-walked.',
                 ${isUuid(actorUserId) ? String(actorUserId) : null}::uuid
           WHERE NOT EXISTS (
             SELECT 1 FROM capability_evidence
              WHERE claim_id = ${made.id}::uuid AND evidence_kind = ${kind}
                AND COALESCE(source_id, '') = ${row.id})
          RETURNING id`);
        if (rowsOf(written).length) report.evidence += 1;
        await recomputeClaimLevel(made.id);
      } else {
        const attached = await attachEvidence({
          claimId: made.id,
          kind,
          sourceId: row.id,
          documentUrl: row.evidenceUrl,
          note: row.evidence,
          occurredAt: row.assessedAt,
          actorUserId,
        });
        if (attached.ok) report.evidence += 1;
      }
    }
    return {
      ...report,
      ok: true,
      sentence: report.claims + ' skill matrix row' + (report.claims === 1 ? '' : 's') + ' carried over as claims, with '
        + report.evidence + ' evidence record' + (report.evidence === 1 ? '' : 's') + '. '
        + 'The level of record stays in the skill matrix; this graph holds what the level rests on.',
    };
  } catch (e: any) {
    logFail(MOD, 'importFromSkillMatrix', e);
    return { ...report, ok: false, sentence: 'Nothing was carried over.', error: e?.cause?.message || e?.message || 'unknown error' };
  }
}

// =================================================================================================
// THE QUESTION
// =================================================================================================

async function claimRowsFor(subjects: LinkedSubject[], skillId: string | null): Promise<{ rows: ClaimRow[]; unreadable: boolean }> {
  const out: ClaimRow[] = [];
  let unreadable = false;
  for (const s of subjects) {
    try {
      const rows = rowsOf(await db.execute(sql`
        SELECT c.id::text AS id, c.subject_kind, c.subject_id, c.skill_id::text AS skill_id,
               c.source, c.source_detail, c.evidence_level, c.level_computed_at, c.created_at,
               s.name AS skill_name, s.category
          FROM capability_claims c
          JOIN hr_skills s ON s.id = c.skill_id
         WHERE c.subject_kind = ${s.subject.kind} AND c.subject_id = ${String(s.subject.id)}
           ${skillId ? sql`AND c.skill_id = ${skillId}::uuid` : sql``}
         ORDER BY s.name ASC
         LIMIT 500`));
      for (const r of rows) out.push(mapClaim(r, s.via || null));
    } catch (e: any) {
      logFail(MOD, 'claimRowsFor', e);
      unreadable = true;
    }
  }
  return { rows: out, unreadable };
}

/**
 * WHY DOES THE SYSTEM BELIEVE THIS PERSON HAS THIS CAPABILITY.
 *
 * One call, and the answer is rows: the claim, every piece of evidence with the module that owns it,
 * the document, where in the document, when, and whether anybody checked it — plus every written
 * verdict. Where there is nothing, the answer is the sentence that there is nothing. Where a read
 * failed, `unreadable` is true and the sentence says so instead of pretending to an empty record.
 *
 * The skill matrix level is fetched and returned SEPARATELY. "Recorded at level 4 by a manager" and
 * "the evidence supports demonstrated" are two different statements about a person and this function
 * never merges them into one number.
 */
export async function whyDoesTheSystemBelieve(
  subject: ClaimSubject,
  skillRef: string,
  opts: { includeLinked?: boolean } = {},
): Promise<BeliefAnswer> {
  const base: BeliefAnswer = {
    found: false,
    unreadable: false,
    subject,
    skillId: '',
    skillName: '',
    claims: [],
    chain: [],
    verifications: [],
    level: null,
    levelLabel: null,
    assertion: null,
    recordedLevel: null,
    joins: [],
    sentence: '',
    identityNote: IDENTITY_NOT_JOINED,
  };
  if (!subject || !isSubjectKind(subject.kind) || !clean(subject.id, 80)) {
    return { ...base, sentence: 'No person was named, so there is nothing to answer.' };
  }

  // The skill may arrive as an id or as the word somebody typed. Both resolve to one node.
  const node = isUuid(skillRef) ? await skillNode(skillRef) : (await resolveSkillNode(skillRef)).node;
  if (!node) {
    return {
      ...base,
      sentence: 'That skill is not in the catalogue, so nothing can be said about it. '
        + 'A word that is not a skill node is not a capability.',
    };
  }
  base.skillId = node.id;
  base.skillName = node.name;

  try {
    await ensureEvidenceGraphSchema();
    const subjects: LinkedSubject[] = [{ subject, via: '' }];
    if (opts.includeLinked !== false) {
      for (const l of await linkedSubjects(subject)) subjects.push(l);
    }
    base.joins = subjects.filter((s) => s.via).map((s) => s.via);

    const { rows: claims, unreadable } = await claimRowsFor(subjects, node.id);
    base.unreadable = unreadable;
    base.claims = claims;

    if (claims.length) {
      const ids = claims.map((c) => c.id).filter(isUuid);
      if (ids.length) {
        const steps = rowsOf(await db.execute(sql`
          SELECT * FROM capability_evidence
           WHERE claim_id = ANY(${ids}::uuid[])
           ORDER BY created_at ASC LIMIT 500`));
        base.chain = steps.map(mapStep);
        const verdicts = rowsOf(await db.execute(sql`
          SELECT * FROM capability_verifications
           WHERE claim_id = ANY(${ids}::uuid[])
           ORDER BY created_at DESC LIMIT 200`));
        base.verifications = verdicts.map(mapVerification);
      }
      base.found = true;
      let level: EvidenceLevel | null = null;
      for (const c of claims) level = level ? strongestLevel(level, c.evidenceLevel) : c.evidenceLevel;
      base.level = level;
      base.levelLabel = level ? EVIDENCE_LEVEL_LABELS[level] : null;
      base.assertion = level ? ASSERTION_BY_EVIDENCE_LEVEL[level] : null;
    }

    // The matrix figure, through its owner. Never a query of our own against hr_employee_skills.
    if (subject.kind === 'employee' && isUuid(subject.id)) {
      const matrix = await skillsForEmployee(subject.id);
      const row = matrix.find((m) => m.skillId === node.id);
      if (row) {
        base.recordedLevel = {
          level: row.level,
          levelLabel: SKILL_LEVEL_LABELS[row.level] || String(row.level),
          source: row.source,
          sourceLabel: SKILL_SOURCE_LABELS[row.source] || row.source,
          evidence: row.evidence,
          evidenceUrl: row.evidenceUrl,
          assessedAt: row.assessedAt,
        };
        base.found = true;
      }
    }

    const strongestStep = base.chain
      .filter((s) => s.contributes)
      .sort((a, b) => LEVEL_RANK[b.contributes as EvidenceLevel] - LEVEL_RANK[a.contributes as EvidenceLevel])[0] || null;
    const supporting = base.verifications.find((v) => v.verdict === 'supports') || null;

    return {
      ...base,
      sentence: beliefSentence({
        skillName: node.name,
        found: base.found,
        unreadable: base.unreadable,
        level: base.level,
        stepCount: base.chain.length,
        strongestStep: strongestStep ? strongestStep.sentence : null,
        verifierName: supporting ? supporting.verifierName : null,
        recordedLevel: base.recordedLevel,
      }),
    };
  } catch (e: any) {
    logFail(MOD, 'whyDoesTheSystemBelieve', e);
    return {
      ...base,
      unreadable: true,
      sentence: beliefSentence({
        skillName: node.name, found: false, unreadable: true, level: null,
        stepCount: 0, strongestStep: null, verifierName: null, recordedLevel: null,
      }),
    };
  }
}

/** Every capability claim on one record, strongest first. */
export async function claimsForSubject(
  subject: ClaimSubject,
  opts: { includeLinked?: boolean } = {},
): Promise<{ ok: boolean; claims: ClaimRow[]; joins: string[]; sentence: string }> {
  if (!subject || !isSubjectKind(subject.kind) || !clean(subject.id, 80)) {
    return { ok: false, claims: [], joins: [], sentence: 'No person was named.' };
  }
  try {
    await ensureEvidenceGraphSchema();
    const subjects: LinkedSubject[] = [{ subject, via: '' }];
    if (opts.includeLinked !== false) {
      for (const l of await linkedSubjects(subject)) subjects.push(l);
    }
    const { rows, unreadable } = await claimRowsFor(subjects, null);
    rows.sort((a, b) => LEVEL_RANK[b.evidenceLevel] - LEVEL_RANK[a.evidenceLevel] || a.skillName.localeCompare(b.skillName));
    return {
      ok: !unreadable,
      claims: rows,
      joins: subjects.filter((s) => s.via).map((s) => s.via),
      sentence: unreadable
        ? 'Some records could not be read, so this list is incomplete and must not be read as a full picture.'
        : rows.length + ' capability claim' + (rows.length === 1 ? '' : 's') + ' on record. ' + IDENTITY_NOT_JOINED,
    };
  } catch (e: any) {
    logFail(MOD, 'claimsForSubject', e);
    return { ok: false, claims: [], joins: [], sentence: 'We could not read the capability records.' };
  }
}

// =================================================================================================
// A REQUIREMENT LIST MEETS A PERSON — AND IS NOT TOTALLED
// =================================================================================================

export type CoverageStatus = 'evidenced' | 'claimed_only' | 'inferred_only' | 'nothing_on_record' | 'unreadable';

export const COVERAGE_STATUS_LABELS: Record<CoverageStatus, string> = {
  evidenced: 'Evidenced',
  claimed_only: 'Claimed, not evidenced',
  inferred_only: 'Inferred from something else',
  nothing_on_record: 'Nothing on record',
  unreadable: 'Could not be read',
};

export interface CoverageItem {
  requiredSkillId: string;
  requiredSkillName: string;
  status: CoverageStatus;
  level: EvidenceLevel | null;
  levelLabel: string | null;
  /** How the requirement was reached: the same node, something underneath it, a substitute. */
  route: RequirementResolution;
  claimId: string | null;
  sentence: string;
}

export interface CoverageReport {
  ok: boolean;
  items: CoverageItem[];
  counts: Record<CoverageStatus, number>;
  /** There is deliberately no score, and this sentence is why. */
  sentence: string;
  identityNote: string;
}

/**
 * Per requirement: is there evidence, is it only claimed, is it only inferred, or is there nothing.
 *
 * IT RETURNS NO TOTAL AND NO PERCENTAGE, and that is the feature. The two sides of a match in this
 * codebase have never shared a vocabulary — a role's skills are free-text strings and a capability is
 * a catalogue node — and a number over that gap is keyword overlap wearing a score. Counts of named
 * statuses are honest; one number that ranks a human against a job is not, and a human reading a
 * percentage stops reading the rows underneath it.
 */
export async function requirementCoverage(
  subject: ClaimSubject,
  requiredSkillIds: readonly string[],
): Promise<CoverageReport> {
  const counts: Record<CoverageStatus, number> = {
    evidenced: 0, claimed_only: 0, inferred_only: 0, nothing_on_record: 0, unreadable: 0,
  };
  const empty: CoverageReport = {
    ok: false, items: [], counts,
    sentence: 'Nothing could be compared.',
    identityNote: IDENTITY_NOT_JOINED,
  };
  const required = (requiredSkillIds || []).filter(isUuid).slice(0, 100);
  if (!required.length) return { ...empty, ok: true, sentence: 'No requirements were given.' };

  const held = await claimsForSubject(subject);
  if (!held.ok) {
    return {
      ...empty,
      sentence: 'The capability records could not be read, so no requirement can be answered. '
        + 'This is not a statement that the person lacks them.',
    };
  }
  const bySkill = new Map<string, ClaimRow>();
  for (const c of held.claims) {
    const prev = bySkill.get(c.skillId);
    if (!prev || LEVEL_RANK[c.evidenceLevel] > LEVEL_RANK[prev.evidenceLevel]) bySkill.set(c.skillId, c);
  }
  const heldIds = Array.from(bySkill.keys());

  const items: CoverageItem[] = [];
  for (const id of required) {
    const route = await requirementResolution(id, heldIds);
    let status: CoverageStatus = 'nothing_on_record';
    let claim: ClaimRow | null = null;
    if (route.match === 'unreadable') {
      status = 'unreadable';
    } else if (route.match === 'exact') {
      claim = bySkill.get(id) || null;
      status = claim && atLeast(claim.evidenceLevel, 'demonstrated')
        ? 'evidenced'
        : (claim && claim.evidenceLevel === 'inferred' ? 'inferred_only' : 'claimed_only');
    } else if (route.match === 'narrower' || route.match === 'substitute' || route.match === 'broader_only') {
      claim = route.viaSkillId ? bySkill.get(route.viaSkillId) || null : null;
      status = 'inferred_only';
    }
    counts[status] += 1;
    items.push({
      requiredSkillId: id,
      requiredSkillName: route.requiredSkillName,
      status,
      level: claim ? claim.evidenceLevel : null,
      levelLabel: claim ? claim.evidenceLevelLabel : null,
      route,
      claimId: claim ? claim.id : null,
      sentence: route.sentence + ' ' + (claim
        ? 'On record as ' + claim.evidenceLevelLabel.toLowerCase() + '.'
        : 'Nothing on record supports it.'),
    });
  }

  return {
    ok: true,
    items,
    counts,
    sentence: counts.evidenced + ' of ' + required.length + ' requirement'
      + (required.length === 1 ? '' : 's') + ' have evidence behind them; '
      + counts.claimed_only + ' are claimed only and ' + counts.nothing_on_record + ' have nothing on record. '
      + 'There is no overall match score here on purpose: a requirement list is a set of separate '
      + 'questions and a single number would hide which ones were answered.',
    identityNote: IDENTITY_NOT_JOINED,
  };
}

// =================================================================================================
// SELF-CHECK — the invariants, checkable without a database or a test runner
// =================================================================================================

/**
 * Returns what is WRONG. An empty array is the pass.
 *
 * These are the properties that make the module honest rather than the ones that make it work, which
 * is why they are checked at runtime by a screen rather than by a test file nothing in this worktree
 * can run: no keyword reaches 'demonstrated', no kind we own claims external verification, and every
 * level maps onto exactly one word of the system provenance vocabulary.
 */
export function evidenceGraphSelfCheck(): string[] {
  const problems: string[] = [];

  for (const l of EVIDENCE_LEVELS) {
    if (!EVIDENCE_LEVEL_LABELS[l]) problems.push('Level ' + l + ' has no label.');
    if (!EVIDENCE_LEVEL_MEANING[l]) problems.push('Level ' + l + ' has no explanation.');
    if (!ASSERTION_BY_EVIDENCE_LEVEL[l]) problems.push('Level ' + l + ' maps to no provenance word.');
    if (typeof LEVEL_RANK[l] !== 'number') problems.push('Level ' + l + ' has no rank.');
  }
  const ranks = EVIDENCE_LEVELS.map((l) => LEVEL_RANK[l]);
  if (new Set(ranks).size !== ranks.length) problems.push('Two evidence levels share a rank.');
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i] <= ranks[i - 1]) problems.push('The ladder is not in ascending order at ' + EVIDENCE_LEVELS[i] + '.');
  }

  const seen = new Set<string>();
  for (const k of EVIDENCE_KINDS) {
    if (seen.has(k.kind)) problems.push('Evidence kind ' + k.kind + ' is declared twice.');
    seen.add(k.kind);
    if (!isEvidenceLevel(k.supports)) problems.push('Evidence kind ' + k.kind + ' supports an unknown level.');
    if (k.needs === 'none' && atLeast(k.supports, 'demonstrated')) {
      problems.push('Evidence kind ' + k.kind + ' claims to demonstrate a capability with nothing to confirm it. '
        + 'A keyword is not proof of competence.');
    }
    if (k.supports === 'externally_verified' && k.needs === 'none') {
      problems.push('Evidence kind ' + k.kind + ' claims external verification with nobody outside checking it.');
    }
    if (atLeast(k.supports, 'professionally_demonstrated') && k.needs !== 'human_verdict'
      && k.kind !== 'background_check') {
      problems.push('Evidence kind ' + k.kind + ' reaches ' + k.supports + ' without a named human saying so.');
    }
  }

  const cv = evidenceKindSpec('cv_statement');
  if (!cv || cv.supports !== 'claimed') problems.push('A CV statement must support exactly "claimed".');
  const inference = evidenceKindSpec('ontology_inference');
  if (!inference || inference.supports !== 'inferred') problems.push('An ontology inference must support exactly "inferred".');
  if (contributionOf('course_completion', 'unverified') !== 'claimed') {
    problems.push('An unconfirmed course completion must contribute nothing above "claimed".');
  }
  if (contributionOf('employment_work_evidence', 'confirmed_by_owner') !== 'claimed') {
    problems.push('Work evidence must not reach professionally demonstrated without a human verdict.');
  }
  if (contributionOf('background_check', 'confirmed_by_owner') !== 'externally_verified') {
    problems.push('A confirmed background check should support external verification.');
  }
  if (contributionOf('cv_statement', 'refused') !== null) {
    problems.push('A refused evidence row must contribute nothing.');
  }

  for (const s of CLAIM_SOURCES) {
    if (!CLAIM_SOURCE_LABELS[s]) problems.push('Claim source ' + s + ' has no label.');
    const floor = FLOOR_BY_SOURCE[s];
    if (!isEvidenceLevel(floor)) problems.push('Claim source ' + s + ' has no floor.');
    else if (s !== 'ontology_inference' && atLeast(floor, 'inferred')) {
      problems.push('Claim source ' + s + ' starts at ' + floor + '. A statement somebody typed must start at claimed or explicit.');
    }
  }
  if (MIN_REASON_CHARS < 1) problems.push('A verdict must require a written reason.');
  return problems;
}
