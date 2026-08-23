// src/lib/horizon/signal-detectors.ts — PATCH 08 · HORIZON Signal Engine · THE DETECTORS.
//
// =================================================================================================
// WHAT A DETECTOR IS
// =================================================================================================
//
// A pure function from ONE PERSON'S RECORDS to zero or more signal candidates. It gets a window of
// events, a clock, and nothing else: no database handle, no network, no ambient state. That is not
// tidiness — it is the only way a rule that will be quoted back at somebody in a review conversation
// can be tested exhaustively before it is ever pointed at a real person.
//
// A detector never decides whether its candidate is raised. admit() in signal-contract.ts does that,
// and it can refuse or downgrade what a detector proposes. So a detector may ask for red; whether it
// gets red depends on the evidence it managed to attach.
//
// =================================================================================================
// WHAT THEY READ, AND WHY ONLY THAT
// =================================================================================================
//
// ONE INPUT: hr_events (src/lib/hr-events.ts), the append-only log of what happened to a person. It
// was built to answer "what has happened to this person, in order", every row carries how it came to
// be known (`assertion`), and it already owns the joins across four id spaces.
//
// Reading it and nothing else is a deliberate limit on this patch:
//   - no other module's tables are read, so no other patch's schema is assumed or duplicated;
//   - every row on that log is `factual`, `explicitly_provided`, `verified` or `calculated` — there
//     is no `inferred` and no `predicted` on it, so a detector cannot build a finding on a guess
//     somebody else made;
//   - THERE IS NO SURVEILLANCE HERE. hr_events records approvals, completions, reviews and joins:
//     organisational acts that already happened on the record. Nothing observes anybody, and
//     `collectedUnder` on every piece of evidence produced here is `organisational_record`.
//
// When another HORIZON patch exposes attendance, task delivery or feedback through a read contract,
// a new detector is added here that consumes it — the window type below has room. What must NOT
// happen is a detector reaching into another patch's tables directly.
//
// =================================================================================================
// WHAT THEY MAY NOT DO
// =================================================================================================
//
// No detector may name a health condition, a protected attribute, or one of the six consequential
// decisions in what it recommends. The workload detector is the one to read carefully: it counts
// RECORDED WORK and RECORDED LEAVE and says so in those words. It does not say anybody is tired, at
// risk, or unwell. It cannot know that, this system is not permitted to conclude it, and the
// difference between "no approved leave is recorded in 180 days" and "she is burning out" is the
// difference between a record and a diagnosis.
import type { HrEvent, HrEventType } from '@/lib/hr-events';
import {
  bandOf,
  DEFAULT_ORGANISATION_ID,
  newHorizonId,
  type Evidence,
  type EvidenceClass,
  type EvidenceSourceType,
  type Graded,
  type RecommendedAction,
  type SubjectRef,
} from '@/lib/horizon';
import type { AttentionBand, SignalCandidate } from '@/lib/horizon/signal-contract';

// =================================================================================================
// THE WINDOW
// =================================================================================================

export interface DetectorWindow {
  subject: SubjectRef;
  /** One person's events. Any order; every detector sorts what it needs. */
  events: HrEvent[];
  /** The clock, passed in so a test can stand anywhere in time. */
  now: Date;
}

export interface Detector {
  key: string;
  version: string;
  name: string;
  /** What it looks for, in one sentence a non-engineer can check. */
  description: string;
  dimension: string;
  /** The highest band it will ever ask for. admit() may still lower it. */
  maxBand: AttentionBand;
  run(w: DetectorWindow): SignalCandidate[];
}

// =================================================================================================
// EVENT -> EVIDENCE
// =================================================================================================
//
// HOW STRONG IS A ROW ON THE TIMELINE? Two things decide it, and both are READ rather than assumed:
// the KIND of event (a verified skill is not a recorded objective) and the event's own `assertion`,
// which is the log's record of how the thing came to be known. The assertion CAPS the class.
//
// `calculated` is the important cap. The log says that row was DERIVED from other rows by a
// definition rather than watched happening, so it drops to `inferred` and stops being load-bearing.
// That single line is what stops a chain of derivations from laundering itself into evidence strong
// enough to stand behind a high-impact act.

