// Validation, place normalisation and — the part that is genuinely easy to get wrong — exact time
// handling across daylight-saving transitions.
//
// Every case here runs with no database and no network: that is the reason birth-input.ts holds no
// import of either.
import { describe, expect, it } from 'vitest';
import {
  canonicalInputJson,
  canonicalTimezone,
  canonicalise,
  deriveInstant,
  formatOffset,
  isValidTimezone,
  normalisePlace,
  normaliseTimePrecision,
  offsetMinutesAt,
  parseCanonicalInputJson,
  parseCoordinates,
  parseDateOfBirth,
  parseTimeOfBirth,
  resolveCountryCode,
  supportedTimezones,
  validateFoundationSubmission,
  yearsBetween,
  zonedWallTimeToUtc,
} from './birth-input';

const TODAY = new Date('2026-08-23T00:00:00Z');

describe('date of birth', () => {
  it('accepts a real ISO day', () => {
    const r = parseDateOfBirth('1994-06-12', TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('1994-06-12');
  });

  // The one a naive check waves through: `new Date('2025-02-30')` rolls into March and silently
  // changes somebody's birthday.
  it('rejects a well-formed day that does not exist', () => {
    const r = parseDateOfBirth('2025-02-30', TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].field).toBe('dateOfBirth');
  });

  it('rejects a future date', () => {
    expect(parseDateOfBirth('2027-01-01', TODAY).ok).toBe(false);
  });

  it('rejects a year before the earliest plausible birth', () => {
    expect(parseDateOfBirth('1804-01-01', TODAY).ok).toBe(false);
  });

  it('rejects a non-ISO string rather than guessing the order', () => {
    expect(parseDateOfBirth('12/06/1994', TODAY).ok).toBe(false);
  });

  it('requires a value', () => {
    expect(parseDateOfBirth('', TODAY).ok).toBe(false);
  });

  // A WARNING, not a rejection, and it must never become one: an implausible age is a typo to fix,
  // not a judgement about a person.
  it('warns rather than fails on an implausibly recent year', () => {
    const r = parseDateOfBirth('2020-01-01', TODAY);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.field === 'dateOfBirth')).toBe(true);
  });

  it('counts whole years by the calendar, not by dividing days', () => {
    expect(yearsBetween('2000-08-24', '2026-08-23')).toBe(25);
    expect(yearsBetween('2000-08-23', '2026-08-23')).toBe(26);
  });
});

