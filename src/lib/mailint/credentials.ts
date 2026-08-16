// src/lib/mailint/credentials.ts — THE CREDENTIAL VAULT.
//
// Section 6 of the brief: API keys, OAuth tokens, webhook secrets and SMTP credentials, and "never
// expose secrets to frontend clients after creation".
//
// THAT RULE IS ENFORCED BY SHAPE, NOT BY DISCIPLINE. There is exactly one function in this file
// that returns plaintext — readSecret() — and it is called only by the connector context on the
// server. Everything an API route or a console page can reach (listCredentials, credentialSummary)
// returns metadata: kind, label, last four characters, fingerprint, expiry, state. There is no
// "reveal" endpoint, because the moment one exists it becomes the thing an admin session
// compromise is worth having.
//
// WHY GCM RATHER THAN A HASH. An API key we CHECK can be hashed (mailapi_keys does exactly that,
// and correctly). A credential we must PRESENT to somebody else's server has to be recoverable, so
// it is encrypted with an authenticated cipher: AES-256-GCM, random 12-byte nonce per record, and
// the auth tag stored alongside. The tag is what makes a tampered ciphertext fail to decrypt rather
// than decrypt to garbage that gets sent to a partner as a password.
//
// THE MASTER KEY IS NEVER IN THE DATABASE. It comes from the environment, and `key_id` on each row
// records which key encrypted it, so a master-key rotation re-encrypts row by row instead of
// invalidating every credential at once.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailIntSchema, rows, dbReason } from './schema';
import { credentialState, type CredentialState } from './policy';
import type { CredentialKind } from './connector';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** Environment variable names, in the order a key is looked for. */
const KEY_ENV = 'MAILINT_VAULT_KEY';
const PREVIOUS_KEY_ENV = 'MAILINT_VAULT_KEY_PREVIOUS';

export interface VaultStatus {
  configured: boolean;
  /** Number of usable master keys (current + previous during a rotation). */
  keys: number;
  /** One sentence an operator can act on. Never "not configured" alone. */
  detail: string;
}

/**
 * Turn an environment value into a 32-byte key.
 *
 * Accepts base64, hex or a passphrase. A passphrase is hashed to 32 bytes rather than refused —
 * refusing it would mean an operator with a working deployment and a passphrase-shaped variable
 * gets a vault that silently stores nothing.
 */
function toKey(raw: string | undefined): Buffer | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  const b64 = /^[A-Za-z0-9+/=]+$/.test(v) ? Buffer.from(v, 'base64') : null;
  if (b64 && b64.length === 32) return b64;
  return createHash('sha256').update(v, 'utf8').digest();
}

function currentKey(): { id: string; key: Buffer } | null {
  const k = toKey(process.env[KEY_ENV]);
  return k ? { id: 'env:v1', key: k } : null;
}

function allKeys(): { id: string; key: Buffer }[] {
  const out: { id: string; key: Buffer }[] = [];
  const cur = currentKey();
  if (cur) out.push(cur);
  const prev = toKey(process.env[PREVIOUS_KEY_ENV]);
  if (prev) out.push({ id: 'env:v0', key: prev });
  return out;
}

export function vaultStatus(): VaultStatus {
  const keys = allKeys();
  if (!keys.length) {
    return {
      configured: false,
      keys: 0,
      detail:
        'No vault key is set on this deployment, so no integration credential can be stored or read. Set ' +
        KEY_ENV +
        ' to 32 random bytes (hex or base64) in the hosting environment. Existing integrations keep working only if they need no stored secret.',
    };
  }
  return {
    configured: true,
    keys: keys.length,
    detail: keys.length > 1
      ? 'Two vault keys are configured: new credentials use the current key, and records written with the previous one still decrypt. Remove ' + PREVIOUS_KEY_ENV + ' once every credential has been rotated.'
      : 'Credentials are encrypted with AES-256-GCM using the key in ' + KEY_ENV + '.',
  };
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  hint: string;
  fingerprint: string;
}

export function encryptSecret(plaintext: string): { ok: true; data: EncryptedSecret } | { ok: false; error: string } {
  const k = currentKey();
  if (!k) return { ok: false, error: vaultStatus().detail };
  const value = String(plaintext ?? '');
  if (!value) return { ok: false, error: 'An empty value is not a credential.' };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k.key, iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ok: true,
    data: {
      ciphertext: enc.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyId: k.id,
      hint: value.length <= 4 ? '****' : '****' + value.slice(-4),
      // A digest of the secret, so "is this the same key you gave the partner?" is answerable
      // without storing or displaying the secret. Truncated: it is an identity check, not a proof.
      fingerprint: createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16),
    },
  };
}

