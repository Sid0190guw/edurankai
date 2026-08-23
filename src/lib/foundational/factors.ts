// src/lib/foundational/factors.ts — POSITIONS IN, VERSIONED FACTORS OUT. Pure; no database, no clock.
//
// =================================================================================================
// A FACTOR IS AN ARITHMETIC RESULT WITH ITS WORKING ATTACHED
// =================================================================================================
//
// Every row this file produces answers six questions without anybody having to open the code:
//
//   INPUTS      source_inputs — which of the four raw input fields could change this number
//   PROCESSING  code + calculation_method_version — which rule, at which version
//   OUTPUT      value, numeric_value, strength
//   EVIDENCE    evidence[] — dotted paths into the same record's raw block, each with its value
//   CONFIDENCE  confidence — derived from measurement uncertainty, never from belief
//   TIMESTAMP   computed_at
//
// source_inputs is not decoration. A sector placement depends on WHEN somebody was born and not on
// WHERE; a house placement depends on both. That distinction is visible in the data, so a reader can
// see at a glance which factors an uncertain birthplace could have moved and which it could not.
//
// =================================================================================================
// WHAT `strength` MEANS HERE, AND WHAT IT DOES NOT
// =================================================================================================
//
// strength is a MAGNITUDE, defined geometrically and published with its components. It is not a
// rating of a person, not a quality, and not an input to any employment decision — this engine has
// no idea what a job is. Three different definitions are used, each stated where it is computed:
//
//   indicators      positional definiteness: 0 at a division boundary, 1 at the centre of a division
//   relationships   geometric exactness: how nearly the configuration is exact
//   strength.point  a declared weighted composite of five published components
//
// The composite's weights are exported as STRENGTH_WEIGHTS, travel in the method manifest, and are
// part of the version. Nobody has to trust the number: every component is on the row.
//
// =================================================================================================
// CONFIDENCE IS A MEASUREMENT PROPERTY
// =================================================================================================
//
// A point 0.02 degrees from a sector boundary, computed from a birth time recorded to the nearest
// hour, might be in either sector. Saying so is the whole job. confidence is therefore the distance
// to the nearest boundary measured in units of the combined uncertainty — model error and
// time-precision error added in quadrature — and it reaches 1 only at CONFIDENCE_SIGMAS away from
// the boundary. It is NOT a probability and is not offered as one.
import {
  angleDiff, norm360, roundAngle, roundUnit,
  CALCULATION_METHOD_VERSION, TIME_PRECISION_MINUTES,
  type FactorEvidence, type FoundationalFactor, type RawComputation, type ComputedPoint,
} from './types';
import {
  ASCENDANT_DEG_PER_MINUTE, SECTOR_SPAN, SEGMENT_SPAN, sectorOf,
} from './astronomy';
import {
  BODY_POINTS, NODE_POINTS, POINT_CODES, buildTechnical, houseCode, pointTerm, ruleTerm,
  sectorCode, sectorTerm, segmentCode, segmentTerm, houseTerm, type PointCode,
} from './vocabulary';

// -------------------------------------------------------------------------------------------------
// METHOD CONSTANTS. Every number below is part of CALCULATION_METHOD_VERSION: change one and the
// version changes with it, or a stored computation stops being reproducible. Declared before the
// functions that read them, because `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** How many combined-uncertainty widths from a boundary counts as fully confident. */
export const CONFIDENCE_SIGMAS = 3;

/** Which point rules each sector. The backbone of every dispositor and house-ruler relationship. */
export const SECTOR_RULER: Record<number, PointCode> = {
  1: 'B03', 2: 'B06', 3: 'B04', 4: 'B02', 5: 'B01', 6: 'B04',
  7: 'B06', 8: 'B03', 9: 'B05', 10: 'B07', 11: 'B07', 12: 'B05',
};

/** Sector of maximum dignity for each body, and the degree within it where it is exact. */
export const DIGNITY_PEAK: Record<string, { sector: number; degree: number }> = {
  B01: { sector: 1, degree: 10 },
  B02: { sector: 2, degree: 3 },
  B03: { sector: 10, degree: 28 },
  B04: { sector: 6, degree: 15 },
  B05: { sector: 4, degree: 5 },
  B06: { sector: 12, degree: 27 },
  B07: { sector: 7, degree: 20 },
};

