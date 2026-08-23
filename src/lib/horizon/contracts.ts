// src/lib/horizon/contracts.ts — PATCH 11's OWNED CONTRACT SURFACE.
//
// =================================================================================================
// WHAT THIS FILE IS
// =================================================================================================
//
// Patch 11 is a VIEW. It builds the Super Admin employee profile and it owns no employee data.
// The brief is explicit: "Do not create a separate employee database model. Consume the Master
// Employee Intelligence Record and PATCH contracts."
//
// So this file declares, from the CONSUMER side, the exact shape Patch 11 needs each producing
// patch to hand it. Nothing here reads a database, nothing here creates a table, and nothing here
// implements another patch's module. A producing patch implements `HorizonSectionProvider` and
// registers itself (src/lib/horizon/registry.ts); until it does, the section renders as
// NOT SUPPLIED, naming the patch that owes it. An unimplemented section is a stated absence, never
// an invented figure.
//
// =================================================================================================
// THE FIVE KINDS OF STATEMENT, NEVER COLLAPSED
// =================================================================================================
//
// Rule 13 of the build brief requires that raw source data, derived data, AI interpretation, human
// feedback and the final human decision stay distinguishable all the way to the screen. They are
// distinguishable here because every value carries `dataClass`, and the renderer prints the class
// beside the value rather than presenting five different kinds of claim in one typeface.
//
// This is deliberately the same discipline src/lib/digital-twin.ts already applies with its seven
// assertion types and src/lib/evidence-graph.ts applies with its seven evidence levels. Patch 11
// does not introduce a second vocabulary for the same idea; `dataClass` is a COARSER axis that the
// brief names, and the finer provenance travels beside it untouched.
//
// =================================================================================================
// EVERY INTELLIGENCE OUTPUT CARRIES ITS OWN WORKING
// =================================================================================================
//
// Rule 12: INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP.
//
// `IntelligenceOutput<T>` is that sentence as a type. A provider cannot return a number to this
// view without also returning what went into it, what was done to it, what supports it, how sure it
// is and when it was computed. There is no shape in this module that can carry a bare score.
//
// =================================================================================================
// WHAT THIS VIEW MAY NEVER DO
// =================================================================================================
//
//   - No section may decide anything. Rule 14. `DecisionRecord` records a decision a NAMED HUMAN
//     made; there is no field for a decision the system made, and no writer in this patch creates
//     one.
//   - No section may diagnose. Rule 27. `SUSTAINABILITY_REFUSALS` below is printed on the Work
//     Sustainability tab so the screen says out loud what it is not claiming.
//   - No birth-based or inferred signal may outrank demonstrated work. Rule 22. `Signal.weightClass`
//     is ordered and `compareSignalWeight()` is the only comparator this patch offers.
//   - The word this project will not print appears in no user-facing string. Rule 19.
//     `assertNeutralTerminology()` is a test-time guard over provider-supplied labels.
// =================================================================================================

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Every const is declared ABOVE the functions that read it: `const` is not
// hoisted, and a const read before its declaration throws on the first line of its caller. That has
// taken pages down on this project before.
// -------------------------------------------------------------------------------------------------

/** The person this view is about, resolved by the identity spine, never re-derived here. */
export interface MeirSubject {
  /** Composed key from src/lib/digital-twin.ts. There is no person_id column in this database. */
  personKey: string;
  userId: string | null;
  employeeId: string | null;
  applicationIds: string[];
}

