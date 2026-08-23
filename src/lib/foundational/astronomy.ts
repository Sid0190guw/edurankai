// src/lib/foundational/astronomy.ts — THE ARITHMETIC. Pure functions, no database, no clock.
//
// =================================================================================================
// WHAT IS ACTUALLY COMPUTED HERE, AND WHAT IT IS WORTH
// =================================================================================================
//
// Nine points on the ecliptic, an ascending direction, and a meridian, for one instant and one place
// on the Earth. That is all. The models and their honest error bounds:
//
//   Sun        Meeus, Astronomical Algorithms ch. 25 (geometric longitude of date)   ~0.01 deg
//   Moon       Meeus ch. 47, ELP-2000/82 truncated: 59 longitude terms       longitude ~0.01 deg
//              latitude truncated to 30 terms and worth ~0.02 deg — informational only, no
//              factor in this engine is derived from lunar latitude
//   Planets    JPL "Approximate Positions of the Major Planets", Keplerian elements
//              with secular rates, valid 1800-2050        Mercury..Mars ~0.02, Jupiter/Saturn ~0.2
//   Nodes      Mean lunar node, Meeus 47.7                                            ~0.01 deg
//   Ayanamsa   IAU-2006 general precession accumulated from a fixed J2000 value        ~0.01 deg
//
// NOT APPLIED, DELIBERATELY: nutation (max 0.005 deg), annual aberration (max 0.006 deg), light-time
// (max 0.007 deg for Mars). Each is smaller than the error of the planetary model they would be
// correcting, and applying some of them and not others is how an engine acquires an accuracy it
// cannot actually deliver. They are listed rather than omitted silently because a reader deserves to
// know which corrections are missing.
//
// THE ERROR BOUNDS ARE PUBLISHED, not buried: POINT_UNCERTAINTY_DEG below travels with every point,
// into every factor's confidence, into the stored record. A factor derived from Saturn is less
// certain than one derived from the Sun and says so.
//
// =================================================================================================
// SIDEREAL FRAME
// =================================================================================================
//
// Everything is finally expressed in a sidereal frame: longitude measured from a fixed starting
// direction rather than from the moving equinox. The offset between the two is the ayanamsa, and the
// one used here is defined by accumulating general precession from a stated value at J2000 — so the
// definition is a formula in this file, not a lookup nobody can check.
import {
  DEG, norm360, angleDiff, roundAngle,
  type ComputedPoint, type NormalizedBirthInput, type RawComputation,
} from './types';
import { J2000, JULIAN_CENTURY, centuriesSinceJ2000, ttFromUT, localSiderealDegrees } from './time';
import { POINT_CODES, type PointCode } from './vocabulary';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. Every one of them is part of the method manifest, and changing any of them is a version
// bump. Declared before use: `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** The ayanamsa at J2000.0, in degrees. The fixed point the whole sidereal frame hangs from. */
export const AYANAMSA_J2000_DEG = 23.85319;

/** How the ayanamsa moves. Named so the manifest can say what was used. */
export const AYANAMSA_MODEL = 'precession-accumulated-from-J2000 (IAU 2006 general precession)';

/** Published model error per point, in degrees. Travels into every confidence this engine reports. */
export const POINT_UNCERTAINTY_DEG: Record<string, number> = {
  B01: 0.010, // Sun
  B02: 0.010, // Moon
  B03: 0.020, // Mars
  B04: 0.015, // Mercury
  B05: 0.120, // Jupiter
  B06: 0.020, // Venus
  B07: 0.170, // Saturn
  B08: 0.010, // ascending node (mean)
  B09: 0.010, // descending node (mean)
};

/** Degrees of ascendant movement per minute of clock error, averaged over the day. */
export const ASCENDANT_DEG_PER_MINUTE = 0.25;

const SECTOR_SPAN = 30;                  // degrees per sector, 360/12
const SEGMENT_SPAN = 360 / 27;           // degrees per segment, 13 deg 20 min
const QUARTER_SPAN = SEGMENT_SPAN / 4;

/** Half-width of the central difference used for daily motion, in days. */
const MOTION_STEP_DAYS = 0.25;

// =================================================================================================
// FRAME
// =================================================================================================

/** Mean obliquity of the ecliptic in degrees. Meeus 22.2, T in Julian centuries TT from J2000. */
export function meanObliquityDeg(t: number): number {
  return 23.439291111
    - 0.0130041667 * t
    - 1.6388889e-7 * t * t
    + 5.0361111e-7 * t * t * t;
}

