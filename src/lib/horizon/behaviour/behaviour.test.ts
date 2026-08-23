// src/lib/behaviour/behaviour.test.ts — PATCH 04.
//
// Vitest, not the house shim: the shim's it() is synchronous and never awaits an async body, so an
// async test written against it passes while asserting nothing.
//
// EVERY TEST HERE RUNS WITHOUT A DATABASE. That is the design being verified as much as the
// arithmetic: windows, metrics, trends and confidence are pure, and `classify()` is exported from
// the read layer precisely so the audit-row mapping can be checked against fixtures rather than
// against production rows about real people.
//
// The suite is organised around the claims this patch makes about itself, not around its files. A
// test named "null is not zero" fails loudly the day somebody makes an empty week render as 0%.
import { describe, it, expect } from 'vitest';
import type { BehaviouralObservation, BehaviourComplexity, EvidenceRef } from './types';
import {
  resolveWindow,
  precedingPeriod,
  subPeriods,
  withinWindow,
  RECENT_DAYS,
  DEFAULT_TZ_OFFSET_MINUTES,
} from './windows';
import { computeMetrics, METRIC_META, dueInstantMs, median, stdev } from './metrics';
import { assessTrend, assessPattern, MIN_RELATIVE_CHANGE, type SubPeriodValue } from './trend';
import { assessConfidence } from './confidence';
import { classify } from './sources';

const EMP = '11111111-1111-4111-8111-111111111111';
const SELF = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOSS = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let seq = 0;
function ev(occurredAt: string, statement = 'status assigned to accepted'): EvidenceRef {
  seq += 1;
  return {
    sourceTable: 'audit_log',
    sourceId: `row-${seq}`,
    sourceField: 'diff.to',
    occurredAt,
    statement,
    collectedVia: 'authorised_system_record',
  };
}

interface ObsOpts {
  taskId?: string;
  self?: boolean | null;
  due?: string | null;
  complexity?: BehaviourComplexity | null;
  from?: string | null;
  to?: string | null;
  statement?: string;
  table?: 'employee_tasks' | 'edu_attempts';
}

function obs(kind: BehaviouralObservation['kind'], occurredAt: string, o: ObsOpts = {}): BehaviouralObservation {
  const table = o.table || 'employee_tasks';
  const id = o.taskId || 't1';
  return {
    kind,
    employeeId: EMP,
    occurredAt,
    actorUserId: o.self === false ? BOSS : SELF,
    selfDriven: o.self === undefined ? true : o.self,
    workRef: { table, id },
    complexity: o.complexity ?? null,
    dueAt: o.due ?? null,
    from: o.from ?? null,
    to: o.to ?? null,
    evidence: { ...ev(occurredAt, o.statement), workRef: { table, id } },
  };
}

/** One task's whole life, so the metric tests read like the thing they are testing. */
function task(
  id: string,
  p: { assigned: string; accepted?: string; submitted?: string; returned?: string[]; completed?: string; cancelled?: string; due?: string | null; self?: boolean },
): BehaviouralObservation[] {
  const out: BehaviouralObservation[] = [];
  const base = { taskId: id, due: p.due ?? null, self: p.self ?? true };
  out.push(obs('task.assigned', p.assigned, { ...base, self: false, to: 'assigned' }));
  if (p.accepted) out.push(obs('task.accepted', p.accepted, { ...base, from: 'assigned', to: 'accepted' }));
  if (p.submitted) out.push(obs('task.submitted', p.submitted, { ...base, from: 'in_progress', to: 'under_review' }));
  for (const r of p.returned || []) {
    out.push(obs('task.returned', r, { ...base, self: false, from: 'under_review', to: 'in_progress' }));
  }
  if (p.completed) out.push(obs('task.completed', p.completed, { ...base, from: 'under_review', to: 'completed' }));
  if (p.cancelled) out.push(obs('task.cancelled', p.cancelled, { ...base, self: false, from: 'assigned', to: 'cancelled' }));
  return out;
}

const TZ = DEFAULT_TZ_OFFSET_MINUTES;
const metricsOf = (o: BehaviouralObservation[]) =>
  new Map(computeMetrics({ observations: o, window: 'this_month', tzOffsetMinutes: TZ }).map((m) => [m.key, m]));

