// src/lib/behaviour/types.ts — PATCH 04, Psycho-Behavioural Intelligence: THE OWNED CONTRACT.
//
// Every other patch reads these shapes. They are extended ADDITIVELY and never renamed: PATCH 05
// (manager feedback) consumes BehaviouralProfile, and a field it reads under a different name is a
// silent empty column on somebody's record rather than a compile error.
//
// =================================================================================================
// WHAT THIS LAYER IS, AND THE THREE THINGS IT REFUSES TO BE
// =================================================================================================
//
// It reads WORK RECORDS THE ORGANISATION ALREADY KEEPS — task transitions in `audit_log`, the task
// rows themselves, assessment attempts — and states, with the rows attached, how somebody's working
// behaviour has moved over a named period. That is all.
//
//   1. IT IS NOT PRODUCTIVITY. Nothing here counts keystrokes, hours, logins, sessions or presence,
//      and no field sums these metrics into one number. `NOT_PRODUCTIVITY` says so on every profile
//      because a figure with a person's name on it gets read as a verdict no matter what the
//      surrounding page claims, and there is no honest way to compute "how much value did this
//      person add" from a task board. Metrics stay separate, named, and bounded to what the row says.
//
//   2. IT IS NOT A DECISION. `decisionUse` is the constant 'advisory_only' and there is no other
//      value. No function in this patch returns a rank, a percentile against colleagues, a
//      recommendation to promote, retain, discipline or exit, or a flag that a workflow could
//      branch on to do any of those. A human reads this, disagrees with it where they disagree, and
//      decides. PATCH 05 records what they said; PATCH 04 never learns from it in a way that closes
//      the loop without them.
//
//   3. IT IS NOT A DIAGNOSIS. No field describes a person's state of mind, temperament, wellbeing,
//      motivation or health, and none may be added. "Submissions moved later over the last month,
//      across 14 tasks" is a fact about rows. "Disengaged" is a clinical-sounding claim about a
//      human being that these inputs cannot support. Metric labels stay in the vocabulary of the
//      record.
//
// =================================================================================================
// THE FIVE LAYERS, NEVER COLLAPSED (shared core principle, and the reason for so many small types)
// =================================================================================================
//
//   a) RAW SOURCE DATA        EvidenceRef — a table, a row id, a field, a timestamp, and the words
//                             the row actually carried. Never a paraphrase.
//   b) DERIVED / COMPUTED     BehaviouralObservation, MetricValue. Arithmetic over (a). Reproducible
//                             from the evidence alone; no judgement in it.
//   c) INTERPRETATION         TrendVerdict, PatternVerdict, Confidence. This is where the system
//                             says something that could be wrong, so each one carries what it read,
//                             how many rows that was, and what it could not tell.
//   d) HUMAN FEEDBACK         NOT IN THIS PATCH. PATCH 05 owns it. Nothing here accepts, stores or
//                             weights an opinion — see the note on ProfileRequest in profile.ts.
//   e) HUMAN DECISION         NOT IN THIS PATCH, and not in any patch that reads it without a named
//                             human attached.
//
// A caller must be able to tell which layer a value came from without reading this file. That is why
// `MetricValue.value` and `BehaviourTrend.verdict` are different types on different objects rather
// than two fields on one flat record.

/** Stamped on every profile. There is no second value; it is a constant so it cannot be negotiated. */
export const DECISION_USE = 'advisory_only' as const;

/** Printed beside any rendering of this data. PATCH 05 and any UI patch must show it verbatim. */
export const NOT_PRODUCTIVITY =
  'These are patterns in recorded work events, not a measure of productivity, value or effort. ' +
  'They describe what the records show and nothing about the person behind them. ' +
  'A human decides; this decides nothing.';

// -------------------------------------------------------------------------------------------------
// (a) RAW SOURCE DATA
// -------------------------------------------------------------------------------------------------

