// GET    /api/v1/messages/:id — the full message record.  Scope: email.read
// DELETE /api/v1/messages/:id — cancel a scheduled send.   Scope: email.send
//
// CANCELLATION IS ONLY HONEST BEFORE THE SEND. A message that is queued for a future time can be
// called back; one that has been handed to a mail server cannot, and this endpoint says so rather
// than returning a success that means nothing. Mail that has left the building cannot be recalled.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { getMessage, getMessageBody, publicMessage, cancelMessage } from '@/lib/mailapi/messages';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'messages.get', scope: 'email.read' }, async (ctx) => {
  const message = await getMessage(String(ctx.params.id || ''), { orgId: ctx.auth.orgId, environment: ctx.auth.environment });
  if (!message) throw new ApiError('message_not_found', 'No message with that id in the ' + ctx.auth.environment + ' environment.');

  const withBody = ctx.url.searchParams.get('include_body') === 'true';
  const body = withBody ? await getMessageBody(message.id, ctx.auth.orgId, ctx.auth.environment) : null;

  return ctx.json({
    ...publicMessage(message, { includeBcc: ctx.url.searchParams.get('include_bcc') === 'true' }),
    html: body?.html,
    text: body?.text,
  });
});

export const DELETE: APIRoute = apiRoute({ endpoint: 'messages.cancel', scope: 'email.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const id = String(ctx.params.id || '');
  const message = await getMessage(id, { orgId: ctx.auth.orgId, environment: ctx.auth.environment });
  if (!message) throw new ApiError('message_not_found', 'No message with that id in the ' + ctx.auth.environment + ' environment.');

  const cancelled = await cancelMessage(ctx.auth.orgId, ctx.auth.environment, id);
  if (cancelled) return ctx.json({ id, object: 'message', status: 'cancelled', cancelled: true });

  return ctx.json({
    id,
    object: 'message',
    status: message.status,
    cancelled: false,
    reason: message.scheduledAt
      ? 'Its scheduled time has passed or it has already been picked up for delivery.'
      : 'Only a message scheduled for a future time can be cancelled. This one was sent immediately.',
  }, 409);
});
