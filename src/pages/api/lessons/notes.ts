// /api/lessons/notes - GET fetch user's notes for a lesson, POST upsert.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  const url = new URL(request.url);
  const lessonId = url.searchParams.get('lesson_id');
  if (!lessonId) return json({ ok: false, error: 'lesson_id required' }, 400);
  try {
    const r = await db.execute(sql`
      SELECT id, body, created_at, updated_at FROM lesson_notes
      WHERE user_id = ${user.id} AND lesson_id = ${lessonId}
      ORDER BY created_at DESC LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return json({ ok: true, note: rows[0] || null });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const lessonId = String(body?.lesson_id || '').trim();
  const courseId = String(body?.course_id || '').trim() || null;
  const noteBody = String(body?.body || '').trim();
  if (!lessonId) return json({ ok: false, error: 'lesson_id required' }, 400);
  if (noteBody.length > 20000) return json({ ok: false, error: 'note too long (max 20k chars)' }, 400);

  try {
    // Upsert pattern: try to find existing first
    const existing = await db.execute(sql`
      SELECT id FROM lesson_notes WHERE user_id = ${user.id} AND lesson_id = ${lessonId} LIMIT 1
    `);
    const exRows = Array.isArray(existing) ? existing : (existing?.rows || []);
    if (exRows.length > 0) {
      if (!noteBody) {
        await db.execute(sql`DELETE FROM lesson_notes WHERE id = ${(exRows[0] as any).id}`);
        return json({ ok: true, deleted: true });
      }
      await db.execute(sql`
        UPDATE lesson_notes SET body = ${noteBody}, updated_at = NOW()
        WHERE id = ${(exRows[0] as any).id}
      `);
    } else if (noteBody) {
      await db.execute(sql`
        INSERT INTO lesson_notes (user_id, lesson_id, course_id, body)
        VALUES (${user.id}, ${lessonId}, ${courseId}, ${noteBody})
      `);
    }
    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
