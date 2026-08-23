// src/lib/horizon/types.ts — THE OWNED CONTRACT for the HORIZON Human Intelligence System.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md sections 3, 7, 8, 9.
//
// Every module under src/lib/horizon/ and every later HORIZON patch imports its shapes from here
// and NOTHING defines its own copy. Extend this file ADDITIVELY. A second definition of Confidence
// somewhere else is how two screens end up disagreeing about what "high" means for the same person.
//
// NOTHING IN THIS FILE TOUCHES THE DATABASE. It is types, unions, labels and pure functions, so
// every rule below can be unit-tested without a connection.
//
// =================================================================================================
// THE ONE IDEA THIS FILE ENCODES
// =================================================================================================
//
// A record about a person is not one kind of thing. It is seven kinds of thing that look identical
// once they are rendered into the same table cell, and the entire moral weight of an HR
// intelligence system rests on never letting them blur:
//
//   RAW              what was recorded. A clock-in row. A submitted form.
//   COMPUTED         deterministic arithmetic over raw. Hours worked. Days since joining.
//   OBSERVED         a recorded act by a named party. A task was reassigned. A review was opened.
//   HUMAN_FEEDBACK   a named human's opinion. One person's opinion, not the organisation's truth.
//   AI_INTERPRETATION  a machine's reading of the four above. Always advisory. Always contestable.
//   RECOMMENDATION   advice addressed to a human who decides.
//   HUMAN_DECISION   the only layer that changes anybody's status.
//
// The order is the brief's. The RULE is not an index comparison — COMPUTED legitimately draws on
// OBSERVED even though OBSERVED sits after it in the list — so `mayCite` states it explicitly per
// layer, and validation enforces the statement rather than the ordering.
//
// TWO PROPERTIES ARE STRUCTURAL, NOT ADVISORY:
//
//   1. NO LAYER MAY BE REWRITTEN AS AN EARLIER ONE. An AI interpretation never becomes raw data.
//      This is the same rule src/lib/provenance.ts enforces for its assertion vocabulary, and it is
//      enforced the same way: there is no promote(), no setLayer(), and every constructed object is
//      frozen.
//   2. ONLY human_decision IS CONSEQUENTIAL. Rule 14 of the brief — no automated score may make a
//      hiring, rejection, promotion, termination or disciplinary decision — is expressed here as a
//      property of the layer, and validation refuses any result or signal that claims otherwise.
//
// =================================================================================================
// AND ONE PIECE OF LANGUAGE POLICY THAT IS ENFORCED IN CODE
// =================================================================================================
//
// Rule 19 forbids a particular word in applicant-facing, employee-facing, HR-facing and public copy.
// A rule like that survives exactly as long as the person who wrote it. FORBIDDEN_UI_TERMS plus
// `checkPublicCopy()` turn it into something a test can fail on, and contracts.test.ts runs that
// check across every exported label in this module.

import type {
  ActorRef, ComputationId, EvidenceId, FeedbackId, OrganisationId,
  ProfileId, ResultId, SignalId, SubjectRef,
} from './ids';

// =================================================================================================
// 3. THE CANONICAL DATA SEPARATION
// =================================================================================================

export const DATA_LAYERS = [
  'raw',
  'computed',
  'observed',
  'human_feedback',
  'ai_interpretation',
  'recommendation',
  'human_decision',
] as const;

export type DataLayer = (typeof DATA_LAYERS)[number];

/**
 * How much weight a layer's content may carry in a decision.
 *
 * `may_decide` exists for exactly one layer. Everything a machine produces is advisory, and the
 * distinction between advisory_only and supporting_only is real: an inference may be shown beside a
 * decision but must never be its stated basis, while a computed fact may be cited as one.
 */
export type DecisionUse = 'may_decide' | 'supporting_only' | 'advisory_only';

export interface DataLayerSpec {
  layer: DataLayer;
  /** The word a screen prints for this layer. Neutral, non-technical, safe for every audience. */
  label: string;
  /** One sentence a screen may print to explain what the reader is looking at. */
  meaning: string;
  /** Which layers a value in this layer is allowed to have been derived from. */
  mayCite: readonly DataLayer[];
  decisionUse: DecisionUse;
  /** True only for human_decision. The layer that is allowed to change somebody's status. */
  consequential: boolean;
  /** True when a named human must be recorded against every item in this layer. */
  requiresNamedHuman: boolean;
}

export const DATA_LAYER_SPECS: Readonly<Record<DataLayer, DataLayerSpec>> = Object.freeze({
  raw: {
    layer: 'raw', label: 'Recorded',
    meaning: 'A record this platform holds of something that happened. Nobody’s opinion is in it.',
    mayCite: [], decisionUse: 'supporting_only', consequential: false, requiresNamedHuman: false,
  },
  computed: {
    layer: 'computed', label: 'Calculated',
    meaning: 'Arithmetic over records. It is only ever as good as those records, and it changes when they do.',
    mayCite: ['raw', 'observed'], decisionUse: 'supporting_only', consequential: false, requiresNamedHuman: false,
  },
  observed: {
    layer: 'observed', label: 'Observed',
    meaning: 'An act by a named party that this platform witnessed and recorded at the time.',
    mayCite: ['raw'], decisionUse: 'supporting_only', consequential: false, requiresNamedHuman: false,
  },
  human_feedback: {
    layer: 'human_feedback', label: 'Feedback from a person',
    meaning: 'One named person’s view, recorded on a date. One person’s view is not the organisation’s.',
    mayCite: ['raw', 'computed', 'observed'], decisionUse: 'supporting_only',
    consequential: false, requiresNamedHuman: true,
  },
  ai_interpretation: {
    layer: 'ai_interpretation', label: 'System interpretation',
    meaning: 'The system’s reading of the records above. Advisory, contestable, and never a finding of fact.',
    mayCite: ['raw', 'computed', 'observed', 'human_feedback'], decisionUse: 'advisory_only',
    consequential: false, requiresNamedHuman: false,
  },
  recommendation: {
    layer: 'recommendation', label: 'Suggested next step',
    meaning: 'Advice addressed to a person who decides. It is not an outcome and nothing follows from it on its own.',
    mayCite: ['raw', 'computed', 'observed', 'human_feedback', 'ai_interpretation'],
    decisionUse: 'advisory_only', consequential: false, requiresNamedHuman: false,
  },
  human_decision: {
    layer: 'human_decision', label: 'Decision by a person',
    meaning: 'A named person decided this, on a date, for a written reason. This is the only layer that changes anything.',
    mayCite: ['raw', 'computed', 'observed', 'human_feedback', 'ai_interpretation', 'recommendation'],
    decisionUse: 'may_decide', consequential: true, requiresNamedHuman: true,
  },
});

