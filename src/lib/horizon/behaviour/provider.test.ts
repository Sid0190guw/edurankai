// src/lib/horizon/behaviour/provider.test.ts — PATCH 04's contract side.
//
// The engine suite (behaviour.test.ts) proves the arithmetic. This one proves the ADAPTER, which is
// the riskier half: an engine that computes the wrong median is a wrong number, but an adapter that
// emits a result the shared contract would reject is a whole section of somebody's record silently
// missing, and nothing downstream re-checks because the contract exists so that nothing has to.
//
// Every result this patch produces therefore goes through buildIntelligenceResult() before it is
// returned, and this file asserts that the shapes it builds actually survive that.
import { describe, it, expect } from 'vitest';
import { buildIntelligenceResult, DIMENSION_FAMILIES, DEFAULT_ORGANISATION_ID } from '@/lib/horizon';
import type { BehaviouralProfile, BehaviourTrend } from './types';
import { DECISION_USE, NOT_PRODUCTIVITY } from './types';
import { BEHAVIOUR_METRICS } from './types';
import {
  DIMENSIONS,
  ENGINE_ID,
  ENGINE_VERSION,
  PATCH_ID,
  behaviourProvider,
  setBehaviourViewerResolver,
  toIntelligenceResult,
} from './provider';

const EMP = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-19T04:30:00Z';

function profile(over: Partial<BehaviouralProfile> = {}): BehaviouralProfile {
  return {
    employeeId: EMP,
    decisionUse: DECISION_USE,
    disclaimer: NOT_PRODUCTIVITY,
    inputs: {
      sources: [{ table: 'audit_log', rowsRead: 42, readable: true }],
      windows: [],
      employedFromIso: '2026-01-05T00:00:00Z',
      employedToIso: null,
      observationCount: 42,
    },
    processing: ['read'],
    metrics: [],
    trends: [],
    confidence: {
      band: 'moderate',
      reasons: ['42 recorded events.'],
      sampleSize: 42,
      sourcesRead: 3,
      sourcesExpected: 3,
      unreadable: false,
    },
    limitations: [],
    computedAtIso: NOW,
    access: {
      allowed: true,
      basis: 'reporting_manager',
      purpose: 'people_management',
      reason: 'ok',
      logged: true,
      atIso: NOW,
    },
    ...over,
  };
}

function trend(over: Partial<BehaviourTrend> = {}): BehaviourTrend {
  return {
    key: 'on_time_completion_rate',
    window: 'this_month',
    verdict: 'improving',
    pattern: 'sustained_pattern',
    current: 0.9,
    baseline: {
      kind: 'preceding_period',
      value: 0.5,
      n: 12,
      fromIso: '2026-07-01T00:00:00Z',
      toIso: '2026-07-31T18:30:00Z',
      toleranceRelative: 0.15,
      statement: 'Compared against the 19 days immediately before this period.',
    },
    delta: 0.4,
    relativeChange: 0.8,
    confidence: {
      band: 'moderate',
      reasons: ['22 recorded events.'],
      sampleSize: 22,
      sourcesRead: 3,
      sourcesExpected: 3,
      unreadable: false,
    },
    statement: 'Completed by the recorded due date moved in the better direction over this period.',
    evidence: [
      {
        sourceTable: 'audit_log',
        sourceId: 'row-1',
        sourceField: 'diff.to',
        occurredAt: '2026-08-10T09:00:00Z',
        statement: 'status under_review to completed',
        collectedVia: 'authorised_system_record',
        workRef: { table: 'employee_tasks', id: 't1' },
      },
      {
        sourceTable: 'edu_attempts',
        sourceId: 'att-1',
        sourceField: 'submitted_at',
        occurredAt: '2026-08-11T09:00:00Z',
        statement: 'attempt submitted on assessment a1',
        collectedVia: 'authorised_system_record',
        workRef: { table: 'edu_attempts', id: 'att-1' },
      },
    ],
    evidenceCount: 2,
    ...over,
  };
}

const build = (t: BehaviourTrend) => {
  const r = toIntelligenceResult(profile(), t, undefined, DEFAULT_ORGANISATION_ID, 'comp-1');
  expect(r).not.toBeNull();
  return r!;
};

