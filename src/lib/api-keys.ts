// Partner / university integration API keys + signed lab-embed tokens.
// Universities issue an API key (admin), then call the read-only /api/v1/* REST
// endpoints and embed our labs in their own LMS via a signed embed URL.
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureApiKeysSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix VARCHAR(16) NOT NULL,
        label VARCHAR(200),
        organization VARCHAR(200),
        created_by UUID,
        is_active BOOLEAN NOT NULL DEFAULT true,
        last_used_at TIMESTAMPTZ,
        request_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    } catch (_) { /* table may already exist */ }
  })();
  return ready;
}

const EMBED_SECRET = process.env.API_EMBED_SECRET || process.env.SESSION_SECRET || 'edurankai-embed-secret-v1';

function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }
function b64url(buf: Buffer): string { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// ---- key management ----
export async function createApiKey(opts: { label?: string; organization?: string; createdBy?: string }): Promise<{ id: string; key: string; prefix: string }> {
  await ensureApiKeysSchema();
  const raw = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const key = 'erk_live_' + raw;
  const prefix = key.slice(0, 16);
  const r = rows(await db.execute(sql`
    INSERT INTO api_keys (key_hash, key_prefix, label, organization, created_by)
    VALUES (${sha256(key)}, ${prefix}, ${opts.label || null}, ${opts.organization || null}, ${opts.createdBy || null})
    RETURNING id`));
  return { id: r[0]?.id, key, prefix };
}

export async function listApiKeys(): Promise<any[]> {
  await ensureApiKeysSchema();
  return rows(await db.execute(sql`SELECT id, key_prefix, label, organization, is_active, last_used_at, request_count, created_at FROM api_keys ORDER BY created_at DESC LIMIT 200`));
}

export async function revokeApiKey(id: string): Promise<void> {
  await ensureApiKeysSchema();
  await db.execute(sql`UPDATE api_keys SET is_active = false WHERE id = ${id}`);
}

// Validate an inbound request's API key (header x-api-key or Authorization: Bearer).
export async function validateApiKey(request: Request): Promise<{ id: string; organization: string | null; label: string | null } | null> {
  await ensureApiKeysSchema();
  let key = request.headers.get('x-api-key') || '';
  if (!key) { const a = request.headers.get('authorization') || ''; if (/^bearer /i.test(a)) key = a.slice(7).trim(); }
  if (!key) { try { key = new URL(request.url).searchParams.get('api_key') || ''; } catch (_) {} }
  if (!key || !key.startsWith('erk_')) return null;
  try {
    const r = rows(await db.execute(sql`SELECT id, organization, label FROM api_keys WHERE key_hash = ${sha256(key)} AND is_active = true LIMIT 1`));
    if (r.length === 0) return null;
    db.execute(sql`UPDATE api_keys SET last_used_at = NOW(), request_count = request_count + 1 WHERE id = ${r[0].id}`).catch(() => {});
    return { id: r[0].id, organization: r[0].organization || null, label: r[0].label || null };
  } catch (_) { return null; }
}

// ---- signed lab-embed tokens (HMAC, no DB lookup so middleware stays fast) ----
export function signEmbedToken(slug: string): string {
  return b64url(crypto.createHmac('sha256', EMBED_SECRET).update('lab:' + slug).digest());
}
export function verifyEmbedToken(slug: string, token: string): boolean {
  if (!slug || !token) return false;
  const expected = signEmbedToken(slug);
  if (expected.length !== token.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token)); } catch (_) { return false; }
}

// CORS headers for the public REST API.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  'Access-Control-Max-Age': '86400',
};
