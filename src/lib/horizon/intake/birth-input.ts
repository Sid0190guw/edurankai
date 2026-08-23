// src/lib/horizon/intake/birth-input.ts — VALIDATION, NORMALISATION AND EXACT TIME HANDLING.
//
// ENTIRELY PURE. No database, no network, no clock beyond `new Date()` for the not-in-the-future
// check, and no third-party service. Every function here is reachable from a unit test with no
// connection at all, which is the reason it is a separate module from the storage boundary.
//
// =================================================================================================
// THE THREE THINGS THAT ARE EASY TO GET WRONG HERE
// =================================================================================================
//
//  1. A LOCAL WALL TIME IS NOT AN INSTANT. "1994-03-27 02:30 in Europe/London" is not a moment in
//     time — that clock reading never happened, because the clocks went forward at 01:00. And
//     "1994-10-23 01:30 in Europe/London" happened TWICE. Converting either one with a fixed offset
//     produces a confident, wrong answer. zonedWallTimeToUtc() below detects both cases, keeps the
//     earlier occurrence for the ambiguous one, and RECORDS which case it hit so nothing downstream
//     has to assume.
//
//  2. THE OFFSET IS HISTORICAL, NOT CURRENT. India moved to +05:30 in 1945; Europe/Lisbon spent
//     1992-1996 on Central European Time. Using today's offset for a birth in 1988 is simply a
//     different moment. Every offset here is read from the platform's own tz database (ICU, through
//     Intl) AT THE INSTANT IN QUESTION, which is what makes this correct rather than approximately
//     correct.
//
//  3. A PLACE NAME IS NOT A TIME ZONE, AND THIS MODULE NEVER PRETENDS OTHERWISE. There is no
//     geocoder and no zone-from-country guess anywhere in this file. Guessing would manufacture a
//     birth instant that can be hours wrong while looking exactly as authoritative as a real one.
//     An unresolved zone stays `unresolved`, and `derived` stays null.
//
// House rule for .astro callers: every value returned from here is a plain string, number, boolean
// or null, so nothing in this module can trip the JSX restrictions the project's pages live under.
import COUNTRY_CODES from '@/lib/country-codes.json';
import {
  TIME_PRECISIONS,
  type BirthCoordinates,
  type BirthPlace,
  type DerivedInstant,
  type FieldIssue,
  type PersonalFoundationInput,
  type PlacePrecision,
  type RawFoundationSubmission,
  type TimePrecision,
  type TimezoneSource,
  type ValidationResult,
} from './types';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — declared before anything that reads them. `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** Nobody applying for work here was born before this. A date below it is a typo, not a birth. */
export const EARLIEST_BIRTH_DATE = '1900-01-01';

/** Below this the record is almost certainly mistyped. A WARNING, never a rejection and never a decision. */
export const IMPLAUSIBLY_YOUNG_YEARS = 14;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** ISO 3166-1 alpha-2 to English name, as shipped with the rest of the platform. */
const COUNTRY_BY_CODE = COUNTRY_CODES as Record<string, string>;

/**
 * Everyday names that are not the ISO name. Small and explicit rather than fuzzy-matched: a
 * near-miss country match writes the wrong country into somebody's record and nothing ever
 * questions it again.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  'usa': 'US', 'u.s.a.': 'US', 'u.s.': 'US', 'united states of america': 'US', 'america': 'US',
  'uk': 'GB', 'u.k.': 'GB', 'great britain': 'GB', 'britain': 'GB', 'england': 'GB',
  'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB',
  'uae': 'AE', 'u.a.e.': 'AE', 'emirates': 'AE',
  'south korea': 'KR', 'korea': 'KR', 'republic of korea': 'KR',
  'north korea': 'KP',
  'russia': 'RU', 'russian federation': 'RU',
  'bharat': 'IN', 'hindustan': 'IN', 'republic of india': 'IN',
  'holland': 'NL', 'the netherlands': 'NL',
  'ivory coast': 'CI', 'cape verde': 'CV', 'czech republic': 'CZ', 'czechia': 'CZ',
  'burma': 'MM', 'myanmar': 'MM',
  'vietnam': 'VN', 'viet nam': 'VN',
  'syria': 'SY', 'iran': 'IR', 'laos': 'LA', 'macedonia': 'MK', 'north macedonia': 'MK',
  'tanzania': 'TZ', 'bolivia': 'BO', 'venezuela': 'VE', 'moldova': 'MD',
  'congo': 'CG', 'dr congo': 'CD', 'drc': 'CD', 'democratic republic of the congo': 'CD',
};

/** Reverse lookup, built once. Keys are the canonical form produced by canonicalise(). */
const CODE_BY_NAME: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [code, name] of Object.entries(COUNTRY_BY_CODE)) {
    m[canonicalise(name)] = code;
    m[canonicalise(code)] = code;
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (COUNTRY_BY_CODE[code]) m[canonicalise(alias)] = code;
  }
  return m;
})();

/**
 * Every IANA zone this runtime knows, or null where the runtime is too old to enumerate them.
 *
 * Null is NOT a failure: isValidTimezone() falls back to asking Intl to construct a formatter for
 * the zone, which throws for an unknown id. The list exists so a page can render a picker without
 * shipping its own copy of the tz database.
 */
const SUPPORTED_ZONES: readonly string[] | null = (() => {
  try {
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof anyIntl.supportedValuesOf === 'function') {
      return Object.freeze(anyIntl.supportedValuesOf('timeZone'));
    }
  } catch {
    // Fall through to the formatter probe.
  }
  return null;
})();

/** Formatters are expensive to build and this runs per submission. One per zone, reused. */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

// -------------------------------------------------------------------------------------------------
// STRING NORMALISATION
// -------------------------------------------------------------------------------------------------

/** Trim, collapse internal whitespace, and cap. Never returns undefined. */
export function tidy(v: unknown, max = 200): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * PURE. The stable lookup form of a name: lowercase, accents folded, punctuation dropped,
 * single-spaced. Used for country matching and for the place canonical key.
 *
 * Folding accents is what makes "Zürich" and "Zurich" the same place to a lookup while leaving the
 * display value untouched — the raw string the person typed is always kept beside it.
 */
export function canonicalise(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    // The class holds the COMBINING DIACRITICAL MARKS block, U+0300 to U+036F. The characters are
    // literal and invisible in an editor; do not retype this line, copy it.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** PURE. Resolve a country name, alias or ISO code to alpha-2. Null when it does not resolve. */
export function resolveCountryCode(input: unknown): string | null {
  const key = canonicalise(input);
  if (!key) return null;
  return CODE_BY_NAME[key] || null;
}

/** PURE. The ISO English name for an alpha-2 code, or null. */
export function countryNameFor(code: string | null | undefined): string | null {
  if (!code) return null;
  return COUNTRY_BY_CODE[String(code).toUpperCase()] || null;
}

// -------------------------------------------------------------------------------------------------
// DATE
// -------------------------------------------------------------------------------------------------

/**
 * PURE. Validate an ISO yyyy-mm-dd date of birth.
 *
 * Rejects a well-formed string that is not a real day — 2025-02-30 parses in a naive check and rolls
 * over to March in a Date constructor, silently changing somebody's birthday.
 */
export function parseDateOfBirth(raw: unknown, today: Date = new Date()): ValidationResult<string> {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  const s = tidy(raw, 10);

  if (!s) {
    errors.push({ field: 'dateOfBirth', message: 'Enter your date of birth.' });
    return { ok: false, errors, warnings };
  }
  const m = ISO_DATE_RE.exec(s);
  if (!m) {
    errors.push({ field: 'dateOfBirth', message: 'Use the date picker, or type the date as YYYY-MM-DD.' });
    return { ok: false, errors, warnings };
  }
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  // Round-trip through UTC: a rolled-over date comes back as a different day.
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  const real = asUtc.getUTCFullYear() === y && asUtc.getUTCMonth() === mo - 1 && asUtc.getUTCDate() === d;
  if (!real) {
    errors.push({ field: 'dateOfBirth', message: 'That is not a real date. Please check the day and month.' });
    return { ok: false, errors, warnings };
  }
  if (s < EARLIEST_BIRTH_DATE) {
    errors.push({ field: 'dateOfBirth', message: 'Please check the year.' });
    return { ok: false, errors, warnings };
  }
  const todayIso = isoDay(today);
  if (s > todayIso) {
    errors.push({ field: 'dateOfBirth', message: 'A date of birth cannot be in the future.' });
    return { ok: false, errors, warnings };
  }
  if (yearsBetween(s, todayIso) < IMPLAUSIBLY_YOUNG_YEARS) {
    // A WARNING. It is surfaced to the person so they can correct a typo, and it is not used for
    // anything else: nothing in this patch may turn an age into an outcome.
    warnings.push({ field: 'dateOfBirth', message: 'Please check the year — this date looks mistyped.' });
  }
  return { ok: true, value: s, warnings };
}

/** PURE. yyyy-mm-dd for a Date, in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** PURE. Whole years between two ISO days. Calendar arithmetic, not 365.25 division. */
export function yearsBetween(fromIso: string, toIso: string): number {
  const a = ISO_DATE_RE.exec(fromIso); const b = ISO_DATE_RE.exec(toIso);
  if (!a || !b) return 0;
  let years = Number(b[1]) - Number(a[1]);
  const beforeBirthday = (Number(b[2]) < Number(a[2]))
    || (Number(b[2]) === Number(a[2]) && Number(b[3]) < Number(a[3]));
  if (beforeBirthday) years -= 1;
  return years;
}

// -------------------------------------------------------------------------------------------------
// TIME
// -------------------------------------------------------------------------------------------------

/**
 * PURE. Parse a 24-hour local wall time into "HH:MM:SS".
 *
 * An empty value is a legitimate answer, not an error: the time of birth is optional throughout.
 * `{ ok: true, value: null }` means "the person did not give one".
 */
export function parseTimeOfBirth(raw: unknown): ValidationResult<string | null> {
  const warnings: FieldIssue[] = [];
  const s = tidy(raw, 12);
  if (!s) return { ok: true, value: null, warnings };

  const m = TIME_RE.exec(s);
  if (!m) {
    return {
      ok: false,
      errors: [{ field: 'timeOfBirth', message: 'Enter the time as HH:MM on a 24-hour clock, for example 09:30 or 21:05.' }],
      warnings,
    };
  }
  const h = Number(m[1]); const mi = Number(m[2]); const sec = m[3] ? Number(m[3]) : 0;
  if (h > 23 || mi > 59 || sec > 59) {
    return {
      ok: false,
      errors: [{ field: 'timeOfBirth', message: 'That is not a valid 24-hour time.' }],
      warnings,
    };
  }
  return { ok: true, value: pad2(h) + ':' + pad2(mi) + ':' + pad2(sec), warnings };
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/**
 * PURE. Settle the stated precision against whether a time was actually given.
 *
 * The two can disagree — a form remembers a precision from a previous visit while the time field is
 * cleared — and the resolution is always the conservative one. With no time there is no precision to
 * claim, so it is `unknown`; with a time and no stated precision, `minute` is what a HH:MM field
 * actually supports, and claiming `exact` on the person's behalf would invent confidence.
 */
export function normaliseTimePrecision(raw: unknown, hasTime: boolean): TimePrecision {
  if (!hasTime) return 'unknown';
  const s = tidy(raw, 20).toLowerCase();
  if ((TIME_PRECISIONS as readonly string[]).includes(s)) {
    return s === 'unknown' ? 'minute' : (s as TimePrecision);
  }
  return 'minute';
}

// -------------------------------------------------------------------------------------------------
// TIME ZONES
// -------------------------------------------------------------------------------------------------

/** Every IANA zone this runtime can offer for a picker, or an empty array if it cannot enumerate. */
export function supportedTimezones(): readonly string[] {
  return SUPPORTED_ZONES || [];
}

/**
 * Resolve a zone id to whatever this runtime calls it, or null if it is not a zone.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, and both were found by testing rather than by reading a spec:
 *
 *  1. THE ENUMERATED LIST IS NOT THE SET OF VALID IDS. On the Node build this runs on,
 *     Intl.supportedValuesOf('timeZone') answers 'Asia/Calcutta', 'Europe/Kiev' and 'Asia/Rangoon' —
 *     the legacy names — while every browser reports the modern 'Asia/Kolkata', 'Europe/Kyiv',
 *     'Asia/Yangon'. Validating against the list alone would therefore REJECT the zone the
 *     applicant's own browser just told us they are in. So the list is for the picker; the
 *     formatter is the judge.
 *
 *  2. THE FORMATTER ALONE IS TOO GENEROUS. ICU accepts bare abbreviations, and resolves them in
 *     ways nobody would predict: 'IST' becomes Asia/Calcutta (not Ireland, not Israel) and 'EST'
 *     becomes America/Panama. Accepting those would silently record a zone the person did not mean.
 *     So an id must be in region/city form — or the one unambiguous exception, 'UTC'.
 */
export function canonicalTimezone(tz: unknown): string | null {
  const s = tidy(tz, 64);
  if (!s) return null;
  if (s !== 'UTC' && !s.includes('/')) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Is this a zone id this runtime understands, in an unambiguous form? */
export function isValidTimezone(tz: unknown): boolean {
  return canonicalTimezone(tz) !== null;
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = FORMATTER_CACHE.get(tz);
  if (!f) {
    // hourCycle h23 rather than hour12:false: the latter can report hour 24 on some ICU builds,
    // which then reconstructs as the following midnight and silently shifts the day.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    FORMATTER_CACHE.set(tz, f);
  }
  return f;
}

interface WallFields { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** The local clock reading in `tz` at a given UTC instant. */
function wallFieldsAt(tz: string, utcMs: number): WallFields {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || '0');
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/**
 * The UTC offset, in minutes, that `tz` was on at a given UTC instant.
 *
 * Positive east of Greenwich (Asia/Kolkata is +330). Read from the tz database at that instant, so
 * historical rules and daylight saving are already in it.
 */
export function offsetMinutesAt(tz: string, utcMs: number): number {
  const w = wallFieldsAt(tz, utcMs);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - utcMs) / 60000);
}

function sameWall(a: WallFields, b: WallFields): boolean {
  return a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi && a.s === b.s;
}

export interface ZonedConversion {
  utcMs: number;
  offsetMinutes: number;
  /** The reading happened twice; the EARLIER occurrence was taken. */
  ambiguous: boolean;
  /** The reading never happened; the instant returned is the closest one and is flagged as such. */
  nonexistent: boolean;
}

/** A day either side is wider than any real DST step, so both sides of a transition are always seen. */
const PROBE_WINDOW_MS = 26 * 60 * 60 * 1000;

/**
 * Convert a local wall-clock reading in a zone to a UTC instant.
 *
 * THE ALGORITHM, because the subtlety is the whole point. Treat the reading as if it were UTC and
 * collect every offset the zone was on in the day either side of it — one probe is not enough, and
 * getting that wrong is precisely how an ambiguous hour gets silently resolved to whichever side the
 * first guess happened to land on. Subtracting each distinct offset gives the candidate instants.
 * Whichever of them ROUND-TRIP — formatting them back in the zone reproduces the original reading —
 * are the real answers:
 *
 *   two round-trip  -> the reading is ambiguous (a fall-back hour). Take the EARLIER instant.
 *   one round-trips -> the ordinary case.
 *   none round-trip -> the reading does not exist (a spring-forward gap). Return the earliest
 *                      candidate and SAY SO, rather than inventing a time the person did not live.
 */
export function zonedWallTimeToUtc(wall: WallFields, tz: string): ZonedConversion {
  const asIfUtc = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);

  const offsets = new Set<number>([
    offsetMinutesAt(tz, asIfUtc - PROBE_WINDOW_MS),
    offsetMinutesAt(tz, asIfUtc),
    offsetMinutesAt(tz, asIfUtc + PROBE_WINDOW_MS),
  ]);
  const candidates = [...offsets].map((o) => asIfUtc - o * 60000).sort((a, b) => a - b);
  const valid = candidates.filter((ms) => sameWall(wallFieldsAt(tz, ms), wall));

  if (valid.length === 0) {
    const chosen = candidates[0];
    return { utcMs: chosen, offsetMinutes: offsetMinutesAt(tz, chosen), ambiguous: false, nonexistent: true };
  }
  const chosen = valid[0];
  return {
    utcMs: chosen,
    offsetMinutes: offsetMinutesAt(tz, chosen),
    ambiguous: valid.length > 1,
    nonexistent: false,
  };
}

/**
 * PURE. The derived instant for a stated date, time and zone.
 *
 * Returns null — never a fabricated midnight — when either the time or the zone is missing. A caller
 * that needs to know why looks at timeOfBirth and timezoneId, both of which it already has.
 */
export function deriveInstant(
  dateIso: string,
  timeHms: string | null,
  timezoneId: string | null,
): DerivedInstant | null {
  if (!timeHms || !timezoneId) return null;
  const d = ISO_DATE_RE.exec(dateIso);
  const t = TIME_RE.exec(timeHms);
  if (!d || !t) return null;
  if (!isValidTimezone(timezoneId)) return null;

  const conv = zonedWallTimeToUtc({
    y: Number(d[1]), mo: Number(d[2]), d: Number(d[3]),
    h: Number(t[1]), mi: Number(t[2]), s: t[3] ? Number(t[3]) : 0,
  }, timezoneId);

  return {
    utcOffsetMinutes: conv.offsetMinutes,
    utcIso: new Date(conv.utcMs).toISOString(),
    ambiguous: conv.ambiguous,
    nonexistent: conv.nonexistent,
  };
}

/** PURE. "+05:30" / "-04:00" for an offset in minutes. Display only. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

// -------------------------------------------------------------------------------------------------
// PLACE
// -------------------------------------------------------------------------------------------------

export interface RawPlaceParts {
  /** A single free-text line, e.g. "Nagpur, Maharashtra, India". Used when the parts are absent. */
  raw?: unknown;
  city?: unknown;
  region?: unknown;
  country?: unknown;
}

/**
 * PURE. Normalise a place of birth.
 *
 * Structured parts win when they are given. A single free-text line is split on commas — city first,
 * country last when the last segment resolves to a country, region in between. NOTHING here is
 * looked up externally and nothing is inferred beyond that split, so `precision` honestly reports
 * how much of the string was actually understood.
 */
export function normalisePlace(parts: RawPlaceParts): BirthPlace {
  const rawLine = tidy(parts.raw, 300);
  let city = tidy(parts.city, 120) || null;
  let region = tidy(parts.region, 120) || null;
  let country = tidy(parts.country, 120) || null;

  if (!city && !region && !country && rawLine) {
    const segs = rawLine.split(',').map((s) => tidy(s, 120)).filter(Boolean);
    if (segs.length === 1) {
      // One segment: a country on its own is a country; anything else is a city.
      if (resolveCountryCode(segs[0])) country = segs[0]; else city = segs[0];
    } else if (segs.length >= 2) {
      city = segs[0];
      const last = segs[segs.length - 1];
      if (resolveCountryCode(last)) {
        country = last;
        if (segs.length >= 3) region = segs.slice(1, -1).join(', ').slice(0, 120);
      } else {
        region = segs.slice(1).join(', ').slice(0, 120);
      }
    }
  }

  const countryCode = resolveCountryCode(country);
  // The ISO name, so two people who typed "Bharat" and "India" store the same country.
  const countryName = countryNameFor(countryCode) || country;

  let precision: PlacePrecision;
  if (city && countryCode) precision = 'structured';
  else if (city || countryCode || region) precision = 'partial';
  else precision = 'freetext';

  const canonical = canonicalise([city, region, countryName].filter(Boolean).join(' ') || rawLine);

  return {
    raw: rawLine || [city, region, country].filter(Boolean).join(', '),
    city,
    region,
    country: countryName,
    countryCode,
    precision,
    canonical,
  };
}

// -------------------------------------------------------------------------------------------------
// COORDINATES
// -------------------------------------------------------------------------------------------------

/**
 * PURE. Validate a coordinate pair the person typed in.
 *
 * Both or neither: one alone is not a location, and storing a lone latitude invites a later reader
 * to pair it with something. `{ ok: true, value: null }` means "not provided", which is normal.
 */
export function parseCoordinates(
  lat: unknown, lon: unknown, statedSource: unknown,
): ValidationResult<BirthCoordinates | null> {
  const warnings: FieldIssue[] = [];
  const latS = tidy(lat, 32); const lonS = tidy(lon, 32);
  if (!latS && !lonS) return { ok: true, value: null, warnings };

  const errors: FieldIssue[] = [];
  if (!latS || !lonS) {
    errors.push({ field: !latS ? 'latitude' : 'longitude', message: 'Give both latitude and longitude, or leave both blank.' });
    return { ok: false, errors, warnings };
  }
  const latN = Number(latS); const lonN = Number(lonS);
  if (!Number.isFinite(latN) || latN < -90 || latN > 90) {
    errors.push({ field: 'latitude', message: 'Latitude must be a number between -90 and 90.' });
  }
  if (!Number.isFinite(lonN) || lonN < -180 || lonN > 180) {
    errors.push({ field: 'longitude', message: 'Longitude must be a number between -180 and 180.' });
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  if (latN === 0 && lonN === 0) {
    warnings.push({ field: 'latitude', message: 'Latitude and longitude are both zero. Please check them.' });
  }
  return {
    ok: true,
    // Six decimals is roughly 0.1m. More is false precision for a place of birth.
    value: { latitude: round6(latN), longitude: round6(lonN), statedSource: tidy(statedSource, 120) || null },
    warnings,
  };
}

function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

// -------------------------------------------------------------------------------------------------
// THE WHOLE BLOCK
// -------------------------------------------------------------------------------------------------

/**
 * Validate and normalise a complete submission.
 *
 * EVERY field issue is collected before returning, rather than stopping at the first: a person
 * should be told everything that needs fixing in one pass, not made to resubmit four times.
 *
 * WHAT IS REQUIRED, and only this: a date of birth, and enough of a place to be worth holding.
 * Time, precision, zone and coordinates are all optional, and their absence produces WARNINGS that
 * say honestly what cannot be worked out without them.
 */
export function validateFoundationSubmission(
  raw: RawFoundationSubmission,
  today: Date = new Date(),
): ValidationResult<PersonalFoundationInput> {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];

  const date = parseDateOfBirth(raw.dateOfBirth, today);
  if (date.ok) warnings.push(...date.warnings); else { errors.push(...date.errors); warnings.push(...date.warnings); }

  const time = parseTimeOfBirth(raw.timeOfBirth);
  if (time.ok) warnings.push(...time.warnings); else { errors.push(...time.errors); warnings.push(...time.warnings); }

  const place = normalisePlace({
    raw: raw.birthPlace, city: raw.birthCity, region: raw.birthRegion, country: raw.birthCountry,
  });
  if (!place.raw) {
    errors.push({ field: 'birthCity', message: 'Enter the town or city where you were born.' });
  } else if (place.precision === 'freetext') {
    warnings.push({ field: 'birthCountry', message: 'We could not recognise the country. The place is stored exactly as you typed it.' });
  }

  const coords = parseCoordinates(raw.latitude, raw.longitude, raw.coordinatesSource);
  if (coords.ok) warnings.push(...coords.warnings); else { errors.push(...coords.errors); warnings.push(...coords.warnings); }

  const tzRaw = tidy(raw.timezoneId, 64);
  let timezoneId: string | null = null;
  let timezoneSource: TimezoneSource = 'unresolved';
  if (tzRaw) {
    // STORED AS THE PERSON GAVE IT, not as this runtime canonicalises it. The canonical form depends
    // on the ICU version the process happens to have ('Asia/Calcutta' here, 'Asia/Kolkata' on a newer
    // build), so canonicalising on write would make the change hash flip on a runtime upgrade and
    // queue a recomputation for everybody. Both forms resolve identically every time they are used.
    if (isValidTimezone(tzRaw)) {
      timezoneId = tzRaw;
      const declared = tidy(raw.timezoneSource, 16).toLowerCase();
      timezoneSource = declared === 'device' ? 'device' : 'declared';
    } else {
      errors.push({ field: 'timezoneId', message: 'That is not a time zone we recognise. Please choose one from the list.' });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const timeOfBirth = (time as { value: string | null }).value;
  const dateOfBirth = (date as { value: string }).value;
  const timePrecision = normaliseTimePrecision(raw.timePrecision, !!timeOfBirth);
  const derived = deriveInstant(dateOfBirth, timeOfBirth, timezoneId);

  // Honest warnings about what could NOT be worked out. None of these blocks the submission.
  if (!timeOfBirth) {
    warnings.push({ field: 'timeOfBirth', message: 'Without a time of birth the exact moment cannot be worked out. Everything else is still used.' });
  } else if (!timezoneId) {
    warnings.push({ field: 'timezoneId', message: 'Without a time zone we cannot turn that time into an exact moment, so we store the time exactly as you gave it and nothing more.' });
  }
  if (derived?.ambiguous) {
    warnings.push({ field: 'timeOfBirth', message: 'The clocks went back that night, so this reading happened twice. We have recorded the earlier one and noted the uncertainty.' });
  }
  if (derived?.nonexistent) {
    warnings.push({ field: 'timeOfBirth', message: 'The clocks went forward that night, so this exact reading did not occur. Please check the time if you can.' });
  }

  return {
    ok: true,
    warnings,
    value: {
      dateOfBirth,
      timeOfBirth,
      timePrecision,
      place,
      coordinates: (coords as { value: BirthCoordinates | null }).value,
      timezoneId,
      timezoneSource,
      derived,
    },
  };
}

/**
 * PURE. A stable, key-ordered JSON string for a validated block.
 *
 * Two purposes, both of which need the SAME bytes every time: it is what gets encrypted, and it is
 * what the change hash is computed over. `JSON.stringify` follows insertion order, so the order is
 * written out explicitly here rather than left to however the object happened to be built.
 */
export function canonicalInputJson(v: PersonalFoundationInput): string {
  return JSON.stringify({
    dateOfBirth: v.dateOfBirth,
    timeOfBirth: v.timeOfBirth,
    timePrecision: v.timePrecision,
    place: {
      raw: v.place.raw,
      city: v.place.city,
      region: v.place.region,
      country: v.place.country,
      countryCode: v.place.countryCode,
      precision: v.place.precision,
      canonical: v.place.canonical,
    },
    coordinates: v.coordinates
      ? { latitude: v.coordinates.latitude, longitude: v.coordinates.longitude, statedSource: v.coordinates.statedSource }
      : null,
    timezoneId: v.timezoneId,
    timezoneSource: v.timezoneSource,
    derived: v.derived
      ? {
        utcOffsetMinutes: v.derived.utcOffsetMinutes,
        utcIso: v.derived.utcIso,
        ambiguous: v.derived.ambiguous,
        nonexistent: v.derived.nonexistent,
      }
      : null,
  });
}

/** PURE. Rebuild a validated block from its canonical JSON. Throws on anything malformed. */
export function parseCanonicalInputJson(json: string): PersonalFoundationInput {
  const o = JSON.parse(json);
  if (!o || typeof o !== 'object') throw new Error('foundation payload is not an object');
  if (typeof o.dateOfBirth !== 'string' || !ISO_DATE_RE.test(o.dateOfBirth)) {
    throw new Error('foundation payload has no valid dateOfBirth');
  }
  return o as PersonalFoundationInput;
}
