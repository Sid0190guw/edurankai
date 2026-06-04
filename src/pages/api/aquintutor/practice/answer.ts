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
    const q = rows(await db.execute(sql`
      SELECT id, question_type, options, correct_answer, accepted_answers, answer_tolerance, explanation, marks
      FROM test_questions WHERE id = ${questionId} LIMIT 1
    `))[0] as any;
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