export const DATA_CLASSES = [
  'raw_source',
  'derived',
  'ai_interpretation',
  'human_feedback',
  'human_decision',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DATA_CLASS_LABELS: Record<DataClass, string> = {
  raw_source: 'Source record',
  derived: 'Computed from records',
  ai_interpretation: 'System interpretation',
  human_feedback: 'Stated by a person',
  human_decision: 'Decision by a named human',
};

export const DATA_CLASS_MEANING: Record<DataClass, string> = {
  raw_source:
    'A row this organisation already held, shown as it is stored. Nothing has been inferred from it here.',
  derived:
    'Calculated from stored rows by a rule that is written down and named beside the number. Change the rows and this changes.',
  ai_interpretation:
    'A reading this system produced. Advisory. It is not a fact about the person and it may not carry a decision on its own.',
  human_feedback:
    'One named person said this. It is their statement, not the organisation’s conclusion, and it stays attributed.',
  human_decision:
    'A named human decided this and answers for it. This is the only class that changes anything about anybody.',
};

/**
 * The weight order the brief fixes in rule 22: demonstrated job-related evidence outranks inferred
 * or birth-based insight, and nothing in this patch may reorder that.
 *
 * Higher index = stronger. `compareSignalWeight` is the only comparator exported, so a caller that
 * wants to sort signals cannot accidentally sort them the other way round.
 */
export const SIGNAL_WEIGHT_CLASSES = [
  'birth_based_inference',
  'model_inference',
  'self_reported',
  'peer_report',
  'manager_report',
  'organisational_record',
  'demonstrated_work',
] as const;
export type SignalWeightClass = (typeof SIGNAL_WEIGHT_CLASSES)[number];

export const SIGNAL_WEIGHT_LABELS: Record<SignalWeightClass, string> = {
  birth_based_inference: 'Traditional computational input (interpretive)',
  model_inference: 'System inference',
  self_reported: 'Stated by the person themselves',
  peer_report: 'Reported by a colleague',
  manager_report: 'Reported by a manager',
  organisational_record: 'Organisational record',
  demonstrated_work: 'Demonstrated work',
};

/**
 * The sentence printed beside a signal of this class, so a reader is never left to guess how much a
 * thing is allowed to mean.
 */
export const SIGNAL_WEIGHT_MEANING: Record<SignalWeightClass, string> = {
  birth_based_inference:
    'An interpretive input derived from a traditional computational method. It is not evidence about this person’s work, it is not presented as scientific fact, and it must never outweigh anything below it.',
  model_inference:
    'The system worked this out. Advisory. It carries the rule that produced it and it may not be the reason for a decision.',
  self_reported:
    'The person said it about themselves and knew it was going on the record. It is their word, and it stays labelled as their word.',
  peer_report: 'A colleague said so. One person’s account, weighted as one person’s account.',
  manager_report: 'A manager said so. Attributed, and still one person’s account.',
  organisational_record:
    'This organisation recorded it as a side effect of something happening — an attendance row, a completed course, a submitted piece of work.',
  demonstrated_work:
    'The person did the work and this platform holds the record of it. The strongest thing this view can show.',
};

/** Rule 22, as a function. Sorting signals any other way is not reachable from this module. */
export function compareSignalWeight(a: SignalWeightClass, b: SignalWeightClass): number {
  return SIGNAL_WEIGHT_CLASSES.indexOf(a) - SIGNAL_WEIGHT_CLASSES.indexOf(b);
}

/** True when `a` is allowed to carry more weight in a human's reading than `b`. */
export function outranks(a: SignalWeightClass, b: SignalWeightClass): boolean {
  return compareSignalWeight(a, b) > 0;
}

/**
 * Signals in the order a human should read them: strongest kind of evidence first, then most recent.
 *
 * This is the ONLY ordering function this patch offers, and it orders — it does not add. There is
 * deliberately no code path anywhere in HORIZON that could turn a list of signals into a single
 * number beside somebody's name.
 *
 * Returns a new array; the input is not mutated, because the same signal list is rendered under its
 * own section as well as in the roll-up and the two must not fight over the order.
 */
export function sortSignalsByWeight<T extends { weightClass: SignalWeightClass; observedAt: string | null }>(
  signals: readonly T[],
): T[] {
  return signals.slice().sort((a, b) => {
    const w = compareSignalWeight(b.weightClass, a.weightClass);
    if (w !== 0) return w;
    const at = a.observedAt ? Date.parse(a.observedAt) : 0;
    const bt = b.observedAt ? Date.parse(b.observedAt) : 0;
    if (isNaN(at) && isNaN(bt)) return 0;
    return (isNaN(bt) ? 0 : bt) - (isNaN(at) ? 0 : at);
  });
}

// -------------------------------------------------------------------------------------------------
// CONFIDENCE
// -------------------------------------------------------------------------------------------------

export const CONFIDENCE_BANDS = ['none', 'low', 'moderate', 'high'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export interface Confidence {
  /** 0..1, or null when the producing patch will not state one. Null is a valid, honest answer. */
  value: number | null;
  band: ConfidenceBand;
  /** Why it is that and not something else. Printed. An unexplained confidence is decoration. */
  basis: string;
}

export const NO_CONFIDENCE: Confidence = Object.freeze({
  value: null,
  band: 'none',
  basis: 'Nothing on record supports a confidence figure, so none is stated.',
});

/** Band from a 0..1 value, so two providers do not draw the same line in two places. */
export function bandOf(value: number | null | undefined): ConfidenceBand {
  if (typeof value !== 'number' || !isFinite(value)) return 'none';
  if (value >= 0.75) return 'high';
  if (value >= 0.45) return 'moderate';
  if (value > 0) return 'low';
  return 'none';
}

// -------------------------------------------------------------------------------------------------
// EVIDENCE
// -------------------------------------------------------------------------------------------------

/**
 * A pointer to the ORIGINAL AUTHORISED RECORD — the last rung of the navigation ladder.
 *
 * This mirrors what src/lib/evidence-graph.ts already stores on capability_evidence
 * (owner_module / source_table / source_id / document_url / locator / occurred_at /
 * verification_status). It is repeated here as a VIEW-SIDE type so that a producing patch which
 * does not use the evidence graph can still answer the question, not so that a second evidence
 * store can be built. Patch 11 creates no evidence table.
 *
 * `documentUrl` is a LINK. This project never stores an uploaded document.
 */
export interface EvidenceRef {
  /** The module that owns the row, so a reader knows which desk to ask. */
  ownerModule: string;
  sourceTable: string | null;
  sourceId: string | null;
  /** Page, section, lesson, commit, certificate number — where inside the source it is. */
  locator: string | null;
  documentUrl: string | null;
  occurredAt: string | null;
  /** Free text from the producing patch. Rendered verbatim; never parsed into a score. */
  verificationStatus: string | null;
  /** The one-line sentence a screen prints for this reference. */
  sentence: string;
  /** An in-app route that opens the original record, when one exists. */
  href: string | null;
}

// -------------------------------------------------------------------------------------------------
// RULE 12, AS A TYPE
// -------------------------------------------------------------------------------------------------

export interface IntelligenceOutput<T> {
  /** What went in. Names of sources, not the values themselves. */
  inputs: string[];
  /** What was done. One sentence, in words, not a model name. */
  processing: string;
  output: T;
  evidence: EvidenceRef[];
  confidence: Confidence;
  /** ISO. When the OUTPUT was computed, not when the page was opened. */
  computedAt: string | null;
  dataClass: DataClass;
}

// -------------------------------------------------------------------------------------------------
// SIGNAL -> PATTERN
// -------------------------------------------------------------------------------------------------

export interface Signal {
  id: string;
  /** Short label. Neutral terminology only — see screenTerminology(). */
  label: string;
  /** What it says, in a sentence a person can disagree with. */
  statement: string;
  weightClass: SignalWeightClass;
  dataClass: DataClass;
  confidence: Confidence;
  observedAt: string | null;
  /** The patch that produced it. Printed, so a disputed signal has an owner. */
  producedBy: string;
  evidence: EvidenceRef[];
  /** Patterns this signal is part of, by id. Empty is normal: most signals stand alone. */
  patternIds: string[];
  /** A named human disputed this signal. Recorded, never silently dropped. */
  disputed: boolean;
}

export interface Pattern {
  id: string;
  label: string;
  /** What repeats, over what window, and what would falsify it. */
  statement: string;
  /** ISO date range the pattern was observed over. */
  from: string | null;
  to: string | null;
  /** Signals that make it up. A pattern with one signal is not a pattern and says so. */
  signalIds: string[];
  confidence: Confidence;
  dataClass: DataClass;
  producedBy: string;
  /** Disagreement inside the pattern: sources that point the other way. Rule 25. */
  counterSignalIds: string[];
}

// -------------------------------------------------------------------------------------------------
// HUMAN DECISIONS AND INTERVENTIONS
// -------------------------------------------------------------------------------------------------

export interface DecisionRecord {
  id: string;
  /** What was decided, in the decider's words where possible. */
  decision: string;
  /** The named human. Never a system id. Rule 14. */
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedByRole: string | null;
  decidedAt: string | null;
  /** The written reason. A decision without one is shown as a decision without one. */
  reason: string | null;
  /** Signals the decider says they considered. Attribution, not causation. */
  consideredSignalIds: string[];
  /** True when the subject has been told. Rule 15/17: the person is not the last to know. */
  subjectInformed: boolean;
  /** Where the decision lives, so the original record is one click away. */
  evidence: EvidenceRef[];
  producedBy: string;
}

export interface InterventionRecord {
  id: string;
  kind: string;
  summary: string;
  openedAt: string | null;
  closedAt: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  /** open | closed | withdrawn, as the owning patch stores it. Rendered verbatim. */
  status: string;
  evidence: EvidenceRef[];
  producedBy: string;
}

// -------------------------------------------------------------------------------------------------
// FEEDBACK — RULE 24 AND RULE 25
// -------------------------------------------------------------------------------------------------

export interface FeedbackContribution {
  id: string;
  /** Who said it, when the section's grant allows a name; null when the source is anonymised. */
  sourceUserId: string | null;
  sourceName: string | null;
  sourceRelationship: string | null;
  /** The rating as stored, and the scale it was on. A bare number is meaningless. */
  value: number | null;
  scaleMax: number | null;
  comment: string | null;
  givenAt: string | null;
  /** How much this one voice counts, and why. Rule 25. Never hidden. */
  weight: number;
  weightBasis: string;
  /** Flagged by the producing patch as an outlier against the rest. Not removed — flagged. */
  outlier: boolean;
}

export interface FeedbackAggregate {
  /** The aggregate figure, or null when there is not enough to state one. */
  value: number | null;
  scaleMax: number | null;
  contributorCount: number;
  /** Spread. Printed beside the aggregate, because an average alone hides a split room. */
  disagreement: string;
  /** Rule 25: what the producing patch found when it looked for bias. Never suppressed. */
  biasNotes: string[];
  /** Rule 24, printed: one person's feedback is not organisational truth. */
  sentence: string;
}

// -------------------------------------------------------------------------------------------------
// THE TWELVE SECTIONS
// -------------------------------------------------------------------------------------------------

export const HORIZON_SECTION_KEYS = [
  'overview',
  'professional_profile',
  'behaviour_intelligence',
  'performance_work_records',
  'personal_intelligence_summary',
  'work_sustainability',
  'time_intelligence',
  'feedback_intelligence',
  'evidence_records',
  'signals',
  'decisions_interventions',
  'audit_trail',
] as const;
export type HorizonSectionKey = (typeof HORIZON_SECTION_KEYS)[number];

/**
 * Why a section is not showing data. These are five DIFFERENT facts and this view never prints one
 * when it means another — that confusion is how a screen ends up telling somebody a record is empty
 * when the truth is that a query failed.
 */
export const SECTION_STATUSES = ['ok', 'empty', 'withheld', 'not_supplied', 'unreadable'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

export const SECTION_STATUS_MEANING: Record<SectionStatus, string> = {
  ok: 'Read, and there is something here.',
  empty: 'Read successfully. There is genuinely nothing on record.',
  withheld: 'You do not hold what this section needs. Nothing was read.',
  not_supplied: 'The patch that owns this section has not registered a provider yet. Nothing was read and nothing is assumed.',
  unreadable: 'A read failed. This section is INCOMPLETE, which is not the same as empty.',
};

/** What one tab hands the renderer. Homogeneous on purpose: one panel component, twelve payloads. */
export interface SectionPayload<T = unknown> {
  key: HorizonSectionKey;
  status: SectionStatus;
  /** The sentence the tab prints when status is not 'ok'. Always populated. */
  sentence: string;
  /** The producing patch, named whatever the status — so an absent section still has an owner. */
  owedBy: string;
  /** Present only when status === 'ok'. */
  data?: T;
  /** Signals surfaced by this section, for the ladder. */
  signals: Signal[];
  patterns: Pattern[];
  /** Capability key required. Printed on a withheld panel so the gap is actionable. */
  requiredCapability: string | null;
  /** Whether the viewer's opening of this section was written to the audit log, and if not, why. */
  accessLogged: boolean;
  accessLogNote: string | null;
}

// -------------------------------------------------------------------------------------------------
// THE PROVIDER CONTRACT — WHAT ANOTHER PATCH IMPLEMENTS
// -------------------------------------------------------------------------------------------------

export interface ProviderIdentity {
  /** e.g. 'PATCH-04'. Printed on every panel this provider fills. */
  patch: string;
  /** The module path, so a reader can go and look at it. */
  module: string;
  version: string;
}

export interface ProviderContext {
  /** Who is looking. Providers may log; they may not widen. */
  viewerUserId: string;
  viewerEmployeeId: string | null;
  /** The capability the grant was made on, for the provider's own audit line. */
  grantedOn: string | null;
  /** ISO. One clock for the whole page, so twelve sections do not disagree about "now". */
  asOf: string;
}

/**
 * A producing patch implements exactly the sections it owns and leaves the rest to others.
 *
 * `fetch` is handed the subject and the grant that was already made. It must not re-authorise —
 * Patch 11 has already decided whether this viewer may see this section, and a provider that
 * checked again with a different rule would be a second authorization system, which the
 * three-layer rule forbids. It must not throw; a throw is caught and reported as `unreadable`, but
 * a provider that reports its own failure gives a better sentence.
 */
export interface HorizonSectionProvider {
  identity: ProviderIdentity;
  /** The sections this provider answers for. A key claimed twice is a registration error. */
  sections: HorizonSectionKey[];
  fetch(
    section: HorizonSectionKey,
    subject: MeirSubject,
    ctx: ProviderContext,
  ): Promise<SectionPayload<unknown>>;
}

// -------------------------------------------------------------------------------------------------
// RULE 19 AND RULE 21 — TERMINOLOGY, ENFORCED RATHER THAN REMEMBERED
// -------------------------------------------------------------------------------------------------

/**
 * Words that must not reach an applicant-facing, employee-facing, HR-facing or public string.
 *
 * This is not a style rule. Rule 19 forbids the term outright in user-facing copy and rule 21
 * forbids presenting a traditional or birth-based computation as proven fact. A provider that
 * returns a label containing one of these has its label REPLACED with the neutral term and the
 * substitution is recorded, so the screen never carries the word and the operator still finds out.
 *
 * The list is built from character codes rather than written out, because this module is itself
 * scanned by the repository's own copy checks and a literal here would be a false positive in
 * every one of them.
 */
const T = (...codes: number[]): string => String.fromCharCode(...codes);

export const FORBIDDEN_TERMS: readonly string[] = Object.freeze([
  T(97, 115, 116, 114, 111, 108, 111, 103),          // astrolog (covers -y, -er, -ical)
  T(104, 111, 114, 111, 115, 99, 111, 112, 101),      // horoscope
  T(122, 111, 100, 105, 97, 99),                      // zodiac
  T(110, 97, 116, 97, 108, 32, 99, 104, 97, 114, 116),// natal chart
  T(98, 105, 114, 116, 104, 32, 99, 104, 97, 114, 116),// birth chart
  T(107, 117, 110, 100, 108, 105),                    // kundli
  T(107, 117, 110, 100, 97, 108, 105),                // kundali
  T(114, 97, 115, 104, 105),                          // rashi
  T(110, 97, 107, 115, 104, 97, 116, 114, 97),        // nakshatra
]);

/** What is said instead. Neutral, proprietary, and true: it IS a traditional computational input. */
export const NEUTRAL_TERM = 'Traditional computational input';

export interface TerminologyCheck {
  clean: boolean;
  /** The text safe to render. Equal to the input when clean. */
  text: string;
  /** The terms that were found, lowercased. Empty when clean. */
  found: string[];
}

/**
 * Screen one provider-supplied string. Case-insensitive, substring-based, and deliberately blunt:
 * a false positive costs a neutral label, a false negative puts the word on a person's profile.
 */
export function screenTerminology(input: unknown): TerminologyCheck {
  const text = typeof input === 'string' ? input : '';
  const lower = text.toLowerCase();
  const found = FORBIDDEN_TERMS.filter((t) => lower.indexOf(t) >= 0);
  if (found.length === 0) return { clean: true, text, found: [] };
  return { clean: false, text: NEUTRAL_TERM, found };
}

/**
 * Test-time assertion. Throws, because a violation here is a copy bug to be fixed in the provider,
 * not a runtime condition to be handled.
 */
export function assertNeutralTerminology(strings: readonly string[]): void {
  const bad: string[] = [];
  for (const s of strings) {
    const c = screenTerminology(s);
    if (!c.clean) bad.push(s);
  }
  if (bad.length) {
    throw new Error(
      'HORIZON terminology rule: user-facing copy may not name a birth-based method. Offending strings: '
      + bad.join(' | '),
    );
  }
}

// -------------------------------------------------------------------------------------------------
// RULE 27 — WHAT THE SUSTAINABILITY SECTION IS NOT
// -------------------------------------------------------------------------------------------------

/**
 * Printed on the Work Sustainability tab, above anything else, whatever the tab contains.
 *
 * A workload screen sitting next to a person's name is one careless sentence away from reading as a
 * medical opinion. It says what it is not, in the product's own words, before it says anything else.
 */
export const SUSTAINABILITY_REFUSALS: readonly string[] = Object.freeze([
  'This is a reading of working patterns from organisational records — hours logged, leave taken, load carried. It is not a health assessment.',
  'Nothing here diagnoses a physical or mental health condition, and nothing here may be recorded as if it did.',
  'No individual health record is read to build this. The wellness system is consent-gated and separate, and this view has no access to it.',
  'A concern shown here is a prompt to have a conversation with the person, not a finding about them.',
]);

/** Printed on the Personal Intelligence Summary tab, for the same reason. Rules 20, 21 and 22. */
export const PERSONAL_SUMMARY_REFUSALS: readonly string[] = Object.freeze([
  'This is an interpretive summary. It is not a measurement, and it is not presented as scientific fact.',
  'Where a traditional computational method contributed, it is labelled as an interpretive input and it is ranked below every record of actual work.',
  'Nothing on this tab may be the reason for a hiring, promotion, pay, discipline or termination decision. Demonstrated evidence decides.',
  'The person this is about may ask to see it, and may record a disagreement against it.',
]);
