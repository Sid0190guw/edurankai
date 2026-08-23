// src/lib/horizon/feedback/types.ts — PATCH 05's OWNED CONTRACT. Extend additively; never re-shape.
//
// =================================================================================================
// WHAT THIS PATCH IS AND WHERE ITS EDGES ARE
// =================================================================================================
//
// PATCH 05 collects STRUCTURED feedback about an employee from five kinds of source, and turns a
// pile of those items into an aggregate that says what it is made of. It owns:
//
//   the structured columns on hr_feedback   (added, never re-shaped — see schema.ts)
//   hr_feedback_dimensions                  (new: one rating per dimension per item)
//   hr_feedback_examples                    (new: the cited incidents behind a rating)
//
// IT DOES NOT OWN, AND MUST NOT REDEFINE:
//   hr_feedback itself          — src/lib/performance-schema.ts declares it. Everything this patch
//                                 adds is a nullable or defaulted column, so every existing row and
//                                 every existing reader (performance.ts giveFeedback / feedbackFor /
//                                 feedbackIGave) keeps working with no change at all.
//   who reports to whom         — src/lib/org-graph.ts. Relationships are resolved per ROW, live.
//   who may open a console      — src/lib/auth/permissions.ts. Capabilities are per USER.
//   appraisal cycles, goals     — src/lib/performance.ts.
//
// =================================================================================================
// THE FIVE THINGS THIS MODULE KEEPS APART, ALWAYS
// =================================================================================================
//
//   a) RAW SOURCE DATA      what a named person wrote on a named date about a named period.
//   b) DERIVED DATA         the weighted aggregate. Computed, never stored as if it were observed.
//   c) INTERPRETATION       the flags — outlier, disagreement, repeated-unsupported, author
//                           tendency. Advisory readings OF the derived data, labelled as such.
//   d) HUMAN FEEDBACK       the written evidence and examples inside (a).
//   e) HUMAN DECISION       NOT IN THIS MODULE. Nothing here decides anything. There is no write
//                           path from an aggregate to an employment outcome, and there must not be.
//
// A number produced here is an INPUT to a conversation. It is never an outcome. No function in this
// patch promotes, rejects, terminates, disciplines or ranks anybody, and none may be added.

/**
 * WHO IS SPEAKING. Five kinds, and the kind is what the weighting reasons about — not the person's
 * seniority, and not their job title.
 *
 * The value is CLAIMED by the form and then CHECKED against the Organization Graph at capture time
 * (capture.ts resolveSourceType). A claim the graph does not support is still recorded, and is
 * recorded as unverified: refusing it would lose real observation from somebody whose edge nobody
 * has entered yet, and silently accepting it would let anybody call themselves a reporting manager.
 */
export const FEEDBACK_SOURCE_TYPES = [
  'reporting_manager',
  'team_lead',
  'hr',
  'peer',
  'self',
] as const;
export type FeedbackSourceType = (typeof FEEDBACK_SOURCE_TYPES)[number];

export const FEEDBACK_SOURCE_LABELS: Record<FeedbackSourceType, string> = {
  reporting_manager: 'Reporting manager',
  team_lead: 'Team lead',
  hr: 'People desk',
  peer: 'Colleague',
  self: 'Self-reflection',
};

/**
 * WHY EACH SOURCE CARRIES THE WEIGHT IT DOES. Printed on the screen beside the number, because a
 * weight nobody can see the reason for is indistinguishable from a thumb on the scale.
 *
 * Every one of these reasons is about OBSERVATIONAL PROXIMITY TO THE WORK. None is about rank. A
 * team lead is not senior to a reporting manager here; they are closer to the day, so on day-to-day
 * dimensions they see more.
 */
export const FEEDBACK_SOURCE_WEIGHT_REASONS: Record<FeedbackSourceType, string> = {
  reporting_manager:
    'Sees the whole of the work over a long period and is accountable for it, so has the widest view '
    + 'and the strongest reason to have looked.',
  team_lead:
    'Closest to the day-to-day work. Often sees execution a reporting manager only hears about.',
  hr:
    'Observes process, conduct and how somebody handles the organisation, and rarely observes the '
    + 'work itself, so it counts for less than the people who watched the work happen.',
  peer:
    'Direct collaboration, one angle each. Weighted a little below the line because a single '
    + 'colleague sees a slice; several colleagues together see a great deal.',
  self:
    'Not counted in the aggregate at all. It is reported beside it, so the difference between how '
    + 'somebody sees their own work and how others see it stays visible instead of being averaged away.',
};

