// src/lib/fusion/types.ts — PATCH 06, THE OWNED CONTRACT.
//
// =================================================================================================
// WHAT THIS PATCH IS, IN ONE SENTENCE
// =================================================================================================
//
// It reads what OTHER modules already established about a person, and says — dimension by dimension,
// source by source — what those records agree on, what they contradict, how sure that is, and which
// way the sureness is moving. It establishes nothing itself.
//
// =================================================================================================
// THIS FILE IS A CONTRACT, NOT AN IMPLEMENTATION. EXTEND IT ADDITIVELY.
// =================================================================================================
//
// Patches 03, 04 and 05 write to this vocabulary and this engine reads it. That makes every union
// below a shared interface in the multi-agent sense: a key may be ADDED, and no key may be renamed,
// re-meant or removed. `FUSION_DIMENSIONS` and `SOURCE_CLASSES` are closed on purpose — see below.
//
// =================================================================================================
// TWO CLOSED UNIONS, AND WHY CLOSING THEM IS THE FAIRNESS CONTROL
// =================================================================================================
//
// src/lib/match.ts already settled this argument for job matching: its seven weighting dimensions
// are a closed union and a key outside it is REFUSED BY NAME rather than ignored, so nobody can
// introduce "culture fit" by saving a profile that mentions one. The same reasoning applies with
// more force here, because this record is about a person rather than about a comparison:
//
//   FUSION_DIMENSIONS is the complete list of things this engine will ever say about a human.
//   SOURCE_CLASSES is the complete list of kinds of thing it will ever listen to.
//
// A dimension outside the first is a new claim about somebody. A class outside the second is a new
// kind of listening. Neither may arrive by configuration; both take a code change, a review, and —
// because they are policy about people — an explicit human decision on the record.
//
// =================================================================================================
// THE WEIGHTING RULE IS STRUCTURAL, NOT ADVISORY
// =================================================================================================
//
// "Observed and demonstrated job-related evidence must outweigh inferred foundational insights" is
// enforced in four independent places, so that defeating it takes four deliberate acts rather than
// one careless configuration:
//
//   1. INFERRED_CEILING (src/lib/fusion/weights.ts). No stored weighting may give the inferred
//      foundation more than 15 of 100. A profile that tries is refused with the number it tried.
//   2. DEMONSTRATED_MULTIPLE (same file). The four demonstrated classes together must be worth at
//      least four times the inferred foundation. A profile that is not is refused.
//   3. `inferenceAdmissible: false` (below). On the three dimensions that ask what a person has
//      ACTUALLY DONE, an inferred signal contributes NOTHING AT ALL. It is not down-weighted; it is
//      not admitted. It is still shown, labelled as not admitted, because hiding a refusal is not a
//      refusal anybody can check.
//   4. THE DEFERENCE RULE (src/lib/fusion/fuse.ts). Where demonstrated evidence contradicts the
//      inferred foundation, the inferred contribution for that dimension drops to zero and the
//      contradiction is stated in words. Evidence does not merely outvote inference; it displaces it.
//
// AND THE FLOOR UNDER ALL FOUR: a dimension whose only signals are inferred produces NO READING.
// `status` is 'foundation_only', `reading` is null, and the sentence says so. Inference alone never
// becomes a number about a person.
//
// =================================================================================================
// WHAT THIS ENGINE REFUSES TO PRODUCE
// =================================================================================================
//
// THERE IS NO OVERALL PERSON SCORE, and there is no field one could be stored in. Ten dimensions are
// reported as ten readings and are never totalled, averaged or ranked into one number, for the same
// reason src/lib/capability-coverage.ts refuses to total its statuses: a single figure over
// vocabularies that measure different things is arithmetic wearing the costume of a judgement, and a
// number is what people act on. `FusionProfile` has no `overall` and no `score`.
//
// NOTHING HERE DECIDES ANYTHING. `decisionUse` is 'advisory_only' on every reading, the brand symbol
// below means no other module can fabricate a reading, and hiring, rejection, promotion, termination
// and discipline are not reachable from any surface this patch ships. The engine's whole output is
// an argument a human then makes their own decision about, in the modules that own those decisions
// (src/lib/application-stages.ts for the funnel, src/lib/workflow.ts for approvals).
//
// =================================================================================================
// THE FIVE THINGS THAT MUST NEVER COLLAPSE INTO EACH OTHER
// =================================================================================================
//
//   a) RAW SOURCE DATA           a row somebody else's module owns. Referenced, never copied.
//   b) DERIVED / COMPUTED        a Signal. Produced by a provider from (a), carrying its own basis.
//   c) INTERPRETATION            a DimensionReading. Produced here, from (b), always explained.
//   d) HUMAN FEEDBACK            a HumanNote. A named person's written disagreement or agreement.
//   e) FINAL HUMAN DECISION      NOT IN THIS MODULE. It lives where the decision lives.
//
// (d) never overwrites (c) and never silently becomes organisational truth: a note is recorded
// beside the reading, one per author, and it is shown with the author's name and relationship on it.
// One person's opinion is one person's opinion however senior they are.
//
// =================================================================================================
// HOUSE RULES OBSERVED IN THIS FILE FAMILY
// =================================================================================================
//
//   - Every `const` is declared ABOVE anything that reads it. `const` is not hoisted.
//   - postgres-js returns PLAIN ARRAYS. Every read goes through rowsOf(). Never `r.rows[0]`.
//   - The real Postgres reason is on `e.cause`. Log `e?.cause?.message || e?.message`.
//   - No write path swallows an exception. Every one logs and returns a sentence a person can read.
//   - No emojis anywhere. Inline monochrome SVG only.
//   - types.ts, weights.ts and fuse.ts import NO database. They are pure, and they are tested.

