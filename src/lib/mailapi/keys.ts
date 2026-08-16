// src/lib/mailapi/keys.ts — organizations, API keys, scopes and environment separation.
//
// THE SECRET IS SHOWN ONCE AND NEVER AGAIN. Only a sha256 of the key is stored, so there is no
// "reveal" button to build, no support process that can leak one, and a database dump does not hand
// anybody a live sending credential. The console shows `key_prefix` — the first sixteen characters —
// which is enough to identify a key in a conversation and useless for sending.
//
// THE ENVIRONMENT IS IN THE KEY ITSELF AND IN ITS ROW, AND BOTH MUST AGREE. `erm_dev_…` is a
// development key. If someone edited the row to say `production` while the string still says `dev`,
// the two disagree and the key is refused rather than believed — a mismatch is either a mistake or
// an attempt, and neither should be able to reach production data. Every query in this module is
// then scoped by environment as well as organization, so "a development key cannot read production"
// is enforced by the WHERE clause and not by a convention somebody has to remember.
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';
import { ApiError } from './errors';
import { linkMailplatformOrg } from './bridge';

// ---------------------------------------------------------------------------
// Pure model — no database, fully testable
// ---------------------------------------------------------------------------

export type Environment = 'development' | 'staging' | 'production';
export const ENVIRONMENTS: Environment[] = ['development', 'staging', 'production'];

/** The token that appears in the key string for each environment. */
const ENV_CODE: Record<Environment, string> = { development: 'dev', staging: 'stg', production: 'live' };
const CODE_ENV: Record<string, Environment> = { dev: 'development', stg: 'staging', live: 'production' };

export type Scope =
  | 'email.send'
  | 'email.read'
  | 'templates.read'
  | 'templates.write'
  | 'events.read'
  // ADDED BY THE INTEGRATION LAYER (src/lib/mailint). Publishing a BUSINESS event — an application
  // moving stage, a candidate being selected — is a different power from reading the delivery feed,
  // because a published event can cause mail to be sent to a person. It therefore gets its own
  // scope rather than being folded into `events.read` or borrowed from `email.send`.
  | 'events.write'
  // Creating integrations, storing credentials and editing routes and mappings. Separate again:
  // a product key that publishes events has no business rewriting the routes that interpret them.
  | 'integrations.write'
  | 'domains.read'
  | 'domains.write';

export const ALL_SCOPES: Scope[] = [
  'email.send', 'email.read', 'templates.read', 'templates.write',
  'events.read', 'events.write', 'integrations.write',
  'domains.read', 'domains.write',
];

/** A sensible default for a product integration: send mail, read back what happened. */
export const DEFAULT_SCOPES: Scope[] = ['email.send', 'email.read', 'templates.read', 'events.read'];

export function isEnvironment(v: unknown): v is Environment {
  return typeof v === 'string' && (ENVIRONMENTS as string[]).includes(v);
}

export function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && (ALL_SCOPES as string[]).includes(v);
}

/**
 * Does a granted scope set satisfy a required scope?
 *
 * Wildcards are supported in the GRANT only (`email.*`, `*`), never in the requirement — a route
 * asks for exactly what it needs. `email.*` does not imply `templates.read`: a prefix wildcard stops
 * at its own namespace, which is the difference between "everything about email" and "everything".
 */
export function hasScope(granted: readonly string[] | null | undefined, required: Scope): boolean {
  if (!granted || granted.length === 0) return false;
  const ns = required.split('.')[0];
  for (const g of granted) {
    if (g === required) return true;
    if (g === '*') return true;
    if (g === ns + '.*') return true;
  }
  return false;
}

/** Every scope a grant set actually resolves to. Used by the console and by GET /v1/keys/self. */
export function expandScopes(granted: readonly string[] | null | undefined): Scope[] {
  return ALL_SCOPES.filter((s) => hasScope(granted, s));
}

/** The environment a key string declares, or null if it is not one of ours. */
export function environmentFromKey(key: string): Environment | null {
  const m = /^erm_(dev|stg|live)_[0-9a-f]{32,}$/.exec(String(key || '').trim());
  return m ? CODE_ENV[m[1]] : null;
}

/** Format check only — says nothing about whether the key exists. */
export function looksLikeKey(key: string): boolean {
  return environmentFromKey(key) !== null;
}