/** Standing relations between bodies. Anything not listed on either side is neutral. */
export const POINT_RELATIONS: Record<string, { friends: PointCode[]; enemies: PointCode[] }> = {
  B01: { friends: ['B02', 'B03', 'B05'], enemies: ['B06', 'B07'] },
  B02: { friends: ['B01', 'B04'], enemies: [] },
  B03: { friends: ['B01', 'B02', 'B05'], enemies: ['B04'] },
  B04: { friends: ['B01', 'B06'], enemies: ['B02'] },
  B05: { friends: ['B01', 'B02', 'B03'], enemies: ['B04', 'B06'] },
  B06: { friends: ['B04', 'B07'], enemies: ['B01', 'B02'] },
  B07: { friends: ['B04', 'B06'], enemies: ['B01', 'B02', 'B03'] },
};

/** The dignity ladder. Six declared rungs, no interpolation between them except at the peak. */
export const DIGNITY_VALUES = {
  peak: 1.0,
  own: 0.85,
  friendly: 0.65,
  neutral: 0.5,
  adverse: 0.35,
  trough: 0.15,
} as const;

/** House in which each body's directional component is at its maximum. */
export const DIRECTIONAL_BEST_HOUSE: Record<string, number> = {
  B01: 10, B03: 10, B05: 1, B04: 1, B02: 4, B06: 4, B07: 7,
};

/** Angularity of each house. Declared, not derived — this is the traditional fourfold division. */
export const ANGULARITY: Record<number, number> = {
  1: 1.0, 4: 1.0, 7: 1.0, 10: 1.0,
  5: 0.85, 9: 0.85,
  2: 0.6, 11: 0.6,
  3: 0.5, 6: 0.5,
  8: 0.3, 12: 0.3,
};

/** Separation from B01 inside which the proximity component starts to bite, in degrees. */
export const PROXIMITY_ORB: Record<string, number> = {
  B02: 12, B03: 17, B04: 14, B05: 11, B06: 10, B07: 15,
};

/** Deepest the proximity component can pull a point down, as a multiplier at zero separation. */
export const PROXIMITY_FLOOR = 0.15;

/** Mean geocentric daily motion, degrees. The denominator of the kinematic motion component. */
export const MEAN_DAILY_MOTION: Record<string, number> = {
  B01: 0.9856, B02: 13.1764, B03: 0.5240, B04: 0.9856, B05: 0.0831,
  B06: 0.9856, B07: 0.0335, B08: 0.0529, B09: 0.0529,
};

/** The composite. Publishing the weights is what stops the composite being an opaque score. */
export const STRENGTH_WEIGHTS: Record<string, number> = {
  dignity: 0.30,
  angularity: 0.25,
  directional: 0.20,
  motion: 0.15,
  proximity: 0.10,
};

/**
 * Extra sector-count offsets at which a point stands in relation to another, beyond the offset of 6
 * (opposition) that applies to every point. Counted in whole sectors, as the framework counts them.
 */
export const SPECIAL_OFFSETS: Record<string, number[]> = {
  B03: [3, 7],
  B05: [4, 8],
  B07: [2, 9],
};

/** The offset every point has to the sector opposite it. */
export const UNIVERSAL_OFFSET = 6;

/** Input fields a time-only factor depends on. */
const TIME_INPUTS = ['input.date', 'input.time', 'input.utcOffsetMinutes'];

/** Input fields a factor that also depends on the place depends on. */
const TIME_AND_PLACE_INPUTS = [...TIME_INPUTS, 'input.location.latitude', 'input.location.longitude'];

// =================================================================================================
// UNCERTAINTY AND CONFIDENCE
// =================================================================================================

/** Combined 1-sigma uncertainty in a point's longitude, degrees: model error and clock error. */
export function positionSigmaDeg(point: ComputedPoint, timeMinutes: number): number {
  const fromModel = point.uncertaintyDeg;
  const fromClock = Math.abs(point.dailyMotion) * (timeMinutes / 1440);
  return Math.sqrt(fromModel * fromModel + fromClock * fromClock);
}

