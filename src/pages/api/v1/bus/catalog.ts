// GET /api/v1/bus/catalog — the whole integration vocabulary, machine-readable.
//
// Every event this platform understands, with its required and optional fields, the channels it may
// drive and whether it is sensitive; every connector, available or planned, with what it produces
// and — for the planned ones — the specific thing that is missing.
//
// IT IS GENERATED FROM THE SAME CONSTANTS THE ROUTER ENFORCES. A developer who reads this and sends
// exactly what it describes cannot be refused for a shape reason, because the validator and this
// endpoint read the same catalogue. That is the difference between documentation and a contract:
// hand-written docs drift on the first added field, and the drift is only discovered by an
// integration failing in somebody else's production.
//
// Scope: `events.read` — the lowest one any integration key carries. Discovery must not require the
// power to publish.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { CANONICAL_EVENTS, DEPRECATED_ALIASES, EVENT_CHANNELS, EVENT_ENVELOPE_VERSION, sampleEvent } from '@/lib/mailint/events';
import { listConnectorMeta } from '@/lib/mailint/connectors';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'bus.catalog', scope: 'events.read' }, async (ctx) => {
  const withSamples = ctx.url.searchParams.get('samples') === 'true';

  return ctx.json({
    object: 'catalog',
    envelope_version: EVENT_ENVELOPE_VERSION,
    channels: EVENT_CHANNELS,
    events: CANONICAL_EVENTS.map((e) => ({
      type: e.type,
      source: e.source,
      description: e.description,
      entity_type: e.entityType,
      required: e.required,
      optional: e.optional || [],
      channels: e.channels,
      // Named plainly rather than left to be discovered: a consumer that needs the score must ask
      // for the grant, and one that does not should know why the field is missing.
      sensitive: !!e.sensitive,
      ...(withSamples ? { sample: sampleEvent(e.type, ctx.auth.orgSlug) } : {}),
    })),
    aliases: DEPRECATED_ALIASES.map(([from, to]) => ({ deprecated: from, use: to })),
    connectors: listConnectorMeta().map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description,
      family: c.family,
      direction: c.direction,
      availability: c.availability,
      produces: c.produces,
      consumes: c.consumes || [],
      requires: c.requires,
      // Only ever present on a planned connector, and never the words "coming soon": the sentence
      // names the actual obstacle so a reader can judge the distance themselves.
      blocked_on: c.blockedOn || null,
    })),
  });
});