export function isDataLayer(v: unknown): v is DataLayer {
  return typeof v === 'string' && (DATA_LAYERS as readonly string[]).includes(v);
}

/** May a value in `layer` legitimately have been derived from a value in `cited`? */
export function mayCite(layer: DataLayer, cited: DataLayer): boolean {
  return DATA_LAYER_SPECS[layer].mayCite.includes(cited);
}

/**
 * The layers a HORIZON engine is allowed to WRITE.
 *
 * An engine records interpretations and recommendations. It does not record raw data (the owning
 * module does), it does not record feedback (a human does), and it certainly does not record
 * decisions. Enforced by validateIntelligenceResult().
 */
export const ENGINE_WRITABLE_LAYERS: readonly DataLayer[] = ['computed', 'ai_interpretation', 'recommendation'];

// =================================================================================================
// ENGINES, AND WHAT THEIR OUTPUT IS ENTITLED TO CLAIM
// =================================================================================================

export const ENGINE_CLASSES = [
  'deterministic',
  'statistical',
  'model_inference',
  'traditional_computation',
  'human_curated',
] as const;

export type EngineClass = (typeof ENGINE_CLASSES)[number];

/**
 * What the system may say about the standing of a method.
 *
 * `not_scientifically_established` is not a hedge, it is a required label. Rule 21 of the brief
 * forbids presenting a traditional or birth-based computation as proven fact, and the only way that
 * survives contact with a rendering layer is if the datum carrying the number also carries the
 * sentence that must be printed next to it.
 */
export const SCIENTIFIC_STATUSES = [
  'platform_record',
  'established_method',
  'exploratory',
  'not_scientifically_established',
] as const;

export type ScientificStatus = (typeof SCIENTIFIC_STATUSES)[number];

export interface EngineClassSpec {
  engineClass: EngineClass;
  label: string;
  /** The strongest scientific standing a result from this class of engine may claim. */
  maxScientificStatus: ScientificStatus;
  /** The strongest decision weight a result from this class may claim. */
  maxDecisionUse: DecisionUse;
  /** True when every result must be routed to a human before it may be shown as anything at all. */
  alwaysHumanReview: boolean;
  /**
   * True when the engine's output may never be shown to the person it is about, nor to a general HR
   * audience — see access.ts. Kept as data because a later patch will add engines and needs the rule
   * to travel with the class rather than living in a screen.
   */
  interpretationLayerOnly: boolean;
}

export const ENGINE_CLASS_SPECS: Readonly<Record<EngineClass, EngineClassSpec>> = Object.freeze({
  deterministic: {
    engineClass: 'deterministic', label: 'Deterministic calculation',
    maxScientificStatus: 'platform_record', maxDecisionUse: 'supporting_only',
    alwaysHumanReview: false, interpretationLayerOnly: false,
  },
  statistical: {
    engineClass: 'statistical', label: 'Statistical analysis',
    maxScientificStatus: 'established_method', maxDecisionUse: 'supporting_only',
    alwaysHumanReview: false, interpretationLayerOnly: false,
  },
  model_inference: {
    engineClass: 'model_inference', label: 'Model inference',
    maxScientificStatus: 'exploratory', maxDecisionUse: 'advisory_only',
    alwaysHumanReview: false, interpretationLayerOnly: false,
  },
  // RULE 20 AND RULE 21, EXPRESSED AS DATA RATHER THAN AS A COMMENT.
  //
  // A traditional or birth-based computation is a computation, and this system may hold one. What it
  // may NOT do is present the output as established, let it outweigh demonstrated work, show it to
  // the person it is about, or let it reach a decision unreviewed. All four of those are properties
  // of this row, and validateIntelligenceResult() refuses a result that contradicts any of them.
  traditional_computation: {
    engineClass: 'traditional_computation', label: 'Traditional computation',
    maxScientificStatus: 'not_scientifically_established', maxDecisionUse: 'advisory_only',
    alwaysHumanReview: true, interpretationLayerOnly: true,
  },
  human_curated: {
    engineClass: 'human_curated', label: 'Curated by a person',
    maxScientificStatus: 'platform_record', maxDecisionUse: 'supporting_only',
    alwaysHumanReview: false, interpretationLayerOnly: false,
  },
});

/** Identifies the exact code that produced a result. Reconstructable months later, or it is useless. */
export interface EngineVersion {
  engineId: string;
  engineClass: EngineClass;
  /** Semantic or build version of the engine. Free-form, but must be present and must change. */
  version: string;
  /** The run this result came out of. Every result cites exactly one. */
  computationId: ComputationId;
}

// =================================================================================================
// 8. EVIDENCE
// =================================================================================================

