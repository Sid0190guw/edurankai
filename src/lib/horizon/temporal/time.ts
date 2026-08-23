// src/lib/horizon/time.ts — THE TIME VOCABULARY. PURE ARITHMETIC, NO DATABASE, NO OPINIONS.
//
// =================================================================================================
// PATCH 07 — HORIZON TIME INTELLIGENCE. WHAT THIS FILE IS.
// =================================================================================================
//
// Seven horizons, four layers, and one rule that outranks the rest: A STATEMENT ABOUT THE FUTURE IS
// NEVER A STATEMENT OF FACT. Everything here exists to make that structural rather than editorial.
//
// This file holds only pure functions. It imports nothing from the database, nothing from the
// authorization engine and nothing from the twin. That is deliberate: the confidence arithmetic and
// the projection-hedging are the two things most likely to be quietly wrong, and both are testable
// here without a connection. src/lib/horizon/horizon.test.ts exercises them directly.
//
// =================================================================================================
// THE FOUR LAYERS, AND WHY THEY ARE NEVER MERGED INTO A SINGLE NUMBER
// =================================================================================================
//
//   observed      A. WHAT HAPPENED. Trends computed from rows that already exist. Historical fact
//                    plus arithmetic over it. Re-derivable by anybody with the same rows.
//   current       B. WHAT IS TRUE NOW. The present-tense evidence: the live records, the open
//                    goals, the standing review. Not a trend, a state.
//   projected     C. WHAT MIGHT DEVELOP. The only layer that speaks about the future. Every
//                    statement it emits is marked 'predicted' and hedged, and no code path can
//                    emit one that reads as certain.
//   foundational  D. THE TIME CYCLES UNDERNEATH. Cadence and phase rather than event: where a
//                    person sits in the repeating cycles their working life is organised around.
//
// A screen may show all four. NOTHING COMBINES THEM INTO ONE SCORE. The master build rule is that
// demonstrated job-related evidence outweighs anything inferred, and the only way to hold that line
// permanently is to never build the adder that would let it be crossed. There is no composite here
// and there is no field to hold one.
//
// =================================================================================================
// CONFIDENCE IS CALCULATED, NEVER PASSED IN
// =================================================================================================
//
// confidenceFor() takes evidence characteristics and returns a number. No caller may hand it a
// confidence and have it stored. The single most important term is SPAN COVERAGE: how much of the
// horizon the evidence actually spans. Eight months of attendance records say almost nothing about
// twenty years, and the arithmetic below makes that come out as a number near zero rather than as a
// confident sentence with a small-print disclaimer nobody reads.
//
// Each horizon also carries a HARD CEILING that no amount of evidence can lift. A twenty-year
// projection is capped at 0.10 even for a person with a twenty-year record, because the limit there
// is not the data, it is the claim.

export const MOD = 'horizon/time';

// =================================================================================================
// HORIZONS
// =================================================================================================

export const HORIZONS = [
  'recent',
  'week',
  'month',
  'year',
  'five_year',
  'ten_year',
  'twenty_year',
] as const;

export type Horizon = (typeof HORIZONS)[number];

export function isHorizon(v: unknown): v is Horizon {
  return typeof v === 'string' && (HORIZONS as readonly string[]).indexOf(v) >= 0;
}

/** How a horizon's output is produced and kept. */
export type HorizonCadence = 'live' | 'versioned';

export interface HorizonSpec {
  key: Horizon;
  label: string;
  /** One line a screen prints under the heading. */
  hint: string;
  /**
   * live      recomputed on every read, never stored. The short horizons must move the moment a
   *           record does, and a cached copy of "this week" is wrong within hours.
   * versioned recomputed on a cadence and STORED WITH A VERSION, because a long-horizon reading is
   *           a document somebody may be asked to justify months later. Overwriting it in place
   *           would destroy the only record of what the system said at the time.
   */
  cadence: HorizonCadence;
  /** Days of history this horizon reads. null means the whole record. */
  lookbackDays: number | null;
  /** Days forward the projection layer speaks about. */
  forwardDays: number;
  /** No evidence, however rich, lifts confidence above this. */
  confidenceCeiling: number;
  /** How often a versioned horizon is recomputed. Ignored for live horizons. */
  recomputeEveryDays: number | null;
}

