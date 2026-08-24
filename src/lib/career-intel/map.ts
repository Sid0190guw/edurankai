// src/lib/career-intel/map.ts — THE CAREER MAP.
//
// =================================================================================================
// A MAP, NOT A VISUALISATION
// =================================================================================================
//
// After enough exploration a person should be able to see the shape of what they have said: which
// directions they keep coming back to, which are only half-formed, and which nearby ones they have
// not mentioned at all. That is genuinely useful. A rotating three-dimensional force graph is not,
// and the brief says so outright — lightweight, accessible, keyboard navigable, understandable
// without animation.
//
// So this module returns a LIST OF NODES with a band, a strength and a real destination. The surface
// lays it out however it likes; the same data reads perfectly well as a plain list, which is what a
// screen reader gets and what everybody gets under reduced motion.
//
// PURE. No database. It is computed from the profile alone and returned alongside the matches, so
// showing the map costs no extra query — the alternative, one COUNT per domain, is nineteen round
// trips to draw a diagram.
//
// =================================================================================================
// WHERE "ADJACENT" COMES FROM, AND WHY IT IS NOT A GUESS ABOUT THE PERSON
// =================================================================================================
//
// Each domain in the ontology declares the dimensions it tends to come with — mathematics leans on
// abstraction and analysis, prototyping on implementation and creativity. An adjacent node is a
// domain the person has NOT named whose leanings overlap what they said about how they like to
// think. That is a statement about the DOMAINS, not a claim about the person: "you said you like
// reasoning things through, and this is another field where that is most of the job".
//
// It reads the same two dimension groups the ranker may read, through the same door, so the map
// cannot become the back way in for the exploration-only layers.

import { INTEREST_DOMAINS, DOMAIN_BY_KEY, type InterestDomain } from './ontology';
import { relevanceDimensions, type CareerProfile } from './dimensions';

export type MapBand = 'strong' | 'emerging' | 'adjacent';

export interface MapNode {
  key: string;
  label: string;
  blurb: string;
  band: MapBand;
  /** 0..1. Drives size or weight in a visual layout; never shown as a number. */
  strength: number;
  /** Why this node is on the map, in one line. Every node has one — none is decoration. */
  because: string;
  /** A real filtered query. Works with no script at all. */
  href: string;
  /** Present when the domain is a filterable column rather than a text search. */
  skillCategory: string | null;
}

export interface CareerMap {
  nodes: MapNode[];
  /** False when the person has not said enough for a map to mean anything. The surface says so. */
  meaningful: boolean;
  /** Rendered above the map. States what it is and, more importantly, what it is not. */
  caption: string;
}

export const MAP_CAPTION =
  'A picture of what you have told us so far, not an assessment of you. '
  + 'Everything on it is somewhere you can go and look.';

const NOT_ENOUGH =
  'Tell us a little more and a map of where you have been looking appears here.';

function hrefFor(d: InterestDomain): string {
  return d.skillCategory
    ? '/careers/opportunities?skillcat=' + encodeURIComponent(d.skillCategory)
    : '/careers/opportunities?q=' + encodeURIComponent(d.label);
}

/**
 * How well a domain's leanings match what the person said about how they like to think and work.
 *
 * A plain overlap rather than a cosine: the values are already 0..1 preference strengths, both
 * sides are short, and a similarity metric that nobody can reproduce by hand is a bad basis for a
 * sentence that begins "because you told us".
 */
function leanOverlap(domain: InterestDomain, dims: Record<string, { value: number; confidence: number }>): { score: number; strongest: string | null } {
  const leans = domain.leans || {};
  const keys = Object.keys(leans);
  if (!keys.length) return { score: 0, strongest: null };
  let total = 0;
  let best = 0;
  let strongest: string | null = null;
  for (const k of keys) {
    const sig = dims[k];
    if (!sig) continue;
    const contribution = leans[k] * sig.value * sig.confidence;
    total += contribution;
    if (contribution > best) { best = contribution; strongest = k; }
  }
  return { score: total / keys.length, strongest };
}