// A TYPE-ONLY import: erased at compile time, so the pure core keeps no runtime dependency on the
// provenance module (which does open the database). src/lib/provenance.ts OWNS this vocabulary —
// factual, explicitly_provided, inferred, calculated, verified, predicted, recommended — and this
// module does not redeclare it. One vocabulary, one owner.
import type { AssertionType } from '@/lib/provenance';

export type { AssertionType };

// -------------------------------------------------------------------------------------------------
// THE TEN DIMENSIONS
// -------------------------------------------------------------------------------------------------

export const FUSION_DIMENSIONS = [
  'role_alignment',
  'current_capability',
  'growth_potential',
  'learning_capacity',
  'leadership_readiness',
  'behavioural_consistency',
  'collaboration',
  'work_sustainability',
  'development_requirements',
  'professional_trajectory',
] as const;

export type FusionDimension = (typeof FUSION_DIMENSIONS)[number];

export function isFusionDimension(v: unknown): v is FusionDimension {
  return typeof v === 'string' && (FUSION_DIMENSIONS as readonly string[]).includes(v);
}

// -------------------------------------------------------------------------------------------------
// THE FIVE SOURCE CLASSES
// -------------------------------------------------------------------------------------------------

export const SOURCE_CLASSES = [
  'inferred_foundation',
  'observed_evidence',
  'manager_evidence',
  'peer_evidence',
  'assessment_evidence',
] as const;

export type SourceClass = (typeof SOURCE_CLASSES)[number];

export function isSourceClass(v: unknown): v is SourceClass {
  return typeof v === 'string' && (SOURCE_CLASSES as readonly string[]).includes(v);
}

/** The four that rest on something a person DID. The weighting rule, in one constant. */
export const DEMONSTRATED_CLASSES: readonly SourceClass[] = Object.freeze([
  'observed_evidence',
  'manager_evidence',
  'assessment_evidence',
  'peer_evidence',
]);

/** The one that does not. Named once so no call site spells it by hand. */
export const INFERRED_CLASS: SourceClass = 'inferred_foundation';

