// GET /api/forms/export/[id] — admin CSV export of a form's responses.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function csvCell(v: any): string {
  const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return '"' + s.replace(/"/g, '""') + '"';
}

export const GET: APIRoute = async ({ params, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return new Response('Unauthorized', { status: 401 });
  const id = params.id;
  const form: any = rows(await db.execute(sql`SELECT slug, fields FROM forms WHERE id = ${id} LIMIT 1`))[0];
  if (!form) return new Response('Not found', { status: 404 });
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const resp = rows(await db.execute(sql`SELECT * FROM form_responses WHERE form_id = ${id} ORDER BY created_at ASC`));

  const headers = ['submitted_at', 'name', 'email', 'phone', 'payment_status', ...fields.map((f: any) => f.label)];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of resp as any[]) {
    const d = r.data || {};
    const line = [r.created_at, r.respondent_name, r.respondent_email, r.respondent_phone, r.payment_status, ...fields.map((f: any) => d[f.key])];
    lines.push(line.map(csvCell).join(','));
  }
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="' + (form.slug || 'form') + '-responses.csv"' },
  });
};