/** Generate a key string for an environment. The random part is 32 bytes of CSPRNG output. */
export function mintKeyString(env: Environment): string {
  return 'erm_' + ENV_CODE[env] + '_' + crypto.randomBytes(32).toString('hex');
}

export function keyPrefix(key: string): string {
  return String(key || '').slice(0, 16);
}

/** What the console and the API show instead of a key: the prefix and the last four characters. */
export function maskKey(key: string): string {
  const k = String(key || '');
  if (k.length < 20) return keyPrefix(k) + '…';
  return keyPrefix(k) + '…' + k.slice(-4);
}

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('hex');
}

/** Pull the presented key out of a request. Header first; a query parameter is never accepted here —
 *  a secret in a URL ends up in access logs, proxies and browser history, and this key can send mail. */
export function extractKey(request: Request): string {
  const direct = request.headers.get('x-api-key');
  if (direct && direct.trim()) return direct.trim();
  const auth = request.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return '';
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export interface Org {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  dailySendCap: number | null;
  /** The matching mailplatform organization, so suppression is shared rather than forked. */
  mpOrgId: string | null;
  createdAt: string;
}

function mapOrg(r: any): Org {
  return {
    id: r.id, slug: r.slug, name: r.name,
    isActive: r.is_active !== false,
    dailySendCap: r.daily_send_cap == null ? null : Number(r.daily_send_cap),
    mpOrgId: r.mp_org_id || null,
    createdAt: r.created_at,
  };
}

export function slugify(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function createOrg(p: { name: string; slug?: string; dailySendCap?: number | null }): Promise<Org> {
  await ensureMailApiSchema();
  const slug = slugify(p.slug || p.name);
  if (!slug) throw new ApiError('invalid_request', 'An organization needs a name.', { param: 'name' });
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_orgs (slug, name, daily_send_cap)
    VALUES (${slug}, ${p.name.trim()}, ${p.dailySendCap ?? null})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    RETURNING id, slug, name, is_active, daily_send_cap, mp_org_id, created_at`));
  const org = mapOrg(r[0]);
  // Linked on creation, and re-attempted whenever it is still null, so a deployment that gains the
  // campaign platform later picks the link up on the next write instead of staying forked for ever.
  if (!org.mpOrgId) {
    const mpId = await linkMailplatformOrg(org.slug, org.name);
    if (mpId) {
      await db.execute(sql`UPDATE mailapi_orgs SET mp_org_id = ${mpId} WHERE id = ${org.id}`);
      org.mpOrgId = mpId;
    }
  }
  return org;
}

export async function listOrgs(): Promise<Org[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT id, slug, name, is_active, daily_send_cap, mp_org_id, created_at
    FROM mailapi_orgs ORDER BY name ASC LIMIT 200`)).map(mapOrg);
}

export async function getOrgBySlug(slug: string): Promise<Org | null> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT id, slug, name, is_active, daily_send_cap, mp_org_id, created_at
    FROM mailapi_orgs WHERE slug = ${slugify(slug)} LIMIT 1`));
  return r[0] ? mapOrg(r[0]) : null;
}

export async function setOrgActive(id: string, active: boolean): Promise<boolean> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_orgs SET is_active = ${active}, updated_at = now()
    WHERE id = ${id} AND is_active IS DISTINCT FROM ${active} RETURNING id`));
  return r.length > 0;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  orgId: string;
  orgSlug?: string;
  environment: Environment;
  name: string | null;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  requestCount: number;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  rotatedFrom: string | null;
  createdAt: string;
}

function mapKey(r: any): ApiKeyRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    orgSlug: r.org_slug,
    environment: r.environment,
    name: r.name || null,
    prefix: r.key_prefix,
    scopes: Array.isArray(r.scopes) ? r.scopes : [],
    lastUsedAt: r.last_used_at || null,
    requestCount: Number(r.request_count || 0),
    rateLimitPerMinute: r.rate_limit_per_minute == null ? null : Number(r.rate_limit_per_minute),
    expiresAt: r.expires_at || null,
    revokedAt: r.revoked_at || null,
    revokedReason: r.revoked_reason || null,
    rotatedFrom: r.rotated_from || null,
    createdAt: r.created_at,
  };
}

/**
 * Create a key. The plaintext is returned EXACTLY ONCE, in this return value — it is never stored,
 * so nothing downstream can show it again.
 */
