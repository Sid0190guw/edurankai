// src/lib/mailapi/webhooks.ts — event endpoints, signatures, retries and the dead-letter state.
//
// SIGNING IS THE WHOLE PRODUCT. An unsigned webhook is an open POST endpoint on somebody else's
// server that anybody can forge: "your candidate's application was rejected" is a message worth
// faking. So every delivery carries an HMAC over the id, the timestamp and the exact body, and the
// receiver is given a verifier (in both SDKs and in the docs) rather than being left to invent one.
//
// THE SIGNED STRING INCLUDES THE TIMESTAMP AND THE DELIVERY ID FOR TWO DIFFERENT REASONS. The
// timestamp lets a receiver reject anything older than its tolerance, which turns a captured request
// into a five-minute weapon instead of a permanent one. The id lets a receiver dedupe, which is what
// actually stops a replay — a retry of a genuine delivery reuses its id, so "have I processed this
// id?" is a complete answer and "is the signature valid?" is not.
//
// WE FETCH URLS THE CUSTOMER GIVES US, so this module refuses to resolve one that points inside our
// own network. Without that check a webhook endpoint is a server-side request forgery primitive
// aimed at the metadata service and every internal port on the host.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows, PAYLOAD_VERSION } from './schema';
import { ApiError } from './errors';
import { isUuid, type Environment } from './keys';

// ---------------------------------------------------------------------------
// Event catalogue
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'email.queued',
  'email.sent',
  'email.delivered',
  'email.deferred',
  'email.bounced',
  'email.failed',
  'email.opened',
  'email.clicked',
  'email.unsubscribed',
  'email.complained',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * Does an endpoint's subscription cover an event?
 *
 * An empty list means "everything" — the least surprising reading of a field left blank, and the
 * one that stops a new event type from being silently dropped by every existing endpoint.
 */
export function subscribes(subscription: readonly string[] | null | undefined, type: string): boolean {
  if (!subscription || subscription.length === 0) return true;
  const ns = String(type).split('.')[0];
  return subscription.some((s) => s === type || s === '*' || s === ns + '.*');
}

// ---------------------------------------------------------------------------
// Signatures — pure, and shared verbatim with both SDKs
// ---------------------------------------------------------------------------

export function mintWebhookSecret(): string {
  return 'whsec_' + crypto.randomBytes(32).toString('base64url');
}

// A LIVE SIGNING SECRET WAS BEING PARTIALLY HANDED OUT ON EVERY READ.
//
// `secretHint` used to be `secret.slice(0, 11) + '...' + secret.slice(-4)`. Six of those first eleven
// characters are the fixed `whsec_` scheme, so what actually went out was five characters of the head
// AND four characters of the tail of the 43-character random part — returned by GET /api/v1/webhooks
// and GET /api/v1/webhooks/:id, which are events.read calls a console makes on every page load. That
// is a large, permanent, repeatable slice of a value whose entire purpose is that only we and the
// endpoint owner ever see it, and read scope is exactly the wrong place to spend it.
//
// The replacement is the scheme prefix plus a truncated sha256 fingerprint. It still answers the only
// question the hint exists to answer — WHICH secret is this, is it the one I hold, did the rotation I
// clicked actually take — because it is stable across reads and an operator can hash the value in
// their own vault the same way and compare. It answers nothing else: the secret is 256 bits of CSPRNG
// output, so there is no dictionary to run against a digest of it and no route from 32 bits of hash
// back to the preimage that is cheaper than guessing the secret outright.
//
// The suffix is never returned again, in any form. The only way to read a secret back remains
// rotateSecret(), which shows the new value once.
const SECRET_HINT_LABEL = 'mailapi.webhook.secret.hint.v1:';

/**
 * A stable, non-disclosing identifier for a signing secret.
 *
 * The label is prepended before hashing so this fingerprint is domain-separated: it cannot be lined
 * up against a bare sha256 of the same string computed anywhere else (our own key hashing in keys.ts
 * included) to confirm that two systems hold the same value.
 *
 * Returns undefined for an absent secret rather than a placeholder string. "There is no secret on
 * this row" and "here is a hint" are different answers, and a caller that renders one as the other is
 * telling an operator their endpoint is signed when we cannot show that it is.
 */
