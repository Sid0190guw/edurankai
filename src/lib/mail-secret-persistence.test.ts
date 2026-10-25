import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { decodeMailSecret, encodeMailSecret, MailSecretReplacementRequiredError } from './mail-secrets';
import { CiphertextAuthenticationError } from './crypto/errors';

const state = vi.hoisted(() => ({ execute: vi.fn() }));
const smtp = vi.hoisted(() => ({ createTransport: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: { execute: (query: any) => state.execute(query) } }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.createTransport } }));

import { clearSmtpSettings, ensureMailSchema, getMailConfig, saveMailConfig } from './mail';
import { saveImapConfig } from './mail-imap';
import { replaceUnreadableMailSecret } from './mail-secret-recovery';
import { sendExternal } from './mail-transport';

const dialect = new PgDialect();
const originalActive = process.env.ACTIVE_DATA_KEY_ID;
const originalKeys = new Map<string, string | undefined>();
const originalSmtpPass = process.env.SMTP_PASS;

for (const name of ['DATA_ENCRYPTION_KEY_k1', 'DATA_ENCRYPTION_KEY_k2', 'DATA_ENCRYPTION_KEY_save_test']) {
  originalKeys.set(name, process.env[name]);
}

function queryInfo(query: any) {
  return dialect.sqlToQuery(query);
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  state.execute.mockResolvedValue([]);
  await ensureMailSchema();
});

beforeEach(() => {
  state.execute.mockReset();
  state.execute.mockResolvedValue([]);
});

afterEach(() => {
  restoreEnv('ACTIVE_DATA_KEY_ID', originalActive);
  for (const [name, value] of originalKeys) restoreEnv(name, value);
  restoreEnv('SMTP_PASS', originalSmtpPass);
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreEnv('ACTIVE_DATA_KEY_ID', originalActive);
  for (const [name, value] of originalKeys) restoreEnv(name, value);
  restoreEnv('SMTP_PASS', originalSmtpPass);
});

