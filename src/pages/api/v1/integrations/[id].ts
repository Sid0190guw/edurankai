// GET    /api/v1/integrations/:id — one integration, its health, its credentials (as metadata) and
//                                   its mappings.
// PATCH  /api/v1/integrations/:id — rename, enable, disable, reconfigure.
// DELETE /api/v1/integrations/:id — disconnect. Credentials and mappings go with it; EVENTS DO NOT.
//
// Deleting an integration must not rewrite the history of what the platform was told. The events it
// published are facts that happened and stay on the bus, which is also what makes a disconnect
// reversible without data loss.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError, readJsonBody } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { checkHealth, deleteIntegration, getIntegration, listMappings, updateIntegration } from '@/lib/mailint/integrations';
import { listCredentials } from '@/lib/mailint/credentials';
import { getConnector } from '@/lib/mailint/connectors';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'integrations.get', scope: 'events.read' }, async (ctx) => {
  const integration = await getIntegration(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!integration) throw new ApiError('not_found', 'No integration with that id.');
  // Environment isolation is a separate check from tenancy, and both are enforced: a development
  // key must not read, change or trigger a production integration.
  if (integration.environment !== ctx.auth.environment) {
    throw new ApiError('environment_mismatch', 'That integration is in the ' + integration.environment + ' environment and this key is a ' + ctx.auth.environment + ' key.');
  }

  const [health, credentials, mappings] = await Promise.all([
    checkHealth(integration),
    listCredentials(ctx.auth.orgId, integration.id),
    listMappings(ctx.auth.orgId, integration.id),
  ]);
  const connector = getConnector(integration.connector);

  return ctx.json({
    object: 'integration',
    id: integration.id,
    connector: integration.connector,
    connector_name: connector?.meta.name || null,
    name: integration.name,
    slug: integration.slug,
    environment: integration.environment,
    enabled: integration.isEnabled,
    config: integration.config,
    inbound_url: '/api/v1/ingest/' + integration.slug,
    health: { status: health.status, detail: health.detail, checked_at: health.checkedAt, facts: health.facts || {} },
    // METADATA ONLY, ALWAYS. There is no field here, and no endpoint anywhere, that returns stored
    // secret material — section 6 of the brief, enforced by the absence of a read path rather than
    // by remembering not to write one.
    credentials: credentials.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      hint: c.hint,
      fingerprint: c.fingerprint,
      state: c.state,
      expires_at: c.expiresAt,
      last_used_at: c.lastUsedAt,
      created_at: c.createdAt,
    })),
    mappings: mappings.map((m) => ({
      id: (m as any).id,
      name: m.name,
      active: m.isActive !== false,
      priority: m.priority ?? 100,
      produces: typeof m.canonicalType === 'string' ? m.canonicalType : '(looked up from the payload)',
    })),
  });
});

export const PATCH: APIRoute = apiRoute({ endpoint: 'integrations.update', scope: 'integrations.write' }, async (ctx) => {
  const integration = await getIntegration(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!integration) throw new ApiError('not_found', 'No integration with that id.');
  if (integration.environment !== ctx.auth.environment) {
    throw new ApiError('environment_mismatch', 'That integration is in the ' + integration.environment + ' environment.');
  }
  const body = await readJsonBody(ctx.request, 64 * 1024);

  const r = await updateIntegration(ctx.auth.orgId, integration.id, {
    name: body.name === undefined ? undefined : String(body.name),
    isEnabled: body.enabled === undefined ? undefined : !!body.enabled,
    config: body.config && typeof body.config === 'object' ? body.config : undefined,
    expectedIntervalSeconds: body.expected_interval_seconds === undefined ? undefined : (body.expected_interval_seconds === null ? null : Number(body.expected_interval_seconds)),
  });
  if (!r.ok || !r.integration) throw new ApiError('invalid_request', r.error || 'Nothing was changed.');

  return ctx.json({
    object: 'integration',
    id: r.integration.id,
    name: r.integration.name,
    enabled: r.integration.isEnabled,
    status: r.integration.status,
    config: r.integration.config,
  });
});

export const DELETE: APIRoute = apiRoute({ endpoint: 'integrations.delete', scope: 'integrations.write' }, async (ctx) => {
  const integration = await getIntegration(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!integration) throw new ApiError('not_found', 'No integration with that id.');
  if (integration.environment !== ctx.auth.environment) {
    throw new ApiError('environment_mismatch', 'That integration is in the ' + integration.environment + ' environment.');
  }
  const r = await deleteIntegration(ctx.auth.orgId, integration.id);
  if (!r.ok) throw new ApiError('invalid_request', r.error || 'It was not deleted.');
  return ctx.json({
    object: 'integration',
    id: integration.id,
    deleted: true,
    note: 'Credentials and mappings were removed with it. Events it published remain on the bus — they are facts that happened.',
  });
});
