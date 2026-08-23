// src/lib/horizon/report/types.ts — THE OWNED CONTRACT OF PATCH 18. Extend additively; never edit
// a field another patch may already read.
//
// =================================================================================================
// SIX SECTIONS, AND THE REASON THEY ARE AN OBJECT RATHER THAN AN ARRAY
// =================================================================================================
//
// Every report this engine produces separates what it knows into six kinds, in this order:
//
//   1. FACTS / RECORDS        what the organisation actually recorded. A row exists.
//   2. DERIVED METRICS        arithmetic over those rows. No opinion, but a method and a window.
//   3. HUMAN FEEDBACK         what named people said. Opinions, kept as opinions.
//   4. AI INTERPRETATION      what a machine read into 1-3. Never a fact, never a decision.
//   5. RECOMMENDATION         a suggested next act. Always overridable, always needs a human.
//   6. FINAL HUMAN DECISION   what a named person decided, and whether they followed the machine.
//
// The brief says these must never blur. The obvious implementation is an array of sections with a
// `kind` field, and the obvious failure of that implementation is that nothing stops a caller
// pushing a derived metric into the AI section — the types are identical, so the compiler is silent
// and the blur ships. So `ReportDocument.sections` is a NAMED OBJECT whose six properties have six
// DIFFERENT claim types. Putting an inference where a fact belongs is a type error at the call site
// that makes the mistake, not a review comment on the pull request that ships it.
//
// The ordering above is also the evidential ordering, and it is load-bearing rather than cosmetic —
// see EVIDENCE_WEIGHT below, which the interpreter is capped by.
//
// =================================================================================================
// WHAT THIS MODULE DELIBERATELY DOES NOT DEFINE
// =================================================================================================
//
// EvidenceRef, SubjectRef, ConsequentialDecision, AiPermittedAct and StoredRecommendation come from
// src/lib/ai-boundary.ts and are RE-EXPORTED here, not redeclared. That module already owns the line
// between what a machine may conclude and what a person must decide; it owns ai_recommendations and
// ai_human_decisions; and it already refuses a recommendation that cannot answer its seven
// explanation questions. A second vocabulary for the same concepts would let two screens disagree
// about what "evidence" means, which is precisely the failure this engine exists to prevent.
import type {
  EvidenceRef, SubjectRef, ConsequentialDecision, AiPermittedAct, StoredRecommendation,
} from '@/lib/ai-boundary';
import type { Permission } from '@/lib/auth/permissions';

export type { EvidenceRef, SubjectRef, ConsequentialDecision, AiPermittedAct, StoredRecommendation };

// =================================================================================================
// SECTIONS
// =================================================================================================

