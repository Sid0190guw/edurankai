// POST /api/discussion/post - create a new top-level post or reply.
// Body: { body, category?, parent_id? }
// Used by /portal/discussion's AJAX submit so the page doesn't reload.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
// postgres-js resolves to a plain array, never a { rows } object. Declared above the handler that
// reads them - `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason lives on e.cause; e.message is only the SQL that failed.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const txt = (body?.body || '').toString().trim();
  const category = (body?.category || 'general').toString().trim().slice(0, 50);
  const parentId = body?.parent_id ? body.parent_id.toString().trim() || null : null;

  if (!txt || txt.length < 3) return json({ ok: false, error: 'message too short (min 3 chars)' }, 400);
  if (txt.length > 10000) return json({ ok: false, error: 'message too long (max 10000)' }, 400);

  try {
    const r = await db.execute(sql`
      INSERT INTO discussions (user_id, body, category, parent_id)
      VALUES (${user.id}, ${txt}, ${category}, ${parentId})
      RETURNING id, body, category, parent_id, created_at
    `);
    const post = rowsOf(r)[0] as any;
    // An INSERT that returned no row means the post is not there. Reading `post.id` off undefined
    // threw into the catch below, which then handed the caller a TypeError as though it were a
    // database complaint; and had the shape ever been { rows }, ok:true would have been reported
    // over a post nobody would ever see.
    if (!post?.id) {
      console.error('[api/discussion/post] insert returned no row for user', String(user.id));
      return json({ ok: false, error: 'Your post was not saved. Nothing has been published; try again.' }, 500);
    }

    return json({
      ok: true,
      post: {
        id: post.id,
        body: post.body,
        category: post.category,
        parent_id: post.parent_id,
        created_at: post.created_at,
        author_name: user.name || user.email,
        author_role: user.role,
        reply_count: 0,
        reaction_count: 0,
      }
    });
  } catch (e: any) {
    // e.message on a drizzle/postgres-js error is the failed SQL STATEMENT - table and column names
    // handed to whoever posted - while the database's actual complaint sits unread on e.cause. A post
    // that was never created also left nothing behind for anyone asked about it afterwards.
    console.error('[api/discussion/post] insert failed for user', String(user?.id || ''), '-', reasonOf(e));
    return json({ ok: false, error: 'Your post was not saved. Nothing has been published; try again.' }, 500);
  }
};
