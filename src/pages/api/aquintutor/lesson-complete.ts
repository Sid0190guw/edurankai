// POST /api/aquintutor/lesson-complete
// Body: { courseId, lessonId }
// Marks a lesson complete for the signed-in user, awards XP, recomputes the
// enrollment progress %, and if it hits 100% issues a course certificate.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { awardXp } from '@/lib/xp';
import { issueCertificate } from '@/lib/certificates';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try { await db.execute(sql`CREATE TABLE IF NOT EXISTS training_lesson_completions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL,
    lesson_id UUID NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, lesson_id))`); } catch (_) {}
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const courseId = (body.courseId || '').toString();
  const lessonId = (body.lessonId || '').toString();
  if (!courseId || !lessonId) return json({ ok: false, error: 'courseId + lessonId required' }, 400);

  await ensureSchema();
  // Insert completion idempotently
  const ins = await db.execute(sql`
    INSERT INTO training_lesson_completions (user_id, course_id, lesson_id)
    VALUES (${user.id}, ${courseId}, ${lessonId})
    ON CONFLICT (user_id, lesson_id) DO NOTHING
    RETURNING lesson_id
  `).catch(() => null);
  const wasNew = Array.isArray(ins) ? ins.length > 0 : ((ins as any)?.rows?.length || 0) > 0;

  let xpDelta = 0;
  if (wasNew) {
    xpDelta = 15; // 15 XP per lesson
    try { await awardXp({ userId: user.id, source: 'lesson_complete', refId: lessonId, delta: xpDelta, reason: 'Lesson completed' }); } catch (_) {}
  }

  // Recompute progress %
  const total = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM training_lessons WHERE course_id = ${courseId}`))[0]?.n || 0;
  const done = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM training_lesson_completions WHERE user_id = ${user.id} AND course_id = ${courseId}`))[0]?.n || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  try {
    await db.execute(sql`
      UPDATE training_enrollments SET progress_pct = ${pct}, last_lesson_id = ${lessonId}, last_accessed_at = NOW()
      WHERE user_id = ${user.id} AND course_id = ${courseId}
    `);
  } catch (_) {}

  // Issue certificate at 100%
  let certificate: any = null;
  if (pct >= 100) {
    try {
      const course = rows(await db.execute(sql`SELECT title FROM training_courses WHERE id = ${courseId} LIMIT 1`))[0] as any;
      const cert = await issueCertificate({
        userId: user.id,
        courseId,
        courseTitle: course?.title || 'EduRankAI course',
        grade: 'Pass',
      });
      certificate = cert;
      if (cert && !cert.alreadyIssued) {
        // 100 XP completion bonus on top
        await awardXp({ userId: user.id, source: 'course_complete', refId: courseId, delta: 100, reason: 'Course completed' }).catch(() => {});
        try {
          const { pushNotify } = await import('@/lib/push');
          const learner = (user as any).name || (user as any).email || 'A learner';
          const title = course?.title || 'an EduRankAI course';
          await pushNotify.courseCompleted(learner, title, cert.certNumber);
          await pushNotify.certificateIssued(user.id, title, cert.certNumber);
        } catch (_) {}
      }
    } catch (_) {}
  }

  return json({ ok: true, lessonId, completedNow: wasNew, progressPct: pct, xpAwarded: xpDelta, certificate });
};
