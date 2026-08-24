// GET /api/careers/search — THE CATALOGUE, ONE PAGE AT A TIME.
//
// =================================================================================================
// THIS ENDPOINT IS THE ANSWER TO THE MULTI-MEGABYTE CAREERS PAGE
// =================================================================================================
//
// The old /careers selected up to five thousand postings and wrote every one into the initial HTML.
// This returns twenty-four, with the honest total of how many matched, and a `nextOffset` for the
// twenty-fifth. Ten thousand postings cost the same request as a hundred.
//
// IT IS ALSO THE FALLBACK PATH. When the interpreter cannot read a sentence, or the personalisation
// endpoint is unavailable, the careers page falls back to this — plain server-side search over the
// same catalogue with the same visibility rule. Section 31 of the brief: the careers page must
// never become unusable because an intelligence endpoint failed, and the only way to promise that
// is for the non-intelligent path to be a first-class endpoint rather than an error branch.
//
// NO SILENT TRUNCATION. `total` is COUNT(*) over the same predicate the rows came from, computed in
// SQL by listOpportunities. `hasMore` is derived from it. If 1,017 postings are open, this says
// 1,017 and forty-three pages walk all of them.
//
// PUBLIC AND CACHEABLE. Nothing here reads a session and the answer is identical for everybody with
// the same query string, so it carries a short shared cache header. The personalised endpoints next
// door carry no-store; the difference between the two is the reason they are separate endpoints.

import type { APIRoute } from 'astro';
import { listOpportunities } from '@/lib/xscale/roles-ext';
import { toCard, json } from '@/lib/career-intel/wire';
import { DOMAIN_BY_KEY } from '@/lib/career-intel/ontology';

export const prerender = false;

const PAGE = 24;
const MAX_PAGE = 48;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const p = url.searchParams;
  const str = (k: string, max = 120) => (p.get(k) || '').trim().slice(0, max);

  const limitRaw = Number(str('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_PAGE, Math.floor(limitRaw)) : PAGE;
  const offsetRaw = Number(str('offset'));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  // A named domain is accepted as a filter, so a pathway chip on the landing page is a real query
  // rather than a search for its own label. Unknown keys are ignored rather than refused: a stale
  // bookmark should show the catalogue, not an error.
  const domainKey = str('domain', 40).toUpperCase();
  const domain = DOMAIN_BY_KEY[domainKey];

  const result = await listOpportunities({
    q: str('q', 120) || undefined,
    departmentId: str('dept', 60) || undefined,
    divisionId: str('division', 60) || undefined,
    level: str('level', 30) || undefined,
    engagementType: str('type', 30) || undefined,
    classification: str('classification', 40) || undefined,
    band: str('band', 20) || undefined,
    skillCategory: domain?.skillCategory || str('skillcat', 40) || undefined,
    skill: str('skill', 60) || undefined,
    terms: domain && !domain.skillCategory ? domain.terms.slice(0, 4) : undefined,
    limit,
    offset,
  });

  const shown = result.rows.length;
  const nextOffset = offset + shown;

  return json({
    ok: result.readable,
    // readable:false means THE QUERY FAILED. A caller must not render it as "no openings match",
    // which is the single most common way a broken search is presented as an empty catalogue.
    readable: result.readable,
    // degraded:true means the extended columns were unavailable and the discipline, division,
    // classification and scale filters were NOT applied. The result is wider than what was asked
    // for and the surface says so.
    degraded: result.degraded,
    total: result.total,
    offset,
    limit,
    count: shown,
    hasMore: result.readable && nextOffset < result.total,
    nextOffset: nextOffset < result.total ? nextOffset : null,
    roles: result.rows.map(toCard),
  }, result.readable ? 200 : 503, result.readable ? 'public, max-age=60, s-maxage=300' : 'no-store');
};
