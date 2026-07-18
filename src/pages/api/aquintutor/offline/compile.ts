// POST /api/aquintutor/offline/compile — compile an Offline Learning Package (Prompt 6).
// Only units the student may see (can(read)) and that are published are packaged; the planner
// drops the lowest-priority units over the offline budget. Returns the pre-rendered manifest the
// client stores in IndexedDB to learn offline.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { contentService } from '@/lib/kernel-content';
import { compileForUser } from '@/lib/offline-package';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const ids: string[] = Array.isArray(b.unitIds) ? b.unitIds.map((x: any) => String(x)).filter(Boolean) : [];
  const tier = ['lite', 'standard', 'rich'].includes(b.tier) ? b.tier : 'lite';   // offline defaults to lite
  if (!ids.length) return j({ ok: false, error: 'unitIds required' }, 400);

  const svc = contentService();
  const allowed: string[] = [];
  for (const id of ids) {
    const v = await svc.getUnitView(id).catch(() => null);
    if (!v || v.unit.lifecycleState !== 'published') continue;
    const g = await can(user, 'read', { type: 'KnowledgeObject', securityLabels: (v.unit as any).securityLabels || ['public'] });
    if (g.allow) allowed.push(id);
  }
  if (!allowed.length) return j({ ok: false, error: 'no permitted published units to package' }, 200);

  try {
    const manifest = await compileForUser(user.id, allowed, tier, Number(b.maxBytes) || undefined);
    return j({ ok: true, manifest });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
