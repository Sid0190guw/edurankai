// GET /api/v1/bus/events/:id — one event, and everything it caused.
//
// THIS ENDPOINT EXISTS TO ANSWER ONE QUESTION: "why did that candidate get that message?"
//
// It returns the fact as stored, the exact webhook body an endpoint would have received, and the
// list of route runs — which route matched, what it did, whether it worked and the reason if not —
// plus the routes that matched the pattern and were held back, with why. Without the last part, a
// route that silently did not fire is indistinguishable from a route that does not exist.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { bodyForStoredEvent, getEvent, getEventRuns } from '@/lib/mailint/router';
import { listDeliveries } from '@/lib/mailapi/webhooks';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'bus.get', scope: 'events.read' }, async (ctx) => {
  const id = String(ctx.params.id || '');
  const event = await getEvent(ctx.auth.orgId, id);
  // Cross-tenant and non-existent answer the same way. Confirming that another organisation's event
  // exists to somebody who guessed a uuid is a leak in itself.
  if (!event) throw new ApiError('not_found', 'No event with that id.');

  const runs = await getEventRuns(ctx.auth.orgId, id);
  // The delivery rows carry our event id in `event_id` (see src/lib/mailint/fanout.ts), so the
  // webhook half of "what did this cause" is a query, not a join we had to invent a column for.
  const deliveries = await listDeliveries(ctx.auth.orgId, { limit: 50 }).then((list) =>
    list.filter((d: any) => String(d.event_id) === id),
  );

  return ctx.json({
    object: 'event',
    id: String(event.id),
    type: String(event.event_type),
    source: String(event.source),
    entity: event.entity_type ? { type: event.entity_type, id: event.entity_id } : null,
    data: event.payload,
    idempotency_key: event.idempotency_key,
    external_event_id: event.external_event_id,
    occurred_at: event.occurred_at,
    received_at: event.created_at,
    /** Exactly what a subscribed endpoint receives — built by the same function that builds the real one. */
    webhook_body: bodyForStoredEvent(event),
    caused: runs.map((r: any) => ({
      route: r.route_name,
      action: r.action,
      status: r.status,
      detail: r.detail,
      result: r.result,
      duration_ms: r.duration_ms,
      at: r.created_at,
    })),
    deliveries: deliveries.map((d: any) => ({
      id: d.id,
      url: d.url,
      status: d.status,
      attempts: d.attempts,
      response_status: d.response_status,
      error: d.error,
      delivered_at: d.delivered_at,
    })),
  });
});