/** Accumulated general precession in longitude since J2000, in arcseconds. IAU 2006. */
export function precessionArcsec(t: number): number {
  return 5028.796195 * t + 1.1054348 * t * t + 0.00007964 * t * t * t;
}

/** The ayanamsa at time T, in degrees. */
export function ayanamsaDeg(t: number): number {
  return AYANAMSA_J2000_DEG + precessionArcsec(t) / 3600;
}

// =================================================================================================
// SUN — Meeus ch. 25
// =================================================================================================

/** Geometric longitude of the Sun referred to the equinox of date, degrees. */
export function sunLongitudeDeg(jdTT: number): number {
  const t = centuriesSinceJ2000(jdTT);
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;
  const mRad = m * DEG;
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(mRad) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * mRad) +
    0.000289 * Math.sin(3 * mRad);
  return norm360(l0 + c);
}

// =================================================================================================
// MOON — Meeus ch. 47, ELP-2000/82 truncated
// =================================================================================================

// [D, M, M', F, coefficient in 1e-6 degrees]
const MOON_LON_TERMS: number[][] = [
  [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314], [0, 0, 2, 0, 213618],
  [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332], [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066],
  [2, 0, 1, 0, 53322], [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383], [2, 0, 0, -2, 15327], [0, 0, 1, 2, -12528], [0, 0, 1, -2, 10980],
  [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034], [4, 0, -2, 0, 8548], [2, 1, -1, 0, -7888],
  [2, 1, 0, 0, -6766], [1, 0, -1, 0, -5163], [1, 1, 0, 0, 4987], [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994], [4, 0, 0, 0, 3861], [2, 0, -3, 0, 3665], [0, 1, -2, 0, -2689],
  [2, 0, -1, 2, -2602], [2, -1, -2, 0, 2390], [1, 0, 1, 0, -2348], [2, -2, 0, 0, 2236],
  [0, 1, 2, 0, -2120], [0, 2, 0, 0, -2069], [2, -2, -1, 0, 2048], [2, 0, 1, -2, -1773],
  [2, 0, 0, 2, -1595], [4, -1, -1, 0, 1215], [0, 0, 2, 2, -1110], [3, 0, -1, 0, -892],
  [2, 1, 1, 0, -810], [4, -1, -2, 0, 759], [0, 2, -1, 0, -713], [2, 2, -1, 0, -700],
  [2, 1, -2, 0, 691], [2, -1, 0, -2, 596], [4, 0, 1, 0, 549], [0, 0, 4, 0, 537],
  [4, -1, 0, 0, 520], [1, 0, -2, 0, -487], [2, 1, 0, -2, -399], [0, 0, 2, -2, -381],
  [1, 1, 1, 0, 351], [3, 0, -2, 0, -340], [4, 0, -3, 0, 330], [2, -1, 2, 0, 327],
  [0, 2, 1, 0, -323], [1, 1, -1, 0, 299], [2, 0, 3, 0, 294],
];

const MOON_LAT_TERMS: number[][] = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, -1, -1, 1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, -1, 1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, -1, -1, -1410], [0, 1, 0, -1, -1344], [0, 0, -1, 1, -1335], [0, 0, 1, 3, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
];

