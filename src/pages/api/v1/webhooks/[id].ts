// GET    /api/v1/webhooks/:id — one endpoint.                    Scope: events.read
// PATCH  /api/v1/webhooks/:id — change url, events, or re-enable. Scope: events.read + email.send
// DELETE /api/v1/webhooks/:id — remove it and its delivery rows.  Scope: events.read + email.send
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { getEndpoint, updateEndpoint, deleteEndpoint, listDeliveries } from '@/lib/mailapi/webhooks';

export const OPTIONS = PREFLIGHT;

function shape(e: any) {
  return {
    id: e.id,
    object: 'webhook_endpoint',
    url: e.url,
    description: e.description,
    events: e.events.length ? e.events : ['*'],
    status: e.status,
    verified_at: e.verifiedAt,
    consecutive_failures: e.consecutiveFailures,
    disabled_reason: e.disabledReason,
    secret_hint: e.secretHint,
    previous_secret_expires_at: e.previousSecretExpiresAt,
    created_at: e.createdAt,
  };
}

export const GET: APIRoute = apiRoute({ endpoint: 'webhooks.get', scope: 'events.read' }, async (ctx) => {
  const e = await getEndpoint(ctx.auth.orgId, String(ctx.params.id || ''), ctx.auth.environment);
  if (!e) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id in the ' + ctx.auth.environment + ' environment.');
  const recent = await listDeliveries(ctx.auth.orgId, { webhookId: e.id, limit: 20 });
  return ctx.json({
    ...shape(e),
    recent_deliveries: recent.map((d: any) => ({
      id: d.id, event_type: d.event_type, status: d.status, attempts: d.attempts,
      response_status: d.response_status, duration_ms: d.duration_ms, error: d.error,
      next_attempt_at: d.next_attempt_at, delivered_at: d.delivered_at, created_at: d.created_at,
    })),
  });
});

export const PATCH: APIRoute = apiRoute({ endpoint: 'webhooks.update', scope: 'events.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const body = await readJsonBody(ctx.request, 32 * 1024);
  const status = body.status === 'active' || body.status === 'disabled' ? body.status : undefined;
  const updated = await updateEndpoint(ctx.auth.orgId, String(ctx.params.id || ''), {
    url: body.url != null ? String(body.url) : undefined,
    description: body.description != null ? String(body.description) : undefined,
    events: Array.isArray(body.events) ? body.events.map(String) : undefined,
    status,
  });
  if (!updated) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id.');
  return ctx.json({
    ...shape(updated),
    note: status === 'active'
      ? 'Re-enabled. The failure counter was reset; deliveries that were already dead need an explicit replay.'
      : undefined,
  });
});

export const DELETE: APIRoute = apiRoute({ endpoint: 'webhooks.delete', scope: 'events.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const gone = await deleteEndpoint(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!gone) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id.');
  return ctx.json({ id: ctx.params.id, object: 'webhook_endpoint', deleted: true });
});
