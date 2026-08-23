// src/lib/behaviour/metrics.ts — PATCH 04: observations in, one number per metric per window out.
//
// PURE, and deliberately so. Every function here takes an array of BehaviouralObservation and
// returns arithmetic over it. No database, no clock, no interpretation — a MetricValue says what the
// rows add up to and stops there. Whether a movement in one of these numbers means anything is
// trend.ts, and it is a separate file so the two can never be read as one claim.
//
// =================================================================================================
// THE FOUR RULES EVERY METRIC IN THIS FILE OBEYS
// =================================================================================================
//
//   1. NULL IS NOT ZERO. A person who closed no tasks this week has an UNKNOWN on-time rate. Zero
//      would be a false record about a human being, and it is the kind of false record that gets
//      screenshotted into a review meeting. Below `minSample` the value is null and `insufficient`
//      is true.
//
//   2. LATENCIES USE THE MEDIAN. One task that sat over somebody's four-week hospital leave moves a
//      mean latency by weeks and describes nothing about how they work. The median describes the
//      typical case, which is the thing the metric claims to describe. Rates use the plain share,
//      because a share of a small denominator is already reported with its `n`.
//
//   3. NOTHING IS WEIGHTED BY PRIORITY. `complexity` segments (compare like with like) and never
//      multiplies. A dropdown somebody picked is not a measurement, and multiplying by it
//      manufactures precision the input never had.
//
//   4. EVERY VALUE CARRIES ITS ROWS. `evidence` is capped for transport at EVIDENCE_CAP and
//      `evidenceCount` is the true total, so a screen can say "12 of 47 shown" rather than implying
//      the number rests on twelve rows.
import type {
  BehaviouralObservation,
  BehaviourMetricKey,
  BehaviourWindow,
  EvidenceRef,
  MetricMeta,
  MetricValue,
} from './types';
import { BEHAVIOUR_METRICS } from './types';
import { toMs } from './windows';

/** How many evidence rows travel with a value. The rest are counted, not carried. */
export const EVIDENCE_CAP = 12;

/**
 * The scale that turns a spread in days into a 0-1 consistency index.
 *
 * Three days: at a stdev of three days the index reads 0.5, which is the point at which "you cannot
 * predict from this person's history whether a given task lands early or late" becomes true in any
 * practical sense. The number is a judgement and it is written down here rather than buried in an
 * expression, so it can be argued with and changed in one place.
 */
export const CONSISTENCY_SCALE_DAYS = 3;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// -------------------------------------------------------------------------------------------------
// THE CATALOGUE. `definition` is shown wherever the number is shown — that is the contract with
// PATCH 05 and with any UI patch, and it is why each one is written as a sentence about ROWS.
// -------------------------------------------------------------------------------------------------