describe('the mapping survives the shared contract', () => {
  it('builds a valid IntelligenceResult from an assessed trend', () => {
    const checked = buildIntelligenceResult(build(trend()));
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });

  it('builds a valid result from a trend that could NOT be assessed', () => {
    const checked = buildIntelligenceResult(
      build(trend({ verdict: 'insufficient_evidence', current: null, evidence: [], evidenceCount: 0 })),
    );
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });

  it('reports an unassessable trend as not_computed and unreadable, never as a zero', () => {
    const r = build(trend({ verdict: 'insufficient_evidence', current: null }));
    expect(r.scoreOrLevel.kind).toBe('not_computed');
    expect(r.status).toBe('unreadable');
    expect(r.unreadable).toBeTruthy();
  });

  it('never claims a decision weight above advisory, and always awaits a human', () => {
    const r = build(trend());
    expect(r.decisionUse).toBe('advisory_only');
    expect(r.humanReviewStatus).toBe('pending');
    expect(r.layer).toBe('computed');
  });

  it('claims only platform_record standing — it is not an established method', () => {
    expect(build(trend()).scientificStatus).toBe('platform_record');
  });

  it('carries the engine version, so two results computed under different rules are tellable apart', () => {
    const v = build(trend()).modelOrEngineVersion;
    expect(v.engineId).toBe(ENGINE_ID);
    expect(v.version).toBe(ENGINE_VERSION);
    expect(v.engineClass).toBe('statistical');
    expect(v.computationId).toBe('comp-1');
  });

  it('prints the engine’s own sentence rather than a second, shorter account of it', () => {
    const t = trend();
    expect(build(t).summary).toBe(t.statement);
  });

  it('names every source it used, with weights that sum to one', () => {
    const r = build(trend());
    const sum = r.sourceBreakdown.reduce((a, c) => a + c.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(r.sourceBreakdown.map((s) => s.sourceType).sort()).toEqual(['assessment', 'task']);
  });

  it('classes its evidence as observed, never demonstrated', () => {
    // Rule 22: a timestamp saying a task changed column must not outrank a demonstrated skill.
    for (const e of build(trend()).evidence) expect(e.evidenceClass).toBe('observed');
  });

  it('records that its evidence is an ordinary organisational record, not a consented disclosure', () => {
    for (const e of build(trend()).evidence) expect(e.collectedUnder).toBe('organisational_record');
  });

  it('points each evidence row back at the module that owns the table', () => {
    const [task, attempt] = build(trend()).evidence;
    expect(task.rawReference.ownerModule).toBe('src/lib/employee-tasks.ts');
    expect(task.rawReference.table).toBe('audit_log');
    expect(attempt.rawReference.ownerModule).toBe('src/lib/assessment.ts');
  });

  it('maps a confidence of "none" DOWN to the contract floor, never up', () => {
    const r = build(trend({ confidence: { ...trend().confidence, band: 'none' } }));
    expect(r.confidence.band).toBe('low');
    expect(r.confidence.value).toBeNull();
    expect(r.confidence.basis.length).toBeGreaterThan(0);
  });
});

describe('what the provider declares', () => {
  it('covers every metric in the catalogue, with no key claimed twice', () => {
    expect(Object.keys(DIMENSIONS).sort()).toEqual([...BEHAVIOUR_METRICS].sort());
    const keys = Object.values(DIMENSIONS).map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts nothing on a risk or wellbeing surface', () => {
    // This engine reads task timestamps. It has no basis for calling anybody a risk, and it must
    // never be the reason a wellbeing surface lights up.
    for (const d of Object.values(DIMENSIONS)) {
      expect(d.family).not.toBe('risk');
      expect(d.family).not.toBe('wellbeing_aggregate');
    }
  });

  it('declares only families the shared contract knows', () => {
    for (const d of Object.values(DIMENSIONS)) {
      expect(DIMENSION_FAMILIES as readonly string[]).toContain(d.family);
    }
  });

  it('does not claim it can answer historically', () => {
    expect(behaviourProvider.historicalSupport).toBe(false);
    expect(behaviourProvider.patchId).toBe(PATCH_ID);
  });
});

describe('the provider fails closed', () => {
  const ctx = (over: any = {}) => ({
    subject: { kind: 'employee' as const, id: EMP, idScheme: 'hr_employee' as const, organisationId: DEFAULT_ORGANISATION_ID },
    organisationId: DEFAULT_ORGANISATION_ID,
    asOf: null,
    requestId: 'req-1',
    ...over,
  });

  it('reads NOTHING when no viewer has been established for the request', async () => {
    setBehaviourViewerResolver(null);
    const out = await behaviourProvider.read(ctx());
    expect(out).toHaveLength(1);
    expect(out[0].scoreOrLevel.kind).toBe('not_computed');
    expect(out[0].summary).toMatch(/never read without an authorised reader/i);
  });

  it('reads NOTHING when the resolver returns no viewer', async () => {
    setBehaviourViewerResolver(async () => null);
    const out = await behaviourProvider.read(ctx());
    expect(out[0].scoreOrLevel.kind).toBe('not_computed');
    setBehaviourViewerResolver(null);
  });

  it('reads NOTHING when the resolver throws — a resolver that is down is not a viewer', async () => {
    setBehaviourViewerResolver(async () => {
      throw new Error('resolver down');
    });
    const out = await behaviourProvider.read(ctx());
    expect(out[0].scoreOrLevel.kind).toBe('not_computed');
    setBehaviourViewerResolver(null);
  });

  it('declines an as-of read rather than returning today’s figures under an old date', async () => {
    const out = await behaviourProvider.read(ctx({ asOf: '2026-03-01T00:00:00Z' }));
    expect(out[0].summary).toMatch(/cannot reconstruct/i);
  });

  it('declines a subject that is not an employee record', async () => {
    const out = await behaviourProvider.read(
      ctx({ subject: { kind: 'applicant', id: 'x', idScheme: 'application', organisationId: DEFAULT_ORGANISATION_ID } }),
    );
    expect(out[0].summary).toMatch(/employee records only/i);
  });

  it('emits refusals that are themselves valid contract results', async () => {
    setBehaviourViewerResolver(null);
    const out = await behaviourProvider.read(ctx());
    const checked = buildIntelligenceResult(out[0]);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });
});