/**
 * THE TWELVE DIMENSIONS from the brief.
 *
 * `conditional` marks a dimension only asked for when the context makes it meaningful. Pressure and
 * workload behaviour is the one: asking every colleague to rate how somebody copes under pressure,
 * in a quarter with no pressure in it, manufactures a number out of nothing.
 */
export const FEEDBACK_DIMENSIONS = [
  'work_quality',
  'reliability',
  'ownership',
  'initiative',
  'communication',
  'teamwork',
  'leadership',
  'problem_solving',
  'discipline',
  'adaptability',
  'learning',
  'pressure_behaviour',
] as const;
export type FeedbackDimension = (typeof FEEDBACK_DIMENSIONS)[number];

export function isFeedbackDimension(v: unknown): v is FeedbackDimension {
  return typeof v === 'string' && (FEEDBACK_DIMENSIONS as readonly string[]).indexOf(v) >= 0;
}

export function isFeedbackSourceType(v: unknown): v is FeedbackSourceType {
  return typeof v === 'string' && (FEEDBACK_SOURCE_TYPES as readonly string[]).indexOf(v) >= 0;
}

export interface DimensionMeta {
  key: FeedbackDimension;
  label: string;
  /** What the rater is being asked. Written as an observation, never as a personality judgement. */
  prompt: string;
  /** Only offered when the context calls for it. See PRESSURE_RELEVANT_CONTEXTS. */
  conditional: boolean;
}

export const FEEDBACK_DIMENSION_META: Record<FeedbackDimension, DimensionMeta> = {
  work_quality: {
    key: 'work_quality',
    label: 'Work quality',
    prompt: 'The standard of what they actually produced, judged against what the work needed.',
    conditional: false,
  },
  reliability: {
    key: 'reliability',
    label: 'Reliability',
    prompt: 'Whether what they said they would do arrived, in the shape and by the time they said.',
    conditional: false,
  },
  ownership: {
    key: 'ownership',
    label: 'Ownership',
    prompt: 'Whether they carried a problem to the end rather than handing it on at the hard part.',
    conditional: false,
  },
  initiative: {
    key: 'initiative',
    label: 'Initiative',
    prompt: 'Work they started because it needed doing, without being asked.',
    conditional: false,
  },
  communication: {
    key: 'communication',
    label: 'Communication',
    prompt: 'Whether the people who needed to know knew, in time, and understood it.',
    conditional: false,
  },
  teamwork: {
    key: 'teamwork',
    label: 'Teamwork',
    prompt: 'What working alongside them did to the rest of the work around them.',
    conditional: false,
  },
  leadership: {
    key: 'leadership',
    label: 'Leadership',
    prompt: 'Where they took responsibility for other people or for direction. Not a job title: '
      + 'somebody with nobody reporting to them can score highly here.',
    conditional: false,
  },
  problem_solving: {
    key: 'problem_solving',
    label: 'Problem solving',
    prompt: 'How they got from a problem nobody had solved to something that worked.',
    conditional: false,
  },
  discipline: {
    key: 'discipline',
    label: 'Discipline',
    prompt: 'Consistency in following the agreed way of working: process, records, commitments.',
    conditional: false,
  },
  adaptability: {
    key: 'adaptability',
    label: 'Adaptability',
    prompt: 'What happened when the plan changed underneath them.',
    conditional: false,
  },
  learning: {
    key: 'learning',
    label: 'Learning',
    prompt: 'Evidence they can do something now they could not do at the start of the period.',
    conditional: false,
  },
  pressure_behaviour: {
    key: 'pressure_behaviour',
    label: 'Under pressure and workload',
    prompt: 'How they and the work around them held up when the load was heavy. Only rate this if '
      + 'the period actually contained that; a guess here is worse than a blank.',
    conditional: true,
  },
};

/**
 * THE CIRCUMSTANCE the feedback is about. Recorded because "3 out of 5 on communication" means
 * something different after a two-week incident than across an ordinary quarter, and an aggregate
 * that cannot say which it was cannot be argued with.
 */
export const FEEDBACK_CONTEXTS = [
  'day_to_day',
  'project_delivery',
  'incident_response',
  'client_engagement',
  'cross_team_collaboration',
  'onboarding_period',
  'cycle_review',
  'high_pressure_period',
] as const;
export type FeedbackContext = (typeof FEEDBACK_CONTEXTS)[number];

