// src/lib/horizon/contracts.test.ts — the rules of the HORIZON contract, asserted.
//
// WHAT THIS SUITE IS FOR. Every rule in the brief that could be written as a sentence in a document
// has been written as a property of a type or a check in a validator. This file is where those stop
// being claims. If a later patch weakens one — by adding an audience that can see health data, by
// letting an engine claim it may decide, by relabelling the traditional-computation family with the
// word the brief forbids — a test here goes red rather than a reviewer having to notice.
//
// Every test is PURE. No database, no network, no fixtures on disk.

import { describe, it, expect } from 'vitest';
import {
  ID_KINDS, ID_OWNERSHIP, HORIZON_OWNED_IDS, REFERENCED_IDS, DEFAULT_ORGANISATION_ID,
  newHorizonId, employeeSubject, applicantSubject, isSubjectRef, subjectKey, sameSubject,
  isActorRef, isUuid, idOrNull, defaultOrganisationResolver,
} from './ids';
import {
  DATA_LAYERS, DATA_LAYER_SPECS, ENGINE_WRITABLE_LAYERS, mayCite, isDataLayer,
  ENGINE_CLASSES, ENGINE_CLASS_SPECS, DIMENSION_FAMILIES, DIMENSION_FAMILY_LABELS,
  EVIDENCE_CLASSES, EVIDENCE_CLASS_WEIGHT, EVIDENCE_CLASS_LABELS, EVIDENCE_CLASS_FROM_GRAPH_LEVEL,
  COLLECTION_BASES, COLLECTION_BASIS_LABELS, FORBIDDEN_UI_TERMS, checkPublicCopy,
  bandOf, isIsoTimestamp, maxConfidenceFor, strongestEvidenceClass,
  validateEvidence, validateIntelligenceResult, validateSignal, validateHumanDecision,
  buildIntelligenceResult, buildSignal, freezeDeep, MIN_CONTRIBUTORS_FOR_AGGREGATE,
  MIN_DECISION_REASON_CHARS, HIGH_IMPACT_DECISIONS,
  type Evidence, type IntelligenceResult, type Signal, type HumanDecision,
} from './types';
import {
  HORIZON_AUDIENCES, AUDIENCE_SPECS, VISIBILITY_CLASSES, VISIBILITY_SPECS, NEVER_VISIBLE,
  FAMILY_VISIBILITY, RESULT_FIELD_VISIBILITY, SIGNAL_FIELD_VISIBILITY,
  audienceMaySee, effectiveVisibility, redactForAudience, authoriseAccess, requireAccessLog,
  audienceThatCanSee, MIN_PURPOSE_CHARS,
} from './visibility';
import {
  API_ERROR_CODES, HORIZON_API_VERSION, httpStatusFor, isRetryable, apiOk, apiErr,
  apiErrFromException, responseMeta, clampPageSize, pageFrom, PAGE_MAX_SIZE, PAGE_DEFAULT_SIZE,
} from './api';

// -------------------------------------------------------------------------------------------------
// FIXTURES
// -------------------------------------------------------------------------------------------------

const NOW = '2026-08-23T10:00:00.000Z';
const LATER = '2026-09-23T10:00:00.000Z';
const EMP = '11111111-1111-4111-8111-111111111111';

const subject = employeeSubject(EMP);

function goodEvidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    sourceType: 'task',
    sourceId: 'task-9',
    timestamp: NOW,
    relevance: { value: 0.8, band: 'high', basis: 'the task exercised the dimension directly' },
    reliability: { value: 0.9, band: 'high', basis: 'platform record of a reviewed submission' },
    summary: 'Completed and reviewed submission on record.',
    rawReference: { ownerModule: 'src/lib/employee-tasks.ts', table: 'hr_task_log', recordId: 'task-9' },
    evidenceClass: 'demonstrated',
    layer: 'raw',
    collectedUnder: 'organisational_record',
    organisationId: DEFAULT_ORGANISATION_ID,
    ...over,
  };
}

function goodResult(over: Partial<IntelligenceResult> = {}): IntelligenceResult {
  return {
    id: 'res-1',
    subject,
    dimension: { family: 'capability', key: 'delivery_depth', label: 'Delivery depth' },
    scoreOrLevel: { kind: 'level', level: 'Independent', ladder: ['Assisted', 'Independent', 'Leading'] },
    confidence: { band: 'high', value: 0.82, basis: 'four reviewed submissions on record' },
    status: 'active',
    summary: 'Four reviewed submissions on record across two quarters.',
    evidence: [goodEvidence()],
    sourceBreakdown: [
      { sourceType: 'task', weight: 1, evidenceIds: ['ev-1'], strongestClass: 'demonstrated' },
    ],
    computedAt: NOW,
    validFor: { staleAt: LATER, recomputeAfterDays: 30 },
    modelOrEngineVersion: {
      engineId: 'horizon.delivery', engineClass: 'deterministic', version: '1.0.0', computationId: 'comp-1',
    },
    humanReviewStatus: 'not_required',
    layer: 'computed',
    decisionUse: 'supporting_only',
    scientificStatus: 'platform_record',
    organisationId: DEFAULT_ORGANISATION_ID,
    ...over,
  };
}

function goodSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    subject,
    category: 'workload',
    severity: 'low',
    title: 'Sustained high assignment count',
    explanation: 'Open assignments have stayed above this person’s usual range for three weeks.',
    evidenceIds: ['ev-1'],
    sourceTypes: ['task'],
    confidence: { band: 'moderate', value: 0.5, basis: 'three weeks of task records' },
    generatedAt: NOW,
    expiresAt: LATER,
    status: 'open',
    recommendedActions: [
      { key: 'review_load', label: 'Review the current assignment list together', addressedTo: 'reporting_manager' },
    ],
    humanReviewRequired: false,
    layer: 'ai_interpretation',
    decisionUse: 'advisory_only',
    organisationId: DEFAULT_ORGANISATION_ID,
    ...over,
  };
}

// -------------------------------------------------------------------------------------------------
// 2. IDENTIFIERS
// -------------------------------------------------------------------------------------------------

describe('canonical identifiers', () => {
  it('names all eleven identifiers from the brief', () => {
    for (const k of [
      'employee', 'applicant', 'organisation', 'profile', 'role', 'feedback',
      'evidence', 'signal', 'assessment', 'report', 'computation',
    ]) {
      expect(ID_KINDS).toContain(k);
      expect(ID_OWNERSHIP[k as keyof typeof ID_OWNERSHIP]).toBeTruthy();
    }
  });

  it('every kind declares an owner and a note', () => {
    for (const k of ID_KINDS) {
      const o = ID_OWNERSHIP[k];
      expect(o.kind).toBe(k);
      expect(o.ownerModule.length).toBeGreaterThan(0);
      expect(o.note.length).toBeGreaterThan(20);
    }
  });

  it('owned and referenced identifiers partition the set', () => {
    expect([...HORIZON_OWNED_IDS, ...REFERENCED_IDS].sort()).toEqual([...ID_KINDS].sort());
    expect(HORIZON_OWNED_IDS.some((k) => REFERENCED_IDS.includes(k))).toBe(false);
  });

  it('keeps employee, applicant, organisation, role, feedback and assessment as REFERENCES', () => {
    // The heart of rule 11. If one of these ever flips to horizonOwns, HORIZON has started keeping a
    // second copy of a concept another module already owns.
    for (const k of ['employee', 'applicant', 'organisation', 'role', 'feedback', 'assessment'] as const) {
      expect(ID_OWNERSHIP[k].horizonOwns).toBe(false);
    }
  });

  it('refuses to mint an identifier it does not own', () => {
    expect(() => newHorizonId('employee')).toThrow(/does not issue employee/i);
    expect(() => newHorizonId('applicant')).toThrow();
    expect(isUuid(newHorizonId('signal'))).toBe(true);
  });

  it('builds subjects and rejects incoherent scheme/kind pairs', () => {
    expect(isSubjectRef(subject)).toBe(true);
    expect(isSubjectRef(applicantSubject('a1', 'tal_person'))).toBe(true);
    // An employee anchored on an application row would read nothing and look like a person with no
    // history. It is refused rather than served.
    expect(isSubjectRef({ ...subject, idScheme: 'application' })).toBe(false);
    expect(isSubjectRef({ ...subject, id: '  ' })).toBe(false);
    expect(isSubjectRef(null)).toBe(false);
  });

  it('gives a subject a stable key that includes the anchor scheme', () => {
    const a = applicantSubject('same-id', 'tal_person');
    const b = applicantSubject('same-id', 'application');
    expect(subjectKey(a)).not.toBe(subjectKey(b));
    expect(sameSubject(a, a)).toBe(true);
    expect(sameSubject(a, b)).toBe(false);
  });

  it('validates actors and normalises empty ids to null', () => {
    expect(isActorRef({ kind: 'user', id: 'u1' })).toBe(true);
    expect(isActorRef({ kind: 'ghost', id: 'u1' })).toBe(false);
    expect(isActorRef({ kind: 'user', id: '' })).toBe(false);
    expect(idOrNull('  ')).toBeNull();
    expect(idOrNull(7)).toBeNull();
    expect(idOrNull(' abc ')).toBe('abc');
  });

  it('resolves the default organisation without a registry', async () => {
    expect(await defaultOrganisationResolver.resolve()).toBe(DEFAULT_ORGANISATION_ID);
  });
});