describe('time of birth', () => {
  it('treats an empty value as a legitimate answer', () => {
    const r = parseTimeOfBirth('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('normalises to HH:MM:SS', () => {
    const r = parseTimeOfBirth('9:30');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('09:30:00');
  });

  it('keeps seconds when they are given', () => {
    const r = parseTimeOfBirth('21:05:07');
    if (r.ok) expect(r.value).toBe('21:05:07');
  });

  it('rejects an out-of-range time', () => {
    expect(parseTimeOfBirth('25:00').ok).toBe(false);
    expect(parseTimeOfBirth('12:99').ok).toBe(false);
  });

  it('never claims a precision the person did not state', () => {
    expect(normaliseTimePrecision('exact', false)).toBe('unknown');   // no time at all
    expect(normaliseTimePrecision('', true)).toBe('minute');          // a HH:MM field supports minutes
    expect(normaliseTimePrecision('unknown', true)).toBe('minute');   // contradiction resolved down
    expect(normaliseTimePrecision('exact', true)).toBe('exact');
  });
});

describe('time zones', () => {
  it('recognises a real IANA id and refuses anything else', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  // BOTH OF THESE WERE FOUND BY RUNNING IT, NOT BY READING A SPEC — see the note on
  // canonicalTimezone(). They are the two ways a naive check gets this wrong.
  it('accepts the modern name even when the runtime enumerates the legacy one', () => {
    // Browsers report Asia/Kolkata; this Node build lists Asia/Calcutta. Both must be accepted, and
    // both must resolve to the same zone.
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Asia/Calcutta')).toBe(true);
    expect(canonicalTimezone('Asia/Kolkata')).toBe(canonicalTimezone('Asia/Calcutta'));
    expect(canonicalTimezone('Europe/Kyiv')).toBe(canonicalTimezone('Europe/Kiev'));
  });

  it('refuses a bare abbreviation, which ICU resolves in ways nobody expects', () => {
    // ICU maps IST to India (not Ireland, not Israel) and EST to America/Panama. Silently recording
    // either would store a zone the person did not mean.
    expect(isValidTimezone('IST')).toBe(false);
    expect(isValidTimezone('EST')).toBe(false);
    expect(isValidTimezone('GMT')).toBe(false);
  });

  it('can list zones for a picker', () => {
    const zones = supportedTimezones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones.some((z) => z.startsWith('Asia/'))).toBe(true);
    expect(zones.every((z) => isValidTimezone(z))).toBe(true);
  });

  it('reads the offset that applied at the instant, not today', () => {
    expect(offsetMinutesAt('Asia/Kolkata', Date.UTC(1994, 5, 12))).toBe(330);
    // New York in July is on daylight time; the same zone in January is not.
    expect(offsetMinutesAt('America/New_York', Date.UTC(2001, 6, 4, 16))).toBe(-240);
    expect(offsetMinutesAt('America/New_York', Date.UTC(2001, 0, 4, 16))).toBe(-300);
  });

  it('formats an offset for display', () => {
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(-240)).toBe('-04:00');
    expect(formatOffset(0)).toBe('+00:00');
  });

  it('converts an ordinary wall time', () => {
    const c = zonedWallTimeToUtc({ y: 1994, mo: 6, d: 12, h: 9, mi: 30, s: 0 }, 'Asia/Kolkata');
    expect(new Date(c.utcMs).toISOString()).toBe('1994-06-12T04:00:00.000Z');
    expect(c.offsetMinutes).toBe(330);
    expect(c.ambiguous).toBe(false);
    expect(c.nonexistent).toBe(false);
  });

  // THE TWO CASES THE WHOLE MODULE EXISTS FOR.
  it('flags a wall time that happened twice and takes the earlier one', () => {
    // UK clocks went back at 02:00 BST on 1994-10-23, so 01:30 local occurred twice.
    const c = zonedWallTimeToUtc({ y: 1994, mo: 10, d: 23, h: 1, mi: 30, s: 0 }, 'Europe/London');
    expect(c.ambiguous).toBe(true);
    expect(c.nonexistent).toBe(false);
    expect(new Date(c.utcMs).toISOString()).toBe('1994-10-23T00:30:00.000Z');  // the earlier, BST
    expect(c.offsetMinutes).toBe(60);
  });

  it('flags a wall time that never happened', () => {
    // UK clocks went forward at 01:00 GMT on 1994-03-27, so 01:30 local did not exist.
    const c = zonedWallTimeToUtc({ y: 1994, mo: 3, d: 27, h: 1, mi: 30, s: 0 }, 'Europe/London');
    expect(c.nonexistent).toBe(true);
    expect(c.ambiguous).toBe(false);
  });

  it('flags the American fall-back hour too', () => {
    const c = zonedWallTimeToUtc({ y: 2019, mo: 11, d: 3, h: 1, mi: 30, s: 0 }, 'America/New_York');
    expect(c.ambiguous).toBe(true);
    expect(c.offsetMinutes).toBe(-240);   // the earlier occurrence, still on daylight time
  });

  // NEVER A FABRICATED MIDNIGHT. Missing inputs produce null, not a confident wrong answer.
  it('derives nothing without both a time and a zone', () => {
    expect(deriveInstant('1994-06-12', null, 'Asia/Kolkata')).toBeNull();
    expect(deriveInstant('1994-06-12', '09:30:00', null)).toBeNull();
    expect(deriveInstant('1994-06-12', '09:30:00', 'Nowhere/Nothing')).toBeNull();
  });

  it('derives the instant when both are present', () => {
    const d = deriveInstant('1994-06-12', '09:30:00', 'Asia/Kolkata');
    expect(d?.utcIso).toBe('1994-06-12T04:00:00.000Z');
    expect(d?.utcOffsetMinutes).toBe(330);
  });
});