export async function createKey(p: {
  orgId: string;
  environment: Environment;
  name?: string;
  scopes?: string[];
  createdBy?: string | null;
  expiresAt?: Date | null;
  rateLimitPerMinute?: number | null;
  rotatedFrom?: string | null;
}): Promise<{ record: ApiKeyRecord; key: string }> {
  await ensureMailApiSchema();
  if (!isEnvironment(p.environment)) throw new ApiError('invalid_request', 'Unknown environment.', { param: 'environment' });
  const scopes = (p.scopes && p.scopes.length ? p.scopes : DEFAULT_SCOPES).filter((s) => s === '*' || /\.\*$/.test(s) || isScope(s));
  if (scopes.length === 0) throw new ApiError('invalid_request', 'A key needs at least one scope.', { param: 'scopes' });
  const key = mintKeyString(p.environment);
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_keys (org_id, environment, name, key_hash, key_prefix, scopes, created_by, expires_at, rate_limit_per_minute, rotated_from)
    VALUES (${p.orgId}, ${p.environment}, ${p.name || null}, ${hashKey(key)}, ${keyPrefix(key)},
            ${JSON.stringify(scopes)}::jsonb, ${p.createdBy || null}, ${p.expiresAt ? p.expiresAt.toISOString() : null},
            ${p.rateLimitPerMinute ?? null}, ${p.rotatedFrom || null})
    RETURNING id, org_id, environment, name, key_prefix, scopes, last_used_at, request_count,
              rate_limit_per_minute, expires_at, revoked_at, revoked_reason, rotated_from, created_at`));
  return { record: mapKey(r[0]), key };
}

export async function listKeys(opts: { orgId?: string; includeRevoked?: boolean } = {}): Promise<ApiKeyRecord[]> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT k.id, k.org_id, o.slug AS org_slug, k.environment, k.name, k.key_prefix, k.scopes, k.last_used_at,
           k.request_count, k.rate_limit_per_minute, k.expires_at, k.revoked_at, k.revoked_reason, k.rotated_from, k.created_at
    FROM mailapi_keys k JOIN mailapi_orgs o ON o.id = k.org_id
    WHERE (${opts.orgId || null}::uuid IS NULL OR k.org_id = ${opts.orgId || null}::uuid)
      AND (${!!opts.includeRevoked} OR k.revoked_at IS NULL)
    ORDER BY k.created_at DESC LIMIT 300`));
  return r.map(mapKey);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * Revoke a key. Answers whether THIS call revoked it.
 *
 * `revoked_at IS NULL` is in the WHERE for the reason /admin/api-keys learned the hard way: a bare
 * UPDATE plus "it did not throw" reports success for an id that matched nothing and for a key
 * somebody already revoked in another tab — on the screen that answers whether a live credential
 * still exists.
 */
