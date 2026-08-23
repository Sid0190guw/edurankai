// src/lib/foundational/time.ts — WALL CLOCK IN, ONE INSTANT OUT. Pure; no database, no clock.
//
// =================================================================================================
// THE PROBLEM THIS FILE EXISTS FOR
// =================================================================================================
//
// A birth record says "14:32, 3 August 1994, Nagpur". That is a wall-clock reading, and it is NOT an
// instant until somebody supplies the offset that place was keeping at that moment. Get the offset
// wrong by an hour and every position downstream moves by up to fifteen degrees of local sidereal
// time — which is a different ascending sector, a different house for every point, and a different
// answer to every question the engine is ever asked.
//
// So: an offset in MINUTES is what this engine stores and re-uses, and an IANA zone is only ever a
// convenience for producing one. A zone is a moving target — tzdata ships corrections to historical
// offsets several times a year — and a stored computation that re-derives its offset from a zone is
// a computation that can change its answer without anybody editing the record. The offset, once
// resolved, is the input.
//
// =================================================================================================
// THE OTHER TRAP: UT VERSUS TT
// =================================================================================================
//
// Sidereal time is a property of the Earth's rotation and is computed from UT. The Sun, Moon and
// planets are computed from TT, which ran ahead of UT by about 60 seconds in 1994 and by about 8
// seconds in 1900. Sixty seconds is 0.5 arcminutes of lunar motion — small, but free to get right,
// and wrong in a way nobody would ever notice by looking. Every function here is explicit about
// which scale it wants.
import { DEG, RAD, norm360, round, type BirthInput, type NormalizedBirthInput, type TimePrecision } from './types';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. Declared before use: `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** Julian Day of 2000 January 1, 12:00 TT. */
export const J2000 = 2451545.0;

/** Days in a Julian century. */
export const JULIAN_CENTURY = 36525.0;

/** The model's honest validity window. Outside it, the planetary elements are extrapolation. */
export const VALID_FROM_YEAR = 1800;
export const VALID_TO_YEAR = 2050;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// =================================================================================================
// JULIAN DAY
// =================================================================================================

/**
 * Julian Day from a UTC calendar date and time. Proleptic Gregorian throughout — this engine does
 * not serve dates before 1582 and a Julian-calendar branch would be dead code pretending to be care.
 */
export function julianDay(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const dayFraction = (hour + minute / 60 + second / 3600) / 24;
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day + dayFraction + b - 1524.5
  );
}

/** The inverse, for turning a period boundary back into a calendar instant. */
export function calendarFromJulianDay(jd: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const dayWhole = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  // Seconds are rounded once, here, and any carry is propagated — rounding at render time is how a
  // period boundary ends up reading 23:59:60.
  let totalSeconds = Math.round(f * 86400);
  let day = dayWhole;
  if (totalSeconds >= 86400) {
    totalSeconds -= 86400;
    day += 1;
  }
  const hour = Math.floor(totalSeconds / 3600);
  const minute = Math.floor((totalSeconds - hour * 3600) / 60);
  const second = totalSeconds - hour * 3600 - minute * 60;
  return { year, month, day, hour, minute, second };
}

/** ISO-8601 UTC string from a Julian Day. Whole seconds; this engine publishes nothing finer. */
export function isoFromJulianDay(jd: number): string {
  const c = calendarFromJulianDay(jd);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(c.year, 4)}-${p(c.month)}-${p(c.day)}T${p(c.hour)}:${p(c.minute)}:${p(c.second)}Z`;
}

export function julianDayFromDate(d: Date): number {
  return d.getTime() / 86400000 + 2440587.5;
}

export function dateFromJulianDay(jd: number): Date {
  return new Date(Math.round((jd - 2440587.5) * 86400000));
}

/** Julian centuries from J2000 for a Julian Day in the SAME scale the caller intends. */
export function centuriesSinceJ2000(jd: number): number {
  return (jd - J2000) / JULIAN_CENTURY;
}

// =================================================================================================
// DELTA T — the gap between the Earth's rotation and uniform time
// =================================================================================================

