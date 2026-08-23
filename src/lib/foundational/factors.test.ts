// src/lib/foundational/factors.test.ts — the derivation layer: shapes, bounds, and the promises the
// header of factors.ts makes about what each number means.
import { describe, it, expect } from 'vitest';
import {
  deriveFactors, divisionConfidence, positionalDefiniteness, positionSigmaDeg, ascendantSigmaDeg,
  dignityComponent, angularityComponent, directionalComponent, motionComponent, proximityComponent,
  ownSectors, SECTOR_RULER, STRENGTH_WEIGHTS, DIGNITY_VALUES, SPECIAL_OFFSETS, UNIVERSAL_OFFSET,
} from './factors';
import { computeRaw } from './astronomy';
import { normalizeBirthInput } from './time';
import type { ComputedPoint } from './types';

const AT = '2026-08-23T00:00:00.000Z';

function subject(overrides: Partial<Parameters<typeof normalizeBirthInput>[0]> = {}) {
  return normalizeBirthInput({
    date: '1994-08-03',
    time: '14:32',
    utcOffsetMinutes: 330,
    location: { latitude: 21.1458, longitude: 79.0882, placeLabel: 'Nagpur' },
    timePrecision: 'minute',
    ...overrides,
  } as any);
}

const raw = computeRaw(subject());
const factors = deriveFactors(raw, { computedAt: AT });

function point(p: Partial<ComputedPoint>): ComputedPoint {
  return {
    code: 'B01', siderealLongitude: 0, tropicalLongitude: 0, dailyMotion: 1, latitude: 0,
    sector: 1, degreeInSector: 0, segment: 1, segmentQuarter: 1, degreeInSegment: 0,
    house: 1, retrograde: false, uncertaintyDeg: 0.01, ...p,
  };
}

