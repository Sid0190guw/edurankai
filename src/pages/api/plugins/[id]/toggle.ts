// POST /api/plugins/[id]/toggle — Block 09: enable/disable a plugin (per institution).
import type { APIRoute } from 'astro';
import { requireCapability, ForbiddenError } from '@/lib/rbac';
import { getPlugin, setPluginEnabled } from '@/lib/plugins';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const id = String(params.id || '');
  if (!getPlugin(id)) return j({ ok: false, error: 'unknown plugin' }, 404);
  try { await requireCapability(user, 'configure', { id, type: 'plugin' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const enabled = !!b.enabled;
  const institutionId = b.institutionId ? String(b.institutionId) : undefined;
  await setPluginEnabled(id, enabled, institutionId);
  return j({ ok: true, enabled });
};