/** Combined 1-sigma uncertainty in the ascending direction, degrees. Dominated by the clock. */
export function ascendantSigmaDeg(timeMinutes: number): number {
  const fromClock = ASCENDANT_DEG_PER_MINUTE * timeMinutes;
  return Math.sqrt(0.01 * 0.01 + fromClock * fromClock);
}

/**
 * Confidence that a longitude falls in the division it was assigned to.
 *
 * Distance to the nearer boundary, in units of sigma, capped at CONFIDENCE_SIGMAS and scaled to
 * 0..1. Linear on purpose: an auditor can reproduce it with a ruler, which a Gaussian tail cannot
 * claim. It is NOT a probability.
 */
export function divisionConfidence(longitude: number, span: number, sigma: number): number {
  const within = norm360(longitude) % span;
  const distance = Math.min(within, span - within);
  if (sigma <= 0) return 1;
  return roundUnit(Math.min(1, distance / (CONFIDENCE_SIGMAS * sigma)));
}

/** 0 at a division boundary, 1 at its centre. The `strength` of an indicator factor. */
export function positionalDefiniteness(longitude: number, span: number): number {
  const within = norm360(longitude) % span;
  const distance = Math.min(within, span - within);
  return roundUnit(distance / (span / 2));
}

// =================================================================================================
// STRENGTH COMPONENTS — each one published on the factor row it feeds
// =================================================================================================

/** Which sectors a body rules. */
export function ownSectors(code: string): number[] {
  return Object.keys(SECTOR_RULER)
    .map(Number)
    .filter((s) => SECTOR_RULER[s] === code);
}

/**
 * The dignity component. Six rungs, plus a linear lift toward 1.0 as a body approaches the exact
 * degree of its peak sector — the only interpolation anywhere in the composite, and it is
 * geometric rather than a matter of opinion.
 */
export function dignityComponent(point: ComputedPoint): { value: number; basis: string } {
  const code = point.code;
  if (NODE_POINTS.includes(code as PointCode)) {
    return { value: DIGNITY_VALUES.neutral, basis: 'not_applicable_to_computed_intersection' };
  }
  const peak = DIGNITY_PEAK[code];
  if (peak) {
    if (point.sector === peak.sector) {
      const closeness = 1 - Math.min(1, Math.abs(point.degreeInSector - peak.degree) / SECTOR_SPAN);
      return { value: roundUnit(DIGNITY_VALUES.own + (DIGNITY_VALUES.peak - DIGNITY_VALUES.own) * closeness), basis: 'peak_sector' };
    }
    const trough = ((peak.sector + 5) % 12) + 1;
    if (point.sector === trough) return { value: DIGNITY_VALUES.trough, basis: 'trough_sector' };
  }
  if (ownSectors(code).includes(point.sector)) return { value: DIGNITY_VALUES.own, basis: 'own_sector' };

  const ruler = SECTOR_RULER[point.sector];
  const rel = POINT_RELATIONS[code];
  if (rel && ruler) {
    if (rel.friends.includes(ruler)) return { value: DIGNITY_VALUES.friendly, basis: 'sector_ruler_allied' };
    if (rel.enemies.includes(ruler)) return { value: DIGNITY_VALUES.adverse, basis: 'sector_ruler_opposed' };
  }
  return { value: DIGNITY_VALUES.neutral, basis: 'sector_ruler_neutral' };
}

/** The angularity component: which of the four house classes the point occupies. */
export function angularityComponent(point: ComputedPoint): number {
  return ANGULARITY[point.house] ?? 0.5;
}

/** The directional component: house distance from the point's declared strongest house. */
export function directionalComponent(point: ComputedPoint): { value: number; basis: string } {
  const best = DIRECTIONAL_BEST_HOUSE[point.code];
  if (!best) return { value: 0.5, basis: 'not_applicable_to_computed_intersection' };
  const raw = Math.abs(point.house - best);
  const distance = Math.min(raw, 12 - raw);
  return { value: roundUnit(1 - distance / 6), basis: 'house_' + houseCode(best) };
}

