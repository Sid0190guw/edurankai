// POST /api/aquintutor/daily-goal  { goal: number 10-200 }
import type { APIRoute } from 'astro';
import { setDailyGoal, getUserXp } from '@/lib/xp';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const goal = parseInt(body?.goal || '30', 10);
  if (!Number.isFinite(goal) || goal < 10 || goal > 200) return json({ ok: false, error: 'goal must be 10–200' }, 400);
  await setDailyGoal(user.id, goal);
  const xp = await getUserXp(user.id);
  return json({ ok: true, dailyGoalXp: xp.dailyGoalXp, todayXp: xp.todayXp });
};