describe('place', () => {
  it('folds accents and punctuation for lookup while keeping what was typed', () => {
    expect(canonicalise('Zürich')).toBe('zurich');
    expect(canonicalise("St. John's, N.L.")).toBe('st john s n l');
  });

  it('resolves country names, codes and everyday aliases', () => {
    expect(resolveCountryCode('India')).toBe('IN');
    expect(resolveCountryCode('in')).toBe('IN');
    expect(resolveCountryCode('Bharat')).toBe('IN');
    expect(resolveCountryCode('UK')).toBe('GB');
    expect(resolveCountryCode('USA')).toBe('US');
    expect(resolveCountryCode('Atlantis')).toBeNull();
  });

  it('splits a three-part free-text line', () => {
    const p = normalisePlace({ raw: 'Nagpur, Maharashtra, India' });
    expect(p.city).toBe('Nagpur');
    expect(p.region).toBe('Maharashtra');
    expect(p.countryCode).toBe('IN');
    expect(p.precision).toBe('structured');
    expect(p.raw).toBe('Nagpur, Maharashtra, India');
  });

  it('stores the ISO country name so two spellings converge', () => {
    expect(normalisePlace({ raw: 'Pune, Bharat' }).country).toBe('India');
    expect(normalisePlace({ raw: 'Pune, India' }).country).toBe('India');
  });

  it('prefers structured parts over the free-text line', () => {
    const p = normalisePlace({ raw: 'ignored', city: 'Zürich', country: 'Switzerland' });
    expect(p.city).toBe('Zürich');
    expect(p.countryCode).toBe('CH');
    expect(p.canonical).toBe('zurich switzerland');
  });

  it('reports honestly when the country did not resolve', () => {
    const p = normalisePlace({ raw: 'Somewhere, Elsewhere' });
    expect(p.countryCode).toBeNull();
    expect(p.precision).toBe('partial');
    expect(p.city).toBe('Somewhere');
  });

  it('treats a lone country as a country and a lone town as a town', () => {
    expect(normalisePlace({ raw: 'India' }).countryCode).toBe('IN');
    expect(normalisePlace({ raw: 'Nagpur' }).city).toBe('Nagpur');
  });
});

describe('coordinates', () => {
  it('accepts absence', () => {
    const r = parseCoordinates('', '', '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('refuses one without the other', () => {
    expect(parseCoordinates('21.1', '', '').ok).toBe(false);
    expect(parseCoordinates('', '79.0', '').ok).toBe(false);
  });

  it('range-checks both', () => {
    expect(parseCoordinates('91', '0', '').ok).toBe(false);
    expect(parseCoordinates('0', '181', '').ok).toBe(false);
  });

  it('rounds to six decimals and keeps the stated source', () => {
    const r = parseCoordinates('21.14581234567', '79.08815', 'Birth certificate');
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(r.value.latitude).toBe(21.145812);
      expect(r.value.statedSource).toBe('Birth certificate');
    }
  });

  it('warns on null island rather than silently accepting it', () => {
    const r = parseCoordinates('0', '0', '');
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(1);
  });
});