export function isDemonstrated(c: SourceClass): boolean {
  return DEMONSTRATED_CLASSES.includes(c);
}

export interface SourceClassSpec {
  key: SourceClass;
  /** What a reader is shown. Neutral, professional, proprietary terminology throughout. */
  label: string;
  /** What it IS, in a sentence, for the person the record is about. */
  meaning: string;
  /** Who or what stands behind it. */
  standsOn: string;
  /** How far it may ever be taken. */
  decisionUse: 'supporting_only' | 'advisory_only';
  /** The patch that owns the module producing it. Auditable at a glance. */
  ownerPatch: string;
}

export const SOURCE_CLASS_SPECS: readonly SourceClassSpec[] = Object.freeze([
  {
    key: 'inferred_foundation',
    label: 'Inferred foundation',
    meaning:
      'A professional interpretation produced from a traditional computational method, before any '
      + 'record of this person at work was consulted. It is a starting hypothesis about disposition, '
      + 'and it is not a finding about capability.',
    standsOn: 'A computation, interpreted by the interpretation layer. No observation of this person.',
    decisionUse: 'advisory_only',
    ownerPatch: 'PATCH 03',
  },
  {
    key: 'observed_evidence',
    label: 'Observed evidence',
    meaning:
      'Things this person did that an organisational record already holds — work delivered, '
      + 'commitments met, learning completed, evidence a named person accepted.',
    standsOn: 'Records this platform already keeps for their own purposes. Nothing collected to watch anybody.',
    decisionUse: 'supporting_only',
    ownerPatch: 'PATCH 04',
  },
  {
    key: 'manager_evidence',
    label: 'Manager evidence',
    meaning:
      'What the person the organisation graph routed as responsible for this person’s work wrote '
      + 'down, in an appraisal or a recorded assessment, with their name on it.',
    standsOn: 'A named human who answers for the judgement.',
    decisionUse: 'supporting_only',
    ownerPatch: 'PATCH 05 (aggregation) over src/lib/performance.ts (the records)',
  },
  {
    key: 'peer_evidence',
    label: 'Peer evidence',
    meaning:
      'What colleagues recorded, aggregated with its disagreement kept rather than averaged away.',
    standsOn: 'Named colleagues. Weighted by source, never pooled into one anonymous verdict.',
    decisionUse: 'supporting_only',
    ownerPatch: 'PATCH 05',
  },
  {
    key: 'assessment_evidence',
    label: 'Assessment evidence',
    meaning:
      'A structured assessment this person sat, scored against a rubric that existed before they sat it.',
    standsOn: 'A graded attempt on record, with its items and its date.',
    decisionUse: 'supporting_only',
    ownerPatch: 'PATCH 06 reads src/lib/assessment.ts directly',
  },
]);

const FALLBACK_SPEC_MEANING = 'No description has been written for this source class yet.';

export function sourceClassSpec(key: SourceClass): SourceClassSpec {
  const found = SOURCE_CLASS_SPECS.find((s) => s.key === key);
  // Every member of a closed union has a spec today; the fallback exists so that ADDING one cannot
  // throw on a screen before somebody remembers to write its prose.
  return found || {
    key,
    label: String(key).replace(/_/g, ' '),
    meaning: FALLBACK_SPEC_MEANING,
    standsOn: 'Unstated.',
    decisionUse: 'advisory_only',
    ownerPatch: 'unassigned',
  };
}

export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  inferred_foundation: 'Inferred foundation',
  observed_evidence: 'Observed evidence',
  manager_evidence: 'Manager evidence',
  peer_evidence: 'Peer evidence',
  assessment_evidence: 'Assessment evidence',
};

// -------------------------------------------------------------------------------------------------
// WHAT EACH DIMENSION MEANS, AND WHICH SOURCES MAY SPEAK TO IT
// -------------------------------------------------------------------------------------------------

