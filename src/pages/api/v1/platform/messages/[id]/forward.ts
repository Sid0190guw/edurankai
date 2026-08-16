// POST /api/v1/platform/messages/:id/forward — forward a message.
// Body: { to, note?, includeAttachments?: boolean }
//
// A forward is a NEW message that quotes the original, not a copy of it. It starts its own thread —
// forwarding to a third party and having their reply land in the original participants' thread is a
// disclosure, not a convenience.

import type { APIRoute } from 'astro';
import { error, ok, preflight, readJson, requirePrincipal, requireUuid } from '@/lib/mailplatform/api';
import { providers } from '@/lib/mailplatform/providers';
import { sendMessage } from '@/lib/mailplatform/send';
import { escapeHtml, formatAddress, normalizeSubject } from '@/lib/mailplatform/rfc';

export const OPTIONS: APIRoute = () => preflight();

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.send');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const id = requireUuid(ctx.params.id, 'id');
  if (id instanceof Response) return id;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;
  if (!body.to) return error('"to" is required.', 422, 'no_recipient');

  const original = await providers().messages.get(id, {
    userId: principal.kind === 'user' ? principal.id : undefined,
    orgId: principal.kind === 'user' ? undefined : principal.orgId,
  });
  if (!original) return error('No message with that id.', 404, 'not_found');

  const note = typeof body.note === 'string' ? body.note : '';

  // BCC recipients of the original are NOT reproduced in the forwarded header block. They were
  // blind-copied; naming them here would expose exactly what the blind copy existed to hide.
  const visibleRecipients = (original.recipients || [])
    .filter((r) => r.kind !== 'bcc')
    .map((r) => formatAddress({ email: r.email, name: r.name }))
    .join(', ');

  const header = [
    '---------- Forwarded message ----------',
    `From: ${formatAddress(original.from)}`,
    `Date: ${original.sentAt || original.createdAt}`,
    `Subject: ${original.subject}`,
    `To: ${visibleRecipients}`,
  ].join('\n');

  const bodyHtml =
    (note ? `<div>${escapeHtml(note).replace(/\n/g, '<br/>')}</div><br/>` : '') +
    `<div style="border-left:2px solid #ddd;padding-left:12px;color:#555;">` +
    `<pre style="font:inherit;white-space:pre-wrap;margin:0 0 8px;">${escapeHtml(header)}</pre>` +
    (original.bodyHtml || escapeHtml(original.bodyText || '')) +
    `</div>`;

  const bodyText = (note ? note + '\n\n' : '') + header + '\n\n' + (original.bodyText || '');

  const includeAttachments = body.includeAttachments !== false;
  const attachments = includeAttachments
    ? (original.attachments || []).map((a) => ({ filename: a.filename, url: a.url, mime: a.mime || undefined, size: a.sizeBytes || undefined }))
    : [];

  const result = await sendMessage(
    {
      to: body.to as any,
      cc: body.cc as any,
      subject: 'Fwd: ' + normalizeSubject(original.subject),
      bodyHtml,
      bodyText,
      attachments,
      // No threadId and no inReplyTo, deliberately — see the note at the top of this file.
    },
    { principal, fromUserId: principal.kind === 'user' ? principal.id : null },
  );

  if (!result.ok) return error(result.error || 'The forward was not sent.', 422, result.status);
  return ok(
    {
      messageId: result.messageId,
      threadId: result.threadId,
      status: result.status,
      accepted: result.accepted,
      attachmentsIncluded: attachments.length,
    },
    202,
  );
};
