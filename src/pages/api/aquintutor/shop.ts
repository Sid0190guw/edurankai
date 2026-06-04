// POST /api/aquintutor/shop  { item: 'streak_freeze' | 'heart_refill', qty? }
// Spend XP on consumable items. Streak freezes (200 XP each, max 2) protect
// your streak through one missed day. Heart refill (50 XP) fills hearts to 5.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { getUserXp, awardXp } from '@/lib/xp';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const ITEMS: Record<string, { cost: number; max?: number; description: string }> = {
  streak_freeze: { cost: 200, max: 2, description: '1 streak freeze (protects streak through one missed day)' },
  heart_refill:  { cost: 50,            description: 'Refill hearts to 5' },
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const item = (body.item || '').toString();
  if (!(item in ITEMS)) return json({ ok: false, error: 'unknown item' }, 400);
  const def = ITEMS[item];

  const xp = await getUserXp(user.id);
  if (xp.totalXp < def.cost) return json({ ok: false, error: 'not enough XP', cost: def.cost, balance: xp.totalXp }, 402);

  if (item === 'streak_freeze') {
    const max = def.max || 2;
    if (xp.streakFreezes >= max) return json({ ok: false, error: 'inventory full', held: xp.streakFreezes, max }, 409);
    await db.execute(sql`UPDATE user_xp SET streak_freezes = LEAST(${max}, streak_freezes + 1), updated_at = NOW() WHERE user_id = ${user.id}`).catch(() => {});
  } else if (item === 'heart_refill') {
    await db.execute(sql`UPDATE user_xp SET hearts = 5, hearts_refilled_at = NOW(), updated_at = NOW() WHERE user_id = ${user.id}`).catch(() => {});
  }

  // Deduct via negative XP award so the audit trail captures it (and rollups stay correct)
  await awardXp({ userId: user.id, source: 'shop_purchase', delta: -def.cost, reason: 'Shop: ' + item });
  await db.execute(sql`INSERT INTO xp_shop_purchases (user_id, item, cost_xp) VALUES (${user.id}, ${item}, ${def.cost})`).catch(() => {});

  const fresh = await getUserXp(user.id);
  return json({ ok: true, item, cost: def.cost, balance: fresh.totalXp, streakFreezes: fresh.streakFreezes, hearts: fresh.hearts });
};
