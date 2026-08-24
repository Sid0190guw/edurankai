// src/pages/api/export/users.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { csvCell } from '@/lib/csv';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  // A bulk CSV of the user directory must require the SAME permission that gates the
  // matching admin section. `role !== 'applicant'` was not that check: every internal role —
  // including editor, which offer letters auto-assign to candidates before they even accept —
  // passed it, so the whole file was one authenticated GET away for anyone who was not an applicant.
  if (!user) return new Response('Forbidden', { status: 403 });
  {
    const { canAccessSection } = await import('@/lib/auth/permissions');
    const allowed = await canAccessSection(user as any, 'users', 'export').catch(() => false);
    if (!allowed) return new Response('Forbidden', { status: 403 });
  }
  // A bulk download of the user directory is an administrative action and is recorded as one, after
  // the gate. logAudit swallows its own failure, so it can never turn a permitted export into a 500.
  {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: (user as any)?.id ?? null, action: 'export.users', entity: 'users' });
  }
  try {
    const r = await db.execute(sql`
      SELECT
        name as "Name",
        email as "Email",
        role as "Role",
        is_active as "Active",
        created_at as "Joined"
      FROM users ORDER BY created_at DESC LIMIT 5000
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    if (rows.length === 0) return new Response('No data', { status: 404 });
    const columns = Object.keys(rows[0] as any);
    const csvRows = [columns.map(csvCell).join(',')];
    for (const row of rows as any[]) {
      csvRows.push(columns.map(c => csvCell(row[c])).join(','));
    }
    return new Response('\uFEFF' + csvRows.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="users-${new Date().toISOString().slice(0,10)}.csv"`
      }
    });
  } catch (e: any) {
    return new Response('Export failed: ' + e.message, { status: 500 });
  }
};
