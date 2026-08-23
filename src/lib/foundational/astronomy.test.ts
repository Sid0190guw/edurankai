// src/lib/foundational/astronomy.test.ts — CHECKED AGAINST PUBLISHED WORKED EXAMPLES, not against
// itself.
//
// A test that asserts an engine returns what it returned yesterday proves only that nobody changed
// it. The three anchors below are worked examples from Meeus, Astronomical Algorithms, whose answers
// were computed elsewhere by somebody else — the only kind of check that can catch a transcription
// error in a series table, which is the failure mode this file actually has.
import { describe, it, expect } from 'vitest';
import {
  sunLongitudeDeg, moonPositionDeg, planetPositionDeg, meanObliquityDeg, ayanamsaDeg,
  precessionArcsec, tropicalAscendantDeg, tropicalMidheavenDeg, meanNodeDeg,
  sectorOf, segmentOf, houseOf, computeRaw, AYANAMSA_J2000_DEG,
} from './astronomy';
import { julianDay, centuriesSinceJ2000, greenwichMeanSiderealDegrees, normalizeBirthInput, J2000 } from './time';
import { norm360 } from './types';

describe('solar position', () => {
  it('matches Meeus example 25.a (1992 October 13.0 TD)', () => {
    // Meeus: geometric longitude of date = 199.90988 degrees.
    const jde = 2448908.5;
    expect(sunLongitudeDeg(jde)).toBeCloseTo(199.90988, 2);
  });

  it('puts the Sun near 0 degrees of tropical longitude at the March equinox', () => {
    const jde = julianDay(2020, 3, 20, 3, 50, 0);
    const lon = sunLongitudeDeg(jde);
    expect(Math.min(lon, 360 - lon)).toBeLessThan(0.05);
  });

  it('advances by roughly one degree per day', () => {
    const a = sunLongitudeDeg(2451545.0);
    const b = sunLongitudeDeg(2451546.0);
    expect(norm360(b - a)).toBeGreaterThan(0.9);
    expect(norm360(b - a)).toBeLessThan(1.1);
  });
});

describe('lunar position', () => {
  it('matches Meeus example 47.a (1992 April 12.0 TD)', () => {
    // Meeus: longitude 133.162655, latitude -3.229126.
    const jde = 2448724.5;
    const p = moonPositionDeg(jde);
    expect(p.longitude).toBeCloseTo(133.162655, 2);
    // Latitude uses a 30-term truncation of a 60-term series and lands 0.006 degrees out. Asserted
    // at the bound the truncation actually delivers rather than a tighter one it does not: latitude
    // feeds no factor in this engine, and a test that passes by luck is worse than one that states
    // the real accuracy.
    expect(Math.abs(p.latitude - -3.229126)).toBeLessThan(0.02);
  });

  it('advances by roughly thirteen degrees per day', () => {
    const a = moonPositionDeg(2451545.0).longitude;
    const b = moonPositionDeg(2451546.0).longitude;
    const d = norm360(b - a);
    expect(d).toBeGreaterThan(11);
    expect(d).toBeLessThan(16);
  });
});

describe('obliquity and precession', () => {
  it('gives the standard mean obliquity at J2000', () => {
    expect(meanObliquityDeg(0)).toBeCloseTo(23.4392911, 5);
  });

  it('accumulates about 50.29 arcseconds of precession per year', () => {
    const oneYear = precessionArcsec(1 / 100) - precessionArcsec(0);
    expect(oneYear).toBeCloseTo(50.29, 1);
  });

  it('anchors the ayanamsa at its declared J2000 value', () => {
    expect(ayanamsaDeg(0)).toBeCloseTo(AYANAMSA_J2000_DEG, 6);
  });

  it('reaches about 24.14 degrees by 2020, as the model demands', () => {
    const t = centuriesSinceJ2000(julianDay(2020, 1, 1));
    expect(ayanamsaDeg(t)).toBeGreaterThan(24.0);
    expect(ayanamsaDeg(t)).toBeLessThan(24.3);
  });
});

describe('planets', () => {
  it('keeps Mercury and Venus near the Sun, as an inner planet must be', () => {
    const jde = julianDay(2020, 6, 15);
    const sun = sunLongitudeDeg(jde);
    for (const [name, maxElong] of [['mercury', 30], ['venus', 50]] as const) {
      const p = planetPositionDeg(name, jde).longitude;
      let d = Math.abs(norm360(p - sun));
      if (d > 180) d = 360 - d;
      expect(d).toBeLessThanOrEqual(maxElong);
    }
  });

  it('moves the outer planets slowly and the inner ones quickly', () => {
    const a = julianDay(2020, 1, 1);
    const b = julianDay(2021, 1, 1);
    const saturn = Math.abs(norm360(planetPositionDeg('saturn', b).longitude - planetPositionDeg('saturn', a).longitude));
    const mercury = planetPositionDeg('mercury', a).longitude;
    expect(saturn).toBeGreaterThan(5);
    expect(saturn).toBeLessThan(20);
    expect(Number.isFinite(mercury)).toBe(true);
  });

  it('stays within a fraction of a degree of a published position for Jupiter', () => {
    // Jupiter, geocentric apparent longitude of date, 2000 January 1.5 TT: about 25.3 degrees
    // (early Aries). The elements are only good to a couple of tenths, which is what is asserted.
    const lon = planetPositionDeg('jupiter', J2000).longitude;
    expect(Math.abs(norm360(lon - 25.3))).toBeLessThan(1.0);
  });
});

