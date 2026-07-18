// POST /api/admin/offline — offline policy (max package size). Gated via can(configure).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setPolicy } from '@/lib/offline-package';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'configure', { type: 'offline' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need configure)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const mb = Number(b.maxBytes);
  if (!Number.isFinite(mb) || mb < 65536) return j({ ok: false, error: 'maxBytes must be >= 65536' }, 400);
  try { await setPolicy(Math.floor(mb)); return j({ ok: true }); } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
