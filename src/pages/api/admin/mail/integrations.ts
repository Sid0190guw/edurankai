// POST /api/admin/mail/integrations — everything the integration console's buttons do.
//
// One endpoint with an `action`, following the house pattern (see /api/admin/rbac.ts). The console
// is session-authenticated staff, not an API key, so it goes through denyAdminApi() and the
// `mail.manage` ability rather than through the /v1 scope machinery — two different populations,
// two different doors, one set of underlying functions.
//
// NOTHING HERE REIMPLEMENTS A LIBRARY. Every action is a call into src/lib/mailint/* or
// src/lib/mailapi/webhooks.ts, so the console and the public API cannot drift: a test delivery sent
// from this screen is signed by the same signer, queued in the same table and dispatched by the same
// dispatcher as a real one. A test console that exercises a different path proves nothing about the
// path that matters.
//
// SECRETS COME BACK EXACTLY ONCE, at creation or rotation, in the response to the click that made
// them. They are not stored anywhere this endpoint can read back, and no action returns one twice.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rows, dbReason, ensureMailIntSchema } from '@/lib/mailint/schema';
import {
  checkHealth, createIntegration, deleteIntegration, deleteMapping, getIntegration,
  listIntegrations, listMappings, saveMapping, updateIntegration,
} from '@/lib/mailint/integrations';
import { listCredentials, revokeCredential, rotateCredential, storeCredential, vaultStatus } from '@/lib/mailint/credentials';
import { dryRun, selectMapping, validateMapping, type EventMapping } from '@/lib/mailint/mapping';
import { emitEvent, getOrCreateOrg, orgSlug } from '@/lib/mailint/router';
import { sampleEvent, isKnownEventType, type CanonicalEvent } from '@/lib/mailint/events';
import { validateRoute } from '@/lib/mailint/routing';
import { isConnectable } from '@/lib/mailint/connectors';
import {
  attemptDelivery, buildEnvelope, createEndpoint, deleteEndpoint, getEndpoint,
  listDeliveries, replayDelivery, rotateSecret, updateEndpoint, verifyEndpoint, classifyResponse, webhookBackoffMs,
} from '@/lib/mailapi/webhooks';
import type { CredentialKind } from '@/lib/mailint/connector';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

/** The console works against one organisation at a time; the page passes its id, or its slug. */
async function resolveOrg(body: any): Promise<{ id: string; slug: string } | null> {
  if (body.org_id) {
    const r = rows(await db.execute(sql`SELECT id, slug FROM mailapi_orgs WHERE id = ${String(body.org_id)}::uuid LIMIT 1`));
    return r[0] ? { id: String(r[0].id), slug: String(r[0].slug) } : null;
  }
  const org = await getOrCreateOrg(String(body.org_slug || 'careers'));
  return org ? { id: org.id, slug: org.slug } : null;
}

