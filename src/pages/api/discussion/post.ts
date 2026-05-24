// POST /api/discussion/post - create a new top-level post or reply.
// Body: { body, category?, parent_id? }
// Used by /portal/discussion's AJAX submit so the page doesn't reload.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

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
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    const post = rows[0] as any;

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
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
