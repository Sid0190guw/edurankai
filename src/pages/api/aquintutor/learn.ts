// POST /api/aquintutor/learn — persist learning progress for the signed-in
// learner. actions: profile | progress | verify | teachback.
import type { APIRoute } from 'astro';
import { saveProfile, setMastery, logVerify, logTeachback, TIER_IDS } from '@/lib/aquintutor-learn';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const action = b.action;
  try {
    if (action === 'profile') {
      const tier = TIER_IDS.includes(b.tier) ? b.tier : 'primary';
      await saveProfile(user.id, { tier, goal: (b.goal || '').toString().slice(0, 200), dailyLimitMin: b.dailyLimitMin ? Number(b.dailyLimitMin) : null });
      return json({ ok: true });
    }
    const skillId = (b.skillId || '').toString().slice(0, 80);
    if (!skillId) return json({ ok: false, error: 'skillId required' }, 400);
    if (action === 'progress') {
      await setMastery(user.id, skillId, b.state === 'mastered' ? 'mastered' : 'growing', !!b.verified);
      return json({ ok: true });
    }
    if (action === 'verify') {
      await logVerify(user.id, skillId, !!b.verified);
      if (b.verified) await setMastery(user.id, skillId, 'mastered', true);
      return json({ ok: true });
    }
    if (action === 'teachback') {
      await logTeachback(user.id, skillId, Number(b.matched) || 0, Number(b.total) || 0, (b.transcript || '').toString());
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500);
  }
};