export const METRIC_META: Record<BehaviourMetricKey, MetricMeta> = {
  acceptance_latency_hours: {
    label: 'Time to accept assigned work',
    definition:
      'Median hours between a task being assigned and this person marking it accepted, over tasks where the records hold both events.',
    unit: 'hours',
    betterWhen: 'lower',
    minSample: 3,
    sources: ['audit_log'],
  },
  first_response_latency_hours: {
    label: 'Time to first action on assigned work',
    definition:
      'Median hours between a task being assigned and the first change this person made to it themselves, whatever that change was.',
    unit: 'hours',
    betterWhen: 'lower',
    minSample: 3,
    sources: ['audit_log'],
  },
  on_time_completion_rate: {
    label: 'Completed by the recorded due date',
    definition:
      'Share of tasks completed in this period that carried a due date and were completed on or before it. Tasks with no due date are excluded, not counted as on time.',
    unit: 'ratio',
    betterWhen: 'higher',
    minSample: 3,
    sources: ['audit_log', 'employee_tasks'],
  },
  overdue_days_when_late: {
    label: 'How late, when late',
    definition:
      'Median days past the due date, counting only the tasks that were completed late. It says nothing about how often lateness happens — that is the on-time rate.',
    unit: 'days',
    betterWhen: 'lower',
    minSample: 2,
    sources: ['audit_log', 'employee_tasks'],
  },
  revision_frequency: {
    label: 'Returns per submitted task',
    definition:
      'Mean number of times a submitted task was sent back for further work, per task submitted. A return is recorded against the task, and it reflects the reviewer and the standard applied as much as the work.',
    unit: 'count',
    betterWhen: 'lower',
    minSample: 3,
    sources: ['audit_log'],
  },
  rework_rate: {
    label: 'Tasks returned at least once',
    definition:
      'Share of submitted tasks that were sent back for further work at least once. Same caveat as returns per task: a reviewer who reads closely produces more of these.',
    unit: 'ratio',
    betterWhen: 'lower',
    minSample: 3,
    sources: ['audit_log'],
  },
  follow_through_rate: {
    label: 'Accepted work that reached completion',
    definition:
      'Of the tasks that reached a final state in this period, the share that ended completed or approved rather than cancelled. A cancellation is frequently an organisational decision and not the assignee’s.',
    unit: 'ratio',
    betterWhen: 'higher',
    minSample: 3,
    sources: ['audit_log'],
  },
  blocked_with_stated_reason_rate: {
    label: 'Blocks raised with a stated reason',
    definition:
      'Of the times work was marked blocked, the share where a reason was written down. It measures whether the obstacle was described, not whether being blocked was avoidable.',
    unit: 'ratio',
    betterWhen: 'higher',
    minSample: 2,
    sources: ['audit_log'],
  },
  self_driven_transition_share: {
    label: 'Changes made by this person on their own tasks',
    definition:
      'Share of recorded changes to this person’s tasks that were made from their own login rather than by somebody else. A low figure may describe how their manager works the board, not how they work.',
    unit: 'ratio',
    betterWhen: 'neutral',
    minSample: 5,
    sources: ['audit_log'],
  },
  project_participation_count: {
    label: 'Distinct projects with recorded activity',
    definition:
      'Number of different projects this person had at least one recorded task event on during the period. It counts breadth of involvement, nothing about contribution.',
    unit: 'count',
    betterWhen: 'neutral',
    minSample: 1,
    sources: ['audit_log', 'employee_tasks'],
  },
  assessment_submission_rate: {
    label: 'Started assessments that were submitted',
    definition:
      'Of the assessment attempts begun in this period, the share that reached submission. It counts submission behaviour only and reads no score.',
    unit: 'ratio',
    betterWhen: 'higher',
    minSample: 3,
    sources: ['edu_attempts'],
  },
  assessment_time_to_submit_hours: {
    label: 'Time taken between starting and submitting',
    definition:
      'Median hours between starting an assessment attempt and submitting it. Faster is not better and slower is not worse; this is here to make a change in working pattern visible, not to rank anyone.',
    unit: 'hours',
    betterWhen: 'neutral',
    minSample: 3,
    sources: ['edu_attempts'],
  },
  timing_consistency: {
    label: 'Predictability of delivery against due dates',
    definition:
      'An index from 0 to 1 computed as 1 / (1 + spread / 3 days), where spread is the standard deviation of days early or late across completed tasks that carried a due date. 1 means every task lands the same distance from its due date; it does not mean on time.',
    unit: 'index',
    betterWhen: 'higher',
    minSample: 4,
    sources: ['audit_log', 'employee_tasks'],
  },
};

// -------------------------------------------------------------------------------------------------
// REASSEMBLING A TASK FROM ITS EVENTS
// -------------------------------------------------------------------------------------------------

/**
 * One task's recorded life, rebuilt from the transition rows.
 *
 * FIRSTS AND LASTS ARE DIFFERENT QUESTIONS. `acceptedAtMs` is the FIRST acceptance — a task accepted,
 * returned and accepted again has one acceptance latency, measured from the original assignment, and
 * taking the last one would report a re-acceptance days later as though the person had ignored the
 * work all week. `completedAtMs` is the LAST completion for the mirror-image reason: a task completed,
 * reopened and completed again finished when it finished.
 */
