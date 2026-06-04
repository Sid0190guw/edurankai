// GET /api/aquintutor/daily-challenge  — returns today's 7-question mix.
// POST /api/aquintutor/daily-challenge/complete  — body { sessionId } awards 50 XP bonus.
// The set is deterministic per day so all users see the same questions.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS daily_challenge_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      challenge_date DATE NOT NULL,
      questions_correct INTEGER NOT NULL DEFAULT 0,
      questions_attempted INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      bonus_awarded BOOLEAN NOT NULL DEFAULT false,
      UNIQUE(user_id, challenge_date))`);
  } catch (_) {}
}

export const GET: APIRoute = async ({ locals }) => {
  await ensureSchema();
  const user = (locals as any)?.user;

  // Stable daily seed: derive a deterministic seed from CURRENT_DATE.
  // We pull a random 7-question slice from published tests, biased toward
  // 1-mark objective questions for fast feedback. Using setseed for repeatability.
  let questions: any[] = [];
  try {
    const today = rows(await db.execute(sql`SELECT CURRENT_DATE::text AS d`))[0].d;
    // Seed PRNG between -1..1; map date to that range deterministically.
    const seedNum = parseInt(today.replace(/-/g, ''), 10) % 1000000;
    const seedFloat = (seedNum / 1000000.0) * 2 - 1; // -1..1
    await db.execute(sql.raw('SELECT setseed(' + seedFloat.toFixed(6) + ')'));
    questions = rows(await db.execute(sql`
      SELECT q.id, q.question_type, q.question_text, q.options, q.category, q.difficulty,
             q.image_url, q.marks, t.title AS test_title, t.slug AS test_slug
      FROM test_questions q JOIN tests t ON q.test_id = t.id
      WHERE t.is_published = true AND q.is_active = true
        AND q.question_type IN ('mcq_single','true_false','fill_in_blank','numeric')
      ORDER BY random() LIMIT 7
    `));
  } catch (_) {}

  // Check existing attempt for today
  let attempt: any = null;
  if (user) {
    try {
      attempt = rows(await db.execute(sql`
        SELECT id, questions_correct, questions_attempted, completed_at, bonus_awarded
        FROM daily_challenge_attempts
        WHERE user_id = ${user.id} AND challenge_date = CURRENT_DATE LIMIT 1
      `))[0] || null;
    } catch (_) {}
    if (!attempt) {
      try {
        attempt = rows(await db.execute(sql`
          INSERT INTO daily_challenge_attempts (user_id, challenge_date)
          VALUES (${user.id}, CURRENT_DATE) RETURNING id, questions_correct, questions_attempted, completed_at, bonus_awarded
        `))[0];
      } catch (_) {}
    }
  }

  return json({
    ok: true,
    date: rows(await db.execute(sql`SELECT CURRENT_DATE::text AS d`))[0].d,
    questions,
    attemptId: attempt?.id || null,
    alreadyCompleted: !!attempt?.completed_at,
    bonusAwarded: !!attempt?.bonus_awarded,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  await ensureSchema();
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const attemptId = (body.attemptId || '').toString();
  const correct = parseInt(body.correct || '0', 10);
  const attempted = parseInt(body.attempted || '0', 10);
  if (!attemptId) return json({ ok: false, error: 'attemptId required' }, 400);

  const att = rows(await db.execute(sql`SELECT bonus_awarded, completed_at FROM daily_challenge_attempts WHERE id = ${attemptId} AND user_id = ${user.id} LIMIT 1`))[0] as any;
  if (!att) return json({ ok: false, error: 'attempt not found' }, 404);

  await db.execute(sql`
    UPDATE daily_challenge_attempts SET
      questions_correct = ${correct}, questions_attempted = ${attempted},
      completed_at = NOW(), bonus_awarded = true
    WHERE id = ${attemptId}
  `);

  let xpDelta = 0;
  if (!att.bonus_awarded) {
    // Base: 5 XP per correct; +50 bonus if all 7 correct
    xpDelta = correct * 5 + (correct === 7 ? 50 : 0);
    try {
      const { awardXp } = await import('@/lib/xp');
      await awardXp({ userId: user.id, source: 'daily_challenge', refId: attemptId, delta: xpDelta, reason: 'Daily challenge ' + correct + '/' + attempted });
    } catch (_) {}
    // Notify the user so the daily completion shows up in the bell + toast
    try {
      const { sendPushToUser } = await import('@/lib/push');
      await sendPushToUser(user.id, {
        type: 'daily_done',
        title: 'Daily challenge complete',
        body: 'You scored ' + correct + '/' + attempted + ' today. ' + (correct === 7 ? '50 XP bonus added.' : 'Streak kept alive.'),
        url: '/aquintutor/daily',
        tag: 'daily-done-' + new Date().toISOString().slice(0, 10),
      });
    } catch (_) {}
  }
  return json({ ok: true, xpAwarded: xpDelta, perfect: correct === 7 });
};
