// POST /api/v1/platform/messages/:id/reply — reply to a message.
// Body: { body?, bodyHtml?, all?: boolean, to?, cc?, subject? }
//
// Threading is done HERE rather than left to the caller: the reply carries In-Reply-To, the parent's
// References chain and the parent's thread id. A "reply" that supplies none of those is a new
// conversation that happens to quote an old one, and every mail client will show it as one.

import type { APIRoute } from 'astro';
import { error, ok, preflight, readJson, requirePrincipal, requireUuid } from '@/lib/mailplatform/api';
import { providers } from '@/lib/mailplatform/providers';
import { sendMessage } from '@/lib/mailplatform/send';
import { normalizeSubject } from '@/lib/mailplatform/rfc';

export const OPTIONS: APIRoute = () => preflight();

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.send');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const id = requireUuid(ctx.params.id, 'id');
  if (id instanceof Response) return id;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const parent = await providers().messages.get(id, {
    userId: principal.kind === 'user' ? principal.id : undefined,
    orgId: principal.kind === 'user' ? undefined : principal.orgId,
  });
  if (!parent) return error('No message with that id.', 404, 'not_found');

  const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : undefined;
  const bodyText = typeof body.bodyText === 'string' ? body.bodyText : typeof body.body === 'string' ? body.body : undefined;
  if (!bodyHtml && !bodyText) return error('A reply needs a body.', 422, 'no_content');

  // Reply goes to the sender. Reply-all adds everyone the parent was addressed to, minus ourselves —
  // otherwise every reply-all puts a copy in the replier's own inbox and the thread doubles.
  const replyAll = body.all === true;
  const self = (principal.email || '').toLowerCase();
  const replyTarget = parent.replyTo || parent.from.email;

  const to: string[] = typeof body.to === 'string' || Array.isArray(body.to)
    ? ([] as string[]).concat(body.to as any)
    : [replyTarget];

  const cc: string[] = replyAll
    ? (parent.recipients || [])
        .filter((r) => r.kind !== 'bcc')
        .map((r) => r.email)
        .filter((email) => email.toLowerCase() !== self && email.toLowerCase() !== replyTarget.toLowerCase())
    : ([] as string[]).concat((body.cc as any) || []);

  const subject = typeof body.subject === 'string' && body.subject
    ? body.subject
    : 'Re: ' + normalizeSubject(parent.subject);

  const result = await sendMessage(
    {
      to,
      cc,
      subject,
      bodyHtml,
      bodyText,
      threadId: parent.threadId,
      inReplyTo: parent.rfcMessageId,
      attachments: Array.isArray(body.attachments) ? (body.attachments as any) : undefined,
    },
    { principal, fromUserId: principal.kind === 'user' ? principal.id : null },
  );

  if (!result.ok) return error(result.error || 'The reply was not sent.', 422, result.status);
  return ok({ messageId: result.messageId, threadId: result.threadId, status: result.status, accepted: result.accepted }, 202);
};