export function webhookSecretHint(secret: string | null | undefined): string | undefined {
  const s = String(secret ?? '');
  if (!s) return undefined;
  const fingerprint = crypto.createHash('sha256').update(SECRET_HINT_LABEL + s, 'utf8').digest('hex').slice(0, 8);
  // Only the scheme marker is echoed, and only when it is the one this module mints. An unrecognised
  // value gets the fingerprint alone rather than a guessed prefix — printing back the head of
  // something we did not generate is how a hint starts leaking again.
  return (s.startsWith('whsec_') ? 'whsec_' : '') + '...' + fingerprint;
}

/** The exact bytes that get signed. Documented, because a receiver has to rebuild this string. */
export function signingString(id: string, timestamp: number | string, body: string): string {
  return String(id) + '.' + String(timestamp) + '.' + String(body);
}

export function signPayload(secret: string, id: string, timestamp: number | string, body: string): string {
  return 'v1,' + crypto.createHmac('sha256', secret).update(signingString(id, timestamp, body), 'utf8').digest('base64');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

export interface VerifyInput {
  secret: string;
  id: string;
  timestamp: number | string;
  /** The full header value; may carry several space-separated `v1,…` signatures during a rotation. */
  signature: string;
  body: string;
  /** How old a delivery may be, in seconds. Default 300. */
  toleranceSec?: number;
  nowMs?: number;
}

export interface VerifyResult { ok: boolean; reason?: 'bad_timestamp' | 'stale' | 'future' | 'no_match' }

/**
 * Verify a delivery. Exported so the tests, the docs, the console's "test my endpoint" helper and
 * both SDKs all check the same thing — a verifier that differs from the signer by one character is
 * the single most common webhook integration failure.
 */
export function verifySignature(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceSec ?? 300;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad_timestamp' };
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (now - ts > tolerance) return { ok: false, reason: 'stale' };
  if (ts - now > tolerance) return { ok: false, reason: 'future' };
  const expected = signPayload(input.secret, input.id, input.timestamp, input.body);
  const presented = String(input.signature || '').split(/\s+/).filter(Boolean);
  for (const p of presented) if (safeEqual(p, expected)) return { ok: true };
  return { ok: false, reason: 'no_match' };
}

/** Attempt 0 fires immediately; then 5s, 30s, 2m, 10m, 30m, 2h, 6h, capped at 12h. */
const BACKOFF_SEC = [0, 5, 30, 120, 600, 1800, 7200, 21600, 43200];
export function webhookBackoffMs(attempt: number): number {
  const i = Math.max(0, Math.min(BACKOFF_SEC.length - 1, Math.floor(attempt)));
  return BACKOFF_SEC[i] * 1000;
}

/** A 2xx means delivered. Everything else is a failure; 410 Gone means stop trying at all. */
export function classifyResponse(status: number): 'delivered' | 'retry' | 'dead' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 410) return 'dead';
  return 'retry';
}

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^0\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // carrier-grade NAT
];