/** The tables this patch may read. A source outside this union is a code change, reviewed. */
export type BehaviourSourceTable = 'audit_log' | 'employee_tasks' | 'edu_attempts';

/**
 * ONE ROW, NAMED, SO A CONCLUSION CAN BE WALKED BACK TO IT.
 *
 * `statement` is the row's own words, trimmed — 'status assigned to accepted', 'due 2026-08-14,
 * completed 2026-08-19'. It is never a summary and never an interpretation, because the whole
 * purpose of this object is to let a human check the machine, and a paraphrase is the machine
 * checking itself.
 */
export interface EvidenceRef {
  sourceTable: BehaviourSourceTable;
  /** Primary key of the row. Text, never cast — ids are UUID in one schema file and slug in another. */
  sourceId: string;
  /** Which column or JSON path carried the fact. 'diff.to', 'completed_at', 'submitted_at'. */
  sourceField: string;
  /** When the recorded event happened, per the row. ISO 8601, UTC. */
  occurredAt: string;
  /** What the row says. Verbatim, trimmed, capped. */
  statement: string;
  /**
   * How this reached the system. One value today, and it is stated rather than assumed: this patch
   * reads authorised organisational records only. There is no observation channel here — no
   * screenshots, no keystrokes, no location, no message content, nothing collected covertly.
   */
  collectedVia: 'authorised_system_record';
  /** The work item the row belongs to, so evidence from one task groups on a screen. */
  workRef?: { table: string; id: string } | null;
}

// -------------------------------------------------------------------------------------------------
// (b) DERIVED — OBSERVATIONS
// -------------------------------------------------------------------------------------------------

/**
 * THE BEHAVIOURAL VOCABULARY. Each value names an event the records genuinely contain.
 *
 * There is deliberately no 'task.late' and no 'task.ignored': lateness is computed from two
 * timestamps and belongs to the metric layer, while "ignored" is a motive, and motives are not in
 * the table. Adding a judgement-shaped kind here is how interpretation leaks into layer (b).
 */
export const BEHAVIOUR_SIGNAL_KINDS = [
  'task.assigned',
  'task.accepted',
  'task.first_response',
  'task.progress',
  'task.blocked',
  'task.unblocked',
  'task.submitted',
  'task.returned',
  'task.approved',
  'task.completed',
  'task.cancelled',
  'task.project_linked',
  'assessment.started',
  'assessment.submitted',
] as const;

export type BehaviourSignalKind = (typeof BEHAVIOUR_SIGNAL_KINDS)[number];

/**
 * COMPLEXITY, WHERE AVAILABLE — AND `null` IS A REAL ANSWER.
 *
 * The only complexity proxy the records carry is `employee_tasks.priority`, which is what the
 * ASSIGNER thought when they typed it, not a measurement. It is used to segment (compare like with
 * like) and never as a multiplier: multiplying a metric by a priority somebody chose from a dropdown
 * manufactures precision the input never had.
 */
export type BehaviourComplexity = 'low' | 'normal' | 'high' | 'urgent';

/** One recorded behavioural event, attributed to one employee, with its row attached. */
export interface BehaviouralObservation {
  kind: BehaviourSignalKind;
  /** hr_employees.id. The subject of the record. */
  employeeId: string;
  /** ISO 8601 UTC, from the source row. */
  occurredAt: string;
  /** users.id of whoever caused the event, per the row. Null when the row does not say. */
  actorUserId: string | null;
  /**
   * Did the subject cause this themselves?
   *
   * `null` means UNKNOWN and must be carried as unknown — the employee has no linked login, or the
   * row recorded no actor. Collapsing unknown into `false` would read as "somebody had to push
   * them", which is a claim about a person built from a missing column.
   */
  selfDriven: boolean | null;
  /** The work item, so a task's events can be reassembled. */
  workRef: { table: string; id: string } | null;
  /** Priority as recorded, or null where the record carries none. Never inferred. */
  complexity: BehaviourComplexity | null;
  /** The due date on the work item, ISO date. Null when none was set. */
  dueAt: string | null;
  /** For transitions: what the row said it moved from and to. */
  from?: string | null;
  to?: string | null;
  evidence: EvidenceRef;
}

