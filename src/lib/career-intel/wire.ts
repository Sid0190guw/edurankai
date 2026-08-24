// src/lib/career-intel/wire.ts — THE ONE SHAPE A POSTING TAKES ON ITS WAY TO A SCREEN.
//
// The careers page renders its first results on the server and every page after that in the
// browser from JSON. Two renderers for one card is two places for a badge to drift, and the badge
// most likely to drift is the one that says where the work happens. So the card is BUILT HERE,
// once, and both paths render the same object.
//
// WORK MODE PASSES THROUGH src/lib/work-mode.ts AND NOWHERE ELSE. displayLocation() reads the
// stored string and rewrites it only when it contradicts the policy, which is what stops a legacy
// "Remote / Hybrid (India)" row from advertising remote work on a page that has been rebuilt around
// it. No component in this feature is allowed to read `role.location` directly; the field is not
// even present on the card. That is deliberate — an absent field cannot be rendered by accident.

import { displayLocation, resolveWorkMode, workModeLabel } from '@/lib/work-mode';
import { classificationDef, careerRung, scaleRangeText } from '@/lib/xscale/taxonomy';
import type { OpportunityRow } from '@/lib/xscale/roles-ext';
import { explain, type Explanation } from './explain';
import type { MatchResult } from './rank';

export interface RoleCard {
  id: string;
  slug: string;
  title: string;
  href: string;
  level: string;
  functionText: string;
  engagementType: string;
  department: string | null;
  division: string | null;
  /** Already resolved through work-mode.ts. The raw stored string is deliberately not carried. */
  location: string;
  workMode: string;
  classification: string | null;
  rung: string | null;
  scale: string | null;
  skills: string[];
  featured: boolean;
  deadline: string | null;
}

export function toCard(r: OpportunityRow): RoleCard {
  const mode = resolveWorkMode(r.engagementType, r.level, r.location);
  const cls = classificationDef(r.researchClassification);
  const rung = careerRung(r.careerLevel);
  const hasScale = typeof r.scaleMinExp === 'number' && typeof r.scaleMaxExp === 'number';
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    href: '/careers/' + r.slug,
    level: r.level,
    functionText: r.functionText,
    engagementType: r.engagementType,
    department: r.departmentName,
    division: r.divisionName,
    location: displayLocation(r.engagementType, r.level, r.location),
    workMode: workModeLabel(mode),
    classification: cls ? cls.label : null,
    rung: rung ? rung.label : null,
    scale: hasScale ? scaleRangeText(r.scaleMinExp as number, r.scaleMaxExp as number) : null,
    skills: (r.skills || []).slice(0, 5),
    featured: r.isFeatured === true,
    deadline: r.applicationDeadline,
  };
}

export interface MatchCard {
  card: RoleCard;
  tier: string;
  explanation: Explanation;
}

/**
 * A ranked posting on its way to a screen.
 *
 * The explanation travels WITH the card and is built from the contributions that produced the
 * ranking. There is no path that sends a ranked card without its reasons, which is the mechanical
 * version of "why this opportunity" being a core feature rather than a panel somebody remembers to
 * add to one of the two renderers.
 */
export function toMatchCard(m: MatchResult, row: OpportunityRow): MatchCard {
  return { card: toCard(row), tier: m.tier, explanation: explain(m) };
}

/** JSON with the headers a public, personalised endpoint needs. */
export function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A personalised answer must never reach a shared cache. The catalogue search below IS
      // cacheable and passes its own value; this is the safe default for everything else.
      'cache-control': cache,
    },
  });
}