export const SECTION_KINDS = [
  'facts',
  'derived',
  'human_feedback',
  'ai_interpretation',
  'recommendation',
  'human_decision',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** Render order. Identical to declaration order, exported separately so a renderer never guesses. */
export const SECTION_ORDER: readonly SectionKind[] = SECTION_KINDS;

export const SECTION_TITLES: Record<SectionKind, string> = {
  facts: 'Facts and records',
  derived: 'Derived metrics',
  human_feedback: 'Human feedback',
  ai_interpretation: 'System interpretation',
  recommendation: 'Recommendation',
  human_decision: 'Final human decision',
};

/**
 * One sentence per section, shown above it. These say what a section IS and, just as importantly,
 * what it is not — a reader who skips the header must still not mistake section 4 for section 1.
 */
export const SECTION_DESCRIPTIONS: Record<SectionKind, string> = {
  facts: 'Records the organisation holds. Each one is a row somebody wrote, not a conclusion.',
  derived: 'Arithmetic over those records. Each states its method, its window and how many records it counted.',
  human_feedback: 'What named people said, kept as their opinion. Disagreement is preserved, not averaged away.',
  ai_interpretation: 'Patterns a system read into the sections above. Not a fact and not a finding about a person.',
  recommendation: 'A suggested next step. Advisory, overridable, and inert until a person acts on it.',
  human_decision: 'What a named person decided, when, and whether they followed the suggestion.',
};

/**
 * HOW MUCH A CLASS OF CLAIM MAY COUNT TOWARDS A CONCLUSION.
 *
 * The brief requires that demonstrated job-related evidence outweigh anything inferred. A comment
 * saying so would be obeyed for about a month, so it is a number the interpreter is arithmetically
 * capped by: confidenceCeiling() in provenance.ts returns the weight of the strongest class an
 * interpretation actually drew on, and no interpretation may report a confidence score above it.
 *
 * An interpretation resting on nothing but other interpretations therefore cannot claim to be
 * confident, which is the correct behaviour and not something a reviewer should have to notice.
 */
export const EVIDENCE_WEIGHT: Record<SectionKind, number> = {
  facts: 1.0,
  derived: 0.8,
  human_feedback: 0.65,
  ai_interpretation: 0.35,
  // A recommendation is not evidence for anything. It is the output of weighing evidence.
  recommendation: 0,
  // Neither is a decision — it is the act the whole document exists to inform.
  human_decision: 0,
};

// =================================================================================================
// PROVENANCE — REQUIRED ON EVERY CLAIM, NOT JUST THE INTERESTING ONES
// =================================================================================================
//
// The brief asks for evidence, source, confidence, timestamp and engine version on every MAJOR
// conclusion. This contract asks for them on every claim, because "major" is a judgement made by
// whoever writes the claim and the cheap way to lose provenance is to decide something was minor.
// `major` still exists, and it tightens the rule further: a major claim must additionally carry at
// least one EvidenceRef pointing at a real row. See validateClaim() in provenance.ts.

/**
 * How sure the engine is, in words before numbers.
 *
 * `observed` is not a high score — it is a different KIND of statement. A recorded clock-in is not
 * 95% likely to have happened; it happened, and the row says so. Keeping it out of the numeric
 * ladder stops a renderer sorting facts and guesses into one list by score.
 */
export type ConfidenceLevel = 'observed' | 'high' | 'moderate' | 'low' | 'insufficient';

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  observed: 'Recorded',
  high: 'High confidence',
  moderate: 'Moderate confidence',
  low: 'Low confidence',
  insufficient: 'Not enough evidence',
};

export interface Confidence {
  level: ConfidenceLevel;
  /** 0-1. Null for `observed`, which is a record rather than an estimate. */
  score: number | null;
  /** Why it is that confident, in a sentence a reader can argue with. Never blank. */
  basis: string;
}

/**
 * Where a claim came from. Points at a SYSTEM AND A RELATION, not at "the HR module" — a reader
 * checking a number needs to know which table to open, and an auditor needs to know which patch
 * owns it when the number is wrong.
 */
export interface SourceRef {
  /** SourceProvider.descriptor.id that produced this. */
  provider: string;
  /** The subsystem: 'hrms' | 'talent' | 'performance' | 'ai_boundary' | 'horizon'. */
  system: string;
  /** The actual relation read. */
  table: string;
  /** The row, when the claim is about one row. */
  recordId?: string | null;
  /** When that row was written or last changed, if the table records it. */
  capturedAt?: string | null;
  /** Which patch owns the data. Auditability: the report is not the place to fix a wrong row. */
  ownedBy: string;
}

export interface ModelStamp {
  name: string;
  version: string;
  /**
   * `first_party` means this codebase computed it and no third party saw the data.
   * `connector` means an external service was called, and that is a disclosure in itself.
   */
  provider: 'first_party' | 'connector';
}

export interface EngineStamp {
  engineId: string;
  engineVersion: string;
  interpreterId: string | null;
  interpreterVersion: string | null;
  model: ModelStamp | null;
}

export interface Provenance {
  /** At least one. A claim with no source is refused rather than shown. */
  sources: SourceRef[];
  /** Rows this rests on. Required to be non-empty when the claim is `major`. */
  evidence: EvidenceRef[];
  confidence: Confidence;
  /** ISO 8601. The moment the claim was computed, not the moment the row was written. */
  generatedAt: string;
  engine: EngineStamp;
}