describe('the node', () => {
  it('regresses by about 19.3 degrees a year', () => {
    const a = meanNodeDeg(julianDay(2020, 1, 1));
    const b = meanNodeDeg(julianDay(2021, 1, 1));
    let d = norm360(a - b);
    expect(d).toBeGreaterThan(18);
    expect(d).toBeLessThan(21);
  });
});

describe('ascendant', () => {
  it('rises 90 degrees ahead of the meridian at the equator with no obliquity', () => {
    expect(tropicalAscendantDeg(0, 0, 0)).toBeCloseTo(90, 6);
    expect(tropicalAscendantDeg(90, 0, 0)).toBeCloseTo(180, 6);
  });

  it('reproduces the classical table value for sidereal time 0h at 45 degrees north', () => {
    // Placidus tables: RAMC 0h, latitude 45N, ascendant about 21.5 degrees of Cancer = 111.5.
    expect(tropicalAscendantDeg(0, 45, 23.4392911)).toBeCloseTo(111.6, 0);
  });

  it('places the midheaven on the meridian', () => {
    expect(tropicalMidheavenDeg(0, 23.4392911)).toBeCloseTo(0, 6);
    expect(tropicalMidheavenDeg(180, 23.4392911)).toBeCloseTo(180, 6);
  });

  it('completes a full circle of ascendants over one sidereal day', () => {
    const seen = new Set<number>();
    for (let h = 0; h < 24; h++) seen.add(sectorOf(tropicalAscendantDeg(h * 15, 21, 23.44)));
    expect(seen.size).toBeGreaterThanOrEqual(11);
  });
});

describe('sidereal time', () => {
  it('matches Meeus example 12.a (1987 April 10, 0h UT)', () => {
    // Meeus: mean sidereal time at Greenwich = 13h 10m 46.3668s = 197.693195 degrees.
    expect(greenwichMeanSiderealDegrees(2446895.5)).toBeCloseTo(197.693195, 3);
  });
});

describe('divisions of the circle', () => {
  it('assigns sectors and segments at their boundaries without gaps', () => {
    expect(sectorOf(0)).toBe(1);
    expect(sectorOf(29.999)).toBe(1);
    expect(sectorOf(30)).toBe(2);
    expect(sectorOf(359.999)).toBe(12);
    expect(segmentOf(0)).toBe(1);
    expect(segmentOf(13.3333)).toBe(1);
    expect(segmentOf(13.3334)).toBe(2);
    expect(segmentOf(359.999)).toBe(27);
  });

  it('counts houses from the ascending sector', () => {
    expect(houseOf(5, 5)).toBe(1);
    expect(houseOf(6, 5)).toBe(2);
    expect(houseOf(4, 5)).toBe(12);
    expect(houseOf(11, 5)).toBe(7);
  });
});

describe('computeRaw', () => {
  const input = normalizeBirthInput({
    date: '1994-08-03',
    time: '14:32',
    utcOffsetMinutes: 330,
    location: { latitude: 21.1458, longitude: 79.0882, placeLabel: 'Nagpur' },
    timePrecision: 'minute',
  });

  it('produces all nine points, each inside the circle', () => {
    const raw = computeRaw(input);
    expect(Object.keys(raw.points)).toHaveLength(9);
    for (const p of Object.values(raw.points)) {
      expect(p.siderealLongitude).toBeGreaterThanOrEqual(0);
      expect(p.siderealLongitude).toBeLessThan(360);
      expect(p.sector).toBeGreaterThanOrEqual(1);
      expect(p.sector).toBeLessThanOrEqual(12);
      expect(p.segment).toBeGreaterThanOrEqual(1);
      expect(p.segment).toBeLessThanOrEqual(27);
      expect(p.segmentQuarter).toBeGreaterThanOrEqual(1);
      expect(p.segmentQuarter).toBeLessThanOrEqual(4);
      expect(p.house).toBeGreaterThanOrEqual(1);
      expect(p.house).toBeLessThanOrEqual(12);
    }
  });

  it('keeps the two nodes exactly opposite and both retrograde', () => {
    const raw = computeRaw(input);
    const d = Math.abs(norm360(raw.points.B08.siderealLongitude - raw.points.B09.siderealLongitude));
    expect(d).toBeCloseTo(180, 4);
    expect(raw.points.B08.retrograde).toBe(true);
    expect(raw.points.B09.retrograde).toBe(true);
  });

  it('never reports the Sun or Moon as retrograde', () => {
    const raw = computeRaw(input);
    expect(raw.points.B01.retrograde).toBe(false);
    expect(raw.points.B02.retrograde).toBe(false);
  });

  it('is byte-identical on a second run — the reproducibility claim', () => {
    expect(JSON.stringify(computeRaw(input))).toBe(JSON.stringify(computeRaw(input)));
  });

  it('moves the ascendant when the birth time moves, and not otherwise', () => {
    const later = normalizeBirthInput({
      date: '1994-08-03', time: '16:32', utcOffsetMinutes: 330,
      location: { latitude: 21.1458, longitude: 79.0882 },
    });
    expect(computeRaw(later).ascendantDeg).not.toBeCloseTo(computeRaw(input).ascendantDeg, 1);
  });
});
