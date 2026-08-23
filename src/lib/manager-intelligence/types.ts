// src/lib/manager-intelligence/types.ts — PATCH 14 (Manager & Team Lead Intelligence) CONTRACTS.
//
// =================================================================================================
// WHAT THIS PATCH IS, AND WHAT IT IS NOT
// =================================================================================================
//
// This patch builds the day-to-day screen a line manager or team lead uses: what their people are
// working on, how delivery is going, where the load is, what the manager might do about it, and the
// controls to actually do it (feedback, acknowledgement, an intervention, an HR referral, a tracked
// development action).
//
// IT OWNS NO SOURCE DATA. Every fact it renders is read from the module that already owns it —
// employee_tasks, hr_daily_reports, hr_attendance, hr_leave_request, hr_feedback, hr_events,
// audit_log. This patch owns exactly three tables (mti_manager_actions, mti_development_actions,
// mti_record_outbox), and every one of them holds A MANAGER'S OWN ACT, which nothing else records.
//
// IT DECIDES NOTHING. Every derived statement in here is advisory, carries its confidence, names its
// inputs, and is rendered lighter than a record. No value produced by this module may close a
// hiring, promotion, termination or disciplinary loop, and there is no code path from a signal to a
// status on anybody's employment record.
//
// =================================================================================================
// THE ENVELOPE EVERY DERIVED STATEMENT CARRIES
// =================================================================================================
//
//     INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
//
// ManagerSignal below is that envelope, as a type, and buildSignal() cannot construct one without
// filling every field. A sentence on a manager's screen that cannot say what it was computed from
// is the thing this shape exists to make unrepresentable.
//
// =================================================================================================
// DEMONSTRATED EVIDENCE OUTRANKS EVERYTHING ELSE, AND THE CODE IS WHAT SAYS SO
// =================================================================================================
//
// `evidenceStrength` is not a label for a screen. decisionWeight() reads it, outranks() compares it,
// and recommend.ts REFUSES to raise an action that rests on nothing demonstrated or stated. Work a
// person actually did, recorded when they did it, is the strongest thing this system holds; a
// pattern the system worked out about them is the weakest; and no third category is admissible.
//
// ADMISSIBLE_SOURCES is a closed list, checked at construction. Birth data, derived traits, health,
// and every protected attribute are absent from it and cannot be added by a caller — a signal whose
// source is not on the list THROWS where it is built rather than rendering with a nice label. The
// separation this enforces is the one the house rules require: only legitimately collected
// organisational work records reach a manager's screen.

