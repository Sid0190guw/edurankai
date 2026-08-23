// src/lib/horizon/interpretation/interpretation.test.ts
//
// The tests that matter here are not the arithmetic ones. They are the four that hold the layer's
// promises up against the code:
//
//   1. Nothing in the catalogue — the only words that can reach a screen — names the methodology,
//      states a prediction, makes a health statement or expresses an employment decision.
//   2. No indication can ever be emitted above the confidence ceiling, however many inputs agree.
//   3. Demonstrated evidence demotes an indication rather than sitting beside it as an equal.
//   4. A viewer without the trace capability receives an object with no trace in it, not a page
//      that merely declines to render one.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DIMENSION_IDS,
  DIMENSION_LIST,
  UNIVERSAL_LIMITATIONS,
  implicationsFor,
  limitationsFor,
  DIMENSION_LEVELS,
  type DimensionId,
} from './dimensions';
import {
  scanText,
  guardText,
  guardUpstreamNote,
  languageGuardSelfCheck,
  DEFAULT_FALLBACK,
} from './language-guard';
import {
  interpret,
  projectForViewer,
  engineSelfCheck,
  levelFor,
  bandFor,
  INFERRED_CONFIDENCE_CEILING,
  MIN_MASS,
  NOT_FOR_DECISIONS_NOTICE,
} from './engine';
import {
  clearFactorMapping,
  clearFoundationalProvider,
  digestFactorSet,
  registerFactorMapping,
  registerFoundationalProvider,
  fetchFoundationalFactors,
  validateFactorSet,
  validateFactorMapping,
  type FoundationalFactor,
  type FoundationalFactorSet,
} from './contract';
import { resolvePrecedence, type EvidenceContext } from './evidence';
import {
  FOUNDATIONAL_ADAPTER_NAME,
  connectFoundationalEngine,
  foundationalMappingKey,
  __adapterInternals,
} from './foundational-adapter';

// -------------------------------------------------------------------------------------------------
// Fixtures. Deliberately opaque codes — this layer must work without knowing what they mean.
// -------------------------------------------------------------------------------------------------

function factor(overrides: Partial<FoundationalFactor> & { id: string }): FoundationalFactor {
  return {
    code: 'F-' + overrides.id,
    weight: 0.8,
    polarity: 1,
    confidence: 0.9,
    method: 'upstream-method',
    methodVersion: '1.0.0',
    ...overrides,
  } as FoundationalFactor;
}

function factorSet(factors: FoundationalFactor[], overrides: Partial<FoundationalFactorSet> = {}): FoundationalFactorSet {
  return {
    subject: { kind: 'employee', id: 'emp-1' },
    factors,
    computedAt: '2026-08-01T00:00:00.000Z',
    sourceModule: 'patch-02',
    sourceVersion: '1.0.0',
    complete: true,
    consentRef: 'consent-1',
    ...overrides,
  };
}

const NOW = '2026-08-23T10:00:00.000Z';

beforeEach(() => {
  clearFactorMapping();
  clearFoundationalProvider();
});

// =================================================================================================
// 1. THE CATALOGUE IS THE ONLY VOCABULARY, AND IT IS CLEAN
// =================================================================================================

describe('dimension catalogue', () => {
  it('publishes exactly the twelve declared dimensions', () => {
    expect(DIMENSION_IDS).toHaveLength(12);
    expect(new Set(DIMENSION_IDS).size).toBe(12);
    expect(DIMENSION_LIST.map((d) => d.id)).toEqual([...DIMENSION_IDS]);
  });

  it('carries no forbidden language anywhere a human can read', () => {
    const offenders: string[] = [];
    const check = (where: string, text: string) => {
      const hits = scanText(text);
      if (hits.length) offenders.push(where + ' :: ' + hits.map((h) => h.group + '="' + h.term + '"').join(', '));
    };
    for (const spec of DIMENSION_LIST) {
      check(spec.id + '.label', spec.label);
      check(spec.id + '.description', spec.description);
      check(spec.id + '.notAbout', spec.notAbout);
      check(spec.id + '.limitation', spec.limitation);
      for (const level of DIMENSION_LEVELS) {
        implicationsFor(spec.id, level).forEach((t, i) => check(spec.id + '.implications.' + level + '[' + i + ']', t));
      }
    }
    UNIVERSAL_LIMITATIONS.forEach((t, i) => check('universal[' + i + ']', t));
    expect(offenders).toEqual([]);
  });

  it('attaches the universal limitations to every dimension', () => {
    for (const id of DIMENSION_IDS) {
      const lims = limitationsFor(id);
      for (const u of UNIVERSAL_LIMITATIONS) expect(lims).toContain(u);
      expect(lims.length).toBe(UNIVERSAL_LIMITATIONS.length + 1);
    }
  });

  it('offers no professional implications for a dimension that could not be indicated', () => {
    for (const id of DIMENSION_IDS) expect(implicationsFor(id, 'indeterminate')).toEqual([]);
  });
});

