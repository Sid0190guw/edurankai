// src/lib/career-intel/rank.ts — WHY THIS OPPORTUNITY, AND HOW SURE WE ARE.
//
// =================================================================================================
// THREE THINGS THIS FILE IS NOT ALLOWED TO DO
// =================================================================================================
//
// 1. IT CANNOT MAKE A POSTING DISAPPEAR. Eligibility — is this open, published, in date — is
//    decided in src/lib/xscale/roles-ext.ts from the POSTING's own columns, before this module is
//    ever called. Nothing about a person is an input to it. This file receives a list of postings
//    that are already showable and decides an ORDER and an EXPLANATION. Ordering is reversible by
//    the person in one click ("show everything"); a hidden posting is not.
//
// 2. IT CANNOT READ THE EXPLORATION LAYERS. Energy rhythm, self-reported behavioural tendencies and
//    the optional reflection layer are collected for the person's own picture. The only door into
//    the dimensions is relevanceDimensions(), which returns the workstyle and cognitive groups and
//    nothing else. reflection.ts is not imported by this file at all, and separation.test.ts reads
//    this file's own source to prove it stays that way.
//
// 3. IT CANNOT PRINT A NUMBER AND CALL IT A MATCH. There is a score in here — ordering a thousand
//    postings requires one — but it is never returned to a surface as "94%". What comes out is a
//    TIER with a written meaning, and a list of CONTRIBUTIONS, each naming the signal, what in the
//    posting it met, and how much it moved things. A percentage on a career decision is the most
//    persuasive and least answerable thing you can put on a screen; src/lib/ai-boundary.ts refuses
//    to store one on a high-impact recommendation for the same reason.
//
// =================================================================================================
// THE EXPLANATION IS THE PRODUCT, SO IT IS COMPUTED FIRST
// =================================================================================================
//
// The contributions are not a narration written after the fact from the same inputs — they ARE the
// score. `total` is the sum of `contributions[].weight`. There is no path by which a posting can
// rank highly for a reason that is not in the list, and none by which a reason can appear in the
// list without having moved the ranking. Section 25: an explanation must never invent a reason that
// was not used, and the only reliable way to guarantee that is to make them the same object.

import {
  relevanceDimensions, type CareerProfile, type Signal,
} from './dimensions';
import { DOMAIN_BY_KEY, type InterestDomain } from './ontology';

/* -------------------------------------------------------------------------------- what we rank */

/**
 * The posting shape this module needs. A superset of the listing row so a detail page can pass the
 * richer record it already has; every extra field is optional and its absence costs a contribution
 * rather than throwing.
 */
export interface MatchableRole {
  id: string;
  slug: string;
  title: string;
  level: string;
  functionText: string;
  engagementType: string;
  departmentName?: string | null;
  divisionName?: string | null;
  researchClassification?: string | null;
  skills?: string[];
  skillCategories?: string[];
  careerLevel?: number | null;
  /** Detail pages have these; the listing query does not select them. */
  preferredSkills?: string[];
  tools?: string[];
  about?: string | null;
}

/* ------------------------------------------------------------------------------ what comes out */

export type MatchTier = 'strong' | 'potential' | 'adjacent' | 'explore';

export interface TierDef {
  key: MatchTier;
  label: string;
  /** What the tier MEANS, in the words shown under its heading. */
  meaning: string;
}

/**
 * FOUR GROUPS WITH WRITTEN MEANINGS, NOT A NUMBER LINE.
 *
 * "Strong Alignment" is a claim about the overlap between what somebody told us and what a posting
 * says — not a prediction that they will get the job, and the wording is chosen so it cannot be
 * read as one.
 */
