// src/lib/fusion/fuse.test.ts — THE RULES THAT MUST NOT BE SILENTLY LOST.
//
// Every test here is about a PROMISE this engine makes about a person, not about an implementation
// detail. If one of them fails, something has changed about what the system is willing to say about
// a human being — which is exactly the class of change that must never pass unnoticed.
//
// The clock is passed in on every call, so these assertions are the same on any machine on any day.
import { describe, it, expect } from 'vitest';
import {
  fuseDimension,
  fuseProfile,
  screenSignal,
  classPosition,
  agreementOf,
  computeConfidence,
  positionToReading,
  CONTRADICTION_GAP,
} from './fuse';
import {
  validateSourceWeights,
  DEFAULT_SOURCE_WEIGHTS,
  INFERRED_CEILING,
  DEMONSTRATED_MULTIPLE,
  demonstratedTotal,
  weightingSentence,
  completenessPct,
} from './weights';
import {
  FUSION_DIMENSIONS,
  SOURCE_CLASSES,
  DIMENSION_SPECS,
  dimensionSpec,
  isInverted,
  type Signal,
  type SourceClass,
  type FusionDimension,
} from './types';

const NOW = new Date('2026-08-23T10:00:00.000Z');
const RECENT = '2026-07-01T00:00:00.000Z';
const OLD = '2022-01-01T00:00:00.000Z';

let seq = 0;
function signal(over: Partial<Signal> & { dimension: FusionDimension; sourceClass: SourceClass }): Signal {
  seq += 1;
  return {
    signalId: 'sig-' + seq,
    providerKey: 'test',
    ownerModule: 'src/lib/fusion/fuse.test.ts',
    sourceTable: null,
    sourceId: null,
    position: 0.5,
    strength: 0.8,
    observedAt: RECENT,
    statement: 'Delivered the migration work that was asked for.',
    basis: 'A record a named person accepted.',
    assertion: 'factual',
    evidenceUrl: null,
    locator: null,
    attributedToUserId: null,
    attributedToRelationship: null,
    advisoryNotice: over.sourceClass === 'inferred_foundation'
      ? 'A starting hypothesis, not a finding, and never a scientific fact about this person.'
      : null,
    ...over,
  } as Signal;
}

// -------------------------------------------------------------------------------------------------
// THE CONTRACT ITSELF
// -------------------------------------------------------------------------------------------------

describe('the closed unions', () => {
  it('reports exactly the ten dimensions the patch specifies, in order', () => {
    expect(FUSION_DIMENSIONS).toEqual([
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
    ]);
  });

  it('listens to exactly the five source classes the patch specifies', () => {
    expect([...SOURCE_CLASSES].sort()).toEqual([
      'assessment_evidence',
      'inferred_foundation',
      'manager_evidence',
      'observed_evidence',
      'peer_evidence',
    ]);
  });

  it('gives every dimension a spec, a question and a stated polarity', () => {
    expect(DIMENSION_SPECS.length).toBe(FUSION_DIMENSIONS.length);
    for (const d of FUSION_DIMENSIONS) {
      const spec = dimensionSpec(d);
      expect(spec, d).toBeTruthy();
      expect(spec.question.length, d).toBeGreaterThan(10);
      expect(spec.highMeans.length, d).toBeGreaterThan(10);
      expect(spec.lowMeans.length, d).toBeGreaterThan(10);
    }
  });

  it('refuses inference on the three dimensions that ask what a person actually did', () => {
    const refused = DIMENSION_SPECS.filter((s) => !s.inferenceAdmissible).map((s) => s.key).sort();
    expect(refused).toEqual(['current_capability', 'development_requirements', 'role_alignment']);
  });

  it('marks development requirements, and only it, as inverted', () => {
    expect(FUSION_DIMENSIONS.filter(isInverted)).toEqual(['development_requirements']);
  });
});