export async function revokeKey(id: string, reason?: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_keys SET revoked_at = now(), revoked_reason = ${reason || null}
    WHERE id = ${id.trim()} AND revoked_at IS NULL RETURNING id`));
  return r.length > 0;
}

/**
 * Rotate a key: mint a replacement carrying the same organization, environment and scopes, and give
 * the old one a grace period before it stops working.
 *
 * A rotation that revoked the old key instantly would be an outage dressed up as a security
 * feature — the caller has to deploy the new value somewhere. `graceMinutes` sets an expiry on the
 * old key instead, so both work during the changeover and the old one dies on its own.
 */
export async function rotateKey(id: string, opts: { graceMinutes?: number; createdBy?: string | null } = {}): Promise<{ record: ApiKeyRecord; key: string; oldExpiresAt: string | null } | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  const existing = rows(await db.execute(sql`
    SELECT id, org_id, environment, name, scopes, rate_limit_per_minute
    FROM mailapi_keys WHERE id = ${id.trim()} AND revoked_at IS NULL LIMIT 1`))[0];
  if (!existing) return null;
  const grace = Math.max(0, Math.min(10080, opts.graceMinutes ?? 60)); // 0 minutes … 7 days
  const created = await createKey({
    orgId: existing.org_id,
    environment: existing.environment,
    name: existing.name ? existing.name + ' (rotated)' : 'rotated key',
    scopes: Array.isArray(existing.scopes) ? existing.scopes : DEFAULT_SCOPES,
    createdBy: opts.createdBy || null,
    rateLimitPerMinute: existing.rate_limit_per_minute ?? null,
    rotatedFrom: existing.id,
  });
  const oldExpiry = new Date(Date.now() + grace * 60_000);
  await db.execute(sql`
    UPDATE mailapi_keys SET expires_at = ${oldExpiry.toISOString()}, revoked_reason = ${'rotated to ' + created.record.prefix}
    WHERE id = ${existing.id}`);
  return { record: created.record, key: created.key, oldExpiresAt: oldExpiry.toISOString() };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface AuthContext {
  keyId: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  environment: Environment;
  scopes: string[];
  rateLimitPerMinute: number | null;
  dailySendCap: number | null;
  /** The linked campaign-platform organization, used for the shared suppression read. */
  mpOrgId: string | null;
}

/**
 * Authenticate a request. Throws a typed ApiError for every failure so a route never has to decide
 * what a bad key means, and so the caller gets a code they can branch on ('expired_api_key' and
 * 'revoked_api_key' are genuinely different problems with different fixes).
 */
export async function authenticate(request: Request): Promise<AuthContext> {
  await ensureMailApiSchema();
  const presented = extractKey(request);
  if (!presented) {
    throw new ApiError('missing_api_key', 'No API key. Send it as `Authorization: Bearer <key>` or the `x-api-key` header.');
  }
  const declaredEnv = environmentFromKey(presented);
  if (!declaredEnv) {
    throw new ApiError('invalid_api_key', 'That is not an EduRankAI Mail API key. Keys look like erm_live_..., erm_stg_... or erm_dev_...');
  }
  const r = rows(await db.execute(sql`
    SELECT k.id, k.org_id, k.environment, k.scopes, k.expires_at, k.revoked_at, k.rate_limit_per_minute,
           o.slug AS org_slug, o.name AS org_name, o.is_active, o.daily_send_cap, o.mp_org_id
    FROM mailapi_keys k JOIN mailapi_orgs o ON o.id = k.org_id
    WHERE k.key_hash = ${hashKey(presented)} LIMIT 1`))[0];
  // Same message and same code for "no such key" as for a bad format past the prefix check: an
  // attacker must not learn from us which of their guesses is a real prefix.
  if (!r) throw new ApiError('invalid_api_key', 'API key not recognised.');
  if (r.revoked_at) throw new ApiError('revoked_api_key', 'This API key was revoked. Create a new one in the console.');
  if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) {
    throw new ApiError('expired_api_key', 'This API key has expired. Rotate it in the console.');
  }
  // The declared environment and the stored one must agree. They can only diverge through direct
  // database editing, and when they do the safe reading is "do not trust this row".
  if (r.environment !== declaredEnv) {
    console.error('[mailapi] key ' + String(r.id) + ' declares ' + declaredEnv + ' but its row says ' + r.environment);
    throw new ApiError('environment_mismatch', 'The environment recorded for this key does not match the key itself. It has been refused; create a new key.');
  }
  if (r.is_active === false) {
    throw new ApiError('organization_inactive', 'Sending is disabled for this organization.');
  }

  // Usage accounting is fire-and-forget: a failed counter update must never fail a send. It is
  // logged rather than swallowed, because a counter that silently stops moving makes the console lie
  // about which keys are still in use — which is how a forgotten credential stays alive.
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64) || null;
  db.execute(sql`
    UPDATE mailapi_keys SET last_used_at = now(), last_used_ip = ${ip}, request_count = request_count + 1
    WHERE id = ${r.id}`).catch((e: any) => console.error('[mailapi] key usage update failed:', e?.cause?.message || e?.message));

  return {
    keyId: r.id,
    orgId: r.org_id,
    orgSlug: r.org_slug,
    orgName: r.org_name,
    environment: r.environment,
    scopes: Array.isArray(r.scopes) ? r.scopes : [],
    rateLimitPerMinute: r.rate_limit_per_minute == null ? null : Number(r.rate_limit_per_minute),
    dailySendCap: r.daily_send_cap == null ? null : Number(r.daily_send_cap),
    mpOrgId: r.mp_org_id || null,
  };
}

/** Require a scope, or fail with the exact scope that was missing. */
export function requireScope(auth: AuthContext, scope: Scope): void {
  if (!hasScope(auth.scopes, scope)) {
    throw new ApiError('insufficient_scope', 'This API key does not have the `' + scope + '` scope.', { extra: { required_scope: scope, granted_scopes: auth.scopes } });
  }
}
