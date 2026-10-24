import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, dbConfigured, sqlClient } from './db';
import { dbPing } from './observability-health';

describe('database fallback when unconfigured', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('returns an offline DB client instead of throwing', async () => {
    expect(dbConfigured()).toBe(false);
    await expect(db.execute('SELECT 1')).resolves.toEqual([]);
    const sql = sqlClient();
    await expect(sql`SELECT 1`).resolves.toEqual([]);
  });

  it('reports the health check as down without a configured database', async () => {
    const ping = await dbPing();
    expect(ping.ok).toBe(false);
    expect(ping.error).toContain('DATABASE_URL is not set');
  });
});