// =================================================================================================
// CLAIMS — ONE TYPE PER SECTION, SO THE SECTIONS CANNOT BE BLURRED
// =================================================================================================

interface ClaimCommon {
  /** Stable within a document. Used by the renderer and by decision records that cite a claim. */
  id: string;
  /** The claim in one sentence, written for the audience of the report. */
  statement: string;
  provenance: Provenance;
  /**
   * A conclusion somebody might act on, as opposed to a supporting detail. Major claims are
   * validated harder (evidence required) and rendered with their provenance expanded by default.
   */
  major?: boolean;
}

/** Section 1. A row exists and says this. */
export interface FactClaim extends ClaimCommon {
  kind: 'facts';
  label: string;
  value: string;
  /** When the thing happened, where the record carries that separately from when it was written. */
  occurredAt?: string | null;
}

/** Section 2. Arithmetic. Carries its method and its denominator so it can be checked. */
export interface DerivedClaim extends ClaimCommon {
  kind: 'derived';
  label: string;
  value: number | string;
  unit?: string | null;
  /** How it was computed, in words. "Mean of overall_rating across submitted reviews", not "score". */
  method: string;
  /** The period it covers. A metric with no window invites comparison across different periods. */
  window?: { from: string; to: string } | null;
  /**
   * How many records it counted. A mean of one is not a mean, and this is the number that tells a
   * reader so without them having to open the table.
   */
  basisCount: number;
}

/** Section 3. Somebody's opinion, attributed and kept whole. */
export interface HumanFeedbackClaim extends ClaimCommon {
  kind: 'human_feedback';
  author: {
    /** users.id or hr_employees.id, whichever the source table holds. Null when anonymised. */
    id: string | null;
    name: string;
    /** 'manager' | 'peer' | 'report' | 'reviewer' | 'self' | 'unknown'. */
    relation: string;
  };
  theme: string;
  body: string;
  recordedAt: string | null;
  /**
   * SOURCE WEIGHTING, NOT AVERAGING. One person's view never becomes organisational truth here: the
   * weight says how much this voice counts in an aggregate, and the aggregate always ships alongside
   * the individual claims rather than replacing them.
   */
  weight: number;
  /** True when this claim disagrees with the majority of its peers on the same theme. */
  dissent?: boolean;
  /** True when it sits far enough from its peers to be worth a second look before it is used. */
  outlier?: boolean;
}

/** Section 4. What a machine read into sections 1-3. */
export interface AiInterpretationClaim extends ClaimCommon {
  kind: 'ai_interpretation';
  /** Which permitted act this is. A machine that cannot name one of these is deciding something. */
  act: AiPermittedAct;
  reasoning: string;
  assumptions: string;
  uncertainty: string;
  /** Which sections it actually drew on. Drives the confidence ceiling. */
  restsOn: SectionKind[];
}

/** Section 5. A suggestion. Structurally incapable of being an outcome. */
export interface RecommendationClaim extends ClaimCommon {
  kind: 'recommendation';
  suggestedAction: string;
  /**
   * Set only when the suggestion sits beside one of the six consequential decisions. When it is set,
   * `boundaryRecommendationId` must also be set: this engine does not mint its own recommendation
   * about hiring, rejection, termination, promotion, compensation or discipline. It surfaces one
   * that already passed the seven-question guard in ai-boundary, or it says nothing.
   */
  forDecisionKind: ConsequentialDecision | null;
  /** ai_recommendations.id, when this is a boundary recommendation being surfaced. */
  boundaryRecommendationId: string | null;
  /** Both are literal `true`. There is no code path that produces a different value. */
  overridable: true;
  requiresHumanDecision: true;
}

/** Section 6. What a person decided. Written by people, never by this engine. */
export interface HumanDecisionClaim extends ClaimCommon {
  kind: 'human_decision';
  decidedByUserId: string;
  decidedByName: string;
  decidedAt: string | null;
  decision: string;
  decisionKind: string;
  /** Null when there was no recommendation in front of them. */
  followedRecommendation: boolean | null;
  /** Required by ai_human_decisions' CHECK constraint when they did not follow it. */
  overrideReason: string | null;
  recommendationId: string | null;
}

