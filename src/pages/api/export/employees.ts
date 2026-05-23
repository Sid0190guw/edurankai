// src/pages/api/export/employees.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function escapeCSV(val: any): string {
  if (val == null) return '';
  let s = String(val);
  if (val instanceof Date) s = val.toISOString();
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const r = await db.execute(sql`
      SELECT
        employee_code as "Code",
        first_name as "First Name",
        last_name as "Last Name",
        email as "Email",
        phone as "Phone",
        designation as "Designation",
        department as "Department",
        date_of_joining as "Joining Date",
        employment_type as "Type",
        is_active as "Active"
      FROM hr_employees ORDER BY created_at DESC LIMIT 5000
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    if (rows.length === 0) return new Response('No data', { status: 404 });
    const columns = Object.keys(rows[0] as any);
    const csvRows = [columns.map(escapeCSV).join(',')];
    for (const row of rows as any[]) {
      csvRows.push(columns.map(c => escapeCSV(row[c])).join(','));
    }
    return new Response('\uFEFF' + csvRows.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="employees-${new Date().toISOString().slice(0,10)}.csv"`
      }
    });
  } catch (e: any) {
    return new Response('Export failed: ' + e.message, { status: 500 });
  }
};