/**
 * The motion component: apparent speed against the point's own mean, capped at 1.
 *
 * PURELY KINEMATIC, and stated as such because the traditional framework's treatment of retrograde
 * motion is an interpretive claim and this layer does not make interpretive claims. A retrograde
 * point moves slowly against the background and therefore scores low here. That is a description of
 * its speed and nothing else.
 */
export function motionComponent(point: ComputedPoint): number {
  const mean = MEAN_DAILY_MOTION[point.code] || 1;
  return roundUnit(Math.min(1, Math.abs(point.dailyMotion) / mean));
}

/** The proximity component: nearness to B01, which the framework treats as a diminishing condition. */
export function proximityComponent(point: ComputedPoint, sunLongitude: number): { value: number; separation: number; orb: number | null } {
  const separation = Math.abs(angleDiff(point.siderealLongitude, sunLongitude));
  const orb = PROXIMITY_ORB[point.code];
  if (!orb) return { value: 1, separation: roundAngle(separation), orb: null };
  if (separation >= orb) return { value: 1, separation: roundAngle(separation), orb };
  const depth = 1 - separation / orb;
  return { value: roundUnit(1 - (1 - PROXIMITY_FLOOR) * depth), separation: roundAngle(separation), orb };
}

// =================================================================================================
// FACTOR CONSTRUCTION
// =================================================================================================

interface BuildContext {
  raw: RawComputation;
  computedAt: string;
  timeMinutes: number;
  version: string;
}

function ev(ref: string, kind: FactorEvidence['kind'], value: number | string): FactorEvidence {
  return { ref, kind, value };
}

function factor(args: Omit<FoundationalFactor, 'calculation_method_version' | 'computed_at'> & { ctx: BuildContext }): FoundationalFactor {
  const { ctx, ...rest } = args;
  return {
    ...rest,
    strength: roundUnit(rest.strength),
    confidence: roundUnit(rest.confidence),
    numeric_value: rest.numeric_value === null ? null : roundAngle(rest.numeric_value),
    calculation_method_version: ctx.version,
    computed_at: ctx.computedAt,
  };
}

