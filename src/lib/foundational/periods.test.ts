// src/lib/foundational/periods.test.ts — the cycle system: its arithmetic, its boundaries, and the
// property that matters most, which is that the three levels agree with each other.
import { describe, it, expect } from 'vitest';
import {
  CYCLE_SEQUENCE, CYCLE_TOTAL_YEARS, CYCLE_YEAR_DAYS,
  cycleSeed, level1Periods, level2Periods, level3Periods, computePeriods, analyzePeriods, cycleFactors,
} from './periods';
import { computeRaw } from './astronomy';
import { normalizeBirthInput, julianDayFromDate } from './time';

const AT = '2026-08-23T00:00:00.000Z';

const raw = computeRaw(normalizeBirthInput({
  date: '1994-08-03',
  time: '14:32',
  utcOffsetMinutes: 330,
  location: { latitude: 21.1458, longitude: 79.0882 },
  timePrecision: 'minute',
}));

describe('the sequence', () => {
  it('divides exactly the declared whole', () => {
    const total = CYCLE_SEQUENCE.reduce((a, e) => a + e.years, 0);
    expect(total).toBe(CYCLE_TOTAL_YEARS);
  });

  it('names nine distinct points', () => {
    expect(CYCLE_SEQUENCE).toHaveLength(9);
    expect(new Set(CYCLE_SEQUENCE.map((e) => e.code)).size).toBe(9);
  });
});

describe('the seed', () => {
  it('comes from B02 and nothing else', () => {
    const seed = cycleSeed(raw);
    expect(seed.segment).toBe(raw.points.B02.segment);
    expect(seed.elapsedFraction).toBeGreaterThanOrEqual(0);
    expect(seed.elapsedFraction).toBeLessThanOrEqual(1);
  });

  it('starts the first period before the birth, by exactly the elapsed part of it', () => {
    const seed = cycleSeed(raw);
    const years = CYCLE_SEQUENCE[seed.startIndex].years;
    const expected = raw.normalizedInput.julianDayUT - seed.elapsedFraction * years * CYCLE_YEAR_DAYS;
    expect(seed.cycleStartJD).toBeCloseTo(expected, 4);
    expect(seed.cycleStartJD).toBeLessThanOrEqual(raw.normalizedInput.julianDayUT);
  });

  it('refuses to seed without a lunar position', () => {
    const broken = { ...raw, points: { ...raw.points, B02: undefined } } as any;
    expect(() => cycleSeed(broken)).toThrow();
  });
});

