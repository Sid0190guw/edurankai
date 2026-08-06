// GET /api/admin/help/thread?id=<conversationId>
// Returns the conversation + messages. Marks unread_admin = 0.
//
// IT NO LONGER RETURNS `c.*`, AND THAT IS THE POINT OF THIS REVISION.
//
// `help_conversations.visitor_token` is not a display field — it is the visitor's ONLY credential.
// src/pages/api/help/send.ts:23, /api/help/poll.ts:21 and /api/help/start.ts:41 each identify a
// visitor by nothing but that string, read from the `era_help_session` cookie that start.ts sets
// with `httpOnly: false`. The token IS the session: whoever holds it can read that visitor's whole
// conversation and post messages that arrive in the inbox under the visitor's own name.
//
// `SELECT c.*` put that token into a JSON body on a five-second poll — into devtools, into any
// proxy log, into anything reading responses in the browser — as a side effect of opening the
// support inbox. Nothing on this screen has ever used it: /admin/help renders visitor_name, email,
// phone, dob, path, message_count and status, and the polling client reads only `messages`.
//
// So the columns are named one at a time. A column added to help_conversations tomorrow is then not
// published by accident, which is the property `SELECT *` cannot have.
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
// The real Postgres reason lives on e.cause; e.message is only the SQL that failed.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ request, locals }) => {
  // Reads one visitor's support conversation. Same section as the inbox it opens from.
  const denied = await denyAdminApi(locals, { section: 'messages', action: 'view', label: 'help.thread' });
  if (denied) return denied;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  try {
    const c = await db.execute(sql`
      SELECT c.id, c.visitor_name, c.visitor_email, c.visitor_phone, c.visitor_dob,
             c.visitor_path, c.user_id, c.status, c.assigned_to,
             c.message_count, c.unread_admin, c.unread_visitor,
             c.last_message_at, c.last_message_by, c.last_message_preview,
             c.created_at, c.updated_at,
             u.name AS assigned_name
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
    // The database's own words go to the log, not to the caller: the failed SQL is not a sentence
    // an admin can act on, and it describes the schema to anyone who can reach this URL.
    logEvent('error', 'help.thread.read-failed', { id, message: reasonOf(e) });
    return json({ ok: false, error: 'that conversation could not be read' }, 500);
  }
};
