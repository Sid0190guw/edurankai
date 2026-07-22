// src/lib/crypto/envelope.ts — Block 11: AES-256-GCM envelope encryption on node:crypto.
// Every ciphertext carries keyId+alg, so rotation is non-destructive (decrypt selects by keyId)
// and the format is crypto-agile. GCM's auth tag makes tamper/wrong-key detection automatic:
// decipher.final() throws on mismatch. Node runtime only — never edge middleware.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { activeKeyId, getKeyMaterial } from './keys';
import { EnvelopeCiphertextSchema, type EnvelopeCiphertext } from './schema';

export function encryptField(plaintext: string, aad?: string): EnvelopeCiphertext {
  const keyId = activeKeyId();
  const key = getKeyMaterial(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, keyId, alg: 'A256GCM', iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64'), ...(aad ? { aad } : {}) };
}

export function decryptField(env: EnvelopeCiphertext): string {
  EnvelopeCiphertextSchema.parse(env);   // reject malformed structure
  const key = getKeyMaterial(env.keyId); // selected by keyId — resolvable during/after rotation
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  if (env.aad) decipher.setAAD(Buffer.from(env.aad, 'utf8'));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Encrypt a blob: the ciphertext travels in `body` (store as a sidecar); the header (iv/tag/keyId)
 *  is small and stored alongside. */
export function encryptBlob(data: Uint8Array, aad?: string): { header: EnvelopeCiphertext; body: Uint8Array } {
  const keyId = activeKeyId();
  const key = getKeyMaterial(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { header: { v: 1, keyId, alg: 'A256GCM', iv: iv.toString('base64'), ct: '', tag: tag.toString('base64'), ...(aad ? { aad } : {}) }, body };
}

export function decryptBlob(header: EnvelopeCiphertext, body: Uint8Array): Uint8Array {
  EnvelopeCiphertextSchema.parse(header);
  const key = getKeyMaterial(header.keyId);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
  if (header.aad) decipher.setAAD(Buffer.from(header.aad, 'utf8'));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()]));
}
