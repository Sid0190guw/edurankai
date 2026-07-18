// POST /api/admin/campus — edit facilities/institutional info (Prompt 21). Gated by can(configure).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { saveFacility } from '@/lib/hub';
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'configure', { type: 'campus' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need configure)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const key = String(b.key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!key || !b.title) return j({ ok: false, error: 'key + title required' }, 400);
  try { await saveFacility(key, String(b.title), String(b.body || ''), Number(b.sort) || 0); return j({ ok: true }); }
  catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
