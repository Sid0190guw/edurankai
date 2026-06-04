// GET /api/aquintutor/learn/start?lesson=<id>
// Returns the lesson's exercises sanitized for client play.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const lessonId = (url.searchParams.get('lesson') || '').toString();
  if (!lessonId) return json({ ok: false, error: 'lesson required' }, 400);

  let lesson: any = null;
  try {
    lesson = rows(await db.execute(sql`
      SELECT l.id, l.course_id, l.title, l.xp_reward, c.title AS course_title, c.slug AS course_slug
      FROM training_lessons l LEFT JOIN training_courses c ON l.course_id = c.id
      WHERE l.id = ${lessonId} LIMIT 1
    `))[0];
  } catch (_) {}
  if (!lesson) return json({ ok: false, error: 'lesson not found' }, 404);

  const ex = rows(await db.execute(sql`
    SELECT id, sort_order, exercise_type, prompt, payload, accepted_answers, points
    FROM lesson_exercises
    WHERE lesson_id = ${lessonId} AND is_active = true
    ORDER BY sort_order ASC
  `));

  // Strip server-only fields. payload (options / pairs) IS shown to client.
  const sanitized = ex.map((e: any) => ({
    id: e.id,
    type: e.exercise_type,
    prompt: e.prompt,
    payload: e.payload,
    points: e.points,
  }));

  return json({ ok: true, lesson, exercises: sanitized });
};
