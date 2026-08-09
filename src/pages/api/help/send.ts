// POST /api/help/send - visitor sends a message in their existing conversation.
//
// THREE BARE CATCHES SAT ON THE ONLY THREE WAYS ANYBODY LEARNS A PERSON IS WAITING. Browser push,
// the email to the desk and the in-app notifier were each wrapped in a catch that discarded the
// error and continued to `ok: true`. A wrong SMTP password, a missing VAPID key or a notifications
// table that never got its columns therefore produced exactly the same observable result as a
// working system - a visitor told their message was sent, and a support inbox nobody was told to
// open. Nothing recorded the attempt, so there was no way to find it short of noticing the silence.
//
// They stay best-effort, deliberately: the message is committed BEFORE any of this runs, and losing
// a person's message because a mail server is down would be a worse bug than the one being fixed.
// What changes is that each failure is now written down with the reason the database or the mailer
// actually gave.
//
// The catch-all also stopped returning `e.message` to the visitor. That string is the failed SQL.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';

// Declared above the handler that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const COOKIE_NAME = 'era_help_session';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(COOKIE_NAME)?.value;
  if (!token) return json({ ok: false, error: 'no session - call /api/help/start first' }, 400);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const txt = (body?.body || '').toString().trim();
  if (!txt) return json({ ok: false, error: 'message required' }, 400);
  if (txt.length > 5000) return json({ ok: false, error: 'message too long (max 5000)' }, 400);

  try {
    const c = await db.execute(sql`SELECT id, visitor_name FROM help_conversations WHERE visitor_token = ${token} AND status = 'open' LIMIT 1`);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    if (cRows.length === 0) return json({ ok: false, error: 'conversation not found or closed' }, 404);
    const conv = cRows[0] as any;

    const m = await db.execute(sql`
      INSERT INTO help_messages (conversation_id, sender_role, sender_name, body)
      VALUES (${conv.id}, 'visitor', ${conv.visitor_name || null}, ${txt})
      RETURNING id, sender_role, sender_name, body, created_at
    `);
    const mRows = Array.isArray(m) ? m : (m?.rows || []);

    await db.execute(sql`
      UPDATE help_conversations SET
        message_count = message_count + 1,
        unread_admin = unread_admin + 1,
        last_message_at = NOW(),
        last_message_by = 'visitor',
        last_message_preview = ${txt.substring(0, 200)},
        updated_at = NOW()
      WHERE id = ${conv.id}
    `);

    // Notify admins immediately - help messages must never sit unseen.
    try {
      const { sendPushToAdmins } = await import('@/lib/push');
      await sendPushToAdmins({
        type: 'help_message',
        title: 'Help message: ' + (conv.visitor_name || 'visitor'),
        body: txt.slice(0, 160),
        url: '/admin/help',
        tag: 'help-' + conv.id,
      });
    } catch (e: any) {
      logEvent('error', 'help.send.push-failed', { conversationId: String(conv.id), message: reasonOf(e) });
    }
    try {
      const { sendEmail } = await import('@/lib/email');
      await sendEmail({
        to: 'hr@edurankai.in',
        subject: 'Help message from ' + (conv.visitor_name || 'a visitor'),
        html: '<p><strong>' + (conv.visitor_name || 'A visitor') + '</strong> wrote in the help chat:</p><blockquote>' + txt.replace(/[<>]/g, '') + '</blockquote><p><a href="https://edurankai.in/admin/help">Open the help inbox</a></p>',
        text: (conv.visitor_name || 'A visitor') + ': ' + txt + '\n\nOpen: https://edurankai.in/admin/help',
      });
    } catch (e: any) {
      logEvent('error', 'help.send.email-failed', { conversationId: String(conv.id), message: reasonOf(e) });
    }
    try {
      const { notifyAllAdmins } = await import('@/lib/notify');
      await notifyAllAdmins({ title: 'Help message from ' + (conv.visitor_name || 'a visitor'), body: txt.slice(0, 160), type: 'message', actionUrl: '/admin/help', entityType: 'help_conversation', entityId: conv.id });
    } catch (e: any) {
      logEvent('error', 'help.send.notify-failed', { conversationId: String(conv.id), message: reasonOf(e) });
    }

    return json({ ok: true, message: mRows[0] });
  } catch (e: any) {
    logEvent('error', 'help.send.failed', { message: reasonOf(e) });
    return json({ ok: false, error: 'That message could not be sent just now. Please try again.' }, 500);
  }
};
