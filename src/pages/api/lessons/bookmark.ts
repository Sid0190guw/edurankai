// /api/lessons/bookmark - POST toggles a bookmark on a lesson.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const lessonId = String(body?.lesson_id || '').trim();
  const courseId = String(body?.course_id || '').trim() || null;
  if (!lessonId) return json({ ok: false, error: 'lesson_id required' }, 400);

  try {
    const exist = await db.execute(sql`
      SELECT 1 FROM lesson_bookmarks WHERE user_id = ${user.id} AND lesson_id = ${lessonId} LIMIT 1
    `);
    const rows = Array.isArray(exist) ? exist : (exist?.rows || []);
    if (rows.length > 0) {
      await db.execute(sql`DELETE FROM lesson_bookmarks WHERE user_id = ${user.id} AND lesson_id = ${lessonId}`);
      return json({ ok: true, bookmarked: false });
    }
    await db.execute(sql`
      INSERT INTO lesson_bookmarks (user_id, lesson_id, course_id) VALUES (${user.id}, ${lessonId}, ${courseId})
      ON CONFLICT DO NOTHING
    `);
    return json({ ok: true, bookmarked: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  const url = new URL(request.url);
  const lessonId = url.searchParams.get('lesson_id');
  if (!lessonId) return json({ ok: false, error: 'lesson_id required' }, 400);
  try {
    const r = await db.execute(sql`SELECT 1 FROM lesson_bookmarks WHERE user_id = ${user.id} AND lesson_id = ${lessonId} LIMIT 1`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return json({ ok: true, bookmarked: rows.length > 0 });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
