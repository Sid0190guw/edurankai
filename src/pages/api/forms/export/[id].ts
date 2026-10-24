// GET /api/forms/export/[id] — admin CSV export of a form's responses.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { csvCell } from '@/lib/csv';
import { normalizeFormFields, type FormField } from '@/lib/forms/form-schema';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function dbErrorMessage(error: unknown): string {
  const cause = (error as any)?.cause;
  return String(cause?.message || (error as any)?.message || 'unknown error');
}

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
  let fields: FormField[];
  try {
    fields = normalizeFormFields(form.fields);
  } catch (error) {
    console.error('[forms/export] invalid saved form definition:', dbErrorMessage(error));
    return new Response('This form has an invalid question definition and cannot be exported.', { status: 500 });
  }
  const resp = rows(await db.execute(sql`SELECT * FROM form_responses WHERE form_id = ${id} ORDER BY created_at ASC`));

  const headers = ['submitted_at', 'name', 'email', 'phone', 'payment_status', ...fields.map((f) => f.label)];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of resp as any[]) {
    const d = r.data || {};
    const line = [r.created_at, r.respondent_name, r.respondent_email, r.respondent_phone, r.payment_status, ...fields.map((f) => d[f.key])];
    lines.push(line.map(csvCell).join(','));
  }
  const filename = String(form.slug || 'form').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'form';
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}-responses.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