/**
 * THE SEVEN HORIZONS.
 *
 * The ceilings descend faster than the spans grow, and that is the point. Going from one year to
 * twenty multiplies the span by twenty and divides the ceiling by six and a half. Anybody reading a
 * twenty-year panel sees a number that cannot exceed 0.10 no matter how good the record is.
 */
export const HORIZON_SPECS: Record<Horizon, HorizonSpec> = {
  recent: {
    key: 'recent',
    label: 'Recent',
    hint: 'The last fortnight, as it stands right now.',
    cadence: 'live',
    lookbackDays: 14,
    forwardDays: 7,
    confidenceCeiling: 0.9,
    recomputeEveryDays: null,
  },
  week: {
    key: 'week',
    label: 'This Week',
    hint: 'The current working week.',
    cadence: 'live',
    lookbackDays: 7,
    forwardDays: 7,
    confidenceCeiling: 0.85,
    recomputeEveryDays: null,
  },
  month: {
    key: 'month',
    label: 'This Month',
    hint: 'The last thirty days and the shape they make.',
    cadence: 'live',
    lookbackDays: 30,
    forwardDays: 30,
    confidenceCeiling: 0.8,
    recomputeEveryDays: null,
  },
  year: {
    key: 'year',
    label: 'This Year',
    hint: 'The last twelve months, versioned so the reading can be checked later.',
    cadence: 'versioned',
    lookbackDays: 365,
    forwardDays: 365,
    confidenceCeiling: 0.65,
    recomputeEveryDays: 7,
  },
  five_year: {
    key: 'five_year',
    label: '5 Years',
    hint: 'A development horizon. Read it as a direction, not a forecast.',
    cadence: 'versioned',
    lookbackDays: null,
    forwardDays: 1826,
    confidenceCeiling: 0.35,
    recomputeEveryDays: 30,
  },
  ten_year: {
    key: 'ten_year',
    label: '10 Years',
    hint: 'A long development horizon. The record supporting it is almost always shorter than it.',
    cadence: 'versioned',
    lookbackDays: null,
    forwardDays: 3652,
    confidenceCeiling: 0.2,
    recomputeEveryDays: 90,
  },
  twenty_year: {
    key: 'twenty_year',
    label: '20 Years',
    hint: 'A horizon this system cannot see to. Kept because the shape of a career is worth naming, not because the reading is reliable.',
    cadence: 'versioned',
    lookbackDays: null,
    forwardDays: 7305,
    confidenceCeiling: 0.1,
    recomputeEveryDays: 180,
  },
};

export const LIVE_HORIZONS: readonly Horizon[] = Object.freeze(
  HORIZONS.filter((h) => HORIZON_SPECS[h].cadence === 'live'),
);

export const VERSIONED_HORIZONS: readonly Horizon[] = Object.freeze(
  HORIZONS.filter((h) => HORIZON_SPECS[h].cadence === 'versioned'),
);

export function horizonSpec(h: Horizon): HorizonSpec {
  return HORIZON_SPECS[h];
}

// =================================================================================================
// LAYERS
// =================================================================================================

export const LAYERS = ['observed', 'current', 'projected', 'foundational'] as const;
export type Layer = (typeof LAYERS)[number];

export function isLayer(v: unknown): v is Layer {
  return typeof v === 'string' && (LAYERS as readonly string[]).indexOf(v) >= 0;
}

export const LAYER_LABELS: Record<Layer, string> = {
  observed: 'Observed history',
  current: 'Current evidence',
  projected: 'Possible development',
  foundational: 'Underlying cycles',
};

/** Printed next to the layer wherever a reading is shown. These are load-bearing, not decoration. */
export const LAYER_MEANING: Record<Layer, string> = {
  observed:
    'Computed from records that already exist. Anybody with the same rows gets the same answer.',
  current:
    'What the record says is true today. A state, not a trend, and it changes when the record does.',
  projected:
    'A possible direction, not a forecast. Nothing here has happened, and nothing here is evidence about this person.',
  foundational:
    'Where this person sits in the repeating cycles their work is organised around. Cadence, not judgement.',
};

