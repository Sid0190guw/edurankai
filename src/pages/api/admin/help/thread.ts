// GET /api/admin/help/thread?id=<conversationId>
// Returns full conversation + messages. Marks unread_admin = 0.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  try {
    const c = await db.execute(sql`
      SELECT c.*, u.name as assigned_name
      FROM help_conversations c
      LEFT JOIN users u ON c.assigned_to = u.id
      WHERE c.id = ${id} LIMIT 1
    `);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    if (cRows.length === 0) return json({ ok: false, error: 'not found' }, 404);
    const conv = cRows[0];

    const m = await db.execute(sql`
      SELECT id, sender_role, sender_name, sender_user_id, body, created_at
      FROM help_messages WHERE conversation_id = ${id}
      ORDER BY created_at ASC LIMIT 500
    `);
    const messages = Array.isArray(m) ? m : (m?.rows || []);

    // Clear admin unread on view
    await db.execute(sql`UPDATE help_conversations SET unread_admin = 0 WHERE id = ${id}`);

    return json({ ok: true, conversation: conv, messages });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
