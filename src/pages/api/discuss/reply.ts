// /api/discuss/reply - POST adds a reply to a course discussion thread.
// Body: { thread_id, body }
//
// TWO THINGS WERE WRONG HERE.
//
// 1. IT NEVER CHECKED THAT THE THREAD EXISTED. The INSERT named `discussion_id = <whatever was
//    posted>` and the follow-up `UPDATE course_discussions ... WHERE id = <the same>` matched zero
//    rows when it did not. Both statements "succeeded", the endpoint answered `ok: true`, and the
//    caller's reply was written against an id nothing renders — a reply nobody will ever read,
//    reported as posted. The thread is resolved first now, and a reply to something that is not
//    there is refused instead of stored somewhere invisible.
//
// 2. THE DATABASE'S OWN WORDS WENT TO THE CALLER. `e?.message` on a drizzle/postgres-js error is the
//    failed SQL, not the reason — so the response described this project's schema to anyone signed
//    in, and the actual Postgres message (which lives on `e.cause`) was written down nowhere at all.
//
// The reply and the counter are still two statements. They are ordered so the failure that remains
// possible is the harmless one: if the counter update throws, the reply is already stored and
// visible, and the count is one behind until the next reply corrects it. The reverse order would
// lose the reply. A transaction would be better and is a change to how this module talks to the
// database rather than a fix to this handler; it is named here rather than smuggled in.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';

// Declared above the handler that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
// postgres-js resolves to a plain array, never a { rows } object.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason lives on e.cause; e.message is only the SQL that failed.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

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
    const thread = rowsOf(await db.execute(sql`SELECT id FROM course_discussions WHERE id = ${threadId} LIMIT 1`))[0] as any;
    if (!thread) return json({ ok: false, error: 'that discussion no longer exists' }, 404);

    const inserted = rowsOf(await db.execute(sql`
      INSERT INTO course_discussion_replies (discussion_id, user_id, body)
      VALUES (${threadId}, ${user.id}, ${txt})
      RETURNING id
    `))[0] as any;
    if (!inserted?.id) {
      // NOT reported as success. An INSERT that returned no row means the reply is not there, and a
      // posted reply that never appears is the failure this file was opened to remove.
      logEvent('error', 'discuss.reply.insert-empty', { threadId, userId: String(user.id) });
      return json({ ok: false, error: 'your reply was not saved' }, 500);
    }

    await db.execute(sql`
      UPDATE course_discussions
      SET reply_count = reply_count + 1, last_reply_at = NOW(), updated_at = NOW()
      WHERE id = ${threadId}
    `);
    return json({ ok: true, id: inserted.id });
  } catch (e: any) {
    logEvent('error', 'discuss.reply.failed', { threadId, userId: String(user?.id || ''), message: reasonOf(e) });
    return json({ ok: false, error: 'your reply could not be saved' }, 500);
  }
};
