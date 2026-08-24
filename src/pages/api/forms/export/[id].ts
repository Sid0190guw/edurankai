// GET /api/forms/export/[id] — admin CSV export of a form's responses.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { csvCell } from '@/lib/csv';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const GET: APIRoute = async ({ params, locals }) => {
  // Bulk CSV of every respondent's name, email and phone for one form. It sits outside /admin, so
  // NOTHING in src/middleware.ts covers it, and `role !== 'applicant'` admitted every internal role
  // plus the AquinTutor scopes. Forms are the `content` section (middleware.ts:90 maps /admin/forms
  // to it), and a bulk export of personal data is the `export` action on it — which
  // canAccessSection() grants alongside view/edit for a built-in role, and which a custom role can
  // be given or refused on its own.
  const denied = await denyAdminApi(locals, { section: 'content', action: 'export', label: 'forms.export' });
  if (denied) return denied;
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