export function isPrivateIp(ip: string): boolean {
  const v = String(ip || '').trim();
  if (net.isIPv4(v)) return PRIVATE_V4.some((re) => re.test(v));
  if (net.isIPv6(v)) {
    const l = v.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) hides a private v4 address inside a v6 literal.
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(l);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

/**
 * Validate a webhook URL and confirm it resolves somewhere public.
 *
 * The DNS lookup is deliberate: a hostname check alone is defeated by `evil.example.com A 127.0.0.1`.
 * This is not a complete defence against DNS rebinding (the name can resolve differently when the
 * delivery actually fires) — that needs a pinned-IP fetch, which is recorded as a follow-up rather
 * than claimed here. It does stop the ordinary case, which is somebody pointing a webhook at
 * localhost and reaching an admin port.
 */
export async function assertDeliverableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new ApiError('invalid_request', 'Webhook url must be an absolute URL.', { param: 'url' });
  }
  const allowInsecure = process.env.MAILAPI_ALLOW_INSECURE_WEBHOOKS === 'true';
  if (url.protocol !== 'https:' && !allowInsecure) {
    throw new ApiError('invalid_request', 'Webhook url must use https. Signed events carry recipient addresses.', { param: 'url' });
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ApiError('invalid_request', 'Webhook url must be reachable from the public internet.', { param: 'url' });
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new ApiError('invalid_request', 'Webhook url must be reachable from the public internet.', { param: 'url' });
  }
  if (!net.isIP(host)) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      if (addrs.length && addrs.every((a) => isPrivateIp(a.address))) {
        throw new ApiError('invalid_request', 'Webhook url resolves to a private address.', { param: 'url' });
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // A name that does not resolve yet is allowed through: DNS propagation is a normal reason for
      // a lookup to fail at the moment somebody registers an endpoint, and the delivery attempt will
      // report the real problem in its own log line.
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface WebhookEndpoint {
  id: string;
  orgId: string;
  environment: Environment;
  url: string;
  description: string | null;
  events: string[];
  status: 'pending_verification' | 'active' | 'disabled' | 'dead';
  verifiedAt: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: string;
  /** Present only in the create/rotate response. */
  secret?: string;
  /**
   * Which secret this endpoint holds, not what it is: `whsec_...` plus a truncated digest. Safe to
   * show on a read-scoped list; see webhookSecretHint for what this field used to give away.
   */
  secretHint?: string;
  previousSecretExpiresAt?: string | null;
}

function mapEndpoint(r: any): WebhookEndpoint {
  return {
    id: r.id,
    orgId: r.org_id,
    environment: r.environment,
    url: r.url,
    description: r.description || null,
    events: Array.isArray(r.events) ? r.events : [],
    status: r.status,
    verifiedAt: r.verified_at || null,
    consecutiveFailures: Number(r.consecutive_failures || 0),
    disabledReason: r.disabled_reason || null,
    createdAt: r.created_at,
    secretHint: webhookSecretHint(r.secret),
    previousSecretExpiresAt: r.previous_secret_expires_at || null,
  };
}

export async function createEndpoint(p: {
  orgId: string; environment: Environment; url: string; description?: string | null; events?: string[]; createdBy?: string | null;
}): Promise<WebhookEndpoint> {
  await ensureMailApiSchema();
  const url = await assertDeliverableUrl(p.url);
  const events = (p.events || []).filter((e) => e === '*' || /\.\*$/.test(e) || isEventType(e));
  if (p.events && p.events.length && events.length === 0) {
    throw new ApiError('invalid_request', 'None of those event types exist. Known types: ' + EVENT_TYPES.join(', '), { param: 'events' });
  }
  const secret = mintWebhookSecret();
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_webhooks (org_id, environment, url, description, events, secret, created_by)
    VALUES (${p.orgId}, ${p.environment}, ${url.toString()}, ${p.description || null}, ${JSON.stringify(events)}::jsonb, ${secret}, ${p.createdBy || null})
    RETURNING id, org_id, environment, url, description, events, status, verified_at, consecutive_failures, disabled_reason, created_at, secret, previous_secret_expires_at`));
  const ep = mapEndpoint(r[0]);
  ep.secret = secret; // shown once, on creation
  return ep;
}

export async function listEndpoints(orgId: string, environment?: Environment): Promise<WebhookEndpoint[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT id, org_id, environment, url, description, events, status, verified_at, consecutive_failures, disabled_reason, created_at, secret, previous_secret_expires_at
    FROM mailapi_webhooks
    WHERE org_id = ${orgId} AND (${environment || null}::text IS NULL OR environment = ${environment || null})
    ORDER BY created_at DESC LIMIT 100`)).map((r) => { const e = mapEndpoint(r); delete e.secret; return e; });
}

