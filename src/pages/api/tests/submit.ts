// src/pages/api/tests/submit.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    const body = await request.json();
    const { attemptId, answers, flagged } = body;

    if (!attemptId) {
      return new Response(JSON.stringify({ ok: false, error: 'attemptId required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get attempt + test
    const attR = await db.execute(sql`SELECT * FROM test_attempts WHERE id = ${attemptId} LIMIT 1`);
    const attRows = Array.isArray(attR) ? attR : (attR?.rows || []);
    const attempt = attRows[0] as any;
    if (!attempt) {
      return new Response(JSON.stringify({ ok: false, error: 'Attempt not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (attempt.status !== 'in_progress') {
      return new Response(JSON.stringify({ ok: false, error: 'Already submitted' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get all questions for this test
    const qR = await db.execute(sql`SELECT * FROM test_questions WHERE test_id = ${attempt.test_id} ORDER BY sort_order`);
    const questions = Array.isArray(qR) ? qR : (qR?.rows || []);

    // Auto-grade MCQs
    let totalScore = 0;
    let maxScore = 0;
    const sectionScores: Record<string, any> = {};

    for (const q of questions as any[]) {
      const userAns = (answers || {})[q.id];
      const correctAns = q.correct_answer;
      const marks = q.marks || 1;
      maxScore += marks;

      if (q.question_type === 'mcq_single' || q.question_type === 'true_false') {
        if (userAns !== undefined && userAns !== null && userAns === correctAns) {
          totalScore += marks;
        }
      } else if (q.question_type === 'mcq_multi') {
        if (Array.isArray(userAns) && Array.isArray(correctAns)) {
          const userSet = new Set(userAns);
          const correctSet = new Set(correctAns);
          if (userSet.size === correctSet.size && [...userSet].every(x => correctSet.has(x))) {
            totalScore += marks;
          }
        }
      }
      // Subjective + code: not auto-graded yet (pending AI grading)
    }

    const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

    // Get start time for duration
    const startedAt = new Date(attempt.started_at).getTime();
    const duration = Math.floor((Date.now() - startedAt) / 1000);

    // Update attempt
    await db.execute(sql`
      UPDATE test_attempts SET
        status = 'submitted',
        answers = ${JSON.stringify(answers || {})},
        flagged_questions = ${JSON.stringify(flagged || {})},
        total_score = ${totalScore},
        max_score = ${maxScore},
        percentage = ${percentage.toFixed(2)},
        duration_seconds = ${duration},
        submitted_at = NOW(),
        ip_address = ${clientAddress || null}
      WHERE id = ${attemptId}
    `);

    // Calculate percentile against other attempts
    try {
      const allR = await db.execute(sql`
        SELECT percentage FROM test_attempts WHERE test_id = ${attempt.test_id} AND status IN ('submitted','auto_submitted') AND percentage IS NOT NULL
      `);
      const allRows = Array.isArray(allR) ? allR : (allR?.rows || []);
      const scores = (allRows as any[]).map(r => parseFloat(r.percentage || '0')).sort((a, b) => a - b);
      if (scores.length > 0) {
        const below = scores.filter(s => s < percentage).length;
        const percentile = (below / scores.length) * 100;
        await db.execute(sql`UPDATE test_attempts SET percentile = ${percentile.toFixed(2)} WHERE id = ${attemptId}`);
      }
    } catch(e) {}

    return new Response(JSON.stringify({
      ok: true,
      score: totalScore,
      maxScore: maxScore,
      percentage: percentage.toFixed(1)
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};
