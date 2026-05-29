// POST /api/mail/draft - save or delete a draft.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { deliverMessage, parseAddressList, getMailboxAddress } from '@/lib/mail';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  try {
    if (body.action === 'delete') {
      if (!body.draftId) return json({ ok: false, error: 'draftId required' }, 400);
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${user.id} AND message_id = ${body.draftId} AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${body.draftId} AND is_draft = true`);
      return json({ ok: true });
    }

    // Replace existing draft (simplest: delete old, create new)
    if (body.draftId) {
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${user.id} AND message_id = ${body.draftId} AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${body.draftId} AND is_draft = true`);
    }

    const fromEmail = await getMailboxAddress(user.id);
    const fromName = user.name || fromEmail;
    let bodyText = (body.bodyText ?? body.body ?? '').toString();
    let bodyHtml = (body.bodyHtml || '').toString();
    if (!bodyHtml) bodyHtml = '<div>' + escapeHtml(bodyText).replace(/\n/g, '<br/>') + '</div>';

    const result = await deliverMessage({
      fromUserId: user.id, fromEmail, fromName,
      to: parseAddressList(body.to), cc: parseAddressList(body.cc), bcc: parseAddressList(body.bcc),
      subject: (body.subject || '').toString().slice(0, 500),
      bodyHtml, bodyText,
      threadId: body.threadId || null,
      asDraft: true,
    });
    return json({ ok: true, draftId: result.messageId, threadId: result.threadId });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'draft failed' }, 500);
  }
};
