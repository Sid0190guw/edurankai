import { afterEach, describe, expect, it } from 'vitest';
import { decodeMailSecret, encodeMailSecret } from './mail-secrets';
import { CiphertextAuthenticationError, MalformedCiphertextError } from './crypto/errors';
import { assertMailSecretReadableBeforeReplace, assertMailSecretIsUnreadable, MailSecretReplacementRequiredError, MailSecretStillReadableError } from './mail-secrets';

const originalActiveKey = process.env.ACTIVE_DATA_KEY_ID;
const originalTestKey = process.env.DATA_ENCRYPTION_KEY_mail_test;

afterEach(() => {
  if (originalActiveKey === undefined) delete process.env.ACTIVE_DATA_KEY_ID;
  else process.env.ACTIVE_DATA_KEY_ID = originalActiveKey;
  if (originalTestKey === undefined) delete process.env.DATA_ENCRYPTION_KEY_mail_test;
  else process.env.DATA_ENCRYPTION_KEY_mail_test = originalTestKey;
});

describe('mail configuration secret storage', () => {
  it('encrypts a secret and decrypts it only for the same configuration field', () => {
    process.env.ACTIVE_DATA_KEY_ID = 'mail_test';
    process.env.DATA_ENCRYPTION_KEY_mail_test = Buffer.alloc(32, 7).toString('base64');

    const stored = encodeMailSecret('mailbox-password-123', 'smtp_pass');
    expect(stored).not.toContain('mailbox-password-123');
    expect(decodeMailSecret(stored, 'smtp_pass')).toBe('mailbox-password-123');
    expect(() => decodeMailSecret(stored, 'imap_pass')).toThrow();
  });

  it('preserves legacy plaintext credentials for compatibility until rotated', () => {
    expect(decodeMailSecret('legacy-credential', 'smtp_pass')).toBe('legacy-credential');
  });

  it('stores an empty replacement as null so callers can preserve the saved secret', () => {
    expect(encodeMailSecret('  ', 'smtp_pass')).toBeNull();
  });

  it('fails clearly when encryption key material is not configured', () => {
    process.env.ACTIVE_DATA_KEY_ID = 'mail_test';
    delete process.env.DATA_ENCRYPTION_KEY_mail_test;
    expect(() => encodeMailSecret('new-secret', 'smtp_pass')).toThrow(/missing key material/);
  });

  it('distinguishes malformed envelopes from key authentication failures', () => {
    process.env.ACTIVE_DATA_KEY_ID = 'mail_test';
    process.env.DATA_ENCRYPTION_KEY_mail_test = Buffer.alloc(32, 7).toString('base64');
    const stored = encodeMailSecret('synthetic-mail-test', 'smtp_pass')!;
    expect(() => decodeMailSecret('era-mail-secret:v1:{', 'smtp_pass')).toThrow(MalformedCiphertextError);
    process.env.DATA_ENCRYPTION_KEY_mail_test = Buffer.alloc(32, 8).toString('base64');
    expect(() => decodeMailSecret(stored, 'smtp_pass')).toThrow(CiphertextAuthenticationError);
  });

  it('blocks routine replacement of an unreadable saved secret', () => {
    process.env.ACTIVE_DATA_KEY_ID = 'mail_test';
    process.env.DATA_ENCRYPTION_KEY_mail_test = Buffer.alloc(32, 7).toString('base64');
    const stored = encodeMailSecret('synthetic-mail-test', 'smtp_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_mail_test;
    expect(() => assertMailSecretReadableBeforeReplace(stored, 'smtp_pass')).toThrow(MailSecretReplacementRequiredError);
  });

  it('allows recovery only for non-empty ciphertext whose key material is missing', () => {
    expect(() => assertMailSecretIsUnreadable('legacy-credential', 'smtp_pass')).toThrow(MailSecretStillReadableError);
    expect(() => assertMailSecretIsUnreadable('', 'smtp_pass')).toThrow(/No saved/);
    process.env.ACTIVE_DATA_KEY_ID = 'mail_test';
    delete process.env.DATA_ENCRYPTION_KEY_mail_test;
    expect(() => assertMailSecretIsUnreadable('era-mail-secret:v1:{', 'smtp_pass')).toThrow(/malformed/);
    process.env.DATA_ENCRYPTION_KEY_mail_test = Buffer.alloc(32, 7).toString('base64');
    const stored = encodeMailSecret('synthetic-recovery-fixture', 'smtp_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_mail_test;
    expect(() => assertMailSecretIsUnreadable(stored, 'smtp_pass')).not.toThrow();
    process.env.DATA_ENCRYPTION_KEY_mail_test = Buffer.alloc(32, 8).toString('base64');
    expect(() => assertMailSecretIsUnreadable(stored, 'smtp_pass')).toThrow(/wrong key and changed ciphertext/);
  });

  it('preserves a legacy plaintext value when checking whether normal replacement is safe', () => {
    expect(() => assertMailSecretReadableBeforeReplace('legacy-credential', 'smtp_pass')).not.toThrow();
  });
});
