import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { encodeMailSecret } from './mail-secrets';

const state = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), rollback: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    execute: (query: any) => state.execute(query),
    transaction: (callback: (tx: any) => Promise<unknown>) => state.transaction(callback),
  },
}));

import { migrateLegacyMailSecrets } from './mail-secret-migration';

const dialect = new PgDialect();
const envBefore = new Map<string, string | undefined>();
for (const name of ['ACTIVE_DATA_KEY_ID', 'DATA_ENCRYPTION_KEY_k1', 'DATA_ENCRYPTION_KEY_k2']) {
  envBefore.set(name, process.env[name]);
}
const approval = { keyIdInventoryReviewed: true, smtpAndImapVerified: true, explicitlyAuthorized: true } as const;

function queryInfo(query: any) { return dialect.sqlToQuery(query); }
function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

beforeEach(() => {
  state.execute.mockReset();
  state.transaction.mockReset();
  state.rollback.mockReset();
  state.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
    try {
      return await callback({ execute: (query: any) => state.execute(query) });
    } catch (error) {
      state.rollback();
      throw error;
    }
  });
  process.env.ACTIVE_DATA_KEY_ID = 'k1';
  process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 11).toString('base64');
  delete process.env.DATA_ENCRYPTION_KEY_k2;
});

afterEach(() => {
  for (const [name, value] of envBefore) setEnv(name, value);
  vi.restoreAllMocks();
});

describe('transactional legacy mail-secret migration', () => {
  it('requires inventory, connectivity, and explicit authorization before key or database access', async () => {
    await expect(migrateLegacyMailSecrets(['smtp_pass'], { ...approval, keyIdInventoryReviewed: false }))
      .rejects.toMatchObject({ code: 'confirmation_required' });
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('rejects unrecognized field names before database access', async () => {
    await expect(migrateLegacyMailSecrets(['smtp_pass; DROP TABLE mail_config'], approval))
      .rejects.toMatchObject({ code: 'invalid_selection' });
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it('validates the active key before opening the transaction', async () => {
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    await expect(migrateLegacyMailSecrets(['smtp_pass'], approval)).rejects.toMatchObject({ code: 'missing_key_material' });
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it('encrypts only selected plaintext fields, preserves exact contents, and returns redacted outcomes', async () => {
    const secret = '  synthetic smtp password  ';
    state.execute.mockImplementation(async (query: any) => {
      const { sql: text } = queryInfo(query);
      if (/SELECT smtp_pass AS stored/.test(text)) return [{ stored: secret }];
      if (/UPDATE mail_config SET smtp_pass/.test(text)) return [{ id: 1 }];
      throw new Error('unexpected query');
    });

    const result = await migrateLegacyMailSecrets(['smtp_pass'], approval);
    expect(result).toEqual([{ column: 'smtp_pass', result: 'migrated' }]);
    expect(JSON.stringify(result)).not.toContain(secret.trim());
    expect(state.transaction).toHaveBeenCalledTimes(1);
    const calls = state.execute.mock.calls.map(([query]) => queryInfo(query));
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls[1].sql).toContain('WHERE id = 1 AND smtp_pass IS NOT DISTINCT FROM');
    expect(calls[1].sql).not.toContain('imap_pass =');
    const encrypted = calls[1].params.find((value: unknown) => typeof value === 'string' && value.startsWith('era-mail-secret:v1:')) as string;
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain(secret.trim());
  });

  it('leaves empty and already encrypted values untouched', async () => {
    const envelope = encodeMailSecret('synthetic existing inbound value', 'inbound_secret')!;
    state.execute.mockImplementation(async (query: any) => {
      const { sql: text } = queryInfo(query);
      if (/SELECT resend_api_key AS stored/.test(text)) return [{ stored: '' }];
      if (/SELECT inbound_secret AS stored/.test(text)) return [{ stored: envelope }];
      return [];
    });

    const result = await migrateLegacyMailSecrets(['resend_api_key', 'inbound_secret'], approval);
    expect(result).toEqual([
      { column: 'resend_api_key', result: 'empty' },
      { column: 'inbound_secret', result: 'already_encrypted' },
    ]);
    expect(state.execute.mock.calls.map(([query]) => queryInfo(query).sql).some((text) => /UPDATE mail_config/i.test(text))).toBe(false);
  });

  it('rolls the whole transaction back when a selected historical envelope is unreadable', async () => {
    process.env.ACTIVE_DATA_KEY_ID = 'k2';
    process.env.DATA_ENCRYPTION_KEY_k2 = Buffer.alloc(32, 22).toString('base64');
    const oldKeyEnvelope = (() => {
      process.env.ACTIVE_DATA_KEY_ID = 'k1';
      const value = encodeMailSecret('synthetic old imap value', 'imap_pass')!;
      process.env.ACTIVE_DATA_KEY_ID = 'k2';
      return value;
    })();
    delete process.env.DATA_ENCRYPTION_KEY_k1;
    state.execute.mockImplementation(async (query: any) => {
      const { sql: text } = queryInfo(query);
      if (/SELECT smtp_pass AS stored/.test(text)) return [{ stored: 'synthetic plaintext smtp' }];
      if (/UPDATE mail_config SET smtp_pass/.test(text)) return [{ id: 1 }];
      if (/SELECT imap_pass AS stored/.test(text)) return [{ stored: oldKeyEnvelope }];
      return [];
    });

    await expect(migrateLegacyMailSecrets(['smtp_pass', 'imap_pass'], approval))
      .rejects.toMatchObject({ code: 'missing_key_material' });
    expect(state.rollback).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite malformed or wrong-key envelopes during a plaintext migration', async () => {
    const malformed = 'era-mail-secret:v1:{not-an-envelope';
    state.execute.mockImplementation(async (query: any) => {
      const { sql: text } = queryInfo(query);
      if (/SELECT smtp_pass AS stored/.test(text)) return [{ stored: malformed }];
      return [];
    });
    await expect(migrateLegacyMailSecrets(['smtp_pass'], approval))
      .rejects.toMatchObject({ code: 'malformed_ciphertext' });
    expect(state.execute.mock.calls.map(([query]) => queryInfo(query).sql).some((text) => /UPDATE mail_config/i.test(text))).toBe(false);
    expect(state.rollback).toHaveBeenCalledTimes(1);

    state.execute.mockReset();
    state.transaction.mockClear();
    state.rollback.mockClear();
    const envelope = encodeMailSecret('synthetic smtp envelope value', 'smtp_pass')!;
    process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 12).toString('base64');
    state.execute.mockImplementation(async (query: any) => {
      if (/SELECT smtp_pass AS stored/.test(queryInfo(query).sql)) return [{ stored: envelope }];
      return [];
    });
    await expect(migrateLegacyMailSecrets(['smtp_pass'], approval))
      .rejects.toMatchObject({ code: 'ciphertext_authentication_failed' });
    expect(state.execute.mock.calls.map(([query]) => queryInfo(query).sql).some((text) => /UPDATE mail_config/i.test(text))).toBe(false);
    expect(state.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back when compare-and-swap detects a concurrent update', async () => {
    state.execute.mockImplementation(async (query: any) => {
      const { sql: text } = queryInfo(query);
      if (/SELECT smtp_pass AS stored/.test(text)) return [{ stored: 'synthetic smtp value' }];
      if (/UPDATE mail_config SET smtp_pass/.test(text)) return [];
      return [];
    });
    await expect(migrateLegacyMailSecrets(['smtp_pass'], approval))
      .rejects.toMatchObject({ code: 'compare_and_swap_failed' });
    expect(state.rollback).toHaveBeenCalledTimes(1);
  });
});
