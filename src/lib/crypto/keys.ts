// src/lib/crypto/keys.ts — Block 11: the key registry. Raw key material comes from env vars
// (DATA_ENCRYPTION_KEY_<keyId>, base64 32 bytes); only lifecycle metadata lives in Postgres.
import { CRYPTO_DDL, type CryptoKey } from './schema';
import { CryptoKeyMaterialError } from './errors';

/** Decode canonical standard or URL-safe Base64 while retaining Node's historical whitespace tolerance. */
function decodeKey(raw: string, keyId: string): Buffer {
  const compact = raw.replace(/[\t\n\r ]/g, '');
  const isUrlSafe = /[-_]/.test(compact);
  const alphabet = isUrlSafe ? /^[A-Za-z0-9_-]+={0,2}$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!compact || !alphabet.test(compact)) {
    throw new CryptoKeyMaterialError({
      keyId,
      code: 'invalid_key_base64',
      message: `key '${keyId}' in DATA_ENCRYPTION_KEY_${keyId} must be valid Base64 encoding of a 32-byte key`,
    });
  }

  const unpadded = compact.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) {
    throw new CryptoKeyMaterialError({
      keyId,
      code: 'invalid_key_base64',
      message: `key '${keyId}' in DATA_ENCRYPTION_KEY_${keyId} must be valid Base64 encoding of a 32-byte key`,
    });
  }
  const buf = Buffer.from(unpadded, isUrlSafe ? 'base64url' : 'base64');
  const canonical = buf.toString(isUrlSafe ? 'base64url' : 'base64').replace(/=+$/, '');
  const expectedPadded = isUrlSafe
    ? buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    : buf.toString('base64');
  if (canonical !== unpadded || (compact.includes('=') && compact !== expectedPadded)) {
    throw new CryptoKeyMaterialError({
      keyId,
      code: 'invalid_key_base64',
      message: `key '${keyId}' in DATA_ENCRYPTION_KEY_${keyId} must be valid Base64 encoding of a 32-byte key`,
    });
  }
  if (buf.length !== 32) {
    throw new CryptoKeyMaterialError({
      keyId,
      code: 'invalid_key_length',
      decodedLength: buf.length,
      message: `key '${keyId}' in DATA_ENCRYPTION_KEY_${keyId} must decode to exactly 32 bytes (received ${buf.length})`,
    });
  }
  return buf;
}

/** Resolve raw 32-byte key material for a keyId. Values are never included in errors or status. */
export function getKeyMaterial(keyId: string): Buffer {
  const envVarName = `DATA_ENCRYPTION_KEY_${keyId}`;
  // Keep the runtime-built lookup visible to deployment-readiness's prefix scanner.
  const raw = process.env[`DATA_ENCRYPTION_KEY_${keyId}`];
  if (raw == null || raw.trim() === '') {
    throw new CryptoKeyMaterialError({
      keyId,
      code: 'missing_key_material',
      message: `missing key material for keyId '${keyId}' (set ${envVarName})`,
    });
  }
  return decodeKey(raw, keyId);
}

export interface KeyMaterialStatus {
  keyId: string;
  envVarName: string;
  status: 'valid' | 'missing' | 'invalid_base64' | 'invalid_length';
  message: string;
}

/** Validate an environment key without returning or logging the key value. */
export function inspectKeyMaterial(keyId: string): KeyMaterialStatus {
  const envVarName = `DATA_ENCRYPTION_KEY_${keyId}`;
  try {
    getKeyMaterial(keyId);
    return { keyId, envVarName, status: 'valid', message: `${envVarName} is valid.` };
  } catch (error) {
    if (error instanceof CryptoKeyMaterialError) {
      const status: KeyMaterialStatus['status'] = error.code === 'missing_key_material'
        ? 'missing'
        : error.code === 'invalid_key_length' ? 'invalid_length' : 'invalid_base64';
      return { keyId, envVarName, status, message: error.message };
    }
    return { keyId, envVarName, status: 'invalid_base64', message: `${envVarName} could not be validated.` };
  }
}

/** The keyId new ciphertext is written under. */
export function activeKeyId(): string { return process.env.ACTIVE_DATA_KEY_ID || 'k1'; }

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function ensureCryptoSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  for (const ddl of CRYPTO_DDL) await db.execute(sql.raw(ddl));
  // seed the active key's metadata row (material stays in env)
  await db.execute(sql`INSERT INTO crypto_keys (key_id, purpose, state) VALUES (${activeKeyId()}, 'data-at-rest', 'active') ON CONFLICT (key_id) DO NOTHING`);
  booted = true;
}

export async function listKeyMetadata(): Promise<CryptoKey[]> {
  await ensureCryptoSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM crypto_keys ORDER BY created_at ASC`)) as CryptoKey[];
}

export async function markRotating(oldKeyId: string, newKeyId: string): Promise<void> {
  await ensureCryptoSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO crypto_keys (key_id, purpose, state) VALUES (${newKeyId}, 'data-at-rest', 'active') ON CONFLICT (key_id) DO UPDATE SET state = 'active'`);
  await db.execute(sql`UPDATE crypto_keys SET state = 'rotating' WHERE key_id = ${oldKeyId}`);
}

export async function retireKey(keyId: string): Promise<void> {
  await ensureCryptoSchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE crypto_keys SET state = 'retired', retired_at = NOW() WHERE key_id = ${keyId}`);
}
