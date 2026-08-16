// GET/POST /api/mail/search — the mailbox search endpoint.
//
// WHY AN ENDPOINT AT ALL, when /admin/mail already searches on page load: because the advanced
// client pages results, prefetches the next page while you read, and re-runs a search when you
// change a filter — none of which should cost a full page render. The listing on the .astro page
// and this route call the SAME function (searchMailbox), so the first page you see and every page
// after it are produced by one engine.
//
// AUTHORISED BEFORE ANYTHING IS READ. denyMailApi() runs on the first line, before the query string
// is parsed and before any statement. A query that ran for an unauthorised caller has already
// happened whatever the response says.
//
// GET and POST both work and mean the same thing. GET so a search is linkable and cacheable by the
// browser's back button; POST so a very long query (a pasted list of addresses) is not truncated by
// a URL length limit somewhere in the chain.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { ensureMailSchema } from '@/lib/mail';
import { searchMailbox, SEARCH_HELP, isBroadQuery, parseSearchQuery } from '@/lib/mail-search';

// Declared above the handlers that read them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

interface SearchArgs {
  q: string;
  folder: string | null;
  label: string | null;
  starred: boolean;
  limit: number;
  cursor: string | null;
  withTotal: boolean;
  sort: 'date' | 'relevance';
}

function argsFromUrl(url: URL): SearchArgs {
  return {
    q: url.searchParams.get('q') || '',
    folder: url.searchParams.get('folder'),
    label: url.searchParams.get('label'),
    starred: url.searchParams.get('starred') === '1' || url.searchParams.get('folder') === 'starred',
    limit: Number(url.searchParams.get('limit')) || 50,
    cursor: url.searchParams.get('cursor'),
    withTotal: url.searchParams.get('total') === '1',
    sort: url.searchParams.get('sort') === 'relevance' ? 'relevance' : 'date',
  };
}

function argsFromBody(b: any): SearchArgs {
  return {
    q: String(b?.q || ''),
    folder: b?.folder ? String(b.folder) : null,
    label: b?.label ? String(b.label) : null,
    starred: !!b?.starred || b?.folder === 'starred',
    limit: Number(b?.limit) || 50,
    cursor: b?.cursor ? String(b.cursor) : null,
    withTotal: !!b?.total,
    sort: b?.sort === 'relevance' ? 'relevance' : 'date',
  };
}

async function run(userId: string, a: SearchArgs) {
  await ensureMailSchema();
  const folder = a.starred ? 'inbox' : (a.folder || 'inbox');
  const page = await searchMailbox(userId, {
    query: a.q,
    scope: { folder, starred: a.starred, label: a.label },
    limit: a.limit,
    cursor: a.cursor,
    withTotal: a.withTotal,
    sort: a.sort,
  });
  return {
    ok: true,
    hits: page.hits,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: page.total ?? null,
    totalIsCapped: page.totalIsCapped ?? false,
    scopeLabel: page.scopeLabel,
    describe: page.query.describe,
    warnings: page.query.warnings,
    // Shown when a search has no narrowing operator at all — not a refusal, a note that the answer
    // is "your whole folder, newest first", which is what a person means less often than they think.
    broad: isBroadQuery(page.query),
    engine: page.engine,
    tookMs: page.tookMs,
    degraded: page.degraded,
  };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.search' });
  if (denied) return denied;
  const user = (locals as any).user;
  try {
    return json(await run(user.id, argsFromUrl(new URL(request.url))));
  } catch (e: any) {
    // NOT swallowed into an empty result list. An empty list means "no mail matched"; this means
    // "the search did not run", and the client renders the difference.
    console.error('[api/mail/search] failed:', reasonOf(e));
    return json({ ok: false, error: 'That search did not run: ' + reasonOf(e) }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.search' });
  if (denied) return denied;
  const user = (locals as any).user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  // `help` returns the operator table so the search box and this endpoint cannot describe different
  // grammars — the list comes from the parser's own module.
  if (body?.help) return json({ ok: true, help: SEARCH_HELP });
  // `parse` explains a query without running it, which is what the "what will this search for?"
  // preview under the box calls.
  if (body?.parse != null) {
    const q = parseSearchQuery(String(body.parse || ''));
    return json({ ok: true, describe: q.describe, warnings: q.warnings, active: q.active, broad: isBroadQuery(q) });
  }

  try {
    return json(await run(user.id, argsFromBody(body)));
  } catch (e: any) {
    console.error('[api/mail/search] failed:', reasonOf(e));
    return json({ ok: false, error: 'That search did not run: ' + reasonOf(e) }, 500);
  }
};