/** Geometric longitude and latitude of the Moon referred to the equinox of date, degrees. */
export function moonPositionDeg(jdTT: number): { longitude: number; latitude: number } {
  const t = centuriesSinceJ2000(jdTT);

  const lp = 218.3164477 + 481267.88123421 * t - 0.0015786 * t * t + (t * t * t) / 538841 - (t * t * t * t) / 65194000;
  const d = 297.8501921 + 445267.1114034 * t - 0.0018819 * t * t + (t * t * t) / 545868 - (t * t * t * t) / 113065000;
  const m = 357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + (t * t * t) / 24490000;
  const mp = 134.9633964 + 477198.8675055 * t + 0.0087414 * t * t + (t * t * t) / 69699 - (t * t * t * t) / 14712000;
  const f = 93.2720950 + 483202.0175233 * t - 0.0036539 * t * t - (t * t * t) / 3526000 + (t * t * t * t) / 863310000;

  // The eccentricity correction: terms in M are scaled because the Earth's orbit is slowly changing.
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;

  const dR = d * DEG, mR = m * DEG, mpR = mp * DEG, fR = f * DEG;

  let sumL = 0;
  for (const [cd, cm, cmp, cf, coeff] of MOON_LON_TERMS) {
    const arg = cd * dR + cm * mR + cmp * mpR + cf * fR;
    const scale = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    sumL += coeff * scale * Math.sin(arg);
  }
  let sumB = 0;
  for (const [cd, cm, cmp, cf, coeff] of MOON_LAT_TERMS) {
    const arg = cd * dR + cm * mR + cmp * mpR + cf * fR;
    const scale = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    sumB += coeff * scale * Math.sin(arg);
  }

  // Additive terms from Venus, Jupiter and the flattening of the Earth.
  const a1 = (119.75 + 131.849 * t) * DEG;
  const a2 = (53.09 + 479264.290 * t) * DEG;
  const a3 = (313.45 + 481266.484 * t) * DEG;
  sumL += 3958 * Math.sin(a1) + 1962 * Math.sin(lp * DEG - fR) + 318 * Math.sin(a2);
  sumB += -2235 * Math.sin(lp * DEG) + 382 * Math.sin(a3) + 175 * Math.sin(a1 - fR)
    + 175 * Math.sin(a1 + fR) + 127 * Math.sin(lp * DEG - mpR) - 115 * Math.sin(lp * DEG + mpR);

  return { longitude: norm360(lp + sumL / 1e6), latitude: sumB / 1e6 };
}

/** Longitude of the MEAN ascending lunar node, degrees. Meeus 47.7. Always retrograde. */
export function meanNodeDeg(jdTT: number): number {
  const t = centuriesSinceJ2000(jdTT);
  return norm360(
    125.0445479 - 1934.1362891 * t + 0.0020754 * t * t + (t * t * t) / 467441 - (t * t * t * t) / 60616000,
  );
}

// =================================================================================================
// PLANETS — JPL approximate elements, valid 1800-2050
// =================================================================================================

interface Elements {
  a: number; e: number; i: number; l: number; peri: number; node: number;
  aDot: number; eDot: number; iDot: number; lDot: number; periDot: number; nodeDot: number;
}

const ELEMENTS: Record<string, Elements> = {
  mercury: { a: 0.38709927, e: 0.20563593, i: 7.00497902, l: 252.25032350, peri: 77.45779628, node: 48.33076593,
    aDot: 0.00000037, eDot: 0.00001906, iDot: -0.00594749, lDot: 149472.67411175, periDot: 0.16047689, nodeDot: -0.12534081 },
  venus: { a: 0.72333566, e: 0.00677672, i: 3.39467605, l: 181.97909950, peri: 131.60246718, node: 76.67984255,
    aDot: 0.00000390, eDot: -0.00004107, iDot: -0.00078890, lDot: 58517.81538729, periDot: 0.00268329, nodeDot: -0.27769418 },
  earth: { a: 1.00000261, e: 0.01671123, i: -0.00001531, l: 100.46457166, peri: 102.93768193, node: 0.0,
    aDot: 0.00000562, eDot: -0.00004392, iDot: -0.01294668, lDot: 35999.37244981, periDot: 0.32327364, nodeDot: 0.0 },
  mars: { a: 1.52371034, e: 0.09339410, i: 1.84969142, l: -4.55343205, peri: -23.94362959, node: 49.55953891,
    aDot: 0.00001847, eDot: 0.00007882, iDot: -0.00813131, lDot: 19140.30268499, periDot: 0.44441088, nodeDot: -0.29257343 },
  jupiter: { a: 5.20288700, e: 0.04838624, i: 1.30439695, l: 34.39644051, peri: 14.72847983, node: 100.47390909,
    aDot: -0.00011607, eDot: -0.00013253, iDot: -0.00183714, lDot: 3034.74612775, periDot: 0.21252668, nodeDot: 0.20469106 },
  saturn: { a: 9.53667594, e: 0.05386179, i: 2.48599187, l: 49.95424423, peri: 92.59887831, node: 113.66242448,
    aDot: -0.00125060, eDot: -0.00050991, iDot: 0.00193609, lDot: 1222.49362201, periDot: -0.41897216, nodeDot: -0.28867794 },
};

