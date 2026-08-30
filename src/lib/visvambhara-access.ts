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

/**
 * The read, WITH the one bit of information `getUserAccess` throws away.
 *
 * `getUserAccess` returns null both when a user has no request on file and when the database could
 * not be asked, and every caller then rendered the first meaning. So a pooler hiccup told an
 * applicant who had already applied — possibly already been APPROVED — "these modules are
 * restricted, submit a note and a CV to request access". That is the failure mode this project
 * calls a swallowed read rendered as a confident false claim, and wrapping the call site in
 * try/catch does not fix it: this function never throws, so the catch never runs.
 *
 * `readable: false` means "we could not look". It is NOT permission — see hasApprovedAccess, which
 * still resolves an unreadable record to false and must keep doing so.
 */
export async function getUserAccessResult(userId: string): Promise<{ record: AccessRecord | null; readable: boolean }> {
  if (!userId) return { record: null, readable: true };
  await ensureVisvambharaAccessSchema();
  try {
    const r = rows(await db.execute(sql`
      SELECT id, status, note, cv_url, reject_reason, created_at
      FROM visvambhara_access_requests
      WHERE user_id = ${userId} LIMIT 1
    `));
    return { record: r[0] || null, readable: true };
  } catch (e: any) {
    console.error('[visvambhara-access] access read failed:', e?.cause?.message || e?.message);
    return { record: null, readable: false };
  }
}

/** Unchanged behaviour, kept for callers that genuinely cannot act on the difference. */
export async function getUserAccess(userId: string): Promise<AccessRecord | null> {
  if (!userId) return null;
  return (await getUserAccessResult(userId)).record;
}

/**
 * FAIL CLOSED, DELIBERATELY. An unreadable record resolves to false: a database that cannot answer
 * is not an approval. This is the one place where collapsing "no record" and "could not look" into
 * a single answer is correct, because both must deny. Surfaces that TELL the user something about
 * their status must use getUserAccessResult instead.
 */
export async function hasApprovedAccess(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const r = await getUserAccessResult(userId);
  return r.readable && !!r.record && r.record.status === 'approved';
}

// Count words ignoring whitespace runs. We enforce <=300 words.
export function wordCount(s: string): number {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}