/**
 * The assertion vocabulary from src/lib/digital-twin.ts, which owns it. Mapping is one-way and
 * lives here so a reading can be handed to any surface that already speaks that language.
 *
 * NOTE the third row. digital-twin.ts defines 'predicted' and then states that nothing in that file
 * emits one. THIS MODULE IS THE ONE THAT DOES, and it is the only reason the value exists.
 */
export const LAYER_ASSERTION: Record<Layer, 'calculated' | 'factual' | 'predicted' | 'inferred'> = {
  observed: 'calculated',
  current: 'factual',
  projected: 'predicted',
  foundational: 'inferred',
};

/** Which layers may ever influence a decision, and which may not. Read by the surfaces. */
export const LAYER_DECISION_WEIGHT: Record<Layer, 'primary' | 'supporting' | 'none'> = {
  observed: 'primary',
  current: 'primary',
  projected: 'none',
  foundational: 'none',
};

// =================================================================================================
// THE HEDGE. A PROJECTION CANNOT BE PHRASED AS A FACT BY ANY CALLER.
// =================================================================================================
//
// Every sentence the projection layer emits goes through hedged(). It is not a style helper. The
// failure it prevents is the one that actually happens in systems like this: a projection is written
// as "will move into a team lead role", somebody reads it six months later without the panel around
// it, and it has become a plan the person was never told about.

const CERTAIN_PHRASES: readonly RegExp[] = Object.freeze([
  /\bwill\b/i,
  /\bshall\b/i,
  /\bis going to\b/i,
  /\bguarantee[sd]?\b/i,
  /\bcertain(ly)?\b/i,
  /\bdefinitely\b/i,
  /\bexpect(s|ed)? to\b/i,
  /\bon track to\b/i,
  /\bdestined\b/i,
  /\bwithout doubt\b/i,
  /\binevitab(le|ly)\b/i,
  /\bproven\b/i,
]);

/** Does this sentence claim the future as fact. Used as a gate, and asserted in the tests. */
export function claimsCertainty(text: string): boolean {
  const t = String(text || '');
  return CERTAIN_PHRASES.some((re) => re.test(t));
}

/**
 * Strip the certainty out of a projection sentence and prefix it with an explicit conditional.
 *
 * Rewriting rather than refusing is deliberate: a refusal here would show a blank panel, and a blank
 * panel gets filled in by whoever is reading it. A hedged sentence says the same useful thing
 * without the claim.
 */
export function hedged(text: string): string {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t
    .replace(/\bwill likely\b/gi, 'could')
    .replace(/\bis going to\b/gi, 'could')
    .replace(/\bis on track to\b/gi, 'is currently moving toward')
    .replace(/\bon track to\b/gi, 'moving toward')
    .replace(/\bis expected to\b/gi, 'may')
    .replace(/\bexpected to\b/gi, 'may')
    .replace(/\bexpects to\b/gi, 'may')
    .replace(/\bis certain to\b/gi, 'may')
    .replace(/\bis destined to\b/gi, 'may')
    .replace(/\bdestined to\b/gi, 'may')
    .replace(/\bwithout doubt\b/gi, 'possibly')
    .replace(/\bwill\b/gi, 'could')
    .replace(/\bshall\b/gi, 'could')
    .replace(/\bcertainly\b/gi, 'possibly')
    .replace(/\bdefinitely\b/gi, 'possibly')
    .replace(/\binevitably\b/gi, 'possibly')
    .replace(/\binevitable\b/gi, 'possible')
    .replace(/\bguarantees\b/gi, 'suggests')
    .replace(/\bguaranteed\b/gi, 'suggested')
    .replace(/\bguarantee\b/gi, 'suggestion')
    .replace(/\bproven\b/gi, 'recorded')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!/^if\b/i.test(t) && !/^on the current\b/i.test(t)) {
    t = 'On the current record, ' + t.charAt(0).toLowerCase() + t.slice(1);
  }
  return t;
}