// =================================================================================================
// 2. THE LANGUAGE GUARD
// =================================================================================================

describe('language guard', () => {
  it('passes its own self-check', () => {
    expect(languageGuardSelfCheck()).toEqual([]);
  });

  it('refuses methodology vocabulary even when it is being denied', () => {
    // The methodology group is NOT negation-exempt: a denial still puts the word on the screen.
    const r = guardText('This is not based on a birth chart.');
    expect(r.clean).toBe(false);
    expect(r.groups).toContain('methodology');
    expect(r.text).toBe(DEFAULT_FALLBACK);
  });

  it('allows the disclaimers this layer is required to print', () => {
    const required = [
      'This is not a prediction and states nothing about what this person will do.',
      'It is not a health assessment and contains no clinical statement of any kind.',
      'It must not be used to make or support a hiring, rejection, promotion, termination or disciplinary decision.',
      'This dimension must never be used as, or alongside, an attrition or flight-risk indicator.',
    ];
    for (const text of required) expect(scanText(text)).toEqual([]);
  });

  it('refuses the same words when they are asserted rather than denied', () => {
    expect(guardText('This indicates an attrition risk.').clean).toBe(false);
    expect(guardText('The candidate shows burnout.').clean).toBe(false);
    expect(guardText('We predict strong delivery.').clean).toBe(false);
    expect(guardText('Recommended for hire.').clean).toBe(false);
  });

  it('substitutes the whole string rather than blanking the matched words', () => {
    const r = guardText('Their planetary influence supports analytical work.');
    expect(r.text).not.toContain('planetary');
    expect(r.text).not.toContain('███');
    expect(r.text).toBe(DEFAULT_FALLBACK);
  });

  it('drops an upstream note entirely rather than substituting one', () => {
    const bad = guardUpstreamNote('Derived from the tenth house of the natal chart.');
    expect(bad.note).toBeNull();
    expect(bad.hits.length).toBeGreaterThan(0);
    const good = guardUpstreamNote('Aggregated across four recorded inputs.');
    expect(good.note).toBe('Aggregated across four recorded inputs.');
  });

  it('does not let a negator on one line exempt an assertion on another', () => {
    const text = 'This is not a prediction.\nThe person is destined for a larger remit.';
    expect(scanText(text).some((h) => h.group === 'prediction')).toBe(true);
  });
});

// =================================================================================================
// 3. THE INPUT CONTRACT
// =================================================================================================

