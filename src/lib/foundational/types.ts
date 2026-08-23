// src/lib/foundational/types.ts — THE OWNED CONTRACT of the Foundational Personal Computation
// engine (HORIZON patch 02). Extend it additively; never edit a shape another patch already reads.
//
// =================================================================================================
// WHAT THIS ENGINE IS, AND THE ONE LINE IT MAY NOT CROSS
// =================================================================================================
//
// This module computes STRUCTURED, VERSIONED FACTORS from a person's birth co-ordinates in time and
// space. It computes. It does not conclude. There is no `recommendation`, no `fit`, no `risk`, no
// `score_for_role` anywhere in this file, and none may be added — a factor is an arithmetic result
// with its inputs attached, and the moment it acquires an opinion about a person's employment it has
// become the interpretation layer, which is a different patch with different rules.
//
//   COMPUTATION LAYER (here)     positions, relationships, strengths, cycle periods. Neutral codes.
//   INTERPRETATION LAYER (not)   what any of it might mean professionally. Separate. Human-reviewed.
//
// =================================================================================================
// NEUTRAL CODES ARE THE DEFAULT PROJECTION, AND THAT IS A HARD RULE
// =================================================================================================
//
// Every factor carries a STRUCTURAL identity — B01..B09 for computed points, S01..S12 for sectors,
// G01..G27 for segments, H01..H12 for houses — and nothing else. The traditional vocabulary that
// names those structures lives in ONE file, vocabulary.ts, reachable only through a capability the
// ordinary reader does not hold. This is not decoration:
//
//   * an ordinary HR, employee or applicant-facing surface must never render the technical framework
//     these codes stand for;
//   * the underlying traditional computation must stay separable from any professional
//     interpretation built on top of it;
//   * a role without explicit permission must not see internal computation detail.
//
// A structural code satisfies all three without inventing meaning. `S04` is a sector index. It is
// not a claim about anybody, and neutrality.test.ts fails the build if a technical term or a
// decision word ever reaches the default projection.
//
// =================================================================================================
// REPRODUCIBILITY IS A PROPERTY OF THIS FILE, NOT A HOPE
// =================================================================================================
//
// Same input + same calculation_method_version => same factors, forever. Three mechanics enforce it:
//
//  1. VERSIONED METHOD. CALCULATION_METHOD_VERSION changes whenever any number that feeds a result
//     changes — a weight, an orb, a series term, a year length. Old computations keep their own
//     version string and are re-derivable by asking for it.
//  2. FIXED PRECISION. Math.sin and friends are implementation-defined in ECMAScript; two engines
//     may differ in the last bits. So every published angle is rounded to ANGLE_DP decimals and
//     every published strength to UNIT_DP before it is stored or hashed. Reproducibility is claimed
//     to that precision and to no more.
//  3. NO AMBIENT TIME. Nothing in the pure layers reads the clock. `computed_at` is stamped once, by
//     the caller of the engine, and is excluded from the output hash — a re-run at a different
//     instant must produce the same hash or something is wrong.
import { createHash } from 'node:crypto';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** Table prefix owned by this patch. Nothing outside src/lib/foundational may create an fpc_ table. */
export const TABLE_PREFIX = 'fpc_';

/**
 * THE VERSION. Bump on any change to a published number: a series term, an orb, a weight, a rounding
 * rule, a year length. Never bump for a comment, a type, or a query.
 *
 *   1.0.0 — initial engine. Meeus solar/lunar series, JPL approximate planetary elements,
 *           precession-defined ayanamsa, whole-sector houses, 120-unit cycle system.
 */
export const CALCULATION_METHOD_VERSION = 'fpc-1.0.0';

/** Decimals every published angle is rounded to before storage or hashing. ~4 milliarcseconds. */
export const ANGLE_DP = 6;

/** Decimals every published unit-interval quantity (strength, confidence) is rounded to. */
export const UNIT_DP = 4;

/** The event other patches subscribe to. A constant, so a rename cannot silently unsubscribe them. */
export const INTELLIGENCE_EVENTS = {
  computationCompleted: 'intelligence.computation_completed',
} as const;

/**
 * Capabilities this engine enforces at its own boundary.
 *
 * Declared HERE and checked HERE rather than added to the shared permission registry, because that
 * registry belongs to another patch and this one must not edit it. A host application that has a
 * registry should map these strings into it; until it does, the engine still refuses.
 */
export const FOUNDATIONAL_CAPABILITIES = {
  /** Read a computation in its neutral projection. */
  read: 'intelligence.foundational.read',
  /** See the technical layer: traditional vocabulary and raw computed positions. */
  technical: 'intelligence.foundational.technical',
  /** Run or re-run a computation. */
  compute: 'intelligence.foundational.compute',
  /** Store, correct or erase the birth input itself. The most sensitive of the four. */
  manageInput: 'intelligence.foundational.input.manage',
} as const;

