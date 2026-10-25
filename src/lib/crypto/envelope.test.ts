import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { CiphertextAuthenticationError, MalformedCiphertextError } from './errors';
import { decryptBlob, decryptField, encryptBlob, encryptField } from './envelope';

const activeBefore = process.env.ACTIVE_DATA_KEY_ID;
const k1Before = process.env.DATA_ENCRYPTION_KEY_k1;
const k2Before = process.env.DATA_ENCRYPTION_KEY_k2;

function key(byte: number): Buffer { return Buffer.alloc(32, byte); }

afterEach(() => {
  if (activeBefore === undefined) delete process.env.ACTIVE_DATA_KEY_ID;
  else process.env.ACTIVE_DATA_KEY_ID = activeBefore;
  if (k1Before === undefined) delete process.env.DATA_ENCRYPTION_KEY_k1;
  else process.env.DATA_ENCRYPTION_KEY_k1 = k1Before;
  if (k2Before === undefined) delete process.env.DATA_ENCRYPTION_KEY_k2;
  else process.env.DATA_ENCRYPTION_KEY_k2 = k2Before;
});

describe('AES-256-GCM envelope compatibility and failures', () => {
  it('round-trips a version 1 envelope and preserves the recorded key ID', () => {
    process.env.DATA_ENCRYPTION_KEY_k1 = key(1).toString('base64');
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    const envelope = encryptField('synthetic-test-value', 'mail_config.smtp_pass.v1');
    expect(envelope).toMatchObject({ v: 1, keyId: 'k1', alg: 'A256GCM' });
    expect(decryptField(envelope)).toBe('synthetic-test-value');
  });

  it('decrypts existing v1 records by their embedded key ID after the active ID changes', () => {
    process.env.DATA_ENCRYPTION_KEY_k1 = key(1).toString('base64');
    process.env.DATA_ENCRYPTION_KEY_k2 = key(2).toString('base64');
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    const oldEnvelope = encryptField('older-v1-record');
    process.env.ACTIVE_DATA_KEY_ID = 'k2';
    expect(encryptField('new-record').keyId).toBe('k2');
    expect(decryptField(oldEnvelope)).toBe('older-v1-record');
  });

  it('reads a v1 envelope produced by the original AES-256-GCM field format', () => {
    const secretKey = key(7);
    process.env.DATA_ENCRYPTION_KEY_k1 = secretKey.toString('base64');
    const iv = Buffer.alloc(12, 3);
    const aad = 'legacy-field-aad';
    const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update('legacy-v1-value', 'utf8'), cipher.final()]);
    const envelope = {
      v: 1 as const,
      keyId: 'k1',
      alg: 'A256GCM' as const,
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      aad,
    };
    expect(decryptField(envelope)).toBe('legacy-v1-value');
  });

  it('classifies wrong-key authentication failures without exposing plaintext', () => {
    process.env.DATA_ENCRYPTION_KEY_k1 = key(1).toString('base64');
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    const envelope = encryptField('synthetic-wrong-key-fixture');
    process.env.DATA_ENCRYPTION_KEY_k1 = key(2).toString('base64');
    expect(() => decryptField(envelope)).toThrow(CiphertextAuthenticationError);
  });

  it('classifies tampered ciphertext as an authentication failure', () => {
    process.env.DATA_ENCRYPTION_KEY_k1 = key(1).toString('base64');
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    const envelope = encryptField('synthetic-tamper-fixture');
    const ciphertext = Buffer.from(envelope.ct, 'base64');
    ciphertext[0] ^= 1;
    expect(() => decryptField({ ...envelope, ct: ciphertext.toString('base64') })).toThrow(CiphertextAuthenticationError);
  });

  it('classifies malformed envelope Base64 separately from authentication failure', () => {
    process.env.DATA_ENCRYPTION_KEY_k1 = key(1).toString('base64');
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    const envelope = encryptField('synthetic-malformed-fixture');
    expect(() => decryptField({ ...envelope, iv: 'not!base64' })).toThrow(MalformedCiphertextError);
    expect(() => decryptField({ ...envelope, tag: Buffer.alloc(8).toString('base64') })).toThrow(MalformedCiphertextError);
  });

  it('round-trips blob bodies and rejects tampered blobs', () => {
    process.env.DATA_ENCRYPTION_KEY_k1 = key(1).toString('base64');
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const { header, body } = encryptBlob(payload, 'blob:test');
    expect(Buffer.from(decryptBlob(header, body))).toEqual(Buffer.from(payload));
    const changed = Buffer.from(body);
    changed[0] ^= 1;
    expect(() => decryptBlob(header, changed)).toThrow(CiphertextAuthenticationError);
  });
});