export const FEEDBACK_CONTEXT_LABELS: Record<FeedbackContext, string> = {
  day_to_day: 'Ordinary day-to-day work',
  project_delivery: 'A specific project or delivery',
  incident_response: 'An incident or escalation',
  client_engagement: 'Work with a client or partner',
  cross_team_collaboration: 'Working across teams',
  onboarding_period: 'Their first months',
  cycle_review: 'An appraisal cycle',
  high_pressure_period: 'A period of unusual load or pressure',
};

/** Contexts in which asking about pressure and workload behaviour is honest rather than invented. */
export const PRESSURE_RELEVANT_CONTEXTS: readonly FeedbackContext[] = [
  'incident_response',
  'high_pressure_period',
  'project_delivery',
  'cycle_review',
];

/**
 * WHO MAY READ THE ITEM, decided by the person writing it and never widened afterwards.
 *
 *   standard    the subject, whoever the Organization Graph says answers for their work, and the
 *               people desk. The ordinary case.
 *   hr_channel  the subject and the people desk ONLY. The reporting line does not see it. This is
 *               what a person needs when the feedback is about how the line itself behaves; without
 *               it, "tell us honestly" is a request to hand a complaint to its subject.
 *
 * THERE IS NO LEVEL THAT HIDES AN ITEM FROM THE PERSON IT IS ABOUT. Feedback nobody may ever show
 * somebody is not feedback, it is a file kept on them, and this product does not build that. There
 * is also no anonymous level: the author is recorded and shown, which is the rule the existing
 * feedback module already states and this patch does not get to reverse.
 */
export const FEEDBACK_CONFIDENTIALITY = ['standard', 'hr_channel'] as const;
export type FeedbackConfidentiality = (typeof FEEDBACK_CONFIDENTIALITY)[number];

export const FEEDBACK_CONFIDENTIALITY_LABELS: Record<FeedbackConfidentiality, string> = {
  standard: 'Their reporting line and the people desk can read this',
  hr_channel: 'Only they and the people desk can read this, not their reporting line',
};

/**
 * HOW WELL THE ITEM IS EVIDENCED. Computed at capture from what was written, stored on the row, and
 * never recomputed on read — a weight that changes because somebody edited a heuristic is a weight
 * nobody can reconcile with the number they saw last week.
 *
 *   specific  names what happened: a cited example, or written evidence with concrete detail.
 *   general   a real sentence, but nothing anybody could check.
 *   none      a rating with no supporting words at all.
 */
export const EVIDENCE_QUALITIES = ['specific', 'general', 'none'] as const;
export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

export const EVIDENCE_QUALITY_LABELS: Record<EvidenceQuality, string> = {
  specific: 'Names something that happened',
  general: 'Written, but nothing checkable',
  none: 'A rating with nothing written behind it',
};

/**
 * THE LIFE OF AN ITEM. Nothing is ever deleted: `withdrawn` hides it from the aggregate and keeps it
 * on the record, because an item that vanishes takes its own audit trail with it.
 */
export const FEEDBACK_ITEM_STATUSES = ['draft', 'submitted', 'withdrawn'] as const;
export type FeedbackItemStatus = (typeof FEEDBACK_ITEM_STATUSES)[number];

// =================================================================================================
// SHAPES
// =================================================================================================

/** One rating on one dimension inside one feedback item. */
export interface DimensionRating {
  dimension: FeedbackDimension;
  /** 1..5. Absence of a row means "not observed" — this module never invents a middle value. */
  rating: number;
  comment: string | null;
}

/** A cited incident. Links only — this platform stores no uploaded documents. */
export interface FeedbackExample {
  id: string;
  dimension: FeedbackDimension | null;
  occurredOn: string | null;
  description: string;
  referenceUrl: string | null;
}

/**
 * ONE STRUCTURED FEEDBACK ITEM, as the aggregator sees it. Category (a): raw source data.
 *
 * `authorKey` is the identity used for saturation control — one human must not become two voices by
 * having two ids. It prefers the employee id and falls back to the user id.
 */
export interface FeedbackItem {
  id: string;
  subjectEmployeeId: string;
  sourceType: FeedbackSourceType;
  /** True when the Organization Graph confirmed the claimed relationship at the time of writing. */
  sourceVerified: boolean;
  sourceVerifiedNote: string | null;
  authorKey: string;
  authorUserId: string | null;
  authorEmployeeId: string | null;
  authorName: string;
  context: FeedbackContext;
  contextNote: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** The written evidence. Required for a submitted structured item — see capture.ts. */
  evidence: string;
  evidenceQuality: EvidenceQuality;
  confidentiality: FeedbackConfidentiality;
  status: FeedbackItemStatus;
  ratings: DimensionRating[];
  examples: FeedbackExample[];
  createdAt: string;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  /** Set when the item belongs to an appraisal cycle. Owned by performance.ts; read-only here. */
  cycleId: string | null;
}

