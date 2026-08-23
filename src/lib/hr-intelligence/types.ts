// src/lib/hr-intelligence/types.ts — PATCH 13 (HR Intelligence View) CONTRACTS.
//
// =================================================================================================
// WHAT THIS PATCH IS
// =================================================================================================
//
// The HR desk opens one person and asks a different question from the one a manager asks and a
// different question from the one the founder asks. A manager asks "what is my team doing this
// week". The founder asks "show me everything, down to the row". HR asks:
//
//     WHERE IS THIS PERSON IN THEIR ROLE, WHAT DO THEY NEED, AND WHAT SHOULD I DO ABOUT IT.
//
// So this view is organised around ACTIONS, not around depth. Ten sections, each ending in
// something the HR desk can actually press: request feedback, start a development plan, assign
// training, schedule a review, record an intervention, open a mobility review. A section that
// cannot lead to an action belongs on somebody else's screen.
//
// =================================================================================================
// IT OWNS ALMOST NO SOURCE DATA, AND THAT IS DELIBERATE
// =================================================================================================
//
// Every fact rendered here is read from the module that already owns it:
//
//   hr_employees                  the people desk                  employment and current role
//   hr_performance_reviews        src/lib/performance.ts           outcomes, ratings, calibration
//   hr_feedback                   src/lib/performance.ts           manager and peer feedback
//   hr_employee_skills            src/lib/skills.ts                THE LEVEL OF RECORD. Never written here.
//   capability_claims             src/lib/evidence-graph.ts        what the evidence actually supports
//   hr_learning_assignments       src/lib/performance-learning.ts  assigned learning
//   hr_employee_goals             src/lib/goals.ts                 objectives
//   employee_tasks                src/lib/employee-tasks.ts        delivered work
//   hr_events                     src/lib/hr-events.ts             the organisational timeline
//   roles                         the hiring desk                  open positions, for mobility
//   ai_recommendations            src/lib/ai-boundary.ts           what a machine concluded
//   ai_human_decisions            src/lib/ai-boundary.ts           what a human decided
//
// This patch owns SIX tables, and each one holds AN ACT BY THE HR DESK that nothing else records:
//
//   hri_development_plans     a plan HR opened
//   hri_plan_items            the gaps that plan is about
//   hri_interventions         a support step HR took, and what followed
//   hri_feedback_requests     a request HR sent for feedback that has not arrived yet
//   hri_mobility_reviews      a role-mobility review HR opened
//   hri_access_log            who opened this view, on whom, at what depth, and why
//
// It creates NO table for a skill, a rating, a review, a course or a promotion. Those exist.
//
// =================================================================================================
// THE ENVELOPE
// =================================================================================================
//
//     INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
//
// HrSignal is that envelope as a type, and hrSignal() cannot construct one without filling every
// field. A quantitative figure with no rows behind it and no input recording that anything was read
// becomes an `absent` value whose display IS the reason. A screen cannot print a number that means
// "we did not look", because there is no way to build one.
//
// The shape is deliberately field-for-field compatible with the founder view's Signal
// (src/lib/founder-intel/types.ts) and the manager view's ManagerSignal
// (src/lib/manager-intelligence/types.ts) without importing either. Three patches were written in
// parallel; a shared base edited by three agents at once is how one agent's rename becomes another
// agent's outage. Same vocabulary, separate declaration, and `toPortableSignal()` at the bottom is
// the seam if these are ever unified by a human who can see all three at once.
//
// =================================================================================================
// THE DEPTH BOUNDARY — THE ONE RULE THAT IS SPECIFIC TO THIS PATCH
// =================================================================================================
//
// "HR must see actionable intelligence but not automatically receive all deep foundational
// computation details."
//
// AUTOMATICALLY is the operative word, and it is enforced by IntelligenceDepth. The HR desk key
// resolves to `actionable` and nothing else. Foundational computation detail is a SEPARATE
// capability, and holding it is still not enough on its own: the read must also name a purpose, and
// the subject must have given consent that is on record and unexpired.
//
// A withheld section is NAMED as withheld and its query is never issued. That is the precedent
// twinAccess() already set in digital-twin.ts: an ungranted aspect is ABSENT from the object rather
// than fetched and then hidden, so there is no code path where the value existed in memory on a
// screen that was not allowed to have it.
//
// The foundational layer itself is NOT IMPLEMENTED HERE. It is reached through the
// FoundationalProvider interface below, which reports `no_provider` when nothing is registered —
// which is the state this platform ships in. Patch 12 owns those sections. This patch owns the
// boundary, not what is on the other side of it.
//
// =================================================================================================
// WHAT MAY NEVER REACH THIS SCREEN
// =================================================================================================
//
// ADMISSIBLE_SOURCES is a closed list checked at construction. A signal whose source is not on it
// throws where it is built. Absent from the list, and unaddable by a caller:
//
//   wellness_*            women-only, gated server-side, aggregate-only. No admin and not the
//                         founder may see one person's cycle, symptoms or consult messages, and
//                         this module contains no import of it.
//   hr_clock_events       latitude, longitude, IP, device string, a selfie per punch. A person may
//                         see their own trail. HR reading everybody's is surveillance.
//   leave reason text     the free-text reason on a leave request is frequently a medical fact.
//   base_salary, bank_*, date_of_birth, gender, blood_group, pan_number, aadhaar_number
//                         none of them is capability, and a compensation figure beside a
//                         development plan turns a support conversation into a pay conversation.
//   anything birth-based or trait-inferred, which reaches HR only through the depth boundary above.