// -------------------------------------------------------------------------------------------------
// THE WEIGHTING RULE
// -------------------------------------------------------------------------------------------------

describe('the weighting rule: demonstrated evidence must outweigh inference', () => {
  it('accepts the built-in default', () => {
    const v = validateSourceWeights(DEFAULT_SOURCE_WEIGHTS);
    expect(v.ok).toBe(true);
    expect(v.rejected).toEqual([]);
  });

  it('the built-in default already satisfies both limits', () => {
    const inferred = DEFAULT_SOURCE_WEIGHTS.inferred_foundation;
    expect(inferred).toBeLessThanOrEqual(INFERRED_CEILING);
    expect(demonstratedTotal(DEFAULT_SOURCE_WEIGHTS)).toBeGreaterThanOrEqual(inferred * DEMONSTRATED_MULTIPLE);
  });

  it('REFUSES an inferred foundation above the ceiling, with the number in the sentence', () => {
    const v = validateSourceWeights({ ...DEFAULT_SOURCE_WEIGHTS, inferred_foundation: INFERRED_CEILING + 1 });
    expect(v.ok).toBe(false);
    expect(v.error).toContain(String(INFERRED_CEILING + 1));
    expect(v.error).toContain(String(INFERRED_CEILING));
  });

  it('REFUSES a weighting where demonstrated evidence is not four times the foundation', () => {
    const v = validateSourceWeights({
      observed_evidence: 10,
      manager_evidence: 5,
      assessment_evidence: 5,
      peer_evidence: 5,
      inferred_foundation: 15,
    });
    expect(v.ok).toBe(false);
    expect(v.error).toContain('4 times');
  });

  it('allows the foundation to be switched off entirely', () => {
    const v = validateSourceWeights({ ...DEFAULT_SOURCE_WEIGHTS, inferred_foundation: 0 });
    expect(v.ok).toBe(true);
    expect(weightingSentence(v.weights)).toContain('set to zero');
  });

  it('REFUSES a sixth kind of evidence BY NAME rather than dropping it', () => {
    const v = validateSourceWeights({ ...DEFAULT_SOURCE_WEIGHTS, culture_fit: 40 });
    expect(v.ok).toBe(false);
    expect(v.rejected).toEqual(['culture_fit']);
    expect(v.error).toContain('culture_fit');
  });

  it('refuses a weighting that weighs nothing', () => {
    const v = validateSourceWeights({
      observed_evidence: 0, manager_evidence: 0, assessment_evidence: 0,
      peer_evidence: 0, inferred_foundation: 0,
    });
    expect(v.ok).toBe(false);
    expect(v.error).toContain('zero');
  });

  it('reports completeness over the classes that were actually present', () => {
    expect(completenessPct(DEFAULT_SOURCE_WEIGHTS, [])).toBe(0);
    expect(completenessPct(DEFAULT_SOURCE_WEIGHTS, [...SOURCE_CLASSES])).toBe(100);
    expect(completenessPct(DEFAULT_SOURCE_WEIGHTS, ['observed_evidence'])).toBe(32);
  });
});

// -------------------------------------------------------------------------------------------------
// SCREENING
// -------------------------------------------------------------------------------------------------

