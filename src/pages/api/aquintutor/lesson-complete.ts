// POST /api/aquintutor/lesson-complete
// Body: { courseId, lessonId }
//
// Marks a lesson complete for the signed-in user and awards XP.
//
// THE PROGRESS ARITHMETIC IS NO LONGER HERE, and that is the point of this change. This route used
// to count training_lesson_completions, divide by the lesson count, and write the result into
// training_enrollments.progress_pct — while /portal/courses/[slug] counted a DIFFERENT table,
// training_progress, and wrote the SAME column. Two denominators, no reader in common: finish four
// of five lessons here (80%), then mark one lesson done in the portal player, and the stored figure
// became 20%. Nothing threw. The employee learning path, which reads that column, then reported the
// wrong number to a manager.
//
// Both players now call recordLessonComplete() in src/lib/learning-progress.ts. It counts every
// completion table together, writes the percentage once, writes completed_at — which nothing in this
// repository wrote before, so a finished course stayed "in progress" on the employee surface forever
// — and issues the certificate through the hash-chained ledger in src/lib/certificates.ts.
//
// XP STAYS HERE. It is this surface's concern, it has its own once-only key, and moving it into the
// shared writer would have given the portal player an XP behaviour nobody asked for.
import type { APIRoute } from 'astro';
import { awardXp } from '@/lib/xp';
import { recordLessonComplete } from '@/lib/learning-progress';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const courseId = (body.courseId || '').toString();
  const lessonId = (body.lessonId || '').toString();
  if (!lessonId) return json({ ok: false, error: 'lessonId required' }, 400);

  // The single writer. It resolves the course FROM THE LESSON, so a caller that posts an empty
  // courseId (aquintutor/learn/[lesson].astro does) still files the completion under the right one.
  const res = await recordLessonComplete({
    userId: String(user.id),
    courseId: courseId || null,
    lessonId,
    source: 'aquintutor',
  });

  // A write that failed is reported as a failure. This route used to swallow both the completion
  // insert and the percentage update and return ok:true regardless, so a learner could be told
  // "Completed" over work that was never recorded.
  if (!res.ok) return json({ ok: false, error: res.error || 'That did not save.' }, 500);

  let xpDelta = 0;
  if (res.completedNow) {
    xpDelta = 15; // 15 XP per lesson
    try {
      await awardXp({ userId: user.id, source: 'lesson_complete', refId: lessonId, delta: xpDelta, reason: 'Lesson completed' });
    } catch (e: any) {
      // The lesson IS recorded; missing XP is not a reason to tell somebody their work did not save.
      // Logged with the real Postgres reason rather than dropped.
      console.error('[lesson-complete] awardXp', e?.cause?.message || e?.message);
      xpDelta = 0;
    }
  }

  if (res.courseCompletedNow) {
    try {
      await awardXp({ userId: user.id, source: 'course_complete', refId: res.progress?.courseId || courseId, delta: 100, reason: 'Course completed' });
    } catch (e: any) {
      console.error('[lesson-complete] awardXp course', e?.cause?.message || e?.message);
    }
    try {
      const { pushNotify } = await import('@/lib/push');
      const learner = (user as any).name || (user as any).email || 'A learner';
      const title = res.certificate?.courseTitle || 'a course on EduRankAI';
      if (res.certificate) {
        await pushNotify.courseCompleted(learner, title, res.certificate.certNumber);
        await pushNotify.certificateIssued(user.id, title, res.certificate.certNumber);
      }
    } catch (e: any) {
      console.error('[lesson-complete] notify', e?.cause?.message || e?.message);
    }
  }

  return json({
    ok: true,
    lessonId,
    completedNow: res.completedNow,
    progressPct: res.progress?.pct ?? 0,
    lessonsCompleted: res.progress?.completedLessons ?? 0,
    totalLessons: res.progress?.totalLessons ?? 0,
    xpAwarded: xpDelta,
    certificate: res.certificate,
  });
};
