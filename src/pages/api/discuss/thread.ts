// /api/discuss/thread - POST creates a new thread on a course.
// Body: { course_id, title, body, kind?, lesson_id? }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const KINDS = new Set(['question', 'discussion', 'announcement']);

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const courseId = String(body?.course_id || '').trim();
  const lessonId = body?.lesson_id ? String(body.lesson_id).trim() : null;
  const title = String(body?.title || '').trim();
  const txt = String(body?.body || '').trim();
  const kind = KINDS.has(String(body?.kind || '')) ? String(body.kind) : 'question';
  // Only staff can post announcements
  const isStaff = user.role && user.role !== 'applicant';
  const finalKind = (kind === 'announcement' && !isStaff) ? 'question' : kind;

  if (!courseId) return json({ ok: false, error: 'course_id required' }, 400);
  if (!title || title.length < 5) return json({ ok: false, error: 'title required (5+ chars)' }, 400);
  if (title.length > 300) return json({ ok: false, error: 'title too long (max 300)' }, 400);
  if (!txt || txt.length < 10) return json({ ok: false, error: 'body required (10+ chars)' }, 400);
  if (txt.length > 20000) return json({ ok: false, error: 'body too long (max 20k)' }, 400);

  try {
    const r = await db.execute(sql`
      INSERT INTO course_discussions (course_id, lesson_id, user_id, title, body, kind)
      VALUES (${courseId}, ${lessonId}, ${user.id}, ${title}, ${txt}, ${finalKind})
      RETURNING id
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return json({ ok: true, id: (rows[0] as any)?.id });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