/**
 * HOW STRONG A PIECE OF EVIDENCE IS, AS A CLASS.
 *
 * Rule 22 of the brief: demonstrated job-related evidence must outweigh inferred or birth-based
 * insight. That is an ordering, so it is stored as one, and `strongestEvidenceClass()` plus the
 * confidence ceiling below are where the ordering does actual work instead of sitting in a document.
 *
 * The vocabulary deliberately ECHOES src/lib/evidence-graph.ts without duplicating it. That module
 * owns seven levels for a capability CLAIM; these six describe what an intelligence OUTPUT rests on,
 * and EVIDENCE_CLASS_FROM_GRAPH_LEVEL is the single point where the two meet.
 */
export const EVIDENCE_CLASSES = [
  'demonstrated',
  'observed',
  'attested',
  'stated',
  'inferred',
  'non_evidential',
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Higher is stronger. Used for ordering only; never shown as a score. */
export const EVIDENCE_CLASS_WEIGHT: Readonly<Record<EvidenceClass, number>> = Object.freeze({
  demonstrated: 5,
  observed: 4,
  attested: 3,
  stated: 2,
  inferred: 1,
  non_evidential: 0,
});

export const EVIDENCE_CLASS_LABELS: Readonly<Record<EvidenceClass, string>> = Object.freeze({
  demonstrated: 'Demonstrated work on record',
  observed: 'Observed and recorded at the time',
  attested: 'Attested by a named person',
  stated: 'Stated by the person themselves',
  inferred: 'Inferred by the system',
  non_evidential: 'Carries no evidential weight',
});

/**
 * The bridge to src/lib/evidence-graph.ts. ONE mapping, in ONE place, so that when either
 * vocabulary changes there is a single line to change instead of a second copy drifting for a year.
 */
export const EVIDENCE_CLASS_FROM_GRAPH_LEVEL: Readonly<Record<string, EvidenceClass>> = Object.freeze({
  claimed: 'stated',
  explicit: 'stated',
  inferred: 'inferred',
  demonstrated: 'demonstrated',
  professionally_demonstrated: 'demonstrated',
  production_demonstrated: 'demonstrated',
  externally_verified: 'demonstrated',
});

/**
 * WHERE A PIECE OF EVIDENCE CAME FROM.
 *
 * Rule 26: no hidden surveillance; only legitimately collected organisational records and authorised
 * integrations. There is no enum member for covert collection, and there is no free-text escape
 * hatch, so a covertly collected datum has no legal shape in which to enter this system.
 */
export const COLLECTION_BASES = [
  'organisational_record',
  'authorised_integration',
  'consented_disclosure',
  'voluntary_submission',
] as const;

export type CollectionBasis = (typeof COLLECTION_BASES)[number];

export const COLLECTION_BASIS_LABELS: Readonly<Record<CollectionBasis, string>> = Object.freeze({
  organisational_record: 'A record this organisation keeps in the ordinary course of work',
  authorised_integration: 'An integration the organisation authorised and documented',
  consented_disclosure: 'Disclosed by the person, for a stated purpose, with consent on record',
  voluntary_submission: 'Submitted by the person of their own accord',
});

/** The sources a piece of evidence may point at. Additive: a later patch may propose more. */
export const EVIDENCE_SOURCE_TYPES = [
  'application',
  'assessment',
  'interview',
  'task',
  'attendance',
  'performance_review',
  'peer_feedback',
  'training_record',
  'capability_evidence',
  'credential',
  'document_link',
  'system_computation',
  'integration_record',
] as const;

export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

/** A 0..1 magnitude with a band, so a screen never has to invent its own thresholds. */
export type Band = 'low' | 'moderate' | 'high';

export interface Graded {
  /** 0..1. */
  value: number;
  band: Band;
  /** Why it is graded this way, in one sentence. Required — an ungrounded grade is a guess. */
  basis: string;
}

export function bandOf(value: number): Band {
  if (value >= 0.7) return 'high';
  if (value >= 0.4) return 'moderate';
  return 'low';
}

/**
 * A pointer back to the row this evidence actually is. The chain has to end somewhere real, or the
 * whole apparatus is decoration.
 *
 * `documentUrl` is a LINK. This project never stores an uploaded document — the only stored upload
 * is a small profile photo — so an evidence item that is "a document" is a link to one.
 */
export interface RawReference {
  /** The module that owns the row. e.g. 'src/lib/interview-feedback.ts'. */
  ownerModule: string;
  /** The table the row lives in. */
  table: string;
  recordId: string;
  /** Page, section, question number, commit, certificate number — whatever narrows it further. */
  locator?: string | null;
  documentUrl?: string | null;
}

export interface Evidence {
  id: EvidenceId;
  sourceType: EvidenceSourceType;
  sourceId: string;
  /** When the evidenced thing HAPPENED, not when the row was written. ISO 8601. */
  timestamp: string;
  /** How much this bears on the dimension being assessed. */
  relevance: Graded;
  /** How much the source can be relied on. Separate from relevance, and often the opposite. */
  reliability: Graded;
  summary: string;
  rawReference: RawReference;

  // --- the honesty fields, without which the four above are unauditable -------------------------
  evidenceClass: EvidenceClass;
  layer: DataLayer;
  collectedUnder: CollectionBasis;
  organisationId: OrganisationId;
  /** Present when the evidence exists but could not be read. Never silently omitted. */
  unreadable?: string | null;
}

// =================================================================================================
// DIMENSIONS — WHAT A RESULT IS ABOUT
// =================================================================================================

/**
 * A dimension FAMILY groups results that a screen shows together and that share access rules.
 *
 * `temporal_pattern` is the neutral name for the traditional-computation family (rule 19: the older
 * word appears in no applicant-facing, employee-facing, HR-facing or public copy — and, in this
 * codebase, in no exported label at all; contracts.test.ts asserts it).
 */
export const DIMENSION_FAMILIES = [
  'capability',
  'contribution',
  'collaboration',
  'reliability',
  'growth',
  'risk',
  'wellbeing_aggregate',
  'temporal_pattern',
] as const;

export type DimensionFamily = (typeof DIMENSION_FAMILIES)[number];

export const DIMENSION_FAMILY_LABELS: Readonly<Record<DimensionFamily, string>> = Object.freeze({
  capability: 'Capability',
  contribution: 'Contribution',
  collaboration: 'Collaboration',
  reliability: 'Reliability',
  growth: 'Growth',
  risk: 'Attention areas',
  wellbeing_aggregate: 'Wellbeing (aggregate only)',
  temporal_pattern: 'Temporal profile',
});

export interface DimensionRef {
  family: DimensionFamily;
  /** Stable machine key, unique within the family. */
  key: string;
  /** What a screen prints. Must pass checkPublicCopy(). */
  label: string;
}

// =================================================================================================
// 7. THE STANDARD INTELLIGENCE OUTPUT
// =================================================================================================

export type ConfidenceBand = 'low' | 'moderate' | 'high';

export interface Confidence {
  band: ConfidenceBand;
  /** 0..1 where the engine can produce one. Optional: a band with no number beats a fabricated number. */
  value?: number | null;
  /** What the confidence rests on. Required. */
  basis: string;
}

/**
 * The value a result carries.
 *
 * A DISCRIMINATED UNION, and `not_computed` is a first-class member of it. The precedent is already
 * set in this codebase by /admin/tests/attempts printing EVIDENCE UNREADABLE rather than a score it
 * could not compute: an empty result rendered as a zero is a lie about a person, and the type system
 * is the cheapest place to make that lie unrepresentable.
 */
export type ScoreOrLevel =
  | { kind: 'numeric'; value: number; scaleMin: number; scaleMax: number; unit?: string | null }
  | { kind: 'level'; level: string; ladder: readonly string[] }
  | { kind: 'categorical'; category: string; options: readonly string[] }
  | { kind: 'not_computed'; reason: string };

export const RESULT_STATUSES = ['draft', 'active', 'superseded', 'withdrawn', 'unreadable'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const HUMAN_REVIEW_STATUSES = [
  'not_required', 'pending', 'in_review', 'accepted', 'rejected', 'overridden',
] as const;
export type HumanReviewStatus = (typeof HUMAN_REVIEW_STATUSES)[number];

/** How long a result may be shown before it must be recomputed or labelled stale. */
export interface ValidityWindow {
  /** ISO 8601. After this the result is stale and a screen must say so. */
  staleAt: string;
  /** Days after computedAt at which a recompute should be requested. */
  recomputeAfterDays: number;
}

/**
 * Where a result's weight came from, broken out per contributing source.
 *
 * This is what makes rule 23 — every signal identifies its evidence sources — checkable rather than
 * asserted. The weights are the engine's own and must sum to approximately 1; validation says so.
 */
export interface SourceContribution {
  sourceType: EvidenceSourceType;
  /** 0..1. Share of the result attributable to this source type. */
  weight: number;
  evidenceIds: readonly EvidenceId[];
  /** The strongest evidence class among those items. Drives the confidence ceiling. */
  strongestClass: EvidenceClass;
  note?: string | null;
}

/**
 * THE STANDARD INTELLIGENCE OUTPUT. Every engine in every later patch returns this shape.
 *
 * Rule 12 of the brief reads INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP,
 * and each arrow has a home here: `sourceBreakdown` and the computation row for inputs,
 * `modelOrEngineVersion` for processing, `scoreOrLevel` and `summary` for the output, `evidence` for
 * evidence, `confidence` for confidence, `computedAt` for the timestamp.
 */
export interface IntelligenceResult {
  id: ResultId;
  subject: SubjectRef;
  dimension: DimensionRef;
  scoreOrLevel: ScoreOrLevel;
  confidence: Confidence;
  status: ResultStatus;
  /** One or two sentences a human can read. Must pass checkPublicCopy(). */
  summary: string;
  evidence: readonly Evidence[];
  sourceBreakdown: readonly SourceContribution[];
  computedAt: string;
  validFor: ValidityWindow;
  modelOrEngineVersion: EngineVersion;
  humanReviewStatus: HumanReviewStatus;

  // --- what the brief's field list implies but does not name ------------------------------------
  /** Always an engine-writable layer. See ENGINE_WRITABLE_LAYERS. */
  layer: DataLayer;
  decisionUse: DecisionUse;
  scientificStatus: ScientificStatus;
  organisationId: OrganisationId;
  profileId?: ProfileId | null;
  /** The result this one replaces. Results are superseded, never edited in place. */
  supersedes?: ResultId | null;
  /** Present when the engine could not produce a value. Pairs with scoreOrLevel.kind = not_computed. */
  unreadable?: string | null;
}

// =================================================================================================
// 9. SIGNALS
// =================================================================================================

export const SIGNAL_CATEGORIES = [
  'capability_gap',
  'workload',
  'engagement',
  'reliability',
  'growth_opportunity',
  'recognition',
  'process_exception',
  'data_quality',
] as const;

export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

export const SIGNAL_SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export const SIGNAL_STATUSES = [
  'open', 'acknowledged', 'in_progress', 'resolved', 'dismissed', 'expired',
] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/**
 * A recommended action.
 *
 * `consequential: false` on every one of these is not an oversight. A recommended action is a
 * SENTENCE ADDRESSED TO A PERSON; it has no executor, no handler and no id that anything can act on
 * automatically. If a later patch wants a one-click action, that click is a human decision and
 * belongs in the decision record, not here.
 */
export interface RecommendedAction {
  key: string;
  /** Imperative sentence for the human who reads it. Must pass checkPublicCopy(). */
  label: string;
  /** Who the action is addressed to. */
  addressedTo: 'subject' | 'reporting_manager' | 'department_head' | 'hr_operations' | 'hr_leadership';
}

export interface Signal {
  id: SignalId;
  /** The person the signal is about. SubjectRef rather than a bare employee id: applicants get signals too. */
  subject: SubjectRef;
  category: SignalCategory;
  severity: SignalSeverity;
  title: string;
  /** Why the system raised it, in words the subject could read without harm. */
  explanation: string;
  evidenceIds: readonly EvidenceId[];
  sourceTypes: readonly EvidenceSourceType[];
  confidence: Confidence;
  generatedAt: string;
  /** A signal that never expires becomes a permanent mark. Required, not optional. */
  expiresAt: string;
  status: SignalStatus;
  recommendedActions: readonly RecommendedAction[];
  humanReviewRequired: boolean;

  // --- the honesty fields -----------------------------------------------------------------------
  layer: DataLayer;
  decisionUse: DecisionUse;
  organisationId: OrganisationId;
  /** The computation that produced it, where one did. Absent for a signal raised by a human. */
  computationId?: ComputationId | null;
}

// =================================================================================================
// HUMAN DECISIONS — THE ONLY CONSEQUENTIAL LAYER
// =================================================================================================

export const DECISION_KINDS = [
  'hiring', 'rejection', 'promotion', 'termination', 'disciplinary',
  'role_change', 'compensation_change', 'development_plan', 'no_action',
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * The decisions rule 14 names explicitly. A HORIZON engine may never produce one of these; only a
 * HumanDecision record may carry one, and a HumanDecision requires a named human.
 */
export const HIGH_IMPACT_DECISIONS: readonly DecisionKind[] = [
  'hiring', 'rejection', 'promotion', 'termination', 'disciplinary',
];

export interface HumanDecision {
  id: string;
  subject: SubjectRef;
  kind: DecisionKind;
  /** The named human. Not a role, not a queue, not "the system". */
  decidedBy: ActorRef;
  decidedAt: string;
  /** Written reason. Required, and a length floor is enforced — "approved" is not a reason. */
  reason: string;
  /** Results and signals the decider says they considered. May be empty; may not be fabricated. */
  consideredResultIds: readonly ResultId[];
  consideredSignalIds: readonly SignalId[];
  /** True when the decider went against a recommendation. Recorded because disagreement is signal. */
  contraryToRecommendation: boolean;
  layer: 'human_decision';
  organisationId: OrganisationId;
}

export const MIN_DECISION_REASON_CHARS = 12;

// =================================================================================================
// 24 & 25. FEEDBACK AGGREGATION — DISAGREEMENT IS DATA, NOT NOISE
// =================================================================================================

/**
 * ONE CONTRIBUTION TO AN AGGREGATE. HORIZON stores this ledger row; it does NOT store the feedback
 * body, which stays in the module that collected it under that module's access rules.
 *
 * `relationship` and `sourceWeight` are what make rule 24 real: a manager's rating and a peer's
 * rating are not the same evidence, and one person's view never becomes organisational truth simply
 * by being the only one recorded.
 */
export interface FeedbackContribution {
  feedbackId: FeedbackId;
  /** The module that owns the feedback body, so an auditor can find it. */
  ownerModule: string;
  subject: SubjectRef;
  dimension: DimensionRef;
  /** The named human who gave it. Anonymity is a RENDERING decision, never a storage one. */
  contributor: ActorRef;
  relationship: 'self' | 'reporting_manager' | 'peer' | 'report' | 'reviewer' | 'external';
  /** Normalised 0..1 so contributions on different scales can be compared at all. */
  normalisedValue: number;
  /** The raw value as the contributor gave it, and the scale it was on. Never discarded. */
  rawValue: string;
  rawScale: string;
  submittedAt: string;
  layer: 'human_feedback';
  organisationId: OrganisationId;
}

/**
 * The SHAPE of an aggregate. HORIZON defines it; it does not compute it — that is the feedback
 * patch's work, and building it here would be building somebody else's module.
 */
export interface FeedbackAggregate {
  subject: SubjectRef;
  dimension: DimensionRef;
  contributionCount: number;
  /** Suppressed below MIN_CONTRIBUTORS_FOR_AGGREGATE — see the constant for why. */
  central: number | null;
  spread: number | null;
  /** Contributions that sit far from the rest. Surfaced, never deleted. */
  outlierFeedbackIds: readonly FeedbackId[];
  /** True when contributors materially disagree. A disagreed aggregate must not be shown as consensus. */
  disagreement: boolean;
  /** Counts per relationship, so a reader can see whose view the number is made of. */
  byRelationship: Readonly<Record<string, number>>;
  /** Anything the aggregator noticed that a reader must know. Bias checks land here. */
  caveats: readonly string[];
  computedAt: string;
  layer: 'computed';
}

/**
 * Below this many contributors an aggregate is not shown.
 *
 * The same reasoning as MIN_GROUP in src/lib/wellness.ts: a mean over two people is a way of naming
 * both of them. The value matches the wellness module's floor so the two surfaces cannot disagree
 * about what "too small to show" means.
 */
export const MIN_CONTRIBUTORS_FOR_AGGREGATE = 5;

export interface FeedbackAggregator {
  aggregate(
    contributions: readonly FeedbackContribution[],
  ): FeedbackAggregate | null;
}

// =================================================================================================
// LANGUAGE POLICY (RULE 19), AS SOMETHING A TEST CAN FAIL ON
// =================================================================================================

/**
 * Terms that must not appear in any copy HORIZON shows to an applicant, an employee, an ordinary HR
 * user, or the public — nor, in this codebase, in any exported label at all.
 *
 * The list is short and deliberately literal. It is not a content filter and does not try to be one;
 * it catches the specific vocabulary the brief names, in the specific place a rule like this is
 * always broken, which is a label somebody added in a hurry two patches later.
 */
export const FORBIDDEN_UI_TERMS: readonly string[] = [
  'astrology', 'astrological', 'astrologer', 'horoscope', 'zodiac', 'natal chart', 'birth chart',
];

export interface CopyCheck {
  ok: boolean;
  /** The matched terms, lowercased. Empty when ok. */
  found: string[];
}

/** Pure. Case-insensitive substring match, which is the right strictness for a seven-word list. */
export function checkPublicCopy(text: string): CopyCheck {
  const hay = String(text || '').toLowerCase();
  const found = FORBIDDEN_UI_TERMS.filter((t) => hay.includes(t));
  return { ok: found.length === 0, found };
}

// =================================================================================================
// VALIDATION — THE RULES ABOVE, ENFORCED
// =================================================================================================

export interface ValidationResult {
  ok: boolean;
  /** Every problem found, not just the first. A caller fixing one at a time is a caller giving up. */
  errors: string[];
}

function fail(errors: string[]): ValidationResult { return { ok: errors.length === 0, errors }; }

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(v: unknown): boolean {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function checkGraded(g: unknown, field: string, errors: string[]): void {
  const x = g as Partial<Graded> | undefined;
  if (!x || typeof x !== 'object') { errors.push(field + ' is required'); return; }
  if (typeof x.value !== 'number' || !(x.value >= 0 && x.value <= 1)) {
    errors.push(field + '.value must be a number between 0 and 1');
  }
  if (x.band !== 'low' && x.band !== 'moderate' && x.band !== 'high') {
    errors.push(field + '.band must be low, moderate or high');
  }
  if (typeof x.value === 'number' && x.band && bandOf(x.value) !== x.band) {
    errors.push(field + '.band does not match ' + field + '.value');
  }
  if (typeof x.basis !== 'string' || !x.basis.trim()) {
    errors.push(field + '.basis is required — an ungraded grade is a guess');
  }
}

export function validateEvidence(e: Evidence): ValidationResult {
  const errors: string[] = [];
  if (!e || typeof e !== 'object') return fail(['evidence is not an object']);
  if (!e.id) errors.push('evidence.id is required');
  if (!(EVIDENCE_SOURCE_TYPES as readonly string[]).includes(e.sourceType)) {
    errors.push('evidence.sourceType is not a known source type');
  }
  if (typeof e.sourceId !== 'string' || !e.sourceId.trim()) errors.push('evidence.sourceId is required');
  if (!isIsoTimestamp(e.timestamp)) errors.push('evidence.timestamp must be an ISO 8601 timestamp');
  checkGraded(e.relevance, 'evidence.relevance', errors);
  checkGraded(e.reliability, 'evidence.reliability', errors);
  if (typeof e.summary !== 'string' || !e.summary.trim()) errors.push('evidence.summary is required');
  if (!(EVIDENCE_CLASSES as readonly string[]).includes(e.evidenceClass)) {
    errors.push('evidence.evidenceClass is not a known class');
  }
  if (!isDataLayer(e.layer)) errors.push('evidence.layer is not a known layer');
  // RULE 26. There is no enum member for covert collection, so this check is the whole guarantee.
  if (!(COLLECTION_BASES as readonly string[]).includes(e.collectedUnder)) {
    errors.push('evidence.collectedUnder must name a lawful collection basis');
  }
  if (!e.organisationId) errors.push('evidence.organisationId is required');

  const ref = e.rawReference;
  if (!ref || typeof ref !== 'object') {
    errors.push('evidence.rawReference is required — a chain that ends nowhere is decoration');
  } else {
    if (!ref.ownerModule) errors.push('evidence.rawReference.ownerModule is required');
    if (!ref.table) errors.push('evidence.rawReference.table is required');
    if (!ref.recordId) errors.push('evidence.rawReference.recordId is required');
  }
  const copy = checkPublicCopy(e.summary || '');
  if (!copy.ok) errors.push('evidence.summary uses forbidden terminology: ' + copy.found.join(', '));
  return fail(errors);
}

/** The strongest class present. `non_evidential` when there is nothing at all. */
export function strongestEvidenceClass(
  breakdown: readonly SourceContribution[],
): EvidenceClass {
  let best: EvidenceClass = 'non_evidential';
  for (const c of breakdown) {
    if (EVIDENCE_CLASS_WEIGHT[c.strongestClass] > EVIDENCE_CLASS_WEIGHT[best]) best = c.strongestClass;
  }
  return best;
}

/**
 * THE CONFIDENCE CEILING. Rule 22 made arithmetic.
 *
 * A result whose strongest evidence is inferred may not announce itself as high confidence, and a
 * result resting on nothing evidential may not exceed low. Without this, "demonstrated evidence
 * outweighs inference" is a sentence in a document that no code has ever read.
 */
export function maxConfidenceFor(strongest: EvidenceClass): ConfidenceBand {
  if (strongest === 'non_evidential') return 'low';
  if (strongest === 'inferred') return 'moderate';
  return 'high';
}

const BAND_RANK: Record<ConfidenceBand, number> = { low: 0, moderate: 1, high: 2 };

export function validateIntelligenceResult(r: IntelligenceResult): ValidationResult {
  const errors: string[] = [];
  if (!r || typeof r !== 'object') return fail(['result is not an object']);
  if (!r.id) errors.push('result.id is required');
  if (!r.subject) errors.push('result.subject is required');
  if (!r.dimension || !(DIMENSION_FAMILIES as readonly string[]).includes(r.dimension.family)) {
    errors.push('result.dimension.family is not a known family');
  }
  if (!r.scoreOrLevel || typeof r.scoreOrLevel !== 'object') errors.push('result.scoreOrLevel is required');
  if (!(RESULT_STATUSES as readonly string[]).includes(r.status)) errors.push('result.status is not known');
  if (!(HUMAN_REVIEW_STATUSES as readonly string[]).includes(r.humanReviewStatus)) {
    errors.push('result.humanReviewStatus is not known');
  }
  if (typeof r.summary !== 'string' || !r.summary.trim()) errors.push('result.summary is required');
  if (!isIsoTimestamp(r.computedAt)) errors.push('result.computedAt must be an ISO 8601 timestamp');
  if (!r.validFor || !isIsoTimestamp(r.validFor.staleAt)) {
    errors.push('result.validFor.staleAt must be an ISO 8601 timestamp — a result with no shelf life becomes a permanent label');
  }
  if (!r.organisationId) errors.push('result.organisationId is required');

  const ev = r.modelOrEngineVersion;
  if (!ev || typeof ev !== 'object') {
    errors.push('result.modelOrEngineVersion is required');
    return fail(errors);
  }
  if (!ev.engineId) errors.push('modelOrEngineVersion.engineId is required');
  if (!ev.version) errors.push('modelOrEngineVersion.version is required');
  if (!ev.computationId) {
    errors.push('modelOrEngineVersion.computationId is required — without the run, the result is unreconstructable');
  }
  if (!(ENGINE_CLASSES as readonly string[]).includes(ev.engineClass)) {
    errors.push('modelOrEngineVersion.engineClass is not a known class');
    return fail(errors);
  }
  const spec = ENGINE_CLASS_SPECS[ev.engineClass];

  // RULE 14 / LAYER RULE 2. An engine writes interpretations, not decisions.
  if (!isDataLayer(r.layer)) {
    errors.push('result.layer is not a known layer');
  } else if (!ENGINE_WRITABLE_LAYERS.includes(r.layer)) {
    errors.push(
      'result.layer ' + r.layer + ' is not writable by an engine; an engine may write only '
      + ENGINE_WRITABLE_LAYERS.join(', '),
    );
  }
  if (DATA_LAYER_SPECS[r.layer as DataLayer]?.consequential) {
    errors.push('an IntelligenceResult may never sit in a consequential layer');
  }
  if (r.decisionUse === 'may_decide') {
    errors.push('an IntelligenceResult may never claim may_decide — rule 14');
  }
  if (r.decisionUse === 'supporting_only' && spec.maxDecisionUse === 'advisory_only') {
    errors.push(
      'engineClass ' + ev.engineClass + ' output is advisory_only and may not claim supporting_only',
    );
  }

  // RULE 21. A method that is not established may not say it is.
  if (!(SCIENTIFIC_STATUSES as readonly string[]).includes(r.scientificStatus)) {
    errors.push('result.scientificStatus is not known');
  } else if (spec.maxScientificStatus === 'not_scientifically_established'
    && r.scientificStatus !== 'not_scientifically_established') {
    errors.push(
      'engineClass ' + ev.engineClass + ' must report scientificStatus '
      + 'not_scientifically_established; it may not be presented as established',
    );
  }

  // RULE 15. Some classes are never shown without a human first.
  if (spec.alwaysHumanReview && (r.humanReviewStatus === 'not_required')) {
    errors.push('engineClass ' + ev.engineClass + ' output always requires human review');
  }

  // RULE 23. Every result names its sources.
  if (!Array.isArray(r.sourceBreakdown)) {
    errors.push('result.sourceBreakdown is required');
  } else if (r.scoreOrLevel?.kind !== 'not_computed') {
    if (r.sourceBreakdown.length === 0) {
      errors.push('a computed result must name at least one source in sourceBreakdown');
    } else {
      const sum = r.sourceBreakdown.reduce((a, c) => a + (Number(c.weight) || 0), 0);
      if (Math.abs(sum - 1) > 0.01) {
        errors.push('sourceBreakdown weights must sum to 1 (got ' + sum.toFixed(3) + ')');
      }
      for (const c of r.sourceBreakdown) {
        if (!(EVIDENCE_CLASSES as readonly string[]).includes(c.strongestClass)) {
          errors.push('sourceBreakdown.strongestClass is not a known evidence class');
        }
      }
    }
  }

  // RULE 22. Demonstrated outweighs inferred, enforced as a confidence ceiling.
  const band = r.confidence?.band;
  if (band !== 'low' && band !== 'moderate' && band !== 'high') {
    errors.push('result.confidence.band must be low, moderate or high');
  } else if (Array.isArray(r.sourceBreakdown) && r.sourceBreakdown.length > 0) {
    const ceiling = maxConfidenceFor(strongestEvidenceClass(r.sourceBreakdown));
    if (BAND_RANK[band] > BAND_RANK[ceiling]) {
      errors.push(
        'confidence ' + band + ' exceeds the ' + ceiling + ' ceiling for evidence of class '
        + strongestEvidenceClass(r.sourceBreakdown),
      );
    }
  }
  if (typeof r.confidence?.basis !== 'string' || !r.confidence.basis.trim()) {
    errors.push('result.confidence.basis is required');
  }

  // A NOT-COMPUTED RESULT MUST SAY WHY. This is the /admin/tests/attempts precedent: unreadable
  // rendered as unreadable, never as a zero.
  if (r.scoreOrLevel?.kind === 'not_computed') {
    if (!r.scoreOrLevel.reason?.trim()) errors.push('a not_computed result must carry a reason');
  }
  if (r.status === 'unreadable' && !r.unreadable?.trim()) {
    errors.push('an unreadable result must carry the reason it could not be read');
  }

  const copy = checkPublicCopy((r.summary || '') + ' ' + (r.dimension?.label || ''));
  if (!copy.ok) errors.push('result copy uses forbidden terminology: ' + copy.found.join(', '));

  return fail(errors);
}

export function validateSignal(s: Signal): ValidationResult {
  const errors: string[] = [];
  if (!s || typeof s !== 'object') return fail(['signal is not an object']);
  if (!s.id) errors.push('signal.id is required');
  if (!s.subject) errors.push('signal.subject is required');
  if (!(SIGNAL_CATEGORIES as readonly string[]).includes(s.category)) errors.push('signal.category is not known');
  if (!(SIGNAL_SEVERITIES as readonly string[]).includes(s.severity)) errors.push('signal.severity is not known');
  if (!(SIGNAL_STATUSES as readonly string[]).includes(s.status)) errors.push('signal.status is not known');
  if (typeof s.title !== 'string' || !s.title.trim()) errors.push('signal.title is required');
  if (typeof s.explanation !== 'string' || !s.explanation.trim()) {
    errors.push('signal.explanation is required — an unexplained signal is an accusation');
  }
  if (!isIsoTimestamp(s.generatedAt)) errors.push('signal.generatedAt must be an ISO 8601 timestamp');
  // A SIGNAL THAT NEVER EXPIRES IS A PERMANENT MARK ON A PERSON. Required, and required to be later
  // than generation, because an already-expired signal is a way of raising one that nobody reviews.
  if (!isIsoTimestamp(s.expiresAt)) {
    errors.push('signal.expiresAt must be an ISO 8601 timestamp — a signal that never expires becomes a permanent mark');
  } else if (isIsoTimestamp(s.generatedAt) && Date.parse(s.expiresAt) <= Date.parse(s.generatedAt)) {
    errors.push('signal.expiresAt must be after signal.generatedAt');
  }
  if (!s.organisationId) errors.push('signal.organisationId is required');

  // RULE 23. Every signal identifies its evidence sources.
  if (!Array.isArray(s.evidenceIds) || s.evidenceIds.length === 0) {
    errors.push('signal.evidenceIds must name at least one piece of evidence');
  }
  if (!Array.isArray(s.sourceTypes) || s.sourceTypes.length === 0) {
    errors.push('signal.sourceTypes must name at least one source type');
  } else {
    for (const t of s.sourceTypes) {
      if (!(EVIDENCE_SOURCE_TYPES as readonly string[]).includes(t)) {
        errors.push('signal.sourceTypes contains an unknown source type: ' + String(t));
      }
    }
  }

  if (!isDataLayer(s.layer)) {
    errors.push('signal.layer is not a known layer');
  } else if (s.layer !== 'ai_interpretation' && s.layer !== 'recommendation' && s.layer !== 'computed') {
    errors.push('a signal sits in computed, ai_interpretation or recommendation — never elsewhere');
  }
  if (s.decisionUse === 'may_decide') errors.push('a signal may never claim may_decide — rule 14');

  // RULE 15. High severity means a human looks at it. Not optional, not configurable.
  if (s.severity === 'high' && !s.humanReviewRequired) {
    errors.push('a high-severity signal must set humanReviewRequired');
  }

  for (const a of s.recommendedActions || []) {
    const c = checkPublicCopy(a?.label || '');
    if (!c.ok) errors.push('recommendedAction label uses forbidden terminology: ' + c.found.join(', '));
  }
  const copy = checkPublicCopy((s.title || '') + ' ' + (s.explanation || ''));
  if (!copy.ok) errors.push('signal copy uses forbidden terminology: ' + copy.found.join(', '));

  return fail(errors);
}

export function validateHumanDecision(d: HumanDecision): ValidationResult {
  const errors: string[] = [];
  if (!d || typeof d !== 'object') return fail(['decision is not an object']);
  if (!(DECISION_KINDS as readonly string[]).includes(d.kind)) errors.push('decision.kind is not known');
  if (!d.decidedBy || (d.decidedBy.kind !== 'user' && d.decidedBy.kind !== 'employee')) {
    errors.push('decision.decidedBy must be a named human — rule 14 leaves no other option');
  }
  if (!d.decidedBy?.id) errors.push('decision.decidedBy.id is required');
  if (!isIsoTimestamp(d.decidedAt)) errors.push('decision.decidedAt must be an ISO 8601 timestamp');
  if (typeof d.reason !== 'string' || d.reason.trim().length < MIN_DECISION_REASON_CHARS) {
    errors.push('decision.reason must be at least ' + MIN_DECISION_REASON_CHARS + ' characters');
  }
  if (d.layer !== 'human_decision') errors.push('decision.layer must be human_decision');
  if (!d.organisationId) errors.push('decision.organisationId is required');
  return fail(errors);
}

// =================================================================================================
// CONSTRUCTORS — FROZEN, SO A LAYER CANNOT BE REWRITTEN AFTER THE FACT
// =================================================================================================

/**
 * Freeze an object and its arrays one level down.
 *
 * The point is layer rule 1: no promotion. `result.layer = 'raw'` must not succeed, and in sloppy
 * mode a plain assignment to a non-frozen object succeeds silently. This is the same defence
 * src/lib/provenance.ts uses, for the same reason.
 */
export function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const v of value) freezeDeep(v);
    return Object.freeze(value) as T;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      freezeDeep((value as Record<string, unknown>)[k]);
    }
    return Object.freeze(value) as T;
  }
  return value;
}

export type Built<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function buildEvidence(e: Evidence): Built<Evidence> {
  const v = validateEvidence(e);
  return v.ok ? { ok: true, value: freezeDeep({ ...e }) } : { ok: false, errors: v.errors };
}

export function buildIntelligenceResult(r: IntelligenceResult): Built<IntelligenceResult> {
  const v = validateIntelligenceResult(r);
  return v.ok ? { ok: true, value: freezeDeep({ ...r }) } : { ok: false, errors: v.errors };
}

export function buildSignal(s: Signal): Built<Signal> {
  const v = validateSignal(s);
  return v.ok ? { ok: true, value: freezeDeep({ ...s }) } : { ok: false, errors: v.errors };
}

// NOT RE-EXPORTED FROM HERE, deliberately. Re-exporting the identifier types would make
// `export * from './ids'` and `export * from './types'` in index.ts both claim the same names, which
// TypeScript reports as a duplicate export and which would otherwise be resolved by whichever star
// export happened to come second. One barrel, one source per name: identifiers come from ./ids.