/** The single purpose this engine's data may be collected and used for. Purpose limitation. */
export const CONSENT_PURPOSE = 'foundational_personal_computation';

/**
 * Words that may never appear in a factor code, label or value. A computation that has learned to
 * say "recommended" has stopped being a computation.
 */
export const DECISION_WORDS: readonly string[] = [
  'hire', 'hiring', 'reject', 'rejection', 'promote', 'promotion', 'terminate', 'termination',
  'fired', 'discipline', 'disciplinary', 'suitable', 'unsuitable', 'unfit', 'fit for',
  'recommend', 'shortlist', 'score for', 'ranking',
];

// =================================================================================================
// INPUT
// =================================================================================================

/** A place on the Earth. Normalised by the caller; this engine does not geocode. */
export interface GeoPoint {
  /** Degrees north, -90..90. */
  latitude: number;
  /** Degrees east, -180..180. West is negative. */
  longitude: number;
  /** Metres above mean sea level. Optional; unused by v1 and stored for later refinement. */
  altitudeM?: number | null;
  /** Free label for the operator. Never a decision variable. */
  placeLabel?: string | null;
}

/**
 * What a caller supplies. Time is a WALL CLOCK reading plus the information needed to place it on
 * the UTC timeline — never a Date, because a Date has already lost the distinction.
 */
export interface BirthInput {
  /** Local calendar date at the birth place, 'YYYY-MM-DD'. Proleptic Gregorian. */
  date: string;
  /** Local wall-clock time at the birth place, 'HH:MM' or 'HH:MM:SS'. */
  time: string;
  /**
   * Minutes east of UTC at that instant. AUTHORITATIVE when present: an offset cannot drift when a
   * time zone database is updated, and a stored computation must stay reproducible.
   */
  utcOffsetMinutes?: number | null;
  /**
   * IANA zone, resolved to an offset at normalisation time and then stored as that offset. Supplying
   * this is a convenience; what is kept is what it resolved to.
   */
  timeZone?: string | null;
  location: GeoPoint;
  /**
   * How exact the time is. A birth time known to the hour is a different measurement from one known
   * to the minute, and every derived confidence says so rather than pretending otherwise.
   */
  timePrecision?: TimePrecision;
}

export const TIME_PRECISIONS = ['second', 'minute', 'five_minute', 'quarter_hour', 'hour', 'unknown'] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

/** Uncertainty in the recorded instant, in minutes, by declared precision. */
export const TIME_PRECISION_MINUTES: Record<TimePrecision, number> = {
  second: 0.5,
  minute: 1,
  five_minute: 5,
  quarter_hour: 15,
  hour: 60,
  unknown: 720,
};

/** The input after normalisation: a single UTC instant, a fixed offset, and a clean location. */
export interface NormalizedBirthInput {
  /** ISO-8601 UTC instant, truncated to whole seconds. */
  utcInstant: string;
  /** Julian Day in UT, the number every downstream calculation actually consumes. */
  julianDayUT: number;
  /** The offset actually used, in minutes east of UTC. Resolved once, then authoritative. */
  utcOffsetMinutes: number;
  /** Echo of what the caller supplied, for audit and for re-normalisation under a later version. */
  localDate: string;
  localTime: string;
  timeZone: string | null;
  location: { latitude: number; longitude: number; altitudeM: number | null; placeLabel: string | null };
  timePrecision: TimePrecision;
}

// =================================================================================================
// OUTPUT
// =================================================================================================

/**
 * The four things this engine produces. A fifth would be an interpretation, and there is no fifth.
 */
export const FACTOR_CATEGORIES = [
  'foundational_indicator',  // where a computed point sits: sector, segment, house, degree
  'factor_relationship',     // how two computed points stand to each other
  'strength',                // a composite magnitude, with its components published
  'time_cycle',              // a bounded period on the timeline
] as const;
export type FactorCategory = (typeof FACTOR_CATEGORIES)[number];

/**
 * A pointer at something this factor was computed FROM. Never prose: a reference another reader can
 * follow to the same number and get the same answer.
 */
export interface FactorEvidence {
  /** Dotted path into the computation's own raw block, e.g. 'raw.points.B02.siderealLongitude'. */
  ref: string;
  /** What sort of thing is at that path. */
  kind: 'input' | 'computed_position' | 'derived_quantity' | 'method_constant';
  /** The value at the time of computation, already rounded to published precision. */
  value: number | string;
}

/**
 * The technical layer. Traditional vocabulary and framework structure. Present ONLY for a viewer
 * holding FOUNDATIONAL_CAPABILITIES.technical; `null` in every other projection.
 */