describe('foundational input contract', () => {
  it('reports not_configured when no upstream is connected, and never fabricates one', async () => {
    const r = await fetchFoundationalFactors({ kind: 'employee', id: 'emp-1' });
    expect(r.state).toBe('not_configured');
    expect(r.set).toBeUndefined();
  });

  it('distinguishes a throwing upstream from a missing one', async () => {
    registerFoundationalProvider('broken', async () => {
      throw new Error('upstream exploded');
    });
    const r = await fetchFoundationalFactors({ kind: 'employee', id: 'emp-1' });
    expect(r.state).toBe('unreadable');
  });

  it('drops malformed and duplicate factors instead of coercing them', () => {
    const v = validateFactorSet(
      factorSet([
        factor({ id: 'a' }),
        factor({ id: 'a' }),
        { id: 'b' } as any,
        factor({ id: 'c', weight: 0 }),
      ]),
    );
    expect(v.factors.map((f) => f.id)).toEqual(['a']);
    expect(v.dropped).toBe(3);
  });

  it('refuses a mapping that names a dimension outside the closed list', () => {
    const v = validateFactorMapping({ 'F-1': [{ dimension: 'charisma', weight: 0.5 }] } as any);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('unknown dimension');
  });

  it('resolves a factor through a registered mapping when it declares nothing itself', () => {
    registerFactorMapping('test', { 'F-a': [{ dimension: 'learning_orientation', weight: 1 }] });
    const r = interpret(factorSet([factor({ id: 'a' })]), { now: NOW });
    expect(r.state).toBe('ok');
    expect(r.dimensions.map((d) => d.dimension)).toEqual(['learning_orientation']);
    expect(r.unmappedFactorCount).toBe(0);
  });

  it('digests the same input identically and a changed input differently', () => {
    const a = factorSet([factor({ id: 'a', contributesTo: [{ dimension: 'execution_drive', weight: 1 }] })]);
    const b = factorSet([factor({ id: 'a', contributesTo: [{ dimension: 'execution_drive', weight: 1 }] })]);
    expect(digestFactorSet(a)).toBe(digestFactorSet(b));
    const c = factorSet([factor({ id: 'a', weight: 0.5, contributesTo: [{ dimension: 'execution_drive', weight: 1 }] })]);
    expect(digestFactorSet(c)).not.toBe(digestFactorSet(a));
  });

  it('ignores an upstream note when digesting, because commentary changes no outcome', () => {
    const base = factor({ id: 'a', contributesTo: [{ dimension: 'execution_drive', weight: 1 }] });
    expect(digestFactorSet(factorSet([{ ...base, note: 'one' }]))).toBe(
      digestFactorSet(factorSet([{ ...base, note: 'two' }])),
    );
  });
});

// =================================================================================================
// 4. THE ENGINE
// =================================================================================================

const one = (dim: DimensionId, over: Partial<FoundationalFactor> = {}, id = 'f1') =>
  factor({ id, contributesTo: [{ dimension: dim, weight: 1 }], ...over });

