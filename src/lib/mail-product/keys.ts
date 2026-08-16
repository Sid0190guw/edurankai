// src/lib/mail-product/keys.ts — API keys and webhooks.
//
// THE SECRET IS SHOWN ONCE AND STORED NEVER. mail_api_keys holds a SHA-256 of the key and the first
// twelve characters, and nothing else. The twelve characters exist so the list screen can say which
// key somebody is looking at; they are not enough to authenticate with, and there is no code path
// anywhere that can reconstruct a key from a stored row. A products' "view key" button is a products'
// plaintext secret store, and this one does not have either.
//
// A REVOKED KEY IS KEPT, NOT DELETED. revoked_at is set and the row stays, so "which key was that
// call made with" still has an answer after the key is gone.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { textArray } from '@/lib/pg-array';
import { ensureMailProductSchema } from './schema';
import { rowsOf, reasonOf, isUuid, str, clampInt } from './common';

/** What a key may do. Deliberately coarse — a scope nobody can explain is a scope nobody sets right. */
export const API_SCOPES: { key: string; label: string; detail: string }[] = [
  { key: 'mail.send', label: 'Send mail', detail: 'Send transactional messages through the API.' },
  { key: 'contacts.read', label: 'Read contacts', detail: 'List and look up contacts, lists and segments.' },
  { key: 'contacts.write', label: 'Write contacts', detail: 'Create, update and unsubscribe contacts.' },
  { key: 'campaigns.read', label: 'Read campaigns', detail: 'List campaigns and read their reports.' },
  { key: 'templates.read', label: 'Read templates', detail: 'Fetch template content for rendering elsewhere.' },
  { key: 'events.read', label: 'Read events', detail: 'Pull delivery, open and click events.' },
];
const SCOPE_KEYS = new Set(API_SCOPES.map((s) => s.key));

/** Every event a webhook can subscribe to. Same vocabulary as mail_campaign_events.type. */
export const WEBHOOK_EVENTS: { key: string; label: string }[] = [
  { key: 'sent', label: 'Message sent' },
  { key: 'delivered', label: 'Message delivered' },
  { key: 'deferred', label: 'Delivery deferred' },
  { key: 'bounced', label: 'Message bounced' },
  { key: 'opened', label: 'Message opened' },
  { key: 'clicked', label: 'Link clicked' },
  { key: 'unsubscribed', label: 'Recipient unsubscribed' },
  { key: 'complained', label: 'Spam complaint' },
  { key: 'campaign.completed', label: 'Campaign completed' },
];
const EVENT_KEYS = new Set(WEBHOOK_EVENTS.map((e) => e.key));

function hashKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface ApiKeyRow {
  id: string; name: string; key_prefix: string; scopes: string[];
  created_at: string; last_used_at: string | null; revoked_at: string | null;
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  await ensureMailProductSchema();
  // key_hash is not selected. Not because it is dangerous to read here, but because a column that is
  // never in a result set cannot end up in a log line, an error payload or a debug dump.
  const r = await db.execute(sql`
    SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at
    FROM mail_api_keys ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 200`);
  return rowsOf<ApiKeyRow>(r);
}

/** Returns the plaintext key EXACTLY ONCE. Nothing stores it; the caller must show it and move on. */
export async function createApiKey(input: { name: string; scopes: string[]; by?: string | null }):
  Promise<{ id: string | null; key?: string; error?: string }> {
  await ensureMailProductSchema();
  const name = str(input.name, 120);
  if (!name) return { id: null, error: 'Give the key a name — "which key is this" is the only question a list of keys has to answer.' };
  const scopes = (input.scopes || []).map(String).filter((s) => SCOPE_KEYS.has(s)).slice(0, 20);
  if (!scopes.length) return { id: null, error: 'Choose at least one permission. A key with no scopes can do nothing and would only be confusing.' };

  // 32 bytes of CSPRNG. The `era_` prefix makes a leaked key greppable in a repository or a log.
  const raw = 'era_' + randomBytes(32).toString('base64url');
  try {
    const r = await db.execute(sql`
      INSERT INTO mail_api_keys (name, key_prefix, key_hash, scopes, created_by)
      VALUES (${name}, ${raw.slice(0, 12)}, ${hashKey(raw)}, ${textArray(scopes)}, ${isUuid(input.by || '') ? input.by : null})
      RETURNING id`);
    const id = rowsOf(r)[0]?.id ?? null;
    return id ? { id, key: raw } : { id: null, error: 'The key was not created.' };
  } catch (e: any) {
    console.error('[mail-product] createApiKey failed:', reasonOf(e));
    return { id: null, error: reasonOf(e) };
  }
}

export async function revokeApiKey(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  await ensureMailProductSchema();
  const r = await db.execute(sql`UPDATE mail_api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id`);
  return rowsOf(r).length > 0;
}

/**
 * Authenticate a presented key.
 *
 * Constant-time comparison on the HASH, and the lookup is BY hash rather than by prefix — so the
 * statement cannot be used as an oracle for which prefixes exist. Returns null for a revoked key.
 */