export function decryptSecret(row: { ciphertext: string; iv: string; tag: string; key_id?: string; keyId?: string }): string | null {
  const keys = allKeys();
  if (!keys.length) return null;
  const wanted = String((row as any).key_id || (row as any).keyId || '');
  // Try the key the row names first, then the others — a row written before a rotation must still
  // open, and a row whose key_id is wrong (a hand-edited restore) should still be recoverable.
  const ordered = [...keys].sort((a, b) => (a.id === wanted ? -1 : b.id === wanted ? 1 : 0));
  for (const k of ordered) {
    try {
      const decipher = createDecipheriv(ALGORITHM, k.key, Buffer.from(row.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      const out = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]);
      return out.toString('utf8');
    } catch {
      // Wrong key: the auth tag fails and we try the next. This is the ONLY place a decryption
      // failure is swallowed, and it is swallowed per key, not per record — a record that opens
      // with no key returns null and the caller reports it.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

export interface CredentialSummary {
  id: string;
  integrationId: string | null;
  kind: CredentialKind;
  label: string | null;
  /** `****abcd`. The only part of a secret that ever reaches a response. */
  hint: string | null;
  fingerprint: string | null;
  state: CredentialState;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  rotatedFrom: string | null;
}

function toSummary(r: any, now = Date.now()): CredentialSummary {
  return {
    id: String(r.id),
    integrationId: r.integration_id ? String(r.integration_id) : null,
    kind: String(r.kind) as CredentialKind,
    label: r.label ?? null,
    hint: r.hint ?? null,
    fingerprint: r.fingerprint ?? null,
    state: credentialState({ expiresAt: r.expires_at, revokedAt: r.revoked_at }, now),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    rotatedFrom: r.rotated_from ? String(r.rotated_from) : null,
  };
}

export interface StoreCredentialInput {
  orgId: string;
  integrationId: string | null;
  kind: CredentialKind;
  secret: string;
  label?: string | null;
  expiresAt?: string | null;
  scopes?: string[];
  createdBy?: string | null;
  /** Set when this replaces an existing credential; recorded for the audit trail. */
  rotatedFrom?: string | null;
}

export async function storeCredential(
  input: StoreCredentialInput,
): Promise<{ ok: boolean; credential?: CredentialSummary; error?: string }> {
  const enc = encryptSecret(input.secret);
  if (!enc.ok) return { ok: false, error: enc.error };
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      INSERT INTO mailint_credentials
        (org_id, integration_id, kind, label, ciphertext, iv, tag, key_id, hint, fingerprint, scopes, expires_at, rotated_from, created_by)
      VALUES (
        ${input.orgId}::uuid,
        ${input.integrationId || null}::uuid,
        ${input.kind},
        ${input.label || null},
        ${enc.data.ciphertext},
        ${enc.data.iv},
        ${enc.data.tag},
        ${enc.data.keyId},
        ${enc.data.hint},
        ${enc.data.fingerprint},
        ${JSON.stringify(input.scopes || [])}::jsonb,
        ${input.expiresAt || null}::timestamptz,
        ${input.rotatedFrom || null}::uuid,
        ${input.createdBy || null}::uuid
      )
      RETURNING *
    `);
    const row = rows(r)[0];
    if (!row) return { ok: false, error: 'The credential was not written.' };
    return { ok: true, credential: toSummary(row) };
  } catch (e: any) {
    console.error('[mailint/credentials] store failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Read a usable secret. SERVER ONLY — no API route returns what this produces.
 *
 * For a webhook secret it returns the current secret AND the previous one joined by a newline,
 * which is the shape ExternalWebhookConnector.authenticate() verifies against. That is what makes a
 * rotation a window rather than a cutover: for the overlap period both signatures verify.
 */
export async function readSecret(
  integrationId: string,
  kind: CredentialKind,
  opts: { orgId?: string; now?: number } = {},
): Promise<string | null> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_credentials
      WHERE integration_id = ${integrationId}::uuid
        AND kind = ${kind}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        ${opts.orgId ? sql`AND org_id = ${opts.orgId}::uuid` : sql``}
      ORDER BY created_at DESC
      LIMIT 2
    `);
    const list = rows(r);
    if (!list.length) return null;
    const values = list.map((row) => decryptSecret(row)).filter((v): v is string => !!v);
    if (!values.length) {
      console.error('[mailint/credentials] a stored credential could not be decrypted with any configured vault key — integration', integrationId, kind);
      return null;
    }
    // Fire-and-forget usage stamp. A failure here must not fail the read: the caller is mid-request
    // with a working credential in hand.
    db.execute(sql`UPDATE mailint_credentials SET last_used_at = now() WHERE id = ${String(list[0].id)}::uuid`)
      .catch((e: any) => console.error('[mailint/credentials] last_used_at not stamped:', dbReason(e)));
    return kind === 'webhook_secret' ? values.join('\n') : values[0];
  } catch (e: any) {
    console.error('[mailint/credentials] read failed:', dbReason(e));
    return null;
  }
}

export async function listCredentials(orgId: string, integrationId?: string | null): Promise<CredentialSummary[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_credentials
      WHERE org_id = ${orgId}::uuid
      ${integrationId ? sql`AND integration_id = ${integrationId}::uuid` : sql``}
      ORDER BY created_at DESC
      LIMIT 200
    `);
    const now = Date.now();
    return rows(r).map((row) => toSummary(row, now));
  } catch (e: any) {
    console.error('[mailint/credentials] list failed:', dbReason(e));
    return [];
  }
}

/**
 * Replace a credential, keeping the old one usable for an overlap window.
 *
 * The old row is not deleted and not revoked immediately: it is given an expiry `overlapHours` in
 * the future. readSecret() returns both during that window (webhook secrets) or the newest
 * (everything else), so nothing on the other side has to switch at the same instant we do.
 */
export async function rotateCredential(opts: {
  orgId: string;
  credentialId: string;
  newSecret: string;
  overlapHours?: number;
  actorUserId?: string | null;
}): Promise<{ ok: boolean; credential?: CredentialSummary; error?: string }> {
  await ensureMailIntSchema();
  try {
    const existing = rows(await db.execute(sql`
      SELECT * FROM mailint_credentials WHERE id = ${opts.credentialId}::uuid AND org_id = ${opts.orgId}::uuid LIMIT 1
    `))[0];
    // Cross-tenant references answer "not found", never "forbidden" — see policy.sameTenant.
    if (!existing) return { ok: false, error: 'No such credential.' };

    const stored = await storeCredential({
      orgId: opts.orgId,
      integrationId: existing.integration_id ? String(existing.integration_id) : null,
      kind: String(existing.kind) as CredentialKind,
      secret: opts.newSecret,
      label: existing.label,
      expiresAt: existing.expires_at ? new Date(existing.expires_at).toISOString() : null,
      createdBy: opts.actorUserId || null,
      rotatedFrom: String(existing.id),
    });
    if (!stored.ok) return stored;

    const overlap = Math.max(0, Math.min(168, opts.overlapHours ?? 24));
    await db.execute(sql`
      UPDATE mailint_credentials
      SET expires_at = now() + make_interval(hours => ${overlap}::int)
      WHERE id = ${String(existing.id)}::uuid
    `);
    return stored;
  } catch (e: any) {
    console.error('[mailint/credentials] rotate failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function revokeCredential(orgId: string, credentialId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      UPDATE mailint_credentials
      SET revoked_at = now(), revoked_reason = ${String(reason || 'revoked in the console').slice(0, 300)}
      WHERE id = ${credentialId}::uuid AND org_id = ${orgId}::uuid AND revoked_at IS NULL
      RETURNING id
    `);
    if (!rows(r).length) return { ok: false, error: 'No such credential, or it was already revoked.' };
    return { ok: true };
  } catch (e: any) {
    console.error('[mailint/credentials] revoke failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/** Credentials about to become a problem, across every integration. Read by the console banner. */
export async function expiringCredentials(orgId: string, withinDays = 14): Promise<CredentialSummary[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_credentials
      WHERE org_id = ${orgId}::uuid
        AND revoked_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at < now() + make_interval(days => ${Math.max(1, Math.floor(withinDays))}::int)
      ORDER BY expires_at ASC
      LIMIT 50
    `);
    const now = Date.now();
    return rows(r).map((row) => toSummary(row, now));
  } catch (e: any) {
    console.error('[mailint/credentials] expiring read failed:', dbReason(e));
    return [];
  }
}
