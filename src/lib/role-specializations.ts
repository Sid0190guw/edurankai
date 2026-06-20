// Product/area sub-specializations under a job role. A role (e.g. "Sales Intern")
// can offer several product-specific tracks (CRM, ERP, AI automation, …). The
// applicant opts into one in the apply form; admins open/close each track (and
// the whole role) as positions fill. Self-bootstrapping schema.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function slugify(s: string): string { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140); }

export function ensureSpecSchema(): Promise<void> {
  return ensureOnce('role_specializations', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS role_specializations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id UUID NOT NULL,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(160),
      description TEXT,
      is_open BOOLEAN NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS role_spec_role_idx ON role_specializations(role_id, is_open, sort_order)`);
    // The application stores which track the candidate chose.
    await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS specialization_id UUID`);
    await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS specialization_name VARCHAR(160)`);
    await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS specialization_id UUID`).catch(() => {});
    await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS specialization_name VARCHAR(160)`).catch(() => {});
  });
}

export async function listForRole(roleId: string, openOnly = false): Promise<any[]> {
  await ensureSpecSchema();
  if (!roleId) return [];
  return rows(await db.execute(sql`
    SELECT id, role_id, name, slug, description, is_open, sort_order
    FROM role_specializations
    WHERE role_id = ${roleId} ${openOnly ? sql`AND is_open = true` : sql``}
    ORDER BY sort_order ASC, name ASC
  `).catch(() => [] as any));
}

export async function createSpec(roleId: string, name: string, description = ''): Promise<{ ok: boolean; error?: string }> {
  await ensureSpecSchema();
  const nm = (name || '').trim();
  if (!roleId || !nm) return { ok: false, error: 'Name required' };
  try {
    const maxR = rows(await db.execute(sql`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM role_specializations WHERE role_id = ${roleId}`))[0];
    await db.execute(sql`
      INSERT INTO role_specializations (role_id, name, slug, description, is_open, sort_order)
      VALUES (${roleId}, ${nm.slice(0, 120)}, ${slugify(nm)}, ${(description || '').slice(0, 2000)}, true, ${Number(maxR?.n) || 1})
    `);
    return { ok: true };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; }
}

export async function setSpecOpen(id: string, roleId: string, open: boolean): Promise<void> {
  await db.execute(sql`UPDATE role_specializations SET is_open = ${open} WHERE id = ${id} AND role_id = ${roleId}`).catch(() => {});
}

export async function updateSpec(id: string, roleId: string, name: string, description: string): Promise<void> {
  const nm = (name || '').trim();
  if (!nm) return;
  await db.execute(sql`UPDATE role_specializations SET name = ${nm.slice(0, 120)}, slug = ${slugify(nm)}, description = ${(description || '').slice(0, 2000)} WHERE id = ${id} AND role_id = ${roleId}`).catch(() => {});
}

export async function deleteSpec(id: string, roleId: string): Promise<void> {
  await db.execute(sql`DELETE FROM role_specializations WHERE id = ${id} AND role_id = ${roleId}`).catch(() => {});
}

export async function getSpec(id: string): Promise<any | null> {
  if (!id) return null;
  await ensureSpecSchema();
  return rows(await db.execute(sql`SELECT id, role_id, name, is_open FROM role_specializations WHERE id = ${id} LIMIT 1`).catch(() => [] as any))[0] || null;
}
