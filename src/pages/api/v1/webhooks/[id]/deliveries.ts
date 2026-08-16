// GET  /api/v1/webhooks/:id/deliveries       — the delivery log, including the dead-letter rows.
// POST /api/v1/webhooks/:id/deliveries       — replay one: { "delivery_id": "..." } or { "replay_dead": true }.
//
// Scope: events.read to read; + email.send to replay.
//
// THE DEAD-LETTER STATE IS VISIBLE AND RECOVERABLE, WHICH IS THE ONLY REASON IT IS SAFE TO HAVE ONE.
// After eight attempts across roughly twelve hours a delivery stops retrying and is marked `dead`.
// If that were the end of it, an endpoint that was down for a maintenance window would lose events
// with no way to get them back. They are listed here, and a replay puts them back in the queue with
// their original payload and event id — so a receiver that dedupes on Webhook-Id, as the docs say to,
// is unharmed by the replay.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { getEndpoint, listDeliveries, replayDelivery } from '@/lib/mailapi/webhooks';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'webhooks.deliveries', scope: 'events.read' }, async (ctx) => {
  const id = String(ctx.params.id || '');
  const endpoint = await getEndpoint(ctx.auth.orgId, id, ctx.auth.environment);
  if (!endpoint) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id in the ' + ctx.auth.environment + ' environment.');

  const status = ctx.url.searchParams.get('status');
  const deliveries = await listDeliveries(ctx.auth.orgId, {
    webhookId: id,
    status: status || undefined,
    limit: Number(ctx.url.searchParams.get('limit')) || 50,
  });

  return ctx.json({
    object: 'list',
    webhook_id: id,
    count: deliveries.length,
    data: deliveries.map((d: any) => ({
      id: d.id,
      object: 'webhook_delivery',
      event_id: d.event_id,
      event_type: d.event_type,
      status: d.status,
      attempts: d.attempts,
      max_attempts: d.max_attempts,
      response_status: d.response_status,
      duration_ms: d.duration_ms,
      error: d.error,
      next_attempt_at: d.next_attempt_at,
      delivered_at: d.delivered_at,
      created_at: d.created_at,
    })),
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'webhooks.replay', scope: 'events.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const id = String(ctx.params.id || '');
  const endpoint = await getEndpoint(ctx.auth.orgId, id, ctx.auth.environment);
  if (!endpoint) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id in the ' + ctx.auth.environment + ' environment.');

  const body = await readJsonBody(ctx.request, 8 * 1024);

  if (body.replay_dead === true) {
    const dead = await listDeliveries(ctx.auth.orgId, { webhookId: id, status: 'dead', limit: 200 });
    let requeued = 0;
    for (const d of dead) if (await replayDelivery(ctx.auth.orgId, d.id)) requeued++;
    return ctx.json({
      object: 'webhook_replay',
      webhook_id: id,
      requeued,
      found: dead.length,
      note: requeued
        ? requeued + ' delivery(s) requeued. They keep their original Webhook-Id, so a receiver that dedupes on it will not double-process.'
        : 'No dead deliveries to replay.',
    });
  }

  const deliveryId = String(body.delivery_id || '');
  if (!deliveryId) throw new ApiError('invalid_request', 'Send `delivery_id`, or `replay_dead: true` to requeue every dead delivery for this endpoint.', { param: 'delivery_id' });
  const ok = await replayDelivery(ctx.auth.orgId, deliveryId);
  if (!ok) throw new ApiError('not_found', 'No dead or pending delivery with that id for this organization. A delivery that already succeeded is not replayed.');
  return ctx.json({ object: 'webhook_replay', webhook_id: id, delivery_id: deliveryId, requeued: 1 });
});