describe('interpretation engine', () => {
  it('passes its own self-check', () => {
    expect(engineSelfCheck()).toEqual([]);
  });

  it('refuses before computing anything when no consent reference is attached', () => {
    const r = interpret(factorSet([one('analytical_orientation')], { consentRef: null }), { now: NOW });
    expect(r.state).toBe('refused');
    expect(r.dimensions).toEqual([]);
    expect(r.inputDigest).toBe('');
    expect(r.reason).toContain('consent');
  });

  it('never emits a dimension above the confidence ceiling, however many inputs agree', () => {
    const factors = Array.from({ length: 25 }, (_, i) =>
      one('analytical_orientation', { weight: 1, polarity: 1, confidence: 1 }, 'f' + i),
    );
    const r = interpret(factorSet(factors), { now: NOW });
    expect(r.state).toBe('ok');
    const d = r.dimensions[0];
    expect(d.confidence).toBeLessThanOrEqual(INFERRED_CONFIDENCE_CEILING);
    expect(d.confidenceBand).not.toBe('high');
    expect(bandFor(INFERRED_CONFIDENCE_CEILING)).not.toBe('high');
  });

  it('reports a dimension nothing reached as not indicated, never as low', () => {
    const r = interpret(factorSet([one('stability_pattern', { weight: MIN_MASS / 2 })]), { now: NOW });
    const d = r.dimensions[0];
    expect(d.level).toBe('indeterminate');
    expect(d.implications).toEqual([]);
    expect(d.explanation).toContain('not indicated');
    expect(levelFor(1, 0)).toBe('indeterminate');
  });

  it('omits dimensions no input reached rather than printing twelve empty rows', () => {
    const r = interpret(factorSet([one('collaboration_tendency')]), { now: NOW });
    expect(r.dimensions).toHaveLength(1);
    expect(r.dimensions[0].dimension).toBe('collaboration_tendency');
  });

  it('counts unmapped inputs and says the interpretation covers less than its input', () => {
    const r = interpret(factorSet([one('execution_drive'), factor({ id: 'orphan' })]), { now: NOW });
    expect(r.unmappedFactorCount).toBe(1);
    expect(r.problems.join(' ')).toContain('contributed to nothing');
  });

  it('returns insufficient_input, not an empty ok, when nothing maps at all', () => {
    const r = interpret(factorSet([factor({ id: 'orphan' })]), { now: NOW });
    expect(r.state).toBe('insufficient_input');
    expect(r.reason).toContain('configuration gap');
  });

  it('lowers confidence when the inputs disagree with each other', () => {
    const agreeing = interpret(
      factorSet([
        one('leadership_tendency', { polarity: 1 }, 'a'),
        one('leadership_tendency', { polarity: 1 }, 'b'),
      ]),
      { now: NOW },
    );
    const conflicting = interpret(
      factorSet([
        one('leadership_tendency', { polarity: 1 }, 'a'),
        one('leadership_tendency', { polarity: -1 }, 'b'),
      ]),
      { now: NOW },
    );
    expect(conflicting.dimensions[0].confidence).toBeLessThan(agreeing.dimensions[0].confidence);
    expect(conflicting.dimensions[0].explanation).toContain('disagree');
  });

  it('lowers confidence when the upstream declares its own input incomplete', () => {
    const complete = interpret(factorSet([one('learning_orientation', { confidence: 0.4 })]), { now: NOW });
    const partial = interpret(
      factorSet([one('learning_orientation', { confidence: 0.4 })], { complete: false }),
      { now: NOW },
    );
    expect(partial.dimensions[0].confidence).toBeLessThan(complete.dimensions[0].confidence);
    expect(partial.dimensions[0].explainability.confidence).toContain('incomplete');
  });

  it('answers all six explainability parts on every dimension', () => {
    const r = interpret(factorSet([one('knowledge_orientation')]), { now: NOW });
    const e = r.dimensions[0].explainability;
    for (const key of ['inputs', 'processing', 'output', 'evidence', 'confidence', 'timestamp'] as const) {
      expect(String(e[key]).length).toBeGreaterThan(0);
    }
    expect(e.timestamp).toBe(NOW);
    expect(e.inputs).toContain(r.inputDigest);
    expect(e.inputs).toContain('patch-02');
  });

  it('carries the standing notice and the not-for-decisions flag on every output', () => {
    const r = interpret(factorSet([one('achievement_orientation')]), { now: NOW });
    expect(r.notice).toBe(NOT_FOR_DECISIONS_NOTICE);
    expect(r.dimensions.every((d) => d.notForDecisions === true)).toBe(true);
  });

  it('emits nothing a human can read that fails the language guard', () => {
    const r = interpret(
      factorSet(DIMENSION_IDS.map((d, i) => one(d, {}, 'f' + i))),
      { now: NOW },
    );
    expect(r.dimensions).toHaveLength(12);
    for (const d of r.dimensions) {
      for (const text of [d.label, d.description, d.notAbout, d.explanation, d.precedenceNote, ...d.implications, ...d.limitations]) {
        expect(scanText(text)).toEqual([]);
      }
    }
    expect(r.redactionCount).toBe(0);
  });

  it('never names the upstream factor code or method in anything a standard viewer receives', () => {
    const r = interpret(
      factorSet([one('adaptation_tendency', { code: 'SECRET_CODE_9', method: 'SECRET_METHOD', note: 'internal note' })]),
      { now: NOW },
    );
    const view = projectForViewer(r, { view: true, trace: false });
    const blob = JSON.stringify(view);
    expect(blob).not.toContain('SECRET_CODE_9');
    expect(blob).not.toContain('SECRET_METHOD');
    expect(blob).not.toContain('internal note');
  });
});

// =================================================================================================
// 5. EVIDENCE PRECEDENCE
// =================================================================================================