export type Claim =
  | FactClaim
  | DerivedClaim
  | HumanFeedbackClaim
  | AiInterpretationClaim
  | RecommendationClaim
  | HumanDecisionClaim;

export type ClaimOfKind<K extends SectionKind> = Extract<Claim, { kind: K }>;

// =================================================================================================
// SECTIONS AND DOCUMENTS
// =================================================================================================

/**
 * What a section could not tell you. Rendered, not swallowed.
 *
 * A report that silently omits the half of itself it had no data for reads exactly like a report
 * that found nothing to say — and the difference between "this person has no negative feedback" and
 * "no feedback source is registered" is the difference between a fair reading and a false one.
 */
export interface SectionCoverage {
  /** Capability keys the section wanted. */
  requested: string[];
  /** Those that answered. */
  satisfied: string[];
  /** Those with no registered provider, or whose provider failed. One sentence each. */
  missing: { capability: string; reason: string }[];
}

export interface ReportSection<K extends SectionKind = SectionKind> {
  kind: K;
  title: string;
  description: string;
  claims: ClaimOfKind<K>[];
  coverage: SectionCoverage;
  /** True when the viewer's role removed claims from this section. Never silent. */
  redacted: boolean;
  redactionReason: string | null;
}

export type ReportSubjectKind = 'applicant' | 'employee' | 'manager' | 'organisation';

export interface ReportSubject {
  kind: ReportSubjectKind;
  /** The primary key in the subject's own table. */
  id: string;
  displayName: string;
  /** The ai-boundary shape, so recommendations and decisions can be looked up unchanged. */
  ref: SubjectRef;
}

export type ReportAudience =
  | 'recruiter'
  | 'interviewer'
  | 'employee_self'
  | 'manager'
  | 'hr'
  | 'founder';

export const AUDIENCE_LABELS: Record<ReportAudience, string> = {
  recruiter: 'Recruitment',
  interviewer: 'Interview panel',
  employee_self: 'The person themselves',
  manager: 'Reporting manager',
  hr: 'Human resources',
  founder: 'Founder',
};

