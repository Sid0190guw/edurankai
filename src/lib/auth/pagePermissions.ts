import { db } from '@/lib/db';
import postgres from 'postgres';
import type { User } from '@/lib/db/schema';

// Cache the matrix for the lifetime of a request
let matrixCache: Record<string, Record<string, { view: boolean; edit: boolean }>> | null = null;

async function loadMatrix() {
  if (matrixCache) return matrixCache;

  const databaseUrl = import.meta.env.DATABASE_URL || process.env.DATABASE_URL;
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    const rows = await sql`SELECT role, page_id, can_view, can_edit FROM role_page_permissions`;
    const m: Record<string, Record<string, { view: boolean; edit: boolean }>> = {};
    for (const r of rows) {
      const role = r.role as string;
      if (!m[role]) m[role] = {};
      m[role][r.page_id as string] = { view: !!r.can_view, edit: !!r.can_edit };
    }
    matrixCache = m;
    return m;
  } finally {
    await sql.end();
  }
}

/** Check if a user role can view an admin page. */
export async function canViewPage(user: User | null, pageId: string): Promise<boolean> {
  if (!user || !user.isActive) return false;
  if (user.role === 'super_admin') return true; // Super admin always sees everything
  const m = await loadMatrix();
  return m[user.role]?.[pageId]?.view === true;
}

/** Check if a user role can edit on an admin page. */
export async function canEditPage(user: User | null, pageId: string): Promise<boolean> {
  if (!user || !user.isActive) return false;
  if (user.role === 'super_admin') return true;
  const m = await loadMatrix();
  return m[user.role]?.[pageId]?.edit === true;
}

/** Get list of page IDs this user can view (for admin nav filtering). */
export async function getViewablePages(user: User | null): Promise<Set<string>> {
  if (!user || !user.isActive) return new Set();
  if (user.role === 'super_admin') {
    // Super admin sees all - return all pages from matrix
    const m = await loadMatrix();
    const pages = new Set<string>();
    for (const role of Object.values(m)) {
      for (const pid of Object.keys(role)) pages.add(pid);
    }
    return pages;
  }
  const m = await loadMatrix();
  const allowed = new Set<string>();
  if (m[user.role]) {
    for (const [pid, perms] of Object.entries(m[user.role])) {
      if (perms.view) allowed.add(pid);
    }
  }
  return allowed;
}