// GET  /api/v1/integrations/:id/mappings  — the rules that turn their shape into ours.
// POST /api/v1/integrations/:id/mappings  — save one, delete one, or TEST one against a captured
//                                           payload without publishing anything.
//
// Section 8 of the brief is this file plus src/lib/mailint/mapping.ts:
//
//     external: { "event": "candidate.moved", "candidate": { "id": "c_9", "stage": 3 } }
//        -> mapping -> application.stage.changed { application_id: "c_9", stage: "assessment" }
//        -> the stage-3 workflow sends the assessment invitation
//
// `action: "test"` IS THE IMPORTANT ONE. It runs the real mapping engine over a real captured
// payload and returns the canonical event it would produce, field by field, with the reason for
// anything that dropped out — and publishes nothing. An integration built by editing a mapping and
// re-posting yesterday's payload is an integration built without sending anybody a test email.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError, readJsonBody } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { deleteMapping, getIntegration, listMappings, saveMapping } from '@/lib/mailint/integrations';
import { dryRun, selectMapping, validateMapping, type EventMapping } from '@/lib/mailint/mapping';
import { validateEvent } from '@/lib/mailint/events';

export const OPTIONS = PREFLIGHT;

async function requireIntegration(ctx: any) {
  const integration = await getIntegration(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!integration) throw new ApiError('not_found', 'No integration with that id.');
  if (integration.environment !== ctx.auth.environment) {
    throw new ApiError('environment_mismatch', 'That integration is in the ' + integration.environment + ' environment.');
  }
  return integration;
}

export const GET: APIRoute = apiRoute({ endpoint: 'integrations.mappings.list', scope: 'events.read' }, async (ctx) => {
  const integration = await requireIntegration(ctx);
  const mappings = await listMappings(ctx.auth.orgId, integration.id);
  return ctx.json({
    object: 'list',
    integration_id: integration.id,
    count: mappings.length,
    data: mappings,
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'integrations.mappings.write', scope: 'events.read' }, async (ctx) => {
  const integration = await requireIntegration(ctx);
  const body = await readJsonBody(ctx.request, 128 * 1024);
  const action = String(body.action || 'save');

  // Testing is a READ of behaviour, not a write, so it needs only events.read. Saving changes what
  // the platform does with real traffic and needs the integration scope.
  if (action === 'test') {
    const payload = body.payload;
    if (payload === undefined) throw new ApiError('invalid_request', '`payload` is required — send a captured request body.', { param: 'payload' });

    const mappings = body.mapping
      ? [body.mapping as EventMapping]
      : await listMappings(ctx.auth.orgId, integration.id);

    const chosen = body.mapping ? (mappings[0] as EventMapping) : selectMapping(mappings as EventMapping[], payload);
    if (!chosen) {
      return ctx.json({
        object: 'mapping_test',
        matched: false,
        // NOT an error. An unmapped payload is acknowledged by the ingest endpoint too — see the
        // 202 case there — because a system that sends us its whole stream must not be taught that
        // most of it is a failure.
        detail: 'No mapping claims this payload. The ingest endpoint would acknowledge it with 202 and publish nothing.',
      });
    }

    const result = dryRun(chosen, payload);
    const validation = result.event
      ? validateEvent({ ...result.event, orgId: ctx.auth.orgId })
      : null;

    return ctx.json({
      object: 'mapping_test',
      matched: true,
      mapping: chosen.name,
      ok: !!result.ok && !!validation?.ok,
      errors: [...(result.errors || []), ...(validation?.ok === false ? validation.errors : [])],
      /** Field by field: where each value came from, what it became, and why anything vanished. */
      trace: result.trace || [],
      event: validation?.normalized || result.event || null,
      published: false,
    });
  }

  requireScope(ctx.auth, 'integrations.write');

  if (action === 'delete') {
    const id = String(body.mapping_id || '');
    if (!id) throw new ApiError('invalid_request', '`mapping_id` is required to delete.', { param: 'mapping_id' });
    const r = await deleteMapping(ctx.auth.orgId, id);
    if (!r.ok) throw new ApiError('not_found', r.error || 'No such mapping.');
    return ctx.json({ object: 'mapping', id, deleted: true });
  }

  const mapping = body.mapping as EventMapping;
  if (!mapping || typeof mapping !== 'object') throw new ApiError('invalid_request', '`mapping` must be an object.', { param: 'mapping' });
  mapping.source = mapping.source || integration.connector;

  // Validated BEFORE it is stored: a typo in a path caught once at save time, rather than once per
  // inbound webhook at three in the morning.
  const errors = validateMapping(mapping);
  if (errors.length) throw new ApiError('invalid_request', 'This mapping would not work: ' + errors.join(' '), { extra: { errors } });

  const r = await saveMapping({
    orgId: ctx.auth.orgId,
    integrationId: integration.id,
    mapping,
    mappingId: body.mapping_id ? String(body.mapping_id) : null,
  });
  if (!r.ok) throw new ApiError('invalid_request', (r.errors || ['The mapping was not saved.']).join(' '), { extra: { errors: r.errors } });

  return ctx.json({ object: 'mapping', id: r.id, name: mapping.name, saved: true }, 201);
});