export interface DimensionSpec {
  key: FusionDimension;
  label: string;
  /** The question this dimension answers. Printed on the screen, so nobody has to guess. */
  question: string;
  /**
   * WHAT A HIGH READING MEANS. This exists because one of the ten is inverted —
   * `development_requirements` reads HIGH when there is MORE to develop — and a dimension whose
   * polarity a reader has to infer is a dimension that will eventually be read backwards about a
   * real person.
   */
  highMeans: string;
  lowMeans: string;
  /**
   * MAY AN INFERRED FOUNDATION CONTRIBUTE TO THIS AT ALL.
   *
   * False on the three dimensions that ask what somebody has actually done and what they actually
   * need. A computation performed before anybody watched this person work has nothing to say about
   * whether they can do the job today, and admitting it there at any weight would be admitting it to
   * the question it is least entitled to touch.
   */
  inferenceAdmissible: boolean;
  /** The kind of thing that would move this reading, said plainly, so a person knows what to do. */
  movedBy: string;
}

export const DIMENSION_SPECS: readonly DimensionSpec[] = Object.freeze([
  {
    key: 'role_alignment',
    label: 'Role alignment',
    question: 'How well does what this person has demonstrated line up with what their role asks for?',
    highMeans: 'The role’s recorded requirements are largely met by evidence on record.',
    lowMeans: 'Much of what the role asks for has nothing on record yet. That is a gap in the RECORD as often as a gap in the person.',
    inferenceAdmissible: false,
    movedBy: 'Evidence against the role’s recorded requirements, and keeping those requirements current.',
  },
  {
    key: 'current_capability',
    label: 'Current capability',
    question: 'What can this person do now, on the evidence this organisation holds?',
    highMeans: 'Skills recorded at working level or above, with evidence behind them rather than a keyword.',
    lowMeans: 'Little is evidenced. Frequently that means nobody recorded it, not that nobody can do it.',
    inferenceAdmissible: false,
    movedBy: 'Verified skill evidence, completed work a named person accepted, graded assessments.',
  },
  {
    key: 'growth_potential',
    label: 'Growth potential',
    question: 'What does the record suggest about how far this person could go from here?',
    highMeans: 'Capability has moved measurably, across more than one kind of evidence.',
    lowMeans: 'The record has not moved. It may simply not have been kept.',
    inferenceAdmissible: true,
    movedBy: 'Change over time in demonstrated capability. A single point in time cannot answer this.',
  },
  {
    key: 'learning_capacity',
    label: 'Learning capacity',
    question: 'How does this person take on something they did not previously know?',
    highMeans: 'Assigned and self-directed learning is finished, and what was learned shows up in later work.',
    lowMeans: 'Little completed learning on record.',
    inferenceAdmissible: true,
    movedBy: 'Completed learning, and evidence that used it afterwards.',
  },
  {
    key: 'leadership_readiness',
    label: 'Leadership readiness',
    question: 'What is on record about this person carrying responsibility for other people’s work?',
    highMeans: 'Responsibility has been carried, and named people recorded how it went.',
    lowMeans: 'No record of carrying it. Very often that means it was never offered.',
    inferenceAdmissible: true,
    movedBy: 'Responsibility actually held, and what managers and colleagues wrote about it.',
  },
  {
    key: 'behavioural_consistency',
    label: 'Behavioural consistency',
    question: 'Do the different records of how this person works say the same thing?',
    highMeans: 'Independent records agree with each other.',
    lowMeans: 'Records disagree, or there are too few to compare. Disagreement is a prompt to ask, not a finding.',
    inferenceAdmissible: true,
    movedBy: 'More independent records. This is about agreement between sources, not about a person’s worth.',
  },
  {
    key: 'collaboration',
    label: 'Collaboration',
    question: 'What have the people who work with this person recorded about working with them?',
    highMeans: 'Colleagues and managers recorded working well together.',
    lowMeans: 'Little recorded either way.',
    inferenceAdmissible: true,
    movedBy: 'Recorded feedback from named colleagues, and shared work that left a record.',
  },
  {
    key: 'work_sustainability',
    label: 'Work sustainability',
    question: 'Is the way this workload is being carried something that can continue?',
    highMeans: 'The pattern on record looks sustainable.',
    lowMeans: 'The pattern on record does not. This is a prompt for a manager to have a conversation.',
    inferenceAdmissible: true,
    movedBy: 'Organisational records of workload and working time that are already kept for their own purposes.',
  },
  {
    key: 'development_requirements',
    label: 'Development requirements',
    question: 'What does the record say this person needs next?',
    highMeans: 'MORE is needed. This dimension is inverted: a high reading is a larger development need, not a worse person.',
    lowMeans: 'Less is outstanding against what the role asks for.',
    inferenceAdmissible: false,
    movedBy: 'Gaps against recorded role requirements, and what managers wrote under support needed.',
  },
  {
    key: 'professional_trajectory',
    label: 'Professional trajectory',
    question: 'Which way has this person’s record been moving, over the time it covers?',
    highMeans: 'The record has been moving upward across successive readings.',
    lowMeans: 'It has been flat, or moving down. A short record cannot answer this at all.',
    inferenceAdmissible: true,
    movedBy: 'Successive readings over time. One reading is not a trajectory and is reported as not being one.',
  },
]);

