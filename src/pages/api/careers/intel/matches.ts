// POST /api/careers/intel/matches — RETRIEVE, RANK, EXPLAIN.
//
// =================================================================================================
// THE PIPELINE, IN THE ORDER IT ACTUALLY RUNS
// =================================================================================================
//
//   profile  ->  compileQuery()   the person's signals become SQL predicates
//            ->  listOpportunities()   the DATABASE decides which rows, and counts them
//            ->  rankAll()        the fetched page is ordered, with contributions recorded
//            ->  explain()        the contributions become sentences
//
// Each step is somewhere else and each is testable on its own. The two that matter most are the
// ones that are NOT here:
//
//   ELIGIBILITY is decided inside listOpportunities from the posting's own status and deadline,
//   before anything about a person is consulted. Nothing in a profile can make a posting
//   unreachable. Career stage and stated avoidances are RANKING inputs, not filters.
//
//   NO SCORE IS RETURNED. Each match carries a tier with a written meaning and the list of
//   contributions that put it there. There is no percentage anywhere in this response, because
//   there is no percentage anywhere in the model.
//
// PAGED, LIKE EVERYTHING ELSE. `offset` walks the same predicate; `total` is the SQL count over it.
// A person can page through every posting that matched, and the number at the top is the number.
//
// AND ONE HONEST LIMIT, STATED RATHER THAN GLOSSED. Ranking orders the page that was FETCHED, not
// the whole matching set: postings 25-48 are ranked against each other, not against 1-24. Ranking
// the full set would mean pulling every matching row into a serverless function to display twelve,
// which is the exact problem this rebuild exists to remove. What makes the trade acceptable is that
// SELECTION already happened in SQL — the compiled discipline and term predicates are what decide
// which postings are in the set at all — so ranking is ordering relevant things, not sifting the
// catalogue. Nothing is hidden by it either way: `total` counts the whole matching set and the
// pages walk all of it.

import type { APIRoute } from 'astro';
import { json, toMatchCard } from '@/lib/career-intel/wire';
import { parseProfile } from '@/lib/career-intel/profile';
import { retrieveForProfile } from '@/lib/career-intel/retrieve';
import { rankAll, TIERS, type MatchableRole } from '@/lib/career-intel/rank';
import { NOT_PERSONALISED, UNPERSONALISED_GROUP_LABEL, UNPERSONALISED_GROUP_MEANING } from '@/lib/career-intel/explain';
import { profileReadiness } from '@/lib/career-intel/dimensions';
import { shouldOfferResume } from '@/lib/career-intel/questions';
import { domainLabel, DOMAIN_BY_KEY } from '@/lib/career-intel/ontology';
import { buildCareerMap, MAP_BANDS } from '@/lib/career-intel/map';
import type { OpportunityRow } from '@/lib/xscale/roles-ext';

export const prerender = false;

const PAGE = 12;
const MAX_PAGE = 24;

