// GET /api/help/poll?since=<iso>
// Returns messages newer than `since` for the visitor's conversation.
// Marks unread_visitor = 0 (visitor read everything).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const COOKIE_NAME = 'era_help_session';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(COOKIE_NAME)?.value;
  if (!token) return json({ ok: true, messages: [], unread: 0 }); // no session = no chat
  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z';

  try {
    const c = await db.execute(sql`SELECT id, unread_visitor, status, assigned_to FROM help_conversations WHERE visitor_token = ${token} LIMIT 1`);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    if (cRows.length === 0) return json({ ok: true, messages: [], unread: 0 });
    const conv = cRows[0] as any;

    const m = await db.execute(sql`
      SELECT id, sender_role, sender_name, body, created_at
      FROM help_messages
      WHERE conversation_id = ${conv.id} AND created_at > ${since}::timestamptz
      ORDER BY created_at ASC LIMIT 100
    `);
    const messages = Array.isArray(m) ? m : (m?.rows || []);

    // If admin messages arrived, clear unread for visitor on poll
    const hasAdminInNew = (messages as any[]).some((x: any) => x.sender_role === 'admin');
    if (hasAdminInNew && conv.unread_visitor > 0) {
      await db.execute(sql`UPDATE help_conversations SET unread_visitor = 0 WHERE id = ${conv.id}`);
    }

    return json({
      ok: true,
      messages,
      unread: conv.unread_visitor,
      status: conv.status,
      assigned: !!conv.assigned_to,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