export async function verifyApiKey(presented: string): Promise<{ id: string; scopes: string[] } | null> {
  const raw = String(presented || '').trim();
  if (!raw.startsWith('era_') || raw.length < 20 || raw.length > 200) return null;
  await ensureMailProductSchema();
  const hash = hashKey(raw);
  try {
    const row = rowsOf(await db.execute(sql`
      SELECT id, key_hash, scopes FROM mail_api_keys WHERE key_hash = ${hash} AND revoked_at IS NULL LIMIT 1`))[0];
    if (!row) return null;
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(String(row.key_hash), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    // Best-effort: a failed last_used write must not refuse a valid key.
    db.execute(sql`UPDATE mail_api_keys SET last_used_at = now() WHERE id = ${row.id}`).catch(() => {});
    return { id: row.id, scopes: Array.isArray(row.scopes) ? row.scopes : [] };
  } catch (e: any) {
    // FAILS CLOSED. A database hiccup refuses the call; it never admits one.
    console.error('[mail-product] verifyApiKey failed:', reasonOf(e));
    return null;
  }
}

// ---- Webhooks ------------------------------------------------------------------------------------

export interface WebhookRow {
  id: string; url: string; events: string[]; is_active: boolean;
  failure_count: number; last_delivery_at: string | null; created_at: string;
}

export async function listWebhooks(): Promise<WebhookRow[]> {
  await ensureMailProductSchema();
  const r = await db.execute(sql`
    SELECT id, url, events, is_active, failure_count, last_delivery_at, created_at
    FROM mail_webhooks ORDER BY created_at DESC LIMIT 100`);
  return rowsOf<WebhookRow>(r);
}

export async function createWebhook(input: { url: string; events: string[]; by?: string | null }):
  Promise<{ id: string | null; secret?: string; error?: string }> {
  await ensureMailProductSchema();
  const url = str(input.url, 500);
  // https only. A webhook carries recipient email addresses and delivery events; over http that is
  // somebody's audience on the wire in plain text.
  if (!/^https:\/\/[^\s]+$/i.test(url)) return { id: null, error: 'The endpoint must be an https:// URL. Delivery events carry recipient addresses and must not travel unencrypted.' };
  const events = (input.events || []).map(String).filter((e) => EVENT_KEYS.has(e)).slice(0, 20);
  if (!events.length) return { id: null, error: 'Choose at least one event to send.' };

  const secret = 'whsec_' + randomBytes(24).toString('base64url');
  try {
    const r = await db.execute(sql`
      INSERT INTO mail_webhooks (url, events, secret, created_by)
      VALUES (${url}, ${textArray(events)}, ${secret}, ${isUuid(input.by || '') ? input.by : null})
      RETURNING id`);
    const id = rowsOf(r)[0]?.id ?? null;
    return id ? { id, secret } : { id: null, error: 'The webhook was not created.' };
  } catch (e: any) {
    return { id: null, error: reasonOf(e) };
  }
}

export async function setWebhookActive(id: string, active: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const r = await db.execute(sql`
    UPDATE mail_webhooks SET is_active = ${active}, failure_count = CASE WHEN ${active} THEN 0 ELSE failure_count END
    WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const r = await db.execute(sql`DELETE FROM mail_webhooks WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function listDeliveries(webhookId: string, limit = 25): Promise<any[]> {
  if (!isUuid(webhookId)) return [];
  const r = await db.execute(sql`
    SELECT id, event, attempt, ok, status_code, response_body, created_at
    FROM mail_webhook_deliveries WHERE webhook_id = ${webhookId}
    ORDER BY created_at DESC LIMIT ${clampInt(limit, 1, 100, 25)}`);
  return rowsOf(r);
}

/**
 * Deliver one event, signed, and record the attempt.
 *
 * The signature is HMAC-ish by construction (sha256 of secret + timestamp + body); a receiver
 * recomputes it and compares. Timestamped so a captured request cannot be replayed indefinitely.
 *
 * ONE ATTEMPT PER CALL, and the attempt number travels in. Retrying is the caller's decision — a
 * retry loop inside a request handler is a request handler that times out holding a connection.
 */
export async function deliverWebhook(
  webhookId: string, event: string, payload: unknown, attempt = 1,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!isUuid(webhookId)) return { ok: false, error: 'Unknown webhook.' };
  await ensureMailProductSchema();
  const hook = rowsOf(await db.execute(sql`SELECT * FROM mail_webhooks WHERE id = ${webhookId} LIMIT 1`))[0];
  if (!hook) return { ok: false, error: 'Unknown webhook.' };
  if (!hook.is_active) return { ok: false, error: 'This webhook is switched off, so nothing was sent.' };

  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event, timestamp: ts, data: payload });
  const signature = createHash('sha256').update(`${hook.secret || ''}.${ts}.${body}`, 'utf8').digest('hex');

  let ok = false;
  let status: number | undefined;
  let responseBody = '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EduRankAI-Event': event,
        'X-EduRankAI-Timestamp': String(ts),
        'X-EduRankAI-Signature': signature,
      },
      body,
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    status = res.status;
    ok = res.ok;
    responseBody = (await res.text().catch(() => '')).slice(0, 2000);
  } catch (e: any) {
    responseBody = e?.name === 'AbortError' ? 'The endpoint did not answer within 8 seconds.' : reasonOf(e);
  }

  await db.execute(sql`
    INSERT INTO mail_webhook_deliveries (webhook_id, event, attempt, ok, status_code, response_body)
    VALUES (${webhookId}, ${str(event, 60)}, ${clampInt(attempt, 1, 20, 1)}, ${ok}, ${status ?? null}, ${responseBody})
  `).catch((e: any) => console.error('[mail-product] delivery log:', reasonOf(e)));

  await db.execute(sql`
    UPDATE mail_webhooks SET last_delivery_at = now(),
      failure_count = CASE WHEN ${ok} THEN 0 ELSE failure_count + 1 END,
      -- Twenty consecutive failures is a dead endpoint, and continuing to post to it is how a
      -- product ends up on somebody else's abuse list. It is switched off, visibly, not silently.
      is_active = CASE WHEN NOT ${ok} AND failure_count + 1 >= 20 THEN false ELSE is_active END
    WHERE id = ${webhookId}`).catch(() => {});

  return { ok, status, error: ok ? undefined : (responseBody || 'The endpoint refused the delivery.') };
}