// =================================================================================================
describe('windows', () => {
  // Wednesday 2026-08-19, 10:00 IST == 04:30Z.
  const NOW = Date.parse('2026-08-19T04:30:00Z');

  it('starts the week on Monday in the working zone, not on Sunday and not in UTC', () => {
    const w = resolveWindow('this_week', NOW, {});
    // Monday 2026-08-17 00:00 IST is 2026-08-16T18:30Z.
    expect(w.fromIso).toBe('2026-08-16T18:30:00Z');
  });

  it('starts the month at local midnight on the first', () => {
    const w = resolveWindow('this_month', NOW, {});
    expect(w.fromIso).toBe('2026-07-31T18:30:00Z');
  });

  it('starts the quarter at the first day of the quarter, not the month', () => {
    const w = resolveWindow('this_quarter', NOW, {});
    // Q3 begins 1 July.
    expect(w.fromIso).toBe('2026-06-30T18:30:00Z');
  });

  it('reaches back exactly RECENT_DAYS for the rolling window', () => {
    const w = resolveWindow('recent', NOW, {});
    expect(Math.round((NOW - Date.parse(w.fromIso)) / 86_400_000)).toBe(RECENT_DAYS);
  });

  it('clamps a window to the joining date and SAYS it did', () => {
    const joined = Date.parse('2026-08-10T00:00:00Z');
    const w = resolveWindow('this_year', NOW, { employedFromMs: joined });
    expect(w.clampedToEmployment).toBe(true);
    expect(w.fromIso).toBe('2026-08-10T00:00:00Z');
    expect(w.statement).toMatch(/joining date/i);
  });

  it('does not call the history window "clamped" when it simply starts at the joining date', () => {
    const joined = Date.parse('2026-01-05T00:00:00Z');
    const w = resolveWindow('employment_history', NOW, { employedFromMs: joined });
    expect(w.clampedToEmployment).toBe(false);
  });

  it('ends a departed colleague’s window at their last working day, not at now', () => {
    const left = Date.parse('2026-08-01T00:00:00Z');
    const w = resolveWindow('this_year', NOW, { employedToMs: left });
    expect(w.toIso).toBe('2026-08-01T00:00:00Z');
  });

  it('says so, rather than inventing a start date, when no joining date is on file', () => {
    const w = resolveWindow('employment_history', NOW, {});
    expect(w.fromIso).toBe('');
    expect(w.statement).toMatch(/no joining date on file/i);
  });

  it('gives the comparison period the SAME length as the window, not the previous calendar month', () => {
    const w = resolveWindow('this_month', NOW, {});
    const prior = precedingPeriod(w, {});
    expect(prior).not.toBeNull();
    expect(prior!.days).toBe(w.days);
    expect(prior!.toIso).toBe(w.fromIso);
  });

  it('refuses a comparison period that would fall before the person joined', () => {
    const joined = Date.parse('2026-08-01T00:00:00Z');
    const w = resolveWindow('this_month', NOW, { employedFromMs: joined });
    expect(precedingPeriod(w, { employedFromMs: joined })).toBeNull();
  });

  it('cuts a window into contiguous buckets that end exactly on the window end', () => {
    const w = resolveWindow('this_month', NOW, {});
    const b = subPeriods(w, 6);
    expect(b).toHaveLength(6);
    expect(b[0].fromIso).toBe(w.fromIso);
    expect(b[5].toIso).toBe(w.toIso);
    for (let i = 1; i < b.length; i++) expect(b[i].fromIso).toBe(b[i - 1].toIso);
  });

  it('treats the window as half-open so one event cannot land in two periods', () => {
    expect(withinWindow('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')).toBe(true);
    expect(withinWindow('2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')).toBe(false);
  });
});

// =================================================================================================
describe('classify — what an audit row means', () => {
  it('reads a bounce back from review as REWORK, not as ordinary progress', () => {
    expect(classify('task.status', 'under_review', 'in_progress')).toBe('task.returned');
  });

  it('reads leaving blocked as an unblock, whatever it moved to', () => {
    expect(classify('task.status', 'blocked', 'in_progress')).toBe('task.unblocked');
  });

  it('maps the ordinary transitions by destination', () => {
    expect(classify('task.status', 'assigned', 'accepted')).toBe('task.accepted');
    expect(classify('task.status', 'in_progress', 'under_review')).toBe('task.submitted');
    expect(classify('task.status', 'under_review', 'completed')).toBe('task.completed');
    expect(classify('task.status', 'assigned', 'cancelled')).toBe('task.cancelled');
    expect(classify('task.assign', null, 'assigned')).toBe('task.assigned');
    expect(classify('task.complete', null, null)).toBe('task.completed');
    expect(classify('task.project.set', null, null)).toBe('task.project_linked');
  });

  it('DROPS a row it cannot classify rather than filing it under a near neighbour', () => {
    expect(classify('task.status', 'assigned', 'something_new')).toBeNull();
    expect(classify('task.collaborator.add', null, null)).toBeNull();
    expect(classify('leave.approve', null, null)).toBeNull();
  });
});