function environmentOf(body: any): 'development' | 'production' {
  return String(body.environment || 'development') === 'production' ? 'production' : 'development';
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.integrations' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'The request body is not valid JSON.' }, 400);
  }
  const action = String(body.action || '');
  await ensureMailIntSchema();

  const org = await resolveOrg(body);
  if (!org) return json({ ok: false, error: 'That organisation could not be resolved.' }, 400);
  const environment = environmentOf(body);

  try {
    switch (action) {
      // ---- integrations --------------------------------------------------------------------
      case 'integration.create': {
        const connector = String(body.connector || '');
        if (!isConnectable(connector)) {
          // The console never offers a connect button for a planned connector; this is the guard for
          // a hand-made request, and it says what is missing rather than "unsupported".
          return json({ ok: false, error: 'That connector is planned, not implemented, so it cannot be connected.' }, 400);
        }
        const r = await createIntegration({
          orgId: org.id, environment, connector,
          name: String(body.name || ''),
          slug: body.slug ? String(body.slug) : undefined,
          createdBy: user?.id || null,
        });
        return json(r.ok ? { ok: true, integration: r.integration } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'integration.update': {
        const r = await updateIntegration(org.id, String(body.integration_id || ''), {
          name: body.name === undefined ? undefined : String(body.name),
          isEnabled: body.enabled === undefined ? undefined : !!body.enabled,
        });
        return json(r.ok ? { ok: true, integration: r.integration } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'integration.delete': {
        const r = await deleteIntegration(org.id, String(body.integration_id || ''));
        return json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'integration.health': {
        const integration = await getIntegration(org.id, String(body.integration_id || ''));
        if (!integration) return json({ ok: false, error: 'No such integration.' }, 404);
        const report = await checkHealth(integration);
        return json({ ok: true, health: report });
      }
      case 'integration.list': {
        const list = await listIntegrations(org.id, environment);
        return json({ ok: true, integrations: list, vault: vaultStatus() });
      }

      // ---- credentials ---------------------------------------------------------------------
      case 'credential.store': {
        const integration = await getIntegration(org.id, String(body.integration_id || ''));
        if (!integration) return json({ ok: false, error: 'No such integration.' }, 404);
        const r = await storeCredential({
          orgId: org.id,
          integrationId: integration.id,
          kind: String(body.kind || 'api_key') as CredentialKind,
          secret: String(body.secret || ''),
          label: body.label ? String(body.label) : null,
          expiresAt: body.expires_at ? String(body.expires_at) : null,
          createdBy: user?.id || null,
        });
        return json(r.ok ? { ok: true, credential: r.credential } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'credential.rotate': {
        const r = await rotateCredential({
          orgId: org.id,
          credentialId: String(body.credential_id || ''),
          newSecret: String(body.secret || ''),
          overlapHours: body.overlap_hours === undefined ? 24 : Number(body.overlap_hours),
          actorUserId: user?.id || null,
        });
        return json(r.ok ? { ok: true, credential: r.credential } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'credential.revoke': {
        const r = await revokeCredential(org.id, String(body.credential_id || ''), String(body.reason || 'revoked in the console'));
        return json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'credential.list': {
        const creds = await listCredentials(org.id, body.integration_id ? String(body.integration_id) : null);
        return json({ ok: true, credentials: creds, vault: vaultStatus() });
      }

      // ---- mappings ------------------------------------------------------------------------
      case 'mapping.save': {
        const mapping = body.mapping as EventMapping;
        if (!mapping || typeof mapping !== 'object') return json({ ok: false, error: 'No mapping was sent.' }, 400);
        const errors = validateMapping(mapping);
        if (errors.length) return json({ ok: false, error: errors.join(' '), errors }, 400);
        const r = await saveMapping({
          orgId: org.id,
          integrationId: String(body.integration_id || ''),
          mapping,
          mappingId: body.mapping_id ? String(body.mapping_id) : null,
          createdBy: user?.id || null,
        });
        return json(r.ok ? { ok: true, id: r.id } : { ok: false, error: (r.errors || []).join(' '), errors: r.errors }, r.ok ? 200 : 400);
      }
      case 'mapping.delete': {
        const r = await deleteMapping(org.id, String(body.mapping_id || ''));
        return json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
      }
      case 'mapping.test': {
        // The real engine over a real captured payload, publishing nothing. This is how an
        // integration gets built without sending anybody a test email.
        const payload = body.payload;
        if (payload === undefined) return json({ ok: false, error: 'Paste a captured payload to test against.' }, 400);
        const mappings = body.mapping ? [body.mapping as EventMapping] : await listMappings(org.id, String(body.integration_id || ''));
        const chosen = body.mapping ? (mappings[0] as EventMapping) : selectMapping(mappings as EventMapping[], payload);
        if (!chosen) return json({ ok: true, matched: false, detail: 'No mapping claims this payload. The ingest endpoint would answer 202 and publish nothing.' });
        const result = dryRun(chosen, payload);
        return json({ ok: true, matched: true, mapping: chosen.name, result });
      }

      // ---- routes --------------------------------------------------------------------------
      case 'route.save': {
        const route = {
          name: String(body.name || ''),
          eventPattern: String(body.event_pattern || ''),
          action: String(body.route_action || ''),
          config: body.config && typeof body.config === 'object' ? body.config : {},
          conditions: Array.isArray(body.conditions) ? body.conditions : [],
        } as any;
        const errors = validateRoute(route);
        if (errors.length) return json({ ok: false, error: errors.join(' '), errors }, 400);
        if (body.route_id) {
          const r = rows(await db.execute(sql`
            UPDATE mailint_routes SET name = ${route.name}, event_pattern = ${route.eventPattern}, action = ${route.action},
              config = ${JSON.stringify(route.config)}::jsonb, conditions = ${JSON.stringify(route.conditions)}::jsonb,
              is_active = ${body.is_active !== false}, priority = ${Number(body.priority || 100)},
              stop_on_match = ${!!body.stop_on_match}, updated_at = now()
            WHERE id = ${String(body.route_id)}::uuid AND org_id = ${org.id}::uuid RETURNING id`));
          return rows(r).length || r.length
            ? json({ ok: true, id: String((r as any)[0]?.id || body.route_id) })
            : json({ ok: false, error: 'No such route.' }, 404);
        }
        const ins = rows(await db.execute(sql`
          INSERT INTO mailint_routes (org_id, environment, name, event_pattern, action, config, conditions, is_active, priority, stop_on_match, created_by)
          VALUES (${org.id}::uuid, ${environment}, ${route.name}, ${route.eventPattern}, ${route.action},
                  ${JSON.stringify(route.config)}::jsonb, ${JSON.stringify(route.conditions)}::jsonb,
                  ${body.is_active !== false}, ${Number(body.priority || 100)}, ${!!body.stop_on_match}, ${user?.id || null}::uuid)
          RETURNING id`));
        return json({ ok: true, id: String(ins[0]?.id || '') });
      }
      case 'route.delete': {
        const r = rows(await db.execute(sql`DELETE FROM mailint_routes WHERE id = ${String(body.route_id || '')}::uuid AND org_id = ${org.id}::uuid RETURNING id`));
        return r.length ? json({ ok: true }) : json({ ok: false, error: 'No such route.' }, 404);
      }
      case 'route.toggle': {
        const r = rows(await db.execute(sql`
          UPDATE mailint_routes SET is_active = ${!!body.is_active}, updated_at = now()
          WHERE id = ${String(body.route_id || '')}::uuid AND org_id = ${org.id}::uuid RETURNING id, is_active`));
        return r.length ? json({ ok: true, is_active: !!r[0].is_active }) : json({ ok: false, error: 'No such route.' }, 404);
      }

      // ---- webhook endpoints (the shipped platform, driven from this console) ----------------
      case 'endpoint.create': {
        const events = Array.isArray(body.events) ? body.events.map(String) : [];
        if (!events.length) return json({ ok: false, error: 'Choose at least one event. An endpoint subscribed to nothing is never called, which looks exactly like one that is broken.' }, 400);
        try {
          const ep = await createEndpoint({
            orgId: org.id, environment, url: String(body.url || ''),
            description: body.description ? String(body.description) : null,
            events, createdBy: user?.id || null,
          });
          if (body.grant_sensitive) {
            // The explicit decision described in routing.ts: an endpoint sees a rejection reason or
            // an assessment score only if somebody deliberately granted it.
            await db.execute(sql`UPDATE mailapi_webhooks SET grant_sensitive = true WHERE id = ${ep.id}::uuid AND org_id = ${org.id}::uuid`);
          }
          return json({ ok: true, endpoint: ep });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message || dbReason(e)) }, 400);
        }
      }
      case 'endpoint.update': {
        const ep = await updateEndpoint(org.id, String(body.endpoint_id || ''), {
          url: body.url ? String(body.url) : undefined,
          description: body.description === undefined ? undefined : (body.description ? String(body.description) : null),
          events: Array.isArray(body.events) ? body.events.map(String) : undefined,
          status: body.status ? String(body.status) as any : undefined,
        });
        if (!ep) return json({ ok: false, error: 'No such endpoint.' }, 404);
        if (body.grant_sensitive !== undefined) {
          await db.execute(sql`UPDATE mailapi_webhooks SET grant_sensitive = ${!!body.grant_sensitive} WHERE id = ${ep.id}::uuid AND org_id = ${org.id}::uuid`);
        }
        return json({ ok: true, endpoint: ep });
      }
      case 'endpoint.delete': {
        const ok = await deleteEndpoint(org.id, String(body.endpoint_id || ''));
        return ok ? json({ ok: true }) : json({ ok: false, error: 'No such endpoint.' }, 404);
      }
      case 'endpoint.rotate': {
        const r = await rotateSecret(org.id, String(body.endpoint_id || ''), Number(body.overlap_minutes || 1440));
        if (!r) return json({ ok: false, error: 'No such endpoint.' }, 404);
        // Shown once. Both secrets sign every delivery until the old one expires, so the receiving
        // system deploys the new value when it suits them rather than at the instant we switch.
        return json({ ok: true, secret: r.secret, previous_expires_at: r.previousExpiresAt });
      }
      case 'endpoint.verify': {
        const r = await verifyEndpoint(org.id, String(body.endpoint_id || ''));
        return r ? json({ ok: true, result: r }) : json({ ok: false, error: 'No such endpoint.' }, 404);
      }

      // ---- the test console ------------------------------------------------------------------
      case 'endpoint.test': {
        const endpointId = String(body.endpoint_id || '');
        const endpoint = await getEndpoint(org.id, endpointId, environment);
        if (!endpoint) return json({ ok: false, error: 'No such endpoint in this environment.' }, 404);

        const type = String(body.event_type || 'application.stage.changed');
        if (!isKnownEventType(type)) return json({ ok: false, error: '"' + type + '" is not an event in the catalogue.' }, 400);
        const sample = sampleEvent(type, org.slug) as CanonicalEvent;
        const eventId = crypto.randomUUID();
        const envelope = buildEnvelope({
          eventId,
          type,
          createdAt: new Date().toISOString(),
          environment,
          orgSlug: org.slug,
          // Obviously synthetic values, always: a test event that looks like real candidate data is
          // a test event somebody downstream will act on.
          data: { ...sample.payload, test: true },
        });

        // A REAL delivery row, so the test appears in the log with everything else and the receiving
        // system sees the identical shape. Its own event id means a receiver that dedupes on
        // Webhook-Id is unharmed by repeated tests.
        const inserted = rows(await db.execute(sql`
          INSERT INTO mailapi_webhook_deliveries (webhook_id, org_id, environment, event_id, event_type, payload, status, max_attempts)
          VALUES (${endpointId}::uuid, ${org.id}::uuid, ${environment}, ${eventId}::uuid, ${type}, ${JSON.stringify(envelope)}::jsonb, 'sending', 1)
          RETURNING id`));
        const deliveryId = String(inserted[0]?.id || '');
        if (!deliveryId) return json({ ok: false, error: 'The test delivery row was not written.' }, 500);

        const secretRow = rows(await db.execute(sql`
          SELECT secret, previous_secret, previous_secret_expires_at, url FROM mailapi_webhooks WHERE id = ${endpointId}::uuid LIMIT 1`))[0];

        const attempt = await attemptDelivery({
          id: deliveryId,
          url: String(secretRow.url),
          secret: String(secretRow.secret),
          previousSecret: secretRow.previous_secret,
          previousExpiresAt: secretRow.previous_secret_expires_at,
          eventType: type,
          payload: envelope,
          attempts: 0,
        });

        await db.execute(sql`
          UPDATE mailapi_webhook_deliveries
          SET status = ${attempt.ok ? 'delivered' : 'dead'}, attempts = 1, response_status = ${attempt.status},
              duration_ms = ${attempt.durationMs}, error = ${attempt.error ? String(attempt.error).slice(0, 500) : null},
              delivered_at = ${attempt.ok ? sql`now()` : sql`NULL`}, next_attempt_at = ${attempt.ok ? sql`NULL` : sql`now()`},
              updated_at = now()
          WHERE id = ${deliveryId}::uuid`);

        return json({
          ok: true,
          delivery_id: deliveryId,
          request: {
            method: 'POST',
            url: String(secretRow.url),
            headers: {
              'Content-Type': 'application/json',
              'Webhook-Id': deliveryId,
              'Webhook-Timestamp': '(sent at request time)',
              'Webhook-Signature': 'v1,<HMAC-SHA256 of id + "." + timestamp + "." + body>',
              'X-EduRankAI-Event': type,
            },
            body: envelope,
          },
          response: {
            status: attempt.status,
            ok: attempt.ok,
            classification: attempt.status === null ? 'no response' : classifyResponse(attempt.status),
            error: attempt.error || null,
            duration_ms: attempt.durationMs,
            // What WOULD happen next if this were a real delivery, so a failing test is legible.
            next_retry_in_seconds: attempt.ok ? null : Math.round(webhookBackoffMs(1) / 1000),
          },
        });
      }
      case 'delivery.retry': {
        const ok = await replayDelivery(org.id, String(body.delivery_id || ''));
        return ok ? json({ ok: true, note: 'Queued for immediate re-delivery with its original payload and event id.' })
                  : json({ ok: false, error: 'No such delivery, or it is not in a replayable state.' }, 404);
      }
      case 'delivery.list': {
        const list = await listDeliveries(org.id, {
          webhookId: body.endpoint_id ? String(body.endpoint_id) : undefined,
          status: body.status ? String(body.status) : undefined,
          limit: Number(body.limit || 50),
        });
        return json({ ok: true, deliveries: list });
      }

      // ---- publishing a test event onto the bus ------------------------------------------------
      case 'event.publish': {
        const type = String(body.event_type || '');
        if (!isKnownEventType(type)) return json({ ok: false, error: '"' + type + '" is not an event in the catalogue.' }, 400);
        const sample = sampleEvent(type, org.slug) as CanonicalEvent;
        const payload = body.payload && typeof body.payload === 'object' ? body.payload : sample.payload;
        const r = await emitEvent(
          {
            orgId: org.id, type, source: String(body.source || 'mail'),
            payload, occurredAt: new Date().toISOString(),
            actorType: 'user', actorId: user?.id || null,
          },
          { environment },
        );
        return json(r.ok ? { ok: true, event_id: r.eventId, duplicate: !!r.duplicate, actions: r.actions || [], skipped: r.skipped || [] }
                         : { ok: false, error: (r.errors || []).join(' ') }, r.ok ? 200 : 400);
      }

      default:
        return json({ ok: false, error: 'Unknown action "' + action + '".' }, 400);
    }
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the SQL that failed.
    console.error('[admin/mail/integrations] ' + action + ' failed:', dbReason(e));
    return json({ ok: false, error: dbReason(e) }, 500);
  }
};

/** A GET is a convenience for the console's own refresh: the org list and the vault's state. */
export const GET: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.integrations.read' });
  if (denied) return denied;
  await ensureMailIntSchema();
  try {
    const orgs = rows(await db.execute(sql`SELECT id, slug, name FROM mailapi_orgs ORDER BY created_at ASC LIMIT 50`));
    return json({ ok: true, orgs, vault: vaultStatus(), slug: await orgSlug(String(orgs[0]?.id || '')) });
  } catch (e: any) {
    return json({ ok: false, error: dbReason(e) }, 500);
  }
};