export const TIERS: TierDef[] = [
  { key: 'strong', label: 'Strong alignment', meaning: 'Several things you told us line up with what this posting asks for.' },
  { key: 'potential', label: 'Good potential', meaning: 'A real overlap, with some of the posting still outside what you have told us.' },
  { key: 'adjacent', label: 'Adjacent', meaning: 'Related to what you described, along a direction you may not have considered.' },
  { key: 'explore', label: 'Worth a look', meaning: 'Matched on part of what you said. Included so the list is not narrower than you are.' },
];

export const TIER_BY_KEY: Record<MatchTier, TierDef> =
  Object.fromEntries(TIERS.map((t) => [t.key, t])) as Record<MatchTier, TierDef>;

export type ContributionKind =
  | 'discipline'   // a research discipline the person named
  | 'domain'       // a pathway the person named, met in the posting's text
  | 'skill'        // something concrete they said they have worked with
  | 'approach'     // how they said they like to think, met by the posting's classification
  | 'stage'        // where they are, met by the posting's rung
  | 'avoid';       // something they said they did not want — the only negative weight

export interface Contribution {
  kind: ContributionKind;
  /** What the person told us. Quoted back verbatim where it was their own word. */
  signal: string;
  /** What in the posting it met. Always a real property of this posting. */
  matched: string;
  /** Signed. The sum of these IS the score; nothing else moves it. */
  weight: number;
}

export interface MatchResult {
  role: MatchableRole;
  tier: MatchTier;
  /** The sum of the contributions. Ordering only; never rendered as a percentage. */
  total: number;
  contributions: Contribution[];
  /** Named in the posting, not evidenced in what the person told us. Honest, not disqualifying. */
  gaps: string[];
  /** What we would need to know to say more. Rendered as "areas we need more information". */
  unknowns: string[];
}

/* ------------------------------------------------------------------------------- the weights */

// One table, so the whole ranking policy is readable in twenty lines instead of being spread
// through the code that applies it. Changing how this system ranks means changing these numbers.
const W = {
  disciplineNamed: 1.0,    // they named the discipline and the posting carries it as a column
  disciplineText: 0.55,    // they named it and it appears in the posting's own words
  domainTerm: 0.45,        // a pathway word met in the title or function line
  skillExact: 0.8,         // a concrete thing they said they have worked with, named by the posting
  skillPartial: 0.4,
  approach: 0.6,           // how they like to think, met by the posting's research classification
  stageExact: 0.5,
  stageNear: 0.25,
  stageFar: -0.35,         // a posting several rungs away is demoted, never hidden
  avoid: -1.2,             // demotion only; an avoided posting still appears if nothing else does
};

/* ------------------------------------------------------- classification to cognitive preference */

/**
 * What each research classification asks of a person, in dimension terms.
 *
 * READ IN ONE DIRECTION ONLY: a person's stated preference for abstraction raises a theoretical
 * posting. The reverse — inferring that somebody who applied to a theoretical posting must prefer
 * abstraction — is not done anywhere, because that is how a recommendation system starts telling
 * people who they are.
 */
const CLASSIFICATION_DIMENSIONS: Record<string, Record<string, number>> = {
  THEORETICAL: { abstraction: 1, analytical: 0.7, research_orientation: 0.6 },
  MATHEMATICAL: { abstraction: 1, analytical: 0.9 },
  COMPUTATIONAL: { analytical: 0.9, implementation: 0.6 },
  SIMULATION: { analytical: 0.8, implementation: 0.7, systems_thinking: 0.6 },
  EXPERIMENTAL: { experimental: 1, detail_orientation: 0.5 },
  PROTOTYPE: { implementation: 1, creativity: 0.7, experimental: 0.6 },
  APPLIED_ENGINEERING: { implementation: 1, systems_thinking: 0.8 },
  LONG_HORIZON_FRONTIER: { research_orientation: 1, ambiguity_tolerance: 0.9, abstraction: 0.6 },
};

/** How a posting's engagement and rung relate to where somebody says they are. */
const STAGE_RUNGS: Record<string, number[]> = {
  student: [0, 1],
  early: [1, 2, 3],
  experienced: [3, 4, 5, 6],
  senior: [6, 7, 8, 9, 10],
};