// =================================================================================================
describe('metrics — null is not zero', () => {
  it('reports an unknown on-time rate, not 0%, when nothing was completed', () => {
    const m = metricsOf([obs('task.assigned', '2026-08-03T09:00:00Z')]);
    const rate = m.get('on_time_completion_rate')!;
    expect(rate.value).toBeNull();
    expect(rate.insufficient).toBe(true);
    expect(rate.notes.join(' ')).toMatch(/unknown, not zero/i);
  });

  it('withholds a value below the metric’s minimum sample and says how many it had', () => {
    const o = [
      ...task('a', { assigned: '2026-08-01T09:00:00Z', accepted: '2026-08-01T11:00:00Z' }),
      ...task('b', { assigned: '2026-08-02T09:00:00Z', accepted: '2026-08-02T10:00:00Z' }),
    ];
    const m = metricsOf(o).get('acceptance_latency_hours')!;
    expect(m.n).toBe(2);
    expect(METRIC_META.acceptance_latency_hours.minSample).toBe(3);
    expect(m.value).toBeNull();
    expect(m.insufficient).toBe(true);
  });
});

describe('metrics — what the numbers actually count', () => {
  it('treats a due DATE as the end of that day, so finishing at 3pm on the due date is on time', () => {
    const due = dueInstantMs('2026-08-14', TZ)!;
    // 2026-08-14 15:00 IST == 09:30Z, comfortably inside the day.
    expect(Date.parse('2026-08-14T09:30:00Z')).toBeLessThan(due);
    // 2026-08-15 00:30 IST is the next day and is late.
    expect(Date.parse('2026-08-14T19:00:00Z')).toBeGreaterThan(due);
  });

  it('excludes tasks with no due date rather than counting them as on time, and says how many', () => {
    const o = [
      ...task('a', { assigned: '2026-08-01T09:00:00Z', completed: '2026-08-05T09:00:00Z', due: '2026-08-06' }),
      ...task('b', { assigned: '2026-08-01T09:00:00Z', completed: '2026-08-05T09:00:00Z', due: '2026-08-06' }),
      ...task('c', { assigned: '2026-08-01T09:00:00Z', completed: '2026-08-05T09:00:00Z', due: '2026-08-06' }),
      ...task('d', { assigned: '2026-08-01T09:00:00Z', completed: '2026-08-20T09:00:00Z', due: null }),
    ];
    const m = metricsOf(o).get('on_time_completion_rate')!;
    expect(m.n).toBe(3);
    expect(m.value).toBe(1);
    expect(m.notes.join(' ')).toMatch(/carried no due date/i);
  });

  it('counts a return as rework and reports both the rate and the frequency', () => {
    const o = [
      ...task('a', { assigned: '2026-08-01T09:00:00Z', submitted: '2026-08-03T09:00:00Z', returned: ['2026-08-04T09:00:00Z', '2026-08-05T09:00:00Z'], completed: '2026-08-06T09:00:00Z' }),
      ...task('b', { assigned: '2026-08-01T09:00:00Z', submitted: '2026-08-03T09:00:00Z', completed: '2026-08-04T09:00:00Z' }),
      ...task('c', { assigned: '2026-08-01T09:00:00Z', submitted: '2026-08-03T09:00:00Z', completed: '2026-08-04T09:00:00Z' }),
      ...task('d', { assigned: '2026-08-01T09:00:00Z', submitted: '2026-08-03T09:00:00Z', completed: '2026-08-04T09:00:00Z' }),
    ];
    const m = metricsOf(o);
    expect(m.get('rework_rate')!.value).toBe(0.25);
    expect(m.get('revision_frequency')!.value).toBe(0.5);
  });

  it('names the reviewer’s part in every rework figure', () => {
    const o = ['a', 'b', 'c'].flatMap((id) =>
      task(id, { assigned: '2026-08-01T09:00:00Z', submitted: '2026-08-03T09:00:00Z', returned: ['2026-08-04T09:00:00Z'] }),
    );
    const m = metricsOf(o);
    expect(m.get('rework_rate')!.notes.join(' ')).toMatch(/reviewer/i);
    expect(m.get('revision_frequency')!.notes.join(' ')).toMatch(/reviewer/i);
  });

  it('does not count somebody else moving the card as this person responding', () => {
    const o = [
      obs('task.assigned', '2026-08-01T09:00:00Z', { taskId: 'a', self: false, to: 'assigned' }),
      obs('task.progress', '2026-08-01T10:00:00Z', { taskId: 'a', self: false, from: 'assigned', to: 'in_progress' }),
      ...task('b', { assigned: '2026-08-01T09:00:00Z', accepted: '2026-08-01T13:00:00Z' }),
      ...task('c', { assigned: '2026-08-01T09:00:00Z', accepted: '2026-08-01T13:00:00Z' }),
      ...task('d', { assigned: '2026-08-01T09:00:00Z', accepted: '2026-08-01T13:00:00Z' }),
    ];
    const m = metricsOf(o).get('first_response_latency_hours')!;
    // Task 'a' contributes nothing: nobody with this person's login touched it.
    expect(m.n).toBe(3);
    expect(m.value).toBe(4);
  });

  it('excludes unknown attribution instead of assuming somebody had to push them', () => {
    const o = [
      obs('task.accepted', '2026-08-01T10:00:00Z', { taskId: 'a', self: null, from: 'assigned', to: 'accepted' }),
      obs('task.progress', '2026-08-01T11:00:00Z', { taskId: 'a', self: null, from: 'accepted', to: 'in_progress' }),
    ];
    const m = metricsOf(o).get('self_driven_transition_share')!;
    expect(m.n).toBe(0);
    expect(m.value).toBeNull();
    expect(m.notes.join(' ')).toMatch(/excluded rather than assumed/i);
  });

  it('reads submission behaviour from assessments and never a score', () => {
    const started = ['x', 'y', 'z', 'w'].map((id, i) =>
      obs('assessment.started', `2026-08-0${i + 1}T09:00:00Z`, { taskId: id, table: 'edu_attempts' }),
    );
    const submitted = ['x', 'y', 'z'].map((id, i) =>
      obs('assessment.submitted', `2026-08-0${i + 1}T11:00:00Z`, { taskId: id, table: 'edu_attempts' }),
    );
    const m = metricsOf([...started, ...submitted]);
    expect(m.get('assessment_submission_rate')!.value).toBe(0.75);
    expect(m.get('assessment_time_to_submit_hours')!.value).toBe(2);
    expect(m.get('assessment_submission_rate')!.notes.join(' ')).toMatch(/No score, mark or pass result/i);
  });

  it('scores predictability, not punctuality — reliably late is consistent', () => {
    const late = ['a', 'b', 'c', 'd'].map((id) =>
      task(id, { assigned: '2026-08-01T09:00:00Z', completed: '2026-08-08T06:00:00Z', due: '2026-08-05' }),
    ).flat();
    const m = metricsOf(late).get('timing_consistency')!;
    expect(m.value).toBeGreaterThan(0.9);
    expect(m.notes.join(' ')).toMatch(/not punctuality/i);
  });

  it('uses the median for latency so one abandoned task cannot describe a person', () => {
    expect(median([1, 2, 3, 400])).toBe(2.5);
    expect(stdev([5, 5, 5, 5])).toBe(0);
  });

  it('carries the rows behind every value and counts the ones it did not carry', () => {
    const o = Array.from({ length: 20 }, (_, i) =>
      task(`t${i}`, {
        assigned: `2026-08-01T0${i % 9}:00:00Z`,
        accepted: `2026-08-01T0${(i % 9) + 1}:00:00Z`,
      }),
    ).flat();
    const m = metricsOf(o).get('acceptance_latency_hours')!;
    expect(m.evidence.length).toBeLessThanOrEqual(12);
    expect(m.evidenceCount).toBeGreaterThan(m.evidence.length);
    expect(m.evidence[0].collectedVia).toBe('authorised_system_record');
  });
});

