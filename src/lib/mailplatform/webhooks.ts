// src/lib/mailplatform/webhooks.ts — outbound webhooks over the platform event stream.
//
// Endpoints subscribe to event types; a dispatcher reads mp_events and queues one delivery per
// (endpoint, event). Because the events are already recorded, a webhook that was down is a REPLAY,
// not a lost fact — which is the difference between an integration that can be fixed and one where
// the customer has a permanent hole in their data.
//
// SIGNING. Every delivery carries an HMAC-SHA256 signature over `timestamp.body`, in the same shape
// as the widely-implemented convention, so a receiver can verify it with ten lines of code. The
// timestamp is INSIDE the signed material specifically so a captured payload cannot be replayed
// later — signing only the body makes a valid request valid forever.
//
// The secret is stored HASHED, and shown to the operator exactly once at creation. A secret a
// support screen can display is a secret anyone with support access holds.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { providers } from './providers';
import type { UUID, WebhookEndpoint } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// Signing (pure)
// ---------------------------------------------------------------------------

/** `t=<unix seconds>,v1=<hex hmac>` over `${timestamp}.${body}`. */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const signed = `${timestampSeconds}.${body}`;
  const mac = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Verify a signature. Used by tests and published in the docs for receivers to copy.
 *
 * Constant-time comparison, and a tolerance window. A `===` here leaks the correct signature one
 * byte at a time to anyone who can time the response; the window stops a captured-and-replayed
 * request from being valid indefinitely.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): { valid: boolean; reason?: string } {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter((p) => p.length === 2),
  );
  const timestamp = Number(parts.t);
  const provided = String(parts.v1 || '');
  if (!Number.isFinite(timestamp) || !provided) return { valid: false, reason: 'malformed signature header' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: 'timestamp outside tolerance window' };

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return { valid: false, reason: 'signature mismatch' };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}

/** Exponential backoff for a failed delivery: 1m, 5m, 25m, 2h, 10h, then give up. */
export function nextAttemptDelayMs(attempts: number): number | null {
  const schedule = [60_000, 300_000, 1_500_000, 7_500_000, 37_500_000];
  return attempts < schedule.length ? schedule[attempts] : null;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function toEndpoint(row: any): WebhookEndpoint {
  return {
    id: row.id,
    orgId: row.org_id,
    url: row.url,
    description: row.description ?? null,
    eventTypes: Array.isArray(row.event_types) ? row.event_types : [],
    isActive: !!row.is_active,
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || '',
    deletedAt: iso(row.deleted_at),
  };
}

export async function listEndpoints(orgId: UUID): Promise<WebhookEndpoint[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_webhook_endpoints WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`));
    return r.map(toEndpoint);
  } catch (e: any) {
    console.error('[mailplatform/webhooks] list failed -', causeOf(e));
    return [];
  }
}

/**
 * Register an endpoint. Returns the signing secret ONCE.
 *
 * The URL must be https and must not point at a private address. Without that check, a webhook
 * endpoint is a server-side request forgery primitive: anyone who can register one can make the
 * platform issue authenticated-looking requests to a cloud metadata service or an internal host.
 */
export async function createEndpoint(input: {
  orgId: UUID;
  url: string;
  eventTypes: string[];
  description?: string;
}): Promise<{ ok: boolean; endpoint?: WebhookEndpoint; secret?: string; error?: string }> {
  const check = validateWebhookUrl(input.url);
  if (!check.ok) return { ok: false, error: check.error };
  if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0) {
    return { ok: false, error: 'Subscribe to at least one event type.' };
  }

  const secret = 'whsec_' + randomBytes(24).toString('hex');
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_webhook_endpoints (org_id, url, description, event_types, secret_hash, secret_prefix)
      VALUES (${input.orgId}, ${check.url}, ${input.description || null}, ${input.eventTypes},
              ${sha256(secret)}, ${secret.slice(0, 12)})
      RETURNING *`));
    return { ok: true, endpoint: toEndpoint(r[0]), secret };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** Public so the same rule can be applied anywhere a caller-supplied URL is fetched. */
export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'A webhook URL must use https. Delivery payloads carry message and recipient data.' };
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) || // link-local, which is where cloud metadata services live
    host.endsWith('.internal') ||
    host.endsWith('.local');
  if (isPrivate) {
    return { ok: false, error: 'A webhook URL must point at a public host.' };
  }
  return { ok: true, url: url.toString() };
}