const SPEC_BY_KEY: Record<string, DimensionSpec> = Object.freeze(
  DIMENSION_SPECS.reduce((acc, s) => { acc[s.key] = s; return acc; }, {} as Record<string, DimensionSpec>),
);

export function dimensionSpec(key: FusionDimension): DimensionSpec {
  return SPEC_BY_KEY[key];
}

export const DIMENSION_LABELS: Record<FusionDimension, string> = FUSION_DIMENSIONS.reduce((acc, d) => {
  acc[d] = SPEC_BY_KEY[d].label;
  return acc;
}, {} as Record<FusionDimension, string>);

/** The one inverted dimension, named once rather than string-tested for in four places. */
export const INVERTED_DIMENSIONS: readonly FusionDimension[] = Object.freeze(['development_requirements']);

export function isInverted(d: FusionDimension): boolean {
  return INVERTED_DIMENSIONS.includes(d);
}

// -------------------------------------------------------------------------------------------------
// THE SIGNAL — THE ONLY THING THAT MAY ENTER THIS ENGINE
// -------------------------------------------------------------------------------------------------

/**
 * ONE OBSERVATION, FROM ONE SOURCE, ABOUT ONE DIMENSION.
 *
 * A provider builds these from rows its own module owns. It never hands over the rows themselves:
 * raw source data stays where it lives and is REFERENCED here, which is what keeps (a) and (b) of
 * the five-way separation apart, and what makes every reading traceable back through the module that
 * is entitled to interpret it.
 *
 * THERE IS NO FIELD HERE FOR A PROTECTED ATTRIBUTE AND THERE MUST NEVER BE ONE. No race, religion,
 * caste, politics, sexual orientation, disability, health, pregnancy, marital status, age or gender —
 * not as a signal, not as a basis, not as a locator. `screenSignal()` in fuse.ts refuses a signal
 * whose statement or basis names one, BY NAME, rather than dropping it quietly.
 *
 * AND NOTHING HERE READS SURVEILLANCE. There is no field for keystrokes, screenshots, idle time,
 * message volume, or location beyond what an organisational record already holds for its own
 * purpose. A provider that wanted to supply one would have nowhere to put it.
 */
export interface Signal {
  /** Stable within one gather. Used to dedupe, and to point a reader at the exact contribution. */
  signalId: string;
  dimension: FusionDimension;
  sourceClass: SourceClass;

