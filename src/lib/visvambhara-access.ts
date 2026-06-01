// Gate + data layer for Viśvambhara restricted access.
// The hub page is public; the deep modules (3D viewers, CFD, datasheet, etc.)
// require a signed-in user with an admin-approved access request on file.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let schemaReady: Promise<void> | null = null;

export function ensureVisvambharaAccessSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.execute(sql`
      CREATE TABLE IF NOT EXISTS visvambhara_access_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        cv_url TEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        reject_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `).then(() => {
      return db.execute(sql`CREATE INDEX IF NOT EXISTS visvambhara_access_status_idx ON visvambhara_access_requests(status, created_at DESC)`);
    }).then(() => undefined).catch(() => undefined);
  }
  return schemaReady;
}

function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export interface AccessRecord {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  cv_url: string;
  created_at: string;
  reject_reason: string | null;
}

export async function getUserAccess(userId: string): Promise<AccessRecord | null> {
  if (!userId) return null;
  await ensureVisvambharaAccessSchema();
  try {
    const r = rows(await db.execute(sql`
      SELECT id, status, note, cv_url, reject_reason, created_at
      FROM visvambhara_access_requests
      WHERE user_id = ${userId} LIMIT 1
    `));
    return r[0] || null;
  } catch (_) { return null; }
}

export async function hasApprovedAccess(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const r = await getUserAccess(userId);
  return !!r && r.status === 'approved';
}

// Count words ignoring whitespace runs. We enforce <=300 words.
export function wordCount(s: string): number {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}