describe('demonstrated evidence precedence', () => {
  const demonstrated: EvidenceContext = {
    state: 'ok',
    items: [{ dimension: 'communication_orientation', presence: 'demonstrated', sources: ['capability evidence: 3 records'] }],
  };

  it('demotes an indication that demonstrated work already covers', () => {
    const unchecked = interpret(factorSet([one('communication_orientation')]), { now: NOW });
    const checked = interpret(factorSet([one('communication_orientation')]), { now: NOW, evidence: demonstrated });
    expect(checked.dimensions[0].supersededByEvidence).toBe(true);
    expect(checked.dimensions[0].confidence).toBeLessThan(unchecked.dimensions[0].confidence);
    expect(checked.dimensions[0].implications).toEqual([]);
    expect(checked.dimensions[0].precedence).toBe('demonstrated_evidence_governs');
    expect(checked.dimensions[0].evidenceSources).toContain('capability evidence: 3 records');
  });

  it('says on every dimension when the evidence side was never consulted', () => {
    const r = interpret(factorSet([one('sustained_effort')]), { now: NOW });
    expect(r.dimensions[0].precedence).toBe('evidence_unknown');
    expect(r.dimensions[0].precedenceNote).toContain('not consulted');
  });

  it('treats an absence of evidence as the weakest case, not the strongest', () => {
    const outcome = resolvePrecedence('execution_drive', {
      state: 'ok',
      items: [{ dimension: 'execution_drive', presence: 'nothing_on_record', sources: [] }],
    });
    expect(outcome.superseded).toBe(false);
    expect(outcome.sentence).toContain('weakest');
  });
});

// =================================================================================================
// 6. ROLE-BASED PROJECTION
// =================================================================================================

describe('viewer projection', () => {
  const result = () => interpret(factorSet([one('collaboration_tendency')]), { now: NOW });

  it('returns a refusal, and no dimensions, to an account without the view capability', () => {
    const v = projectForViewer(result(), { view: false, trace: false });
    expect(v.state).toBe('refused');
    expect(v.dimensions).toEqual([]);
  });

  it('omits the trace from the object, not merely from the screen', () => {
    const v = projectForViewer(result(), { view: true, trace: false });
    expect(v.dimensions[0].trace).toBeUndefined();
    expect(v.dimensions[0].contributingFactors).toEqual([]);
    expect(v.dimensions[0].contributingFactorCount).toBe(1);
  });

  it('gives the full trace to an account that holds the trace capability', () => {
    const v = projectForViewer(result(), { view: true, trace: true });
    expect(v.dimensions[0].trace).toBeDefined();
    expect(v.dimensions[0].trace!.length).toBe(1);
    expect(v.dimensions[0].explainability.processing).toContain('input mass');
  });

  it('keeps the neutral output identical for both viewers', () => {
    const full = projectForViewer(result(), { view: true, trace: true }).dimensions[0];
    const limited = projectForViewer(result(), { view: true, trace: false }).dimensions[0];
    expect(limited.level).toBe(full.level);
    expect(limited.confidence).toBe(full.confidence);
    expect(limited.explanation).toBe(full.explanation);
    expect(limited.limitations).toEqual(full.limitations);
  });
});


// =================================================================================================
// 7. THE PATCH 02 ADAPTER
// =================================================================================================
//
// Pure half only. Nothing here loads src/lib/foundational or opens a connection: what is tested is
// the translation, which is the part that can silently carry something across the boundary that
// should not have crossed it.

