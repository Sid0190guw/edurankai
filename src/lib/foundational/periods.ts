// src/lib/foundational/periods.ts — THE TIME-CYCLE LAYER. Pure; no database, no clock.
//
// =================================================================================================
// WHAT A PERIOD IS IN THIS ENGINE
// =================================================================================================
//
// A bounded span of time, with a start, an end, and the code of the point that governs it under the
// traditional framework's own rules. THAT IS THE WHOLE OUTPUT. A period does not carry a mood, an
// outlook, a warning or an opportunity, and any surface that renders one has left the computation
// layer without saying so.
//
// The system divides a 120-unit whole among nine points in a fixed order, and the position of B02
// inside its segment at birth decides where in that order the first period was already running and
// how much of it was left. Everything after that is arithmetic on those two numbers, which is why a
// period boundary is reproducible to the second and why this file needs no ephemeris of its own.
//
// =================================================================================================
// THREE LEVELS, AND WHY ONLY TWO ARE STORED
// =================================================================================================
//
// Level 1 subdivides into level 2 subdivides into level 3, each by the same proportional rule. Nine
// level-1 periods give 81 level-2 and 729 level-3 spans per 120-unit cycle. The first two are stored
// so other patches can query the timeline in SQL; level 3 is generated on demand from the same seed,
// because 729 rows per person per cycle is a lot of storage for a span that is often a few days long
// and is exactly recomputable in microseconds.
//
// =================================================================================================
// THE YEAR IS A DECLARED CONSTANT, NOT AN ASSUMPTION
// =================================================================================================
//
// Implementations of this system disagree about the length of its year: some use 365.25 days, some
// 360, some a tropical year. They produce boundaries months apart after a century. CYCLE_YEAR_DAYS
// below is the choice this engine makes, it is published in the method manifest, and changing it is
// a version bump — so a stored period can always be checked against the rule that produced it.
import {
  round, roundAngle, roundUnit, CALCULATION_METHOD_VERSION,
  type CyclePeriod, type RawComputation, type FoundationalFactor, type TimePeriodAnalysis, type SubjectRef,
} from './types';
import { SEGMENT_SPAN } from './astronomy';
import { isoFromJulianDay, julianDayFromDate } from './time';
import { buildTechnical, ruleTerm, pointTerm, segmentTerm, type PointCode } from './vocabulary';

// -------------------------------------------------------------------------------------------------
// METHOD CONSTANTS. Part of CALCULATION_METHOD_VERSION. Declared before use: `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** Days in one unit-year of the cycle system. Declared, published, versioned. */
export const CYCLE_YEAR_DAYS = 365.2425;

/** The whole the nine shares divide. */
export const CYCLE_TOTAL_YEARS = 120;

/**
 * The fixed order and share of the nine governing points. The order is the framework's, not this
 * engine's, and the shares sum to CYCLE_TOTAL_YEARS — asserted in periods.test.ts, because a
 * mistyped share would shift every boundary after it and nothing else would notice.
 */
export const CYCLE_SEQUENCE: ReadonlyArray<{ code: PointCode; years: number }> = [
  { code: 'B09', years: 7 },
  { code: 'B06', years: 20 },
  { code: 'B01', years: 6 },
  { code: 'B02', years: 10 },
  { code: 'B03', years: 7 },
  { code: 'B08', years: 18 },
  { code: 'B05', years: 16 },
  { code: 'B07', years: 19 },
  { code: 'B04', years: 17 },
];

/** How many level-1 periods to project by default. Nine is one full cycle. */
export const DEFAULT_HORIZON_YEARS = 120;

/** Ceiling on generated level-3 spans, so a wide window cannot become an unbounded loop. */
const MAX_LEVEL3 = 2000;

/**
 * Decimals the cycle seed's elapsed fraction is rounded to. Deeper than the engine's unit precision
 * on purpose: this one number is multiplied by up to twenty years of days, so a rounding that is
 * harmless on a strength is most of a day on a period boundary.
 */
export const SEED_DP = 9;

const SEQ_LEN = CYCLE_SEQUENCE.length;

// =================================================================================================
// THE SEED
// =================================================================================================

export interface CycleSeed {
  /** Index into CYCLE_SEQUENCE of the period already running at birth. */
  startIndex: number;
  /** How much of that period had already elapsed, 0..1. */
  elapsedFraction: number;
  /** Julian Day (UT) at which that first period began — before the birth, by construction. */
  cycleStartJD: number;
  /** The segment of B02 the seed came from, 1..27. */
  segment: number;
}