export async function getEndpoint(orgId: string, id: string, environment?: Environment): Promise<WebhookEndpoint | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT id, org_id, environment, url, description, events, status, verified_at, consecutive_failures, disabled_reason, created_at, secret, previous_secret_expires_at
    FROM mailapi_webhooks WHERE id = ${id.trim()} AND org_id = ${orgId}
      AND (${environment || null}::text IS NULL OR environment = ${environment || null}) LIMIT 1`));
  if (!r[0]) return null;
  const e = mapEndpoint(r[0]);
  delete e.secret;
  return e;
}

export async function updateEndpoint(orgId: string, id: string, p: { url?: string; description?: string | null; events?: string[]; status?: 'active' | 'disabled' }): Promise<WebhookEndpoint | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  const url = p.url ? (await assertDeliverableUrl(p.url)).toString() : null;
  const events = p.events ? p.events.filter((e) => e === '*' || /\.\*$/.test(e) || isEventType(e)) : null;
  const r = rows(await db.execute(sql`
    UPDATE mailapi_webhooks SET
      url = COALESCE(${url}, url),
      description = COALESCE(${p.description ?? null}, description),
      events = COALESCE(${events ? JSON.stringify(events) : null}::jsonb, events),
      status = COALESCE(${p.status || null}, status),
      disabled_reason = CASE WHEN ${p.status || null} = 'active' THEN NULL ELSE disabled_reason END,
      consecutive_failures = CASE WHEN ${p.status || null} = 'active' THEN 0 ELSE consecutive_failures END,
      updated_at = now()
    WHERE id = ${id.trim()} AND org_id = ${orgId}
    RETURNING id, org_id, environment, url, description, events, status, verified_at, consecutive_failures, disabled_reason, created_at, secret, previous_secret_expires_at`));
  if (!r[0]) return null;
  const e = mapEndpoint(r[0]);
  delete e.secret;
  return e;
}

export async function deleteEndpoint(orgId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`DELETE FROM mailapi_webhooks WHERE id = ${id.trim()} AND org_id = ${orgId} RETURNING id`));
  return r.length > 0;
}

/**
 * Rotate the signing secret with an overlap.
 *
 * Both secrets sign every delivery until the old one expires, so the receiver can deploy the new
 * value whenever it suits them. A rotation that took effect instantly would break every delivery
 * between the click and the deploy — which is how "rotate your secrets regularly" becomes advice
 * nobody follows.
 */
export async function rotateSecret(orgId: string, id: string, overlapMinutes = 1440): Promise<{ secret: string; previousExpiresAt: string } | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  const secret = mintWebhookSecret();
  const overlap = Math.max(0, Math.min(20160, overlapMinutes)); // up to 14 days
  const expiry = new Date(Date.now() + overlap * 60_000).toISOString();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_webhooks
    SET previous_secret = secret, previous_secret_expires_at = ${expiry}, secret = ${secret}, updated_at = now()
    WHERE id = ${id.trim()} AND org_id = ${orgId} RETURNING id`));
  return r.length ? { secret, previousExpiresAt: expiry } : null;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  id: string;
  type: string;
  api_version: string;
  created_at: string;
  environment: string;
  organization: string;
  data: Record<string, any>;
}

export function buildEnvelope(p: { eventId: string; type: string; createdAt: string; environment: string; orgSlug: string; data: Record<string, any> }): EventEnvelope {
  return {
    id: 'evt_' + p.eventId.replace(/-/g, '').slice(0, 24),
    type: p.type,
    api_version: PAYLOAD_VERSION,
    created_at: p.createdAt,
    environment: p.environment,
    organization: p.orgSlug,
    data: p.data,
  };
}

/**
 * Queue one delivery row per subscribed endpoint. Returns how many were queued.
 *
 * Queueing is separate from sending on purpose: the row is the durable record that this endpoint
 * owes this event. If the process dies immediately afterwards the dispatcher still finds it, and the
 * unique index on (webhook_id, event_id) means a second attempt to queue the same pair is a no-op
 * rather than a duplicate POST.
 */
