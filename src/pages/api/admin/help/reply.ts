// POST /api/admin/help/reply
// Body: { conversationId, body, closeAfter? }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);

  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const conversationId = (body?.conversationId || '').toString();
  const txt = (body?.body || '').toString().trim();
  const closeAfter = !!body?.closeAfter;

  if (!conversationId) return json({ ok: false, error: 'conversationId required' }, 400);
  if (!txt) return json({ ok: false, error: 'message body required' }, 400);
  if (txt.length > 5000) return json({ ok: false, error: 'too long (max 5000)' }, 400);

  try {
    const c = await db.execute(sql`SELECT id FROM help_conversations WHERE id = ${conversationId} LIMIT 1`);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    if (cRows.length === 0) return json({ ok: false, error: 'conversation not found' }, 404);

    const m = await db.execute(sql`
      INSERT INTO help_messages (conversation_id, sender_role, sender_name, sender_user_id, body)
      VALUES (${conversationId}, 'admin', ${user.name || null}, ${user.id}, ${txt})
      RETURNING id, sender_role, sender_name, body, created_at
    `);
    const mRows = Array.isArray(m) ? m : (m?.rows || []);

    await db.execute(sql`
      UPDATE help_conversations SET
        message_count = message_count + 1,
        unread_admin = 0,
        unread_visitor = unread_visitor + 1,
        last_message_at = NOW(),
        last_message_by = 'admin',
        last_message_preview = ${txt.substring(0, 200)},
        assigned_to = COALESCE(assigned_to, ${user.id}),
        ${closeAfter ? sql`status = 'closed',` : sql``}
        updated_at = NOW()
      WHERE id = ${conversationId}
    `);

    return json({ ok: true, message: mRows[0] });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