// =================================================================================================
describe('trend — noise is not movement', () => {
  const resolved = resolveWindow('this_month', Date.parse('2026-08-19T04:30:00Z'), {});

  const mv = (key: any, value: number | null, n = 10): any => ({
    key,
    window: 'this_month',
    value,
    unit: METRIC_META[key as keyof typeof METRIC_META].unit,
    n,
    insufficient: value === null,
    evidence: [],
    evidenceCount: n,
    notes: [],
  });

  const base = {
    resolved,
    baselineKind: 'preceding_period' as const,
    baselineFromIso: '2026-07-01T00:00:00Z',
    baselineToIso: '2026-07-31T18:30:00Z',
    subPeriods: [] as SubPeriodValue[],
    staleDays: 2,
    sourcesRead: 3,
    sourcesExpected: 3,
    unreadable: false,
  };

  it('calls a change inside the tolerance STABLE, and names the tolerance on the result', () => {
    const t = assessTrend({
      ...base,
      key: 'on_time_completion_rate',
      current: mv('on_time_completion_rate', 0.8),
      baselineMetric: mv('on_time_completion_rate', 0.75),
    });
    expect(Math.abs(t.relativeChange!)).toBeLessThan(MIN_RELATIVE_CHANGE);
    expect(t.verdict).toBe('stable');
    expect(t.baseline.toleranceRelative).toBe(MIN_RELATIVE_CHANGE);
  });

  it('reads a rise in a higher-is-better metric as improving', () => {
    const t = assessTrend({
      ...base,
      key: 'on_time_completion_rate',
      current: mv('on_time_completion_rate', 0.9),
      baselineMetric: mv('on_time_completion_rate', 0.5),
    });
    expect(t.verdict).toBe('improving');
  });

  it('reads a rise in a lower-is-better metric as declining', () => {
    const t = assessTrend({
      ...base,
      key: 'acceptance_latency_hours',
      current: mv('acceptance_latency_hours', 40),
      baselineMetric: mv('acceptance_latency_hours', 10),
    });
    expect(t.verdict).toBe('declining');
  });

  it('refuses to call a neutral metric better or worse, and still reports that it moved', () => {
    const t = assessTrend({
      ...base,
      key: 'assessment_time_to_submit_hours',
      current: mv('assessment_time_to_submit_hours', 9),
      baselineMetric: mv('assessment_time_to_submit_hours', 4),
    });
    expect(t.verdict).toBe('changed_without_direction');
    expect(t.statement).toMatch(/does not judge as better or worse/i);
  });

  it('says "could not be assessed" — not "stable" — when there is no baseline', () => {
    const t = assessTrend({
      ...base,
      key: 'on_time_completion_rate',
      current: mv('on_time_completion_rate', 0.9),
      baselineMetric: null,
      baselineKind: 'none',
      baselineFromIso: null,
      baselineToIso: null,
    });
    expect(t.verdict).toBe('insufficient_evidence');
    expect(t.baseline.kind).toBe('none');
    expect(t.statement).toMatch(/unknown, not a finding/i);
  });

  it('says "could not be assessed" when the period under review is too thin', () => {
    const t = assessTrend({
      ...base,
      key: 'on_time_completion_rate',
      current: { ...mv('on_time_completion_rate', null, 1), insufficient: true },
      baselineMetric: mv('on_time_completion_rate', 0.5),
    });
    expect(t.verdict).toBe('insufficient_evidence');
  });

  it('names the baseline it used, so "improving" can be argued with', () => {
    const t = assessTrend({
      ...base,
      key: 'on_time_completion_rate',
      current: mv('on_time_completion_rate', 0.9),
      baselineMetric: mv('on_time_completion_rate', 0.5),
      baselineKind: 'employment_history',
    });
    expect(t.baseline.statement).toMatch(/everything on record for this person/i);
    expect(t.statement).toContain(t.baseline.statement);
  });

  it('never divides by a zero baseline', () => {
    const t = assessTrend({
      ...base,
      key: 'overdue_days_when_late',
      current: mv('overdue_days_when_late', 3),
      baselineMetric: mv('overdue_days_when_late', 0),
    });
    expect(t.relativeChange).toBeNull();
    expect(Number.isFinite(t.delta as number)).toBe(true);
    expect(t.verdict).toBe('declining');
  });
});