const BECAUSE: Record<string, string> = {
  abstraction: 'you are comfortable with ideas before they are concrete',
  analytical: 'you like reasoning a problem through',
  experimental: 'you would rather try something and see',
  implementation: 'you want to build the working thing',
  systems_thinking: 'you like seeing how the parts fit together',
  research_orientation: 'you are drawn to unanswered questions',
  creativity: 'you like making things that did not exist before',
  ambiguity_tolerance: 'you are comfortable when the answer is not known yet',
  deep_focus: 'you prefer quiet, uninterrupted stretches',
  collaboration: 'you think best with other people in the room',
  social_energy: 'you draw energy from people',
  goal_clarity: 'clear objectives matter to you',
  autonomy: 'you want freedom in how you work',
  pace: 'you like work that moves quickly',
  structure: 'you work well with clear structure',
  flexibility: 'you want room to change your approach',
  routine: 'you like knowing what your day looks like',
  detail_orientation: 'you notice the small thing that is wrong',
};

/** How many nodes of each band. Small on purpose: a map with thirty nodes is a list. */
const LIMITS = { strong: 4, emerging: 3, adjacent: 4 };

/** The confidence above which a named interest counts as somewhere the person keeps returning to. */
const STRONG_AT = 0.75;

/** The overlap below which an adjacent domain is not worth putting on a map. */
const ADJACENT_AT = 0.2;

export function buildCareerMap(profile: CareerProfile): CareerMap {
  const interests = (profile.interests || []).filter((t) => t.confirmation !== 'rejected');
  const avoided = new Set((profile.avoid || []).filter((t) => t.confirmation !== 'rejected').map((t) => t.key));
  const named = new Set(interests.map((t) => t.key));
  const dims = relevanceDimensions(profile); // THE SAME DOOR THE RANKER USES.

  const nodes: MapNode[] = [];

  // ---- what they named ----
  const sorted = interests.slice().sort((a, b) => b.confidence - a.confidence);
  let strongCount = 0;
  let emergingCount = 0;
  for (const tag of sorted) {
    const d = DOMAIN_BY_KEY[tag.key];
    const label = d ? d.label : tag.label;
    const blurb = d ? d.blurb : 'Something you named yourself.';
    const isStrong = tag.confidence >= STRONG_AT || tag.confirmation === 'confirmed';
    if (isStrong && strongCount >= LIMITS.strong) continue;
    if (!isStrong && emergingCount >= LIMITS.emerging) continue;
    if (isStrong) strongCount++; else emergingCount++;
    nodes.push({
      key: tag.key,
      label,
      blurb,
      band: isStrong ? 'strong' : 'emerging',
      strength: tag.confidence,
      because: isStrong ? 'You have come back to this.' : 'You mentioned this once.',
      href: d ? hrefFor(d) : '/careers/opportunities?q=' + encodeURIComponent(tag.label),
      skillCategory: d?.skillCategory || null,
    });
  }

  // ---- what they have not named, but keep describing ----
  const candidates = INTEREST_DOMAINS
    .filter((d) => !named.has(d.key) && !avoided.has(d.key))
    .map((d) => ({ d, ...leanOverlap(d, dims) }))
    .filter((x) => x.score >= ADJACENT_AT)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMITS.adjacent);

  for (const c of candidates) {
    const reason = c.strongest && BECAUSE[c.strongest]
      ? 'You have not mentioned this, but ' + BECAUSE[c.strongest] + '.'
      : 'Close to what you described.';
    nodes.push({
      key: c.d.key,
      label: c.d.label,
      blurb: c.d.blurb,
      band: 'adjacent',
      strength: Math.min(1, c.score),
      because: reason,
      href: hrefFor(c.d),
      skillCategory: c.d.skillCategory || null,
    });
  }

  // A map of one node is not a map, it is the thing you already knew.
  const meaningful = nodes.filter((n) => n.band !== 'adjacent').length >= 2;

  return { nodes, meaningful, caption: meaningful ? MAP_CAPTION : NOT_ENOUGH };
}

/** The bands in reading order, with the heading each gets. Used by the surface, kept beside the data. */
export const MAP_BANDS: { key: MapBand; label: string; note: string }[] = [
  { key: 'strong', label: 'Where you keep looking', note: 'The directions you have come back to.' },
  { key: 'emerging', label: 'Mentioned once', note: 'Said in passing. Tell us more, or remove them.' },
  { key: 'adjacent', label: 'You may not have considered', note: 'Fields where what you described is most of the work. Not a suggestion about you — a fact about them.' },
];