describe('the weights', () => {
  it('sum to exactly one, or the composite is not a weighted mean', () => {
    const total = Object.values(STRENGTH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('gives every sector a ruler and every ruler at least one sector', () => {
    for (let s = 1; s <= 12; s++) expect(SECTOR_RULER[s]).toMatch(/^B0[1-7]$/);
    for (const code of ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07']) {
      expect(ownSectors(code).length).toBeGreaterThan(0);
    }
    // The two computed intersections rule nothing — they are not bodies.
    expect(ownSectors('B08')).toHaveLength(0);
    expect(ownSectors('B09')).toHaveLength(0);
  });
});

describe('confidence', () => {
  it('falls to zero at a division boundary and reaches one well inside it', () => {
    expect(divisionConfidence(30, 30, 0.1)).toBe(0);
    expect(divisionConfidence(15, 30, 0.1)).toBe(1);
  });

  it('shrinks as the recorded birth time gets vaguer', () => {
    const precise = divisionConfidence(29.5, 30, ascendantSigmaDeg(1));
    const vague = divisionConfidence(29.5, 30, ascendantSigmaDeg(60));
    expect(precise).toBeGreaterThan(vague);
  });

  it('widens a point sigma with both model error and clock error', () => {
    const slow = point({ dailyMotion: 0.03, uncertaintyDeg: 0.17 });
    const fast = point({ code: 'B02', dailyMotion: 13.2, uncertaintyDeg: 0.01 });
    expect(positionSigmaDeg(slow, 1)).toBeGreaterThan(0.16);
    // The Moon's own model error is tiny; an hour of clock error dominates it entirely.
    expect(positionSigmaDeg(fast, 60)).toBeGreaterThan(0.5);
  });
});

describe('positional definiteness', () => {
  it('is zero on a boundary and one at the centre', () => {
    expect(positionalDefiniteness(0, 30)).toBe(0);
    expect(positionalDefiniteness(15, 30)).toBe(1);
    expect(positionalDefiniteness(7.5, 30)).toBeCloseTo(0.5, 4);
  });
});

describe('strength components', () => {
  it('places dignity on its declared ladder', () => {
    expect(dignityComponent(point({ code: 'B01', sector: 1, degreeInSector: 10 })).value).toBe(DIGNITY_VALUES.peak);
    expect(dignityComponent(point({ code: 'B01', sector: 7, degreeInSector: 10 })).value).toBe(DIGNITY_VALUES.trough);
    expect(dignityComponent(point({ code: 'B01', sector: 5, degreeInSector: 2 })).value).toBe(DIGNITY_VALUES.own);
    expect(dignityComponent(point({ code: 'B08' })).basis).toBe('not_applicable_to_computed_intersection');
  });

  it('rates the four angular houses highest', () => {
    expect(angularityComponent(point({ house: 1 }))).toBe(1);
    expect(angularityComponent(point({ house: 10 }))).toBe(1);
    expect(angularityComponent(point({ house: 12 }))).toBeLessThan(0.5);
  });

  it('peaks the directional component at the declared house and bottoms out opposite it', () => {
    expect(directionalComponent(point({ code: 'B01', house: 10 })).value).toBe(1);
    expect(directionalComponent(point({ code: 'B01', house: 4 })).value).toBe(0);
  });

  it('keeps the motion component purely kinematic and capped at one', () => {
    expect(motionComponent(point({ code: 'B04', dailyMotion: 2.0 }))).toBe(1);
    expect(motionComponent(point({ code: 'B04', dailyMotion: -0.2 }))).toBeCloseTo(0.2029, 3);
    expect(motionComponent(point({ code: 'B01', dailyMotion: 0.9856 }))).toBe(1);
  });

  it('applies proximity only inside the declared orb, and only to the seven bodies', () => {
    const near = proximityComponent(point({ code: 'B04', siderealLongitude: 100 }), 100);
    expect(near.value).toBeCloseTo(0.15, 4);
    const far = proximityComponent(point({ code: 'B04', siderealLongitude: 140 }), 100);
    expect(far.value).toBe(1);
    const node = proximityComponent(point({ code: 'B08', siderealLongitude: 100 }), 100);
    expect(node.orb).toBeNull();
    expect(node.value).toBe(1);
  });
});

describe('deriveFactors', () => {
  it('produces the four categories and nothing else', () => {
    const categories = new Set(factors.map((f) => f.category));
    for (const c of categories) {
      expect(['foundational_indicator', 'factor_relationship', 'strength']).toContain(c);
    }
  });

  it('gives every factor its inputs, its evidence, a bounded strength and a bounded confidence', () => {
    expect(factors.length).toBeGreaterThan(50);
    for (const f of factors) {
      expect(f.factor_id).toBeTruthy();
      expect(f.calculation_method_version).toMatch(/^fpc-/);
      expect(f.computed_at).toBe(AT);
      expect(f.source_inputs.length).toBeGreaterThan(0);
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.strength).toBeGreaterThanOrEqual(0);
      expect(f.strength).toBeLessThanOrEqual(1);
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      for (const e of f.evidence) expect(e.ref).toBeTruthy();
    }
  });

  it('gives every factor a unique id, because the table has a unique index on it', () => {
    const ids = factors.map((f) => f.factor_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks sector placements as depending on the time and not on the place', () => {
    const sectorFactor = factors.find((f) => f.code === 'indicator.point.sector')!;
    expect(sectorFactor.source_inputs).not.toContain('input.location.latitude');
    const houseFactor = factors.find((f) => f.code === 'indicator.point.house')!;
    expect(houseFactor.source_inputs).toContain('input.location.latitude');
  });

  it('publishes every component of every composite strength', () => {
    const composites = factors.filter((f) => f.code === 'strength.point');
    expect(composites).toHaveLength(9);
    for (const c of composites) {
      expect(Object.keys(c.components || {}).sort()).toEqual(
        ['angularity', 'dignity', 'directional', 'motion', 'proximity'],
      );
      const recomputed = Object.entries(STRENGTH_WEIGHTS)
        .reduce((sum, [k, w]) => sum + (c.components![k] as number) * w, 0);
      expect(c.strength).toBeCloseTo(recomputed, 3);
    }
  });

  it('records the universal relationship for every pair and the special ones only for their points', () => {
    const specials = factors.filter((f) => f.code === 'relationship.aspect.special');
    for (const s of specials) {
      const from = s.factor_id.split(':')[1].split('->')[0];
      expect(Object.keys(SPECIAL_OFFSETS)).toContain(from);
    }
    const universal = factors.filter((f) => f.code === 'relationship.aspect');
    for (const u of universal) expect(u.value).toContain(`offset ${UNIVERSAL_OFFSET}`);
  });

  it('records twelve house rulers, one per house', () => {
    const rulers = factors.filter((f) => f.code === 'relationship.house_ruler');
    expect(rulers).toHaveLength(12);
    expect(new Set(rulers.map((r) => r.value.split(' ')[0])).size).toBe(12);
  });

  it('carries a technical block at computation time, which the projection is responsible for hiding', () => {
    expect(factors.every((f) => f.technical !== null)).toBe(true);
  });

  it('is deterministic in order and content', () => {
    const again = deriveFactors(computeRaw(subject()), { computedAt: AT });
    expect(JSON.stringify(again)).toBe(JSON.stringify(factors));
  });

  it('lowers confidence across the board when the birth time is only known to the hour', () => {
    const vague = deriveFactors(computeRaw(subject({ timePrecision: 'hour' })), { computedAt: AT });
    const preciseAvg = factors.reduce((a, f) => a + f.confidence, 0) / factors.length;
    const vagueAvg = vague.reduce((a, f) => a + f.confidence, 0) / vague.length;
    expect(vagueAvg).toBeLessThan(preciseAvg);
  });
});
