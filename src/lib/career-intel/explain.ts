// src/lib/career-intel/explain.ts — "WHY THIS OPPORTUNITY?", ASSEMBLED FROM WHAT ACTUALLY RANKED IT.
//
// The one rule, and the reason this is a separate module rather than a template in a component:
//
//   EVERY SENTENCE HERE IS BUILT FROM A CONTRIBUTION THAT MOVED THE RANKING.
//
// There is no path in this file that produces a reason from anything else. It cannot reach the
// profile, it cannot reach the posting, and it cannot reach a model — its only argument is the
// MatchResult, whose contributions ARE the score. So a reason cannot appear without having counted,
// and a posting cannot rank without its reasons being sayable. When there is nothing to say, this
// returns an empty `aligned` list and a stated reason for the emptiness, which is the honest answer
// and the one the brief asks for in section 14: never pretend certainty where information is missing.
//
// The three headings are deliberately asymmetric in tone:
//
//   aligned            things that lined up. Stated plainly.
//   needMoreInfo       what we could not check. Ours to fix by asking, not the person's to fix.
//   couldDevelop       what the posting names and we have no evidence of. Framed as strengthening
//                      alignment, NEVER as a route to being hired.

import { TIER_BY_KEY, type Contribution, type MatchResult } from './rank';

export interface Explanation {
  /** The tier's own words. Shown as the heading of the group this posting sits in. */
  tierLabel: string;
  tierMeaning: string;
  /** One line, in the person's own terms, for the top of the card. Empty when nothing lined up. */
  headline: string;
  aligned: { signal: string; matched: string }[];
  needMoreInfo: string[];
  couldDevelop: string[];
  /** True when the posting ranked with no positive contribution at all. */
  nothingMatched: boolean;
  /** Present only when something was demoted, so a lower position is never silent. */
  demotedBecause: string[];
}

/** The order reasons are read in. Concrete before abstract: what you know beats how you think. */
const KIND_ORDER: Record<string, number> = {
  discipline: 0, skill: 1, domain: 2, approach: 3, stage: 4, avoid: 9,
};

export function explain(m: MatchResult): Explanation {
  const tier = TIER_BY_KEY[m.tier];
  const positive = m.contributions
    .filter((c) => c.weight > 0)
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (b.weight - a.weight));
  const negative = m.contributions.filter((c) => c.weight < 0);

  return {
    tierLabel: tier.label,
    tierMeaning: tier.meaning,
    headline: headlineFor(positive),
    aligned: positive.slice(0, 6).map((c) => ({ signal: c.signal, matched: c.matched })),
    needMoreInfo: m.unknowns.slice(0, 3),
    couldDevelop: m.gaps.slice(0, 5),
    nothingMatched: positive.length === 0,
    demotedBecause: negative.map((c) => c.signal + ' ' + c.matched),
  };
}

/**
 * The single line at the top of a personalised card.
 *
 * Built from the two strongest reasons and nothing else. When there is one reason it says one; when
 * there are none it says so rather than reaching for a generic sentence, because a generic sentence
 * on a personalised card is a fabricated reason wearing a friendly tone.
 */
function headlineFor(positive: Contribution[]): string {
  if (positive.length === 0) return '';
  const parts = positive.slice(0, 2).map((c) => c.signal.replace(/\.$/, ''));
  if (parts.length === 1) return 'Because you told us: ' + lowerFirst(parts[0]) + '.';
  return 'Because you told us: ' + lowerFirst(parts[0]) + ', and ' + lowerFirst(parts[1]) + '.';
}

function lowerFirst(s: string): string {
  const t = String(s || '').trim();
  if (!t) return t;
  // Leave acronyms and proper names alone — "AI" must not become "aI".
  if (/^[A-Z]{2,}/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/**
 * The sentence shown when a whole result set was produced with NO personalisation at all.
 *
 * Its existence is the point: a list of postings that happens to be the newest ones must never be
 * presented as though it were chosen for somebody. This is what the surface renders instead.
 */
export const NOT_PERSONALISED =
  'These are not personalised — they are the current openings, newest first. '
  + 'Tell us anything about what you are looking for and we will explain why each one is here.';

/**
 * What to say when personalisation ran but the person's own words met nothing in a posting.
 *
 * A posting in that state is still shown, because the alternative — quietly dropping it — makes the
 * catalogue narrower than the person is. It is shown with this sentence attached, and never with a
 * borrowed reason from a different posting.
 */
export const MATCHED_NOTHING =
  'Nothing you have told us so far lines up with this one. It is here so the list is not narrower than you are.';