/** The ten sections of the manager view, in render order. */
export const SECTION_KEYS = [
  'current_work',
  'submission_patterns',
  'quality_rework',
  'team_behaviour',
  'strengths',
  'development_areas',
  'workload_capacity',
  'recommended_actions',
  'feedback',
  'growth_timeline',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * Plain words for a heading, from a FUNCTION and not an exported `Record<string, string>`.
 * A typed map read inside .astro JSX is a known parse hazard on this project, and every consumer
 * of this module renders in an .astro file.
 */
export function sectionLabel(key: string): string {
  const k = String(key || '');
  if (k === 'current_work') return 'Current work and delivery';
  if (k === 'submission_patterns') return 'Submission patterns';
  if (k === 'quality_rework') return 'Quality and rework';
  if (k === 'team_behaviour') return 'Team behaviour';
  if (k === 'strengths') return 'Strengths';
  if (k === 'development_areas') return 'Development areas';
  if (k === 'workload_capacity') return 'Workload and capacity';
  if (k === 'recommended_actions') return 'Recommended management actions';
  if (k === 'feedback') return 'Feedback';
  if (k === 'growth_timeline') return 'Growth timeline';
  return 'Section';
}

export function isSectionKey(v: unknown): v is SectionKey {
  return typeof v === 'string' && (SECTION_KEYS as readonly string[]).indexOf(v) >= 0;
}

// -------------------------------------------------------------------------------------------------
// EVIDENCE STRENGTH — THE RANKING THAT DECIDES WHAT MAY CARRY A RECOMMENDATION
// -------------------------------------------------------------------------------------------------

/**
 *   demonstrated  the person did the work and the platform recorded it as it happened. A task they
 *                 closed, a report they filed, a review a named human left. The strongest thing here.
 *   stated        a human wrote it down about them — a manager's feedback note, an acknowledgement.
 *                 It is somebody's account, recorded honestly as somebody's account.
 *   derived       this module worked it out by counting the two above. Advisory, always, and it
 *                 never stands alone next to a person's name.
 */
export type EvidenceStrength = 'demonstrated' | 'stated' | 'derived';

/** Higher is stronger. Used to sort, and used by recommend.ts to refuse a weightless action. */
export function decisionWeight(strength: EvidenceStrength): number {
  if (strength === 'demonstrated') return 3;
  if (strength === 'stated') return 2;
  return 1;
}

/** Does `a` carry more decision weight than `b`? */
export function outranks(a: EvidenceStrength, b: EvidenceStrength): boolean {
  return decisionWeight(a) > decisionWeight(b);
}

export function evidenceStrengthLabel(strength: string): string {
  const k = String(strength || '');
  if (k === 'demonstrated') return 'Demonstrated work';
  if (k === 'stated') return 'Stated by a person';
  if (k === 'derived') return 'Worked out from records';
  return 'Unknown';
}

// -------------------------------------------------------------------------------------------------
// WHERE A SIGNAL MAY COME FROM. A CLOSED LIST, CHECKED AT CONSTRUCTION.
// -------------------------------------------------------------------------------------------------

/**
 * The only systems of record this patch is allowed to build a signal out of. Each is an ordinary
 * organisational work record that the person themselves can already see on their own portal.
 *
 * WHAT IS NOT ON THIS LIST, and cannot be added by a caller because the check is on the value:
 * anything birth-based or trait-inferred; wellness_* (women-only, gated, aggregate-only, and there
 * is deliberately no read-one-person helper anywhere in it); hr_clock_events (latitude, longitude,
 * IP, device string, a selfie per punch — a person may see their own trail, a manager seeing their
 * reports' is surveillance); the free-text reason on a leave request; and every protected attribute.
 */
export const ADMISSIBLE_SOURCES = [
  'employee_tasks',
  'hr_daily_reports',
  'hr_attendance',
  'hr_leave_request',
  'hr_feedback',
  'hr_events',
  'audit_log',
  'mti_manager_actions',
  'mti_development_actions',
  'hr_employee_flags:count_only',
] as const;
export type AdmissibleSource = (typeof ADMISSIBLE_SOURCES)[number];

export function isAdmissibleSource(v: unknown): v is AdmissibleSource {
  return typeof v === 'string' && (ADMISSIBLE_SOURCES as readonly string[]).indexOf(v) >= 0;
}

// -------------------------------------------------------------------------------------------------
// THE SIGNAL ENVELOPE
// -------------------------------------------------------------------------------------------------

/** One thing that was counted, and the table it was counted in. */
export interface SignalInput {
  label: string;
  value: string;
  source: AdmissibleSource;
}

/**
 * What a manager could go and look at to check the signal themselves.
 *
 * `ref` is a path on this platform, never an external link and never a document. An aggregate
 * carries a count and no ref, because "eleven reports were filed" is checkable as a number and
 * naming eleven rows on a manager's screen is more disclosure than the sentence needs.
 */
export interface SignalEvidence {
  label: string;
  kind: 'record' | 'aggregate';
  ref?: string | null;
  count?: number | null;
}

/** Which way the signal points. Never a score, never a grade, never a colour on a person. */
export type SignalDirection = 'positive' | 'attention' | 'neutral';

export interface ManagerSignal {
  /** Stable across renders, so an acknowledgement can name the signal it answers. */
  key: string;
  section: SectionKey;
  /** One sentence, in the words a manager would use. */
  headline: string;
  /** What it means and what it does not mean. Rendered under the headline, always. */
  detail: string;
  direction: SignalDirection;
  evidenceStrength: EvidenceStrength;
  inputs: SignalInput[];
  /** The named method: "on-time rate = closed on or before the due date / closed with a due date". */
  processing: string;
  /** The computed value, in words. */
  output: string;
  evidence: SignalEvidence[];
  /** 0..1. Required on every signal in this module, including the ones counted straight from rows. */
  confidence: number;
  /** Why the confidence is what it is. A number with no basis is not a confidence. */
  confidenceBasis: string;
  /** The observation window, inclusive, as YYYY-MM-DD. */
  observedFrom: string;
  observedTo: string;
  /** ISO instant the signal was computed. Passed in — nothing in signals.ts reads the clock. */
  computedAt: string;
}

/** Thrown where a signal is built, never rendered. A bad signal must not reach a screen at all. */
export class SignalContractError extends Error {}

/**
 * The single constructor. Every signal in this patch comes through here, so every rule below is
 * enforced once rather than remembered in ten places.
 */
export function buildSignal(s: ManagerSignal): ManagerSignal {
  if (!s.key) throw new SignalContractError('A signal needs a stable key.');
  if (!isSectionKey(s.section)) throw new SignalContractError('Unknown section: ' + String(s.section));
  if (!s.headline || !s.detail) {
    throw new SignalContractError(s.key + ': headline and detail are both required.');
  }
  if (!s.processing) throw new SignalContractError(s.key + ': a signal must name how it was computed.');
  if (!s.inputs.length) throw new SignalContractError(s.key + ': a signal must name its inputs.');
  for (const i of s.inputs) {
    if (!isAdmissibleSource(i.source)) {
      throw new SignalContractError(s.key + ': ' + String(i.source) + ' is not an admissible source.');
    }
  }
  if (!(s.confidence >= 0 && s.confidence <= 1)) {
    throw new SignalContractError(s.key + ': confidence must be between 0 and 1.');
  }
  if (!s.confidenceBasis) throw new SignalContractError(s.key + ': a confidence needs a stated basis.');
  return Object.freeze({
    ...s,
    inputs: Object.freeze([...s.inputs]) as SignalInput[],
    evidence: Object.freeze([...s.evidence]) as SignalEvidence[],
  }) as ManagerSignal;
}

// -------------------------------------------------------------------------------------------------
// RECOMMENDED MANAGEMENT ACTIONS
// -------------------------------------------------------------------------------------------------

/** What the manager is being invited to do. Each maps to a control this patch actually renders. */
export const MANAGER_ACTION_KINDS = [
  'structured_feedback',
  'signal_acknowledged',
  'intervention_recorded',
  'hr_support_requested',
  'development_action',
] as const;
export type ManagerActionKind = (typeof MANAGER_ACTION_KINDS)[number];

export function isManagerActionKind(v: unknown): v is ManagerActionKind {
  return typeof v === 'string' && (MANAGER_ACTION_KINDS as readonly string[]).indexOf(v) >= 0;
}

export function actionKindLabel(kind: string): string {
  const k = String(kind || '');
  if (k === 'structured_feedback') return 'Feedback recorded';
  if (k === 'signal_acknowledged') return 'Signal acknowledged';
  if (k === 'intervention_recorded') return 'Intervention recorded';
  if (k === 'hr_support_requested') return 'HR support requested';
  if (k === 'development_action') return 'Development action';
  return 'Manager action';
}

export type ActionUrgency = 'now' | 'this_week' | 'watch';

export function urgencyLabel(u: string): string {
  const k = String(u || '');
  if (k === 'now') return 'Worth doing now';
  if (k === 'this_week') return 'Worth doing this week';
  if (k === 'watch') return 'Keep an eye on it';
  return 'Suggestion';
}

/**
 * ADVICE TO A HUMAN WHO DECIDES. `humanDecides` is a literal `true` in the type, so a variant that
 * decides on its own cannot be constructed, cannot be assigned, and cannot be introduced by an edit
 * that forgets the rule.
 */
export interface RecommendedAction {
  key: string;
  /** The sentence. "Review workload before assigning additional high-priority tasks." */
  headline: string;
  /** Why this is being suggested, naming what it rests on. */
  why: string;
  /** Signal keys this was drawn from. Never empty — see recommend.ts. */
  fromSignals: string[];
  /** The strongest evidence behind it. Never weaker than 'stated'. */
  restsOn: EvidenceStrength;
  urgency: ActionUrgency;
  suggests: ManagerActionKind;
  confidence: number;
  humanDecides: true;
}

// -------------------------------------------------------------------------------------------------
// THE FACTS SIGNALS ARE COMPUTED FROM
// -------------------------------------------------------------------------------------------------
//
// Plain numbers, gathered by read.ts and by nothing else. signals.ts takes this shape and touches no
// database, which is what makes every rule in it testable without one.

export interface ObservationWindow {
  /** YYYY-MM-DD, inclusive. */
  fromIso: string;
  toIso: string;
  days: number;
}

export interface DeliveryFacts {
  openTotal: number;
  inProgress: number;
  blocked: number;
  blockedWithStatedReason: number;
  underReview: number;
  overdue: number;
  dueWithin7: number;
  urgentOpen: number;
  highOpen: number;
  completedInWindow: number;
  completedOnTime: number;
  completedLate: number;
  completedWithDueDate: number;
  /** Age in days of the oldest task still open. Null when nothing is open. */
  oldestOpenDays: number | null;
}

export interface SubmissionFacts {
  /** Working days in the window on which a report was expected — attendance says they worked. */
  expectedDays: number;
  filedDays: number;
  /** Filed on the day it covers. */
  sameDayFilings: number;
  /** Filed after the day it covers. */
  lateFilings: number;
  longestMissingRun: number;
  reviewedByAnyone: number;
}

export interface ReworkFacts {
  /** Moves back from under_review / approved / completed to in_progress or blocked. */
  sendBacks: number;
  tasksSentBack: number;
  tasksReachingReview: number;
  /** hr_daily_reports.revision_count > 0. */
  reportsRevised: number;
  reportsFiled: number;
}

export interface BehaviourFacts {
  attendanceDaysRecorded: number;
  presentDays: number;
  leaveDays: number;
  daysWithNoRecord: number;
  /** Tasks this person moved to accepted or in_progress themselves, in the window. */
  workPickedUp: number;
  /** Blocks they raised WITH a stated cause. Raising a blocker early is a behaviour, not a fault. */
  blockersRaised: number;
  commentsWritten: number;
  /**
   * COUNT ONLY, LEVEL 1 ONLY. See read.ts for why no description, no breach type and no level 2 or
   * 3 reaches this shape: an investigation is HR's to hold, and a manager acting on one they were
   * shown in passing is the harm being designed out.
   */
  informalConductNotes: number;
}

export interface CapacityFacts {
  activeAssignments: number;
  urgentOpen: number;
  highOpen: number;
  dueWithin7: number;
  overdue: number;
  /** Approved leave days already booked in the next fortnight. A count only, never a leave type. */
  approvedLeaveDaysNext14: number;
  /** How many people the manager holds, for the "carrying more than the rest" comparison. */
  teamSize: number;
  /** Mean active assignments across the authorised team. Null when the team is one person. */
  teamMeanAssignments: number | null;
}

/** What a human wrote about this person, as a count by theme. The words stay in hr_feedback. */
export interface StatedFacts {
  strengthNotes: number;
  improvementNotes: number;
  generalNotes: number;
  mostRecentAt: string | null;
}

export interface TeamMemberFacts {
  employeeId: string;
  fullName: string;
  designation: string | null;
  window: ObservationWindow;
  delivery: DeliveryFacts;
  submission: SubmissionFacts;
  rework: ReworkFacts;
  behaviour: BehaviourFacts;
  capacity: CapacityFacts;
  stated: StatedFacts;
  /**
   * Which of the reads above actually succeeded. A failed read is NEVER presented as a zero — a
   * manager told "no reports were filed" because a query timed out will go and have a conversation
   * about something that did not happen.
   */
  readFailures: string[];
}

// -------------------------------------------------------------------------------------------------
// THE ENVELOPE PUBLISHED TO THE CENTRAL EMPLOYEE INTELLIGENCE RECORD
// -------------------------------------------------------------------------------------------------

/**
 * Every manager act this patch records is also published as one of these. See record-port.ts for
 * how it reaches the central record, and docs/manager-intelligence.md for the consumer contract.
 *
 * IT CARRIES NO FREE TEXT ABOUT A PERSON. The words a manager wrote live in the module that owns
 * them (hr_feedback for feedback, helpdesk_tickets for an HR referral, mti_* for the rest) and this
 * envelope points at the row. A second copy of somebody's appraisal note, in a table nobody thinks
 * of as holding one, is how disclosure happens by accident.
 */
export interface RecordEnvelope {
  /** mti_manager_actions.id — the row this describes. */
  actionId: string;
  subjectEmployeeId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  kind: ManagerActionKind;
  /** The signal this act answers, when it answers one. */
  signalKey: string | null;
  section: SectionKey | null;
  /** module:table:id of the row that holds the words. Never the words. */
  recordRef: string | null;
  /** How the manager came to hold authority over this person, at the moment they acted. */
  authorityBasis: string;
  occurredAt: string;
}