// =================================================================================================
describe('pattern — one bad fortnight is not a decline', () => {
  const sp = (values: (number | null)[]): SubPeriodValue[] =>
    values.map((v, i) => ({
      fromIso: `2026-08-0${i + 1}T00:00:00Z`,
      toIso: `2026-08-0${i + 2}T00:00:00Z`,
      value: {
        key: 'on_time_completion_rate',
        window: 'this_month',
        value: v,
        unit: 'ratio',
        n: v === null ? 0 : 5,
        insufficient: v === null,
        evidence: [],
        evidenceCount: 0,
        notes: [],
      },
    }));

  it('calls a dip that recovered a TEMPORARY ANOMALY', () => {
    const r = assessPattern(sp([1, 1, 0.2, 1, 1]), 1, -0.5);
    expect(r.pattern).toBe('temporary_anomaly');
    expect(r.note).toMatch(/back within the usual range/i);
  });

  it('calls a run that reaches the present a SUSTAINED PATTERN', () => {
    const r = assessPattern(sp([1, 1, 0.2, 0.2, 0.2]), 1, -0.5);
    expect(r.pattern).toBe('sustained_pattern');
    expect(r.note).toMatch(/run of 3/);
  });

  it('will not call a single recent dip either way', () => {
    const r = assessPattern(sp([1, 1, 1, 1, 0.2]), 1, -0.5);
    expect(r.pattern).toBe('undetermined');
    expect(r.note).toMatch(/either the start of something or an ordinary bad week/i);
  });

  it('refuses to characterise anything from too few buckets with data', () => {
    const r = assessPattern(sp([1, null, null, null, 0.2]), 1, -0.5);
    expect(r.pattern).toBe('undetermined');
    expect(r.covered).toBe(2);
  });

  it('ignores buckets that moved the OTHER way from the overall movement', () => {
    const r = assessPattern(sp([1, 1, 1, 1, 3]), 1, -0.5);
    expect(r.pattern).toBe('undetermined');
    expect(r.note).toMatch(/how the period was cut/i);
  });
});

