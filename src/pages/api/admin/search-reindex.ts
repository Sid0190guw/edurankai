// POST /api/admin/search-reindex — rebuild the search index from published kernel objects
// (Prompt 12). Gated by can(manage, search) (audited).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { reindex } from '@/lib/search-index';
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'manage', { type: 'search' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need manage)', reason: g.reason }, 403);
  // BOUNDED, AND A FAILURE NO LONGER ANSWERS 200.
  //
  // reindex() reads the whole kernel and then swaps the index inside a transaction. Unbounded, a
  // stalled connection anywhere in that left the invocation hanging until the platform killed it,
  // with the transaction's locks and one of five pool slots held for the duration and nothing on the
  // admin's screen but a spinning button. 60s is generous for a full rebuild and far short of
  // forever.
  //
  // The old catch returned HTTP 200 with ok:false, so every monitor and every caller that checks a
  // status code read a failed rebuild as a successful one. And it published e.cause verbatim — the
  // driver's own message, which on a connection failure carries the pooler hostname and the database
  // role. The reason goes to the log; the page gets a sentence.
  try {
    const n = await withDbTimeout(reindex(), 'admin.searchReindex', 60000);
    return j({ ok: true, indexed: n });
  } catch (e: any) {
    const raw = e?.cause?.message || e?.message || 'unknown error';
    console.error('[admin/search-reindex] rebuild failed:', raw);
    return j({
      ok: false,
      error: isDbUnavailable(e)
        ? 'The database did not answer, so the index was not rebuilt. The previous index is untouched.'
        : 'The index could not be rebuilt. The previous index is untouched.',
    }, 503);
  }
};