export async function queueEvent(p: {
  orgId: string; orgSlug: string; environment: string; eventId: string; type: string; createdAt: string; data: Record<string, any>;
}): Promise<string[]> {
  await ensureMailApiSchema();
  const endpoints = rows(await db.execute(sql`
    SELECT id, events, status FROM mailapi_webhooks
    WHERE org_id = ${p.orgId} AND environment = ${p.environment} AND status IN ('active', 'pending_verification')`));
  const envelope = buildEnvelope(p);
  const queued: string[] = [];
  for (const ep of endpoints) {
    if (!subscribes(Array.isArray(ep.events) ? ep.events : [], p.type)) continue;
    try {
      const r = rows(await db.execute(sql`
        INSERT INTO mailapi_webhook_deliveries (webhook_id, org_id, environment, event_id, event_type, payload)
        VALUES (${ep.id}, ${p.orgId}, ${p.environment}, ${p.eventId}, ${p.type}, ${JSON.stringify(envelope)}::jsonb)
        ON CONFLICT (webhook_id, event_id) DO NOTHING
        RETURNING id`));
      if (r[0]) queued.push(r[0].id);
    } catch (e: any) {
      console.error('[mailapi] could not queue webhook delivery:', e?.cause?.message || e?.message);
    }
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const DELIVERY_TIMEOUT_MS = 10_000;
const DISABLE_AFTER_FAILURES = 20;

export interface DeliveryAttempt {
  deliveryId: string;
  ok: boolean;
  status: number | null;
  error?: string;
  durationMs: number;
}

/**
 * POST one delivery. The signature covers the exact bytes we send, so the body is serialised once
 * and reused — signing a re-serialised copy is how a signature comes to disagree with its payload.
 */
export async function attemptDelivery(delivery: {
  id: string; url: string; secret: string; previousSecret?: string | null; previousExpiresAt?: string | null;
  eventType: string; payload: any; attempts: number;
}): Promise<DeliveryAttempt> {
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const sigs = [signPayload(delivery.secret, delivery.id, timestamp, body)];
  if (delivery.previousSecret && (!delivery.previousExpiresAt || new Date(delivery.previousExpiresAt).getTime() > Date.now())) {
    sigs.push(signPayload(delivery.previousSecret, delivery.id, timestamp, body));
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(delivery.url, {
      method: 'POST',
      signal: ctrl.signal,
      // A redirect is a misconfiguration, and following one would send a signed payload carrying
      // recipient addresses to a host the customer never registered.
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'EduRankAI-Mail-Webhooks/1',
        'Webhook-Id': delivery.id,
        'Webhook-Timestamp': String(timestamp),
        'Webhook-Signature': sigs.join(' '),
        'X-EduRankAI-Event': delivery.eventType,
        'X-EduRankAI-Payload-Version': PAYLOAD_VERSION,
        'X-EduRankAI-Attempt': String(delivery.attempts + 1),
      },
      body,
    });
    const text = await res.text().catch(() => '');
    return {
      deliveryId: delivery.id,
      ok: classifyResponse(res.status) === 'delivered',
      status: res.status,
      error: classifyResponse(res.status) === 'delivered' ? undefined : 'HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : ''),
      durationMs: Date.now() - started,
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return {
      deliveryId: delivery.id,
      ok: false,
      status: null,
      error: aborted ? 'timed out after ' + DELIVERY_TIMEOUT_MS + 'ms' : String(e?.message || 'request failed').slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Claim due deliveries and post them.
 *
 * The claim is an UPDATE…RETURNING with SKIP LOCKED, the same shape mail-advanced.ts adopted after
 * two overlapping runs delivered the same scheduled mail twice. Two dispatchers running at once take
 * different rows instead of both taking the same one.
 */
export async function dispatchWebhooks(limit = 25, deadlineMs = 20_000): Promise<{ attempted: number; delivered: number; retried: number; dead: number }> {
  await ensureMailApiSchema();
  const started = Date.now();
  const claimed = rows(await db.execute(sql`
    UPDATE mailapi_webhook_deliveries d
    SET status = 'sending', claimed_at = now(), attempts = d.attempts + 1, updated_at = now()
    FROM mailapi_webhooks w
    WHERE d.webhook_id = w.id AND d.id IN (
      SELECT id FROM mailapi_webhook_deliveries
      WHERE status IN ('pending', 'sending') AND next_attempt_at <= now()
        AND (status = 'pending' OR claimed_at < now() - interval '5 minutes')
      ORDER BY next_attempt_at ASC LIMIT ${Math.min(100, limit)} FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.event_type, d.payload, d.attempts, d.max_attempts, d.webhook_id,
              w.url, w.secret, w.previous_secret, w.previous_secret_expires_at`));

  let delivered = 0, retried = 0, dead = 0;
  for (const row of claimed) {
    if (Date.now() - started > deadlineMs) {
      // Out of time: hand the rest back so the next run picks them up immediately, rather than
      // leaving them 'sending' for the five-minute stale window.
      await db.execute(sql`UPDATE mailapi_webhook_deliveries SET status = 'pending', attempts = GREATEST(0, attempts - 1) WHERE id = ${row.id}`);
      continue;
    }
    const attempt = await attemptDelivery({
      id: row.id, url: row.url, secret: row.secret, previousSecret: row.previous_secret,
      previousExpiresAt: row.previous_secret_expires_at, eventType: row.event_type,
      payload: row.payload, attempts: Number(row.attempts) - 1,
    });
    const attempts = Number(row.attempts);
    const maxAttempts = Number(row.max_attempts);
    const verdict = attempt.ok ? 'delivered' : (attempt.status === 410 ? 'dead' : (attempts >= maxAttempts ? 'dead' : 'retry'));

    if (verdict === 'delivered') {
      delivered++;
      await db.execute(sql`
        UPDATE mailapi_webhook_deliveries SET status = 'delivered', delivered_at = now(), response_status = ${attempt.status},
          duration_ms = ${attempt.durationMs}, error = NULL, updated_at = now() WHERE id = ${row.id}`);
      await db.execute(sql`
        UPDATE mailapi_webhooks SET consecutive_failures = 0, updated_at = now(),
          status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END,
          verified_at = COALESCE(verified_at, now())
        WHERE id = ${row.webhook_id}`);
      continue;
    }

    const next = new Date(Date.now() + webhookBackoffMs(attempts));
    await db.execute(sql`
      UPDATE mailapi_webhook_deliveries
      SET status = ${verdict === 'dead' ? 'dead' : 'pending'}, next_attempt_at = ${next.toISOString()},
          response_status = ${attempt.status}, duration_ms = ${attempt.durationMs},
          error = ${String(attempt.error || 'delivery failed').slice(0, 500)}, updated_at = now()
      WHERE id = ${row.id}`);
    // An endpoint that has failed twenty times in a row is gone, and continuing to post at it wastes
    // a dispatcher slot every run. It is disabled with the reason recorded, and the console offers a
    // re-enable — a silent stop would be worse than the failures.
    await db.execute(sql`
      UPDATE mailapi_webhooks SET consecutive_failures = consecutive_failures + 1, updated_at = now(),
        status = CASE WHEN consecutive_failures + 1 >= ${DISABLE_AFTER_FAILURES} THEN 'disabled' ELSE status END,
        disabled_reason = CASE WHEN consecutive_failures + 1 >= ${DISABLE_AFTER_FAILURES}
          THEN ${'disabled automatically after ' + DISABLE_AFTER_FAILURES + ' consecutive failures'} ELSE disabled_reason END
      WHERE id = ${row.webhook_id}`);
    if (verdict === 'dead') dead++; else retried++;
  }
  return { attempted: claimed.length, delivered, retried, dead };
}

export async function listDeliveries(orgId: string, opts: { webhookId?: string; status?: string; limit?: number } = {}): Promise<any[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT d.id, d.webhook_id, d.event_id, d.event_type, d.status, d.attempts, d.max_attempts, d.next_attempt_at,
           d.response_status, d.duration_ms, d.error, d.delivered_at, d.created_at, w.url
    FROM mailapi_webhook_deliveries d JOIN mailapi_webhooks w ON w.id = d.webhook_id
    WHERE d.org_id = ${orgId}
      AND (${opts.webhookId || null}::uuid IS NULL OR d.webhook_id = ${opts.webhookId || null}::uuid)
      AND (${opts.status || null}::text IS NULL OR d.status = ${opts.status || null})
    ORDER BY d.created_at DESC LIMIT ${Math.min(200, opts.limit || 50)}`));
}

/** Put a dead or failed delivery back in the queue. The manual recovery for the dead-letter state. */
export async function replayDelivery(orgId: string, deliveryId: string): Promise<boolean> {
  if (!isUuid(deliveryId)) return false;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_webhook_deliveries
    SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL, updated_at = now()
    WHERE id = ${deliveryId.trim()} AND org_id = ${orgId} AND status IN ('dead', 'pending') RETURNING id`));
  return r.length > 0;
}

/**
 * Send a verification event to an endpoint and report exactly what came back.
 *
 * This is the handshake: an endpoint stays `pending_verification` until it answers a signed POST
 * with a 2xx. It is also the "test my endpoint" button — the same request, so a green test means the
 * real thing will work.
 */
export async function verifyEndpoint(orgId: string, id: string): Promise<{ ok: boolean; status: number | null; error?: string; durationMs: number } | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT w.id, w.url, w.secret, w.previous_secret, w.previous_secret_expires_at, w.environment, o.slug AS org_slug
    FROM mailapi_webhooks w JOIN mailapi_orgs o ON o.id = w.org_id
    WHERE w.id = ${id.trim()} AND w.org_id = ${orgId} LIMIT 1`))[0];
  if (!r) return null;
  const envelope = buildEnvelope({
    eventId: crypto.randomUUID(),
    type: 'webhook.verification',
    createdAt: new Date().toISOString(),
    environment: r.environment,
    orgSlug: r.org_slug,
    data: { message: 'This is a signed verification event from EduRankAI Mail. Reply 2xx to activate this endpoint.' },
  });
  const attempt = await attemptDelivery({
    id: crypto.randomUUID(), url: r.url, secret: r.secret, previousSecret: r.previous_secret,
    previousExpiresAt: r.previous_secret_expires_at, eventType: 'webhook.verification', payload: envelope, attempts: 0,
  });
  if (attempt.ok) {
    await db.execute(sql`
      UPDATE mailapi_webhooks SET status = 'active', verified_at = now(), consecutive_failures = 0, disabled_reason = NULL, updated_at = now()
      WHERE id = ${r.id}`);
  }
  return { ok: attempt.ok, status: attempt.status, error: attempt.error, durationMs: attempt.durationMs };
}
