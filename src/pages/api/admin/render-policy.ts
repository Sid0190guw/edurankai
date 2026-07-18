// POST /api/admin/render-policy — set/clear a per-object render override (Prompt 5).
// Gated via can(user,'configure',{type:'rendering'}) (audited). Writes edu_render_overrides.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setOverride, clearOverride, type RenderDirective } from '@/lib/render-policy';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const decision = await can(user, 'configure', { type: 'rendering' });
  if (!decision.allow) return j({ ok: false, error: 'not permitted (need the configure capability)', reason: decision.reason }, 403);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const objectId = String(b.objectId || '');
  if (!objectId) return j({ ok: false, error: 'objectId required' }, 400);
  try {
    if (b.action === 'clear') { await clearOverride(objectId); return j({ ok: true }); }
    const d: Partial<RenderDirective> = {};
    if (Array.isArray(b.hydrate)) d.hydrate = b.hydrate.map((x: any) => String(x)).filter(Boolean);
    else if (typeof b.hydrate === 'string') d.hydrate = b.hydrate.split(',').map((x: string) => x.trim()).filter(Boolean);
    if (['none', 'basic', 'full'].includes(b.animation)) d.animation = b.animation;
    if (typeof b.physics === 'boolean') d.physics = b.physics;
    if (['none', 'ondemand', 'auto'].includes(b.audio)) d.audio = b.audio;
    if (b.imageMaxWidth) d.image = { maxWidth: Number(b.imageMaxWidth) || 720, format: (['avif', 'webp', 'jpeg'].includes(b.imageFormat) ? b.imageFormat : 'webp'), lazy: b.imageLazy !== false } as any;
    await setOverride(objectId, d);
    return j({ ok: true, directives: d });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
