// Progress sharing — a learner mints a read-only token so a parent or teacher
// can view their verified progress without needing an account or a fragile
// account-linking flow. Self-bootstrapping schema, no LLM. Tokens are
// unguessable; a learner can revoke any time.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
export function ensureShareSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_progress_share (
        token TEXT PRIMARY KEY,
        user_id UUID NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_progress_share_user_idx ON aq_progress_share (user_id, created_at DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

function newToken(): string {
  try { return (globalThis.crypto?.randomUUID?.() || '').replace(/-/g, '') || Math.random().toString(36).slice(2) + Date.now().toString(36); }
  catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

export async function createShare(userId: string, label: string): Promise<string> {
  await ensureShareSchema();
  const token = newToken();
  await db.execute(sql`INSERT INTO aq_progress_share (token, user_id, label) VALUES (${token}, ${userId}, ${(label || '').slice(0, 80)})`);
  return token;
}

export async function listShares(userId: string): Promise<{ token: string; label: string; createdAt: string }[]> {
  await ensureShareSchema();
  return rows(await db.execute(sql`SELECT token, label, created_at FROM aq_progress_share WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY created_at DESC`))
    .map((r: any) => ({ token: r.token, label: r.label || '', createdAt: r.created_at }));
}

export async function revokeShare(userId: string, token: string): Promise<void> {
  await ensureShareSchema();
  await db.execute(sql`UPDATE aq_progress_share SET revoked_at = NOW() WHERE token = ${token} AND user_id = ${userId} AND revoked_at IS NULL`);
}

// Resolve a share token to its owner (user id + display name), or null if the
// token is unknown or revoked.
export async function resolveShare(token: string): Promise<{ userId: string; name: string } | null> {
  await ensureShareSchema();
  const r = rows(await db.execute(sql`SELECT user_id FROM aq_progress_share WHERE token = ${token} AND revoked_at IS NULL LIMIT 1`))[0];
  if (!r) return null;
  let name = '';
  try { name = (rows(await db.execute(sql`SELECT name FROM users WHERE id = ${r.user_id} LIMIT 1`))[0] || {}).name || ''; } catch (_) {}
  return { userId: r.user_id, name };
}
