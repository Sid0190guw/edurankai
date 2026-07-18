// POST /api/admin/sync — sync/conflict actions (Prompt 7). Gated via can(manage, sync) (audited).
//   push {objectIds} | resolve {objectId, policy} | flag {objectId}
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { pushDirty, resolveConflict, flagConflict, type ConflictPolicy } from '@/lib/knowledge-sync';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const POLICIES: ConflictPolicy[] = ['server-wins', 'local-wins', 'higher-version'];

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'manage', { type: 'sync' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need manage)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'push') {
      const ids = Array.isArray(b.objectIds) ? b.objectIds.map((x: any) => String(x)) : [];
      const n = await pushDirty(ids, user.id); return j({ ok: true, pushed: n });
    }
    if (b.action === 'resolve') {
      const objectId = String(b.objectId || ''); const policy: ConflictPolicy = POLICIES.includes(b.policy) ? b.policy : 'server-wins';
      if (!objectId) return j({ ok: false, error: 'objectId required' }, 400);
      const r = await resolveConflict(objectId, policy, user.id); return j({ ok: true, ...r });
    }
    if (b.action === 'flag') { await flagConflict(String(b.objectId || '')); return j({ ok: true }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