export interface TaskTrace {
  taskId: string;
  assignedAtMs: number | null;
  acceptedAtMs: number | null;
  firstSelfActionMs: number | null;
  submittedAtMs: number | null;
  completedAtMs: number | null;
  cancelledAtMs: number | null;
  returnCount: number;
  blockedCount: number;
  blockedWithReasonCount: number;
  dueMs: number | null;
  complexity: string | null;
  /** Every row that contributed, in occurrence order. */
  evidence: EvidenceRef[];
}

/**
 * A due DATE means the end of that day, not its first instant.
 *
 * `employee_tasks.due_on` is a DATE. Read as midnight, a task due on the 14th and completed at 3pm
 * on the 14th is "one day late", which is wrong, and wrong in the direction that makes people look
 * worse. The end of the local day is what "due on the 14th" means to the person who was told it.
 */
export function dueInstantMs(dueIso: string | null, tzOffsetMinutes: number): number | null {
  if (!dueIso) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dueIso.trim());
  const base = toMs(dateOnly ? `${dueIso.trim()}T00:00:00Z` : dueIso);
  if (base === null) return null;
  // Shift a bare date from UTC midnight to the end of that day in the working zone.
  return dateOnly ? base + MS_PER_DAY - tzOffsetMinutes * 60_000 - 1 : base;
}

export function buildTraces(
  observations: BehaviouralObservation[],
  tzOffsetMinutes: number,
): Map<string, TaskTrace> {
  const traces = new Map<string, TaskTrace>();

  const ordered = [...observations].sort(
    (a, b) => (toMs(a.occurredAt) ?? 0) - (toMs(b.occurredAt) ?? 0),
  );

  for (const o of ordered) {
    if (!o.workRef || o.workRef.table !== 'employee_tasks') continue;
    const id = o.workRef.id;
    let t = traces.get(id);
    if (!t) {
      t = {
        taskId: id,
        assignedAtMs: null,
        acceptedAtMs: null,
        firstSelfActionMs: null,
        submittedAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
        returnCount: 0,
        blockedCount: 0,
        blockedWithReasonCount: 0,
        dueMs: null,
        complexity: null,
        evidence: [],
      };
      traces.set(id, t);
    }

    const at = toMs(o.occurredAt);
    if (at === null) continue;
    t.evidence.push(o.evidence);
    if (t.dueMs === null) t.dueMs = dueInstantMs(o.dueAt, tzOffsetMinutes);
    if (t.complexity === null && o.complexity) t.complexity = o.complexity;

    // Only the subject's own actions count as a response. A manager dragging the card is not the
    // person responding to the work, and counting it as one would report a fast response for
    // somebody who never opened it.
    if (o.selfDriven === true && t.firstSelfActionMs === null && o.kind !== 'task.assigned') {
      t.firstSelfActionMs = at;
    }

    switch (o.kind) {
      case 'task.assigned':
        if (t.assignedAtMs === null) t.assignedAtMs = at;
        break;
      case 'task.accepted':
        if (t.acceptedAtMs === null) t.acceptedAtMs = at;
        break;
      case 'task.submitted':
        if (t.submittedAtMs === null) t.submittedAtMs = at;
        break;
      case 'task.returned':
        t.returnCount += 1;
        break;
      case 'task.blocked':
        t.blockedCount += 1;
        // A reason is carried in the evidence statement by sources.ts; its absence is recorded
        // there rather than guessed here.
        if (/reason:/i.test(o.evidence.statement)) t.blockedWithReasonCount += 1;
        break;
      case 'task.completed':
      case 'task.approved':
        t.completedAtMs = at;
        break;
      case 'task.cancelled':
        t.cancelledAtMs = at;
        break;
      default:
        break;
    }
  }

  return traces;
}