/**
 * TT - UT1 in seconds, from the Espenak & Meeus polynomial set. Only the branches this engine's
 * validity window can reach are implemented; outside them the nearest branch is extrapolated and the
 * result is worth a few seconds at most, which is below the precision anything here publishes.
 *
 * IT CAN BE NEGATIVE, and that is not a bug: between roughly 1865 and 1905 the Earth was ahead of
 * uniform time and TT ran BEHIND UT. deltaTSeconds(1880) is about -5 seconds and is meant to be.
 */
export function deltaTSeconds(decimalYear: number): number {
  const y = decimalYear;
  if (y < 1860) {
    // 1800-1860. NOTE THE SIGN: Delta T was POSITIVE here, fell through zero in the 1860s, and was
    // NEGATIVE for most of the rest of the century — the Earth was running fast against uniform
    // time. An implementation that assumes TT is always ahead of UT is wrong for forty years of
    // birth records, which is exactly the window a long-lived personnel system reaches into.
    const t = y - 1800;
    return 13.72 - 0.332447 * t + 0.0068612 * t ** 2 + 0.0041116 * t ** 3
      - 0.00037436 * t ** 4 + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6
      + 0.000000000875 * t ** 7;
  }
  if (y < 1900) {
    const t = y - 1860;
    return 7.62 + 0.5737 * t - 0.251754 * t ** 2 + 0.01680668 * t ** 3
      - 0.0004473624 * t ** 4 + t ** 5 / 233174;
  }
  if (y < 1920) {
    const t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t * t * t - 0.000197 * t * t * t * t;
  }
  if (y < 1941) {
    const t = y - 1920;
    return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t * t * t;
  }
  if (y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - t * t / 233 + t * t * t / 2547;
  }
  if (y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - t * t / 260 - t * t * t / 718;
  }
  if (y < 2005) {
    const t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t
      + 0.000651814 * t * t * t * t + 0.00002373599 * t * t * t * t * t;
  }
  if (y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  const u = (y - 1820) / 100;
  return -20 + 32 * u * u - 0.5628 * (2150 - y);
}

/** Decimal year from a Julian Day, accurate enough for a Delta-T lookup. */
export function decimalYear(jd: number): number {
  const c = calendarFromJulianDay(jd);
  return c.year + (c.month - 0.5) / 12;
}

/** TT Julian Day from a UT Julian Day. */
export function ttFromUT(jdUT: number): number {
  return jdUT + deltaTSeconds(decimalYear(jdUT)) / 86400;
}

// =================================================================================================
// SIDEREAL TIME
// =================================================================================================

/**
 * Greenwich mean sidereal time in degrees, from a UT Julian Day. Meeus 12.4 — the form that takes
 * any UT instant rather than only 0h, which matters because a birth time is never 0h.
 */
export function greenwichMeanSiderealDegrees(jdUT: number): number {
  const t = centuriesSinceJ2000(jdUT);
  const theta =
    280.46061837 +
    360.98564736629 * (jdUT - J2000) +
    0.000387933 * t * t -
    (t * t * t) / 38710000;
  return norm360(theta);
}

/** Local mean sidereal time in degrees. East longitude positive, which is the sign convention the
 * whole engine uses and the opposite of the one older astronomical texts use. */
export function localSiderealDegrees(jdUT: number, longitudeEast: number): number {
  return norm360(greenwichMeanSiderealDegrees(jdUT) + longitudeEast);
}

// =================================================================================================
// TIME ZONE RESOLUTION
// =================================================================================================

/**
 * Offset in minutes east of UTC that `timeZone` was keeping at a given UTC instant.
 *
 * Implemented on Intl, which is the only zone database Node ships. It is used ONCE, at normalisation
 * time, and the number it returns is then stored — see the file header for why re-deriving it later
 * would make a stored computation unstable.
 *
 * Throws on an unknown zone rather than falling back to UTC. A silent fall back to UTC is a
 * five-and-a-half-hour error on every Indian birth record in the system.
 */
export function zoneOffsetMinutesAt(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`time zone '${timeZone}' produced no ${type}`);
    return Number(p.value);
  };
  // Intl renders hour 24 for midnight under hour12:false in some ICU versions.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * The offset a zone was keeping for a given WALL CLOCK reading. Two passes, because the first guess
 * uses the wrong offset by definition and a DST boundary can move the answer by an hour.
 *
 * AMBIGUOUS AND SKIPPED TIMES ARE REAL. In the hour that repeats at the end of DST, two offsets are
 * both correct; this function returns the earlier one and the caller can override by supplying
 * `utcOffsetMinutes` directly. In the hour that does not exist at the start of DST, it returns the
 * offset in force after the transition. Both choices are deterministic, which is the property that
 * matters — and both are recorded, because what gets stored is the resolved offset itself.
 */