/** Solve Kepler's equation. Newton-Raphson; the eccentricities here converge in a handful of steps. */
function solveKepler(mDeg: number, e: number): number {
  const mRad = mDeg * DEG;
  let eRad = mRad + e * Math.sin(mRad);
  for (let i = 0; i < 12; i++) {
    const dm = mRad - (eRad - e * Math.sin(eRad));
    const de = dm / (1 - e * Math.cos(eRad));
    eRad += de;
    if (Math.abs(de) < 1e-12) break;
  }
  return eRad;
}

/** Heliocentric ecliptic rectangular coordinates at J2000, in AU. */
function heliocentric(name: string, t: number): { x: number; y: number; z: number } {
  const el = ELEMENTS[name];
  const a = el.a + el.aDot * t;
  const e = el.e + el.eDot * t;
  const i = (el.i + el.iDot * t) * DEG;
  const l = el.l + el.lDot * t;
  const peri = el.peri + el.periDot * t;
  const node = (el.node + el.nodeDot * t) * DEG;

  let mDeg = l - peri;
  mDeg = ((mDeg % 360) + 540) % 360 - 180;

  const eRad = solveKepler(mDeg, e);
  const xp = a * (Math.cos(eRad) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(eRad);

  const w = (peri) * DEG - node;
  const cw = Math.cos(w), sw = Math.sin(w);
  const cn = Math.cos(node), sn = Math.sin(node);
  const ci = Math.cos(i), si = Math.sin(i);

  return {
    x: (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    y: (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    z: (sw * si) * xp + (cw * si) * yp,
  };
}

/**
 * Geocentric ecliptic longitude and latitude of a planet, referred to the equinox of DATE.
 *
 * The elements are J2000-referred, so accumulated precession is added to bring the longitude onto
 * the same frame the Sun and Moon are already expressed in. Without that step the planets would sit
 * about 0.28 degrees away from the luminaries for a 2020 birth, which is a quarter of a sector
 * boundary's worth of nonsense.
 */
export function planetPositionDeg(name: string, jdTT: number): { longitude: number; latitude: number } {
  const t = (jdTT - J2000) / JULIAN_CENTURY;
  const p = heliocentric(name, t);
  const earth = heliocentric('earth', t);
  const x = p.x - earth.x;
  const y = p.y - earth.y;
  const z = p.z - earth.z;
  const lonJ2000 = norm360(Math.atan2(y, x) / DEG);
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
  return { longitude: norm360(lonJ2000 + precessionArcsec(t) / 3600), latitude: lat };
}

// =================================================================================================
// THE POINT SET
// =================================================================================================

const PLANET_FOR_CODE: Record<string, string> = {
  B03: 'mars', B04: 'mercury', B05: 'jupiter', B06: 'venus', B07: 'saturn',
};

/**
 * Longitudes of all nine points, referred to the equinox of date, for one TT instant.
 * Separated from computePoints() because daily motion needs the same set at three instants.
 */
export function tropicalLongitudes(jdTT: number): Record<string, number> {
  const out: Record<string, number> = {};
  out.B01 = sunLongitudeDeg(jdTT);
  out.B02 = moonPositionDeg(jdTT).longitude;
  for (const code of Object.keys(PLANET_FOR_CODE)) {
    out[code] = planetPositionDeg(PLANET_FOR_CODE[code], jdTT).longitude;
  }
  const node = meanNodeDeg(jdTT);
  out.B08 = node;
  out.B09 = norm360(node + 180);
  return out;
}

function latitudeOf(code: string, jdTT: number): number {
  if (code === 'B01') return 0;
  if (code === 'B02') return moonPositionDeg(jdTT).latitude;
  if (code === 'B08' || code === 'B09') return 0;
  const planet = PLANET_FOR_CODE[code];
  return planet ? planetPositionDeg(planet, jdTT).latitude : 0;
}

/**
 * The sidereal ascendant, degrees.
 *
 * Derived from the rising condition cos(H) = -tan(phi) tan(delta) applied to the ecliptic, which is
 * why the formula carries tan(latitude): the ascendant is a property of the horizon, and the horizon
 * is a property of where the person was. A wrong sign on longitude or latitude produces a perfectly
 * plausible answer for somebody else's birthplace, so the convention is stated once and obeyed
 * everywhere: NORTH positive, EAST positive.
 */
export function tropicalAscendantDeg(lstDeg: number, latitudeDeg: number, obliquityDeg: number): number {
  const th = lstDeg * DEG;
  const eps = obliquityDeg * DEG;
  const phi = latitudeDeg * DEG;
  const y = Math.cos(th);
  const x = -(Math.sin(th) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps));
  return norm360(Math.atan2(y, x) / DEG);
}

/** The tropical midheaven, degrees: where the meridian cuts the ecliptic. */
export function tropicalMidheavenDeg(lstDeg: number, obliquityDeg: number): number {
  const th = lstDeg * DEG;
  const eps = obliquityDeg * DEG;
  return norm360(Math.atan2(Math.sin(th), Math.cos(th) * Math.cos(eps)) / DEG);
}

/** Sector 1..12 for a sidereal longitude. */
export const sectorOf = (lon: number): number => Math.floor(norm360(lon) / SECTOR_SPAN) + 1;

/** Segment 1..27 for a sidereal longitude. */
export const segmentOf = (lon: number): number => Math.floor(norm360(lon) / SEGMENT_SPAN) + 1;

/**
 * Whole-sector houses: the ascending sector is house 1 and every point in it is in house 1,
 * regardless of degree. Chosen because it is the traditional Indian division and because it has no
 * free parameters — every degree-based house system disagrees with every other one near the poles
 * and none of them can be checked against anything.
 */
export const houseOf = (sector: number, ascendantSector: number): number =>
  ((sector - ascendantSector + 12) % 12) + 1;

/**
 * Compute every point for one normalised input. THE function the rest of the engine calls.
 *
 * Deterministic: it reads the clock nowhere, and every published number is rounded to the engine's
 * declared precision before it leaves. Two runs on two machines produce the same object.
 */
export function computeRaw(input: NormalizedBirthInput): RawComputation {
  const jdUT = input.julianDayUT;
  const jdTT = ttFromUT(jdUT);
  const t = centuriesSinceJ2000(jdTT);

  const ayan = ayanamsaDeg(t);
  const obliquity = meanObliquityDeg(t);
  const lst = localSiderealDegrees(jdUT, input.location.longitude);

  const ascTropical = tropicalAscendantDeg(lst, input.location.latitude, obliquity);
  const mcTropical = tropicalMidheavenDeg(lst, obliquity);
  const ascSidereal = norm360(ascTropical - ayan);
  const mcSidereal = norm360(mcTropical - ayan);
  const ascendantSector = sectorOf(ascSidereal);

  const atNow = tropicalLongitudes(jdTT);
  const atBefore = tropicalLongitudes(jdTT - MOTION_STEP_DAYS);
  const atAfter = tropicalLongitudes(jdTT + MOTION_STEP_DAYS);

  const points: Record<string, ComputedPoint> = {};
  for (const code of POINT_CODES as readonly PointCode[]) {
    const tropical = atNow[code];
    const sidereal = norm360(tropical - ayan);
    // Central difference on the UNWRAPPED separation, so a point crossing 0 degrees does not
    // suddenly report 720 degrees per day.
    const motion = angleDiff(atAfter[code], atBefore[code]) / (2 * MOTION_STEP_DAYS);
    const sector = sectorOf(sidereal);
    const segment = segmentOf(sidereal);
    const degreeInSegment = norm360(sidereal) - (segment - 1) * SEGMENT_SPAN;

    points[code] = {
      code,
      siderealLongitude: roundAngle(sidereal),
      tropicalLongitude: roundAngle(tropical),
      dailyMotion: roundAngle(motion),
      latitude: roundAngle(latitudeOf(code, jdTT)),
      sector,
      degreeInSector: roundAngle(norm360(sidereal) - (sector - 1) * SECTOR_SPAN),
      segment,
      segmentQuarter: Math.min(4, Math.floor(degreeInSegment / QUARTER_SPAN) + 1),
      degreeInSegment: roundAngle(degreeInSegment),
      house: houseOf(sector, ascendantSector),
      retrograde: motion < 0,
      uncertaintyDeg: POINT_UNCERTAINTY_DEG[code] ?? 0.2,
    };
  }

  return {
    normalizedInput: input,
    ayanamsaDeg: roundAngle(ayan),
    obliquityDeg: roundAngle(obliquity),
    localSiderealDeg: roundAngle(lst),
    ascendantDeg: roundAngle(ascSidereal),
    midheavenDeg: roundAngle(mcSidereal),
    ascendantSector,
    points,
  };
}

export { SECTOR_SPAN, SEGMENT_SPAN, QUARTER_SPAN };
