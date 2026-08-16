// POST /api/v1/bus/events — publish a BUSINESS event onto the integration event bus.
// GET  /api/v1/bus/events — read the bus back.
//
// WHY THIS IS NOT /api/v1/events. That route is the DELIVERY feed: email.sent, email.bounced,
// email.opened — facts the mail platform produces about messages it handled. This one is the
// opposite direction: facts a PRODUCT produces about the world, which the platform then decides what
// to do about. Merging them would have put "we sent a message" and "an application reached the
// assessment stage" in one list with one shape and one retention policy, and a consumer of either
// would have had to filter the other out on every read.
//
// Scope: `events.write` to publish, `events.read` to read. Publishing is separated because a
// published event can CAUSE MAIL TO A PERSON — an integration key that only reports delivery
// outcomes must not be able to trigger a candidate's rejection message.
//
// THE ORGANISATION COMES FROM THE KEY. There is no `org_id` field in the request body and there
// never will be: a payload that could name its own tenant is a cross-tenant write waiting for
// somebody to guess a uuid.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError, readJsonBody } from '@/lib/mailapi/errors';
import { emitEvent, listEvents } from '@/lib/mailint/router';
import { CANONICAL_EVENTS, EVENT_ENVELOPE_VERSION, isKnownEventType, suggestEventType } from '@/lib/mailint/events';

export const OPTIONS = PREFLIGHT;

/** Environments are three in this platform; the router's actions are decided for two of them. */
function routerEnvironment(env: string): 'development' | 'production' {
  // Staging behaves as development for anything that SENDS: rendering and routing run, delivery
  // does not. That is the deliberate reading of "not production" for a surface whose mistakes are
  // measured in real messages to real people.
  return env === 'production' ? 'production' : 'development';
}

export const POST: APIRoute = apiRoute({ endpoint: 'bus.publish', scope: 'events.write' }, async (ctx) => {
  const body = await readJsonBody(ctx.request, 256 * 1024);

  const type = String(body.type || body.event || '');
  if (!type) throw new ApiError('invalid_request', 'An event needs a `type`. GET /api/v1/bus/catalog lists them.', { param: 'type' });
  if (!isKnownEventType(type)) {
    const hint = suggestEventType(type);
    throw new ApiError(
      'invalid_request',
      '"' + type + '" is not an event in the catalogue' + (hint ? ' — did you mean "' + hint + '"?' : '. GET /api/v1/bus/catalog lists them.'),
      { param: 'type' },
    );
  }

  const payload = body.data ?? body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('invalid_request', '`data` must be a JSON object carrying the event’s fields.', { param: 'data' });
  }

  const result = await emitEvent(
    {
      orgId: ctx.auth.orgId,
      type,
      source: String(body.source || ctx.auth.orgSlug || 'external'),
      entityId: body.entity_id ? String(body.entity_id) : undefined,
      actorType: 'api_key',
      actorId: ctx.auth.keyId,
      payload,
      occurredAt: body.occurred_at ? String(body.occurred_at) : new Date().toISOString(),
      // Section 9. The caller's own key wins; the platform derives one when there is none, from
      // (source, type, entity, second) — see deriveIdempotencyKey.
      idempotencyKey: body.idempotency_key ? String(body.idempotency_key) : undefined,
      externalEventId: body.event_id ? String(body.event_id) : undefined,
    },
    { environment: routerEnvironment(ctx.auth.environment), now: Date.now() },
  );

  if (!result.ok) {
    throw new ApiError('invalid_request', (result.errors || ['The event was refused.']).join(' '), { extra: { errors: result.errors } });
  }

  // A DUPLICATE IS A 200 WITH `duplicate: true`, NOT AN ERROR. A well-behaved sender retries on a
  // timeout; answering 409 would teach it that its retry was a mistake, and answering 500 would make
  // it retry again. The response says plainly that nothing new happened.
  return ctx.json(
    {
      object: 'event',
      id: result.eventId,
      type,
      duplicate: !!result.duplicate,
      environment: ctx.auth.environment,
      envelope_version: EVENT_ENVELOPE_VERSION,
      actions: result.duplicate ? [] : (result.actions || []),
      skipped: result.duplicate ? [] : (result.skipped || []),
    },
    result.duplicate ? 200 : 201,
  );
});

export const GET: APIRoute = apiRoute({ endpoint: 'bus.list', scope: 'events.read' }, async (ctx) => {
  const q = ctx.url.searchParams;
  const type = q.get('type');
  if (type && !isKnownEventType(type)) {
    throw new ApiError('invalid_request', '"' + type + '" is not an event in the catalogue.', { param: 'type' });
  }
  const events = await listEvents({
    orgId: ctx.auth.orgId,
    environment: routerEnvironment(ctx.auth.environment),
    eventType: type,
    entityId: q.get('entity_id'),
    since: q.get('since'),
    limit: Number(q.get('limit')) || 50,
  });

  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: events.length,
    envelope_version: EVENT_ENVELOPE_VERSION,
    catalogue_size: CANONICAL_EVENTS.length,
    data: events.map((e: any) => ({
      id: e.id,
      object: 'event',
      type: e.event_type,
      source: e.source,
      entity: e.entity_type ? { type: e.entity_type, id: e.entity_id } : null,
      data: e.payload,
      idempotency_key: e.idempotency_key,
      external_event_id: e.external_event_id,
      occurred_at: e.occurred_at,
      received_at: e.created_at,
    })),
  });
});
