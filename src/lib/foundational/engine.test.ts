// src/lib/foundational/engine.test.ts — the pure half of the engine: reproducibility, hashing, the
// method manifest, and the guards that do not need a database to prove.
//
// The persistence half is not exercised here on purpose. This project does not connect a development
// process to its production database, and a test that needs a live connection is a test that does
// not run — so what is asserted here is everything that can be asserted honestly without one, and
// docs/horizon-foundational-computation.md lists the integration checks that need a database.
import { describe, it, expect } from 'vitest';
import * as engine from './engine';
import { computeFromInput, describeMethod, inputHashOf, outputHashOf } from './engine';
import { normalizeBirthInput } from './time';
import { CALCULATION_METHOD_VERSION, canonicalJson, round } from './types';
import { STRENGTH_WEIGHTS } from './factors';
import { CYCLE_TOTAL_YEARS, CYCLE_YEAR_DAYS } from './periods';

const AT = '2026-08-23T00:00:00.000Z';
const LATER = '2027-01-01T00:00:00.000Z';

const input = {
  date: '1994-08-03',
  time: '14:32',
  utcOffsetMinutes: 330,
  location: { latitude: 21.1458, longitude: 79.0882, placeLabel: 'Nagpur' },
  timePrecision: 'minute' as const,
};

describe('computeFromInput', () => {
  const a = computeFromInput(input, AT);

  it('returns positions, factors and both stored period levels', () => {
    expect(Object.keys(a.raw.points)).toHaveLength(9);
    expect(a.factors.length).toBeGreaterThan(60);
    expect(a.periods.level1.length).toBeGreaterThan(0);
    expect(a.periods.level2).toHaveLength(a.periods.level1.length * 9);
  });

  it('is byte-identical on a second run', () => {
    expect(canonicalJson(computeFromInput(input, AT))).toBe(canonicalJson(a));
  });

  it('includes the cycle factors alongside the positional ones', () => {
    expect(a.factors.some((f) => f.category === 'time_cycle')).toBe(true);
    expect(a.factors.some((f) => f.category === 'foundational_indicator')).toBe(true);
    expect(a.factors.some((f) => f.category === 'factor_relationship')).toBe(true);
    expect(a.factors.some((f) => f.category === 'strength')).toBe(true);
  });

  it('stamps every factor with the same version and the supplied timestamp', () => {
    for (const f of a.factors) {
      expect(f.calculation_method_version).toBe(CALCULATION_METHOD_VERSION);
      expect(f.computed_at).toBe(AT);
    }
  });

  it('refuses an input it cannot place on the timeline', () => {
    expect(() => computeFromInput({ ...input, utcOffsetMinutes: undefined, timeZone: undefined } as any, AT)).toThrow();
  });
});

describe('hashing', () => {
  it('gives the same output hash for the same input computed on different days', () => {
    const a = computeFromInput(input, AT);
    const b = computeFromInput(input, LATER);
    expect(b.outputHash).toBe(a.outputHash);
    // ...while the factors themselves do carry the different timestamps.
    expect(b.factors[0].computed_at).not.toBe(a.factors[0].computed_at);
  });

  it('changes the output hash when the birth time changes by a minute', () => {
    const a = computeFromInput(input, AT);
    const b = computeFromInput({ ...input, time: '14:33' }, AT);
    expect(b.outputHash).not.toBe(a.outputHash);
  });

  it('changes the input hash when any input field changes', () => {
    const base = inputHashOf(normalizeBirthInput(input));
    expect(inputHashOf(normalizeBirthInput({ ...input, time: '14:33' }))).not.toBe(base);
    expect(inputHashOf(normalizeBirthInput({ ...input, location: { latitude: 21.2, longitude: 79.0882 } }))).not.toBe(base);
    expect(inputHashOf(normalizeBirthInput({ ...input, utcOffsetMinutes: 0 }))).not.toBe(base);
  });

  it('labels which hashing mode produced it, so a keyed and an unkeyed digest cannot be confused', () => {
    expect(inputHashOf(normalizeBirthInput(input))).toMatch(/^h[01]:[0-9a-f]{64}$/);
  });

  it('hashes an empty output set without throwing', () => {
    expect(outputHashOf([], [])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('describeMethod', () => {
  const m = describeMethod();

  it('publishes every constant a third party needs to reproduce a result', () => {
    expect(m.version).toBe(CALCULATION_METHOD_VERSION);
    expect(m.strengthWeights).toEqual(STRENGTH_WEIGHTS);
    expect(m.cycleYearDays).toBe(CYCLE_YEAR_DAYS);
    expect(m.cycleTotalYears).toBe(CYCLE_TOTAL_YEARS);
    expect(m.ayanamsaAtJ2000Deg).toBeGreaterThan(23);
    expect(m.houseModel).toContain('whole-sector');
  });

  it('states the accuracy rather than implying it', () => {
    expect(m.accuracy.B07).toContain('deg');
    expect(m.accuracy.notApplied).toContain('nutation');
    expect(m.accuracy.ascendant).toContain('birth-time precision');
    expect(m.validRange.fromYear).toBeLessThan(m.validRange.toYear);
  });

  it('travels with the computation, so a stored result carries the rules that made it', () => {
    expect(computeFromInput(input, AT).method.version).toBe(m.version);
  });
});

describe('precision discipline', () => {
  it('rounds every published angle to the declared number of decimals', () => {
    const a = computeFromInput(input, AT);
    for (const p of Object.values(a.raw.points)) {
      expect(p.siderealLongitude).toBe(round(p.siderealLongitude, 6));
      expect(p.dailyMotion).toBe(round(p.dailyMotion, 6));
    }
  });

  it('rounds every strength and confidence to the declared number of decimals', () => {
    for (const f of computeFromInput(input, AT).factors) {
      expect(f.strength).toBe(round(f.strength, 4));
      expect(f.confidence).toBe(round(f.confidence, 4));
    }
  });

  it('kills negative zero, which would otherwise change a hash for no reason', () => {
    expect(Object.is(round(-0.0000001, 4), 0)).toBe(true);
  });
});

describe('the engine refuses to produce a conclusion', () => {
  it('exports no function whose name suggests one', () => {
    // A crude check, deliberately: it is the kind that survives somebody adding a "helpful" export.
    const banned = /(hire|reject|promote|terminate|recommend|suitab|rank|score)/i;
    for (const name of Object.keys(engine)) expect(name).not.toMatch(banned);
  });
});
