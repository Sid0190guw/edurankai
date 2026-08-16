// GET  /api/v1/integrations — the connected systems for this organisation and environment.
// POST /api/v1/integrations — connect one.
//
// Scope: `events.read` to list, `integrations.write` to create. Creating an integration is the act
// that gives a system a door into the event bus, so it is deliberately not something a publishing
// key can do to itself.
//
// A PLANNED CONNECTOR CANNOT BE CREATED, and the refusal says what is missing rather than "not
// supported" — see the `blocked_on` sentence in GET /api/v1/bus/catalog.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError, readJsonBody } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { createIntegration, listIntegrations } from '@/lib/mailint/integrations';
import { getConnector } from '@/lib/mailint/connectors';
import { vaultStatus } from '@/lib/mailint/credentials';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'integrations.list', scope: 'events.read' }, async (ctx) => {
  const list = await listIntegrations(ctx.auth.orgId, ctx.auth.environment);
  const vault = vaultStatus();
  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: list.length,
    // Surfaced on the LIST, not hidden in an error at credential-write time: an integration that
    // cannot store a secret is a different problem from one that is merely unconfigured, and an
    // operator should learn which before they start.
    credential_vault: { configured: vault.configured, detail: vault.detail },
    data: list.map((i) => ({
      id: i.id,
      object: 'integration',
      connector: i.connector,
      name: i.name,
      slug: i.slug,
      direction: i.direction,
      enabled: i.isEnabled,
      status: i.status,
      status_detail: i.statusDetail,
      consecutive_failures: i.consecutiveFailures,
      last_event_at: i.lastEventAt,
      inbound_url: '/api/v1/ingest/' + i.slug,
      created_at: i.createdAt,
    })),
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'integrations.create', scope: 'events.read' }, async (ctx) => {
  requireScope(ctx.auth, 'integrations.write');
  const body = await readJsonBody(ctx.request, 64 * 1024);

  const connectorKey = String(body.connector || '');
  const connector = getConnector(connectorKey);
  if (!connector) {
    throw new ApiError('invalid_request', '"' + connectorKey + '" is not a connector. GET /api/v1/bus/catalog lists them.', { param: 'connector' });
  }
  if (connector.meta.availability !== 'available') {
    throw new ApiError(
      'invalid_request',
      connector.meta.name + ' is planned, not implemented. ' + (connector.meta.blockedOn || ''),
      { param: 'connector' },
    );
  }
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError('invalid_request', 'An integration needs a `name`.', { param: 'name' });

  const r = await createIntegration({
    orgId: ctx.auth.orgId,
    environment: ctx.auth.environment,
    connector: connectorKey,
    name,
    slug: body.slug ? String(body.slug) : undefined,
    config: body.config && typeof body.config === 'object' ? body.config : {},
    expectedIntervalSeconds: body.expected_interval_seconds ? Number(body.expected_interval_seconds) : null,
    seedMappings: body.seed_mappings !== false,
  });
  if (!r.ok || !r.integration) throw new ApiError('invalid_request', r.error || 'The integration was not created.');

  return ctx.json({
    object: 'integration',
    id: r.integration.id,
    connector: r.integration.connector,
    name: r.integration.name,
    slug: r.integration.slug,
    environment: r.integration.environment,
    enabled: r.integration.isEnabled,
    /** Where the external system posts. Signed with the webhook secret you store next. */
    inbound_url: '/api/v1/ingest/' + r.integration.slug,
    next_steps: connector.meta.requires.map((k) =>
      k === 'webhook_secret'
        ? 'POST /api/v1/integrations/' + r.integration!.id + '/credentials with {"kind":"webhook_secret","secret":"..."} — the sending system signs with it.'
        : 'POST /api/v1/integrations/' + r.integration!.id + '/credentials with {"kind":"' + k + '","secret":"..."}',
    ),
  }, 201);
});
