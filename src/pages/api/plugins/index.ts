// GET /api/plugins — Block 09: list plugins + their per-institution enabled state.
import type { APIRoute } from 'astro';
import { requireCapability, ForbiddenError } from '@/lib/rbac';
import { allPlugins, listPluginState } from '@/lib/plugins';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  try { await requireCapability(user, 'configure', { type: 'plugin' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }

  const state = await listPluginState();
  const enabled = new Map(state.map((s) => [s.pluginId, s.enabled]));
  const plugins = allPlugins().map((p) => ({
    id: p.id, subject: p.subject, version: p.version, conceptDomains: p.conceptDomains,
    subtypes: p.objectSubtypes.map((s) => `${s.kernelType}/${s.subtype}`),
    scenePacks: (p.scenePacks ?? []).map((sp) => sp.id),
    enabled: enabled.get(p.id) ?? true,
  }));
  return j({ ok: true, plugins });
};
