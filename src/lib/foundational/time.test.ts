// src/lib/foundational/time.test.ts — the wall-clock-to-instant conversion, and its refusals.
import { describe, it, expect } from 'vitest';
import {
  julianDay, calendarFromJulianDay, isoFromJulianDay, deltaTSeconds, ttFromUT,
  greenwichMeanSiderealDegrees, localSiderealDegrees, resolveOffsetMinutes,
  normalizeBirthInput, InputError,
} from './time';

describe('julian day', () => {
  it('matches the standard epochs', () => {
    expect(julianDay(2000, 1, 1, 12, 0, 0)).toBeCloseTo(2451545.0, 6);
    expect(julianDay(1987, 1, 27, 0, 0, 0)).toBeCloseTo(2446822.5, 6);
    expect(julianDay(1957, 10, 4, 19, 26, 24)).toBeCloseTo(2436116.31, 2);
  });

  it('round-trips through the calendar', () => {
    for (const jd of [2451545.0, 2446822.5, 2436116.31, 2299160.5]) {
      const c = calendarFromJulianDay(jd);
      expect(julianDay(c.year, c.month, c.day, c.hour, c.minute, c.second)).toBeCloseTo(jd, 4);
    }
  });

  it('never renders a sixtieth second', () => {
    // A fraction that rounds up to a whole day used to produce 24:00:00 or 23:59:60.
    const iso = isoFromJulianDay(2451545.0 - 0.5 + 0.9999999);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(iso).not.toContain(':60');
    expect(iso).not.toContain('T24:');
  });
});

describe('delta T', () => {
  it('is about a minute in the 1990s and about 70 seconds in the 2020s', () => {
    expect(deltaTSeconds(1994)).toBeGreaterThan(55);
    expect(deltaTSeconds(1994)).toBeLessThan(65);
    expect(deltaTSeconds(2024)).toBeGreaterThan(65);
    expect(deltaTSeconds(2024)).toBeLessThan(80);
  });

  it('goes NEGATIVE in the late nineteenth century, because it really did', () => {
    // The Earth ran ahead of uniform time from about 1865 to about 1905. An engine that assumes TT
    // is always ahead of UT is wrong for forty years of birth records.
    expect(deltaTSeconds(1850)).toBeGreaterThan(5);
    expect(deltaTSeconds(1850)).toBeLessThan(9);
    expect(deltaTSeconds(1880)).toBeLessThan(0);
    expect(deltaTSeconds(1900)).toBeCloseTo(-2.79, 1);
    expect(deltaTSeconds(1950)).toBeCloseTo(29.07, 0);
  });

  it('moves TT ahead of UT everywhere the modern branches apply', () => {
    for (const y of [1950, 2000, 2040]) {
      const jd = julianDay(y, 6, 1);
      expect(ttFromUT(jd)).toBeGreaterThan(jd);
    }
  });
});

describe('sidereal time', () => {
  it('advances by slightly more than 360 degrees a day', () => {
    const a = greenwichMeanSiderealDegrees(2451545.0);
    const b = greenwichMeanSiderealDegrees(2451546.0);
    const advance = ((b - a) % 360 + 360) % 360;
    expect(advance).toBeGreaterThan(0.9);
    expect(advance).toBeLessThan(1.1);
  });

  it('adds east longitude', () => {
    const g = greenwichMeanSiderealDegrees(2451545.0);
    expect(localSiderealDegrees(2451545.0, 90)).toBeCloseTo((g + 90) % 360, 6);
  });
});

describe('time zone resolution', () => {
  it('resolves a fixed-offset zone', () => {
    expect(resolveOffsetMinutes(1994, 8, 3, 14, 32, 0, 'Asia/Kolkata')).toBe(330);
  });

  it('resolves both sides of a daylight-saving boundary', () => {
    // London: GMT in January, BST in July.
    expect(resolveOffsetMinutes(2020, 1, 15, 12, 0, 0, 'Europe/London')).toBe(0);
    expect(resolveOffsetMinutes(2020, 7, 15, 12, 0, 0, 'Europe/London')).toBe(60);
  });

  it('refuses an unknown zone rather than defaulting to UTC', () => {
    expect(() => resolveOffsetMinutes(2020, 1, 1, 0, 0, 0, 'Middle/Earth')).toThrow();
  });
});

describe('normalizeBirthInput', () => {
  const base = {
    date: '1994-08-03',
    time: '14:32',
    location: { latitude: 21.1458, longitude: 79.0882, placeLabel: 'Nagpur' },
  };

  it('places a local wall clock on the UTC timeline', () => {
    const n = normalizeBirthInput({ ...base, utcOffsetMinutes: 330 });
    expect(n.utcInstant).toBe('1994-08-03T09:02:00Z');
    expect(n.utcOffsetMinutes).toBe(330);
  });

  it('gives the same instant from an IANA zone as from its offset', () => {
    const byOffset = normalizeBirthInput({ ...base, utcOffsetMinutes: 330 });
    const byZone = normalizeBirthInput({ ...base, timeZone: 'Asia/Kolkata' });
    expect(byZone.utcInstant).toBe(byOffset.utcInstant);
    // And it STORES the resolved offset, so a later tzdata change cannot move the answer.
    expect(byZone.utcOffsetMinutes).toBe(330);
  });

  it('prefers an explicit offset over a zone when both are supplied', () => {
    const n = normalizeBirthInput({ ...base, utcOffsetMinutes: 0, timeZone: 'Asia/Kolkata' });
    expect(n.utcOffsetMinutes).toBe(0);
    expect(n.utcInstant).toBe('1994-08-03T14:32:00Z');
  });

  it('defaults the declared time precision to a minute rather than to certainty', () => {
    expect(normalizeBirthInput({ ...base, utcOffsetMinutes: 330 }).timePrecision).toBe('minute');
  });

  it('refuses rather than guessing', () => {
    expect(() => normalizeBirthInput({ ...base } as any)).toThrow(InputError);
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, date: '03-08-1994' })).toThrow(InputError);
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, time: '25:00' })).toThrow(InputError);
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, location: { latitude: 91, longitude: 0 } })).toThrow(InputError);
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, location: { latitude: 0, longitude: 181 } })).toThrow(InputError);
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, location: { latitude: 89.9, longitude: 0 } })).toThrow(InputError);
  });

  it('refuses a date outside the model validity window instead of extrapolating quietly', () => {
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, date: '1750-01-01' })).toThrow(InputError);
    expect(() => normalizeBirthInput({ ...base, utcOffsetMinutes: 330, date: '2099-01-01' })).toThrow(InputError);
  });
});
