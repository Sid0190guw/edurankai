// src/lib/crypto/keys.ts — Block 11: the key registry. Raw key material comes from env vars
// (DATA_ENCRYPTION_KEY_<keyId>, base64 32 bytes); only lifecycle metadata lives in Postgres.
import { CRYPTO_DDL, type CryptoKey } from './schema';

/** Resolve raw 32-byte key material for a keyId. Throws if unset or wrong length. */
export function getKeyMaterial(keyId: string): Buffer {
  const raw = process.env[`DATA_ENCRYPTION_KEY_${keyId}`];
  if (!raw) throw new Error(`missing key material for keyId '${keyId}' (set DATA_ENCRYPTION_KEY_${keyId})`);
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`key '${keyId}' must be 32 bytes base64 (got ${buf.length})`);
  return buf;
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