describe('foundational adapter', () => {
  const { translateFactor, stateForRefusal, SUBJECT_KIND_MAP } = __adapterInternals;

  const upstreamFactor = (over: Record<string, any> = {}) => ({
    factor_id: 'fpc-1',
    category: 'foundational_indicator',
    code: 'indicator.point.sector',
    label: 'Point B02 in sector S04',
    value: 'B02 in S04',
    numeric_value: 12.5,
    strength: 0.62,
    confidence: 0.81,
    calculation_method_version: 'fpc-1.0.0',
    source_inputs: ['date', 'time', 'place'],
    evidence: [{ ref: 'raw.points.B02.siderealLongitude', kind: 'computed_position', value: 102.5 }],
    components: { dignity: 0.3, angularity: 0.2 },
    technical: { term: 'a framework term that must never cross this boundary' },
    computed_at: '2026-08-01T00:00:00.000Z',
    ...over,
  });

  it('keys a factor on code AND value, because the code alone names every factor of that shape', () => {
    expect(foundationalMappingKey({ code: 'indicator.point.sector', value: 'B02 in S04' }))
      .toBe('indicator.point.sector|B02 in S04');
    expect(foundationalMappingKey({ code: 'indicator.point.sector', value: 'B03 in S04' }))
      .not.toBe(foundationalMappingKey({ code: 'indicator.point.sector', value: 'B02 in S04' }));
  });

  it('carries no technical layer, no evidence pointers and no components across the boundary', () => {
    const f = translateFactor(upstreamFactor())!;
    const blob = JSON.stringify(f);
    expect(blob).not.toContain('framework term');
    expect(blob).not.toContain('siderealLongitude');
    expect(blob).not.toContain('dignity');
    expect(f.note).toBeUndefined();
  });

  it('translates a magnitude as a magnitude, with no direction invented for it', () => {
    const f = translateFactor(upstreamFactor())!;
    expect(f.weight).toBe(0.62);
    expect(f.confidence).toBe(0.81);
    expect(f.polarity).toBe(0);
    expect(f.methodVersion).toBe('fpc-1.0.0');
    expect(f.contributesTo).toBeUndefined();
  });

  it('drops a factor with no id or no strength rather than defaulting one', () => {
    expect(translateFactor(upstreamFactor({ factor_id: '' }))).toBeNull();
    expect(translateFactor(upstreamFactor({ strength: 0 }))).toBeNull();
  });

  it('keeps the upstream refusal codes distinguishable', () => {
    expect(stateForRefusal('no_consent')).toBe('refused');
    expect(stateForRefusal('not_permitted')).toBe('refused');
    expect(stateForRefusal('input_missing')).toBe('not_configured');
    expect(stateForRefusal('not_found')).toBe('not_configured');
    expect(stateForRefusal('storage_failed')).toBe('unreadable');
  });

  it('maps a learner onto the upstream generic person space without merging id spaces', () => {
    expect(SUBJECT_KIND_MAP.learner).toBe('person');
    expect(SUBJECT_KIND_MAP.employee).toBe('employee');
    expect(SUBJECT_KIND_MAP.candidate).toBe('candidate');
  });

  it('connects into an empty slot and refuses to displace an existing provider', () => {
    const first = connectFoundationalEngine();
    expect(first.connected).toBe(true);
    expect(first.provider).toBe(FOUNDATIONAL_ADAPTER_NAME);
    const second = connectFoundationalEngine();
    expect(second.connected).toBe(false);
    clearFoundationalProvider();
  });

  it('produces a directed dimension only once a mapping supplies the direction', () => {
    const translated = translateFactor(upstreamFactor())!;
    const set = factorSet([translated]);

    // With no mapping the factor reaches nothing, and the layer says so instead of inventing a level.
    const unmapped = interpret(set, { now: NOW });
    expect(unmapped.state).toBe('insufficient_input');
    expect(unmapped.unmappedFactorCount).toBe(1);

    // A mapping authored by a human supplies BOTH the dimension and the direction.
    registerFactorMapping('authored', {
      'indicator.point.sector|B02 in S04': [
        { dimension: 'analytical_orientation', weight: 1, polarity: -1 },
      ],
    });
    const mapped = interpret(set, { now: NOW });
    expect(mapped.state).toBe('ok');
    expect(mapped.dimensions[0].dimension).toBe('analytical_orientation');
    expect(mapped.dimensions[0].score).toBeLessThan(0);
    expect(mapped.dimensions[0].contributingFactors[0].direction).toBe('lowers');
  });

  it('changes the input fingerprint when a mapping changes the direction', () => {
    const translated = translateFactor(upstreamFactor())!;
    const set = factorSet([translated]);
    registerFactorMapping('a', { 'indicator.point.sector|B02 in S04': [{ dimension: 'execution_drive', weight: 1, polarity: 1 }] });
    const up = digestFactorSet(set);
    registerFactorMapping('b', { 'indicator.point.sector|B02 in S04': [{ dimension: 'execution_drive', weight: 1, polarity: -1 }] });
    expect(digestFactorSet(set)).not.toBe(up);
  });

  it('refuses a mapping whose direction is out of range', () => {
    const v = validateFactorMapping({ 'k': [{ dimension: 'execution_drive', weight: 1, polarity: 4 }] } as any);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('direction outside');
  });
});
