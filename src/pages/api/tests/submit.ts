// src/pages/api/tests/submit.ts
//
// THE ONE THING THIS ROUTE OWES A CANDIDATE IS THAT THEIR PAPER IS RECORDED AND THEY ARE TOLD SO.
//
// Everything after the recording UPDATE — experience points, the admin notification, the re-rank,
// the percentile, the event-level artifacts — is bookkeeping. None of it changes what the candidate
// answered or what they scored. Yet all of it was awaited, unbounded, INSIDE the same invocation
// and BEFORE the response, so a single stalled connection anywhere in that tail killed the function
// at the gateway and the browser never received an answer.
//
// What that looked like from the candidate's chair: the paper WAS recorded, and the screen said
// "Submitting your test..." forever. There is no worse failure available on this route — the person
// has finished an examination and been given no evidence that it counted. The client had no
// .catch() on the fetch either, so a gateway timeout produced an unhandled rejection and not even
// an error message.
//
// So, in order:
//   1. Every read BEFORE the recording is bounded and retried. A stall there means the paper is
//      genuinely not recorded, and the honest answer is to say so and let the candidate press
//      Submit again — their answers are still in the tab.
//   2. The recording UPDATE is bounded and retried. It is idempotent (it sets a fixed row to fixed
//      values), so a retry cannot double-count anything.
//   3. After it succeeds NOTHING may fail the request. Each bookkeeping step is bounded at 2.5s so
//      a stall costs that step and not the invocation, and the outer guard returns ok:true even if
//      the whole tail throws — because by then the only true statement is that the paper is in.
//   4. An attempt that is ALREADY submitted answers ok:true, not an error. If the first submit
//      recorded the paper and only the response was lost, the retry must land the candidate on
//      their result page. Answering "Already submitted" as a failure told the one person who did
//      everything right that they had failed.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { attemptAccess } from '@/lib/auth/attempt-access';
import { withDbRetry, withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

/**
 * How long one piece of post-recording bookkeeping may take.
 *
 * Short on purpose and unrelated to DB_TIMEOUT_MS: the paper is already safe by the time any of
 * these run, so the only question left is how much of the invocation's remaining budget a stalled
 * one is allowed to burn before the candidate gets their confirmation.
 */
const BOOKKEEPING_MS = 2500;

/**
 * Run one post-recording step under a bound, and never let it fail the request.
 *
 * Replaces five `catch (_) {}` blocks. The catch was not wrong to swallow — none of this should
 * cost a candidate their confirmation — it was wrong to swallow SILENTLY and to be unbounded while
 * doing it, so a stalled re-rank both killed the invocation and left no trace of why.
 *
 * withDbTimeout sheds the WAIT and not the work: the statement keeps running and keeps its
 * connection until the server answers or PG_STATEMENT_TIMEOUT_MS ends it. That is the right trade
 * here and would not be for a read the page is waiting on — the candidate is not waiting on any of
 * this, and the alternative is the whole invocation waiting instead.
 */
async function bookkeep(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await withDbTimeout(run(), label, BOOKKEEPING_MS);
  } catch (e: any) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'tests.submit.bookkeeping_skipped',
      step: label, unavailable: isDbUnavailable(e),
      // e.cause carries the real Postgres reason; e.message is only the failed SQL.
      reason: e?.cause?.message || e?.message || 'unknown',
    }));
  }
}