  /** Which provider produced it — the registry key. */
  providerKey: string;
  /** The module that OWNS the underlying record, as a repo path. Printed in the evidence chain. */
  ownerModule: string;
  /** The table and row the underlying record lives in, where there is one. Reference, never a copy. */
  sourceTable: string | null;
  sourceId: string | null;

  /**
   * WHAT IT SAYS, from -1 to +1. Direction and degree, not a percentage of a person.
   * On an inverted dimension, +1 means MORE is needed. `dimensionSpec().highMeans` is the authority.
   */
  position: number;
  /**
   * HOW MUCH OF A THING IT IS, from 0 to 1. A passing remark and a full appraisal are both one
   * signal; this is what stops them counting the same.
   */
  strength: number;

  /** When the thing being reported HAPPENED. Null where the record does not say — never guessed. */
  observedAt: string | null;

  /** One sentence a person could read about themselves without needing it explained. Required. */
  statement: string;
  /** How the provider came to say it. Required, and it is what a reader checks. */
  basis: string;

  /** The provenance vocabulary. src/lib/provenance.ts owns it; this module never redeclares it. */
  assertion: AssertionType;

  /** A LINK to the evidence. This project never stores an upload; there is no field for one. */
  evidenceUrl: string | null;
  /** Where inside it — a section, an item number, a certificate number, a commit. */
  locator: string | null;

  /** The named human who is answerable for this, where there is one. */
  attributedToUserId: string | null;
  /** Their relationship to the subject at the time — a RELATIONSHIP, resolved from the org graph. */
  attributedToRelationship: string | null;

  /**
   * REQUIRED ON EVERY INFERRED SIGNAL. The sentence that goes on the screen beside it, saying what
   * it is not. `screenSignal()` refuses an inferred signal without one, so the notice cannot be lost
   * by a provider that forgot it.
   */
  advisoryNotice: string | null;
}

// -------------------------------------------------------------------------------------------------
// WHAT ONE SOURCE CLASS SAYS ABOUT ONE DIMENSION
// -------------------------------------------------------------------------------------------------

/** How one source class stands relative to the inferred foundation. */
export const AGREEMENTS = [
  'strongly_confirms',
  'partially_confirms',
  'does_not_confirm',
  'contradicts',
  'silent',
  'no_foundation_to_compare',
] as const;
export type Agreement = (typeof AGREEMENTS)[number];

export const AGREEMENT_LABELS: Record<Agreement, string> = {
  strongly_confirms: 'strongly confirms',
  partially_confirms: 'partially confirms',
  does_not_confirm: 'does not confirm',
  contradicts: 'contradicts',
  silent: 'is silent',
  no_foundation_to_compare: 'has nothing to compare against',
};

export interface SourceView {
  sourceClass: SourceClass;
  label: string;
  /** How many signals of this class fed this dimension. */
  signalCount: number;
  /** The class’s own position, -1..+1, before any weighting. null when the class is silent. */
  position: number | null;
  /** Total strength this class brought. */
  strength: number;
  /** The weight it was given, 0..100, from the weighting profile in force. */
  weight: number;
  /**
   * WHAT IT ACTUALLY CONTRIBUTED after admissibility and the deference rule. 0 where a class was
   * present but not admitted — which is a different thing from being silent, and is printed as one.
   */
  effectiveWeight: number;
  /** Set whenever effectiveWeight is below weight. Always a sentence. */
  withheldBecause: string | null;
  /** How this class stands against the inferred foundation. */
  agreement: Agreement;
  /** The newest observation in this class, so recency is visible per source rather than pooled. */
  mostRecentAt: string | null;
  /** The signals themselves, for the reader who opens the row. */
  signals: Signal[];
}

// -------------------------------------------------------------------------------------------------
// THE EXPLANATION CONTRACT — INPUTS, PROCESSING, OUTPUT, EVIDENCE, CONFIDENCE, TIMESTAMP
// -------------------------------------------------------------------------------------------------