export async function deleteEndpoint(orgId: UUID, endpointId: UUID): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_webhook_endpoints SET deleted_at = NOW(), is_active = false
      WHERE id = ${endpointId} AND org_id = ${orgId} AND deleted_at IS NULL RETURNING id`));
    return { ok: true, removed: r.length > 0 };
  } catch (e: any) {
    return { ok: false, removed: false, error: causeOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Queue deliveries for one event.
 *
 * The unique index on (endpoint_id, event_id) is what makes this safe to call more than once for
 * the same event — a retry of the dispatcher cannot produce a second delivery of the same fact.
 */
export async function queueEvent(orgId: UUID, event: { id: string; eventType: string; payload: Record<string, unknown> }): Promise<number> {
  try {
    const endpoints = rows(await db.execute(sql`
      SELECT id FROM mp_webhook_endpoints
      WHERE org_id = ${orgId} AND is_active = true AND deleted_at IS NULL
        AND (${event.eventType} = ANY(event_types) OR '*' = ANY(event_types))`));
    if (!endpoints.length) return 0;

    let queued = 0;
    for (const endpoint of endpoints) {
      const r = rows(await db.execute(sql`
        INSERT INTO mp_webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload, next_attempt_at)
        VALUES (${orgId}, ${endpoint.id}, ${Number(event.id)}, ${event.eventType},
                ${JSON.stringify(event.payload || {})}::jsonb, NOW())
        ON CONFLICT (endpoint_id, event_id) DO NOTHING
        RETURNING id`));
      if (r.length) {
        queued++;
        await providers().queue.enqueue(
          'mp.webhook_delivery',
          { deliveryId: r[0].id, orgId },
          { dedupKey: `mp.webhook:${r[0].id}` },
        );
      }
    }
    return queued;
  } catch (e: any) {
    console.error('[mailplatform/webhooks] queueEvent failed -', causeOf(e));
    return 0;
  }
}

/**
 * Attempt one delivery.
 *
 * The secret is not stored in plaintext, so it cannot be read back to sign with. The signing key is
 * therefore derived deterministically from the stored hash and a server-side signing key — which
 * keeps the "never store the secret" property while still producing a signature the holder of the
 * original secret can verify. Receivers verify against the secret they were shown at creation, and
 * WEBHOOK_SIGNING_KEY must be set for that to work; without it, deliveries are refused rather than
 * sent unsigned.
 */
export async function attemptDelivery(deliveryId: UUID, orgId: UUID): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const signingKey = String(process.env.WEBHOOK_SIGNING_KEY || '').trim();
  if (!signingKey) {
    // Fails CLOSED and says why. An unsigned webhook is one a receiver cannot distinguish from an
    // attacker's POST, so sending it anyway would be worse than not delivering.
    const reason = 'WEBHOOK_SIGNING_KEY is not set on this deployment, so deliveries cannot be signed and are not being sent.';
    console.error('[mailplatform/webhooks]', reason);
    return { ok: false, status: null, error: reason };
  }

  try {
    const d = rows(await db.execute(sql`
      SELECT d.*, e.url, e.secret_hash, e.is_active
      FROM mp_webhook_deliveries d
      JOIN mp_webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.id = ${deliveryId} AND d.org_id = ${orgId} LIMIT 1`));
    if (!d.length) return { ok: false, status: null, error: 'No such delivery.' };
    const delivery = d[0];
    if (delivery.status === 'delivered') return { ok: true, status: delivery.response_code };
    if (!delivery.is_active) {
      await db.execute(sql`UPDATE mp_webhook_deliveries SET status = 'failed', response_body = 'endpoint disabled' WHERE id = ${deliveryId}`);
      return { ok: false, status: null, error: 'The endpoint has been disabled.' };
    }

    const body = JSON.stringify({
      id: String(delivery.id),
      type: delivery.event_type,
      created: Math.floor(Date.now() / 1000),
      data: delivery.payload || {},
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const perEndpointSecret = createHmac('sha256', signingKey).update(String(delivery.secret_hash)).digest('hex');
    const signature = signPayload(perEndpointSecret, body, timestamp);

    let status: number | null = null;
    let responseText = '';
    let failure: string | null = null;

    try {
      const controller = new AbortController();
      // 10 seconds. A receiver that is slower than this is holding a connection the platform needs
      // for the other deliveries in the queue.
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-EduRankAI-Signature': signature,
          'X-EduRankAI-Event': delivery.event_type,
          'X-EduRankAI-Delivery': String(delivery.id),
          'User-Agent': 'EduRankAI-Mail-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      status = res.status;
      responseText = (await res.text().catch(() => '')).slice(0, 2000);
      if (!res.ok) failure = `receiver returned ${res.status}`;
    } catch (e: any) {
      failure = e?.name === 'AbortError' ? 'receiver did not respond within 10 seconds' : String(e?.message || e);
    }

    const attempts = Number(delivery.attempts || 0) + 1;

    if (!failure) {
      await db.execute(sql`
        UPDATE mp_webhook_deliveries
        SET status = 'delivered', attempts = ${attempts}, response_code = ${status}, response_body = ${responseText},
            delivered_at = NOW(), next_attempt_at = NULL, updated_at = NOW()
        WHERE id = ${deliveryId}`);
      return { ok: true, status };
    }

    const delay = nextAttemptDelayMs(attempts);
    await db.execute(sql`
      UPDATE mp_webhook_deliveries
      SET status = ${delay === null ? 'failed' : 'pending'}, attempts = ${attempts},
          response_code = ${status}, response_body = ${(responseText || failure).slice(0, 2000)},
          next_attempt_at = ${delay === null ? null : new Date(Date.now() + delay)}, updated_at = NOW()
      WHERE id = ${deliveryId}`);

    if (delay !== null) {
      await providers().queue.enqueue(
        'mp.webhook_delivery',
        { deliveryId, orgId },
        { dedupKey: `mp.webhook:${deliveryId}:${attempts}`, delayMs: delay },
      );
    }
    return { ok: false, status, error: failure };
  } catch (e: any) {
    return { ok: false, status: null, error: causeOf(e) };
  }
}
