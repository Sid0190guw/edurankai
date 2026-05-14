import postgres from 'postgres';
import type { User } from '@/lib/db/schema';

async function loadMatrix(): Promise<Record<string, Record<string, { view: boolean; edit: boolean }>>> {
  const databaseUrl = import.meta.env.DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) return {};
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    const rows = await sql`SELECT role, page_id, can_view, can_edit FROM role_page_permissions`;
    const m: Record<string, Record<string, { view: boolean; edit: boolean }>> = {};
    for (const r of rows) {
      const role = r.role as string;
      if (!m[role]) m[role] = {};
      m[role][r.page_id as string] = { view: !!r.can_view, edit: !!r.can_edit };
    }
    return m;
  } catch (err) {
    console.error('[pagePermissions] loadMatrix failed:', err);
    return {};
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function canViewPage(user: User | null, pageId: string): Promise<boolean> {
  if (!user || !user.isActive) return false;
  if (user.role === 'super_admin') return true;
  try {
    const m = await loadMatrix();
    return m[user.role]?.[pageId]?.view === true;
  } catch {
    return false;
  }
}

export async function canEditPage(user: User | null, pageId: string): Promise<boolean> {
  if (!user || !user.isActive) return false;
  if (user.role === 'super_admin') return true;
  try {
    const m = await loadMatrix();
    return m[user.role]?.[pageId]?.edit === true;
  } catch {
    return false;
  }
}

export async function getViewablePages(user: User | null): Promise<Set<string>> {
  if (!user || !user.isActive) return new Set();
  const ALL_PAGES = ['dashboard', 'applications', 'offers', 'messages', 'roles', 'departments', 'events', 'products', 'content', 'users', 'audit', 'settings', 'contact'];
  if (user.role === 'super_admin') return new Set(ALL_PAGES);
  try {
    const m = await loadMatrix();
    const allowed = new Set<string>();
    if (m[user.role]) {
      for (const [pid, perms] of Object.entries(m[user.role])) {
        if (perms.view) allowed.add(pid);
      }
    }
    return allowed;
  } catch {
    return new Set();
  }
}