export interface TechnicalDetail {
  /** Traditional name of the structure this factor is about. */
  term: string;
  /** Traditional names of the structures it relates to, where the factor is a relationship. */
  relatedTerms?: string[];
  /** The rule applied, named in the framework's own language. */
  rule?: string;
  /** Anything else the framework records. Free-form, never rendered outside a permitted surface. */
  detail?: Record<string, unknown>;
}

/**
 * ONE FACTOR. The shape the brief specifies, plus the three fields that make it answerable:
 * `evidence` (what it was computed from), `confidence` (how exact the inputs were), and
 * `technical` (the gated framework layer).
 *
 * INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP, in one row.
 */
export interface FoundationalFactor {
  /** Deterministic within a computation: same inputs and version produce the same id. */
  factor_id: string;
  category: FactorCategory;
  /** Neutral machine code, e.g. 'indicator.point.sector'. Never framework vocabulary. */
  code: string;
  /** Neutral human label. Structural, not interpretive. */
  label: string;
  /** Neutral rendering of the result, e.g. 'B02 in S04' or 'H10'. */
  value: string;
  /** The same result as a number where one exists, e.g. a degree within a sector. */
  numeric_value: number | null;
  /** 0..1. A magnitude, never a verdict. */
  strength: number;
  /** 0..1. How exact the inputs were — NOT how much anybody believes the factor. */
  confidence: number;
  calculation_method_version: string;
  /** Names of the raw input fields that reached this factor. */
  source_inputs: string[];
  evidence: FactorEvidence[];
  /** Published components of a composite, so a strength is never an opaque number. */
  components?: Record<string, number>;
  technical: TechnicalDetail | null;
  computed_at: string;
}

/** A bounded period on the timeline. Level 1 is the longest; each level subdivides its parent. */
export interface CyclePeriod {
  period_id: string;
  level: 1 | 2 | 3;
  /** Neutral code of the point that governs this period, B01..B09. */
  ruler_code: string;
  /** Chain of governing codes from level 1 down to this one, e.g. ['B06','B01','B03']. */
  chain: string[];
  starts_at: string;
  ends_at: string;
  /** Length in days, to the published precision. */
  length_days: number;
  calculation_method_version: string;
  technical: TechnicalDetail | null;
}

/** The answer getTimePeriodAnalysis() returns. Periods only; not a word about what they mean. */
export interface TimePeriodAnalysis {
  subject: SubjectRef;
  computation_id: string;
  calculation_method_version: string;
  /** The instant the analysis was taken at, supplied by the caller. */
  as_of: string;
  /** The period at each level containing `as_of`, with how far through it that instant sits. */
  current: Array<CyclePeriod & { fraction_elapsed: number }>;
  /** Periods beginning after `as_of` and before the window's end, in order. */
  upcoming: CyclePeriod[];
  /** Level-1 periods across the long horizon, including ones already past. */
  horizon: CyclePeriod[];
  window: { from: string; to: string; horizon_years: number };
}

/** Which subject a computation belongs to. Deliberately not a foreign key. */
export interface SubjectRef {
  /** Whose identity space the id lives in. This patch owns none of them. */
  kind: 'person' | 'employee' | 'candidate' | 'external';
  id: string;
}

export const SUBJECT_KINDS = ['person', 'employee', 'candidate', 'external'] as const;

export const COMPUTATION_REASONS = ['initial', 'recompute', 'input_corrected', 'method_upgrade'] as const;
export type ComputationReason = (typeof COMPUTATION_REASONS)[number];

/** The header row of one computation. Raw positions are gated with the same key as `technical`. */
export interface ComputationRecord {
  id: string;
  subject: SubjectRef;
  calculation_method_version: string;
  /** sha256 over the canonical normalised input. Two identical inputs share it. */
  input_hash: string;
  /** sha256 over the canonical factor and period set, EXCLUDING computed_at. */
  output_hash: string;
  reason: ComputationReason;
  computed_at: string;
  computed_by: string | null;
  factor_count: number;
  period_count: number;
  /** Raw computed positions. Gated: null unless the viewer holds `technical`. */
  raw: RawComputation | null;
  /** Method manifest as it was at computation time. Never gated — it is how a result is checked. */
  method: MethodManifest;
}

/** One computed point, before any factor is derived from it. */
export interface ComputedPoint {
  /** Neutral code, B01..B09. */
  code: string;
  /** Longitude in the sidereal frame, degrees 0..360. */
  siderealLongitude: number;
  /** Longitude in the equinox-of-date frame, degrees 0..360. */
  tropicalLongitude: number;
  /** Degrees per day; negative means apparent retrograde motion. */
  dailyMotion: number;
  /** Ecliptic latitude, degrees. Zero for the computed nodes. */
  latitude: number;
  /** Sector index 1..12 and the degree within it. */
  sector: number;
  degreeInSector: number;
  /** Segment index 1..27, its quarter 1..4, and the degree within the segment. */
  segment: number;
  segmentQuarter: number;
  degreeInSegment: number;
  /** Whole-sector house 1..12, relative to the ascending sector. */
  house: number;
  retrograde: boolean;
  /** Model error bound for this point, in degrees, at the published version. */
  uncertaintyDeg: number;
}