/**
 * The six-part shape every intelligence output in this system must carry. It is a TYPE rather than a
 * convention, so that a reading without one cannot be constructed, and so a screen can render the
 * six parts without knowing which dimension it is showing.
 */
export interface Explanation {
  /** INPUTS — what was read, by name, with counts. */
  inputs: { source: string; ownerModule: string; rows: number; sentence: string }[];
  /** PROCESSING — what was done to it, in order, in words. No formula a reader cannot follow. */
  processing: string[];
  /** OUTPUT — what was concluded. One sentence. */
  output: string;
  /** EVIDENCE — the references behind it. Links, never copies. */
  evidence: { what: string; ownerModule: string; url: string | null; locator: string | null; at: string | null }[];
  /** CONFIDENCE — how sure, why that sure, and which way it is moving. */
  confidence: ConfidenceReport;
  /** TIMESTAMP — when this was computed. */
  computedAt: string;
}

export const CONFIDENCE_BANDS = ['insufficient', 'low', 'moderate', 'high'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  insufficient: 'Not enough to say',
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
};

export const CONFIDENCE_DIRECTIONS = ['increasing', 'steady', 'decreasing', 'first_reading'] as const;
export type ConfidenceDirection = (typeof CONFIDENCE_DIRECTIONS)[number];

export const CONFIDENCE_DIRECTION_LABELS: Record<ConfidenceDirection, string> = {
  increasing: 'increasing',
  steady: 'steady',
  decreasing: 'decreasing',
  first_reading: 'first reading',
};

export interface ConfidenceReport {
  band: ConfidenceBand;
  /** 0-100. Reported WITH the band, never instead of it. */
  value: number;
  /** How many INDEPENDENT demonstrated source classes contributed. The main driver, and the honest one. */
  independentSources: number;
  /** Days since the newest demonstrated observation. null when there is none. */
  recencyDays: number | null;
  direction: ConfidenceDirection;
  /** The value at the previous snapshot, for the reader who wants to see the move. */
  previousValue: number | null;
  /** Why this band. Always a sentence. */
  sentence: string;
}

// -------------------------------------------------------------------------------------------------
// THE READING
// -------------------------------------------------------------------------------------------------

export const READING_STATUSES = [
  'evidenced',
  'thin_evidence',
  'foundation_only',
  'nothing_on_record',
  'unreadable',
] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  evidenced: 'Evidenced',
  thin_evidence: 'Thin evidence',
  foundation_only: 'Foundation only — no reading',
  nothing_on_record: 'Nothing on record',
  unreadable: 'Could not be read',
};

/**
 * THE BRAND. Not exported outside this directory, so no module elsewhere can construct a
 * DimensionReading — which means there is no way anywhere in this codebase to produce a number about
 * a person without the explanation that has to travel with it. src/lib/match.ts established this
 * pattern here and this module follows it rather than inventing a second one.
 */
declare const FUSED: unique symbol;

export interface DimensionReading {
  readonly [FUSED]: true;

  dimension: FusionDimension;
  label: string;
  question: string;
  inverted: boolean;

  status: ReadingStatus;
  /**
   * 0-100, and NULL whenever status is not 'evidenced' or 'thin_evidence'. A dimension that could
   * not be read has no number — it does not have a zero. Zero is a finding; absence is not.
   */
  reading: number | null;
  /** The one sentence that explains this reading, on its own, to the person it is about. */
  sentence: string;

  /** The five source classes, always all five, silent ones included and labelled as silent. */
  sources: SourceView[];

  /** What the sources agree on, in words. */
  agreement: string[];
  /** Where they contradict each other, in words. Never resolved silently. */
  contradiction: string[];

  explanation: Explanation;

  /** Movement against the previous snapshot for the same dimension. */
  change: {
    previousReading: number | null;
    delta: number | null;
    since: string | null;
    sentence: string;
  };