describe('level 1', () => {
  const seed = cycleSeed(raw);
  const birth = raw.normalizedInput.julianDayUT;
  const periods = level1Periods(seed, seed.cycleStartJD, birth + 120 * CYCLE_YEAR_DAYS);

  it('covers the horizon with no gaps and no overlaps', () => {
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i].starts_at).toBe(periods[i - 1].ends_at);
    }
  });

  it('gives each governing point its declared share of days', () => {
    for (const p of periods) {
      const entry = CYCLE_SEQUENCE.find((e) => e.code === p.ruler_code)!;
      expect(p.length_days).toBeCloseTo(entry.years * CYCLE_YEAR_DAYS, 2);
    }
  });

  it('follows the fixed order, wrapping round', () => {
    const startIdx = CYCLE_SEQUENCE.findIndex((e) => e.code === periods[0].ruler_code);
    periods.forEach((p, i) => {
      expect(p.ruler_code).toBe(CYCLE_SEQUENCE[(startIdx + i) % 9].code);
    });
  });

  it('keeps period ids unique across repeating cycles', () => {
    const ids = periods.map((p) => p.period_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('subdivision', () => {
  const seed = cycleSeed(raw);
  const l1 = level1Periods(seed, seed.cycleStartJD, raw.normalizedInput.julianDayUT + 120 * CYCLE_YEAR_DAYS);
  const parent = l1[2];
  const l2 = level2Periods(parent);

  it('produces nine children that exactly fill their parent', () => {
    expect(l2).toHaveLength(9);
    expect(l2[0].starts_at).toBe(parent.starts_at);
    const total = l2.reduce((a, p) => a + p.length_days, 0);
    expect(total).toBeCloseTo(parent.length_days, 2);
  });

  it('starts each subdivision with its own parent governor', () => {
    expect(l2[0].ruler_code).toBe(parent.ruler_code);
    const l3 = level3Periods(l2[3]);
    expect(l3[0].ruler_code).toBe(l2[3].ruler_code);
  });

  it('proportions each child by its share of the whole', () => {
    for (const child of l2) {
      const entry = CYCLE_SEQUENCE.find((e) => e.code === child.ruler_code)!;
      expect(child.length_days).toBeCloseTo(parent.length_days * (entry.years / CYCLE_TOTAL_YEARS), 2);
    }
  });

  it('carries the whole chain of governors, so a level-3 span knows its lineage', () => {
    const l3 = level3Periods(l2[0]);
    expect(l3[0].chain).toHaveLength(3);
    expect(l3[0].chain[0]).toBe(parent.ruler_code);
  });
});

describe('computePeriods', () => {
  it('stores levels one and two, and nothing deeper', () => {
    const { level1, level2 } = computePeriods(raw);
    expect(level1.length).toBeGreaterThan(0);
    expect(level2).toHaveLength(level1.length * 9);
    expect(level1.every((p) => p.level === 1)).toBe(true);
    expect(level2.every((p) => p.level === 2)).toBe(true);
  });
});

describe('analyzePeriods', () => {
  const asOf = new Date('2026-08-23T00:00:00.000Z');
  const analysis = analyzePeriods(raw, { subject: { kind: 'person', id: 'p1' }, computationId: 'c1', asOf });

  it('names exactly one current period per level, and they nest', () => {
    expect(analysis.current).toHaveLength(3);
    expect(analysis.current.map((p) => p.level)).toEqual([1, 2, 3]);
    const [l1, l2, l3] = analysis.current;
    expect(l2.chain[0]).toBe(l1.ruler_code);
    expect(l3.chain[0]).toBe(l1.ruler_code);
    expect(l3.chain[1]).toBe(l2.ruler_code);
  });

  it('brackets the instant asked about', () => {
    for (const p of analysis.current) {
      expect(new Date(p.starts_at).getTime()).toBeLessThanOrEqual(asOf.getTime());
      expect(new Date(p.ends_at).getTime()).toBeGreaterThan(asOf.getTime());
      expect(p.fraction_elapsed).toBeGreaterThanOrEqual(0);
      expect(p.fraction_elapsed).toBeLessThanOrEqual(1);
    }
  });

  it('returns only future starts under `upcoming`, in order', () => {
    for (const p of analysis.upcoming) {
      expect(new Date(p.starts_at).getTime()).toBeGreaterThan(asOf.getTime());
    }
    const starts = analysis.upcoming.map((p) => p.starts_at);
    expect([...starts].sort()).toEqual(starts);
  });

  it('projects a long horizon that includes periods already past', () => {
    expect(analysis.horizon.length).toBeGreaterThanOrEqual(9);
    expect(new Date(analysis.horizon[0].starts_at).getTime()).toBeLessThan(asOf.getTime());
  });

  it('reads the clock nowhere — same instant in, same answer out', () => {
    const again = analyzePeriods(raw, { subject: { kind: 'person', id: 'p1' }, computationId: 'c1', asOf });
    expect(JSON.stringify(again)).toBe(JSON.stringify(analysis));
  });

  it('adds level-3 spans only when asked', () => {
    const withL3 = analyzePeriods(raw, {
      subject: { kind: 'person', id: 'p1' }, computationId: 'c1', asOf,
      to: new Date('2028-08-23T00:00:00.000Z'), includeLevel3: true,
    });
    expect(withL3.upcoming.some((p) => p.level === 3)).toBe(true);
    expect(analysis.upcoming.some((p) => p.level === 3)).toBe(false);
  });
});

describe('cycleFactors', () => {
  it('turns each level-1 period into one factor with its share published', () => {
    const { level1 } = computePeriods(raw);
    const cf = cycleFactors(raw, level1, { computedAt: AT });
    expect(cf).toHaveLength(level1.length);
    for (const f of cf) {
      expect(f.category).toBe('time_cycle');
      expect(f.components?.share_of_cycle).toBeGreaterThan(0);
      expect(f.evidence.some((e) => e.ref === 'method.CYCLE_YEAR_DAYS')).toBe(true);
      expect(f.confidence).toBeGreaterThan(0);
    }
  });
});

describe('the boundary arithmetic is checkable by hand', () => {
  it('puts a period boundary exactly its declared number of days after the previous one', () => {
    const seed = cycleSeed(raw);
    const l1 = level1Periods(seed, seed.cycleStartJD, raw.normalizedInput.julianDayUT + 40 * CYCLE_YEAR_DAYS);
    const a = julianDayFromDate(new Date(l1[0].starts_at));
    const b = julianDayFromDate(new Date(l1[0].ends_at));
    const years = CYCLE_SEQUENCE.find((e) => e.code === l1[0].ruler_code)!.years;
    expect(b - a).toBeCloseTo(years * CYCLE_YEAR_DAYS, 3);
  });
});