export interface RawComputation {
  normalizedInput: NormalizedBirthInput;
  /** Ayanamsa applied, degrees. */
  ayanamsaDeg: number;
  /** Mean obliquity of the ecliptic, degrees. */
  obliquityDeg: number;
  /** Local sidereal time, degrees. */
  localSiderealDeg: number;
  /** Sidereal ascendant and midheaven, degrees. */
  ascendantDeg: number;
  midheavenDeg: number;
  ascendantSector: number;
  points: Record<string, ComputedPoint>;
}

/** Everything a third party needs to reproduce a result. Returned by describeMethod(). */
export interface MethodManifest {
  engine: string;
  version: string;
  anglePrecisionDp: number;
  unitPrecisionDp: number;
  ayanamsaModel: string;
  ayanamsaAtJ2000Deg: number;
  houseModel: string;
  cycleYearDays: number;
  cycleTotalYears: number;
  strengthWeights: Record<string, number>;
  /** Stated, not implied: what this engine's numbers are worth. */
  accuracy: Record<string, string>;
  /** Where the model stops being valid at all. */
  validRange: { fromYear: number; toYear: number };
}

/** Who is asking. Every engine entry point takes one; none of them defaults to "allowed". */
export interface ViewerContext {
  userId: string | null;
  capabilities: readonly string[];
  /** For the audit row. */
  ipAddress?: string | null;
}

/** Uniform refusal shape. The engine returns these; it does not throw at its callers. */
export interface Refusal {
  ok: false;
  code:
    | 'not_permitted'
    | 'no_consent'
    | 'input_missing'
    | 'input_invalid'
    | 'input_unprotected'
    | 'not_found'
    | 'storage_failed';
  reason: string;
}

// =================================================================================================
// SMALL HELPERS — local on purpose. This module is the contract and must not gain a dependency on
// anything that could one day want to depend back on it.
// =================================================================================================

/** postgres-js hands back a PLAIN ARRAY. `r.rows[0]` has broken this project before. */
export function rowsOf(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/** The real Postgres reason lives on e.cause. e.message is only the failed SQL. */
export function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown reason');
}

/** Round to a fixed number of decimals, killing -0 so a hash cannot depend on a sign bit. */
export function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const f = Math.pow(10, dp);
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r;
}

export const roundAngle = (v: number): number => round(v, ANGLE_DP);
export const roundUnit = (v: number): number => round(Math.min(1, Math.max(0, v)), UNIT_DP);

/** Degrees into [0, 360). */
export function norm360(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** Signed separation in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/**
 * Canonical JSON: keys sorted at every depth, undefined dropped, numbers left exactly as given.
 * Callers round BEFORE hashing — this function will not silently change a value.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v === undefined ? null : v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Does this viewer hold every capability named? No capability list means no. */
export function hasCapabilities(viewer: ViewerContext | null | undefined, ...needed: string[]): boolean {
  const held = new Set(viewer?.capabilities || []);
  return needed.every((c) => held.has(c));
}

/** True when the viewer may see framework vocabulary and raw positions. */
export function maySeeTechnical(viewer: ViewerContext | null | undefined): boolean {
  return hasCapabilities(viewer, FOUNDATIONAL_CAPABILITIES.read, FOUNDATIONAL_CAPABILITIES.technical);
}

/**
 * Strip everything gated. The DEFAULT for every read path — a projection is opt-in to detail, never
 * opt-out, because the failure mode of the other order is a leak.
 */
export function projectFactor(f: FoundationalFactor, allowTechnical: boolean): FoundationalFactor {
  return allowTechnical ? f : { ...f, technical: null };
}

export function projectPeriod(p: CyclePeriod, allowTechnical: boolean): CyclePeriod {
  return allowTechnical ? p : { ...p, technical: null };
}

export function projectComputation(c: ComputationRecord, allowTechnical: boolean): ComputationRecord {
  return allowTechnical ? c : { ...c, raw: null };
}

/**
 * The guard that keeps this layer a computation layer. Returns the offending word, or null.
 * Applied to every factor the engine builds, and asserted over the whole vocabulary in tests.
 */
export function decisionWordIn(text: string): string | null {
  const t = text.toLowerCase();
  for (const w of DECISION_WORDS) if (t.includes(w)) return w;
  return null;
}