describe('screening — what may never enter a reading about a person', () => {
  it('refuses a signal naming a protected attribute', () => {
    const r = screenSignal(signal({
      dimension: 'collaboration',
      sourceClass: 'manager_evidence',
      statement: 'Works well despite a recent medical diagnosis.',
    }));
    expect(r.ok).toBe(false);
    expect(r.because).toContain('protected');
  });

  it('refuses a forbidden person-outcome prediction written as PROSE, not just as a column name', () => {
    // The owner's patterns are spelled `flight_?risk` because they were written to screen field
    // names. A provider writes sentences, so the text is normalised into field-name shape before it
    // is asked. Without that step this exact string passed a rule that exists to stop it.
    const r = screenSignal(signal({
      dimension: 'growth_potential',
      sourceClass: 'observed_evidence',
      statement: 'Flight risk is elevated this quarter.',
    }));
    expect(r.ok).toBe(false);
  });

  it('is deliberately broad, and refuses an innocuous phrase that happens to name a protected word', () => {
    // "analytical orientation" is a perfectly ordinary thing to write and it is REFUSED, because the
    // protected pattern covers `orientation`. That is the trade the owner of the vocabulary made on
    // purpose: a false refusal costs a provider a rewording, a false acceptance creates the field
    // this product promised never to have. It is asserted here so a provider author who hits it
    // finds the reason rather than assuming a bug.
    const r = screenSignal(signal({
      dimension: 'learning_capacity',
      sourceClass: 'inferred_foundation',
      statement: 'Initial profile suggests a high analytical orientation.',
    }));
    expect(r.ok).toBe(false);
    expect(r.because).toContain('protected');
  });

  it('refuses a surveillance signal', () => {
    const r = screenSignal(signal({
      dimension: 'work_sustainability',
      sourceClass: 'observed_evidence',
      basis: 'Derived from keystroke counts over the last month.',
    }));
    expect(r.ok).toBe(false);
  });

  it('refuses a signal that is really somebody’s termination decision', () => {
    const r = screenSignal(signal({
      dimension: 'role_alignment',
      sourceClass: 'manager_evidence',
      statement: 'Recommended for dismissal at the next review.',
    }));
    expect(r.ok).toBe(false);
  });

  it('refuses an inferred signal that arrives without its advisory notice', () => {
    const s = signal({ dimension: 'growth_potential', sourceClass: 'inferred_foundation' });
    s.advisoryNotice = null;
    const r = screenSignal(s);
    expect(r.ok).toBe(false);
    expect(r.because).toContain('advisory');
  });

  it('refuses a dimension outside the closed union, by name', () => {
    const r = screenSignal(signal({ dimension: 'culture_fit' as FusionDimension, sourceClass: 'peer_evidence' }));
    expect(r.ok).toBe(false);
    expect(r.because).toContain('culture_fit');
  });

  it('refuses a position outside -1..+1', () => {
    const r = screenSignal(signal({ dimension: 'collaboration', sourceClass: 'peer_evidence', position: 4 }));
    expect(r.ok).toBe(false);
  });

  it('accepts an ordinary, well-formed signal', () => {
    expect(screenSignal(signal({ dimension: 'collaboration', sourceClass: 'peer_evidence' })).ok).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// THE REFUSALS THAT ARE THE POINT
// -------------------------------------------------------------------------------------------------

describe('a refusal is never a zero', () => {
  it('produces NO reading when nothing is on record', () => {
    const r = fuseDimension({ dimension: 'collaboration', signals: [], weights: DEFAULT_SOURCE_WEIGHTS, now: NOW });
    expect(r.status).toBe('nothing_on_record');
    expect(r.reading).toBeNull();
    expect(r.sentence).toContain('empty record');
  });

  it('produces NO reading when the only thing on record is an inference', () => {
    const r = fuseDimension({
      dimension: 'growth_potential',
      signals: [signal({ dimension: 'growth_potential', sourceClass: 'inferred_foundation', position: 0.9 })],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    expect(r.status).toBe('foundation_only');
    expect(r.reading).toBeNull();
    expect(r.sentence).toContain('does not turn one into a');
  });

  it('still produces no reading from inference alone even at the maximum permitted weight', () => {
    const weights = { ...DEFAULT_SOURCE_WEIGHTS, inferred_foundation: INFERRED_CEILING };
    const r = fuseDimension({
      dimension: 'leadership_readiness',
      signals: [signal({ dimension: 'leadership_readiness', sourceClass: 'inferred_foundation', position: 1 })],
      weights,
      now: NOW,
    });
    expect(r.reading).toBeNull();
  });

  it('always reports all five source classes, silent ones included', () => {
    const r = fuseDimension({ dimension: 'collaboration', signals: [], weights: DEFAULT_SOURCE_WEIGHTS, now: NOW });
    expect(r.sources.map((s) => s.sourceClass).sort()).toEqual([...SOURCE_CLASSES].sort());
    for (const s of r.sources) expect(s.position).toBeNull();
  });
});

describe('inference is not admitted where the question is what somebody actually did', () => {
  it('gives the foundation zero effective weight on current capability, and says why', () => {
    const r = fuseDimension({
      dimension: 'current_capability',
      signals: [
        signal({ dimension: 'current_capability', sourceClass: 'inferred_foundation', position: 1 }),
        signal({ dimension: 'current_capability', sourceClass: 'assessment_evidence', position: -0.4 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    const found = r.sources.find((s) => s.sourceClass === 'inferred_foundation')!;
    expect(found.signalCount).toBe(1);
    expect(found.position).toBeCloseTo(1);
    expect(found.effectiveWeight).toBe(0);
    expect(found.withheldBecause).toContain('Not admitted');
    // The reading comes from the assessment alone, so it must sit on the negative side.
    expect(r.reading).toBe(positionToReading(-0.4));
  });

  it('shows the refused foundation rather than hiding it', () => {
    const r = fuseDimension({
      dimension: 'role_alignment',
      signals: [signal({ dimension: 'role_alignment', sourceClass: 'inferred_foundation', position: 0.8 })],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    expect(r.sources.find((s) => s.sourceClass === 'inferred_foundation')!.signalCount).toBe(1);
    expect(r.agreement.join(' ')).toContain('was not admitted');
  });
});

describe('the deference rule: evidence displaces inference rather than averaging with it', () => {
  it('sets the foundation aside when the demonstrated record contradicts it', () => {
    const r = fuseDimension({
      dimension: 'growth_potential',
      signals: [
        signal({ dimension: 'growth_potential', sourceClass: 'inferred_foundation', position: 0.9 }),
        signal({ dimension: 'growth_potential', sourceClass: 'manager_evidence', position: -0.6 }),
        signal({ dimension: 'growth_potential', sourceClass: 'assessment_evidence', position: -0.5 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    const found = r.sources.find((s) => s.sourceClass === 'inferred_foundation')!;
    expect(found.effectiveWeight).toBe(0);
    expect(found.withheldBecause).toContain('contradicts');
    expect(r.contradiction.join(' ')).toContain('set aside');
    // Nothing the foundation said may pull the reading up past what the record shows.
    expect(r.reading!).toBeLessThan(positionToReading(-0.4));
  });

  it('admits the foundation when the record broadly agrees with it', () => {
    const r = fuseDimension({
      dimension: 'growth_potential',
      signals: [
        signal({ dimension: 'growth_potential', sourceClass: 'inferred_foundation', position: 0.6 }),
        signal({ dimension: 'growth_potential', sourceClass: 'manager_evidence', position: 0.5 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    const found = r.sources.find((s) => s.sourceClass === 'inferred_foundation')!;
    expect(found.effectiveWeight).toBe(DEFAULT_SOURCE_WEIGHTS.inferred_foundation);
    expect(found.withheldBecause).toBeNull();
  });

  it('a hostile foundation cannot move a well-evidenced reading by more than a few points', () => {
    const evidence = [
      signal({ dimension: 'learning_capacity', sourceClass: 'observed_evidence', position: 0.7 }),
      signal({ dimension: 'learning_capacity', sourceClass: 'manager_evidence', position: 0.7 }),
      signal({ dimension: 'learning_capacity', sourceClass: 'assessment_evidence', position: 0.7 }),
      signal({ dimension: 'learning_capacity', sourceClass: 'peer_evidence', position: 0.7 }),
    ];
    const withoutFoundation = fuseDimension({
      dimension: 'learning_capacity', signals: evidence, weights: DEFAULT_SOURCE_WEIGHTS, now: NOW,
    });
    // A foundation just inside the contradiction gap, so deference does NOT fire and it counts.
    const withFoundation = fuseDimension({
      dimension: 'learning_capacity',
      signals: [
        ...evidence,
        signal({ dimension: 'learning_capacity', sourceClass: 'inferred_foundation', position: 0.7 - (CONTRADICTION_GAP - 0.01) }),
      ],
      weights: { ...DEFAULT_SOURCE_WEIGHTS, inferred_foundation: INFERRED_CEILING },
      now: NOW,
    });
    const moved = Math.abs(withoutFoundation.reading! - withFoundation.reading!);
    expect(moved).toBeLessThanOrEqual(8);
  });
});

// -------------------------------------------------------------------------------------------------
// AGREEMENT AND CONTRADICTION — THE PATCH'S OWN EXAMPLE
// -------------------------------------------------------------------------------------------------

describe('the output explains agreement and contradiction', () => {
  it('reproduces the worked example: foundation high, assessment strongly confirms, manager partially confirms', () => {
    const r = fuseDimension({
      dimension: 'learning_capacity',
      signals: [
        signal({
          dimension: 'learning_capacity', sourceClass: 'inferred_foundation', position: 0.8,
          statement: 'Initial profile suggests a high analytical disposition.',
        }),
        signal({ dimension: 'learning_capacity', sourceClass: 'assessment_evidence', position: 0.75 }),
        signal({ dimension: 'learning_capacity', sourceClass: 'manager_evidence', position: 0.35 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      previous: { reading: 60, confidenceValue: 30, computedAt: '2026-05-01T00:00:00.000Z' },
      now: NOW,
    });

    const assessment = r.sources.find((s) => s.sourceClass === 'assessment_evidence')!;
    const manager = r.sources.find((s) => s.sourceClass === 'manager_evidence')!;
    expect(assessment.agreement).toBe('strongly_confirms');
    expect(manager.agreement).toBe('partially_confirms');

    expect(r.agreement.join(' ')).toContain('Initial profile suggests a high analytical disposition.');
    expect(r.agreement.join(' ')).toContain('Assessment evidence: strongly confirms.');
    expect(r.agreement.join(' ')).toContain('Manager evidence: partially confirms.');
    expect(r.explanation.confidence.direction).toBe('increasing');
  });

  it('names a disagreement between two demonstrated records rather than averaging it away', () => {
    const r = fuseDimension({
      dimension: 'collaboration',
      signals: [
        signal({ dimension: 'collaboration', sourceClass: 'manager_evidence', position: 0.8 }),
        signal({ dimension: 'collaboration', sourceClass: 'peer_evidence', position: -0.6 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    const text = r.contradiction.join(' ');
    expect(text).toContain('Manager evidence');
    expect(text).toContain('Peer evidence');
    expect(text).toContain('question to ask, not a finding');
    // Both stay on the record. Neither is dropped.
    expect(r.sources.find((s) => s.sourceClass === 'manager_evidence')!.effectiveWeight).toBeGreaterThan(0);
    expect(r.sources.find((s) => s.sourceClass === 'peer_evidence')!.effectiveWeight).toBeGreaterThan(0);
  });

  it('classifies agreement by distance from the foundation', () => {
    expect(agreementOf(0.8, 0.8)).toBe('strongly_confirms');
    expect(agreementOf(0.35, 0.8)).toBe('partially_confirms');
    expect(agreementOf(0.0, 0.8)).toBe('does_not_confirm');
    expect(agreementOf(-0.5, 0.8)).toBe('contradicts');
    expect(agreementOf(null, 0.8)).toBe('silent');
    expect(agreementOf(0.5, null)).toBe('no_foundation_to_compare');
  });
});

// -------------------------------------------------------------------------------------------------
// CONFIDENCE AND EVOLUTION
// -------------------------------------------------------------------------------------------------

describe('confidence', () => {
  const view = (c: SourceClass, position: number | null, strength: number, at: string | null) => ({
    sourceClass: c, label: c, signalCount: position === null ? 0 : 1, position, strength,
    weight: 20, effectiveWeight: 20, withheldBecause: null, agreement: 'silent' as const,
    mostRecentAt: at, signals: [],
  });

  it('is insufficient when only an inference contributed, whatever its weight', () => {
    const c = computeConfidence({
      sources: [view('inferred_foundation', 0.9, 1, RECENT)],
      previousValue: null,
      nowMs: NOW.getTime(),
    });
    expect(c.band).toBe('insufficient');
    expect(c.value).toBe(0);
    expect(c.independentSources).toBe(0);
    expect(c.sentence).toContain('empty record');
  });

  it('rises with the number of independent demonstrated sources', () => {
    const one = computeConfidence({
      sources: [view('manager_evidence', 0.6, 1, RECENT)], previousValue: null, nowMs: NOW.getTime(),
    });
    const four = computeConfidence({
      sources: [
        view('manager_evidence', 0.6, 1, RECENT),
        view('peer_evidence', 0.6, 1, RECENT),
        view('observed_evidence', 0.6, 1, RECENT),
        view('assessment_evidence', 0.6, 1, RECENT),
      ],
      previousValue: null, nowMs: NOW.getTime(),
    });
    expect(four.value).toBeGreaterThan(one.value);
    expect(four.independentSources).toBe(4);
  });

  it('falls when the newest evidence is years old', () => {
    const fresh = computeConfidence({
      sources: [view('manager_evidence', 0.6, 1, RECENT), view('peer_evidence', 0.6, 1, RECENT)],
      previousValue: null, nowMs: NOW.getTime(),
    });
    const stale = computeConfidence({
      sources: [view('manager_evidence', 0.6, 1, OLD), view('peer_evidence', 0.6, 1, OLD)],
      previousValue: null, nowMs: NOW.getTime(),
    });
    expect(stale.value).toBeLessThan(fresh.value);
    expect(stale.recencyDays).toBeGreaterThan(365);
  });

  it('reports direction against the previous snapshot', () => {
    const base = { sources: [view('manager_evidence', 0.6, 1, RECENT)], nowMs: NOW.getTime() };
    expect(computeConfidence({ ...base, previousValue: null }).direction).toBe('first_reading');
    expect(computeConfidence({ ...base, previousValue: 5 }).direction).toBe('increasing');
    expect(computeConfidence({ ...base, previousValue: 95 }).direction).toBe('decreasing');
    const v = computeConfidence({ ...base, previousValue: null }).value;
    expect(computeConfidence({ ...base, previousValue: v }).direction).toBe('steady');
  });
});

describe('evolution over time', () => {
  it('states movement against the previous reading, and says what it does not mean', () => {
    const r = fuseDimension({
      dimension: 'current_capability',
      signals: [
        signal({ dimension: 'current_capability', sourceClass: 'observed_evidence', position: 0.6 }),
        signal({ dimension: 'current_capability', sourceClass: 'assessment_evidence', position: 0.6 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      previous: { reading: 50, confidenceValue: 40, computedAt: '2026-02-01T00:00:00.000Z' },
      now: NOW,
    });
    expect(r.change.previousReading).toBe(50);
    expect(r.change.delta).toBe(r.reading! - 50);
    expect(r.change.sentence).toContain('The record moved');
  });

  it('says plainly that one point is not a trajectory', () => {
    const r = fuseDimension({
      dimension: 'professional_trajectory',
      signals: [signal({ dimension: 'professional_trajectory', sourceClass: 'observed_evidence', position: 0.5 })],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    expect(r.change.sentence).toContain('first reading');
  });

  it('reads the inverted dimension the right way round', () => {
    const r = fuseDimension({
      dimension: 'development_requirements',
      signals: [
        signal({
          dimension: 'development_requirements', sourceClass: 'manager_evidence', position: 0.8,
          statement: 'Needs structured support on data modelling before the next project.',
        }),
        signal({ dimension: 'development_requirements', sourceClass: 'observed_evidence', position: 0.7 }),
      ],
      weights: DEFAULT_SOURCE_WEIGHTS,
      previous: { reading: 40, confidenceValue: 40, computedAt: '2026-02-01T00:00:00.000Z' },
      now: NOW,
    });
    expect(r.inverted).toBe(true);
    expect(r.sentence).toContain('development need');
    expect(r.change.sentence).toContain('more is outstanding');
    expect(r.developmentNeeds).toContain('Needs structured support on data modelling before the next project.');
  });
});

// -------------------------------------------------------------------------------------------------
// THE WHOLE PROFILE
// -------------------------------------------------------------------------------------------------

describe('the profile', () => {
  it('always returns all ten dimensions in their declared order, however little is on record', () => {
    const dims = fuseProfile({ signals: [], weights: DEFAULT_SOURCE_WEIGHTS, now: NOW });
    expect(dims.map((d) => d.dimension)).toEqual([...FUSION_DIMENSIONS]);
    for (const d of dims) {
      expect(d.reading, d.dimension).toBeNull();
      expect(d.status, d.dimension).toBe('nothing_on_record');
      expect(d.decisionUse, d.dimension).toBe('advisory_only');
    }
  });

  it('carries the full six-part explanation on every reading', () => {
    const dims = fuseProfile({
      signals: [signal({ dimension: 'collaboration', sourceClass: 'peer_evidence', position: 0.4 })],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    for (const d of dims) {
      expect(d.explanation.inputs.length, d.dimension).toBe(SOURCE_CLASSES.length);
      expect(d.explanation.processing.length, d.dimension).toBeGreaterThan(0);
      expect(d.explanation.output.length, d.dimension).toBeGreaterThan(0);
      expect(d.explanation.confidence, d.dimension).toBeTruthy();
      expect(d.explanation.computedAt, d.dimension).toBe(NOW.toISOString());
    }
  });

  it('never produces an overall score for a person', () => {
    const dims = fuseProfile({ signals: [], weights: DEFAULT_SOURCE_WEIGHTS, now: NOW });
    expect((dims as any).overall).toBeUndefined();
    expect((dims as any).score).toBeUndefined();
  });

  it('reports a refused signal in the processing trail rather than dropping it', () => {
    const d = fuseDimension({
      dimension: 'collaboration',
      signals: [signal({
        dimension: 'collaboration', sourceClass: 'peer_evidence',
        statement: 'Assessed on their religious observance.',
      })],
      weights: DEFAULT_SOURCE_WEIGHTS,
      now: NOW,
    });
    expect(d.status).toBe('nothing_on_record');
    expect(d.explanation.processing.join(' ')).toContain('1 were refused');
    expect(d.explanation.processing.join(' ')).toContain('protected');
  });
});

// -------------------------------------------------------------------------------------------------
// ARITHMETIC
// -------------------------------------------------------------------------------------------------

describe('arithmetic', () => {
  it('maps a position onto a reading, and the midpoint is 50', () => {
    expect(positionToReading(-1)).toBe(0);
    expect(positionToReading(0)).toBe(50);
    expect(positionToReading(1)).toBe(100);
  });

  it('weights a class position by how substantial each signal is', () => {
    const strong = { position: 1, strength: 1 } as Signal;
    const weak = { position: -1, strength: 0.1 } as Signal;
    const { position } = classPosition([strong, weak]);
    expect(position!).toBeGreaterThan(0.7);
  });

  it('returns null rather than a neutral midpoint when every signal carries no strength', () => {
    const { position, strength } = classPosition([{ position: 1, strength: 0 } as Signal]);
    expect(position).toBeNull();
    expect(strength).toBe(0);
  });
});