/**
 * Derive the seed from the computed positions.
 *
 * ONE POINT DECIDES THE WHOLE TIMELINE. B02's position inside its 13-and-a-third-degree segment is
 * the only input, which is why B02's model error and the recorded birth time dominate every period
 * boundary this file produces, and why analyzePeriods() reports that uncertainty rather than
 * printing a date to the second and letting the reader assume it is exact.
 */
export function cycleSeed(raw: RawComputation): CycleSeed {
  const moon = raw.points.B02;
  if (!moon) throw new Error('cycle seed requires point B02');
  const startIndex = (moon.segment - 1) % SEQ_LEN;
  // ROUNDED FIRST, THEN USED. The published elapsedFraction has to be the number that actually
  // produced the boundaries, or the seed does not reproduce the timeline it is the seed for. At
  // SEED_DP decimals the worst-case boundary shift across a twenty-unit period is under a second;
  // at the four decimals used for a strength it would have been three quarters of a day.
  const elapsedFraction = round(
    Math.min(1, Math.max(0, moon.degreeInSegment / SEGMENT_SPAN)),
    SEED_DP,
  );
  const years = CYCLE_SEQUENCE[startIndex].years;
  const cycleStartJD = raw.normalizedInput.julianDayUT - elapsedFraction * years * CYCLE_YEAR_DAYS;
  return { startIndex, elapsedFraction, cycleStartJD, segment: moon.segment };
}

// =================================================================================================
// GENERATION
// =================================================================================================

function period(args: {
  level: 1 | 2 | 3;
  chain: PointCode[];
  startJD: number;
  endJD: number;
  cycleNo: number;
  version: string;
}): CyclePeriod {
  const { level, chain, startJD, endJD, cycleNo, version } = args;
  return {
    period_id: `cycle:${cycleNo}:L${level}:${chain.join('-')}`,
    level,
    ruler_code: chain[chain.length - 1],
    chain: [...chain],
    starts_at: isoFromJulianDay(startJD),
    ends_at: isoFromJulianDay(endJD),
    length_days: round(endJD - startJD, 4),
    calculation_method_version: version,
    technical: buildTechnical({
      term: ruleTerm(`cycle.level${level}`),
      relatedTerms: chain.map(pointTerm),
      rule: ruleTerm('cycle.system'),
    }),
  };
}

/**
 * Level-1 periods covering [fromJD, toJD]. Cycles repeat every CYCLE_TOTAL_YEARS, and the cycle
 * number is carried into every period id so that the same governing point in two different cycles
 * is two different rows rather than one row that quietly overwrites the other.
 */
export function level1Periods(seed: CycleSeed, fromJD: number, toJD: number, version = CALCULATION_METHOD_VERSION): CyclePeriod[] {
  const out: CyclePeriod[] = [];
  let cursor = seed.cycleStartJD;
  let idx = seed.startIndex;
  let cycleNo = 0;
  // A hard bound rather than `while (true)`: a caller asking for a ten-thousand-year window gets a
  // truncated answer, not a hung function.
  for (let n = 0; n < 400; n++) {
    const entry = CYCLE_SEQUENCE[idx % SEQ_LEN];
    const end = cursor + entry.years * CYCLE_YEAR_DAYS;
    if (end >= fromJD && cursor <= toJD) {
      out.push(period({ level: 1, chain: [entry.code], startJD: cursor, endJD: end, cycleNo, version }));
    }
    cursor = end;
    idx += 1;
    if (idx % SEQ_LEN === seed.startIndex % SEQ_LEN) cycleNo += 1;
    if (cursor > toJD) break;
  }
  return out;
}

/** Level-2 periods inside one level-1 period, in the framework's order, starting at its own ruler. */
export function level2Periods(parent: CyclePeriod, version = CALCULATION_METHOD_VERSION): CyclePeriod[] {
  return subdivide(parent, 2, version);
}

/** Level-3 periods inside one level-2 period. Generated on demand; never stored. */
export function level3Periods(parent: CyclePeriod, version = CALCULATION_METHOD_VERSION): CyclePeriod[] {
  return subdivide(parent, 3, version);
}