const LEVEL_STAGE: Record<string, string[]> = {
  Apprentice: ['student'],
  Intern: ['student', 'early'],
  Junior: ['early', 'experienced'],
  Mid: ['experienced'],
  Senior: ['experienced', 'senior'],
  Lead: ['senior'],
  'C-Level': ['senior'],
};

/* -------------------------------------------------------------------------------- normalising */

const norm = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();

/** Word-level overlap between two short phrases. Cheap, and honest about being a word match. */
function phraseOverlap(a: string, b: string): number {
  const wa = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const wb = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size);
}

/* ------------------------------------------------------------------------------ the evaluation */

/**
 * Compare one person to one posting.
 *
 * TOTAL. A posting with nothing in common produces `tier: 'explore'`, an empty contribution list
 * and an honest `unknowns`. It does not produce a match at 0% and it does not throw.
 */
export function evaluate(profile: CareerProfile, role: MatchableRole): MatchResult {
  const contributions: Contribution[] = [];
  const gaps: string[] = [];
  const unknowns: string[] = [];

  const interests = (profile.interests || []).filter((t) => t.confirmation !== 'rejected');
  const avoid = (profile.avoid || []).filter((t) => t.confirmation !== 'rejected');
  const skills = (profile.skills || []).filter((t) => t.confirmation !== 'rejected');
  const dims = relevanceDimensions(profile); // THE ONLY DOOR — see the header.

  const roleCats = new Set((role.skillCategories || []).map(String));
  const roleText = [role.title, role.functionText, role.departmentName || '', role.divisionName || '']
    .join(' ');
  const roleTextLower = norm(roleText);
  const roleSkills = (role.skills || []).concat(role.preferredSkills || [], role.tools || []);

  /* ---- interests: the disciplines and pathways they named ---- */

  for (const tag of interests) {
    const domain: InterestDomain | undefined = DOMAIN_BY_KEY[tag.key];
    if (!domain) {
      // Something they typed themselves. Matched against the posting's words, at the lower weight
      // a text match deserves.
      if (roleTextLower.includes(norm(tag.label))) {
        contributions.push({ kind: 'domain', signal: tag.label, matched: role.title, weight: W.domainTerm * tag.confidence });
      }
      continue;
    }
    if (domain.skillCategory && roleCats.has(domain.skillCategory)) {
      contributions.push({
        kind: 'discipline',
        signal: domain.label,
        matched: 'This posting is classified under ' + domain.label.toLowerCase() + '.',
        weight: W.disciplineNamed * tag.confidence,
      });
      continue;
    }
    const term = (domain.terms || []).find((t) => roleTextLower.includes(norm(t)));
    if (term) {
      contributions.push({
        kind: domain.skillCategory ? 'discipline' : 'domain',
        signal: domain.label,
        matched: '"' + term + '" appears in this posting.',
        weight: (domain.skillCategory ? W.disciplineText : W.domainTerm) * tag.confidence,
      });
    }
  }

  /* ---- skills: concrete things they said they had worked with ---- */

  for (const tag of skills) {
    const exact = roleSkills.find((s) => norm(s) === norm(tag.label));
    if (exact) {
      contributions.push({ kind: 'skill', signal: tag.label, matched: 'Named in this posting as "' + exact + '".', weight: W.skillExact * tag.confidence });
      continue;
    }
    const partial = roleSkills.find((s) => phraseOverlap(s, tag.label) >= 0.5);
    if (partial) {
      contributions.push({ kind: 'skill', signal: tag.label, matched: 'Close to "' + partial + '" in this posting.', weight: W.skillPartial * tag.confidence });
      continue;
    }
    if (roleTextLower.includes(norm(tag.label))) {
      contributions.push({ kind: 'skill', signal: tag.label, matched: 'Mentioned in the posting text.', weight: W.skillPartial * tag.confidence });
    }
  }

  /* ---- approach: how they said they like to think, met by the posting's classification ---- */

  const clsDims = CLASSIFICATION_DIMENSIONS[String(role.researchClassification || '')] || null;
  if (clsDims) {
    for (const [key, need] of Object.entries(clsDims)) {
      const sig: Signal | undefined = dims[key];
      if (!sig || sig.value < 0.55 || sig.confidence < 0.3) continue;
      contributions.push({
        kind: 'approach',
        signal: APPROACH_TEXT[key] || key,
        matched: 'This is ' + String(role.researchClassification).toLowerCase().replace(/_/g, ' ') + ' work.',
        weight: W.approach * need * sig.value * sig.confidence,
      });
    }
  } else if (Object.keys(dims).length > 0) {
    unknowns.push('This posting has no research classification recorded, so we could not compare it against how you said you like to work.');
  }

  /* ---- stage ---- */

  if (profile.stage !== 'unknown') {
    const wanted = STAGE_RUNGS[profile.stage] || [];
    const rung = typeof role.careerLevel === 'number' ? role.careerLevel : null;
    const levelOk = (LEVEL_STAGE[role.level] || []).includes(profile.stage);

    if (rung !== null && wanted.length) {
      const distance = Math.min(...wanted.map((w) => Math.abs(w - rung)));
      if (distance === 0) {
        contributions.push({ kind: 'stage', signal: STAGE_TEXT[profile.stage], matched: 'This posting sits at the rung that matches.', weight: W.stageExact * (profile.stageConfidence || 0.6) });
      } else if (distance <= 1) {
        contributions.push({ kind: 'stage', signal: STAGE_TEXT[profile.stage], matched: 'One rung away from where you said you are.', weight: W.stageNear * (profile.stageConfidence || 0.6) });
      } else {
        contributions.push({ kind: 'stage', signal: STAGE_TEXT[profile.stage], matched: 'Several rungs from where you said you are — still open to you.', weight: W.stageFar });
      }
    } else if (levelOk) {
      contributions.push({ kind: 'stage', signal: STAGE_TEXT[profile.stage], matched: 'Advertised at ' + role.level + ' level.', weight: W.stageExact * 0.7 * (profile.stageConfidence || 0.6) });
    } else if (rung === null) {
      unknowns.push('This posting does not record a career rung, so we could not check it against where you said you are.');
    }
  } else {
    unknowns.push('You have not told us where you are in your career, which is the single thing that would sharpen this most.');
  }

  /* ---- avoidance: demote, never hide ---- */

  for (const tag of avoid) {
    const domain = DOMAIN_BY_KEY[tag.key];
    const hit = domain
      ? (domain.skillCategory && roleCats.has(domain.skillCategory)) || (domain.terms || []).some((t) => roleTextLower.includes(norm(t)))
      : roleTextLower.includes(norm(tag.label));
    if (hit) {
      contributions.push({
        kind: 'avoid',
        signal: 'You said you would rather not go towards ' + (domain?.label || tag.label).toLowerCase() + '.',
        matched: 'This posting is in that area, so it is ranked lower — not removed.',
        weight: W.avoid * tag.confidence,
      });
    }
  }

  /* ---- gaps: what the posting asks for that we have no evidence of ---- */

  const known = new Set(skills.map((s) => norm(s.label)));
  for (const s of (role.skills || []).slice(0, 8)) {
    if (!known.has(norm(s))) gaps.push(s);
  }
  if (skills.length === 0 && (role.skills || []).length > 0) {
    unknowns.push('You have not told us what you have worked with, so nothing in this posting could be checked against your experience.');
  }

  const total = contributions.reduce((n, c) => n + c.weight, 0);
  const tier = tierFor(total, contributions);

  return { role, tier, total, contributions: contributions.sort((a, b) => b.weight - a.weight), gaps: gaps.slice(0, 6), unknowns };
}

