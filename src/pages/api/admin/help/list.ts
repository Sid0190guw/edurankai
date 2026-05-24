// GET /api/admin/help/list - list conversations for the admin inbox.
// ?status=open|closed|all (default open)
// ?unread=1 to filter only conversations with unread visitor messages
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
  const status = url.searchParams.get('status') || 'open';
  const unreadOnly = url.searchParams.get('unread') === '1';

  try {
    let rows: any[] = [];
    if (status === 'all') {
      const r = await db.execute(sql`
        SELECT c.id, c.visitor_name, c.visitor_email, c.visitor_path, c.status,
          c.message_count, c.unread_admin, c.last_message_at, c.last_message_by,
          c.last_message_preview, c.created_at,
          u.name as assigned_name
        FROM help_conversations c
        LEFT JOIN users u ON c.assigned_to = u.id
        ${unreadOnly ? sql`WHERE c.unread_admin > 0` : sql``}
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 200
      `);
      rows = (Array.isArray(r) ? r : (r?.rows || [])) as any[];
    } else {
      const r = await db.execute(sql`
        SELECT c.id, c.visitor_name, c.visitor_email, c.visitor_path, c.status,
          c.message_count, c.unread_admin, c.last_message_at, c.last_message_by,
          c.last_message_preview, c.created_at,
          u.name as assigned_name
        FROM help_conversations c
        LEFT JOIN users u ON c.assigned_to = u.id
        WHERE c.status = ${status} ${unreadOnly ? sql`AND c.unread_admin > 0` : sql``}
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 200
      `);
      rows = (Array.isArray(r) ? r : (r?.rows || [])) as any[];
    }

    // Unread total across open
    const cnt = await db.execute(sql`SELECT COUNT(*)::int as n FROM help_conversations WHERE status = 'open' AND unread_admin > 0`);
    const cntRows = Array.isArray(cnt) ? cnt : (cnt?.rows || []);
    const unreadCount = (cntRows[0] as any)?.n || 0;

    return json({ ok: true, conversations: rows, unreadCount });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