const EVENT_SOURCE: Record<string, EvidenceSourceType> = {
  CandidateApplied: 'application',
  InterviewCompleted: 'interview',
  OfferAccepted: 'application',
  EmployeeJoined: 'integration_record',
  EmployeePromoted: 'integration_record',
  EmployeeTransferred: 'integration_record',
  LeaveApproved: 'attendance',
  GoalCreated: 'task',
  PerformanceReviewCompleted: 'performance_review',
  CourseCompleted: 'training_record',
  SkillVerified: 'capability_evidence',
  EmployeeExited: 'integration_record',
};

const EVENT_CLASS: Record<string, EvidenceClass> = {
  CandidateApplied: 'stated',
  InterviewCompleted: 'attested',
  OfferAccepted: 'observed',
  EmployeeJoined: 'observed',
  EmployeePromoted: 'observed',
  EmployeeTransferred: 'observed',
  LeaveApproved: 'observed',
  GoalCreated: 'stated',
  PerformanceReviewCompleted: 'attested',
  CourseCompleted: 'demonstrated',
  SkillVerified: 'demonstrated',
  EmployeeExited: 'observed',
};

const CLASS_ORDER: EvidenceClass[] = ['non_evidential', 'inferred', 'stated', 'attested', 'observed', 'demonstrated'];

/** The ceiling an assertion puts on an evidence class. */
const ASSERTION_CEILING: Record<string, EvidenceClass> = {
  factual: 'demonstrated',
  verified: 'demonstrated',
  explicitly_provided: 'stated',
  calculated: 'inferred',
};

function capClass(cls: EvidenceClass, ceiling: EvidenceClass): EvidenceClass {
  const a = CLASS_ORDER.indexOf(cls);
  const b = CLASS_ORDER.indexOf(ceiling);
  if (a < 0 || b < 0) return cls;
  return a <= b ? cls : ceiling;
}

function graded(value: number, basis: string): Graded {
  const v = Math.max(0, Math.min(1, value));
  return { value: v, band: bandOf(v), basis };
}

/** How much a source can be relied on, read off the class rather than invented per detector. */
const RELIABILITY_BY_CLASS: Record<EvidenceClass, number> = {
  demonstrated: 0.9,
  observed: 0.8,
  attested: 0.6,
  stated: 0.4,
  inferred: 0.3,
  non_evidential: 0.05,
};

/**
 * Turn one timeline row into one piece of shared-contract evidence, or null when it cannot be
 * pointed at. `sourceId` is the hr_events row, so two detectors citing the same event cite the same
 * reference and the dedupe comparison in signal-contract.ts can tell.
 */
export function evidenceFromEvent(ev: HrEvent, relevance: number, relevanceBasis: string): Evidence | null {
  if (!ev || !ev.id || !ev.occurredAt) return null;
  const cls = capClass(EVENT_CLASS[ev.type] || 'stated', ASSERTION_CEILING[ev.assertion] || 'stated');
  return {
    id: newHorizonId('evidence'),
    // A row the log itself calls derived is recorded as a computation, whatever the event type is.
    sourceType: ev.assertion === 'calculated' ? 'system_computation' : EVENT_SOURCE[ev.type] || 'integration_record',
    sourceId: String(ev.id),
    timestamp: new Date(ev.occurredAt).toISOString(),
    relevance: graded(relevance, relevanceBasis),
    reliability: graded(
      RELIABILITY_BY_CLASS[cls],
      'Recorded by this platform at the time as "' + ev.assertion + '", which places it at "' + cls + '".',
    ),
    summary: (ev.label || ev.type) + ' — ' + new Date(ev.occurredAt).toISOString().slice(0, 10),
    rawReference: {
      ownerModule: 'src/lib/hr-events.ts',
      table: 'hr_events',
      recordId: String(ev.id),
    },
    evidenceClass: ev.assertion === 'calculated' ? 'inferred' : cls,
    layer: 'raw',
    collectedUnder: 'organisational_record',
    organisationId: DEFAULT_ORGANISATION_ID,
  };
}

/**
 * A measurement this engine computed. Never load-bearing, and labelled so a reader knows why.
 *
 * It is `inferred`, layer `computed`, source type `system_computation` — every one of which is a
 * word the shared vocabulary already has. A derived rate is how the change was NOTICED; the records
 * underneath it are what the finding rests on.
 */
