// POST /api/admin/observability — toggle a feature flag (Prompt 22). Strictly superadmin
// (can(administer)). Audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setFlag, KNOWN_FEATURES } from '@/lib/observability';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'administer', { type: 'platform' });
  if (!g.allow) return j({ ok: false, error: 'superadmin only', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const key = String(b.key || '');
  if (!(KNOWN_FEATURES as readonly string[]).includes(key)) return j({ ok: false, error: 'unknown feature' }, 400);
  try { await setFlag(key, !!b.enabled); return j({ ok: true }); } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
