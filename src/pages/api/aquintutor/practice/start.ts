// POST /api/aquintutor/practice/start
// Body: { testSlug, n? }  — n = number of questions to fetch (default 10, max 20)
// Returns a question batch sanitised (no correct_answer leaked) + a session id
// so subsequent /answer calls can be tied to one practice run.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { targetDifficultyFromHistory } from '@/lib/irt';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const slug = (body.testSlug || '').toString().trim();
  const want = Math.max(3, Math.min(20, parseInt(body.n || '10', 10) || 10));
  if (!slug) return json({ ok: false, error: 'testSlug required' }, 400);

  try {
    const t = rows(await db.execute(sql`
      SELECT id, slug, title, COALESCE(practice_enabled, true) AS practice_enabled
      FROM tests WHERE slug = ${slug} AND is_published = true LIMIT 1
    `))[0] as any;
    if (!t) return json({ ok: false, error: 'Test not found or unpublished' }, 404);
    if (!t.practice_enabled) return json({ ok: false, error: 'Practice mode is disabled for this test' }, 403);

    // Adaptive sampling via Item Response Theory: estimate the learner's ability
    // (theta) from their real answer history — each past response paired with that
    // question's empirical difficulty — then target the difficulty that is MAXIMALLY
    // INFORMATIVE at their ability (for the 2PL that is difficulty == ability). This
    // replaces the old "miss-rate + 0.1" heuristic with a real psychometric estimate.
    // De-prioritises recently-seen questions and falls back to 0.5 when no history.
    let targetDifficulty = 0.5;
    let abilityTheta: number | null = null;
    if (user) {
      try {
        const hist = rows(await db.execute(sql`
          SELECT h.last_correct, COALESCE(s.empirical_difficulty, 0.5)::float8 AS emp
          FROM user_question_history h
          LEFT JOIN question_stats s ON s.question_id = h.question_id
          WHERE h.user_id = ${user.id} AND h.last_seen_at > NOW() - INTERVAL '30 days'
          ORDER BY h.last_seen_at DESC
          LIMIT 40
        `)).map((r: any) => ({ correct: !!r.last_correct, emp: Number(r.emp) }));
        if (hist.length) {
          const est = targetDifficultyFromHistory(hist);
          targetDifficulty = est.targetDifficulty;
          abilityTheta = est.theta;
        }
      } catch (_) {}
    }

    const qs = rows(await db.execute(sql`
      SELECT q.id, q.question_type, q.question_text, q.options, q.correct_answer,
             q.accepted_answers, q.answer_tolerance,
             q.image_url, q.category, q.difficulty, q.marks, q.explanation,
             COALESCE(s.empirical_difficulty, 0.5) AS emp_diff,
             COALESCE(h.last_seen_at, NOW() - INTERVAL '365 days') AS last_seen
      FROM test_questions q
      LEFT JOIN question_stats s ON s.question_id = q.id
      LEFT JOIN user_question_history h ON h.question_id = q.id AND h.user_id = ${user?.id || null}
      WHERE q.test_id = ${t.id} AND q.is_active = true
        AND q.question_type IN ('mcq_single','mcq_multi','true_false','fill_in_blank','numeric')
      ORDER BY
        -- score = absolute distance from target + recency bonus + jitter
        ABS(COALESCE(s.empirical_difficulty, 0.5) - ${targetDifficulty}::numeric)
        + CASE WHEN h.last_seen_at IS NULL THEN 0 ELSE GREATEST(0.0, 0.5 - EXTRACT(EPOCH FROM (NOW() - h.last_seen_at)) / 86400.0 / 14.0) END
        + (random() * 0.15) ASC
      LIMIT ${want}
    `));
    if (qs.length === 0) return json({ ok: false, error: 'No practice questions configured yet' }, 503);

    let sessionId: string | null = null;
    if (user) {
      try {
        const ins = rows(await db.execute(sql`
          INSERT INTO practice_sessions (user_id, test_id, questions_attempted, questions_correct)
          VALUES (${user.id}, ${t.id}, 0, 0) RETURNING id
        `));
        sessionId = ins[0]?.id || null;
      } catch (_) {}
    }

    // Strip correct_answer + accepted_answers before sending to client.
    const out = qs.map((q: any) => ({
      id: q.id,
      question_type: q.question_type,
      question_text: q.question_text,
      options: q.options,
      image_url: q.image_url,
      category: q.category,
      difficulty: q.difficulty,
      marks: q.marks,
    }));

    return json({ ok: true, sessionId, testTitle: t.title, questions: out, ability: abilityTheta, targetDifficulty });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