export function derivedEvidence(key: string, summary: string, at: Date): Evidence {
  return {
    id: newHorizonId('evidence'),
    sourceType: 'system_computation',
    sourceId: 'horizon_signal_metric:' + key,
    timestamp: at.toISOString(),
    relevance: graded(0.5, 'It is how the change was noticed, not what the change rests on.'),
    reliability: graded(0.3, 'Derived here from the rows above by a named definition; it measures nothing on its own.'),
    summary,
    rawReference: {
      ownerModule: 'src/lib/horizon/signal-detectors.ts',
      table: 'hr_events',
      recordId: 'derived:' + key,
    },
    evidenceClass: 'inferred',
    layer: 'computed',
    collectedUnder: 'organisational_record',
    organisationId: DEFAULT_ORGANISATION_ID,
  };
}

// =================================================================================================
// WINDOW HELPERS
// =================================================================================================

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86400000);
}

function at(ev: HrEvent): number {
  return ev?.occurredAt ? Date.parse(ev.occurredAt) : NaN;
}

function between(events: HrEvent[], from: Date, to: Date): HrEvent[] {
  const a = from.getTime();
  const b = to.getTime();
  return events.filter((e) => {
    const t = at(e);
    return !Number.isNaN(t) && t >= a && t <= b;
  });
}

function ofType(events: HrEvent[], types: readonly string[]): HrEvent[] {
  return events.filter((e) => types.indexOf(e.type) >= 0);
}

function newestFirst(events: HrEvent[]): HrEvent[] {
  return events.slice().sort((x, y) => (at(y) || 0) - (at(x) || 0));
}

