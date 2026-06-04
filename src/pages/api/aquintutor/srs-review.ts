// GET  /api/aquintutor/srs-review  — return up to 10 review questions due now
// POST /api/aquintutor/srs-review  { questionId, correct } — schedule next review
// SM-2 lite spaced repetition. Difficulty bucket: if correct → multiply
// interval by ease factor; if wrong → reset interval to 1 day.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS srs_review_queue (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question_id UUID NOT NULL,
      due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      interval_days INTEGER NOT NULL DEFAULT 1,
      ease_factor NUMERIC(4,2) NOT NULL DEFAULT 2.5,
      repetitions INTEGER NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, question_id))`);
  } catch (_) {}
}

export const GET: APIRoute = async ({ locals }) => {
  await ensureSchema();
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);

  // Backfill: pull recent wrong answers from user_question_history that aren't in queue
  try {
    await db.execute(sql`
      INSERT INTO srs_review_queue (user_id, question_id, due_at)
      SELECT h.user_id, h.question_id, NOW()
      FROM user_question_history h
      WHERE h.user_id = ${user.id} AND h.last_correct = false
        AND h.last_seen_at > NOW() - INTERVAL '30 days'
      ON CONFLICT (user_id, question_id) DO NOTHING
    `);
  } catch (_) {}

  const due = rows(await db.execute(sql`
    SELECT srs.question_id AS id, srs.repetitions, srs.interval_days, q.question_type, q.question_text,
           q.options, q.image_url, q.category, q.difficulty, q.marks
    FROM srs_review_queue srs JOIN test_questions q ON q.id = srs.question_id
    WHERE srs.user_id = ${user.id} AND srs.due_at <= NOW()
      AND q.is_active = true
      AND q.question_type IN ('mcq_single','mcq_multi','true_false','fill_in_blank','numeric')
    ORDER BY srs.due_at ASC LIMIT 10
  `));

  return json({ ok: true, questions: due });
};

export const POST: APIRoute = async ({ request, locals }) => {
  await ensureSchema();
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const questionId = (body.questionId || '').toString();
  const correct = !!body.correct;
  if (!questionId) return json({ ok: false, error: 'questionId required' }, 400);

  const r = rows(await db.execute(sql`SELECT * FROM srs_review_queue WHERE user_id = ${user.id} AND question_id = ${questionId} LIMIT 1`))[0] as any;
  if (!r) {
    await db.execute(sql`INSERT INTO srs_review_queue (user_id, question_id) VALUES (${user.id}, ${questionId}) ON CONFLICT DO NOTHING`).catch(() => {});
  }

  // SM-2 lite: correct → interval × ease; wrong → reset to 1 day
  let interval = correct ? Math.round((r?.interval_days || 1) * (parseFloat(r?.ease_factor || '2.5') || 2.5)) : 1;
  let ease = parseFloat(r?.ease_factor || '2.5') || 2.5;
  if (!correct) ease = Math.max(1.3, ease - 0.2);
  else ease = Math.min(3.0, ease + 0.05);
  const reps = correct ? (Number(r?.repetitions || 0) + 1) : 0;
  await db.execute(sql`
    UPDATE srs_review_queue SET
      interval_days = ${Math.max(1, interval)},
      ease_factor = ${ease},
      repetitions = ${reps},
      last_seen_at = NOW(),
      due_at = NOW() + (${Math.max(1, interval)} || ' days')::INTERVAL
    WHERE user_id = ${user.id} AND question_id = ${questionId}
  `).catch(() => {});

  if (correct) {
    try { const { awardXp } = await import('@/lib/xp'); await awardXp({ userId: user.id, source: 'srs_review', refId: questionId, delta: 3, reason: 'SRS review correct' }); } catch (_) {}
  }
  return json({ ok: true, intervalDays: interval, nextDue: new Date(Date.now() + interval * 86400000).toISOString() });
};
