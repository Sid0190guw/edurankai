// GET  /api/v1/webhooks — list this organization's endpoints for this environment.
// POST /api/v1/webhooks — register one. The signing secret is returned ONCE, here.
//
// Scope: events.read to list, events.read + email.send to create (registering an endpoint that will
// receive recipient addresses is a sending-side decision, not a read).
//
// A NEW ENDPOINT STARTS `pending_verification`. It becomes active when it answers a signed POST with
// a 2xx — either the verification call below, or the first real event. An endpoint that never answers
// therefore never silently accumulates a backlog of deliveries nobody is reading.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { createEndpoint, listEndpoints, EVENT_TYPES, verifyEndpoint } from '@/lib/mailapi/webhooks';
import { PAYLOAD_VERSION } from '@/lib/mailapi/schema';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'webhooks.list', scope: 'events.read' }, async (ctx) => {
  const endpoints = await listEndpoints(ctx.auth.orgId, ctx.auth.environment);
  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: endpoints.length,
    payload_version: PAYLOAD_VERSION,
    available_events: EVENT_TYPES,
    data: endpoints.map((e) => ({
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
    })),
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'webhooks.create', scope: 'events.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const body = await readJsonBody(ctx.request, 32 * 1024);
  const endpoint = await createEndpoint({
    orgId: ctx.auth.orgId,
    environment: ctx.auth.environment,
    url: String(body.url || ''),
    description: body.description != null ? String(body.description) : null,
    events: Array.isArray(body.events) ? body.events.map(String) : [],
  });

  // Verify immediately unless asked not to, so the caller finds out here whether their endpoint
  // answers — rather than from a queue of failed deliveries an hour later.
  let verification: any = null;
  if (body.verify !== false) {
    const v = await verifyEndpoint(ctx.auth.orgId, endpoint.id);
    verification = v ? { ok: v.ok, response_status: v.status, duration_ms: v.durationMs, error: v.error } : null;
  }

  return ctx.json({
    id: endpoint.id,
    object: 'webhook_endpoint',
    url: endpoint.url,
    events: endpoint.events.length ? endpoint.events : ['*'],
    status: verification?.ok ? 'active' : endpoint.status,
    // Shown once. There is no endpoint that returns it again, by design.
    secret: endpoint.secret,
    secret_note: 'Store this now. It is not retrievable later — rotate the endpoint if you lose it.',
    payload_version: PAYLOAD_VERSION,
    signature_scheme: {
      headers: ['Webhook-Id', 'Webhook-Timestamp', 'Webhook-Signature'],
      signed_content: '{Webhook-Id}.{Webhook-Timestamp}.{raw request body}',
      algorithm: 'HMAC-SHA256, base64, prefixed `v1,`',
      tolerance_seconds: 300,
    },
    verification,
  }, 201);
});