function subdivide(parent: CyclePeriod, level: 2 | 3, version: string): CyclePeriod[] {
  const startIdx = CYCLE_SEQUENCE.findIndex((e) => e.code === parent.ruler_code);
  if (startIdx < 0) return [];
  const parentStart = julianDayFromDate(new Date(parent.starts_at));
  const parentDays = parent.length_days;
  const cycleNo = Number(parent.period_id.split(':')[1]) || 0;
  const out: CyclePeriod[] = [];
  let cursor = parentStart;
  for (let k = 0; k < SEQ_LEN; k++) {
    const entry = CYCLE_SEQUENCE[(startIdx + k) % SEQ_LEN];
    const days = parentDays * (entry.years / CYCLE_TOTAL_YEARS);
    out.push(period({
      level,
      chain: [...(parent.chain as PointCode[]), entry.code],
      startJD: cursor,
      endJD: cursor + days,
      cycleNo,
      version,
    }));
    cursor += days;
  }
  return out;
}

/**
 * The stored set: every level-1 period touching the horizon, and every level-2 period inside them.
 *
 * Called once at computation time. The window is anchored on the birth instant rather than on the
 * present, because the present moves and a stored period table that depends on when it was written
 * is a table two people can disagree about.
 */
export function computePeriods(
  raw: RawComputation,
  opts: { horizonYears?: number; version?: string } = {},
): { level1: CyclePeriod[]; level2: CyclePeriod[]; seed: CycleSeed } {
  const version = opts.version || CALCULATION_METHOD_VERSION;
  const horizon = opts.horizonYears ?? DEFAULT_HORIZON_YEARS;
  const seed = cycleSeed(raw);
  const birth = raw.normalizedInput.julianDayUT;
  const level1 = level1Periods(seed, seed.cycleStartJD, birth + horizon * CYCLE_YEAR_DAYS, version);
  const level2: CyclePeriod[] = [];
  for (const p of level1) level2.push(...level2Periods(p, version));
  return { level1, level2, seed };
}

// =================================================================================================
// ANALYSIS
// =================================================================================================

function containing(periods: CyclePeriod[], atJD: number): CyclePeriod | null {
  for (const p of periods) {
    const s = julianDayFromDate(new Date(p.starts_at));
    const e = julianDayFromDate(new Date(p.ends_at));
    if (atJD >= s && atJD < e) return p;
  }
  return null;
}

function withFraction(p: CyclePeriod, atJD: number): CyclePeriod & { fraction_elapsed: number } {
  const s = julianDayFromDate(new Date(p.starts_at));
  const e = julianDayFromDate(new Date(p.ends_at));
  const f = e > s ? (atJD - s) / (e - s) : 0;
  return { ...p, fraction_elapsed: roundUnit(f) };
}

/**
 * Current, upcoming and long-horizon periods for one instant.
 *
 * `asOf`, `from` and `to` are all supplied by the caller. Nothing here reads the clock, which is
 * what makes the function testable and what stops two calls a millisecond apart from disagreeing.
 */