// -------------------------------------------------------------------------------------------------
// TIME
// -------------------------------------------------------------------------------------------------

/**
 * THE SIX WINDOWS. Fixed vocabulary — a caller may not pass an arbitrary range, because an
 * arbitrary range is how somebody finds the fortnight that makes their argument.
 */
export const BEHAVIOUR_WINDOWS = [
  'recent',
  'this_week',
  'this_month',
  'this_quarter',
  'this_year',
  'employment_history',
] as const;

export type BehaviourWindow = (typeof BEHAVIOUR_WINDOWS)[number];

export const WINDOW_LABELS: Record<BehaviourWindow, string> = {
  recent: 'Recent',
  this_week: 'This week',
  this_month: 'This month',
  this_quarter: 'This quarter',
  this_year: 'This year',
  employment_history: 'Employment history',
};

/** A resolved window: the half-open interval [fromIso, toIso) actually queried, and what bounded it. */
export interface ResolvedWindow {
  window: BehaviourWindow;
  fromIso: string;
  toIso: string;
  /** Whole days spanned. Used to size a comparable baseline period. */
  days: number;
  /**
   * Was the start moved because the person was not employed that far back?
   *
   * A "this year" window on somebody who joined in July is three months of data wearing a twelve
   * month label, and a baseline drawn from the empty half would be a comparison against nothing.
   */
  clampedToEmployment: boolean;
  /** Human sentence naming the exact interval. Rendered as-is; never rebuilt by a caller. */
  statement: string;
}

// -------------------------------------------------------------------------------------------------
// (b) DERIVED — METRICS
// -------------------------------------------------------------------------------------------------

/**
 * THE METRIC VOCABULARY. Each key is a question the rows can answer on their own.
 *
 * Read every one as a description of records, not of a person: `self_driven_transition_share` is
 * "what share of this person's task transitions were made by their own login", not "how
 * self-motivated they are". The label carries that distinction and must not be shortened on a screen.
 */
export const BEHAVIOUR_METRICS = [
  'acceptance_latency_hours',
  'first_response_latency_hours',
  'on_time_completion_rate',
  'overdue_days_when_late',
  'revision_frequency',
  'rework_rate',
  'follow_through_rate',
  'blocked_with_stated_reason_rate',
  'self_driven_transition_share',
  'project_participation_count',
  'assessment_submission_rate',
  'assessment_time_to_submit_hours',
  'timing_consistency',
] as const;

export type BehaviourMetricKey = (typeof BEHAVIOUR_METRICS)[number];

export interface MetricMeta {
  label: string;
  /** What the number literally counts. Shown wherever the number is shown. */
  definition: string;
  unit: 'hours' | 'days' | 'ratio' | 'count' | 'index';
  /**
   * Which direction, if any, is the better one.
   *
   * 'neutral' is used wherever the honest answer is "it depends" — a high
   * `blocked_with_stated_reason_rate` may be somebody flagging obstacles early, which is good, or
   * work that is genuinely stuck, which is not, and this layer cannot tell those apart.
   */
  betterWhen: 'higher' | 'lower' | 'neutral';
  /** Rows needed before the value is reported at all. Below this the metric is `insufficient`. */
  minSample: number;
  /** Sources it is computed from, so a missing source explains a missing metric. */
  sources: BehaviourSourceTable[];
}

/**
 * ONE METRIC, ONE WINDOW, WITH ITS ROWS.
 *
 * `value: null` with `insufficient: true` is a complete and correct result. It is NOT zero — a
 * person with no tasks closed this week has an unknown on-time rate, not a zero one, and rendering
 * 0% there would put a false record on a human being.
 */