/** The listing row, in the shape the ranker asks for. No new data — a projection. */
function matchable(r: OpportunityRow): MatchableRole {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    level: r.level,
    functionText: r.functionText,
    engagementType: r.engagementType,
    departmentName: r.departmentName,
    divisionName: r.divisionName,
    researchClassification: r.researchClassification,
    skills: r.skills,
    skillCategories: r.skillCategories,
    careerLevel: r.careerLevel,
  };
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read that request.' }, 400);
  }

  const profile = parseProfile(body?.profile);
  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_PAGE, Math.floor(limitRaw)) : PAGE;
  const offsetRaw = Number(body?.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  // The person's own explicit choices — a search box, a department they clicked — are the only
  // things allowed to REMOVE postings from the result. They travel separately from the profile so
  // that distinction is visible at the call site rather than buried in the compiler.
  //
  // A DOMAIN CLICKED ON THE CAREER MAP IS AN EXPLICIT CHOICE, not an inference, so it belongs here
  // and it is allowed to narrow the result set. It is also reversible in one click, which is what
  // makes narrowing acceptable: the map node the person pressed is still on screen beside the
  // results, and pressing nothing returns the whole set.
  const domainKey = typeof body?.domain === 'string' ? body.domain.slice(0, 40).toUpperCase() : '';
  const domain = DOMAIN_BY_KEY[domainKey];

  const explicit = {
    q: typeof body?.q === 'string' ? body.q.trim().slice(0, 120) : undefined,
    departmentId: typeof body?.dept === 'string' ? body.dept.slice(0, 60) : undefined,
    level: typeof body?.level === 'string' ? body.level.slice(0, 30) : undefined,
    engagementType: typeof body?.type === 'string' ? body.type.slice(0, 30) : undefined,
    skillCategory: domain?.skillCategory || undefined,
    terms: domain && !domain.skillCategory ? domain.terms.slice(0, 4) : undefined,
  };

  const pool = await retrieveForProfile(profile, { limit, offset, explicit });

  if (!pool.readable) {
    // NOT an empty list. The careers page renders this as "we could not read the catalogue just
    // now", with the plain search still available — never as "nothing matches you".
    return json({
      ok: false,
      readable: false,
      error: 'The catalogue could not be read just now.',
      total: 0,
      groups: [],
    }, 503);
  }

  const byId = new Map(pool.rows.map((r) => [r.id, r]));
  const ranked = rankAll(profile, pool.rows.map(matchable));
  const personalised = !pool.compiled.unpersonalised && profileReadiness(profile) > 0;

  const cards = ranked
    .map((m) => {
      const row = byId.get(m.role.id);
      return row ? toMatchCard(m, row) : null;
    })
    .filter(Boolean) as ReturnType<typeof toMatchCard>[];

  // Grouped by tier, in the tiers' own order, and empty groups are dropped rather than rendered as
  // a heading with nothing under it.
  //
  // A TIER IS A CLAIM ABOUT OVERLAP, SO IT NEEDS SOMETHING TO OVERLAP WITH. With no personalisation
  // the ranker still assigns every posting a tier — everything lands in 'explore' — and rendering
  // that tier's label put "Worth a look: matched on part of what you said" above a list built from
  // nothing the person had said, four lines under this endpoint's own "these are not personalised".
  // One unpersonalised group, named for what it actually is.
  const groups = personalised
    ? TIERS
      .map((t) => ({
        tier: t.key,
        label: t.label,
        meaning: t.meaning,
        matches: cards.filter((c) => c.tier === t.key),
      }))
      .filter((g) => g.matches.length > 0)
    : (cards.length
      ? [{
        tier: 'explore',
        label: UNPERSONALISED_GROUP_LABEL,
        meaning: UNPERSONALISED_GROUP_MEANING,
        matches: cards,
      }]
      : []);

  const nextOffset = offset + pool.rows.length;

  return json({
    ok: true,
    readable: true,
    // The extended columns were unavailable, so the discipline predicates did not run and this
    // result is wider than what was asked for. The surface says so; it does not pass it off.
    degraded: pool.degraded,
    // The personalised query matched nothing and the catalogue was read instead.
    widened: pool.widened,
    personalised,
    // Rendered above the results when nothing personalised them, so a list of the newest openings
    // is never presented as a list chosen for somebody.
    notPersonalisedNote: personalised ? null : NOT_PERSONALISED,
    // What we actually looked in, in words. The search is not a black box.
    lookedIn: {
      disciplines: pool.compiled.disciplines.map(domainLabel),
      terms: pool.compiled.terms,
      explicit: Object.fromEntries(Object.entries(explicit).filter(([, v]) => !!v)),
    },
    total: pool.total,
    catalogueTotal: pool.catalogueTotal,
    offset,
    limit,
    count: cards.length,
    hasMore: nextOffset < pool.total,
    nextOffset: nextOffset < pool.total ? nextOffset : null,
    readiness: profileReadiness(profile),
    offerResume: shouldOfferResume(profile),
    // THE CAREER MAP TRAVELS WITH THE RESULTS AND COSTS NOTHING. It is computed from the profile
    // alone — no query — so showing it is free, and it cannot drift from what the results were
    // ranked on because both were built from the same document in the same request.
    map: buildCareerMap(profile),
    mapBands: MAP_BANDS,
    focusedDomain: domain ? { key: domain.key, label: domain.label } : null,
    groups,
  }, 200, 'no-store');
};