function indicatorFactors(ctx: BuildContext): FoundationalFactor[] {
  const { raw } = ctx;
  const out: FoundationalFactor[] = [];
  const ascSigma = ascendantSigmaDeg(ctx.timeMinutes);

  out.push(factor({
    ctx,
    factor_id: 'indicator.ascendant',
    category: 'foundational_indicator',
    code: 'indicator.ascendant',
    label: 'Ascending direction',
    value: `${sectorCode(raw.ascendantSector)} ${roundAngle(raw.ascendantDeg - (raw.ascendantSector - 1) * SECTOR_SPAN).toFixed(3)}`,
    numeric_value: raw.ascendantDeg,
    strength: positionalDefiniteness(raw.ascendantDeg, SECTOR_SPAN),
    confidence: divisionConfidence(raw.ascendantDeg, SECTOR_SPAN, ascSigma),
    source_inputs: TIME_AND_PLACE_INPUTS,
    evidence: [
      ev('raw.ascendantDeg', 'computed_position', raw.ascendantDeg),
      ev('raw.localSiderealDeg', 'derived_quantity', raw.localSiderealDeg),
      ev('raw.ayanamsaDeg', 'method_constant', raw.ayanamsaDeg),
    ],
    technical: buildTechnical({
      term: sectorTerm(raw.ascendantSector),
      rule: ruleTerm('indicator.ascendant'),
      detail: { degreeInSector: roundAngle(raw.ascendantDeg - (raw.ascendantSector - 1) * SECTOR_SPAN) },
    }),
  }));

  out.push(factor({
    ctx,
    factor_id: 'indicator.midheaven',
    category: 'foundational_indicator',
    code: 'indicator.midheaven',
    label: 'Meridian direction',
    value: sectorCode(sectorOf(raw.midheavenDeg)),
    numeric_value: raw.midheavenDeg,
    strength: positionalDefiniteness(raw.midheavenDeg, SECTOR_SPAN),
    confidence: divisionConfidence(raw.midheavenDeg, SECTOR_SPAN, ascSigma),
    source_inputs: TIME_AND_PLACE_INPUTS,
    evidence: [ev('raw.midheavenDeg', 'computed_position', raw.midheavenDeg)],
    technical: buildTechnical({ term: sectorTerm(sectorOf(raw.midheavenDeg)), rule: ruleTerm('indicator.midheaven') }),
  }));

  for (const code of POINT_CODES) {
    const p = raw.points[code];
    if (!p) continue;
    const sigma = positionSigmaDeg(p, ctx.timeMinutes);
    const houseSigma = Math.sqrt(sigma * sigma + ascSigma * ascSigma);
    const lonEvidence = ev(`raw.points.${code}.siderealLongitude`, 'computed_position', p.siderealLongitude);

    out.push(factor({
      ctx,
      factor_id: `indicator.point.sector:${code}`,
      category: 'foundational_indicator',
      code: 'indicator.point.sector',
      label: `Sector placement of ${code}`,
      value: `${code} in ${sectorCode(p.sector)}`,
      numeric_value: p.degreeInSector,
      strength: positionalDefiniteness(p.siderealLongitude, SECTOR_SPAN),
      confidence: divisionConfidence(p.siderealLongitude, SECTOR_SPAN, sigma),
      source_inputs: TIME_INPUTS,
      evidence: [lonEvidence, ev(`raw.points.${code}.uncertaintyDeg`, 'method_constant', p.uncertaintyDeg)],
      technical: buildTechnical({
        term: pointTerm(code),
        relatedTerms: [sectorTerm(p.sector)],
        rule: ruleTerm('indicator.point.sector'),
        detail: { degreeInSector: p.degreeInSector },
      }),
    }));

    out.push(factor({
      ctx,
      factor_id: `indicator.point.segment:${code}`,
      category: 'foundational_indicator',
      code: 'indicator.point.segment',
      label: `Segment placement of ${code}`,
      value: `${code} in ${segmentCode(p.segment)} Q${p.segmentQuarter}`,
      numeric_value: p.degreeInSegment,
      strength: positionalDefiniteness(p.siderealLongitude, SEGMENT_SPAN),
      confidence: divisionConfidence(p.siderealLongitude, SEGMENT_SPAN, sigma),
      source_inputs: TIME_INPUTS,
      evidence: [lonEvidence],
      technical: buildTechnical({
        term: pointTerm(code),
        relatedTerms: [segmentTerm(p.segment)],
        rule: ruleTerm('indicator.point.segment'),
        detail: { quarter: p.segmentQuarter, degreeInSegment: p.degreeInSegment },
      }),
    }));

    out.push(factor({
      ctx,
      factor_id: `indicator.point.house:${code}`,
      category: 'foundational_indicator',
      code: 'indicator.point.house',
      label: `House placement of ${code}`,
      value: `${code} in ${houseCode(p.house)}`,
      numeric_value: p.house,
      strength: roundUnit(ANGULARITY[p.house] ?? 0.5),
      confidence: divisionConfidence(p.siderealLongitude, SECTOR_SPAN, houseSigma),
      source_inputs: TIME_AND_PLACE_INPUTS,
      evidence: [lonEvidence, ev('raw.ascendantSector', 'derived_quantity', raw.ascendantSector)],
      technical: buildTechnical({
        term: pointTerm(code),
        relatedTerms: [houseTerm(p.house)],
        rule: ruleTerm('indicator.point.house'),
      }),
    }));

    out.push(factor({
      ctx,
      factor_id: `indicator.point.motion:${code}`,
      category: 'foundational_indicator',
      code: 'indicator.point.motion',
      label: `Apparent motion of ${code}`,
      value: p.retrograde ? 'reverse' : 'forward',
      numeric_value: p.dailyMotion,
      strength: motionComponent(p),
      confidence: 1,
      source_inputs: TIME_INPUTS,
      evidence: [
        ev(`raw.points.${code}.dailyMotion`, 'computed_position', p.dailyMotion),
        ev(`method.MEAN_DAILY_MOTION.${code}`, 'method_constant', MEAN_DAILY_MOTION[code] ?? 1),
      ],
      technical: buildTechnical({ term: pointTerm(code), rule: p.retrograde ? 'Vakri' : 'Marga' }),
    }));
  }

  return out;
}

