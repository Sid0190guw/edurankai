// src/lib/foundational/vocabulary.ts — THE ONE FILE THAT KNOWS THE FRAMEWORK'S OWN WORDS.
//
// =================================================================================================
// WHY THE VOCABULARY IS ISOLATED IN A FILE OF ITS OWN
// =================================================================================================
//
// The computation this engine performs comes from a traditional knowledge framework, and that
// framework has names for everything it touches. Those names may not reach an applicant, an
// employee, an ordinary HR user or a public page — not because they are shameful, but because a
// personnel system that renders them has quietly told the reader what to conclude, and concluding is
// not this layer's job. So the whole vocabulary lives here, exported behind ONE function, and every
// other module in this engine speaks only in structural codes.
//
//   B01..B09   computed points
//   S01..S12   sectors of the circle
//   G01..G27   segments of the circle
//   H01..H12   houses, counted from the ascending sector
//
// If you are reading this file to find out what a code "means", the honest answer is that it means a
// position. The traditional name below is a label for the same position, not an additional fact
// about the person.
//
// =================================================================================================
// WHAT THIS FILE IS NOT ALLOWED TO CONTAIN
// =================================================================================================
//
// No trait words. No aptitudes. No temperaments. No "good for", no "weak in". Every string here is
// either a NAME of a structure or a NAME of a rule. The instant a description of a person appears in
// this file, the interpretation layer has been built in the wrong patch, and neutrality.test.ts is
// written to catch exactly that.
//
// NOTHING HERE IS A SCIENTIFIC CLAIM. These are the names a traditional framework uses for its own
// constructs. The engine computes them because the product requires the framework's factors as an
// input to a human-reviewed process; computing a construct is not asserting that it predicts
// anything, and no surface built on this engine may say otherwise.
import type { TechnicalDetail, ViewerContext } from './types';
import { maySeeTechnical } from './types';

// -------------------------------------------------------------------------------------------------
// NEUTRAL STRUCTURAL CODES. These are the public identifiers. Everything else in this file is gated.
// -------------------------------------------------------------------------------------------------

/** The nine computed points, in the fixed order their codes encode. */
export const POINT_CODES = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09'] as const;
export type PointCode = (typeof POINT_CODES)[number];

/** The seven points that have a physical body and therefore a real dignity and combustion state. */
export const BODY_POINTS: readonly PointCode[] = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07'];

/** The two computed points that are intersections rather than bodies. */
export const NODE_POINTS: readonly PointCode[] = ['B08', 'B09'];

export const sectorCode = (n: number): string => 'S' + String(n).padStart(2, '0');
export const segmentCode = (n: number): string => 'G' + String(n).padStart(2, '0');
export const houseCode = (n: number): string => 'H' + String(n).padStart(2, '0');

/** Structural labels. Deliberately dull: they describe geometry and nothing else. */
export const POINT_LABELS: Record<PointCode, string> = {
  B01: 'Point B01',
  B02: 'Point B02',
  B03: 'Point B03',
  B04: 'Point B04',
  B05: 'Point B05',
  B06: 'Point B06',
  B07: 'Point B07',
  B08: 'Point B08 (computed intersection)',
  B09: 'Point B09 (computed intersection)',
};

// -------------------------------------------------------------------------------------------------
// THE GATED LAYER. Everything below is reachable only through technicalDetail() / technicalTermFor(),
// both of which require a viewer holding FOUNDATIONAL_CAPABILITIES.technical.
// -------------------------------------------------------------------------------------------------

const POINT_TERMS: Record<string, string> = {
  B01: 'Surya', B02: 'Chandra', B03: 'Mangala', B04: 'Budha', B05: 'Guru',
  B06: 'Shukra', B07: 'Shani', B08: 'Rahu', B09: 'Ketu',
};

const POINT_ASTRONOMY: Record<string, string> = {
  B01: 'Sun', B02: 'Moon', B03: 'Mars', B04: 'Mercury', B05: 'Jupiter',
  B06: 'Venus', B07: 'Saturn', B08: 'Mean lunar ascending node', B09: 'Mean lunar descending node',
};

const SECTOR_TERMS: string[] = [
  'Mesha', 'Vrishabha', 'Mithuna', 'Karka', 'Simha', 'Kanya',
  'Tula', 'Vrischika', 'Dhanu', 'Makara', 'Kumbha', 'Meena',
];