describe('the whole block', () => {
  it('accepts a minimal submission: date and place only', () => {
    const r = validateFoundationSubmission({ dateOfBirth: '1994-06-12', birthCity: 'Nagpur', birthCountry: 'India' }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timeOfBirth).toBeNull();
      expect(r.value.timePrecision).toBe('unknown');
      expect(r.value.derived).toBeNull();
      expect(r.value.timezoneSource).toBe('unresolved');
      // Told honestly that the exact moment cannot be worked out.
      expect(r.warnings.some((w) => w.field === 'timeOfBirth')).toBe(true);
    }
  });

  it('collects every field problem in one pass instead of stopping at the first', () => {
    const r = validateFoundationSubmission({ dateOfBirth: 'nonsense', timeOfBirth: '99:99', birthCity: '' }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toContain('dateOfBirth');
      expect(fields).toContain('timeOfBirth');
      expect(fields).toContain('birthCity');
    }
  });

  it('rejects an unknown zone rather than dropping it silently', () => {
    const r = validateFoundationSubmission(
      { dateOfBirth: '1994-06-12', birthCity: 'Nagpur', birthCountry: 'India', timezoneId: 'IST' }, TODAY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === 'timezoneId')).toBe(true);
  });

  it('produces the derived instant for a complete submission', () => {
    const r = validateFoundationSubmission({
      dateOfBirth: '1994-06-12', timeOfBirth: '09:30', timePrecision: 'minute',
      birthCity: 'Nagpur', birthRegion: 'Maharashtra', birthCountry: 'India',
      timezoneId: 'Asia/Kolkata', timezoneSource: 'declared',
    }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.derived?.utcIso).toBe('1994-06-12T04:00:00.000Z');
      expect(r.value.derived?.utcOffsetMinutes).toBe(330);
      expect(r.value.place.countryCode).toBe('IN');
      expect(r.value.timezoneSource).toBe('declared');
    }
  });

  it('warns when a time was given but no zone, and derives nothing', () => {
    const r = validateFoundationSubmission(
      { dateOfBirth: '1994-06-12', timeOfBirth: '09:30', birthCity: 'Nagpur', birthCountry: 'India' }, TODAY,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.derived).toBeNull();
      expect(r.warnings.some((w) => w.field === 'timezoneId')).toBe(true);
    }
  });

  it('surfaces an ambiguous birth time as a warning the person can see', () => {
    const r = validateFoundationSubmission({
      dateOfBirth: '1994-10-23', timeOfBirth: '01:30', birthCity: 'London', birthCountry: 'United Kingdom',
      timezoneId: 'Europe/London',
    }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.derived?.ambiguous).toBe(true);
      expect(r.warnings.some((w) => /twice/.test(w.message))).toBe(true);
    }
  });
});

describe('canonical payload', () => {
  const input = {
    dateOfBirth: '1994-06-12', timeOfBirth: '09:30:00', timePrecision: 'minute' as const,
    place: {
      raw: 'Nagpur, Maharashtra, India', city: 'Nagpur', region: 'Maharashtra',
      country: 'India', countryCode: 'IN', precision: 'structured' as const, canonical: 'nagpur maharashtra india',
    },
    coordinates: null,
    timezoneId: 'Asia/Kolkata', timezoneSource: 'declared' as const,
    derived: { utcOffsetMinutes: 330, utcIso: '1994-06-12T04:00:00.000Z', ambiguous: false, nonexistent: false },
  };

  // The hash is computed over these bytes, so the SAME input must always produce the SAME string
  // regardless of the order the object was built in. Otherwise "did this change?" answers yes forever.
  it('is stable regardless of key insertion order', () => {
    const shuffled = {
      derived: input.derived, timezoneSource: input.timezoneSource, timezoneId: input.timezoneId,
      coordinates: input.coordinates, place: input.place, timePrecision: input.timePrecision,
      timeOfBirth: input.timeOfBirth, dateOfBirth: input.dateOfBirth,
    };
    expect(canonicalInputJson(shuffled as any)).toBe(canonicalInputJson(input));
  });

  it('round-trips', () => {
    expect(parseCanonicalInputJson(canonicalInputJson(input)).dateOfBirth).toBe('1994-06-12');
  });

  it('refuses a payload that is not one of ours', () => {
    expect(() => parseCanonicalInputJson('{"hello":"world"}')).toThrow();
  });
});
