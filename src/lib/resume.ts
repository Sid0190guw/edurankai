// Resume-builder submissions store + admin operations.
//
// The /resume tool is public (no login), so we capture each generated resume —
// attaching the user id when present — for quality and security review. The data
// is fully editable and managed ONLY by a super admin via /admin/resumes.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
export function ensureResumeSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS resume_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        email TEXT,
        full_name TEXT,
        template TEXT,
        data JSONB NOT NULL,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS resume_submissions_created_idx ON resume_submissions(created_at DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export async function saveResume(opts: { userId?: string | null; email?: string | null; fullName?: string | null; template?: string | null; data: any; ip?: string | null }): Promise<void> {
  await ensureResumeSchema();
  await db.execute(sql`
    INSERT INTO resume_submissions (user_id, email, full_name, template, data, ip)
    VALUES (${opts.userId || null}, ${opts.email || null}, ${opts.fullName || null}, ${opts.template || null}, ${JSON.stringify(opts.data || {})}::jsonb, ${opts.ip || null})
  `);
}

export async function listResumes(q = ''): Promise<any[]> {
  try {
    await ensureResumeSchema();
    const like = '%' + q + '%';
    const r = await db.execute(sql`
      SELECT id, user_id, email, full_name, template, created_at,
             COALESCE(data->>'level','') AS level
      FROM resume_submissions
      ${q ? sql`WHERE email ILIKE ${like} OR full_name ILIKE ${like} OR COALESCE(data->>'title','') ILIKE ${like}` : sql``}
      ORDER BY created_at DESC LIMIT 300
    `);
    return rows(r);
  } catch { return []; }
}

export async function getResume(id: string): Promise<any | null> {
  try {
    await ensureResumeSchema();
    return rows(await db.execute(sql`SELECT * FROM resume_submissions WHERE id = ${id} LIMIT 1`))[0] || null;
  } catch { return null; }
}

export async function updateResume(id: string, patch: { fullName?: string; email?: string; template?: string; data?: any }): Promise<void> {
  await ensureResumeSchema();
  await db.execute(sql`
    UPDATE resume_submissions SET
      full_name = ${patch.fullName ?? null},
      email = ${patch.email ?? null},
      template = ${patch.template ?? null},
      data = ${JSON.stringify(patch.data || {})}::jsonb
    WHERE id = ${id}
  `);
}

export async function deleteResume(id: string): Promise<void> {
  await ensureResumeSchema();
  await db.execute(sql`DELETE FROM resume_submissions WHERE id = ${id}`);
}

export async function deleteResumes(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await ensureResumeSchema();
  const r = await db.execute(sql`DELETE FROM resume_submissions WHERE id::text = ANY(${ids}::text[]) RETURNING id`);
  return rows(r).length;
}

/** Delete every submission matching the current search filter ('' = truly all). */
export async function deleteAllResumes(q = ''): Promise<number> {
  await ensureResumeSchema();
  const like = '%' + q + '%';
  const r = await db.execute(sql`
    DELETE FROM resume_submissions
    ${q ? sql`WHERE email ILIKE ${like} OR full_name ILIKE ${like} OR COALESCE(data->>'title','') ILIKE ${like}` : sql``}
    RETURNING id
  `);
  return rows(r).length;
}

/** Full rows for CSV export (respects the same search filter as the list). */
export async function exportResumes(q = ''): Promise<any[]> {
  try {
    await ensureResumeSchema();
    const like = '%' + q + '%';
    const r = await db.execute(sql`
      SELECT id, user_id, email, full_name, template, created_at,
             COALESCE(data->>'level','') AS level,
             COALESCE(data->>'phone','') AS phone,
             COALESCE(data->>'linkedin','') AS linkedin,
             COALESCE(data->>'summary','') AS summary
      FROM resume_submissions
      ${q ? sql`WHERE email ILIKE ${like} OR full_name ILIKE ${like} OR COALESCE(data->>'title','') ILIKE ${like}` : sql``}
      ORDER BY created_at DESC LIMIT 2000
    `);
    return rows(r);
  } catch { return []; }
}
