// Tiny admin-editable key/value settings store. Self-bootstrapping so new
// settings ship without a migration. Used for things like the wallet refund
// deduction %, base currency, etc.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

function ensure(): Promise<void> {
  return ensureOnce('platform_settings', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS platform_settings (
      key VARCHAR(80) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  });
}

export async function getSetting(key: string, def = ''): Promise<string> {
  await ensure();
  try {
    const r = rows(await db.execute(sql`SELECT value FROM platform_settings WHERE key = ${key} LIMIT 1`));
    const v = r[0]?.value;
    return v === undefined || v === null ? def : String(v);
  } catch (_) { return def; }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await ensure();
  await db.execute(sql`
    INSERT INTO platform_settings (key, value, updated_at) VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `).catch(() => {});
}

export async function getNumberSetting(key: string, def: number): Promise<number> {
  const v = await getSetting(key, '');
  if (v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export async function listSettings(): Promise<Record<string, string>> {
  await ensure();
  const out: Record<string, string> = {};
  try { for (const r of rows(await db.execute(sql`SELECT key, value FROM platform_settings`))) out[r.key] = r.value; } catch (_) {}
  return out;
}

// --- Convenience accessors with sensible defaults ---
// Refund deduction percentage applied when refunding wallet credit (admin-set).
export async function getRefundDeductionPct(): Promise<number> {
  const n = await getNumberSetting('refund_deduction_pct', 15);
  return Math.min(100, Math.max(0, n));
}