  /** Named, and never folded into the number. */
  developmentNeeds: string[];

  /** Fixed. There is no code path in this repository that sets it to anything else. */
  decisionUse: 'advisory_only';
}

/** The reading before it is branded. What fuse.ts builds and what nothing else may hand out. */
export type UnbrandedReading = Omit<DimensionReading, typeof FUSED>;

/** INTERNAL to src/lib/fusion. The only constructor of a branded reading. */
export function brandReading(r: UnbrandedReading): DimensionReading {
  return r as DimensionReading;
}

// -------------------------------------------------------------------------------------------------
// THE PROFILE
// -------------------------------------------------------------------------------------------------

/** A named human’s written response to a reading. Recorded beside it. It never replaces it. */
export interface HumanNote {
  noteId: string;
  dimension: FusionDimension | null;
  authorUserId: string;
  authorName: string | null;
  /** Their relationship to the subject, resolved from the org graph at the time of writing. */
  authorRelationship: string | null;
  stance: 'agrees' | 'disagrees' | 'adds_context';
  body: string;
  writtenAt: string;
}

export const NOTE_STANCES = ['agrees', 'disagrees', 'adds_context'] as const;
export type NoteStance = (typeof NOTE_STANCES)[number];

export const NOTE_STANCE_LABELS: Record<NoteStance, string> = {
  agrees: 'Agrees',
  disagrees: 'Disagrees',
  adds_context: 'Adds context',
};

export function isNoteStance(v: unknown): v is NoteStance {
  return typeof v === 'string' && (NOTE_STANCES as readonly string[]).includes(v);
}

export interface ProfileSubject {
  employeeId: string;
  displayName: string | null;
  designation: string | null;
  departmentId: string | null;
  /** The role whose requirements role_alignment was read against, where one is on record. */
  roleId: string | null;
  roleTitle: string | null;
}

/**
 * THE EMPLOYEE INTELLIGENCE PROFILE.
 *
 * ONE MASTER RECORD. The role-based VIEWS are produced by src/lib/fusion/access.ts from this one
 * object by REMOVING what a given viewer may not see — never by computing a different profile for
 * different people, which is how two screens end up disagreeing about the same human.
 *
 * NO `overall`, NO `score`, NO `rank`. See the file header.
 */
export interface FusionProfile {
  subject: ProfileSubject;

  /** All ten, always, in FUSION_DIMENSIONS order. A dimension is never omitted for being empty. */
  dimensions: DimensionReading[];

  /** The weighting every reading above was produced under, named and owned. */
  weighting: {
    key: string;
    label: string;
    ownerUserId: string | null;
    weights: Record<SourceClass, number>;
    isBuiltInDefault: boolean;
    sentence: string;
  };

  /** What could not be read, and why. Never rendered as an empty result. */
  unreadable: { what: string; because: string }[];
  /** What was deliberately not looked at for this viewer. Named, so absence is never silent. */
  withheld: { what: string; because: string }[];
  /** Providers that are not connected yet. An honest empty, never a fabricated full one. */
  notConnected: { providerKey: string; ownerPatch: string; what: string }[];

  /** Human responses on record. Shown with names; never averaged into anything. */
  humanNotes: HumanNote[];

  /** The snapshots this profile can be compared against, newest first. */
  history: { snapshotId: string; computedAt: string; dimensionsRead: number }[];

  fairness: {
    /** Always empty. Present so a screen can PRINT that it is empty rather than say nothing at all. */
    protectedAttributesUsed: string[];
    refusedSignals: { providerKey: string; because: string }[];
    sentence: string;
  };

  humanAuthority: {
    decides: false;
    sentence: string;
    /** Where the actual decision is made, so a screen can send somebody there. */
    routes: { label: string; href: string }[];
  };

  computedAt: string;
  /** Set when this profile was loaded from a stored snapshot rather than computed now. */
  fromSnapshotId: string | null;
}