/** The sentence every projection panel carries. Never varied, so it is never argued with. */
export const PROJECTION_DISCLAIMER =
  'This is a possible direction worked out from records, not a prediction and not a plan. '
  + 'Nothing here has happened. It is not evidence about this person, it decides nothing, and it '
  + 'must not be used on its own to support any decision about their employment.';

/** The sentence the foundational layer carries wherever it appears. */
export const FOUNDATIONAL_DISCLAIMER =
  'Cycle readings describe timing and cadence, not ability, character or worth. They are not a '
  + 'scientific finding, they carry no decision weight, and demonstrated work always outranks them.';

// =================================================================================================
// WINDOWS
// =================================================================================================

export interface Window {
  /** ISO date, inclusive. */
  fromDay: string;
  /** ISO date, inclusive. */
  toDay: string;
  days: number;
}

const DAY_MS = 86400000;

export function toDay(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function daysBetween(fromDay: string, toDayStr: string): number {
  const a = new Date(fromDay + 'T00:00:00Z').getTime();
  const b = new Date(toDayStr + 'T00:00:00Z').getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

export function shiftDays(day: string, delta: number): string {
  const t = new Date(day + 'T00:00:00Z').getTime();
  return new Date(t + delta * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The lookback window for a horizon, anchored on a caller-supplied "today".
 *
 * `today` is a parameter and not Date.now() so that every window in a reading is anchored on the
 * SAME instant. A composer that called now() per horizon would produce a reading whose panels
 * disagree about what day it is, which is the kind of defect that only shows up at midnight.
 *
 * `recordStartDay` bounds the open-ended horizons: a five-year lookback on somebody who joined
 * eight months ago is eight months, and saying so is what makes the coverage arithmetic honest.
 */
export function lookbackWindow(h: Horizon, today: string, recordStartDay: string | null): Window {
  const spec = HORIZON_SPECS[h];
  let fromDay: string;
  if (spec.lookbackDays === null) {
    fromDay = recordStartDay || shiftDays(today, -365);
  } else {
    fromDay = shiftDays(today, -spec.lookbackDays);
    if (recordStartDay && recordStartDay > fromDay) fromDay = recordStartDay;
  }
  if (fromDay > today) fromDay = today;
  return { fromDay, toDay: today, days: Math.max(0, daysBetween(fromDay, today)) };
}

export function forwardWindow(h: Horizon, today: string): Window {
  const spec = HORIZON_SPECS[h];
  const to = shiftDays(today, spec.forwardDays);
  return { fromDay: today, toDay: to, days: spec.forwardDays };
}

// =================================================================================================
// CONFIDENCE
// =================================================================================================

export interface EvidenceShape {
  /** How many distinct evidence rows fed this reading. */
  rowCount: number;
  /** How many DISTINCT source tables fed it. One source is a thin reading however many rows it has. */
  sourceCount: number;
  /** Days between the oldest and newest evidence row. */
  spanDays: number;
  /** Days since the newest evidence row. */
  staleDays: number;
  /** Rows that a named human verified, per the evidence graph. */
  verifiedRowCount: number;
}

export const EMPTY_SHAPE: EvidenceShape = Object.freeze({
  rowCount: 0,
  sourceCount: 0,
  spanDays: 0,
  staleDays: 0,
  verifiedRowCount: 0,
});

export interface ConfidenceBreakdown {
  value: number;
  ceiling: number;
  /** Every term, so a screen can show WHY the number is what it is rather than just the number. */
  terms: { name: string; value: number; because: string }[];
  /** Set when the evidence spans less of the horizon than the reading claims to describe. */
  underspanned: boolean;
  sentence: string;
}

function clamp01(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Rounded to two places so a screen never prints sixteen digits of false precision. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * THE CONFIDENCE ARITHMETIC.
 *
 * Five terms, multiplied, then capped. Multiplication rather than a weighted average is the whole
 * design: an average lets a rich, diverse, verified body of evidence disguise the fact that it all
 * comes from last month. A product cannot. If span coverage is 0.04, nothing rescues it.
 */
export function confidenceFor(h: Horizon, shape: EvidenceShape): ConfidenceBreakdown {
  const spec = HORIZON_SPECS[h];
  const terms: { name: string; value: number; because: string }[] = [];

  // How much of what this horizon talks about is actually covered by evidence. For a forward-looking
  // horizon the honest denominator is the FORWARD span: a five-year reading is a claim about five
  // years, so five years is what the record is measured against.
  const horizonDays = Math.max(spec.forwardDays, spec.lookbackDays || 0);
  const coverage = horizonDays > 0 ? clamp01(shape.spanDays / horizonDays) : 0;
  // NO FLOOR. There was one — Math.max(0.05, coverage) — and it was doing exactly the harm this term
  // exists to prevent: at a twenty-year horizon a real coverage of 0.03 was being lifted to 0.05, so
  // the case that most needs to collapse was the one being propped up. Linear and unfloored means a
  // record covering three per cent of the question earns three per cent of the confidence, which is
  // both honest and explainable to the person it is about.
  const spanTerm = coverage;
  terms.push({
    name: 'span coverage',
    value: round2(spanTerm),
    because:
      shape.spanDays + ' days of record against a ' + horizonDays + '-day horizon'
      + (coverage < 0.5 ? '. The record is shorter than the question.' : '.'),
  });

  const volumeTerm = clamp01(Math.log10(1 + Math.max(0, shape.rowCount)) / 2);
  terms.push({
    name: 'volume',
    value: round2(volumeTerm),
    because: shape.rowCount + ' evidence rows. Saturates near a hundred; more than that adds little.',
  });

  const diversityTerm = clamp01(Math.max(0, shape.sourceCount) / 4);
  terms.push({
    name: 'source diversity',
    value: round2(diversityTerm),
    because:
      shape.sourceCount + ' distinct sources. One source is one point of view however many rows it holds.',
  });

  const recencyTerm = clamp01(1 - Math.max(0, shape.staleDays) / 180);
  terms.push({
    name: 'recency',
    value: round2(recencyTerm),
    because:
      shape.staleDays + ' days since the newest record. Reaches zero at six months of silence.',
  });

  const verifiedRatio = shape.rowCount > 0 ? shape.verifiedRowCount / shape.rowCount : 0;
  const verificationTerm = 0.6 + 0.4 * clamp01(verifiedRatio);
  terms.push({
    name: 'human verification',
    value: round2(verificationTerm),
    because:
      shape.verifiedRowCount + ' of ' + shape.rowCount
      + ' rows carry a named human verdict. Unverified evidence still counts, at a discount.',
  });

  const raw = spanTerm * volumeTerm * diversityTerm * recencyTerm * verificationTerm;
  const value = round2(Math.min(raw, spec.confidenceCeiling));
  const underspanned = coverage < 0.5;

  let sentence: string;
  if (shape.rowCount === 0) {
    sentence =
      'There is no evidence behind this horizon, so there is no confidence in it. '
      + 'An empty reading is not a neutral one.';
  } else if (value >= spec.confidenceCeiling) {
    sentence =
      'Held at the ceiling for this horizon (' + spec.confidenceCeiling
      + '). More evidence cannot raise it, because the limit here is the length of the claim, not the size of the record.';
  } else if (underspanned) {
    sentence =
      'The record spans ' + shape.spanDays + ' days and this horizon asks about ' + horizonDays
      + '. Read the projection as a direction only.';
  } else {
    sentence = 'Worked out from ' + shape.rowCount + ' rows across ' + shape.sourceCount + ' sources.';
  }

  return { value, ceiling: spec.confidenceCeiling, terms, underspanned, sentence };
}

/** Plain-language band. Screens print this beside the number so it is not read as a percentage score. */
export function confidenceBand(v: number): 'none' | 'low' | 'moderate' | 'reasonable' {
  if (v <= 0) return 'none';
  if (v < 0.2) return 'low';
  if (v < 0.5) return 'moderate';
  return 'reasonable';
}

export const CONFIDENCE_BAND_LABELS: Record<'none' | 'low' | 'moderate' | 'reasonable', string> = {
  none: 'No basis',
  low: 'Weak basis',
  moderate: 'Partial basis',
  reasonable: 'Reasonable basis',
};
