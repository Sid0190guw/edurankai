// GET /api/forms/export-json/[id] — authorized structured export of one form's responses.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { normalizeFormFields, type FormField } from '@/lib/forms/form-schema';

function rows(result: any): any[] { return Array.isArray(result) ? result : (result?.rows || []); }

export const GET: APIRoute = async ({ params, locals }) => {
  const denied = await denyAdminApi(locals, { section: 'content', action: 'export', label: 'forms.export.json' });
  if (denied) return denied;

  const id = params.id;
  if (!id) return new Response('Not found', { status: 404 });

  const form: any = rows(await db.execute(sql`SELECT id, slug, title, fields FROM forms WHERE id = ${id} LIMIT 1`))[0];
  if (!form) return new Response('Not found', { status: 404 });

  let fields: FormField[];
  try {
    fields = normalizeFormFields(form.fields);
  } catch (error) {
    console.error('[forms/export-json] invalid saved form definition:', error instanceof Error ? error.message : error);
    return new Response('This form has an invalid question definition and cannot be exported.', { status: 500 });
  }

  const responses = rows(await db.execute(sql`
    SELECT created_at, respondent_name, respondent_email, respondent_phone, payment_status, data
    FROM form_responses WHERE form_id = ${id} ORDER BY created_at ASC
  `));

  const body = {
    form: { id: form.id, slug: form.slug, title: form.title },
    exportedAt: new Date().toISOString(),
    questions: fields.map(({ key, type, label, required, options }) => ({ key, type, label, required, options })),
    responses: responses.map((response: any) => ({
      submittedAt: response.created_at,
      respondent: {
        name: response.respondent_name,
        email: response.respondent_email,
        phone: response.respondent_phone,
      },
      paymentStatus: response.payment_status,
      answers: response.data && typeof response.data === 'object' && !Array.isArray(response.data) ? response.data : {},
    })),
  };

  const filename = String(form.slug || 'form').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'form';
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}-responses.json"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
