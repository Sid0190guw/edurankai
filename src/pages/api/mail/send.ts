// POST /api/mail/send - compose / reply / forward. Internal delivery + external via SMTP/Resend.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { deliverMessage, parseAddressList, getMailboxAddress, logOutbound } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';

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

  const to = parseAddressList(body.to);
  const cc = parseAddressList(body.cc);
  const bcc = parseAddressList(body.bcc);
  if (to.length + cc.length + bcc.length === 0) return json({ ok: false, error: 'at least one recipient required' }, 400);

  const subject = (body.subject || '').toString().slice(0, 500);
  let bodyText = (body.bodyText ?? body.body ?? '').toString();
  if (bodyText.length > 100000) return json({ ok: false, error: 'message too long' }, 400);
  let bodyHtml = (body.bodyHtml || '').toString();
  if (!bodyHtml) bodyHtml = '<div>' + escapeHtml(bodyText).replace(/\n/g, '<br/>') + '</div>';
  if (!bodyText) bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((a: any) => a && a.url).map((a: any) => ({ filename: a.filename || 'attachment', url: a.url, mime: a.mime, size: a.size }))
    : [];

  try {
    const fromEmail = await getMailboxAddress(user.id);
    const fromName = user.name || fromEmail;

    const result = await deliverMessage({
      fromUserId: user.id, fromEmail, fromName,
      to, cc, bcc, subject, bodyHtml, bodyText,
      threadId: body.threadId || null,
      inReplyTo: body.inReplyTo || null,
      attachments,
    });

    // Delete the draft this was sent from, if any
    if (body.draftId) {
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${user.id} AND message_id = ${body.draftId} AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${body.draftId} AND is_draft = true`);
    }

    // External delivery
    if (result.external.length) {
      const extTo = result.external.filter(e => e.kind === 'to').map(e => e.email);
      const extCc = result.external.filter(e => e.kind === 'cc').map(e => e.email);
      const extBcc = result.external.filter(e => e.kind === 'bcc').map(e => e.email);
      const send = await sendExternal({
        from: `${fromName} <${fromEmail}>`,
        to: extTo.length ? extTo : (extCc[0] ? extCc : extBcc),
        cc: extCc, bcc: extBcc,
        subject, html: bodyHtml, text: bodyText,
        replyTo: fromEmail,
        messageId: result.rfcMessageId,
        inReplyTo: body.inReplyTo || undefined,
        attachments: attachments.map((a: any) => ({ filename: a.filename, href: a.url })),
      });
      for (const e of result.external) {
        await logOutbound({
          messageId: result.messageId, to: e.email, from: fromEmail, subject,
          status: send.ok ? 'sent' : 'failed', provider: send.provider, error: send.error,
        });
      }
      // mark message as outbound when it left the platform
      await db.execute(sql`UPDATE mail_messages SET direction = 'outbound' WHERE id = ${result.messageId}`);
      return json({ ok: true, threadId: result.threadId, messageId: result.messageId, external: { attempted: result.external.length, delivered: send.ok, provider: send.provider, error: send.error } });
    }

    return json({ ok: true, threadId: result.threadId, messageId: result.messageId });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'send failed' }, 500);
  }
};
