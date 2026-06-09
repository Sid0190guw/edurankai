// POST /api/mail/send - compose / reply / forward. Internal delivery + external via SMTP/Resend.
// Supports the @group:slug token in To/Cc/Bcc — see /lib/mail-groups.ts.
// Groups marked hidden_recipients=true ALWAYS route to BCC so members never
// see each other's addresses.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { deliverMessage, parseAddressList, getMailboxAddress, logOutbound, getMailConfig } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';
import { expandGroupTokens } from '@/lib/mail-groups';
import { getSignature, scheduleMessage, rewriteLinksForTracking } from '@/lib/mail-advanced';

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

  // Pull tokens BEFORE parseAddressList strips display names — so we can spot
  // @group:slug entries that wouldn't match the email regex.
  function splitTokens(input: any): string[] {
    if (!input) return [];
    const raw = Array.isArray(input) ? input.join(',') : String(input);
    return raw.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  const toTokens = splitTokens(body.to);
  const ccTokens = splitTokens(body.cc);
  const bccTokens = splitTokens(body.bcc);

  // Expand @group:slug tokens. Hidden-recipient groups go into BCC regardless
  // of which field the token was placed in.
  const expanded = await expandGroupTokens({ to: toTokens, cc: ccTokens, bcc: bccTokens });
  const to = parseAddressList(expanded.to);
  const cc = parseAddressList(expanded.cc);
  const bcc = parseAddressList(expanded.bcc);
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

  // Append the composer's signature (unless this is a no-signature send).
  if (body.signature !== false) {
    try {
      const sig = await getSignature(user.id);
      if (sig.on && sig.html) {
        bodyHtml = bodyHtml + '<br/><br/><div class="era-sig">' + sig.html + '</div>';
        bodyText = bodyText + '\n\n' + sig.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } catch (_) {}
  }

  // Scheduled send: stash it and return; the scheduled-send cron delivers it.
  const schedRaw = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if (schedRaw && !isNaN(schedRaw.getTime()) && schedRaw.getTime() > Date.now() + 30000) {
    try {
      const sid = await scheduleMessage({ userId: user.id, to, cc, bcc, subject, bodyHtml, bodyText, threadId: body.threadId || null, inReplyTo: body.inReplyTo || null, scheduledAt: schedRaw });
      return json({ ok: true, scheduled: true, scheduledId: sid, scheduledAt: schedRaw.toISOString() });
    } catch (e: any) { return json({ ok: false, error: 'could not schedule: ' + (e?.message || e) }, 500); }
  }

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
      // The SMTP server typically only allows sending AS the authenticated
      // mailbox, so use the configured From address (fallback to SMTP user);
      // set Reply-To to the actual composer so replies route back to them.
      const cfg = await getMailConfig();
      const envFromAddr = cfg.fromAddress || cfg.smtpUser || fromEmail;
      const envFrom = `${cfg.fromName || fromName} <${envFromAddr}>`;
      // Inject a 1x1 read-receipt pixel before sending so we know when the
      // recipient opens. Inserted at the bottom of the HTML so it loads after
      // body content; falls through silently if their client blocks images.
      const trackingPixel = `<img src="https://edurankai.in/api/mail/track/${result.messageId}.gif" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px;" />`;
      // Rewrite links through the click redirector so opens AND clicks are measured.
      const htmlTracked = rewriteLinksForTracking(bodyHtml || '', result.messageId);
      const htmlWithPixel = htmlTracked + trackingPixel;
      const send = await sendExternal({
        from: envFrom,
        to: extTo.length ? extTo : (extCc[0] ? extCc : extBcc),
        cc: extCc, bcc: extBcc,
        subject, html: htmlWithPixel, text: bodyText,
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
