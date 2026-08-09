// GET /api/admin/help/list - list conversations for the admin inbox.
// ?status=open|closed|all (default open)
// ?unread=1 to filter only conversations with unread visitor messages
//
// The failure path handed the caller `e.message` - the failed SQL, not a sentence anybody can act on
// - which is the same leak its sibling thread.ts already closed. The reason goes to the log; the
// inbox gets something it can print.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { logEvent } from '@/lib/logger';

// Declared above the handler that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ request, locals }) => {
  // The whole applicant support inbox. middleware.ts:50 maps /admin/help to the `messages` section,
  // so that is what this asks for — before the first SELECT, not after it.
  const denied = await denyAdminApi(locals, { section: 'messages', action: 'view', label: 'help.list' });
  if (denied) return denied;

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
    logEvent('error', 'help.list.failed', { message: reasonOf(e) });
    return json({ ok: false, error: 'The support inbox could not be read just now.' }, 500);
  }
};
