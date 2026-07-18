// src/lib/hub.ts — Virtual-campus hub (Prompt 21). A real personalized dashboard that ties the live
// subsystems together for a signed-in user; role decides which sections show. Plus honest, editable
// facilities/institutional info. NO fake 3D/XR — this is a navigational/dashboard surface only. The
// section-visibility logic is pure and unit-tested.
import { ADMIN_ROLE_KEYS } from '@/lib/rbac/roles';

export const ALL_SECTIONS = ['continue', 'deadlines', 'notifications', 'progress', 'credentials', 'community', 'guardian', 'admin'] as const;
export type Section = (typeof ALL_SECTIONS)[number];

/** Which dashboard sections a set of roles should see. Pure — role changes what's shown. */
export function visibleSections(roles: string[]): Section[] {
  const set = new Set(roles);
  const isStaff = roles.some((r) => ADMIN_ROLE_KEYS.includes(r));
  const out: Section[] = ['continue', 'deadlines', 'notifications', 'progress', 'credentials', 'community'];
  if (set.has('guardian')) out.push('guardian');
  if (isStaff) out.push('admin');
  return out;
}

// ---- facilities / institutional info (honest, editable) ----
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureHubSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_facilities (key TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', sort INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  booted = true;
}
export async function listFacilities(): Promise<any[]> {
  await ensureHubSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT key, title, body FROM edu_facilities ORDER BY sort, title`));
}
export async function saveFacility(key: string, title: string, body: string, sort = 0): Promise<void> {
  await ensureHubSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_facilities (key, title, body, sort) VALUES (${key}, ${title}, ${body}, ${sort}) ON CONFLICT (key) DO UPDATE SET title = ${title}, body = ${body}, sort = ${sort}, updated_at = NOW()`);
}