function relationshipFactors(ctx: BuildContext): FoundationalFactor[] {
  const { raw } = ctx;
  const out: FoundationalFactor[] = [];
  const codes = POINT_CODES.filter((c) => raw.points[c]);

  // Co-location: two points in the same sector. Strength falls off with their separation, so a pair
  // one degree apart and a pair twenty-nine degrees apart are not recorded as the same thing.
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const a = raw.points[codes[i]];
      const b = raw.points[codes[j]];
      if (a.sector !== b.sector) continue;
      const separation = Math.abs(angleDiff(a.siderealLongitude, b.siderealLongitude));
      const sigma = Math.sqrt(
        positionSigmaDeg(a, ctx.timeMinutes) ** 2 + positionSigmaDeg(b, ctx.timeMinutes) ** 2,
      );
      out.push(factor({
        ctx,
        factor_id: `relationship.colocation:${a.code}-${b.code}`,
        category: 'factor_relationship',
        code: 'relationship.colocation',
        label: `${a.code} and ${b.code} share ${sectorCode(a.sector)}`,
        value: `${a.code}+${b.code} in ${sectorCode(a.sector)}`,
        numeric_value: separation,
        strength: roundUnit(1 - separation / SECTOR_SPAN),
        confidence: roundUnit(Math.min(
          divisionConfidence(a.siderealLongitude, SECTOR_SPAN, sigma),
          divisionConfidence(b.siderealLongitude, SECTOR_SPAN, sigma),
        )),
        source_inputs: TIME_INPUTS,
        evidence: [
          ev(`raw.points.${a.code}.siderealLongitude`, 'computed_position', a.siderealLongitude),
          ev(`raw.points.${b.code}.siderealLongitude`, 'computed_position', b.siderealLongitude),
        ],
        technical: buildTechnical({
          term: ruleTerm('relationship.colocation'),
          relatedTerms: [pointTerm(a.code), pointTerm(b.code), sectorTerm(a.sector)],
          rule: ruleTerm('relationship.colocation'),
        }),
      }));
    }
  }

  // Directed sector-count relationships. Every point stands in one to the sector opposite it; three
  // points stand in further ones. Strength is exactness: how near the separation is to the whole
  // number of sectors the relationship is counted at.
  for (const from of codes) {
    const a = raw.points[from];
    const offsets = [UNIVERSAL_OFFSET, ...(SPECIAL_OFFSETS[from] || [])];
    for (const to of codes) {
      if (to === from) continue;
      const b = raw.points[to];
      const sectorGap = ((b.sector - a.sector + 12) % 12);
      if (!offsets.includes(sectorGap)) continue;
      const separation = norm360(b.siderealLongitude - a.siderealLongitude);
      const exact = sectorGap * SECTOR_SPAN;
      const off = Math.abs(angleDiff(separation, exact));
      const special = sectorGap !== UNIVERSAL_OFFSET;
      out.push(factor({
        ctx,
        factor_id: `relationship.aspect:${from}->${to}`,
        category: 'factor_relationship',
        code: special ? 'relationship.aspect.special' : 'relationship.aspect',
        label: `${from} stands ${sectorGap} sectors from ${to}`,
        value: `${from}->${to} offset ${sectorGap}`,
        numeric_value: off,
        strength: roundUnit(1 - Math.min(1, off / SECTOR_SPAN)),
        confidence: roundUnit(Math.min(
          divisionConfidence(a.siderealLongitude, SECTOR_SPAN, positionSigmaDeg(a, ctx.timeMinutes)),
          divisionConfidence(b.siderealLongitude, SECTOR_SPAN, positionSigmaDeg(b, ctx.timeMinutes)),
        )),
        source_inputs: TIME_INPUTS,
        evidence: [
          ev(`raw.points.${from}.siderealLongitude`, 'computed_position', a.siderealLongitude),
          ev(`raw.points.${to}.siderealLongitude`, 'computed_position', b.siderealLongitude),
          ev('method.UNIVERSAL_OFFSET', 'method_constant', UNIVERSAL_OFFSET),
        ],
        technical: buildTechnical({
          term: ruleTerm(special ? 'relationship.aspect.special' : 'relationship.aspect'),
          relatedTerms: [pointTerm(from), pointTerm(to)],
          rule: `offset ${sectorGap}`,
        }),
      }));
    }
  }

  // Dispositor: the ruler of the sector a point occupies. Structural, so exact by construction —
  // its strength is 1 and its confidence is the confidence of the sector assignment beneath it.
  for (const code of codes) {
    const p = raw.points[code];
    const ruler = SECTOR_RULER[p.sector];
    out.push(factor({
      ctx,
      factor_id: `relationship.dispositor:${code}`,
      category: 'factor_relationship',
      code: 'relationship.dispositor',
      label: `${code} sits in a sector ruled by ${ruler}`,
      value: `${code} -> ${ruler}`,
      numeric_value: null,
      strength: 1,
      confidence: divisionConfidence(p.siderealLongitude, SECTOR_SPAN, positionSigmaDeg(p, ctx.timeMinutes)),
      source_inputs: TIME_INPUTS,
      evidence: [
        ev(`raw.points.${code}.sector`, 'derived_quantity', p.sector),
        ev(`method.SECTOR_RULER.${p.sector}`, 'method_constant', ruler),
      ],
      technical: buildTechnical({
        term: ruleTerm('relationship.dispositor'),
        relatedTerms: [pointTerm(code), sectorTerm(p.sector), pointTerm(ruler)],
      }),
    }));
  }

  // House rulers. Twelve rows, one per house, derived from the ascending sector alone.
  for (let house = 1; house <= 12; house++) {
    const sector = ((raw.ascendantSector - 1 + house - 1) % 12) + 1;
    const ruler = SECTOR_RULER[sector];
    out.push(factor({
      ctx,
      factor_id: `relationship.house_ruler:${houseCode(house)}`,
      category: 'factor_relationship',
      code: 'relationship.house_ruler',
      label: `${houseCode(house)} is ruled by ${ruler}`,
      value: `${houseCode(house)} -> ${ruler}`,
      numeric_value: null,
      strength: 1,
      confidence: divisionConfidence(raw.ascendantDeg, SECTOR_SPAN, ascendantSigmaDeg(ctx.timeMinutes)),
      source_inputs: TIME_AND_PLACE_INPUTS,
      evidence: [
        ev('raw.ascendantSector', 'derived_quantity', raw.ascendantSector),
        ev(`method.SECTOR_RULER.${sector}`, 'method_constant', ruler),
      ],
      technical: buildTechnical({
        term: ruleTerm('relationship.house_ruler'),
        relatedTerms: [houseTerm(house), sectorTerm(sector), pointTerm(ruler)],
      }),
    }));
  }

  // Proximity to B01. Recorded only where it is inside the declared orb — a row for every point
  // would be twelve rows saying "not near", which is noise rather than evidence.
  const sun = raw.points.B01;
  if (sun) {
    for (const code of codes) {
      if (code === 'B01') continue;
      const p = raw.points[code];
      const prox = proximityComponent(p, sun.siderealLongitude);
      if (prox.orb === null || prox.separation >= prox.orb) continue;
      out.push(factor({
        ctx,
        factor_id: `relationship.proximity_to_b01:${code}`,
        category: 'factor_relationship',
        code: 'relationship.proximity_to_b01',
        label: `${code} lies within the declared orb of B01`,
        value: `${code} at ${prox.separation.toFixed(3)} from B01`,
        numeric_value: prox.separation,
        strength: roundUnit(1 - prox.separation / prox.orb),
        confidence: divisionConfidence(p.siderealLongitude, SECTOR_SPAN, positionSigmaDeg(p, ctx.timeMinutes)),
        source_inputs: TIME_INPUTS,
        evidence: [
          ev(`raw.points.${code}.siderealLongitude`, 'computed_position', p.siderealLongitude),
          ev('raw.points.B01.siderealLongitude', 'computed_position', sun.siderealLongitude),
          ev(`method.PROXIMITY_ORB.${code}`, 'method_constant', prox.orb),
        ],
        technical: buildTechnical({
          term: ruleTerm('relationship.proximity_to_b01'),
          relatedTerms: [pointTerm(code), pointTerm('B01')],
          detail: { separationDeg: prox.separation, orbDeg: prox.orb },
        }),
      }));
    }
  }

  return out;
}