export const REPORT_IDS = [
  'applicant_intelligence_summary',
  'interview_decision_support',
  'employee_professional_intelligence',
  'manager_development',
  'hr_talent_development',
  'founder_360_intelligence',
  'longitudinal_behaviour',
  'time_intelligence',
  'role_mobility',
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export interface DocumentCoverage {
  /** Providers that ran and answered. */
  satisfied: string[];
  /** Capability keys with no provider registered, or whose provider failed. */
  missing: { capability: string; reason: string }[];
  /** True when every capability the definition asked for was answered. */
  complete: boolean;
}

export interface DocumentIntegrity {
  claimCount: number;
  majorClaimCount: number;
  /** Claims rejected at build time for missing provenance. Always zero in a served document. */
  rejected: { section: SectionKind; statement: string; reason: string }[];
  /** The highest confidence any interpretation was allowed to claim, and why. */
  confidenceCeiling: number;
}

export interface ReportDocument {
  reportId: ReportId;
  title: string;
  purpose: string;
  subject: ReportSubject;
  audience: ReportAudience;
  /**
   * Named properties, not an array. See the header: this is the mechanism that makes "never blur the
   * categories" a compile-time property rather than a convention.
   */
  sections: {
    facts: ReportSection<'facts'>;
    derived: ReportSection<'derived'>;
    human_feedback: ReportSection<'human_feedback'>;
    ai_interpretation: ReportSection<'ai_interpretation'>;
    recommendation: ReportSection<'recommendation'>;
    human_decision: ReportSection<'human_decision'>;
  };
  coverage: DocumentCoverage;
  integrity: DocumentIntegrity;
  stamp: EngineStamp;
  generatedAt: string;
  generatedForUserId: string | null;
  /** ADVISORY_NOTICE, carried in the document so a consumer cannot render one without it. */
  notice: string;
  /** Set when the viewer saw less than the full document. */
  redactions: { section: SectionKind; reason: string }[];
}

// =================================================================================================
// DEFINITIONS — THE NINE REPORTS
// =================================================================================================

export interface ReportDefinition {
  id: ReportId;
  title: string;
  purpose: string;
  subjectKind: ReportSubjectKind;
  audience: ReportAudience;
  /**
   * ANY of these permits the report. Existing permissions from src/lib/auth/permissions.ts — this
   * patch deliberately adds no new permission names, because the permission union is a shared
   * contract several patches read and a report engine is not a reason to widen it.
   */
  requiredPermissions: Permission[];
  /** May the subject read it about themselves, with no admin permission at all. */
  allowSelf: boolean;
  /** Capability keys resolved against the source registry. */
  requires: string[];
  /** Look-back window in days. Null means "everything on record". */
  windowDays: number | null;
  /**
   * `elevated` reports carry claims that reveal how the organisation reasons about a person.
   * Rule 18: those are not shown to roles without explicit permission, even when the report is.
   */
  sensitivity: 'standard' | 'elevated';
  /**
   * The consequential decision this report typically sits beside, if any. Drives which boundary
   * recommendations and decisions are pulled into sections 5 and 6. Null for reports that inform no
   * particular decision.
   */
  decisionContext: ConsequentialDecision | null;
}

// =================================================================================================
// SOURCE PROVIDERS — HOW THE OTHER PATCHES' DATA REACHES A REPORT
// =================================================================================================
//
// This engine owns no employee data and creates no table that holds any. Every fact it prints comes
// through a provider, and a provider is the integration boundary the multi-agent rules ask for: a
// patch that owns a domain registers one and keeps ownership of its queries, its columns and its
// access rules. Nothing here reaches into another patch's tables on its own authority.
//
// A PROVIDER MAY ONLY PRODUCE SECTIONS 1-3. It cannot return an interpretation and it cannot return
// a recommendation — those are the interpreter's, and the split is enforced by the SourceLoad type
// having no field to put them in.

export interface SourceDescriptor {
  id: string;
  label: string;
  system: string;
  /** Relations this provider reads. Audited by a test against the forbidden-table list. */
  tables: string[];
  /** Which patch owns the data. Not a formality: it is who to talk to when a number is wrong. */
  ownedBy: string;
  /** Capability keys this provider can answer. */
  capabilities: string[];
  sensitivity: 'standard' | 'elevated';
  /**
   * THE SEAM FOR SIGNAL THAT IS INFERRED RATHER THAN DEMONSTRATED.
   *
   * A provider that marks itself `inferenceOnly` has every claim it returns capped at the
   * interpretation tier of EVIDENCE_WEIGHT, whichever section the claim lands in, and labelled as
   * inference in the rendered document. That is how the programme rule "demonstrated job-related
   * evidence outweighs anything inferred" is enforced against a provider this patch did not write
   * and cannot inspect: the cap is applied by the engine at load time, not requested of the author.
   *
   * Absent or false means the provider returns records and arithmetic over records.
   */
  inferenceOnly?: boolean;
}

export interface ViewerContext {
  userId: string | null;
  role: string;
  /** hr_employees.id for the viewer, when they are staff. Drives self and manager scoping. */
  employeeId: string | null;
  /** True when the viewer may see method-level internals. Rule 18. */
  canSeeInternals: boolean;
}

export interface SourceLoadContext {
  subject: ReportSubject;
  definition: ReportDefinition;
  window: { from: string; to: string } | null;
  now: string;
  stamp: EngineStamp;
  viewer: ViewerContext;
  /** Capability keys this provider is being asked for on this run. */
  capabilities: string[];
}

export interface SourceLoad {
  ok: boolean;
  providerId: string;
  facts: FactClaim[];
  derived: DerivedClaim[];
  humanFeedback: HumanFeedbackClaim[];
  /**
   * DECISIONS A NAMED PERSON ALREADY RECORDED, read back from wherever that patch keeps them.
   *
   * Optional, and added after the first three because most providers have none. It exists because
   * ai_human_decisions is not the only place a real human decision lives: tal_selection_decision has
   * a NOT NULL decided_by_user_id and a required reason, and it IS the decision on a hiring report.
   * A section 6 that could only read one table would have rendered empty on the two reports where
   * the decision matters most, and a reader would have concluded nobody had decided anything.
   *
   * A provider may report what people DID. It still may not produce an interpretation or a
   * recommendation — there is nowhere on this type to put one, and that is the line.
   */
  humanDecisions?: HumanDecisionClaim[];
  /**
   * INTERPRETATION ANOTHER PATCH ALREADY PRODUCED AND LABELLED, relayed rather than invented.
   *
   * A provider still may not FORM an interpretation. This slot exists for the different case: the
   * HORIZON master record carries results and signals that other patches computed and stamped
   * `ai_interpretation` themselves, and dropping them on the way in would lose real content, while
   * putting them in `facts` would be exactly the blur this engine exists to prevent. Relaying them
   * into section 4 with their original producer named is the only reading of rule 13 that keeps the
   * five categories distinct.
   *
   * Everything here goes through the same validation as this engine's own interpretation, including
   * the confidence ceiling.
   */
  upstreamInterpretation?: AiInterpretationClaim[];
  /**
   * A RECOMMENDATION ANOTHER PATCH ALREADY PRODUCED, relayed on the same terms.
   *
   * Safe by construction rather than by trust: validateClaim() refuses any recommendation tagged with
   * one of the six consequential decisions unless it carries the id of a row that passed ai-boundary's
   * guard. A relayed recommendation to schedule a conversation goes through; a relayed recommendation
   * to reject somebody does not, whoever produced it.
   */
  upstreamRecommendation?: RecommendationClaim[];
  /** Anything the reader should know about what this load could and could not see. */
  notes: string[];
  error: string | null;
}

export interface SourceProvider {
  descriptor: SourceDescriptor;
  load(ctx: SourceLoadContext): Promise<SourceLoad>;
}

// =================================================================================================
// INTERPRETER — THE SWAPPABLE SEAM FOR SECTIONS 4 AND 5
// =================================================================================================

export interface InterpretationInput {
  definition: ReportDefinition;
  subject: ReportSubject;
  facts: FactClaim[];
  derived: DerivedClaim[];
  humanFeedback: HumanFeedbackClaim[];
  /**
   * Recommendations already stored through ai-boundary for this subject. The interpreter may surface
   * these; it may not invent a replacement for one.
   */
  boundaryRecommendations: StoredRecommendation[];
  stamp: EngineStamp;
  now: string;
}

export interface InterpretationResult {
  ok: boolean;
  interpretation: AiInterpretationClaim[];
  recommendations: RecommendationClaim[];
  notes: string[];
  error?: string | null;
}

export interface Interpreter {
  id: string;
  version: string;
  /** `first_party` computes here and sends nothing anywhere. See ModelStamp. */
  provider: 'first_party' | 'connector';
  model: ModelStamp;
  interpret(input: InterpretationInput): Promise<InterpretationResult>;
}

// =================================================================================================
// GENERATION
// =================================================================================================

export interface GenerateOptions {
  reportId: ReportId;
  /** The subject's primary key: hr_employees.id, tal_application.id, or the organisation sentinel. */
  subjectId: string;
  viewer: { id: string | null; role: string | null };
  /** Overrides the registered default. Used by tests and by a future connector. */
  interpreter?: Interpreter;
  /** Persist the run to hzn_report_run. Default true; false for previews and tests. */
  persist?: boolean;
}

export interface GenerateResult {
  ok: boolean;
  /** hzn_report_run.id when persisted. */
  runId: string | null;
  document: ReportDocument | null;
  /** Why not, in a sentence for the person who asked. */
  error: string | null;
  /** Set when the refusal was an access decision rather than a fault. */
  denied?: boolean;
}
