// src/lib/mailint/fanout.ts — BUSINESS EVENTS ONTO THE EXISTING WEBHOOK PLATFORM.
//
// The webhook platform is already built: endpoints, secrets and rotation, signing, the dispatcher
// with its backoff curve, the dead state, replay, verification and the private-address refusal all
// live in src/lib/mailapi/webhooks.ts. NOTHING of that is reimplemented here, and this file has no
// fetch() in it.
//
// WHAT IT ADDS IS ONE THING THAT COULD NOT LIVE THERE: a per-endpoint payload.
//
// queueEvent() writes the same envelope to every subscribed endpoint, which is correct for delivery
// events — `email.bounced` says the same thing to everybody. It is NOT correct for the business
// events this patch introduces. `candidate.rejected` carries a written reason, `assessment.completed`
// carries a score; those go to the workflow that decides what to say to the person, and they do not
// go to a partner's endpoint unless somebody deliberately granted that endpoint the full payload.
// So the body has to be built per endpoint, and that is the whole reason this function exists rather
// than a call to queueEvent().
//
// Everything else is theirs: `subscribes()` decides subscription (including its rule that an empty
// list means everything), `buildEnvelope()` shapes the body, and the delivery row is the same row in
// the same table with the same unique index, so their dispatcher picks it up with no changes.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rows, dbReason } from './schema';
import { buildEnvelope, subscribes } from '@/lib/mailapi/webhooks';
import { planFanout, redactForChannel, type EndpointSubscription } from './routing';
import type { CanonicalEvent } from './events';

export interface FanoutResult {
  queued: number;
  /** Endpoints that matched but were not queued, with the reason. Shown on the event's page. */
  skipped: { endpointId: string; reason: string }[];
  /** Endpoints that received a payload with fields removed, and which fields. */
  redacted: { endpointId: string; fields: string[] }[];
}

export async function fanoutEvent(
  event: CanonicalEvent & { id: string },
  opts: { environment: string; orgSlug: string },
): Promise<FanoutResult> {
  const out: FanoutResult = { queued: 0, skipped: [], redacted: [] };
  let endpoints: any[] = [];
  try {
    endpoints = rows(await db.execute(sql`
      SELECT id, events, status, grant_sensitive
      FROM mailapi_webhooks
      WHERE org_id = ${event.orgId}::uuid AND environment = ${opts.environment}
        AND status IN ('active', 'pending_verification')
    `));
  } catch (e: any) {
    // A read failure is reported, never rendered as "no endpoints". Those two states look identical
    // on a screen and mean opposite things.
    console.error('[mailint/fanout] endpoint read failed:', dbReason(e));
    return { queued: 0, skipped: [{ endpointId: '-', reason: 'endpoints could not be read: ' + dbReason(e) }], redacted: [] };
  }

  // The pure planner decides tenancy, environment, subscription (using the platform's own
  // `subscribes` rule, injected) and per-endpoint redaction. Everything asserted about those
  // decisions in routing.test.ts is therefore asserted about THIS path, not about a model of it.
  const subscriptions: EndpointSubscription[] = endpoints.map((ep) => ({
    id: String(ep.id),
    orgId: event.orgId,
    url: '',
    eventTypes: Array.isArray(ep.events) ? ep.events.map(String) : [],
    status: String(ep.status) as EndpointSubscription['status'],
    environment: opts.environment,
    grantSensitive: !!ep.grant_sensitive,
  }));
  const plan = planFanout(event, subscriptions, opts.environment, (sub, type) => subscribes(sub, type));
  out.skipped.push(...plan.skipped);

  for (const target of plan.targets) {
    const full = event.payload || {};
    const payload = target.payload;
    const removed = Object.keys(full).filter((k) => !(k in payload));
    if (removed.length) out.redacted.push({ endpointId: target.endpointId, fields: removed });

    const envelope = buildEnvelope({
      eventId: event.id,
      type: event.type,
      createdAt: event.occurredAt,
      environment: opts.environment,
      orgSlug: opts.orgSlug,
      data: payload,
    });

    try {
      // ON CONFLICT DO NOTHING against the unique (webhook_id, event_id) index is the duplicate
      // promise for the outbound half: a router that runs twice on one event — a retried emit, two
      // dispatchers — posts the endpoint once.
      const r = rows(await db.execute(sql`
        INSERT INTO mailapi_webhook_deliveries (webhook_id, org_id, environment, event_id, event_type, payload)
        VALUES (${target.endpointId}::uuid, ${event.orgId}::uuid, ${opts.environment}, ${event.id}::uuid, ${event.type},
                ${JSON.stringify(envelope)}::jsonb)
        ON CONFLICT (webhook_id, event_id) DO NOTHING
        RETURNING id
      `));
      if (r[0]) out.queued++;
      else out.skipped.push({ endpointId: target.endpointId, reason: 'already queued for this event' });
    } catch (e: any) {
      console.error('[mailint/fanout] queue failed for endpoint', target.endpointId, dbReason(e));
      out.skipped.push({ endpointId: target.endpointId, reason: dbReason(e) });
    }
  }
  return out;
}

/**
 * The body one endpoint would receive for one event, without sending anything.
 *
 * The console's preview calls this, so what an operator is shown before they save a route is built
 * by the same code that will build the real delivery.
 */
export function previewFanoutBody(
  event: CanonicalEvent & { id: string },
  opts: { environment: string; orgSlug: string; grantSensitive?: boolean },
): Record<string, unknown> {
  return buildEnvelope({
    eventId: event.id,
    type: event.type,
    createdAt: event.occurredAt,
    environment: opts.environment,
    orgSlug: opts.orgSlug,
    data: redactForChannel(event, 'webhook', { grantSensitive: opts.grantSensitive }),
  }) as unknown as Record<string, unknown>;
}