export function resolveOffsetMinutes(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetMinutesAt(wallAsUtc, timeZone);
  for (let i = 0; i < 2; i++) {
    const candidate = wallAsUtc - offset * 60000;
    const next = zoneOffsetMinutesAt(candidate, timeZone);
    if (next === offset) break;
    offset = next;
  }
  return offset;
}

// =================================================================================================
// NORMALISATION — the only entry point the engine uses
// =================================================================================================

export class InputError extends Error {}

function parseDate(s: unknown): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(String(s || '').trim());
  if (!m) throw new InputError('date must be YYYY-MM-DD');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new InputError('date month out of range');
  if (day < 1 || day > 31) throw new InputError('date day out of range');
  return { year, month, day };
}

function parseTime(s: unknown): { hour: number; minute: number; second: number } {
  const m = TIME_RE.exec(String(s || '').trim());
  if (!m) throw new InputError('time must be HH:MM or HH:MM:SS');
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) throw new InputError('time out of range');
  return { hour, minute, second };
}

/**
 * Turn a caller's BirthInput into the single instant the rest of the engine consumes.
 *
 * Refuses rather than guessing, in every case: no offset and no zone is a refusal, an unparseable
 * date is a refusal, a latitude of 91 is a refusal. There is no default location and no default
 * time, because a defaulted birth record is a fabricated one.
 */
export function normalizeBirthInput(input: BirthInput): NormalizedBirthInput {
  const { year, month, day } = parseDate(input?.date);
  const { hour, minute, second } = parseTime(input?.time);

  const lat = Number(input?.location?.latitude);
  const lon = Number(input?.location?.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new InputError('latitude must be -90..90');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new InputError('longitude must be -180..180');
  // The ascendant formula divides by cos(latitude) through tan(latitude); at a pole it has no answer.
  if (Math.abs(lat) > 89.5) throw new InputError('latitude within 0.5 degrees of a pole is not supported');

  let offset: number;
  const supplied = input?.utcOffsetMinutes;
  if (supplied !== undefined && supplied !== null && Number.isFinite(Number(supplied))) {
    offset = Math.round(Number(supplied));
    if (Math.abs(offset) > 16 * 60) throw new InputError('utcOffsetMinutes out of range');
  } else if (input?.timeZone) {
    try {
      offset = resolveOffsetMinutes(year, month, day, hour, minute, second, String(input.timeZone));
    } catch (e: any) {
      throw new InputError(`time zone could not be resolved: ${e?.message || 'unknown'}`);
    }
  } else {
    throw new InputError('either utcOffsetMinutes or timeZone is required');
  }

  const jdLocal = julianDay(year, month, day, hour, minute, second);
  const julianDayUT = jdLocal - offset / 1440;

  const yr = calendarFromJulianDay(julianDayUT).year;
  if (yr < VALID_FROM_YEAR || yr > VALID_TO_YEAR) {
    throw new InputError(`date outside the model's validity window ${VALID_FROM_YEAR}-${VALID_TO_YEAR}`);
  }

  const precision: TimePrecision = input?.timePrecision || 'minute';

  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    utcInstant: isoFromJulianDay(julianDayUT),
    julianDayUT: round(julianDayUT, 9),
    utcOffsetMinutes: offset,
    localDate: `${p(year, 4)}-${p(month)}-${p(day)}`,
    localTime: `${p(hour)}:${p(minute)}:${p(second)}`,
    timeZone: input?.timeZone ? String(input.timeZone) : null,
    location: {
      latitude: round(lat, 6),
      longitude: round(lon, 6),
      altitudeM: Number.isFinite(Number(input?.location?.altitudeM)) ? Math.round(Number(input.location.altitudeM)) : null,
      placeLabel: input?.location?.placeLabel ? String(input.location.placeLabel).slice(0, 200) : null,
    },
    timePrecision: precision,
  };
}

/** Radians helpers used by every trigonometric routine downstream. */
export const toRad = (deg: number): number => deg * DEG;
export const toDeg = (rad: number): number => rad * RAD;
