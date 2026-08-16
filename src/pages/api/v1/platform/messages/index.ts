// GET  /api/v1/platform/messages — list messages the caller can see.
// POST /api/v1/platform/messages — store a message without sending it (a draft).
//
// The list is scoped by WHO is asking, not by a filter the caller supplies: a session user sees the
// messages in their own mailbox, an org-scoped key sees the organization's. There is no parameter
// that widens it, which is the mechanical reason one tenant cannot read another's mail.

import type { APIRoute } from 'astro';
import { audit, error, ok, pageParams, pageResponse, preflight, readJson, requirePrincipal, validate } from '@/lib/mailplatform/api';
import { providers } from '@/lib/mailplatform/providers';
import { buildRecipients, htmlToText, textToHtml } from '@/lib/mailplatform/rfc';
import { resolveIdentity } from '@/lib/mailplatform/send';

const DRAFT_SPEC = {
  to: { required: true },
  subject: { type: 'string', maxLength: 500 },
  bodyHtml: { type: 'string' },
  bodyText: { type: 'string' },
} as const;

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const url = new URL(ctx.request.url);
  const { limit, cursor } = pageParams(url, 25, 100);

  const page = await providers().messages.list({
    // A user principal is scoped to their own mailbox copies; a key is scoped to the org. Never both.
    userId: principal.kind === 'user' ? principal.id : undefined,
    orgId: principal.kind === 'user' ? undefined : principal.orgId,
    folder: url.searchParams.get('folder') || undefined,
    threadId: url.searchParams.get('threadId') || undefined,
    search: url.searchParams.get('q') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    direction: (url.searchParams.get('direction') as any) || undefined,
    isRead: url.searchParams.has('unread') ? false : undefined,
    isDraft: url.searchParams.get('drafts') === 'true' ? true : undefined,
    hasAttachments: url.searchParams.get('hasAttachments') === 'true' ? true : undefined,
    limit,
    cursor,
  });

  return pageResponse(page, 'messages');
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.send');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;
  const check = validate(body, DRAFT_SPEC as any);
  if (!check.ok) return check.response;

  const { recipients, invalid } = buildRecipients({ to: body.to as any, cc: body.cc as any, bcc: body.bcc as any });
  if (invalid.length) {
    return error(`These addresses are not valid: ${invalid.slice(0, 5).join(', ')}. Nothing has been saved.`, 422, 'invalid_recipients');
  }

  const identity = await resolveIdentity(principal.orgId, typeof body.from === 'string' ? body.from : null);
  if ('error' in identity) return error(identity.error, 422, 'identity');

  const bodyHtml = typeof body.bodyHtml === 'string' && body.bodyHtml ? body.bodyHtml : textToHtml(body.bodyText || '');
  const bodyText = typeof body.bodyText === 'string' && body.bodyText ? body.bodyText : htmlToText(bodyHtml);

  const result = await providers().messages.persist({
    orgId: principal.orgId,
    direction: 'outbound',
    from: { email: identity.fromAddress, name: identity.fromName },
    fromUserId: principal.kind === 'user' ? principal.id : null,
    recipients,
    subject: String(body.subject || ''),
    bodyHtml,
    bodyText,
    // A draft is stored and NOT delivered. No mailbox copy reaches a recipient, and no transport is
    // contacted — see the isDraft branch in the message store.
    isDraft: true,
  });

  if (!result.ok || !result.data) return error(result.error || 'The draft was not saved.', 500, result.code);

  await audit({
    principal,
    request: ctx.request,
    action: 'message.draft',
    targetType: 'message',
    targetId: result.data.messageId,
    meta: { recipients: recipients.length },
  });

  return ok({ messageId: result.data.messageId, threadId: result.data.threadId, isDraft: true }, 201);
};
