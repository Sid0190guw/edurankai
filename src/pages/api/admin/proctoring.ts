// POST /api/admin/proctoring — proctoring policy (which event types are enabled). Gated by
// can(configure, proctoring) (audited). Advisory pipeline — this only tunes what is recorded.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setEnabledTypes, EVENT_TYPES } from '@/lib/proctor';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'configure', { type: 'proctoring' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need configure)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  if (b.action !== 'setPolicy') return j({ ok: false, error: 'unknown action' }, 400);
  const types = Array.isArray(b.enabledTypes) ? b.enabledTypes.filter((t: any) => (EVENT_TYPES as readonly string[]).includes(String(t))) : [];
  try { await setEnabledTypes(types); return j({ ok: true }); } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