// =================================================================================================
// SECTIONS
// =================================================================================================

/** The ten sections of the HR view, in render order. */
export const SECTION_KEYS = [
  'role_status',
  'development_needs',
  'skill_gaps',
  'training',
  'feedback',
  'behaviour_trends',
  'promotion_readiness',
  'mobility',
  'interventions',
  'org_development',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export function isSectionKey(v: unknown): v is SectionKey {
  return typeof v === 'string' && (SECTION_KEYS as readonly string[]).indexOf(v) >= 0;
}

/**
 * Plain words for a heading, from a FUNCTION and not an exported `Record<string, string>`.
 * A typed map read inside .astro JSX is a known parse hazard on this project, and every consumer
 * of this module renders in an .astro file.
 */
export function sectionLabel(key: string): string {
  const k = String(key || '');
  if (k === 'role_status') return 'Current role status';
  if (k === 'development_needs') return 'Development needs';
  if (k === 'skill_gaps') return 'Skill gaps';
  if (k === 'training') return 'Training recommendations';
  if (k === 'feedback') return 'Manager and peer feedback';
  if (k === 'behaviour_trends') return 'Behaviour trends';
  if (k === 'promotion_readiness') return 'Promotion readiness';
  if (k === 'mobility') return 'Internal mobility';
  if (k === 'interventions') return 'Intervention history';
  if (k === 'org_development') return 'Organisational development actions';
  return 'Section';
}

/** One sentence under the heading, so a reader knows what they are looking at before they read it. */
export function sectionSubtitle(key: string): string {
  const k = String(key || '');
  if (k === 'role_status') return 'The role, the terms and the stage of employment, as the people desk holds them.';
  if (k === 'development_needs') return 'Where the record says support would help, and what each one was read from.';
  if (k === 'skill_gaps') return 'The role requirements, one at a time, against what there is evidence for. No overall score.';
  if (k === 'training') return 'Courses that address a named gap. A suggestion, never an enrolment.';
  if (k === 'feedback') return 'Every note on record, with its author, and where the authors disagree.';
  if (k === 'behaviour_trends') return 'Organisational records over time. No monitoring, no location, no device data.';
  if (k === 'promotion_readiness') return 'Named conditions, each with its own evidence. There is no readiness score and this decides nothing.';
  if (k === 'mobility') return 'Open roles the evidence already on record would cover, requirement by requirement.';
  if (k === 'interventions') return 'Support steps taken, who took them, and what was recorded afterwards.';
  if (k === 'org_development') return 'Actions at the level of a team or a role, not one person.';
  return '';
}

// =================================================================================================
// DEPTH — WHAT HR GETS AUTOMATICALLY, AND WHAT IT DOES NOT
// =================================================================================================

/**
 *   actionable    what the HR desk sees by holding the HR desk key. Signals, the evidence rows
 *                 behind them, confidence, and the actions each one leads to. This is the whole
 *                 view for almost everybody who will ever open it.
 *
 *   foundational  the deep computation detail underneath a derived statement, including any
 *                 traditional computational method a registered provider supplies. NOT reachable by
 *                 holding the HR desk key. Needs its own capability, a named purpose, and the
 *                 subject's recorded unexpired consent — all three, checked separately.
 */
export const DEPTHS = ['actionable', 'foundational'] as const;
export type IntelligenceDepth = (typeof DEPTHS)[number];

export function depthLabel(v: string): string {
  const k = String(v || '');
  if (k === 'actionable') return 'Actionable intelligence';
  if (k === 'foundational') return 'Foundational computation detail';
  return 'Unknown depth';
}

/** Printed verbatim on the screen wherever the deeper tier is withheld. */
export const FOUNDATIONAL_WITHHELD_SENTENCE =
  'Foundational computation detail is not part of the HR view. It needs a separate permission, a '
  + 'recorded purpose and this person\'s consent on record, checked independently of one another. '
  + 'It is not hidden behind a toggle here: the queries that would carry it were never issued.';

// =================================================================================================
// EVIDENCE STRENGTH — RULE 22 AS ARITHMETIC
// =================================================================================================

/**
 *   demonstrated  the person did the work and this platform recorded it as it happened, or a named
 *                 human verified it against something. The strongest thing this system holds.
 *   stated        a human wrote it down about them, or about themselves. Somebody's account,
 *                 recorded honestly as somebody's account.
 *   derived       this module worked it out by counting the two above. Advisory, always.
 *
 * There is no fourth value, and in particular none for anything birth-based or trait-inferred: such
 * a thing cannot be given a strength here because it cannot be a signal here.
 */
export const EVIDENCE_STRENGTHS = ['demonstrated', 'stated', 'derived'] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export function decisionWeight(strength: string): number {
  const k = String(strength || '');
  if (k === 'demonstrated') return 3;
  if (k === 'stated') return 2;
  if (k === 'derived') return 1;
  return 0;
}

export function outranks(a: string, b: string): boolean {
  return decisionWeight(a) > decisionWeight(b);
}

export function evidenceStrengthLabel(strength: string): string {
  const k = String(strength || '');
  if (k === 'demonstrated') return 'Demonstrated work';
  if (k === 'stated') return 'Stated by a person';
  if (k === 'derived') return 'Worked out from records';
  return 'Unknown';
}

// =================================================================================================
// ASSERTION — REUSING THE DIGITAL TWIN VOCABULARY RATHER THAN INVENTING A SECOND ONE
// =================================================================================================

export const ASSERTIONS = ['verified', 'factual', 'provided', 'calculated', 'inferred'] as const;
export type Assertion = (typeof ASSERTIONS)[number];

export function assertionLabel(a: string): string {
  const k = String(a || '');
  if (k === 'verified') return 'Verified by a named human';
  if (k === 'factual') return 'Recorded by this platform';
  if (k === 'provided') return 'Stated by a named human';
  if (k === 'calculated') return 'Calculated here';
  if (k === 'inferred') return 'Inferred';
  return 'Unknown';
}

export function assertionWeight(a: string): number {
  const k = String(a || '');
  if (k === 'verified') return 5;
  if (k === 'factual') return 4;
  if (k === 'provided') return 3;
  if (k === 'calculated') return 2;
  if (k === 'inferred') return 1;
  return 0;
}

/** An assertion maps onto exactly one evidence strength, and the mapping is not a matter of taste. */
export function strengthOfAssertion(a: string): EvidenceStrength {
  const k = String(a || '');
  if (k === 'verified' || k === 'factual') return 'demonstrated';
  if (k === 'provided') return 'stated';
  return 'derived';
}

// =================================================================================================
// ADMISSIBLE SOURCES — A CLOSED LIST, CHECKED AT CONSTRUCTION
// =================================================================================================

/**
 * The only systems of record an HR signal may be read out of. Every one is an ordinary
 * organisational record the person themselves can already see on their own portal.
 *
 * See the header for what is deliberately absent and why. A caller cannot extend this list: the
 * check in hrSignal() is on the value, and an unlisted table throws where the signal is built
 * rather than rendering with a plausible label.
 */
export const ADMISSIBLE_SOURCES = [
  'hr_employees',
  'hr_performance_reviews',
  'hr_review_cycles',
  'hr_feedback',
  'hr_employee_skills',
  'hr_skills',
  'hr_employee_goals',
  'hr_learning_assignments',
  'hr_training_events',
  'hr_training_signups',
  'hr_events',
  'employee_tasks',
  'capability_claims',
  'capability_evidence',
  'roles',
  'ai_recommendations',
  'ai_human_decisions',
  'hri_development_plans',
  'hri_plan_items',
  'hri_interventions',
  'hri_feedback_requests',
  'hri_mobility_reviews',
] as const;

export type AdmissibleSource = (typeof ADMISSIBLE_SOURCES)[number];

export function isAdmissibleSource(v: unknown): v is AdmissibleSource {
  return typeof v === 'string' && (ADMISSIBLE_SOURCES as readonly string[]).indexOf(v) >= 0;
}

/**
 * Named so a refusal can say what it refused and why, rather than "invalid source".
 * The value is the sentence a developer sees the moment they try.
 */
export function refuseSource(table: string): string | null {
  if (isAdmissibleSource(table)) return null;
  return 'Source "' + String(table) + '" is not on the admissible list for the HR intelligence view. '
    + 'Adding it is a policy decision about what HR may read about a person, not a code change: it '
    + 'belongs in ADMISSIBLE_SOURCES with a note saying who decided and when.';
}

// =================================================================================================
// THE PARTS OF THE ENVELOPE
// =================================================================================================

export type SignalValueKind = 'count' | 'duration' | 'ratio' | 'band' | 'text' | 'absent';

export interface SignalValue {
  kind: SignalValueKind;
  /** The number, when there is one. Null for text, band and absent. */
  number: number | null;
  /** What the number counts: 'reviews', 'days', 'notes'. Never a bare unit-less score. */
  unit: string | null;
  /** What a reader sees. For `absent` this is the reason, in a sentence. */
  display: string;
}

export const BANDS = ['unknown', 'low', 'moderate', 'elevated', 'high'] as const;
export type Band = (typeof BANDS)[number];

export interface SignalInput {
  /** The module that OWNS this fact. Never the module that happens to be reading it. */
  ownerModule: string;
  /** The table the rows came from. Must be on ADMISSIBLE_SOURCES. */
  table: string;
  /** How many rows were read. Zero is a legitimate, printable answer. */
  rowsRead: number;
  from?: string | null;
  to?: string | null;
  /** Set when the read FAILED. An empty result from a failed query is never printed as "none". */
  unreadable?: string | null;
}

export interface EvidenceRef {
  /** The row, as `${table}:${id}`. */
  recordId: string;
  table: string;
  ownerModule: string;
  /** What the row says, in one line. */
  summary: string;
  /** A named human, or the platform itself. Never "the system" when a person is on record. */
  providedBy: string;
  providedByUserId?: string | null;
  assertion: Assertion;
  /** When the thing happened, not when it was read. */
  occurredAt: string | null;
  /** The screen that OWNS this record, so HR lands where the action is. */
  href?: string | null;
}

export const CONFIDENCE_LEVELS = ['none', 'low', 'moderate', 'high'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface Confidence {
  level: ConfidenceLevel;
  /** Why it is that and not higher. Always a sentence; 'high' still has to justify itself. */
  why: string;
}

export type DecisionUse = 'not_a_decision_input' | 'advisory' | 'supporting';

export function decisionUseSentence(v: string): string {
  const k = String(v || '');
  if (k === 'not_a_decision_input') {
    return 'Context only. This is not an input to any decision about this person.';
  }
  if (k === 'supporting') {
    return 'Supporting evidence for a decision a named human makes and records elsewhere.';
  }
  return 'Advisory. A human may consider it; it decides nothing on its own and carries less weight '
    + 'than work this person demonstrably did.';
}

// =================================================================================================
// THE SIGNAL
// =================================================================================================

export interface HrSignal {
  /** Stable and addressable: the drill-down is read off this object, not recomputed. */
  id: string;
  section: SectionKey;
  label: string;
  value: SignalValue;
  /** The rule, written down, in words a reader can check against the rows. */
  processing: string;
  inputs: SignalInput[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  /** The strongest thing behind this signal. Sorted on, and checked before an action may cite it. */
  strength: EvidenceStrength;
  decisionUse: DecisionUse;
  /** Which HR actions this signal can lead to. May be empty; most sections have one. */
  actions: HrActionKind[];
  computedAt: string;
  observedFrom: string | null;
  observedTo: string | null;
  /** Set when a source could not be READ. Distinct from "nothing on record". */
  unreadable: string | null;
}

export interface SignalDraft {
  id: string;
  section: SectionKey;
  label: string;
  value: SignalValue;
  processing: string;
  inputs?: SignalInput[];
  evidence?: EvidenceRef[];
  confidence?: Confidence;
  decisionUse?: DecisionUse;
  actions?: HrActionKind[];
  computedAt?: string;
  observedFrom?: string | null;
  observedTo?: string | null;
  unreadable?: string | null;
}

/** Value kinds that assert a measured quantity, and therefore must be able to point at rows. */
const QUANTITATIVE: SignalValueKind[] = ['count', 'duration', 'ratio', 'band'];

/**
 * Build a signal, or build the refusal to show one.
 *
 * THREE THINGS THIS REFUSES, all at construction, none of them recoverable by a caller:
 *
 *   1. AN INADMISSIBLE SOURCE. Throws. Not a soft failure: a signal reading a table nobody decided
 *      HR may read is a policy breach wearing a chart, and it should break the build rather than
 *      the trust.
 *
 *   2. A FIGURE NOTHING SUPPORTS. A quantitative value with no evidence rows AND no readable input
 *      becomes `absent`, and its display is the explanation. `rowsRead: 0` across readable inputs is
 *      NOT this case — that is a real finding, and it keeps its number, because the inputs prove the
 *      question was asked.
 *
 *   3. A FIGURE FROM A FAILED READ. If any input carries `unreadable`, the value is replaced by the
 *      reason. An empty answer produced by a failed query is a lie about a person.
 */
export function hrSignal(d: SignalDraft): HrSignal {
  const inputs = d.inputs ?? [];
  const evidence = d.evidence ?? [];

  for (const i of inputs) {
    const refusal = refuseSource(i.table);
    if (refusal) throw new Error(refusal);
  }
  for (const e of evidence) {
    const refusal = refuseSource(e.table);
    if (refusal) throw new Error(refusal);
  }

  const looked = inputs.length > 0 && inputs.every((i) => !i.unreadable);
  const unreadableInput = inputs.find((i) => i.unreadable);
  const quantitative = QUANTITATIVE.indexOf(d.value.kind) >= 0;

  let value = d.value;
  let unreadable = d.unreadable ?? null;

  if (!unreadable && unreadableInput) {
    unreadable = unreadableInput.unreadable || 'A source could not be read.';
  }

  if (unreadable) {
    value = {
      kind: 'absent',
      number: null,
      unit: null,
      display: 'Not shown: ' + unreadable
        + ' An empty answer produced by a failed read would be a lie about this person.',
    };
  } else if (quantitative && evidence.length === 0 && !looked) {
    value = {
      kind: 'absent',
      number: null,
      unit: null,
      display: 'Not shown: nothing on record supports this figure, and no source was recorded as '
        + 'having been read.',
    };
  }

  const confidence = value.kind === 'absent'
    ? { level: 'none' as ConfidenceLevel, why: 'There is no figure to be confident about.' }
    : (d.confidence ?? confidenceFrom(evidence, inputs));

  return {
    id: d.id,
    section: d.section,
    label: d.label,
    value,
    processing: d.processing,
    inputs,
    evidence,
    confidence,
    strength: strengthFrom(evidence),
    decisionUse: d.decisionUse ?? 'advisory',
    actions: d.actions ?? [],
    computedAt: d.computedAt ?? new Date().toISOString(),
    observedFrom: d.observedFrom ?? null,
    observedTo: d.observedTo ?? null,
    unreadable,
  };
}

/**
 * The strength of a signal is the strength of the STRONGEST thing behind it, and a signal with
 * nothing behind it is derived. A caller cannot pass this in — that is the point of rule 22 being
 * arithmetic rather than a label.
 */
export function strengthFrom(evidence: readonly EvidenceRef[]): EvidenceStrength {
  let best: EvidenceStrength = 'derived';
  for (const e of evidence) {
    const s = strengthOfAssertion(e.assertion);
    if (outranks(s, best)) best = s;
  }
  return best;
}

/**
 * Confidence from what is actually behind the figure, never from how the figure looks.
 *
 * ONE PERSON STATING SOMETHING IS NOT AGREEMENT, and this is where rule 24 is enforced for every
 * section at once: a single stated row cannot reach 'high' however emphatic it is, because
 * `distinctAuthors` is counted and one author caps the answer.
 */
export function confidenceFrom(
  evidence: readonly EvidenceRef[],
  inputs: readonly SignalInput[],
): Confidence {
  if (inputs.some((i) => i.unreadable)) {
    return { level: 'none', why: 'At least one source could not be read.' };
  }
  if (evidence.length === 0) {
    return {
      level: 'low',
      why: 'The sources were read and hold nothing for this person. The absence is the finding.',
    };
  }
  const verified = evidence.filter((e) => e.assertion === 'verified').length;
  const factual = evidence.filter((e) => e.assertion === 'factual').length;
  const derived = evidence.filter((e) => e.assertion === 'calculated' || e.assertion === 'inferred').length;
  const distinctAuthors = new Set(evidence.map((e) => e.providedByUserId || e.providedBy)).size;

  if (verified >= 2 || (verified >= 1 && factual >= 2)) {
    return {
      level: 'high',
      why: verified + ' verified record(s) and ' + factual + ' platform record(s), from '
        + distinctAuthors + ' distinct source(s).',
    };
  }
  if (verified >= 1 || factual >= 2) {
    return {
      level: 'moderate',
      why: 'Supported by records this platform owns, but not by two independent verifications.',
    };
  }
  if (derived === evidence.length) {
    return {
      level: 'low',
      why: 'Everything behind this figure was derived here. Nothing external confirms it.',
    };
  }
  return {
    level: 'low',
    why: distinctAuthors === 1
      ? 'One source. One person stating something is not agreement.'
      : 'Stated rather than demonstrated.',
  };
}

/** Higher sorts first. Demonstrated work is above anything this system worked out for itself. */
export function weightOf(s: HrSignal): number {
  if (s.value.kind === 'absent') return -1;
  const best = s.evidence.reduce((m, e) => Math.max(m, assertionWeight(e.assertion)), 0);
  const conf = CONFIDENCE_LEVELS.indexOf(s.confidence.level);
  return best * 10 + conf;
}

export function sortByWeight(list: readonly HrSignal[]): HrSignal[] {
  return [...list].sort((a, b) => weightOf(b) - weightOf(a));
}

/**
 * A screen may render a signal only when this is true. The gate lives here so no screen has to
 * remember it, and so a future section cannot quietly ship a figure with nothing behind it.
 */
export function isRenderable(s: HrSignal): boolean {
  if (s.value.kind === 'absent') return true; // the refusal renders; the figure does not
  return s.evidence.length > 0 || s.inputs.some((i) => !i.unreadable);
}

// =================================================================================================
// SECTION STATE
// =================================================================================================

export const SECTION_STATES = [
  'ready',
  'empty',
  'unreadable',
  'not_permitted',
  'no_provider',
  'no_consent',
] as const;

export type SectionState = (typeof SECTION_STATES)[number];

export interface HrSection {
  key: SectionKey;
  label: string;
  subtitle: string;
  state: SectionState;
  /** Why the state is what it is. Printed verbatim; a blank section always says something. */
  sentence: string;
  signals: HrSignal[];
  /** The actions this section offers, already filtered by what the viewer may actually do. */
  actions: HrActionKind[];
}

// =================================================================================================
// THE HR ACTIONS
// =================================================================================================

/**
 * Six acts, and every one of them ends in a row somebody's name is on.
 *
 * THREE ARE DELEGATED, not reimplemented. `assign_training` calls
 * performance-learning.assignCourse(); `schedule_review` writes through the training calendar that
 * same module owns; `request_feedback` records the REQUEST here and the feedback itself lands in
 * hr_feedback through performance.giveFeedback(). This patch does not own a second copy of any of
 * them, and actions.ts imports the owner rather than writing the owner's table.
 *
 * THREE ARE OWNED, because nothing else records them: a development plan HR opened, a support
 * intervention HR made, and a role-mobility review HR started.
 */
export const HR_ACTION_KINDS = [
  'request_feedback',
  'initiate_development_plan',
  'assign_training',
  'schedule_review',
  'record_intervention',
  'initiate_mobility_review',
] as const;

export type HrActionKind = (typeof HR_ACTION_KINDS)[number];

export function isHrActionKind(v: unknown): v is HrActionKind {
  return typeof v === 'string' && (HR_ACTION_KINDS as readonly string[]).indexOf(v) >= 0;
}

export function actionLabel(kind: string): string {
  const k = String(kind || '');
  if (k === 'request_feedback') return 'Request feedback';
  if (k === 'initiate_development_plan') return 'Start a development plan';
  if (k === 'assign_training') return 'Assign training';
  if (k === 'schedule_review') return 'Schedule a review';
  if (k === 'record_intervention') return 'Record an intervention';
  if (k === 'initiate_mobility_review') return 'Open a mobility review';
  return 'Action';
}

/** What pressing it actually does, said before it is pressed. */
export function actionEffect(kind: string): string {
  const k = String(kind || '');
  if (k === 'request_feedback') {
    return 'Records that you asked a named person for feedback on this employee, and why. It does '
      + 'not write feedback and it does not notify anybody automatically.';
  }
  if (k === 'initiate_development_plan') {
    return 'Opens a development plan with the gaps you selected as its items. A plan is a shared '
      + 'record between the employee, whoever answers for their work, and the people desk.';
  }
  if (k === 'assign_training') {
    return 'Assigns a course through the learning module, which owns assignments. The employee sees '
      + 'it on their own learning path with the reason you give here.';
  }
  if (k === 'schedule_review') {
    return 'Puts a review on the training calendar with a date and the reason for it. It does not '
      + 'open an appraisal cycle, which is a separate act by whoever runs appraisals.';
  }
  if (k === 'record_intervention') {
    return 'Records a support step you took, what prompted it, and leaves a place for what followed. '
      + 'It changes nothing on the employment record and starts no disciplinary process.';
  }
  if (k === 'initiate_mobility_review') {
    return 'Opens a review of this person against one open role. It moves nobody, notifies nobody, '
      + 'and reaches no conclusion by itself.';
  }
  return '';
}

/**
 * WHAT NO ACTION HERE DOES. Printed on the action rail, because a list of buttons on an
 * intelligence screen is exactly where somebody assumes one of them is the promote button.
 */
export const ACTIONS_DECIDE_NOTHING =
  'None of these changes this person\'s employment, pay, designation or standing. Hiring, '
  + 'rejection, promotion, termination, compensation and discipline are decided by a named human '
  + 'and recorded by the module that owns each one. Nothing on this screen can reach them.';

// =================================================================================================
// THE FOUNDATIONAL COMPUTATION PROVIDER — AN INTERFACE, AND NO IMPLEMENTATION
// =================================================================================================

/**
 * Patch 12 renders a foundational computation section and a professional interpretation section.
 * This patch neither implements nor imports either: it declares the shape it would consume IF a
 * provider is ever registered, so that the HR view has a boundary to enforce rather than a hole.
 *
 * FOUR RULES ARE CARRIED BY THE TYPE ITSELF, so a provider cannot be written that breaks them:
 *
 *   - `interpretation` and `computation` are SEPARATE FIELDS. The traditional computational method,
 *     if one is ever implemented, is kept apart from the professional interpretation layer that
 *     reads it. They cannot be returned as one blob.
 *   - `notScientificFact` is required and may only be true.
 *   - `subordinateTo` is required and names the demonstrated evidence that outranks this. A
 *     provider that cannot name what outranks it cannot be rendered.
 *   - `consentRecordId` is required. No consent row, no read.
 *
 * TERMINOLOGY. Nothing produced by a provider may be described to an applicant, an employee, an HR
 * user or the public in the vocabulary of divination. The neutral term this platform uses is
 * "foundational computation", and it appears in exactly that form on every surface.
 */
export interface FoundationalReading {
  providerId: string;
  /** The computation, kept apart from what anybody made of it. */
  computation: { label: string; detail: string }[];
  /** What a professional interpreted from it. A separate layer, and it says so. */
  interpretation: { label: string; detail: string }[];
  /** May only ever be true. A provider returning anything else is refused by the reader. */
  notScientificFact: true;
  /** The demonstrated evidence that outweighs this, named. Empty is a refusal, not a reading. */
  subordinateTo: string[];
  /** The consent row that permitted this read. Required. */
  consentRecordId: string;
  computedAt: string;
}

export type FoundationalResult =
  | { state: 'no_provider'; sentence: string }
  | { state: 'no_consent'; sentence: string }
  | { state: 'not_permitted'; sentence: string }
  | { state: 'ready'; reading: FoundationalReading };

export interface FoundationalProvider {
  id: string;
  /** Human-readable, and in neutral terminology. Checked by registerFoundationalProvider(). */
  label: string;
  read(input: { employeeId: string; purpose: string; consentRecordId: string }): Promise<FoundationalResult>;
}

let PROVIDER: FoundationalProvider | null = null;

/**
 * Register the one provider. There is no provider on this platform and this function has no caller
 * — it exists so that the HR view's boundary is enforced against a real seam rather than an
 * imagined one, and so whoever writes Patch 12's provider has somewhere to plug in that is already
 * gated.
 *
 * IT REFUSES A PROVIDER WHOSE LABEL USES THE VOCABULARY OF DIVINATION, by name, at registration.
 * The terminology rule is not a copy guideline a future label can quietly miss; it is a check.
 */
export function registerFoundationalProvider(p: FoundationalProvider): { ok: boolean; error: string | null } {
  const banned = ['astrolog', 'horoscope', 'zodiac', 'natal', 'birth chart', 'kundli', 'kundali', 'jyotish'];
  const label = String(p?.label || '').toLowerCase();
  const hit = banned.find((b) => label.indexOf(b) >= 0);
  if (hit) {
    return {
      ok: false,
      error: 'This provider\'s label uses the word "' + hit + '", which does not appear on any '
        + 'applicant-facing, employee-facing, HR-facing or public surface of this platform. The '
        + 'neutral term is "foundational computation". Rename the provider.',
    };
  }
  if (!p || typeof p.read !== 'function' || !p.id) {
    return { ok: false, error: 'A provider needs an id and a read().' };
  }
  PROVIDER = p;
  return { ok: true, error: null };
}

export function foundationalProvider(): FoundationalProvider | null {
  return PROVIDER;
}

/** Exported for the test that proves the platform ships with no provider registered. */
export function clearFoundationalProvider(): void {
  PROVIDER = null;
}

// =================================================================================================
// THE SEAM, IF THESE THREE VIEWS ARE EVER UNIFIED
// =================================================================================================

/**
 * The founder view and the manager view carry the same six fields under the same names. This
 * returns the intersection, so a future human unifying the three patches has one function to point
 * at rather than three type declarations to diff.
 *
 * Nothing in this patch calls it. It is a note in the form of code.
 */
export function toPortableSignal(s: HrSignal): {
  id: string;
  label: string;
  value: SignalValue;
  processing: string;
  inputs: SignalInput[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  computedAt: string;
} {
  return {
    id: s.id,
    label: s.label,
    value: s.value,
    processing: s.processing,
    inputs: s.inputs,
    evidence: s.evidence,
    confidence: s.confidence,
    computedAt: s.computedAt,
  };
}