function strengthFactors(ctx: BuildContext): FoundationalFactor[] {
  const { raw } = ctx;
  const sun = raw.points.B01;
  const out: FoundationalFactor[] = [];

  for (const code of POINT_CODES) {
    const p = raw.points[code];
    if (!p) continue;

    const dignity = dignityComponent(p);
    const angularity = angularityComponent(p);
    const directional = directionalComponent(p);
    const motion = motionComponent(p);
    const proximity = sun ? proximityComponent(p, sun.siderealLongitude) : { value: 1, separation: 0, orb: null };

    const components: Record<string, number> = {
      dignity: roundUnit(dignity.value),
      angularity: roundUnit(angularity),
      directional: roundUnit(directional.value),
      motion: roundUnit(motion),
      proximity: roundUnit(proximity.value),
    };
    const composite =
      components.dignity * STRENGTH_WEIGHTS.dignity +
      components.angularity * STRENGTH_WEIGHTS.angularity +
      components.directional * STRENGTH_WEIGHTS.directional +
      components.motion * STRENGTH_WEIGHTS.motion +
      components.proximity * STRENGTH_WEIGHTS.proximity;

    const sigma = positionSigmaDeg(p, ctx.timeMinutes);
    const houseSigma = Math.sqrt(sigma * sigma + ascendantSigmaDeg(ctx.timeMinutes) ** 2);

    out.push(factor({
      ctx,
      factor_id: `strength.point:${code}`,
      category: 'strength',
      code: 'strength.point',
      label: `Composite magnitude for ${code}`,
      value: `${code} ${roundUnit(composite).toFixed(4)}`,
      numeric_value: roundUnit(composite),
      strength: roundUnit(composite),
      // The composite is only as sure as its least sure ingredient: dignity comes from the sector,
      // angularity and direction come from the house, and the house is the shakier of the two.
      confidence: roundUnit(Math.min(
        divisionConfidence(p.siderealLongitude, SECTOR_SPAN, sigma),
        divisionConfidence(p.siderealLongitude, SECTOR_SPAN, houseSigma),
      )),
      source_inputs: TIME_AND_PLACE_INPUTS,
      components,
      evidence: [
        ev(`raw.points.${code}.sector`, 'derived_quantity', p.sector),
        ev(`raw.points.${code}.house`, 'derived_quantity', p.house),
        ev(`raw.points.${code}.dailyMotion`, 'computed_position', p.dailyMotion),
        ev('method.STRENGTH_WEIGHTS', 'method_constant', JSON.stringify(STRENGTH_WEIGHTS)),
        ev(`method.dignity_basis.${code}`, 'method_constant', dignity.basis),
        ev(`method.directional_basis.${code}`, 'method_constant', directional.basis),
      ],
      technical: buildTechnical({
        term: ruleTerm('strength.point'),
        relatedTerms: [pointTerm(code)],
        detail: {
          dignityBasis: dignity.basis,
          directionalBasis: directional.basis,
          proximitySeparationDeg: proximity.separation,
          componentTerms: {
            dignity: ruleTerm('strength.component.dignity'),
            angularity: ruleTerm('strength.component.angularity'),
            directional: ruleTerm('strength.component.directional'),
            motion: ruleTerm('strength.component.motion'),
            proximity: ruleTerm('strength.component.proximity'),
          },
        },
      }),
    }));
  }

  return out;
}

/**
 * Every factor for one computed position set.
 *
 * Ordered deterministically — indicators, then relationships, then strengths, each in the fixed
 * order of POINT_CODES — because the output hash is taken over this array and an array whose order
 * depends on object iteration is an array whose hash changes for no reason.
 */
export function deriveFactors(
  raw: RawComputation,
  opts: { computedAt: string; version?: string },
): FoundationalFactor[] {
  const ctx: BuildContext = {
    raw,
    computedAt: opts.computedAt,
    timeMinutes: TIME_PRECISION_MINUTES[raw.normalizedInput.timePrecision] ?? 1,
    version: opts.version || CALCULATION_METHOD_VERSION,
  };
  return [...indicatorFactors(ctx), ...relationshipFactors(ctx), ...strengthFactors(ctx)];
}

export { BODY_POINTS };
