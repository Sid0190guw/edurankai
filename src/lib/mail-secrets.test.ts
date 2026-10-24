import { afterEach, describe, expect, it } from 'vitest';
import { decodeMailSecret, encodeMailSecret } from './mail-secrets';

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
});