const APPROACH_TEXT: Record<string, string> = {
  abstraction: 'You said you are comfortable working with ideas before they are concrete',
  analytical: 'You said you like reasoning a problem through carefully',
  experimental: 'You said you would rather try something and see what happens',
  implementation: 'You said you want to build the working thing',
  systems_thinking: 'You said you like seeing how the parts fit together',
  research_orientation: 'You said you are drawn to unanswered questions',
  creativity: 'You said you like making things that did not exist before',
  ambiguity_tolerance: 'You said you are comfortable when the answer is not known yet',
  detail_orientation: 'You said you notice the small thing that is wrong',
  deep_focus: 'You said you prefer quiet, uninterrupted stretches',
};

const STAGE_TEXT: Record<string, string> = {
  student: 'You are studying',
  early: 'You are starting out',
  experienced: 'You have experience behind you',
  senior: 'You lead work',
  unknown: '',
};

/**
 * Which group a posting lands in.
 *
 * TWO CONDITIONS FOR THE TOP GROUP, NOT ONE. A high total from a single very strong contribution is
 * not "strong alignment" — it is one thing lining up. The brief's own wording for the top tier is
 * "several things", and this is where that word is enforced: two DISTINCT KINDS of evidence, so
 * three skill words from the same sentence cannot promote a posting on their own.
 */