describe('mail secret persistence fail-closed behavior', () => {
  it('does not issue a mail_config write when SMTP encryption lacks its active key', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'save_test';
    delete process.env.DATA_ENCRYPTION_KEY_save_test;
    await expect(saveMailConfig({ smtpHost: 'smtp.example.test', smtpPass: 'synthetic-password' }))
      .rejects.toMatchObject({ code: 'missing_key_material' });
    const sqlTexts = state.execute.mock.calls.map(([query]) => queryInfo(query).sql);
    expect(sqlTexts.some((text) => /INSERT INTO mail_config|UPDATE mail_config SET/i.test(text))).toBe(false);
  });

  it('does not issue an IMAP write when IMAP encryption lacks its active key', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'save_test';
    delete process.env.DATA_ENCRYPTION_KEY_save_test;
    await expect(saveImapConfig({ host: 'imap.example.test', pass: 'synthetic-password' }))
      .rejects.toMatchObject({ code: 'missing_key_material' });
    const sqlTexts = state.execute.mock.calls.map(([query]) => queryInfo(query).sql);
    expect(sqlTexts.some((text) => /INSERT INTO mail_config|UPDATE mail_config SET/i.test(text))).toBe(false);
  });

  it('blocks routine replacement if the existing secret cannot be decrypted', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-old-value', 'smtp_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    process.env.ACTIVE_DATA_KEY_ID = 'k2';
    process.env.DATA_ENCRYPTION_KEY_k2 = Buffer.alloc(32, 2).toString('base64');
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT smtp_pass, resend_api_key, inbound_secret FROM mail_config/i.test(text)) {
        return [{ smtp_pass: existing, resend_api_key: null, inbound_secret: null }];
      }
      return [];
    });

    await expect(saveMailConfig({ smtpPass: 'synthetic-new-value' })).rejects.toBeInstanceOf(MailSecretReplacementRequiredError);
    const sqlTexts = state.execute.mock.calls.map(([query]) => queryInfo(query).sql);
    expect(sqlTexts.some((text) => /INSERT INTO mail_config|UPDATE mail_config SET/i.test(text))).toBe(false);
  });

  it('aborts an SMTP secret save if the stored value changes after the preflight read', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-existing-smtp', 'smtp_pass')!;
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT smtp_pass, resend_api_key, inbound_secret FROM mail_config/i.test(text)) {
        return [{ smtp_pass: existing, resend_api_key: null, inbound_secret: null }];
      }
      if (/INSERT INTO mail_config/i.test(text)) return [];
      return [];
    });

    await expect(saveMailConfig({ smtpPass: 'synthetic-replacement' }))
      .rejects.toThrow(/changed during this save/);
    const write = state.execute.mock.calls.map(([query]) => queryInfo(query)).find((query) => /INSERT INTO mail_config/i.test(query.sql));
    expect(write?.sql).toContain('WHERE mail_config.smtp_pass IS NOT DISTINCT FROM');
    expect(write?.params).toContain(existing);
  });

  it('aborts an IMAP secret save if the stored value changes after the preflight read', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-existing-imap', 'imap_pass')!;
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT imap_pass FROM mail_config/i.test(text)) return [{ imap_pass: existing }];
      if (/INSERT INTO mail_config/i.test(text)) return [];
      return [];
    });

    await expect(saveImapConfig({ pass: 'synthetic-replacement' }))
      .rejects.toThrow(/changed during this save/);
    const write = state.execute.mock.calls.map(([query]) => queryInfo(query)).find((query) => /INSERT INTO mail_config/i.test(query.sql));
    expect(write?.sql).toContain('WHERE mail_config.imap_pass IS NOT DISTINCT FROM');
    expect(write?.params).toContain(existing);
  });

  it('refuses recovery unless the original key loss is explicitly confirmed', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k2';
    process.env.DATA_ENCRYPTION_KEY_k2 = Buffer.alloc(32, 2).toString('base64');
    await expect(replaceUnreadableMailSecret('smtp_pass', 'synthetic-new-value', false))
      .rejects.toThrow(/Explicit confirmation/);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('rejects non-text replacement input before any database operation', async () => {
    await expect(replaceUnreadableMailSecret('smtp_pass', { name: 'untrusted-file' }, true))
      .rejects.toThrow(/as text/);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('replaces only the confirmed unreadable column using compare-and-swap', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-old-value', 'imap_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    process.env.ACTIVE_DATA_KEY_ID = 'k2';
    process.env.DATA_ENCRYPTION_KEY_k2 = Buffer.alloc(32, 2).toString('base64');
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT imap_pass AS stored FROM mail_config/i.test(text)) return [{ stored: existing }];
      if (/UPDATE mail_config SET imap_pass = .*RETURNING id/i.test(text)) return [{ id: 1 }];
      return [];
    });

    await expect(replaceUnreadableMailSecret('imap_pass', 'synthetic-new-value', true)).resolves.toBeUndefined();
    const writes = state.execute.mock.calls.map(([query]) => queryInfo(query)).filter((query) => /UPDATE mail_config/i.test(query.sql));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('SET imap_pass =');
    expect(writes[0].sql).not.toContain('smtp_pass =');
    expect(writes[0].sql).toContain('AND imap_pass =');
    expect(writes[0].params.some((value: unknown) => typeof value === 'string' && value.includes('synthetic-new-value'))).toBe(false);
  });

  it('does not clear SMTP settings when the stored password is unreadable', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-old-value', 'smtp_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT smtp_pass FROM mail_config/i.test(text)) return [{ smtp_pass: existing }];
      return [];
    });

    const { clearSmtpSettings } = await import('./mail');
    await expect(clearSmtpSettings()).rejects.toBeInstanceOf(MailSecretReplacementRequiredError);
    const sqlTexts = state.execute.mock.calls.map(([query]) => queryInfo(query).sql);
    expect(sqlTexts.some((text) => /UPDATE mail_config SET smtp_host = NULL/i.test(text))).toBe(false);
  });

  it('aborts an SMTP clear if the saved password changes after the preflight read', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-clear-race', 'smtp_pass')!;
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT smtp_pass FROM mail_config/i.test(text)) return [{ smtp_pass: existing }];
      if (/UPDATE mail_config SET smtp_host = NULL/i.test(text)) return [];
      return [];
    });

    await expect(clearSmtpSettings()).rejects.toThrow(/changed while settings were being cleared/);
    const update = state.execute.mock.calls.map(([query]) => queryInfo(query)).find((query) => /UPDATE mail_config SET smtp_host = NULL/i.test(query.sql));
    expect(update?.sql).toContain('AND smtp_pass IS NOT DISTINCT FROM');
    expect(update?.params).toContain(existing);
  });

  it('keeps a database-backed unreadable SMTP secret from falling back to SMTP_PASS', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-old-value', 'smtp_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    process.env.SMTP_PASS = 'synthetic-env-fallback';
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT \* FROM mail_config WHERE id = 1/i.test(text)) {
        return [{ smtp_host: 'smtp.example.test', smtp_user: 'user@example.test', smtp_pass: existing }];
      }
      return [];
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = await getMailConfig();
    expect(config.smtpPass).toBe('');
    expect(config.secretErrors.smtp_pass).toContain('DATA_ENCRYPTION_KEY_k1');
    expect(config.secretErrors.smtp_pass).not.toContain('synthetic');
    expect(config.secretErrorCodes.smtp_pass).toBe('missing_key_material');
  });

  it('refuses SMTP sends when a saved password cannot be decrypted', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-old-value', 'smtp_pass')!;
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    state.execute.mockImplementation(async (query: any) => {
      const text = queryInfo(query).sql;
      if (/SELECT \* FROM mail_config WHERE id = 1/i.test(text)) {
        return [{ smtp_host: 'smtp.example.test', smtp_user: 'user@example.test', smtp_pass: existing }];
      }
      return [];
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendExternal({ from: 'sender@example.test', to: 'recipient@example.test', subject: 'synthetic', html: '<p>test</p>' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('DATA_ENCRYPTION_KEY_k1');
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it('uses a distinct authentication error for a readable-format secret with the wrong key', () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k1';
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
    const existing = encodeMailSecret('synthetic-old-value', 'smtp_pass')!;
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 2).toString('base64');
    expect(() => decodeMailSecret(existing, 'smtp_pass')).toThrow(CiphertextAuthenticationError);
  });
});