// -------------------------------------------------------------------------------------------------
// 3. THE LAYER SEPARATION
// -------------------------------------------------------------------------------------------------

describe('the canonical data separation', () => {
  it('carries the brief’s seven layers in order', () => {
    expect([...DATA_LAYERS]).toEqual([
      'raw', 'computed', 'observed', 'human_feedback',
      'ai_interpretation', 'recommendation', 'human_decision',
    ]);
  });

  it('makes human_decision the only consequential layer', () => {
    const consequential = DATA_LAYERS.filter((l) => DATA_LAYER_SPECS[l].consequential);
    expect(consequential).toEqual(['human_decision']);
    const mayDecide = DATA_LAYERS.filter((l) => DATA_LAYER_SPECS[l].decisionUse === 'may_decide');
    expect(mayDecide).toEqual(['human_decision']);
  });

  it('never lets an engine write a consequential or human layer', () => {
    for (const l of ENGINE_WRITABLE_LAYERS) {
      expect(DATA_LAYER_SPECS[l].consequential).toBe(false);
      expect(DATA_LAYER_SPECS[l].requiresNamedHuman).toBe(false);
    }
    expect(ENGINE_WRITABLE_LAYERS).not.toContain('human_decision');
    expect(ENGINE_WRITABLE_LAYERS).not.toContain('human_feedback');
    expect(ENGINE_WRITABLE_LAYERS).not.toContain('raw');
  });

  it('states citation rules explicitly rather than by index order', () => {
    expect(mayCite('raw', 'computed')).toBe(false);
    expect(DATA_LAYER_SPECS.raw.mayCite).toEqual([]);
    // The case an index comparison would get wrong: computed legitimately draws on observed even
    // though observed comes after it in the brief's list.
    expect(mayCite('computed', 'observed')).toBe(true);
    expect(mayCite('ai_interpretation', 'human_feedback')).toBe(true);
    expect(mayCite('human_feedback', 'ai_interpretation')).toBe(false);
    expect(isDataLayer('nonsense')).toBe(false);
  });

  it('freezes constructed objects so a layer cannot be rewritten afterwards', () => {
    const built = buildIntelligenceResult(goodResult());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.isFrozen(built.value)).toBe(true);
    expect(() => { (built.value as any).layer = 'raw'; }).toThrow();
    expect(built.value.layer).toBe('computed');
    const nested = freezeDeep({ a: [{ b: 1 }] });
    expect(Object.isFrozen(nested.a[0])).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// 7. INTELLIGENCE RESULTS
// -------------------------------------------------------------------------------------------------

describe('the standard intelligence output', () => {
  it('accepts a well-formed result', () => {
    const v = validateIntelligenceResult(goodResult());
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('refuses a result that claims it may decide (rule 14)', () => {
    const v = validateIntelligenceResult(goodResult({ decisionUse: 'may_decide' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/may_decide/);
  });

  it('refuses a result that sits in a human or consequential layer', () => {
    expect(validateIntelligenceResult(goodResult({ layer: 'human_decision' })).ok).toBe(false);
    expect(validateIntelligenceResult(goodResult({ layer: 'human_feedback' })).ok).toBe(false);
    expect(validateIntelligenceResult(goodResult({ layer: 'raw' })).ok).toBe(false);
  });

  it('requires the computation that produced it', () => {
    const v = validateIntelligenceResult(goodResult({
      modelOrEngineVersion: {
        engineId: 'e', engineClass: 'deterministic', version: '1', computationId: '' as any,
      },
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/computationId/);
  });

  it('requires every result to name its sources and to weight them to one (rule 23)', () => {
    expect(validateIntelligenceResult(goodResult({ sourceBreakdown: [] })).ok).toBe(false);
    const v = validateIntelligenceResult(goodResult({
      sourceBreakdown: [
        { sourceType: 'task', weight: 0.3, evidenceIds: [], strongestClass: 'demonstrated' },
        { sourceType: 'interview', weight: 0.3, evidenceIds: [], strongestClass: 'attested' },
      ],
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/sum to 1/);
  });

  it('caps confidence by the strongest evidence class (rule 22)', () => {
    expect(maxConfidenceFor('demonstrated')).toBe('high');
    expect(maxConfidenceFor('inferred')).toBe('moderate');
    expect(maxConfidenceFor('non_evidential')).toBe('low');

    const inferredOnly = goodResult({
      sourceBreakdown: [
        { sourceType: 'system_computation', weight: 1, evidenceIds: [], strongestClass: 'inferred' },
      ],
    });
    // High confidence off inference alone is refused...
    expect(validateIntelligenceResult(inferredOnly).ok).toBe(false);
    // ...and the same result at moderate is accepted.
    const moderated = { ...inferredOnly, confidence: { band: 'moderate' as const, value: 0.5, basis: 'inference only' } };
    expect(validateIntelligenceResult(moderated).errors).toEqual([]);
  });

  it('ranks demonstrated evidence above inferred and non-evidential', () => {
    expect(EVIDENCE_CLASS_WEIGHT.demonstrated).toBeGreaterThan(EVIDENCE_CLASS_WEIGHT.inferred);
    expect(EVIDENCE_CLASS_WEIGHT.inferred).toBeGreaterThan(EVIDENCE_CLASS_WEIGHT.non_evidential);
    expect(strongestEvidenceClass([
      { sourceType: 'task', weight: 0.5, evidenceIds: [], strongestClass: 'inferred' },
      { sourceType: 'interview', weight: 0.5, evidenceIds: [], strongestClass: 'demonstrated' },
    ])).toBe('demonstrated');
    expect(strongestEvidenceClass([])).toBe('non_evidential');
  });

  it('requires a shelf life, so a result cannot become a permanent label', () => {
    const v = validateIntelligenceResult(goodResult({ validFor: { staleAt: 'never', recomputeAfterDays: 30 } }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/staleAt/);
  });

  it('requires a not_computed result to say why, instead of reading as a zero', () => {
    const v = validateIntelligenceResult(goodResult({
      scoreOrLevel: { kind: 'not_computed', reason: '' },
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/reason/);

    // With a reason it is a valid answer, and it needs no sources — there was nothing to compute on.
    const honest = validateIntelligenceResult(goodResult({
      scoreOrLevel: { kind: 'not_computed', reason: 'No reviewed submissions on record in the window.' },
      sourceBreakdown: [],
      confidence: { band: 'low', value: 0, basis: 'nothing on record' },
    }));
    expect(honest.errors).toEqual([]);
  });

  it('requires an unreadable result to carry the reason it could not be read', () => {
    const v = validateIntelligenceResult(goodResult({ status: 'unreadable' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/unreadable/);
  });
});

// -------------------------------------------------------------------------------------------------
// 20 & 21. THE TRADITIONAL COMPUTATION LAYER
// -------------------------------------------------------------------------------------------------

describe('traditional computation is kept apart from the interpretation layer', () => {
  const traditional = (over: Partial<IntelligenceResult> = {}) => goodResult({
    dimension: { family: 'temporal_pattern', key: 'cycle_a', label: 'Temporal profile A' },
    layer: 'ai_interpretation',
    decisionUse: 'advisory_only',
    scientificStatus: 'not_scientifically_established',
    humanReviewStatus: 'pending',
    confidence: { band: 'low', value: 0.1, basis: 'a traditional computation carries no evidential weight' },
    sourceBreakdown: [
      { sourceType: 'system_computation', weight: 1, evidenceIds: [], strongestClass: 'non_evidential' },
    ],
    modelOrEngineVersion: {
      engineId: 'horizon.temporal', engineClass: 'traditional_computation', version: '1.0.0',
      computationId: 'comp-2',
    },
    ...over,
  });

  it('accepts one that labels itself honestly', () => {
    expect(validateIntelligenceResult(traditional()).errors).toEqual([]);
  });

  it('refuses one that claims established scientific standing (rule 21)', () => {
    const v = validateIntelligenceResult(traditional({ scientificStatus: 'established_method' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/not_scientifically_established/);
  });

  it('refuses one that skips human review (rule 15)', () => {
    const v = validateIntelligenceResult(traditional({ humanReviewStatus: 'not_required' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/human review/i);
  });

  it('refuses one that claims more than advisory weight (rule 22)', () => {
    const v = validateIntelligenceResult(traditional({ decisionUse: 'supporting_only' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/advisory_only/);
  });

  it('cannot exceed low confidence, because it rests on nothing evidential', () => {
    const v = validateIntelligenceResult(traditional({
      confidence: { band: 'high', value: 0.9, basis: 'strong pattern' },
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/ceiling/);
  });

  it('is restricted from every operational audience by its engine class', () => {
    expect(ENGINE_CLASS_SPECS.traditional_computation.interpretationLayerOnly).toBe(true);
    expect(effectiveVisibility('open', 'capability', 'traditional_computation')).toBe('restricted');
    expect(audienceMaySee('self', 'restricted')).toBe(false);
    expect(audienceMaySee('hr_operations', 'restricted')).toBe(false);
    expect(audienceMaySee('reporting_manager', 'restricted')).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// 8. EVIDENCE
// -------------------------------------------------------------------------------------------------

describe('evidence', () => {
  it('accepts a well-formed item', () => {
    expect(validateEvidence(goodEvidence()).errors).toEqual([]);
  });

  it('requires a reference that ends somewhere real', () => {
    const v = validateEvidence(goodEvidence({ rawReference: undefined as any }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/rawReference/);
    const partial = validateEvidence(goodEvidence({
      rawReference: { ownerModule: 'm', table: '', recordId: '' },
    }));
    expect(partial.ok).toBe(false);
  });

  it('requires a lawful collection basis, and offers no covert one (rule 26)', () => {
    expect(COLLECTION_BASES).not.toContain('covert');
    expect(COLLECTION_BASES).not.toContain('monitoring');
    const v = validateEvidence(goodEvidence({ collectedUnder: 'covert_capture' as any }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/lawful collection basis/);
  });

  it('requires relevance and reliability to be graded and grounded', () => {
    expect(bandOf(0.9)).toBe('high');
    expect(bandOf(0.5)).toBe('moderate');
    expect(bandOf(0.1)).toBe('low');
    const mismatched = validateEvidence(goodEvidence({
      relevance: { value: 0.1, band: 'high', basis: 'because' },
    }));
    expect(mismatched.ok).toBe(false);
    const ungrounded = validateEvidence(goodEvidence({
      reliability: { value: 0.9, band: 'high', basis: '  ' },
    }));
    expect(ungrounded.ok).toBe(false);
  });

  it('maps the evidence-graph levels onto its own classes without forking them', () => {
    for (const level of [
      'claimed', 'explicit', 'inferred', 'demonstrated',
      'professionally_demonstrated', 'production_demonstrated', 'externally_verified',
    ]) {
      expect(EVIDENCE_CLASSES).toContain(EVIDENCE_CLASS_FROM_GRAPH_LEVEL[level]);
    }
    expect(EVIDENCE_CLASS_FROM_GRAPH_LEVEL.claimed).toBe('stated');
    expect(EVIDENCE_CLASS_FROM_GRAPH_LEVEL.externally_verified).toBe('demonstrated');
  });
});

// -------------------------------------------------------------------------------------------------
// 9. SIGNALS
// -------------------------------------------------------------------------------------------------

describe('signals', () => {
  it('accepts a well-formed signal', () => {
    expect(validateSignal(goodSignal()).errors).toEqual([]);
    const built = buildSignal(goodSignal());
    expect(built.ok).toBe(true);
  });

  it('requires an expiry that is later than generation', () => {
    expect(validateSignal(goodSignal({ expiresAt: '' as any })).ok).toBe(false);
    const backwards = validateSignal(goodSignal({ expiresAt: '2026-08-22T10:00:00.000Z' }));
    expect(backwards.ok).toBe(false);
    expect(backwards.errors.join(' ')).toMatch(/after signal.generatedAt/);
  });

  it('requires evidence and source types (rule 23)', () => {
    expect(validateSignal(goodSignal({ evidenceIds: [] })).ok).toBe(false);
    expect(validateSignal(goodSignal({ sourceTypes: [] })).ok).toBe(false);
    expect(validateSignal(goodSignal({ sourceTypes: ['gossip' as any] })).ok).toBe(false);
  });

  it('forces a human onto every high-severity signal (rule 15)', () => {
    const v = validateSignal(goodSignal({ severity: 'high', humanReviewRequired: false }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/humanReviewRequired/);
    expect(validateSignal(goodSignal({ severity: 'high', humanReviewRequired: true })).errors).toEqual([]);
  });

  it('requires an explanation, because an unexplained signal is an accusation', () => {
    const v = validateSignal(goodSignal({ explanation: '' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/explanation/);
  });

  it('never sits in a decision layer', () => {
    expect(validateSignal(goodSignal({ layer: 'human_decision' })).ok).toBe(false);
    expect(validateSignal(goodSignal({ decisionUse: 'may_decide' })).ok).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// 13 & 14. HUMAN DECISIONS
// -------------------------------------------------------------------------------------------------

describe('human decisions', () => {
  const decision = (over: Partial<HumanDecision> = {}): HumanDecision => ({
    id: 'dec-1',
    subject,
    kind: 'promotion',
    decidedBy: { kind: 'user', id: 'u-1', displayName: 'A named person' },
    decidedAt: NOW,
    reason: 'Sustained delivery at the next level for two review cycles.',
    consideredResultIds: ['res-1'],
    consideredSignalIds: [],
    contraryToRecommendation: false,
    layer: 'human_decision',
    organisationId: DEFAULT_ORGANISATION_ID,
    ...over,
  });

  it('accepts a decision made by a named human with a written reason', () => {
    expect(validateHumanDecision(decision()).errors).toEqual([]);
  });

  it('refuses a decision attributed to the system or an engine (rule 14)', () => {
    expect(validateHumanDecision(decision({ decidedBy: { kind: 'system', id: 'horizon' } })).ok).toBe(false);
    expect(validateHumanDecision(decision({ decidedBy: { kind: 'engine', id: 'e1' } })).ok).toBe(false);
  });

  it('refuses a decision with no real reason', () => {
    const v = validateHumanDecision(decision({ reason: 'approved' }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(String(MIN_DECISION_REASON_CHARS));
  });

  it('names every high-impact decision from rule 14', () => {
    for (const k of ['hiring', 'rejection', 'promotion', 'termination', 'disciplinary']) {
      expect(HIGH_IMPACT_DECISIONS).toContain(k);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// 16, 17 & 18. ACCESS
// -------------------------------------------------------------------------------------------------

describe('role-based views', () => {
  it('never lets any audience see a prohibited class', () => {
    for (const a of HORIZON_AUDIENCES) {
      expect(AUDIENCE_SPECS[a].maySee).not.toContain(NEVER_VISIBLE);
      expect(audienceMaySee(a, 'prohibited')).toBe(false);
    }
    expect(audienceThatCanSee('prohibited')).toBeNull();
  });

  it('keeps individual wellbeing data out of every per-person view', () => {
    // The project rule, stated in CLAUDE.md: if you find yourself writing a query that returns a row
    // per user on an admin surface for this data, that is the screen that must not exist.
    expect(FAMILY_VISIBILITY.wellbeing_aggregate).toBe('prohibited');
    expect(effectiveVisibility('open', 'wellbeing_aggregate')).toBe('prohibited');
    for (const a of HORIZON_AUDIENCES) {
      expect(audienceMaySee(a, effectiveVisibility('open', 'wellbeing_aggregate'))).toBe(false);
    }
    expect(MIN_CONTRIBUTORS_FOR_AGGREGATE).toBeGreaterThanOrEqual(5);
  });

  it('applies the strictest of the field, family and engine rules', () => {
    expect(effectiveVisibility('open', 'capability')).toBe('open');
    expect(effectiveVisibility('open', 'risk')).toBe('internal');
    expect(effectiveVisibility('restricted', 'capability')).toBe('restricted');
    expect(effectiveVisibility('open', 'temporal_pattern')).toBe('restricted');
    expect(effectiveVisibility('internal', 'capability', 'traditional_computation')).toBe('restricted');
  });

  it('shows a person their own evidence but not the machinery that weighted it', () => {
    const out = redactForAudience(goodResult(), 'self', RESULT_FIELD_VISIBILITY, { family: 'capability' });
    expect(out.value.summary).toBeTruthy();
    expect(out.value.evidence).toBeTruthy();
    expect(out.value.scoreOrLevel).toBeTruthy();
    expect(out.value.sourceBreakdown).toBeUndefined();
    expect(out.value.modelOrEngineVersion).toBeUndefined();
    // Restricted fields are OMITTED, not announced: announcing them would disclose the thing the
    // restriction protects.
    expect(out.omitted).toContain('sourceBreakdown');
    expect(out.withheld.map((w) => w.path)).not.toContain('sourceBreakdown');
  });

  it('gives an auditor the machinery, which is what an auditor is for', () => {
    const out = redactForAudience(goodResult(), 'auditor', RESULT_FIELD_VISIBILITY, { family: 'capability' });
    expect(out.value.sourceBreakdown).toBeTruthy();
    expect(out.value.modelOrEngineVersion).toBeTruthy();
    expect(out.omitted).toEqual([]);
  });

  it('fails closed on a field nobody classified', () => {
    const out = redactForAudience(
      { ...goodResult(), somethingNewNobodyClassified: 'x' } as any,
      'self',
      RESULT_FIELD_VISIBILITY,
      { family: 'capability' },
    );
    expect((out.value as any).somethingNewNobodyClassified).toBeUndefined();
    expect(out.omitted).toContain('somethingNewNobodyClassified');
  });

  it('classifies every field of the two standard outputs', () => {
    for (const k of Object.keys(goodResult())) {
      expect(RESULT_FIELD_VISIBILITY[k], 'result field ' + k + ' is unclassified').toBeTruthy();
    }
    for (const k of Object.keys(goodSignal())) {
      expect(SIGNAL_FIELD_VISIBILITY[k], 'signal field ' + k + ' is unclassified').toBeTruthy();
    }
  });

  it('declares a redaction mode for every visibility class', () => {
    for (const v of VISIBILITY_CLASSES) {
      expect(['withhold', 'omit']).toContain(VISIBILITY_SPECS[v].redaction);
    }
  });

  it('refuses a relationship-scoped view that nobody confirmed', () => {
    const base = {
      actor: { kind: 'user' as const, id: 'u-9' },
      subject,
      organisationId: DEFAULT_ORGANISATION_ID,
      requestId: 'req-1',
    };
    const unconfirmed = authoriseAccess({ ...base, audience: 'reporting_manager' });
    expect(unconfirmed.allowed).toBe(false);
    // undefined must not mean "allow". That is how an authorisation check becomes decoration.
    const explicitlyFalse = authoriseAccess({
      ...base, audience: 'reporting_manager', relationshipConfirmed: false,
    });
    expect(explicitlyFalse.allowed).toBe(false);
    const confirmed = authoriseAccess({
      ...base, audience: 'reporting_manager', relationshipConfirmed: true,
    });
    expect(confirmed.allowed).toBe(true);
  });

  it('requires a stated purpose where purpose limitation applies (rule 17)', () => {
    const base = {
      actor: { kind: 'user' as const, id: 'u-9' },
      subject,
      organisationId: DEFAULT_ORGANISATION_ID,
      requestId: 'req-1',
      audience: 'hr_operations' as const,
    };
    const noPurpose = authoriseAccess(base);
    expect(noPurpose.allowed).toBe(false);
    if (!noPurpose.allowed) expect(noPurpose.code).toBe('purpose_required');
    expect(authoriseAccess({ ...base, purpose: 'tiny' }).allowed).toBe(false);
    expect(authoriseAccess({ ...base, purpose: 'Payroll exception review for August' }).allowed).toBe(true);
    expect(MIN_PURPOSE_CHARS).toBeGreaterThan(0);
  });

  it('refuses to render for a logged audience when the access log write failed', async () => {
    const failing = { async log() { return { ok: false, error: 'connection refused' }; } };
    const entry = {
      organisationId: DEFAULT_ORGANISATION_ID,
      actor: { kind: 'user' as const, id: 'u-9' },
      subject,
      visibilityServed: 'internal' as const,
      purpose: 'Quarterly review preparation',
      requestId: 'req-1',
      omitted: [],
      succeeded: true,
    };
    const manager = await requireAccessLog(failing, { ...entry, audience: 'reporting_manager' });
    expect(manager.mayRender).toBe(false);
    expect(manager.logged).toBe(false);

    // A person reading their OWN record is not blocked by a logging hiccup.
    const self = await requireAccessLog(failing, { ...entry, audience: 'self' });
    expect(self.mayRender).toBe(true);
    expect(self.logged).toBe(false);
  });

  it('treats a throwing logger as a failed log, not as a success', async () => {
    const throwing = {
      async log(): Promise<never> {
        const e: any = new Error('insert into hzn_access_log ...');
        e.cause = { message: 'relation "hzn_access_log" does not exist' };
        throw e;
      },
    };
    const r = await requireAccessLog(throwing, {
      organisationId: DEFAULT_ORGANISATION_ID,
      actor: { kind: 'user', id: 'u-9' },
      subject,
      audience: 'auditor',
      visibilityServed: 'restricted',
      purpose: 'Scheduled control testing',
      requestId: 'req-1',
      omitted: [],
      succeeded: true,
    });
    expect(r.mayRender).toBe(false);
    // The REAL reason, from e.cause — not the failed statement.
    expect(r.error).toMatch(/does not exist/);
  });
});

// -------------------------------------------------------------------------------------------------
// 6. API RESPONSES
// -------------------------------------------------------------------------------------------------

describe('api response contract', () => {
  const meta = { requestId: 'req-1', organisationId: DEFAULT_ORGANISATION_ID, audience: 'self' };

  it('distinguishes an empty answer from a failure', () => {
    const empty = apiOk<string[]>([], meta);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data).toEqual([]);
    const failed = apiErr(API_ERROR_CODES.INTERNAL, 'could not read', meta);
    expect(failed.ok).toBe(false);
  });

  it('maps a failed access log to 503, not 500', () => {
    expect(httpStatusFor(API_ERROR_CODES.ACCESS_LOG_FAILED)).toBe(503);
    expect(isRetryable(API_ERROR_CODES.ACCESS_LOG_FAILED)).toBe(true);
    expect(httpStatusFor(API_ERROR_CODES.FORBIDDEN)).toBe(403);
    expect(httpStatusFor(API_ERROR_CODES.PURPOSE_REQUIRED)).toBe(400);
    expect(isRetryable(API_ERROR_CODES.FORBIDDEN)).toBe(false);
  });

  it('defaults accessLogged to false, so a forgotten log is never claimed', () => {
    expect(responseMeta(meta).accessLogged).toBe(false);
    expect(responseMeta({ ...meta, accessLogged: true }).accessLogged).toBe(true);
    expect(responseMeta(meta).contractVersion).toBe(HORIZON_API_VERSION);
    expect(responseMeta(meta).withheld).toEqual([]);
  });

  it('keeps the real database reason out of the client and hands it to the caller to log', () => {
    const e: any = new Error('select * from hzn_result ...');
    e.cause = { message: 'permission denied for table hzn_intelligence_result' };
    const { response, logReason } = apiErrFromException(e, meta);
    expect(logReason).toMatch(/permission denied/);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.message).not.toMatch(/permission denied/);
      expect(response.error.message).not.toMatch(/select/i);
    }
  });

  it('pages by overfetching one row rather than counting the table', () => {
    const rows = ['a', 'b', 'c', 'd'];
    const p = pageFrom(rows, 3, (r) => r);
    expect(p.items).toEqual(['a', 'b', 'c']);
    expect(p.page.hasMore).toBe(true);
    expect(p.page.nextCursor).toBe('c');
    const last = pageFrom(['a'], 3, (r) => r);
    expect(last.page.hasMore).toBe(false);
    expect(last.page.nextCursor).toBeNull();
    expect(clampPageSize('9999')).toBe(PAGE_MAX_SIZE);
    expect(clampPageSize(undefined)).toBe(PAGE_DEFAULT_SIZE);
    expect(clampPageSize(-4)).toBe(PAGE_DEFAULT_SIZE);
  });
});

// -------------------------------------------------------------------------------------------------
// 19. LANGUAGE POLICY
// -------------------------------------------------------------------------------------------------

describe('language policy', () => {
  it('catches the forbidden vocabulary wherever it appears in copy', () => {
    expect(checkPublicCopy('A neutral sentence.').ok).toBe(true);
    expect(checkPublicCopy('Based on the ASTROLOGY module').ok).toBe(false);
    expect(checkPublicCopy('their natal chart suggests').found).toContain('natal chart');
    expect(FORBIDDEN_UI_TERMS.length).toBeGreaterThan(0);
  });

  it('uses none of it in any exported label of this module', () => {
    const labels = [
      ...Object.values(DIMENSION_FAMILY_LABELS),
      ...Object.values(EVIDENCE_CLASS_LABELS),
      ...Object.values(COLLECTION_BASIS_LABELS),
      ...DATA_LAYERS.map((l) => DATA_LAYER_SPECS[l].label),
      ...DATA_LAYERS.map((l) => DATA_LAYER_SPECS[l].meaning),
      ...ENGINE_CLASSES.map((e) => ENGINE_CLASS_SPECS[e].label),
      ...HORIZON_AUDIENCES.map((a) => AUDIENCE_SPECS[a].label),
      ...VISIBILITY_CLASSES.map((v) => VISIBILITY_SPECS[v].label),
      ...VISIBILITY_CLASSES.map((v) => VISIBILITY_SPECS[v].meaning),
    ];
    for (const label of labels) {
      expect(checkPublicCopy(label).found, 'label: ' + label).toEqual([]);
    }
  });

  it('gives the traditional-computation family a neutral name', () => {
    expect(DIMENSION_FAMILIES).toContain('temporal_pattern');
    expect(checkPublicCopy(DIMENSION_FAMILY_LABELS.temporal_pattern).ok).toBe(true);
    expect(checkPublicCopy(ENGINE_CLASS_SPECS.traditional_computation.label).ok).toBe(true);
  });

  it('refuses a result or signal whose copy breaks the policy', () => {
    expect(validateIntelligenceResult(goodResult({ summary: 'Their horoscope indicates delay.' })).ok).toBe(false);
    expect(validateSignal(goodSignal({ title: 'Zodiac mismatch with the team' })).ok).toBe(false);
    expect(validateEvidence(goodEvidence({ summary: 'From the birth chart.' })).ok).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// TIMESTAMPS
// -------------------------------------------------------------------------------------------------

describe('timestamps', () => {
  it('accepts ISO 8601 and rejects everything else', () => {
    expect(isIsoTimestamp(new Date().toISOString())).toBe(true);
    expect(isIsoTimestamp('2026-08-23T10:00:00+05:30')).toBe(true);
    expect(isIsoTimestamp('2026-08-23')).toBe(false);
    expect(isIsoTimestamp('yesterday')).toBe(false);
    expect(isIsoTimestamp(1756000000000)).toBe(false);
  });
});
