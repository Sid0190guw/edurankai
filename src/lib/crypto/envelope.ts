// src/lib/crypto/envelope.ts — Block 11: AES-256-GCM envelope encryption on node:crypto.
// Every ciphertext carries keyId+alg, so rotation is non-destructive (decrypt selects by keyId)
// and the format is crypto-agile. GCM's auth tag makes tamper/wrong-key detection automatic:
// decipher.final() throws on mismatch. Node runtime only — never edge middleware.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { activeKeyId, getKeyMaterial } from './keys';
import { EnvelopeCiphertextSchema, type EnvelopeCiphertext } from './schema';
import { CiphertextAuthenticationError, MalformedCiphertextError } from './errors';

function parseEnvelope(value: unknown): EnvelopeCiphertext {
  try {
    return EnvelopeCiphertextSchema.parse(value);
  } catch {
    throw new MalformedCiphertextError('Encrypted data envelope has an invalid structure.');
  }
}

function decodeCiphertextPart(value: string, part: 'iv' | 'ct' | 'tag', expectedLength?: number): Buffer {
  const compact = value.replace(/[\t\n\r ]/g, '');
  if (part === 'ct' && compact === '') return Buffer.alloc(0);
  const isUrlSafe = /[-_]/.test(compact);
  const alphabet = isUrlSafe ? /^[A-Za-z0-9_-]+={0,2}$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!compact || !alphabet.test(compact)) {
    throw new MalformedCiphertextError(`Encrypted data ${part} is not valid Base64.`);
  }
  const unpadded = compact.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) throw new MalformedCiphertextError(`Encrypted data ${part} is not valid Base64.`);
  const bytes = Buffer.from(unpadded, isUrlSafe ? 'base64url' : 'base64');
  const canonical = bytes.toString(isUrlSafe ? 'base64url' : 'base64').replace(/=+$/, '');
  const expectedPadded = isUrlSafe
    ? bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    : bytes.toString('base64');
  if (canonical !== unpadded || (compact.includes('=') && compact !== expectedPadded)) {
    throw new MalformedCiphertextError(`Encrypted data ${part} is not valid Base64.`);
  }
  if (expectedLength != null && bytes.length !== expectedLength) {
    throw new MalformedCiphertextError(`Encrypted data ${part} has an invalid length.`);
  }
  return bytes;
}

function decipherField(env: EnvelopeCiphertext, ciphertext: Uint8Array): Buffer {
  const iv = decodeCiphertextPart(env.iv, 'iv', 12);
  const tag = decodeCiphertextPart(env.tag, 'tag', 16);
  const key = getKeyMaterial(env.keyId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (env.aad) decipher.setAAD(Buffer.from(env.aad, 'utf8'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
  } catch {
    // AES-GCM deliberately does not distinguish a wrong key from altered ciphertext/tag.
    throw new CiphertextAuthenticationError(env.keyId);
  }
}

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
  const parsed = parseEnvelope(env);
  const ciphertext = decodeCiphertextPart(parsed.ct, 'ct');
  return decipherField(parsed, ciphertext).toString('utf8');
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
  const parsed = parseEnvelope(header);
  return new Uint8Array(decipherField(parsed, body));
}
