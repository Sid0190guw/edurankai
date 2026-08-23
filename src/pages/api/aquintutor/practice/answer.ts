// POST /api/aquintutor/practice/answer
// Body: { sessionId?, questionId, answer }
// Grades a single answer server-side and returns whether it was correct + the
// model answer + explanation so the practice runner can show instant feedback.
// Awards XP per correct answer (signed-in users).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { awardXp } from '@/lib/xp';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }
function normTxt(s: any) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const questionId = (body.questionId || '').toString();
  const sessionId = (body.sessionId || '').toString();
  if (!questionId) return json({ ok: false, error: 'questionId required' }, 400);

  try {
    // question_text / category / the CURRENT empirical difficulty come along for the AquinTutor Mind
    // event below — read here so the capture costs no extra query, and read BEFORE the stats update
    // so the difficulty recorded is the one this learner actually faced.
    // =============================================================================================
    // THE SAME GATE ITS OWN SIBLING ALREADY APPLIES, AND WITHOUT IT THIS WAS THE ANSWER KEY
    // =============================================================================================
    //
    // test_questions is not a practice bank. It is THE question table — /admin/tests/[id] writes
    // into it, attempts are marked from it, and q.correct_answer is the mark scheme. This lookup
    // used to match on the question id ALONE, and the route has no authentication of any kind
    // (`user` below is only used to award XP and record events, never to authorise). So an
    // unauthenticated POST of any question id came back with correct_answer, accepted_answers and
    // explanation — for a live, proctored, unpublished assessment as readily as for a practice set.
    // A candidate sitting a test in another tab could read the mark scheme one question at a time.
    //
    // practice/start.ts, which hands OUT the questions, has always required the parent test to be
    // `is_published = true` AND practice-enabled, and it strips correct_answer before replying. The
    // door that gives feedback simply never asked. The rule is not new and is not widened here — it
    // is the same rule, applied at the second door. A question the practice runner may legitimately
    // serve still grades exactly as before; a question belonging to a live or unpublished test is
    // no longer gradeable at this URL.
    const q = rows(await db.execute(sql`
      SELECT q.id, q.question_type, q.options, q.correct_answer, q.accepted_answers, q.answer_tolerance,
             q.explanation, q.marks, q.question_text, q.category,
             COALESCE(s.empirical_difficulty, 0.5)::float8 AS emp_diff
      FROM test_questions q
      JOIN tests t ON t.id = q.test_id
      LEFT JOIN question_stats s ON s.question_id = q.id
      WHERE q.id = ${questionId}
        AND q.is_active = true
        AND t.is_published = true
        AND COALESCE(t.practice_enabled, true) = true
      LIMIT 1
    `))[0] as any;
    // Deliberately the SAME answer for "no such question" and "that question is not practisable":
    // telling the two apart is how somebody maps which ids belong to a live assessment.
    if (!q) return json({ ok: false, error: 'Question not found' }, 404);

    const u = body.answer;
    let correct = false;
    const c = q.correct_answer;
    let modelAnswer: any = c;

    if (q.question_type === 'mcq_single' || q.question_type === 'true_false') {
      correct = u === c;
      const opts = Array.isArray(q.options) ? q.options : [];
      const found = opts.find((o: any, i: number) => i === c || o?.id === c);
      modelAnswer = found ? (found.text || found) : c;
    } else if (q.question_type === 'mcq_multi') {
      const uSet = new Set(Array.isArray(u) ? u : []);
      const cSet = new Set(Array.isArray(c) ? c : []);
      correct = uSet.size === cSet.size && [...uSet].every(x => cSet.has(x));
      modelAnswer = Array.isArray(c) ? c.map((i: any) => (q.options || [])[i]?.text || i).join(', ') : c;
    } else if (q.question_type === 'fill_in_blank' || q.question_type === 'short_answer') {
      const cand = normTxt(u);
      const accepted: string[] = [];
      let raw: any = q.accepted_answers;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
      if (Array.isArray(raw)) for (const a of raw) { const n = normTxt(a); if (n) accepted.push(n); }
      const single = Array.isArray(c) ? c[0] : c;
      if (single != null && String(single).trim() !== '') {
        const n = normTxt(single); if (n && !accepted.includes(n)) accepted.push(n);
      }
      correct = cand !== '' && accepted.includes(cand);
      modelAnswer = (single ?? accepted[0] ?? '').toString();
    } else if (q.question_type === 'numeric') {
      const ua = parseFloat(String(u));
      const ca = parseFloat(String(Array.isArray(c) ? c[0] : c));
      const tol = parseFloat(q.answer_tolerance ?? '0') || 0;
      correct = !isNaN(ua) && !isNaN(ca) && Math.abs(ua - ca) <= tol;
      modelAnswer = Array.isArray(c) ? c[0] : c;
    }

    let xpDelta = 0;
    if (user && correct) {
      xpDelta = (q.marks || 1) * 2; // 2 XP per mark for practice
      try { await awardXp({ userId: user.id, source: 'test_practice', refId: questionId, delta: xpDelta, reason: 'Practice answer' }); } catch (_) {}
    }

    // Record question stats for adaptive practice (best-effort, ignore errors
    // on cold schema).
    try {
      const isBlank = u == null || u === '' || (Array.isArray(u) && u.length === 0);
      await db.execute(sql`
        INSERT INTO question_stats (question_id, times_shown, times_correct, times_blank, empirical_difficulty)
        VALUES (${questionId}, 1, ${correct ? 1 : 0}, ${isBlank ? 1 : 0}, ${correct ? 0 : 1}::numeric)
        ON CONFLICT (question_id) DO UPDATE SET
          times_shown = question_stats.times_shown + 1,
          times_correct = question_stats.times_correct + ${correct ? 1 : 0},
          times_blank = question_stats.times_blank + ${isBlank ? 1 : 0},
          empirical_difficulty = CASE
            WHEN (question_stats.times_shown + 1) > 0
            THEN 1.0 - ((question_stats.times_correct + ${correct ? 1 : 0})::numeric / (question_stats.times_shown + 1)::numeric)
            ELSE 0.5 END,
          updated_at = NOW()
      `).catch(() => {});
      if (user) {
        await db.execute(sql`
          INSERT INTO user_question_history (user_id, question_id, last_seen_at, times_seen, last_correct)
          VALUES (${user.id}, ${questionId}, NOW(), 1, ${correct})
          ON CONFLICT (user_id, question_id) DO UPDATE SET
            last_seen_at = NOW(),
            times_seen = user_question_history.times_seen + 1,
            last_correct = ${correct}
        `).catch(() => {});
      }
    } catch (_) {}

    // AquinTutor Mind (src/lib/mind): attach the outcome to the moment this question was shown.
    // This is the supervised half of the corpus — one graded moment, in the situation it happened in.
    if (user) {
      try {
        const { recordOutcome } = await import('@/lib/mind/store');
        const blank = u == null || u === '' || (Array.isArray(u) && u.length === 0);
        await recordOutcome({
          userKey: user.id, label: correct ? 1 : 0, labelSource: 'outcome',
          signals: {
            itemKey: questionId, conceptKey: String(q.category || 'practice'), itemType: String(q.question_type || ''),
            difficulty: Number(q.emp_diff ?? 0.5), marks: Number(q.marks || 1), blank,
            text: String(q.question_text || '').slice(0, 300), atMs: Date.now(),
          },
        });
      } catch (e: any) { console.error('[practice/answer] mind capture:', e?.cause?.message || e?.message); }
    }

    // Update practice session counters
    if (sessionId) {
      try {
        await db.execute(sql`
          UPDATE practice_sessions SET
            questions_attempted = questions_attempted + 1,
            questions_correct = questions_correct + ${correct ? 1 : 0},
            xp_earned = xp_earned + ${xpDelta}
          WHERE id = ${sessionId}
        `);
      } catch (_) {}
    }

    return json({
      ok: true,
      correct,
      modelAnswer,
      explanation: q.explanation || null,
      xpDelta,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
