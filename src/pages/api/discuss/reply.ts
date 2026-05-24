// /api/discuss/reply - POST adds a reply to a thread.
// Body: { thread_id, body }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const threadId = String(body?.thread_id || '').trim();
  const txt = String(body?.body || '').trim();

  if (!threadId) return json({ ok: false, error: 'thread_id required' }, 400);
  if (!txt || txt.length < 2) return json({ ok: false, error: 'body required' }, 400);
  if (txt.length > 20000) return json({ ok: false, error: 'body too long (max 20k)' }, 400);

  try {
    await db.execute(sql`
      INSERT INTO course_discussion_replies (discussion_id, user_id, body)
      VALUES (${threadId}, ${user.id}, ${txt})
    `);
    await db.execute(sql`
      UPDATE course_discussions
      SET reply_count = reply_count + 1, last_reply_at = NOW(), updated_at = NOW()
      WHERE id = ${threadId}
    `);
    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