export function tierFor(total: number, contributions: Contribution[]): MatchTier {
  const positive = contributions.filter((c) => c.weight > 0);
  const kinds = new Set(positive.map((c) => c.kind)).size;
  const demoted = contributions.some((c) => c.kind === 'avoid');

  if (demoted && total < 1.2) return 'explore';
  if (total >= 1.8 && kinds >= 2) return 'strong';
  if (total >= 1.0) return 'potential';
  if (total >= 0.4) return 'adjacent';
  return 'explore';
}

/* -------------------------------------------------------------------------------- ranking a list */

export interface RankedGroup {
  tier: MatchTier;
  label: string;
  meaning: string;
  matches: MatchResult[];
}

/**
 * Rank a retrieved page of postings and group it by tier.
 *
 * THE INPUT IS ALREADY A PAGE. This function never sees the whole catalogue and is not where
 * pagination happens — retrieval decided which postings to fetch and how many, in SQL. Ranking a
 * thousand rows in a serverless function to show twelve is the shape of the problem this rebuild
 * exists to remove.
 */
export function rankAll(profile: CareerProfile, roles: MatchableRole[]): MatchResult[] {
  return roles
    .map((r) => evaluate(profile, r))
    .sort((a, b) => (b.total - a.total) || a.role.title.localeCompare(b.role.title));
}

export function groupByTier(matches: MatchResult[]): RankedGroup[] {
  return TIERS
    .map((t) => ({
      tier: t.key,
      label: t.label,
      meaning: t.meaning,
      matches: matches.filter((m) => m.tier === t.key),
    }))
    .filter((g) => g.matches.length > 0);
}

/**
 * "What could strengthen my fit?" — section 15.
 *
 * WHAT IT SAYS AND WHAT IT REFUSES TO SAY. It lists what the posting names that we have no evidence
 * of, and it calls that "could strengthen your alignment". It does not say doing these things leads
 * to an offer, because that is a promise nobody in this system is in a position to make and a
 * candidate acting on it would be acting on a fiction.
 */
export function strengthenFit(m: MatchResult): { aligned: string[]; couldStrengthen: string[]; note: string } {
  const aligned = m.contributions
    .filter((c) => c.weight > 0)
    .map((c) => c.signal)
    .slice(0, 6);
  return {
    aligned,
    couldStrengthen: m.gaps,
    note: 'These could strengthen your alignment with what this posting asks for. '
      + 'They are not a checklist and completing them is not a route to an offer — every application here is read by a person.',
  };
}