function evidenceOf(events: HrEvent[], relevance: number, basis: string, cap = 12): Evidence[] {
  const out: Evidence[] = [];
  for (const ev of newestFirst(events)) {
    const e = evidenceFromEvent(ev, relevance, basis);
    if (e) out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * The event types this patch treats as A THING BEING DELIVERED.
 *
 * NAMED, NOT INFERRED, and printed on every signal that counts them, because "delivery fell" means
 * nothing until the reader knows what was counted. hr_events carries no task or ticket today; these
 * five are what the log actually holds that somebody did.
 */
export const DELIVERY_TYPES: readonly HrEventType[] = Object.freeze([
  'CourseCompleted',
  'SkillVerified',
  'PerformanceReviewCompleted',
  'InterviewCompleted',
  'GoalCreated',
] as HrEventType[]);

const DELIVERY_SENTENCE =
  'completed courses, verified skills, completed appraisals, recorded interview feedback and recorded objectives';

function action(key: string, label: string, addressedTo: RecommendedAction['addressedTo']): RecommendedAction {
  return { key, label, addressedTo };
}

// =================================================================================================
// DETECTOR 1 — GROWTH ALIGNMENT (Opportunity)
// =================================================================================================

const growthAlignment: Detector = {
  key: 'growth_alignment',
  version: '1.0.0',
  name: 'Growth alignment',
  description:
    'Learning that was evidenced in the same period as objectives being recorded — the two lining up is the finding.',
  dimension: 'direction',
  maxBand: 'green',
  run(w) {
    const periodStart = daysAgo(w.now, 90);
    const window = between(w.events, periodStart, w.now);
    const learning = ofType(window, ['CourseCompleted', 'SkillVerified']);
    const goals = ofType(window, ['GoalCreated']);
    if (learning.length < 2 || goals.length < 1) return [];

    return [
      {
        detectorKey: growthAlignment.key,
        detectorVersion: growthAlignment.version,
        band: 'green',
        category: 'growth_opportunity',
        dimension: growthAlignment.dimension,
        title: 'Strong Growth Alignment Detected',
        whatChanged:
          learning.length +
          ' pieces of evidenced learning were recorded in the last 90 days alongside ' +
          goals.length +
          ' recorded objective(s) — the learning and the stated direction moved together.',
        subject: w.subject,
        evidence: evidenceOf(learning, 0.8, 'Evidenced learning inside the window this signal covers.', 8).concat(
          evidenceOf(goals, 0.7, 'The recorded direction the learning is being read against.', 4),
        ),
        inputs: [
          {
            source: 'hr_events',
            description:
              'CourseCompleted and SkillVerified rows for this person in the last 90 days (' +
              learning.length +
              '), and GoalCreated rows in the same window (' +
              goals.length +
              ').',
          },
        ],
        processing:
          'Counted evidenced learning and recorded objectives in one 90-day window. Two or more of the first alongside at least one of the second is the threshold. No comparison is made against anybody else.',
        recommendedActions: [
          action(
            'discuss_next_opportunity',
            'Have a conversation about what this makes possible next — a wider brief, a piece of work that uses it, or a mentor.',
            'reporting_manager',
          ),
        ],
        periodStart: periodStart.toISOString(),
        periodEnd: w.now.toISOString(),
        touchesDecision: null,
      },
    ];
  },
};

// =================================================================================================
// DETECTOR 2 — LEADERSHIP DEVELOPMENT (Growth)
// =================================================================================================
//
// MARKED AS TOUCHING `promotion`, DELIBERATELY. Nothing about this signal promotes anybody and its
// recommended action is a development conversation — but this is precisely the sort of row that gets
// quoted in a promotion discussion, and marking it holds it to the high-impact evidence floor: at
// least one demonstrated or observed record, or it is not raised at all. It also forces human review
// and puts HR on it as the reviewer. Being honest about where a signal might end up is what buys the
// stricter test.

const leadershipDevelopment: Detector = {
  key: 'leadership_development',
  version: '1.0.0',
  name: 'Leadership development',
  description:
    'Repeated verified capability plus a completed appraisal, with no change of responsibility recorded in the same period.',
  dimension: 'leadership',
  maxBand: 'blue',
  run(w) {
    const periodStart = daysAgo(w.now, 180);
    const window = between(w.events, periodStart, w.now);
    const verified = ofType(window, ['SkillVerified']);
    const reviews = ofType(window, ['PerformanceReviewCompleted']);
    const responsibilityChanges = ofType(window, ['EmployeePromoted', 'EmployeeTransferred']);
    if (verified.length < 2 || reviews.length < 1) return [];
    if (responsibilityChanges.length > 0) return [];

    return [
      {
        detectorKey: leadershipDevelopment.key,
        detectorVersion: leadershipDevelopment.version,
        band: 'blue',
        category: 'growth_opportunity',
        dimension: leadershipDevelopment.dimension,
        title: 'Leadership Development Opportunity',
        whatChanged:
          verified.length +
          ' skills were verified against evidence in the last 180 days and an appraisal was completed in the same period, while nothing changed in the responsibility on record.',
        subject: w.subject,
        evidence: evidenceOf(verified, 0.85, 'Capability evidenced and verified by a named human.', 8).concat(
          evidenceOf(reviews, 0.7, 'A completed appraisal in the same period.', 4),
        ),
        inputs: [
          {
            source: 'hr_events',
            description:
              'SkillVerified rows (' +
              verified.length +
              '), PerformanceReviewCompleted rows (' +
              reviews.length +
              '), and the absence of EmployeePromoted or EmployeeTransferred rows, all within 180 days.',
          },
        ],
        processing:
          'Two or more verified skills and at least one completed appraisal inside 180 days, with no recorded change of responsibility in the same window. Verified skills are used because each one required a named human and linked evidence; a skill somebody typed into a form is not counted here.',
        recommendedActions: [
          action(
            'development_conversation',
            'Have a development conversation about what wider responsibility would look like, and what would need to be true first.',
            'reporting_manager',
          ),
          action(
            'record_for_review',
            'Keep this alongside the evidence for the next review cycle. Any change of role is a separate human decision on its own evidence.',
            'hr_operations',
          ),
        ],
        periodStart: periodStart.toISOString(),
        periodEnd: w.now.toISOString(),
        touchesDecision: 'promotion',
      },
    ];
  },
};

// =================================================================================================
// DETECTOR 3 — SUBMISSION CONSISTENCY (Watch)
// =================================================================================================
//
// A RATE CHANGE IS NOT A PERFORMANCE FINDING, and this detector is written so nobody can read it as
// one. It compares a 30-day rate against the 60 days before it, states both numbers on the signal,
// and recommends asking. A drop has a dozen ordinary explanations — a long piece of work that has
// not landed yet, a reassignment, an illness, a system that stopped emitting an event. The engine
// cannot tell those apart, so it does not try to.

const submissionConsistency: Detector = {
  key: 'submission_consistency',
  version: '1.0.0',
  name: 'Submission consistency',
  description: 'A 30-day rate of recorded delivery that has fallen well below the 60 days before it.',
  dimension: 'consistency',
  maxBand: 'yellow',
  run(w) {
    const recentStart = daysAgo(w.now, 30);
    const baselineStart = daysAgo(w.now, 90);
    const recent = ofType(between(w.events, recentStart, w.now), DELIVERY_TYPES);
    const baseline = ofType(between(w.events, baselineStart, recentStart), DELIVERY_TYPES);

    // A baseline this thin cannot support a claim about a change. Say nothing rather than something
    // shaped like a finding.
    if (baseline.length < 3) return [];

    const baselineRate = baseline.length / 2; // two 30-day periods
    const recentRate = recent.length;
    if (recentRate >= baselineRate * 0.5) return [];
    const dropPct = Math.round((1 - recentRate / baselineRate) * 100);

    return [
      {
        detectorKey: submissionConsistency.key,
        detectorVersion: submissionConsistency.version,
        band: 'yellow',
        category: 'reliability',
        dimension: submissionConsistency.dimension,
        title: 'Submission Consistency Change Detected',
        whatChanged:
          'Recorded delivery in the last 30 days is ' +
          dropPct +
          '% below the rate of the 60 days before it (' +
          recentRate +
          ' against ' +
          baselineRate.toFixed(1) +
          ' per 30 days).',
        subject: w.subject,
        evidence: evidenceOf(recent, 0.7, 'Recorded delivery inside the recent window.', 6)
          .concat(evidenceOf(baseline, 0.6, 'Recorded delivery in the baseline window it is compared against.', 6))
          .concat([
            derivedEvidence(
              'submission_rate:' + recentRate + ':' + baselineRate.toFixed(1),
              'Recorded delivery ran at ' +
                recentRate +
                ' in the last 30 days against a baseline of ' +
                baselineRate.toFixed(1) +
                ' per 30 days over the 60 days before that.',
              w.now,
            ),
          ]),
        inputs: [
          {
            source: 'hr_events',
            description:
              'Counted ' +
              DELIVERY_SENTENCE +
              ' in two windows: the last 30 days (' +
              recent.length +
              ') and the 60 days before it (' +
              baseline.length +
              ').',
          },
        ],
        processing:
          'Compared a 30-day count against a 60-day baseline expressed per 30 days. Raised when the recent rate is below half the baseline and the baseline itself has at least three records. It measures what this platform recorded, not what was done — work that leaves no row here is invisible to it, and that is one of several ordinary explanations for a fall.',
        recommendedActions: [
          action(
            'ask_what_changed',
            'Ask what changed. A fall in recorded delivery is a question, not a finding — the records may simply be somewhere this system cannot see.',
            'reporting_manager',
          ),
        ],
        periodStart: baselineStart.toISOString(),
        periodEnd: w.now.toISOString(),
        touchesDecision: null,
      },
    ];
  },
};

// =================================================================================================
// DETECTOR 4 — WORKLOAD SUSTAINABILITY (Watch, escalating to Attention)
// =================================================================================================
//
// READ THE COPY BEFORE CHANGING THE THRESHOLDS. This detector counts two things that are on the
// record — delivery events, and approved leave — and reports their shape. It says nothing about
// anybody's health, because it cannot know anything about anybody's health, and because this system
// is not permitted to conclude it. Every user-facing sentence it produces stays on the records.
//
// It asks for red only when the pattern has held for 180 days AND the recent rate is high. Whether
// it GETS red is admit()'s call: red needs two distinct weight-carrying source types and at least one
// demonstrated or observed record. A person whose only evidence here is the derived rate gets
// yellow, correctly.

const WORKLOAD_HIGH_RATE = 6; // recorded delivery events per 30 days

const workloadSustainability: Detector = {
  key: 'workload_sustainability',
  version: '1.0.0',
  name: 'Workload sustainability',
  description: 'Sustained recorded delivery over a long period with no approved leave recorded in the same period.',
  dimension: 'workload_sustainability',
  maxBand: 'red',
  run(w) {
    const shortStart = daysAgo(w.now, 90);
    const longStart = daysAgo(w.now, 180);
    const recentDelivery = ofType(between(w.events, shortStart, w.now), DELIVERY_TYPES);
    const longDelivery = ofType(between(w.events, longStart, w.now), DELIVERY_TYPES);
    const leaveShort = ofType(between(w.events, shortStart, w.now), ['LeaveApproved']);
    const leaveLong = ofType(between(w.events, longStart, w.now), ['LeaveApproved']);

    const ratePer30 = recentDelivery.length / 3;
    if (ratePer30 < WORKLOAD_HIGH_RATE || leaveShort.length > 0) return [];

    const sustained = leaveLong.length === 0 && longDelivery.length / 6 >= WORKLOAD_HIGH_RATE;
    const band: AttentionBand = sustained ? 'red' : 'yellow';
    const days = sustained ? 180 : 90;

    return [
      {
        detectorKey: workloadSustainability.key,
        detectorVersion: workloadSustainability.version,
        band,
        category: 'workload',
        dimension: workloadSustainability.dimension,
        title: 'Workload Sustainability Watch',
        whatChanged:
          'Recorded delivery has held at ' +
          ratePer30.toFixed(1) +
          ' per 30 days for ' +
          days +
          ' days and no approved leave is recorded for this person in that period.',
        subject: w.subject,
        evidence: evidenceOf(
          sustained ? longDelivery : recentDelivery,
          0.75,
          'A recorded piece of delivery inside the period this signal covers.',
          10,
        ).concat([
          derivedEvidence(
            'workload_rate:' + ratePer30.toFixed(1) + ':' + days,
            'Recorded delivery ran at ' +
              ratePer30.toFixed(1) +
              ' per 30 days across ' +
              days +
              ' days, with no approved leave recorded in that period.',
            w.now,
          ),
        ]),
        inputs: [
          {
            source: 'hr_events',
            description:
              'Counted ' +
              DELIVERY_SENTENCE +
              ' over ' +
              days +
              ' days (' +
              (sustained ? longDelivery.length : recentDelivery.length) +
              '), and LeaveApproved rows in the same period (' +
              (sustained ? leaveLong.length : leaveShort.length) +
              ').',
          },
        ],
        processing:
          'Two counts over one period: recorded delivery, and approved leave. Raised when delivery holds at or above ' +
          WORKLOAD_HIGH_RATE +
          ' per 30 days with no approved leave recorded. This describes RECORDS ONLY. It is not a statement about anybody’s health, it is not a diagnosis of any kind, and leave taken but not recorded here would not be visible to it.',
        recommendedActions: [
          action('review_the_load', 'Look at the load with them.', 'reporting_manager'),
          action(
            'check_leave_record',
            'Check whether leave they have taken is missing from the record.',
            'hr_operations',
          ),
        ],
        periodStart: (sustained ? longStart : shortStart).toISOString(),
        periodEnd: w.now.toISOString(),
        touchesDecision: null,
      },
    ];
  },
};

// =================================================================================================
// THE REGISTRY
// =================================================================================================

export const DETECTORS: readonly Detector[] = Object.freeze([
  growthAlignment,
  leadershipDevelopment,
  submissionConsistency,
  workloadSustainability,
]);

export function detectorByKey(key: string): Detector | null {
  return DETECTORS.find((d) => d.key === key) || null;
}

/**
 * Run every detector (or a named subset) over one person's window.
 *
 * A DETECTOR THAT THROWS DOES NOT TAKE THE SWEEP WITH IT. Its failure is returned in `errors` and
 * reported by the caller — a sweep that goes quiet because one rule has a bug is the failure mode
 * this whole patch exists to avoid.
 */
export function runDetectors(
  w: DetectorWindow,
  keys?: readonly string[],
): { candidates: SignalCandidate[]; errors: { detector: string; error: string }[] } {
  const candidates: SignalCandidate[] = [];
  const errors: { detector: string; error: string }[] = [];
  for (const d of DETECTORS) {
    if (keys && keys.indexOf(d.key) < 0) continue;
    try {
      for (const c of d.run(w) || []) candidates.push(c);
    } catch (e: any) {
      errors.push({ detector: d.key, error: String(e?.cause?.message || e?.message || e) });
    }
  }
  return { candidates, errors };
}
