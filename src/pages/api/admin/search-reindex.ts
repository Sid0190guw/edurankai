// POST /api/admin/search-reindex — rebuild the search index from published kernel objects
// (Prompt 12). Gated by can(manage, search) (audited).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { reindex } from '@/lib/search-index';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'manage', { type: 'search' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need manage)', reason: g.reason }, 403);
  try { const n = await reindex(); return j({ ok: true, indexed: n }); } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'reindex failed' }, 200); }
};