export const POST: APIRoute = async ({ request, locals, cookies, clientAddress }) => {
  try {
    const body = await request.json();
    const { attemptId, answers, flagged } = body;

    if (!attemptId) {
      return new Response(JSON.stringify({ ok: false, error: 'attemptId required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Submits AND GRADES the attempt, awards XP against candidate_id and can auto-issue an event
    // artifact. It previously loaded any attempt by id and did all of that with no check that the
    // caller owned it. Authorised first, so the SELECT * below runs only for the person whose paper
    // it is (docs/workforce-os/AUTHORIZATION_FIRST.md: no query above the boundary).
    const access = await attemptAccess(String(attemptId), locals, cookies);
    if (!access.ok) {
      return new Response(JSON.stringify({ ok: false, error: access.error }), {
        status: access.status, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get attempt + test
    const attR = await withDbRetry(
      () => db.execute(sql`SELECT * FROM test_attempts WHERE id = ${access.attempt.id} LIMIT 1`),
      'tests.submit.attempt');
    const attRows = Array.isArray(attR) ? attR : (attR?.rows || []);
    const attempt = attRows[0] as any;
    if (!attempt) {
      return new Response(JSON.stringify({ ok: false, error: 'Attempt not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (attempt.status !== 'in_progress') {
      // ok:true, NOT an error. The overwhelmingly likely way to arrive here is a retry after a first
      // submit whose response was lost — the paper is recorded, and the candidate must be sent to
      // their result page rather than told that submitting failed. A genuine double-tap lands here
      // too and gets the same correct answer.
      return new Response(JSON.stringify({ ok: true, alreadySubmitted: true, attemptId }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get questions for this test. If the attempt was served a subset
    // (question pool), grade ONLY the served questions so max score matches.
    const qR = await withDbRetry(
      () => db.execute(sql`SELECT * FROM test_questions WHERE test_id = ${attempt.test_id} ORDER BY sort_order`),
      'tests.submit.questions');
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
      const tr = await withDbRetry(
        () => db.execute(sql`SELECT negative_mark_fraction FROM tests WHERE id = ${attempt.test_id} LIMIT 1`),
        'tests.submit.negativeFraction');
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
      } else if (q.question_type === 'short_answer' || q.question_type === 'fill_in_blank') {
        // Accept any of `accepted_answers` (jsonb array) OR the single correct_answer.
        // Case + leading/trailing whitespace insensitive; treat multiple spaces as one.
        objective = q.question_type === 'fill_in_blank'; // negative-marking eligible for fill-in only
        const norm = (s: any) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
        const candidate = norm(userAns);
        const accepted: string[] = [];
        let acceptedRaw: any = q.accepted_answers;
        if (typeof acceptedRaw === 'string') { try { acceptedRaw = JSON.parse(acceptedRaw); } catch { acceptedRaw = []; } }
        if (Array.isArray(acceptedRaw)) for (const a of acceptedRaw) { const n = norm(a); if (n) accepted.push(n); }
        const single = Array.isArray(correctAns) ? correctAns[0] : correctAns;
        if (single != null && String(single).trim() !== '') {
          const n = norm(single); if (n && !accepted.includes(n)) accepted.push(n);
        }
        if (candidate && accepted.length) correct = accepted.includes(candidate);
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

    // ── THE RECORDING. Everything above decides what to write; this is the write. ──────────────
    //
    // Bounded and retried like the reads, and idempotent in the strict sense: it sets one known row
    // to values computed entirely before it runs, so running it twice leaves exactly what running it
    // once leaves. That is what makes a retry safe here — it is not a general licence to retry a
    // write, it is a property of this particular statement.
    await withDbRetry(() => db.execute(sql`
      UPDATE test_attempts SET
        status = 'submitted',
        answers = ${JSON.stringify(answers || {})},
        flagged_questions = ${JSON.stringify(flagged || {})},
        total_score = ${totalScore},
        auto_score = ${totalScore},
        max_score = ${maxScore},
        percentage = ${percentage.toFixed(2)},
        negative_marks = ${negativeTotal.toFixed(2)},
        duration_seconds = ${duration},
        submitted_at = NOW(),
        ip_address = ${clientAddress || null}
      WHERE id = ${attemptId}
    `), 'tests.submit.record');

    // FROM HERE THE PAPER IS IN. Nothing below may fail this request.
    //
    // Every step after this point is bookkeeping that does not change what the candidate answered or
    // what they scored, and each one used to be an unbounded await before the response — so any one
    // of them stalling killed the invocation and left the candidate staring at "Submitting your
    // test..." over a paper that had already been recorded.
    const recorded = true;

    // Award XP if this is an official, signed-in attempt. Practice attempts
    // award XP through the practice endpoint instead.
    await bookkeep('tests.submit.xp', async () => {
      if (attempt.candidate_id && (attempt.mode || 'official') === 'official') {
        const { awardXp } = await import('@/lib/xp');
        const baseXp = Math.max(10, Math.round(totalScore * 5)); // 5 XP per mark, min 10
        const bonus = percentage >= 90 ? 30 : percentage >= 75 ? 15 : 0;
        const delta = baseXp + bonus;
        await awardXp({
          userId: attempt.candidate_id,
          source: 'test_official',
          refId: attempt.id,
          delta,
          reason: 'Official test submitted (' + Math.round(percentage) + '%)',
        });
        await db.execute(sql`UPDATE test_attempts SET xp_awarded = ${delta} WHERE id = ${attemptId}`).catch(() => {});
      }
    });

    // Notify admins that an official test was submitted (so the bell + inbox
    // light up for HR / reviewers — currently only "new user" events surface).
    await bookkeep('tests.submit.notify', async () => {
      if ((attempt.mode || 'official') === 'official') {
        const tt = await db.execute(sql`SELECT title FROM tests WHERE id = ${attempt.test_id} LIMIT 1`);
        const ttRows = Array.isArray(tt) ? tt : (tt?.rows || []);
        const testTitle = (ttRows[0] as any)?.title || 'a test';
        const candidateName = attempt.candidate_name || attempt.candidate_email || 'A candidate';
        const { pushNotify } = await import('@/lib/push');
        await pushNotify.testSubmitted(candidateName, testTitle + ' (' + Math.round(percentage) + '%)', '/admin/tests/attempts');
      }
    });

    // Auto-rank all graded attempts for this test by score (ties broken by
    // faster duration). Ranks are computed automatically from scores so the
    // ordering is objective; the candidate only sees it once results are
    // released/declared (see the result page + admin declare action).
    // ONE STATEMENT, NOT ONE PER CANDIDATE.
    //
    // This selected every submitted attempt and then issued a separate UPDATE for each one, in a
    // sequential await loop, on EVERY submission. The cost is not the SQL — each of those updates is
    // trivial — it is that every awaited round trip holds a pooler connection for ~140ms across the
    // network. A test with five hundred attempts meant the five-hundredth candidate's submit held a
    // connection for something like seventy seconds while it rewrote a rank onto every row.
    //
    // On a pool of five per instance against a shared pooler, that is not a slow endpoint. It is an
    // outage: one candidate pressing Submit starves every other page on the site of connections, and
    // the swallowing catch below meant it never appeared as an error anywhere. This is the largest
    // single contributor found in the round-trip audit.
    //
    // ROW_NUMBER() over the same ORDER BY produces exactly the ranks the loop produced, and the
    // UPDATE ... FROM applies all of them at once. `IS DISTINCT FROM` skips rows whose rank has not
    // changed, which on a re-rank is most of them — fewer dead tuples for autovacuum to chase, and
    // it is null-safe in a way `<>` is not.
    await bookkeep('tests.submit.rank', async () => {
      await db.execute(sql`
        UPDATE test_attempts t
           SET rank = r.rn
          FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     ORDER BY percentage DESC NULLS LAST,
                              duration_seconds ASC NULLS LAST,
                              submitted_at ASC
                   )::int AS rn
              FROM test_attempts
             WHERE test_id = ${attempt.test_id}
               AND status IN ('submitted','auto_submitted')
          ) r
         WHERE t.id = r.id
           AND t.rank IS DISTINCT FROM r.rn
      `);
    });

    // Calculate percentile against other attempts
    // Counted in the database instead of shipped to the function and sorted there. This pulled every
    // percentage on the test across the network to compute one number from them — the transfer is
    // connection time, and on a popular test it is the whole cohort every time somebody submits.
    // Same arithmetic: strictly-below over the count of non-null percentages, to two decimals. The
    // NULLIF keeps a division by zero from turning an empty cohort into an error, and the outer
    // guard keeps the write off the row entirely when there is nothing to compare against.
    await bookkeep('tests.submit.percentile', async () => {
      await db.execute(sql`
        UPDATE test_attempts SET percentile = sub.pct
          FROM (
            SELECT ROUND(
                     100.0 * COUNT(*) FILTER (WHERE percentage < ${percentage})
                     / NULLIF(COUNT(*), 0), 2) AS pct
              FROM test_attempts
             WHERE test_id = ${attempt.test_id}
               AND status IN ('submitted','auto_submitted')
               AND percentage IS NOT NULL
          ) sub
         WHERE test_attempts.id = ${attemptId}
           AND sub.pct IS NOT NULL
      `);
    });

    // Event-series hook: if this test gates one or more event levels and the
    // candidate is registered, record per-level pass/fail and auto-issue.
    // Bounded as ONE step rather than per statement: it loops over levels and issues artifacts, so
    // the thing worth capping is the whole tail, not each round trip inside it. A level that is not
    // recorded here is recoverable from the attempt row; a candidate with no confirmation is not.
    await bookkeep('tests.submit.eventLevels', async () => {
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
    });

    return new Response(JSON.stringify({
      ok: true,
      recorded,
      score: totalScore,
      maxScore: maxScore,
      percentage: percentage.toFixed(1)
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    // WHAT THE CANDIDATE IS TOLD WHEN THIS FAILS, AND WHY IT IS NOT `e.message`.
    //
    // Reaching here means the paper was NOT recorded — every path after the recording is inside
    // bookkeep(), which cannot throw. So the honest answer is that nothing was saved and they should
    // press Submit again, and the client keeps their answers in the tab for exactly that.
    //
    // `retryable` separates "ask again, it will probably work" from "something is actually wrong",
    // because an unreachable database on this route is the first case and the client should say so
    // rather than implying the candidate did something wrong. e.cause carries the real Postgres
    // reason; e.message is only the failed SQL, which is also why it was never fit to show anybody.
    const unavailable = isDbUnavailable(e);
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'error', event: 'tests.submit.failed',
      unavailable, reason: e?.cause?.message || e?.message || 'unknown',
    }));
    return new Response(JSON.stringify({
      ok: false,
      recorded: false,
      retryable: true,
      error: unavailable
        ? 'Your answers were NOT saved - the database did not respond. They are still held in this tab, so press Submit again.'
        : 'Your answers were NOT saved. They are still held in this tab, so press Submit again.',
    }), {
      status: unavailable ? 503 : 500,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
    });
  }
};