export function analyzePeriods(
  raw: RawComputation,
  args: {
    subject: SubjectRef;
    computationId: string;
    asOf: Date;
    from?: Date;
    to?: Date;
    horizonYears?: number;
    includeLevel3?: boolean;
    version?: string;
  },
): TimePeriodAnalysis {
  const version = args.version || CALCULATION_METHOD_VERSION;
  const horizonYears = args.horizonYears ?? DEFAULT_HORIZON_YEARS;
  const asOfJD = julianDayFromDate(args.asOf);
  const fromJD = args.from ? julianDayFromDate(args.from) : asOfJD;
  const toJD = args.to ? julianDayFromDate(args.to) : asOfJD + 10 * CYCLE_YEAR_DAYS;

  const seed = cycleSeed(raw);
  const birth = raw.normalizedInput.julianDayUT;
  const horizon = level1Periods(seed, seed.cycleStartJD, birth + horizonYears * CYCLE_YEAR_DAYS, version);

  const current: Array<CyclePeriod & { fraction_elapsed: number }> = [];
  const l1 = containing(horizon, asOfJD);
  if (l1) {
    current.push(withFraction(l1, asOfJD));
    const l2list = level2Periods(l1, version);
    const l2 = containing(l2list, asOfJD);
    if (l2) {
      current.push(withFraction(l2, asOfJD));
      const l3 = containing(level3Periods(l2, version), asOfJD);
      if (l3) current.push(withFraction(l3, asOfJD));
    }
  }

  // Upcoming: every level-1 and level-2 boundary inside the window, plus level-3 only when asked —
  // a ten-year window at level 3 is several hundred rows and nobody wants it by accident.
  const upcoming: CyclePeriod[] = [];
  for (const p of horizon) {
    const s = julianDayFromDate(new Date(p.starts_at));
    if (s > asOfJD && s <= toJD && s >= fromJD) upcoming.push(p);
    const overlaps = s <= toJD && julianDayFromDate(new Date(p.ends_at)) >= fromJD;
    if (!overlaps) continue;
    for (const q of level2Periods(p, version)) {
      const qs = julianDayFromDate(new Date(q.starts_at));
      if (qs > asOfJD && qs <= toJD && qs >= fromJD) upcoming.push(q);
      if (!args.includeLevel3) continue;
      if (qs > toJD || julianDayFromDate(new Date(q.ends_at)) < fromJD) continue;
      for (const r of level3Periods(q, version)) {
        const rs = julianDayFromDate(new Date(r.starts_at));
        if (rs > asOfJD && rs <= toJD && rs >= fromJD && upcoming.length < MAX_LEVEL3) upcoming.push(r);
      }
    }
  }
  upcoming.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : a.level - b.level));

  return {
    subject: args.subject,
    computation_id: args.computationId,
    calculation_method_version: version,
    as_of: args.asOf.toISOString(),
    current,
    upcoming,
    horizon,
    window: {
      from: (args.from || args.asOf).toISOString(),
      to: (args.to || new Date((toJD - 2440587.5) * 86400000)).toISOString(),
      horizon_years: horizonYears,
    },
  };
}

// =================================================================================================
// PERIODS AS FACTORS
// =================================================================================================

/**
 * One factor per level-1 period, so the cycle system is queryable from the same table as everything
 * else. `strength` here is the period's share of the whole cycle — a proportion, nothing more.
 */
export function cycleFactors(
  raw: RawComputation,
  level1: CyclePeriod[],
  opts: { computedAt: string; version?: string },
): FoundationalFactor[] {
  const version = opts.version || CALCULATION_METHOD_VERSION;
  const seed = cycleSeed(raw);
  const moon = raw.points.B02;
  return level1.map((p) => {
    const entry = CYCLE_SEQUENCE.find((e) => e.code === p.ruler_code);
    return {
      factor_id: `cycle.level1:${p.period_id}`,
      category: 'time_cycle' as const,
      code: 'cycle.level1.span',
      label: `Level-1 period governed by ${p.ruler_code}`,
      value: `${p.ruler_code} ${p.starts_at.slice(0, 10)} to ${p.ends_at.slice(0, 10)}`,
      numeric_value: p.length_days,
      strength: roundUnit((entry?.years ?? 0) / CYCLE_TOTAL_YEARS),
      // The whole timeline hangs off one number: where B02 sat inside its segment. Its confidence
      // is therefore the confidence of that segment assignment and cannot exceed it.
      confidence: roundUnit(1 - Math.min(1, (moon?.uncertaintyDeg ?? 0.01) / SEGMENT_SPAN)),
      calculation_method_version: version,
      source_inputs: ['input.date', 'input.time', 'input.utcOffsetMinutes'],
      evidence: [
        { ref: 'raw.points.B02.segment', kind: 'derived_quantity' as const, value: moon?.segment ?? 0 },
        { ref: 'raw.points.B02.degreeInSegment', kind: 'derived_quantity' as const, value: roundAngle(moon?.degreeInSegment ?? 0) },
        { ref: 'method.CYCLE_YEAR_DAYS', kind: 'method_constant' as const, value: CYCLE_YEAR_DAYS },
        { ref: 'method.CYCLE_SEQUENCE', kind: 'method_constant' as const, value: CYCLE_SEQUENCE.map((e) => e.code).join(',') },
      ],
      components: { share_of_cycle: roundUnit((entry?.years ?? 0) / CYCLE_TOTAL_YEARS), elapsed_at_birth: seed.elapsedFraction },
      technical: buildTechnical({
        term: ruleTerm('cycle.level1'),
        relatedTerms: [pointTerm(p.ruler_code), segmentTerm(seed.segment)],
        rule: ruleTerm('cycle.system'),
      }),
      computed_at: opts.computedAt,
    };
  });
}
