// GET /api/mail/gov/search?q=...
//
// One box, several stores. The classification is pure and explained back to the caller — the response
// carries `query.explain` so the results page can say WHY it looked where it looked, which is the
// difference between a search that returns nothing and a search a person can correct.
//
// THE SCOPE COMES FROM THE ACTOR, NEVER FROM THE REQUEST. A tenant-scoped administrator searching an
// exact message id belonging to another organization gets nothing, because every statement in
// runSearch() carries their org id. There is no parameter with which to widen it.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed } from '@/lib/mailgov/http';
import { requireGov } from '@/lib/mailgov/guard';
import { runSearch } from '@/lib/mailgov/search';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const g = await requireGov(locals, 'search.run', {}, request);
  if (g.denied) return g.denied;

  const out = await runSearch({
    q: url.searchParams.get('q') || '',
    scopeOrgId: g.actor.orgId,
    limitPerTarget: Number(url.searchParams.get('per')) || 10,
  });

  // A store that failed is named. Returning the hits that worked and hiding the store that did not
  // produces a confident "not found" for a record that is right there.
  return govJson({
    ok: out.ok,
    error: out.error,
    query: out.query,
    hits: out.hits,
    failed: out.failed,
    skipped: out.skipped,
    note: out.failed.length
      ? 'Some stores could not be searched. These results are incomplete.'
      : 'Message subjects and bodies are never searched from here.',
  }, out.ok ? 200 : 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET']);