const SEGMENT_TERMS: string[] = [
  'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha',
  'Magha', 'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha',
  'Mula', 'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta', 'Shatabhisha',
  'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati',
];

const HOUSE_TERMS: string[] = [
  'Lagna bhava', 'Dhana bhava', 'Sahaja bhava', 'Sukha bhava', 'Putra bhava', 'Ari bhava',
  'Yuvati bhava', 'Randhra bhava', 'Dharma bhava', 'Karma bhava', 'Labha bhava', 'Vyaya bhava',
];

const RULE_TERMS: Record<string, string> = {
  'indicator.point.sector': 'Rashi sthiti',
  'indicator.point.segment': 'Nakshatra sthiti',
  'indicator.point.house': 'Bhava sthiti',
  'indicator.ascendant': 'Lagna',
  'indicator.midheaven': 'Madhya lagna',
  'relationship.colocation': 'Yuti',
  'relationship.aspect': 'Drishti',
  'relationship.aspect.special': 'Vishesha drishti',
  'relationship.dispositor': 'Rashi swami',
  'relationship.house_ruler': 'Bhava swami',
  'relationship.proximity_to_b01': 'Astangata',
  'strength.point': 'Bala',
  'strength.component.dignity': 'Sthana bala',
  'strength.component.angularity': 'Kendra bala',
  'strength.component.directional': 'Dig bala',
  'strength.component.motion': 'Chesta bala',
  'strength.component.proximity': 'Astangata hani',
  'cycle.level1': 'Mahadasha',
  'cycle.level2': 'Antardasha',
  'cycle.level3': 'Pratyantardasha',
  'cycle.system': 'Vimshottari',
};

/**
 * Build the gated technical block for a factor.
 *
 * Returns `null` — not a partial block, not a placeholder — when the viewer may not see it. A caller
 * that forgets to check therefore ships no vocabulary rather than some of it.
 */
export function technicalDetail(
  viewer: ViewerContext | null | undefined,
  args: { term: string; relatedTerms?: string[]; rule?: string; detail?: Record<string, unknown> },
): TechnicalDetail | null {
  if (!maySeeTechnical(viewer)) return null;
  return {
    term: args.term,
    ...(args.relatedTerms ? { relatedTerms: args.relatedTerms } : {}),
    ...(args.rule ? { rule: args.rule } : {}),
    ...(args.detail ? { detail: args.detail } : {}),
  };
}

/**
 * The same thing for the engine's INTERNAL use: it builds every factor with its technical block
 * populated, stores it in a gated column, and the projection strips it per reader. This function is
 * how the block is built at computation time, when there is no viewer yet.
 *
 * It is exported because engine.ts needs it. It is NOT a read path — nothing renders its output
 * without going through projectFactor().
 */
export function buildTechnical(args: {
  term: string;
  relatedTerms?: string[];
  rule?: string;
  detail?: Record<string, unknown>;
}): TechnicalDetail {
  return {
    term: args.term,
    ...(args.relatedTerms ? { relatedTerms: args.relatedTerms } : {}),
    ...(args.rule ? { rule: args.rule } : {}),
    ...(args.detail ? { detail: args.detail } : {}),
  };
}

export function pointTerm(code: string): string {
  return POINT_TERMS[code] || code;
}

export function pointAstronomyName(code: string): string {
  return POINT_ASTRONOMY[code] || code;
}

export function sectorTerm(n: number): string {
  return SECTOR_TERMS[n - 1] || sectorCode(n);
}

export function segmentTerm(n: number): string {
  return SEGMENT_TERMS[n - 1] || segmentCode(n);
}

export function houseTerm(n: number): string {
  return HOUSE_TERMS[n - 1] || houseCode(n);
}

export function ruleTerm(code: string): string {
  return RULE_TERMS[code] || code;
}

/**
 * Every gated string in this module, flattened. Exists so neutrality.test.ts can assert that NONE of
 * them appears in a neutral projection — a guarantee that is worth having only if it is checked
 * against the real list rather than a copy of it that will rot.
 */
export function allTechnicalTerms(): string[] {
  return [
    ...Object.values(POINT_TERMS),
    ...SECTOR_TERMS,
    ...SEGMENT_TERMS,
    ...HOUSE_TERMS,
    ...Object.values(RULE_TERMS),
  ];
}