// -------------------------------------------------------------------------------------------------
// SMALL STATISTICS, WRITTEN OUT RATHER THAN IMPORTED
// -------------------------------------------------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation. Population, not sample: this describes the rows we have, not an estimate of a wider one. */
export function stdev(values: number[]): number | null {
  if (values.length === 0) return null;
  const m = mean(values) as number;
  const v = values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
  return Math.sqrt(v);
}

/** Two decimal places. Reporting 4.3871 hours claims a precision the source timestamps do not carry. */
export function round2(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}

function valueOf(
  key: BehaviourMetricKey,
  window: BehaviourWindow,
  raw: number | null,
  n: number,
  evidence: EvidenceRef[],
  notes: string[] = [],
): MetricValue {
  const meta = METRIC_META[key];
  const insufficient = n < meta.minSample || raw === null;
  return {
    key,
    window,
    value: insufficient ? null : round2(raw),
    unit: meta.unit,
    n,
    insufficient,
    evidence: evidence.slice(0, EVIDENCE_CAP),
    evidenceCount: evidence.length,
    notes: insufficient
      ? [
          ...notes,
          `Not reported: ${n} record${n === 1 ? '' : 's'} in this period, and this metric needs at least ${meta.minSample}. This is unknown, not zero.`,
        ]
      : notes,
  };
}

// -------------------------------------------------------------------------------------------------
// THE METRICS
// -------------------------------------------------------------------------------------------------

export interface MetricInput {
  observations: BehaviouralObservation[];
  window: BehaviourWindow;
  tzOffsetMinutes: number;
}

/**
 * COMPUTE EVERY METRIC over one window's observations.
 *
 * Traces are built once and shared. Rebuilding them per metric was the first shape of this function
 * and it was thirteen passes over the same rows to answer thirteen questions about the same tasks.
 */
