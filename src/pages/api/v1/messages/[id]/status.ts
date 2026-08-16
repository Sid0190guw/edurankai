// GET /api/v1/messages/:id/status — where a message is now, and how it got there.
//
// Scope: email.read. Delivery events are included when the key also holds events.read; without it
// the caller still gets the status, and a line saying which scope would add the events. Silently
// returning an empty `events` array to a key that lacks the scope would read as "nothing happened".
//
// BCC IS NOT RETURNED BY DEFAULT. A status URL gets pasted into tickets, logs and chat, and a blind
// copy is blind on purpose. `?include_bcc=true` returns it for a caller who genuinely needs it.
//
// Statuses are exactly the set the platform documents: queued, processing, sent, delivered,
// deferred, bounced, failed — plus cancelled for a scheduled message that was called back in time.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { hasScope } from '@/lib/mailapi/keys';
import { getMessage, getMessageEvents, publicMessage } from '@/lib/mailapi/messages';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'messages.status', scope: 'email.read' }, async (ctx) => {
  const id = String(ctx.params.id || '');
  const message = await getMessage(id, { orgId: ctx.auth.orgId, environment: ctx.auth.environment });
  if (!message) {
    // The same answer for "no such message" and "a message belonging to another organization or
    // another environment": an id is a guessable shape, and a 403 would confirm existence.
    throw new ApiError('message_not_found', 'No message with that id in the ' + ctx.auth.environment + ' environment.');
  }

  const canReadEvents = hasScope(ctx.auth.scopes, 'events.read');
  const events = canReadEvents ? await getMessageEvents(message.id) : [];

  return ctx.json({
    ...publicMessage(message, { includeBcc: ctx.url.searchParams.get('include_bcc') === 'true' }),
    object: 'message_status',
    events: canReadEvents
      ? events.map((e) => ({ id: e.id, type: e.type, recipient: e.recipient, occurred_at: e.occurredAt, data: e.data }))
      : undefined,
    events_available: canReadEvents ? events.length : undefined,
    events_note: canReadEvents ? undefined : 'Delivery events are not included: this API key does not hold the `events.read` scope.',
  });
});