/**
 * THE EXPLANATION EVERY DERIVED NUMBER CARRIES.
 *
 * The shape is the one the programme requires literally:
 *   INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
 *
 * A structure and not a paragraph, so a screen, a test and an auditor read the same thing.
 */
export interface Explanation {
  inputs: string[];
  processing: string[];
  output: string;
  evidence: string[];
  confidence: string;
  computedAt: string;
}

export type ConfidenceBand = 'insufficient' | 'low' | 'moderate' | 'high';

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  insufficient: 'Not enough independent sources to say anything',
  low: 'Weak. Treat as a prompt to go and look, not as a finding',
  moderate: 'Reasonable, with the gaps named below',
  high: 'Well covered by several independent sources with evidence',
};

/** What one item contributed to one dimension, and every reason its weight is what it is. */
export interface Contribution {
  feedbackId: string;
  authorKey: string;
  authorName: string;
  sourceType: FeedbackSourceType;
  rating: number;
  evidenceQuality: EvidenceQuality;
  createdAt: string;
  /** The final weight after every adjustment below. */
  weight: number;
  /** Each step, so the number can be reconstructed by hand from the screen. */
  weightSteps: { factor: string; value: number; reason: string }[];
  isOutlier: boolean;
}

export type DisagreementKind = 'none' | 'within_source' | 'across_sources';

export interface DimensionAggregate {
  dimension: FeedbackDimension;
  label: string;
  /** null when there were not enough independent sources. There is no default and no zero. */
  score: number | null;
  band: ConfidenceBand;
  confidence: number;
  /** Distinct humans who rated this dimension. NOT the number of items. */
  sourceCount: number;
  itemCount: number;
  sourceTypes: FeedbackSourceType[];
  /** 0..1. 1 means everybody said the same thing. */
  consensusIndex: number;
  spread: number;
  disagreement: DisagreementKind;
  disagreementNote: string | null;
  outlierCount: number;
  /** Category (a) laid out under the number that came from it. */
  contributions: Contribution[];
  /** The self-reflection rating, kept out of `score` on purpose. */
  selfRating: number | null;
  selfGap: number | null;
  selfGapLabel: 'aligned' | 'rates_self_higher' | 'rates_self_lower' | 'no_self_rating';
  explanation: Explanation;
}

/** Category (c): a reading OF the data, never a fact about a person. */
export interface FeedbackSignalFlag {
  kind:
    | 'single_source'
    | 'source_type_imbalance'
    | 'repeated_unsupported'
    | 'author_tendency'
    | 'disagreement'
    | 'stale_evidence'
    | 'evidence_thin';
  severity: 'note' | 'attention';
  summary: string;
  /** The rows the reading was made from, so a human can go and read them. */
  evidenceRefs: string[];
  /** Present only where the reading is ABOUT a named author. Withheld from non-HR views. */
  aboutAuthorKey?: string | null;
  aboutAuthorName?: string | null;
}

/**
 * THE AGGREGATE. Category (b), with (c) attached and (a) reachable underneath.
 *
 * This object may be READ by a human making a decision. It may never BE the decision, and there is
 * no field on it an employment outcome can be derived from without a person in the loop.
 */
export interface FeedbackSignal {
  contractVersion: string;
  subjectEmployeeId: string;
  /** null unless at least MIN_DIMENSIONS_FOR_OVERALL dimensions could be scored. */
  overall: number | null;
  overallBand: ConfidenceBand;
  dimensions: DimensionAggregate[];
  flags: FeedbackSignalFlag[];
  itemCount: number;
  sourceCount: number;
  sourceTypeCounts: Record<string, number>;
  periodCoveredFrom: string | null;
  periodCoveredTo: string | null;
  explanation: Explanation;
  /** Always true. Present so a consumer cannot claim it did not know. */
  advisoryOnly: true;
  /** The sentence a consuming screen must print beside any use of `overall`. */
  decisionNotice: string;
  computedAt: string;
}

/** The sentence, once, so every surface and every consuming patch prints the same words. */
export const FEEDBACK_DECISION_NOTICE =
  'This is aggregated human feedback, weighted and explained. It is advisory. It does not decide '
  + 'anything about anybody, and no hiring, promotion, pay, disciplinary or exit decision may be '
  + 'recorded as having been made by it. A named person decides, having read the items underneath it.';