export function computeMetrics(input: MetricInput): MetricValue[] {
  const { observations, window, tzOffsetMinutes } = input;
  const traces = [...buildTraces(observations, tzOffsetMinutes).values()];
  const out: MetricValue[] = [];

  // --- acceptance latency -------------------------------------------------------------------
  {
    const vals: number[] = [];
    const ev: EvidenceRef[] = [];
    for (const t of traces) {
      if (t.assignedAtMs === null || t.acceptedAtMs === null) continue;
      const hours = (t.acceptedAtMs - t.assignedAtMs) / MS_PER_HOUR;
      if (hours < 0) continue;   // clock skew or a backfilled row; not a negative latency
      vals.push(hours);
      ev.push(...t.evidence.slice(0, 2));
    }
    out.push(valueOf('acceptance_latency_hours', window, median(vals), vals.length, ev));
  }

  // --- first response latency ---------------------------------------------------------------
  {
    const vals: number[] = [];
    const ev: EvidenceRef[] = [];
    for (const t of traces) {
      if (t.assignedAtMs === null || t.firstSelfActionMs === null) continue;
      const hours = (t.firstSelfActionMs - t.assignedAtMs) / MS_PER_HOUR;
      if (hours < 0) continue;
      vals.push(hours);
      ev.push(...t.evidence.slice(0, 2));
    }
    out.push(
      valueOf('first_response_latency_hours', window, median(vals), vals.length, ev, [
        'Counts only changes made from this person’s own login. Tasks moved on their behalf are not a response.',
      ]),
    );
  }

  // --- on-time completion, lateness, consistency --------------------------------------------
  {
    const completedWithDue = traces.filter((t) => t.completedAtMs !== null && t.dueMs !== null);
    const ev: EvidenceRef[] = [];
    let onTime = 0;
    const lateDays: number[] = [];
    const deltaDays: number[] = [];
    for (const t of completedWithDue) {
      const delta = ((t.completedAtMs as number) - (t.dueMs as number)) / MS_PER_DAY;
      deltaDays.push(delta);
      ev.push(...t.evidence.slice(-2));
      if (delta <= 0) onTime += 1;
      else lateDays.push(delta);
    }
    const withoutDue = traces.filter((t) => t.completedAtMs !== null && t.dueMs === null).length;
    const notes: string[] = [];
    if (withoutDue > 0) {
      notes.push(
        `${withoutDue} task${withoutDue === 1 ? '' : 's'} completed in this period carried no due date and ${withoutDue === 1 ? 'is' : 'are'} excluded rather than counted as on time.`,
      );
    }
    out.push(
      valueOf(
        'on_time_completion_rate',
        window,
        completedWithDue.length ? onTime / completedWithDue.length : null,
        completedWithDue.length,
        ev,
        notes,
      ),
    );
    out.push(
      valueOf('overdue_days_when_late', window, median(lateDays), lateDays.length, ev, [
        'Counts only tasks completed after the due date. It does not say how often that happened.',
      ]),
    );

    const spread = stdev(deltaDays);
    const consistency = spread === null ? null : 1 / (1 + spread / CONSISTENCY_SCALE_DAYS);
    out.push(
      valueOf('timing_consistency', window, consistency, deltaDays.length, ev, [
        spread === null
          ? 'No completed task carried a due date in this period.'
          : `Spread of delivery around the due date: ${round2(spread)} days. Consistency describes predictability, not punctuality — reliably three days late scores high.`,
      ]),
    );
  }

  // --- revision frequency and rework rate ---------------------------------------------------
  {
    const submitted = traces.filter((t) => t.submittedAtMs !== null);
    const ev: EvidenceRef[] = [];
    let returns = 0;
    let reworked = 0;
    for (const t of submitted) {
      returns += t.returnCount;
      if (t.returnCount > 0) {
        reworked += 1;
        ev.push(...t.evidence.slice(-2));
      }
    }
    const sharedNote =
      'A return is a reviewer’s decision as much as the submitter’s work. Read it with who reviewed, not alone.';
    out.push(
      valueOf(
        'revision_frequency',
        window,
        submitted.length ? returns / submitted.length : null,
        submitted.length,
        ev,
        [sharedNote],
      ),
    );
    out.push(
      valueOf(
        'rework_rate',
        window,
        submitted.length ? reworked / submitted.length : null,
        submitted.length,
        ev,
        [sharedNote],
      ),
    );
  }

  // --- follow-through -----------------------------------------------------------------------
  {
    const terminal = traces.filter((t) => t.completedAtMs !== null || t.cancelledAtMs !== null);
    const ev: EvidenceRef[] = [];
    let finished = 0;
    for (const t of terminal) {
      if (t.completedAtMs !== null) finished += 1;
      else ev.push(...t.evidence.slice(-2));
    }
    const open = traces.length - terminal.length;
    const notes = [
      'Tasks still open are excluded, so work in flight cannot drag this down.',
      'A cancellation is often an organisational decision and not the assignee’s.',
    ];
    if (open > 0) notes.push(`${open} task${open === 1 ? '' : 's'} in this period had not reached a final state.`);
    out.push(
      valueOf(
        'follow_through_rate',
        window,
        terminal.length ? finished / terminal.length : null,
        terminal.length,
        ev,
        notes,
      ),
    );
  }

  // --- blocks with a stated reason ----------------------------------------------------------
  {
    let blocked = 0;
    let withReason = 0;
    const ev: EvidenceRef[] = [];
    for (const t of traces) {
      blocked += t.blockedCount;
      withReason += t.blockedWithReasonCount;
      if (t.blockedCount > 0) ev.push(...t.evidence.slice(-2));
    }
    out.push(
      valueOf(
        'blocked_with_stated_reason_rate',
        window,
        blocked ? withReason / blocked : null,
        blocked,
        ev,
        ['Describes whether an obstacle was written down, not whether it should have arisen.'],
      ),
    );
  }

  // --- self-driven share --------------------------------------------------------------------
  {
    const known = observations.filter(
      (o) => o.selfDriven !== null && o.kind !== 'task.assigned' && o.workRef?.table === 'employee_tasks',
    );
    const self = known.filter((o) => o.selfDriven === true).length;
    const unknown = observations.filter(
      (o) => o.selfDriven === null && o.workRef?.table === 'employee_tasks',
    ).length;
    const notes = [
      'A low share can describe how somebody else works the board rather than how this person works.',
    ];
    if (unknown > 0) {
      notes.push(
        `${unknown} record${unknown === 1 ? '' : 's'} named no actor, or the person has no linked login; ${unknown === 1 ? 'it is' : 'they are'} excluded rather than assumed.`,
      );
    }
    out.push(
      valueOf(
        'self_driven_transition_share',
        window,
        known.length ? self / known.length : null,
        known.length,
        known.slice(0, EVIDENCE_CAP).map((o) => o.evidence),
        notes,
      ),
    );
  }

  // --- project participation ----------------------------------------------------------------
  {
    const projects = new Set<string>();
    const ev: EvidenceRef[] = [];
    for (const o of observations) {
      if (o.kind !== 'task.project_linked') continue;
      const id = String(o.to || '').trim();
      if (!id) continue;
      if (!projects.has(id)) ev.push(o.evidence);
      projects.add(id);
    }
    out.push(
      valueOf('project_participation_count', window, projects.size || null, projects.size, ev, [
        'Counts projects with a recorded task link. It says nothing about the size or nature of the involvement.',
      ]),
    );
  }

  // --- assessment behaviour -----------------------------------------------------------------
  {
    const started = observations.filter((o) => o.kind === 'assessment.started');
    const submitted = observations.filter((o) => o.kind === 'assessment.submitted');
    const submittedIds = new Set(submitted.map((o) => o.workRef?.id).filter(Boolean) as string[]);
    const startedIds = started.map((o) => o.workRef?.id).filter(Boolean) as string[];
    const matched = startedIds.filter((id) => submittedIds.has(id)).length;
    const scoreNote =
      'Reads submission behaviour only. No score, mark or pass result is read anywhere in this patch.';
    out.push(
      valueOf(
        'assessment_submission_rate',
        window,
        startedIds.length ? matched / startedIds.length : null,
        startedIds.length,
        started.slice(0, EVIDENCE_CAP).map((o) => o.evidence),
        [scoreNote],
      ),
    );

    const byId = new Map(started.map((o) => [o.workRef?.id || '', toMs(o.occurredAt)]));
    const hours: number[] = [];
    for (const s of submitted) {
      const startAt = byId.get(s.workRef?.id || '');
      const endAt = toMs(s.occurredAt);
      if (!startAt || endAt === null) continue;
      const h = (endAt - startAt) / MS_PER_HOUR;
      if (h >= 0) hours.push(h);
    }
    out.push(
      valueOf(
        'assessment_time_to_submit_hours',
        window,
        median(hours),
        hours.length,
        submitted.slice(0, EVIDENCE_CAP).map((o) => o.evidence),
        [scoreNote, 'Faster is not better here. This exists to make a change in pattern visible.'],
      ),
    );
  }

  // Emitted in catalogue order so two surfaces cannot list them differently.
  const order = new Map(BEHAVIOUR_METRICS.map((k, i) => [k, i] as const));
  return out.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/** One metric over one set of observations. Used by trend.ts for baselines and sub-periods. */
export function computeMetric(key: BehaviourMetricKey, input: MetricInput): MetricValue {
  const found = computeMetrics(input).find((m) => m.key === key);
  // Unreachable while computeMetrics covers the catalogue; a new key added to BEHAVIOUR_METRICS
  // without a computation lands here and says so rather than reading as a person with no data.
  return (
    found || {
      key,
      window: input.window,
      value: null,
      unit: METRIC_META[key].unit,
      n: 0,
      insufficient: true,
      evidence: [],
      evidenceCount: 0,
      notes: ['This metric has no computation in this build and was not evaluated.'],
    }
  );
}
