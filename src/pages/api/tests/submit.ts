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

    // Get questions for this test. If the attempt was served a subset
    // (question pool), grade ONLY the served questions so max score matches.
    const qR = await db.execute(sql`SELECT * FROM test_questions WHERE test_id = ${attempt.test_id} ORDER BY sort_order`);
    let questions = Array.isArray(qR) ? qR : (qR?.rows || []);
    let served: any = attempt.served_question_ids;
    if (typeof served === 'string') { try { served = JSON.parse(served); } catch { served = null; } }
    if (Array.isArray(served) && served.length > 0) {
      const set = new Set(served.map((x: any) => String(x)));
      questions = (questions as any[]).filter((q: any) => set.has(String(q.id)));
    }

    // Auto-grade. Negative marking applies to wrong objective answers only
    // (never to blanks), per the test's negative_mark_fraction.
    let totalScore = 0;
    let maxScore = 0;
    let negativeTotal = 0;
    const sectionScores: Record<string, any> = {};

    // The negative-marking fraction lives on the test row.
    let negativeFraction = 0;
    try {
      const tr = await db.execute(sql`SELECT negative_mark_fraction FROM tests WHERE id = ${attempt.test_id} LIMIT 1`);
      const trRows = Array.isArray(tr) ? tr : (tr?.rows || []);
      negativeFraction = Math.max(0, Math.min(1, parseFloat(trRows[0]?.negative_mark_fraction ?? '0') || 0));
    } catch (_) {}

    function isBlankAns(v: any) { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0); }
    function numClose(a: number, b: number, tol: number) { return Math.abs(a - b) <= (tol || 0); }

    for (const q of questions as any[]) {
      const userAns = (answers || {})[q.id];
      const correctAns = q.correct_answer;
      const marks = q.marks || 1;
      maxScore += marks;
      if (isBlankAns(userAns)) continue; // blanks never penalised

      let correct = false;
      let objective = false; // eligible for negative marking
      if (q.question_type === 'mcq_single' || q.question_type === 'true_false') {
        objective = true;
        correct = userAns === correctAns;
      } else if (q.question_type === 'mcq_multi') {
        objective = true;
        const userSet = new Set(Array.isArray(userAns) ? userAns : []);
        const correctSet = new Set(Array.isArray(correctAns) ? correctAns : []);
        correct = userSet.size === correctSet.size && [...userSet].every(x => correctSet.has(x));
      } else if (q.question_type === 'numeric' || q.question_type === 'calculative') {
        objective = true;
        const ua = parseFloat(String(userAns));
        const ca = parseFloat(String(Array.isArray(correctAns) ? correctAns[0] : correctAns));
        if (!isNaN(ua) && !isNaN(ca)) correct = numClose(ua, ca, parseFloat(q.answer_tolerance ?? '0') || 0);
      } else if (q.question_type === 'short_answer') {
        // Auto-grade only when a model answer exists; case/space-insensitive.
        const ca = Array.isArray(correctAns) ? correctAns[0] : correctAns;
        if (ca != null && String(ca).trim() !== '') {
          correct = String(userAns).trim().toLowerCase() === String(ca).trim().toLowerCase();
        }
      }
      // long_answer, code, file_upload, video: pending manual/AI grading.

      if (correct) totalScore += marks;
      else if (objective && negativeFraction > 0) { const pen = marks * negativeFraction; totalScore -= pen; negativeTotal += pen; }
    }
    if (totalScore < 0) totalScore = 0;

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
        negative_marks = ${negativeTotal.toFixed(2)},
        duration_seconds = ${duration},
        submitted_at = NOW(),
        ip_address = ${clientAddress || null}
      WHERE id = ${attemptId}
    `);

    // Auto-rank all graded attempts for this test by score (ties broken by
    // faster duration). Ranks are computed automatically from scores so the
    // ordering is objective; the candidate only sees it once results are
    // released/declared (see the result page + admin declare action).
    try {
      const ar = await db.execute(sql`
        SELECT id FROM test_attempts
        WHERE test_id = ${attempt.test_id} AND status IN ('submitted','auto_submitted')
        ORDER BY percentage DESC NULLS LAST, duration_seconds ASC NULLS LAST, submitted_at ASC
      `);
      const arRows = Array.isArray(ar) ? ar : (ar?.rows || []);
      for (let i = 0; i < arRows.length; i++) {
        await db.execute(sql`UPDATE test_attempts SET rank = ${i + 1} WHERE id = ${(arRows[i] as any).id}`);
      }
    } catch (_) {}

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

    // Event-series hook: if this test gates one or more event levels and the
    // candidate is registered, record per-level pass/fail and auto-issue.
    try {
      if (attempt.candidate_id) {
        const lvR = await db.execute(sql`SELECT id, event_id, pass_mark, auto_issue_artifact FROM event_levels WHERE test_id = ${attempt.test_id} AND is_active = true`);
        const lvRows = Array.isArray(lvR) ? lvR : (lvR?.rows || []);
        for (const lv of lvRows as any[]) {
          const regR = await db.execute(sql`SELECT id FROM event_registrations WHERE event_id = ${lv.event_id} AND user_id = ${attempt.candidate_id} LIMIT 1`);
          const regRows = Array.isArray(regR) ? regR : (regR?.rows || []);
          const reg: any = regRows[0];
          if (!reg) continue;
          const passed = lv.pass_mark != null ? percentage >= Number(lv.pass_mark) : true;
          const newStatus = passed ? 'passed' : 'failed';
          await db.execute(sql`
            INSERT INTO event_level_progress (registration_id, level_id, event_id, status, score, test_attempt_id)
            VALUES (${reg.id}, ${lv.id}, ${lv.event_id}, ${newStatus}, ${percentage.toFixed(2)}, ${attemptId})
            ON CONFLICT (registration_id, level_id) DO UPDATE SET status = ${newStatus}, score = ${percentage.toFixed(2)}, test_attempt_id = ${attemptId}, updated_at = NOW()
          `);
          if (passed && lv.auto_issue_artifact) {
            const { issueArtifact } = await import('@/lib/issue-artifact');
            await issueArtifact({ registrationId: reg.id, eventId: lv.event_id, levelId: lv.id, artifactType: lv.auto_issue_artifact, autoIssued: true });
          }
        }
      }
    } catch (e2: any) { console.error('[tests] event level auto-issue failed:', e2?.message); }

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