export interface MetricValue {
  key: BehaviourMetricKey;
  window: BehaviourWindow;
  value: number | null;
  unit: MetricMeta['unit'];
  /** How many source events the value was computed over. */
  n: number;
  /** True when `n` fell below the metric's `minSample`; `value` is then null. */
  insufficient: boolean;
  /** The rows behind it, capped for transport. `evidenceCount` is the true total. */
  evidence: EvidenceRef[];
  evidenceCount: number;
  /** Anything a reader must know to read the number honestly. Rendered with it, not hidden. */
  notes: string[];
}

// -------------------------------------------------------------------------------------------------
// (c) INTERPRETATION
// -------------------------------------------------------------------------------------------------

/**
 * THE TREND VOCABULARY.
 *
 * 'stable' and 'insufficient_evidence' are different answers and must never be merged. "Nothing
 * changed" is a finding; "we could not tell" is an admission, and a screen that prints the first
 * when it means the second is telling a manager something the data never said.
 *
 * 'changed_without_direction' exists for the metrics whose `betterWhen` is 'neutral'. Time taken
 * between starting and submitting an assessment moved from four hours to nine: that is a real,
 * reportable change, and calling it a decline would be this module deciding that faster is better
 * when nothing in the record says so. Reporting it as 'stable' would be worse — it moved. So the
 * movement is stated and the judgement is left to the human, which is the whole arrangement.
 */
export type TrendVerdict =
  | 'improving'
  | 'declining'
  | 'stable'
  | 'changed_without_direction'
  | 'insufficient_evidence';

/**
 * IS THIS A BLIP OR A DIRECTION?
 *
 * 'temporary_anomaly' — the movement sits in one contiguous sub-period and the periods around it are
 *                       back inside the baseline band. One bad fortnight is one bad fortnight, and
 *                       people have those for reasons no work record contains.
 * 'sustained_pattern' — the movement holds across consecutive sub-periods.
 * 'undetermined'      — not enough sub-periods carried data to tell the two apart. The default.
 */
export type PatternVerdict = 'temporary_anomaly' | 'sustained_pattern' | 'undetermined';

/** Confidence in an interpretation. Never a percentage: the inputs do not justify two decimal places. */
export type ConfidenceBand = 'none' | 'low' | 'moderate' | 'high';

export interface Confidence {
  band: ConfidenceBand;
  /** Why it landed there, in words, one reason per line. Always populated, including for 'high'. */
  reasons: string[];
  /** Total source events the interpretation rests on. */
  sampleSize: number;
  /** How many of the expected source tables actually returned rows. */
  sourcesRead: number;
  sourcesExpected: number;
  /** True when a source failed to read. An empty result and an unreadable one are not the same. */
  unreadable: boolean;
}

/** What a movement is measured against, and how that comparison was arrived at. */
export interface Baseline {
  /**
   * 'preceding_period'   the same number of days immediately before the window. The default.
   * 'employment_history' everything on record for this person. Used when the preceding period is
   *                      too thin, and named so nobody mistakes a career average for last month.
   * 'none'               there was nothing to compare against. `value` is null and every verdict
   *                      built on it is 'insufficient_evidence'.
   */
  kind: 'preceding_period' | 'employment_history' | 'none';
  value: number | null;
  n: number;
  fromIso: string | null;
  toIso: string | null;
  /**
   * The band inside which a difference is treated as noise rather than movement, expressed as a
   * relative fraction. Stated per trend so a reader can see what threshold produced the verdict.
   */
  toleranceRelative: number;
  statement: string;
}

/**
 * ONE INTERPRETED MOVEMENT IN ONE METRIC.
 *
 * The baseline is stated, not implied. "Improving" against an unnamed comparison is unfalsifiable,
 * and everything in this patch has to be arguable by the person it describes.
 */