// =================================================================================================
describe('confidence — it only ever falls', () => {
  const ok = { sourcesRead: 3, sourcesExpected: 3, unreadable: false, staleDays: 1 };

  it('gives no confidence at all when there is nothing to read', () => {
    const c = assessConfidence({ ...ok, sampleSize: 0 });
    expect(c.band).toBe('none');
    expect(c.reasons.join(' ')).toMatch(/Nothing here is a statement about the person/i);
  });

  it('rises with sample size and always explains itself', () => {
    expect(assessConfidence({ ...ok, sampleSize: 2 }).band).toBe('low');
    expect(assessConfidence({ ...ok, sampleSize: 8 }).band).toBe('moderate');
    const high = assessConfidence({ ...ok, sampleSize: 40 });
    expect(high.band).toBe('high');
    expect(high.reasons.length).toBeGreaterThan(0);
  });

  it('drops a band when a source returned nothing', () => {
    expect(assessConfidence({ ...ok, sampleSize: 40, sourcesRead: 2 }).band).toBe('moderate');
  });

  it('cannot stay high when a source could not be READ, and says the gap is of unknown size', () => {
    const c = assessConfidence({ ...ok, sampleSize: 400, unreadable: true });
    expect(c.band).toBe('low');
    expect(c.unreadable).toBe(true);
    expect(c.reasons.join(' ')).toMatch(/unknown amount of recorded work is missing/i);
  });

  it('drops a band for a stale record and says it describes a past period', () => {
    const c = assessConfidence({ ...ok, sampleSize: 40, staleDays: 200 });
    expect(c.band).toBe('moderate');
    expect(c.reasons.join(' ')).toMatch(/past period/i);
  });

  it('drops a band when everything fell in a single sub-period', () => {
    const c = assessConfidence({ ...ok, sampleSize: 40, periodsCovered: 1, periodsExamined: 6 });
    expect(c.band).toBe('moderate');
  });
});

// =================================================================================================
describe('the promises this patch makes about itself', () => {
  it('has no metric that claims to measure productivity', () => {
    for (const [key, meta] of Object.entries(METRIC_META)) {
      expect(`${key} ${meta.label} ${meta.definition}`.toLowerCase()).not.toMatch(
        /productiv|efficien|performance score|rating/,
      );
    }
  });

  it('states what every metric literally counts, so a number is never shown bare', () => {
    for (const meta of Object.values(METRIC_META)) {
      expect(meta.definition.length).toBeGreaterThan(40);
      expect(meta.minSample).toBeGreaterThan(0);
      expect(meta.sources.length).toBeGreaterThan(0);
    }
  });

  it('uses no emoji anywhere in the vocabulary it renders', () => {
    const text = Object.values(METRIC_META)
      .map((m) => m.label + m.definition)
      .join(' ');
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });
});
