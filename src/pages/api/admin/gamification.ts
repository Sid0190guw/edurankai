// POST /api/admin/gamification — set XP values (Prompt 15). Gated by can(configure, gamification).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setXpConfig } from '@/lib/xp';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'configure', { type: 'gamification' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need configure)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  // setXpConfig REPORTS failure rather than throwing, so 'Saved.' on the screen means stored.
  try {
    const saved = await setXpConfig(b.values || {});
    return saved ? j({ ok: true }) : j({ ok: false, error: 'the XP values could not be stored' }, 200);
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200);
  }
};
