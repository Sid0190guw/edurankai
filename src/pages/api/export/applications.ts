// src/pages/api/export/applications.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function escapeCSV(val: any): string {
  if (val == null) return '';
  let s = String(val);
  if (val instanceof Date) s = val.toISOString();
  else if (typeof val === 'object') s = JSON.stringify(val);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export const GET: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  // A bulk CSV of the applicant pipeline must require the SAME permission that gates the
  // matching admin section. `role !== 'applicant'` was not that check: every internal role —
  // including editor, which offer letters auto-assign to candidates before they even accept —
  // passed it, so the whole file was one authenticated GET away for anyone who was not an applicant.
  if (!user) return new Response('Forbidden', { status: 403 });
  {
    const { canAccessSection } = await import('@/lib/auth/permissions');
    const allowed = await canAccessSection(user as any, 'applications', 'export').catch(() => false);
    if (!allowed) return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');

  let whereClause = sql`WHERE 1=1`;
  if (status) whereClause = sql`WHERE status = ${status}`;
  if (search) {
    whereClause = sql`WHERE LOWER(first_name) LIKE ${'%' + search.toLowerCase() + '%'}
      OR LOWER(last_name) LIKE ${'%' + search.toLowerCase() + '%'}
      OR LOWER(email) LIKE ${'%' + search.toLowerCase() + '%'}
      OR LOWER(application_number) LIKE ${'%' + search.toLowerCase() + '%'}`;
  }

  try {
    const r = await db.execute(sql`
      SELECT
        application_number as "Application Number",
        first_name as "First Name",
        last_name as "Last Name",
        email as "Email",
        phone as "Phone",
        role_title_snapshot as "Role",
        status as "Status",
        created_at as "Applied On",
        education_summary as "Education",
        why_us as "Why Us",
        portfolio_url as "Portfolio",
        linkedin_url as "LinkedIn",
        github_url as "GitHub",
        location as "Location",
        years_experience as "Years Experience"
      FROM applications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 5000
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);

    if (rows.length === 0) {
      return new Response('No data', { status: 404 });
    }

    const columns = Object.keys(rows[0] as any);
    const csvRows = [columns.map(escapeCSV).join(',')];
    for (const row of rows as any[]) {
      csvRows.push(columns.map(c => escapeCSV(row[c])).join(','));
    }
    const csv = '\uFEFF' + csvRows.join('\n');
    const filename = `applications-${new Date().toISOString().slice(0,10)}.csv`;

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });
  } catch (e: any) {
    return new Response('Export failed: ' + e.message, { status: 500 });
  }
};
