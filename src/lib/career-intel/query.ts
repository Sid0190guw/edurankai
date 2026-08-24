// src/lib/career-intel/query.ts — A PROFILE BECOMES A QUERY.
//
// Pure, and in its own file precisely because it is. It began life inside retrieve.ts, which imports
// the database module — and importing that module runs `dotenv.config()` at module scope, so a test
// for this logic could not run without reading the environment file. Pure decision logic that can
// only be exercised through a database connection is pure logic that does not get tested, and this
// is the one function in the feature that decides what a person is shown, so it gets tested.
//
// =================================================================================================
// THE RULE THIS FILE ENFORCES
// =================================================================================================
//
//   A FILTER REMOVES. A WEIGHT REORDERS. Only the person's own explicit choices may filter.
//
// What they typed in the search box, the department they clicked — those remove postings, because
// the person asked for that and can undo it in one click. What we INFERRED about them never does.
// Career stage does not become a career-level filter; a stated dislike does not become a NOT. Both
// are handled in ranking, where they move a posting down a list that is still scrollable.
//
// The difference matters because the two are indistinguishable from the inside and completely
// different from the outside: a demoted posting is one the person can still find, and a filtered one
// is one that, as far as they can tell, does not exist.

import type { OpportunityFilters } from '@/lib/xscale/roles-ext';
import { DOMAIN_BY_KEY } from './ontology';
import type { CareerProfile } from './dimensions';

export interface CompiledQuery {
  filters: OpportunityFilters;
  /** The disciplines that became a real column predicate. Shown to the person as "we looked in". */
  disciplines: string[];
  /** The words that became a text predicate. Shown, so the search is never a black box. */
  terms: string[];
  /** True when the profile said nothing usable, so this is the plain catalogue in its own order. */
  unpersonalised: boolean;
}

/**
 * Turn a profile into a query this database can run.
 *
 * ONE QUERY, NOT ONE PER SIGNAL. A profile can name four disciplines and six terms; the obvious
 * implementation runs a query per discipline and merges, which is ten round trips to build one
 * page. This project has measured what a round trip costs from the region the site runs in, and the
 * note in src/lib/db/index.ts is blunt about it — the round-trip COUNT is the lever. So everything
 * is compiled into one filter set.
 */
export function compileQuery(profile: CareerProfile, explicit: Partial<OpportunityFilters> = {}): CompiledQuery {
  const interests = (profile.interests || [])
    .filter((t) => t.confirmation !== 'rejected')
    .slice()
    .sort((a, b) => b.confidence - a.confidence);

  const disciplines: string[] = [];
  const terms: string[] = [];

  for (const tag of interests) {
    const d = DOMAIN_BY_KEY[tag.key];
    if (d?.skillCategory) {
      if (!disciplines.includes(d.skillCategory)) disciplines.push(d.skillCategory);
    } else if (d) {
      for (const t of (d.terms || []).slice(0, 2)) if (!terms.includes(t)) terms.push(t);
    } else if (tag.label) {
      if (!terms.includes(tag.label)) terms.push(tag.label);
    }
  }

  // Named skills are the sharpest thing a person gives us, so they go in even when disciplines
  // already did. A posting that names "PyTorch" is a better answer than the whole AI discipline.
  for (const s of (profile.skills || []).filter((t) => t.confirmation !== 'rejected').slice(0, 4)) {
    if (!terms.includes(s.label)) terms.push(s.label);
  }

  const cappedDisciplines = disciplines.slice(0, 6);
  const cappedTerms = terms.slice(0, 6);

  // BOTH ARE SENT, AND listOpportunities OR-s THEM WITH EACH OTHER.
  //
  // An earlier version sent one or the other — disciplines when there were any, terms otherwise —
  // because listOpportunities AND-s its filters and the intersection of "in the AI discipline" and
  // "mentions Python" is frequently empty. Sending only the disciplines turned out to be the worse
  // half of that trade on this catalogue: skill_categories is populated on the 179 research
  // postings and on nothing else, so "I want AI work" would look past every AI-titled role in the
  // main catalogue and answer with a handful, or with none at all.
  //
  // discoveryFragment() in roles-ext.ts now ORs the two, so both go. Everything else in `explicit`
  // still ANDs, because those are choices the person made and are meant to narrow.
  const filters: OpportunityFilters = {
    ...explicit,
    skillCategoriesAny: cappedDisciplines.length ? cappedDisciplines : undefined,
    terms: cappedTerms.length ? cappedTerms : undefined,
  };

  const unpersonalised = cappedDisciplines.length === 0 && cappedTerms.length === 0 && !explicit.q;

  return {
    filters,
    disciplines: cappedDisciplines,
    terms: cappedTerms,
    unpersonalised,
  };
}