export interface BehaviourTrend {
  key: BehaviourMetricKey;
  window: BehaviourWindow;
  verdict: TrendVerdict;
  pattern: PatternVerdict;
  /** The value in the window under review. */
  current: number | null;
  /** What it is being compared against, and where that came from. */
  baseline: Baseline;
  /** Signed change, current minus baseline, in the metric's unit. Null when either side is unknown. */
  delta: number | null;
  /** Relative change against the baseline. Null when the baseline is zero or unknown. */
  relativeChange: number | null;
  confidence: Confidence;
  /** The sentence a screen prints. Written here so two surfaces cannot word it differently. */
  statement: string;
  /** Rows behind both sides of the comparison. */
  evidence: EvidenceRef[];
  evidenceCount: number;
}

// -------------------------------------------------------------------------------------------------
// THE EXPLAINABILITY ENVELOPE — INPUTS, PROCESSING, OUTPUT, EVIDENCE, CONFIDENCE, TIMESTAMP
// -------------------------------------------------------------------------------------------------

export interface ExplanationInputs {
  /** Which tables were read, and how many rows each returned. A zero here explains a gap below. */
  sources: { table: BehaviourSourceTable; rowsRead: number; readable: boolean; note?: string }[];
  windows: ResolvedWindow[];
  /** Employment bounds used to clamp windows, where known. */
  employedFromIso: string | null;
  employedToIso: string | null;
  observationCount: number;
}

/**
 * THE WHOLE ANSWER FOR ONE PERSON. The shape PATCH 05 and any UI patch consume.
 *
 * Nothing on it is a summary that replaces the parts: there is no headline number, no letter grade
 * and no colour. A consumer that wants one has to invent it, in the open, where it can be argued
 * with — rather than receiving one from here with this module's authority behind it.
 */
export interface BehaviouralProfile {
  employeeId: string;
  /** Constant 'advisory_only'. */
  decisionUse: typeof DECISION_USE;
  /** Constant. Render verbatim. */
  disclaimer: typeof NOT_PRODUCTIVITY;
  /** INPUTS. */
  inputs: ExplanationInputs;
  /** PROCESSING — the named steps that ran, in order, in plain words. */
  processing: string[];
  /** OUTPUT — metrics by window, then interpretations over them. */
  metrics: MetricValue[];
  trends: BehaviourTrend[];
  /** CONFIDENCE for the profile as a whole. Individual trends carry their own. */
  confidence: Confidence;
  /** What this profile could NOT establish, in words. Empty array means nothing was withheld. */
  limitations: string[];
  /** TIMESTAMP — when this was computed. ISO 8601 UTC. */
  computedAtIso: string;
  /** The read that produced it, already logged. Present so a caller can cite the log entry. */
  access: AccessDecision;
}

// -------------------------------------------------------------------------------------------------
// ACCESS
// -------------------------------------------------------------------------------------------------

/** Why somebody is reading this. Required, recorded, and narrower than "because I can". */
export const BEHAVIOUR_PURPOSES = [
  'self_review',
  'people_management',
  'performance_cycle',
  'workload_review',
  'org_oversight',
] as const;

export type BehaviourPurpose = (typeof BEHAVIOUR_PURPOSES)[number];

/** The ground on which access was granted. Recorded so an audit can ask "by what right". */
export type AccessBasis =
  | 'self'
  | 'reporting_manager'
  | 'department_head'
  | 'org_capability';

export interface AccessDecision {
  allowed: boolean;
  basis: AccessBasis | null;
  purpose: BehaviourPurpose;
  /** Where the relationship was resolved from, when the basis was a relationship. */
  relationshipSource?: 'graph' | 'legacy-column' | 'none';
  /** Refusal in words, safe to show. Never names the schema or whether the person exists. */
  reason: string;
  /** True once the access log row is known to have been written. A read proceeds only on true. */
  logged: boolean;
  atIso: string;
}
