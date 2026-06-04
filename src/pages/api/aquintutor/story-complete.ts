// POST /api/aquintutor/story-complete  { storyId, correct, total }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { awardXp } from '@/lib/xp';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const storyId = (body.storyId || '').toString();
  if (!storyId) return json({ ok: false, error: 'storyId required' }, 400);
  const correct = parseInt(body.correct || '0', 10);
  const total = parseInt(body.total || '0', 10);

  try {
    const s = rows(await db.execute(sql`SELECT xp_reward FROM stories WHERE id = ${storyId} LIMIT 1`))[0] as any;
    const baseXp = Number(s?.xp_reward || 30);
    // Only award once
    const existing = rows(await db.execute(sql`SELECT 1 FROM story_completions WHERE user_id = ${user.id} AND story_id = ${storyId} LIMIT 1`));
    if (existing[0]) return json({ ok: true, xpAwarded: 0, alreadyDone: true });

    await db.execute(sql`
      INSERT INTO story_completions (user_id, story_id, questions_correct, questions_total)
      VALUES (${user.id}, ${storyId}, ${correct}, ${total})
      ON CONFLICT (user_id, story_id) DO NOTHING
    `);
    const bonus = (total > 0 && correct === total) ? Math.round(baseXp * 0.5) : 0;
    const totalXp = baseXp + bonus;
    await awardXp({ userId: user.id, source: 'story_complete', refId: storyId, delta: totalXp, reason: 'Story finished (' + correct + '/' + total + ')' });
    return json({ ok: true, xpAwarded: totalXp, perfect: correct === total });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
