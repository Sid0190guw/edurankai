// POST /api/help/send - visitor sends a message in their existing conversation.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const COOKIE_NAME = 'era_help_session';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

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
    } catch (_) {}
    try {
      const { sendEmail } = await import('@/lib/email');
      await sendEmail({
        to: 'hr@edurankai.in',
        subject: 'Help message from ' + (conv.visitor_name || 'a visitor'),
        html: '<p><strong>' + (conv.visitor_name || 'A visitor') + '</strong> wrote in the help chat:</p><blockquote>' + txt.replace(/[<>]/g, '') + '</blockquote><p><a href="https://edurankai.in/admin/help">Open the help inbox</a></p>',
        text: (conv.visitor_name || 'A visitor') + ': ' + txt + '\n\nOpen: https://edurankai.in/admin/help',
      });
    } catch (_) {}

    return json({ ok: true, message: mRows[0] });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
