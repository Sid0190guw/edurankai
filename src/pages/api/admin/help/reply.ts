// POST /api/admin/help/reply
// Body: { conversationId, body, closeAfter?, reopen? }
//
// REOPEN NOW EXISTS, AND THAT IS THE DEFECT THIS REVISION CLOSES.
//
// /admin/help renders a "Reopen" button next to "Close". Both called this endpoint; only one of them
// meant anything. `closeAfter` set status='closed' and there was no path back, so Reopen posted the
// line "(Conversation reopened)" into the thread, got `ok: true` — because the REPLY had genuinely
// been written — and the client did `location.reload()` on that success. The page came back with the
// conversation still closed, no error anywhere, and a message in the transcript telling the visitor
// it had been reopened when it had not. The visitor, meanwhile, cannot send: /api/help/send.ts:23
// matches on `status = 'open'` and answers "conversation not found or closed" to anything else.
//
// That is the exact shape this sweep is for — a control with nothing behind it (E) reporting success
// (C) — and it is repaired rather than reported, because it adds no authority to anyone: the
// capability that may close a conversation is `messages` edit, this is the same endpoint and the
// same gate, and reopening is the inverse of a power that was already held. Nobody gains a reach
// they did not have; a button stops lying.
//
// `closeAfter` and `reopen` are mutually exclusive and are rejected together rather than silently
// resolved in one direction — an ambiguous instruction about whether a person can still reach
// support should not be guessed at.
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

export const POST: APIRoute = async ({ request, locals }) => {
  // Writes a reply AS the company to a member of the public, so this is `messages` edit.
  const denied = await denyAdminApi(locals, { section: 'messages', action: 'edit', label: 'help.reply' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const conversationId = (body?.conversationId || '').toString();
  const txt = (body?.body || '').toString().trim();
  const closeAfter = !!body?.closeAfter;
  const reopen = !!body?.reopen;

  if (!conversationId) return json({ ok: false, error: 'conversationId required' }, 400);
  if (!txt) return json({ ok: false, error: 'message body required' }, 400);
  if (txt.length > 5000) return json({ ok: false, error: 'too long (max 5000)' }, 400);
  if (closeAfter && reopen) {
    return json({ ok: false, error: 'closeAfter and reopen cannot both be set' }, 400);
  }

  // Built before the statement that carries it. An empty fragment leaves the status column alone,
  // which is what an ordinary reply does.
  const statusChange = closeAfter
    ? sql`status = 'closed',`
    : (reopen ? sql`status = 'open',` : sql``);

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

    // RETURNING is what proves the UPDATE matched. Without it a status change against a row that
    // vanished between the SELECT above and here would report success having changed nothing —
    // which is the failure this file was opened to remove, so it is not reintroduced one line down.
    const upd = await db.execute(sql`
      UPDATE help_conversations SET
        message_count = message_count + 1,
        unread_admin = 0,
        unread_visitor = unread_visitor + 1,
        last_message_at = NOW(),
        last_message_by = 'admin',
        last_message_preview = ${txt.substring(0, 200)},
        assigned_to = COALESCE(assigned_to, ${user.id}),
        ${statusChange}
        updated_at = NOW()
      WHERE id = ${conversationId}
      RETURNING status
    `);
    const uRows = Array.isArray(upd) ? upd : (upd?.rows || []);
    if (uRows.length === 0) {
      logEvent('error', 'help.reply.conversation-vanished', { conversationId, userId: user?.id || null });
      return json({ ok: false, error: 'the reply was saved but the conversation could not be updated' }, 500);
    }

    return json({ ok: true, message: mRows[0], status: (uRows[0] as any)?.status });
  } catch (e: any) {
    logEvent('error', 'help.reply.failed', { conversationId, userId: user?.id || null, message: reasonOf(e) });
    return json({ ok: false, error: 'that reply could not be saved' }, 500);
  }
};
