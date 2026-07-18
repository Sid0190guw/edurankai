// POST /api/admin/gamification — set XP values (Prompt 15). Gated by can(configure, gamification).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setXpConfig } from '@/lib/xp-ledger';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'configure', { type: 'gamification' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need configure)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try { await setXpConfig(b.values || {}); return j({ ok: true }); } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
