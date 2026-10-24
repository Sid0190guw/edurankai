// POST /api/forms/submit
// Public form submission (no account). Validates required fields. If the form
// has a fee, returns a Razorpay order; the browser pays then calls
// /api/forms/confirm. Free forms record the response immediately.
// Body: { slug, data: { fieldKey: value, ... } }

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';
import { clientIp, overPublicFormLimit } from '@/lib/public-form-limit';
import { normalizeFormFields, validateFormAnswers, validateFormForPublishing, type FormField } from '@/lib/forms/form-schema';
import { decidePriorApplication, splitApplicantName } from '@/lib/forms/application-policy';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function dbErrorMessage(error: unknown): string {
  const cause = (error as any)?.cause;
  return String(cause?.message || (error as any)?.message || 'unknown error');
}

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  // Counted before the form is even looked up. This route is unauthenticated by design, and on a
  // form with a fee each call reaches convertToInrPaise() and then createOrder() — a live call to
  // the payment gateway with production keys. Fails CLOSED for that reason: a dropped submission is
  // retryable, a stream of fabricated pending orders is quota spent and a reconciliation run that
  // has to separate real payments from noise.
  const spend = await overPublicFormLimit('forms-submit', clientIp(request.headers) || String(clientAddress || ''), { whenUnavailable: 'refuse' });
  if (spend.blocked) return json({ ok: false, error: 'Too many submissions from this connection. Please try again later.' }, 429);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'Please submit a valid form request.' }, 400);
  }
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const data = body.data;
  if (!slug) return json({ ok: false, error: 'slug required' }, 400);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json({ ok: false, error: 'Please submit valid form responses.' }, 400);
  }

  let form: any;
  try {
    form = rows(await db.execute(sql`SELECT * FROM forms WHERE slug = ${slug} AND is_published = true LIMIT 1`))[0];
  } catch (error) {
    console.error('[forms/submit] published form lookup failed:', dbErrorMessage(error));
    return json({ ok: false, error: 'Forms are temporarily unavailable. Please try again later.' }, 503);
  }
  if (!form) return json({ ok: false, error: 'Form not found' }, 404);
  let fields: FormField[];
  try {
    fields = normalizeFormFields(form.fields);
    const publicationError = validateFormForPublishing(fields);
    if (publicationError) throw new Error(publicationError);
  } catch (error) {
    console.error('[forms/submit] invalid saved form definition:', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'This form is temporarily unavailable because its question setup is invalid.' }, 500);
  }
  const validation = validateFormAnswers(fields, data);
  if (validation.error) return json({ ok: false, error: validation.error }, 400);
  const declaredFields = new Map(fields.map((field) => [String(field.key), field]));
  const cleanData = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(validation.data)) {
    const field = declaredFields.get(key);
    if (!field) continue;
    const value = validation.data[key];
    cleanData[key] = field.type === 'acknowledgment'
      ? {
          acknowledged: value,
          statement: String(field.label || '').slice(0, 200),
          acknowledgedAt: new Date().toISOString(),
        }
      : value;
  }
  const rawJson = JSON.stringify(cleanData);
  if (rawJson.length > 128_000) return json({ ok: false, error: 'That submission is too large.' }, 413);
  const submissionData = cleanData;

  let applicationLink: any = null;
  try {
    applicationLink = rows(await db.execute(sql`
      SELECT l.role_id, l.name_field_key, l.email_field_key, l.phone_field_key, l.reviewer_user_id,
             r.title AS role_title, r.level, r.department_id, d.name AS department_name,
             r.is_open, r.application_deadline
      FROM form_role_links l
      JOIN roles r ON r.id = l.role_id
      LEFT JOIN departments d ON d.id = r.department_id
      WHERE l.form_id = ${form.id}
      LIMIT 1
    `))[0] || null;
  } catch (error) {
    const code = (error as any)?.cause?.code;
    if (code !== '42P01') {
      console.error('[forms/submit] recruitment link lookup failed:', error instanceof Error ? error.message : error);
      return json({ ok: false, error: 'Recruitment submission is temporarily unavailable. Please try again later.' }, 503);
    }
    console.warn('[forms/submit] recruitment-link migration is not installed; continuing with ordinary form submission.');
  }

  if (applicationLink) {
    const sessionUser = locals.user;
    if (!sessionUser || sessionUser.role !== 'applicant') {
      return json({
        ok: false,
        error: 'Sign in to your verified applicant account before submitting this application form.',
        signInUrl: '/portal/login?next=' + encodeURIComponent('/f/' + slug),
      }, 401);
    }
    if (Number(form.fee_chf || 0) > 0) {
      console.error('[forms/submit] linked recruitment form has a nonzero form fee:', form.id);
      return json({ ok: false, error: 'This recruitment form is misconfigured. Please contact the form owner.' }, 503);
    }

    const nameKey = String(applicationLink.name_field_key || '');
    const emailKey = String(applicationLink.email_field_key || '');
    const phoneKey = String(applicationLink.phone_field_key || '');
    const nameField = fields.find((field) => field.key === nameKey && field.type === 'text');
    const emailField = fields.find((field) => field.key === emailKey && field.type === 'email');
    const phoneField = phoneKey ? fields.find((field) => field.key === phoneKey && field.type === 'phone') : null;
    if (!nameField || !emailField || (phoneKey && !phoneField)) {
      console.error('[forms/submit] linked recruitment form has invalid field mapping:', form.id);
      return json({ ok: false, error: 'This application form needs its identity questions reconfigured by the form owner.' }, 503);
    }
    const respondentEmail = String(submissionData[emailKey] || '').trim().toLowerCase();
    const respondentName = String(submissionData[nameKey] || '').trim().replace(/\s+/g, ' ');
    if (!respondentName) return json({ ok: false, error: `Please fill: ${nameField.label}` }, 400);

    let account: any;
    try {
      account = rows(await db.execute(sql`
        SELECT id, email, email_verified
        FROM users
        WHERE id = ${sessionUser.id} AND role = 'applicant' AND is_active = true
        LIMIT 1
      `))[0];
    } catch (error) {
      console.error('[forms/submit] applicant account validation failed:', error instanceof Error ? error.message : error);
      return json({ ok: false, error: 'We could not verify your account. Please retry.' }, 503);
    }
    if (!account || !account.email_verified || String(account.email).trim().toLowerCase() !== respondentEmail) {
      return json({ ok: false, error: 'Use the verified email address on your signed-in applicant account.' }, 403);
    }

    let applicationResult: any;
    try {
      applicationResult = await db.transaction(async (tx) => {
        const roleRows = rows(await tx.execute(sql`
          SELECT id, title, level, department_id, is_open, application_deadline
          FROM roles
          WHERE id = ${applicationLink.role_id}
          LIMIT 1
        `));
        const role = roleRows[0];
        if (!role || !role.is_open ||
            (role.application_deadline && new Date(role.application_deadline).getTime() <= Date.now())) {
          return { error: 'This position is no longer accepting applications.' };
        }
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${String(account.id) + ':' + String(role.id)}, 0))
        `);
        const prior = rows(await tx.execute(sql`
          SELECT id, status, created_at, updated_at
          FROM applications
          WHERE (
                  role_id = ${role.id}
               OR (role_id IS NULL AND role_title_snapshot = ${role.title})
                )
            AND (applicant_user_id = ${account.id} OR LOWER(email) = ${respondentEmail})
          ORDER BY
            CASE WHEN status IN ('withdrawn', 'rejected') THEN 1 ELSE 0 END,
            COALESCE(updated_at, created_at) DESC NULLS LAST,
            created_at DESC
          LIMIT 1
        `));
        const priorDecision = decidePriorApplication(prior);
        if (priorDecision.kind === 'duplicate') {
          return { applicationId: priorDecision.applicationId, duplicate: true };
        }
        if (priorDecision.kind === 'cooling') {
          return { error: 'A six-month waiting period applies before reapplying to this position.' };
        }

        let assignedReviewerId: string | null = null;
        if (applicationLink.reviewer_user_id) {
          const reviewer = rows(await tx.execute(sql`
            SELECT id
            FROM users
            WHERE id = ${applicationLink.reviewer_user_id}
              AND is_active = true
              AND role::text IN ('hr', 'recruiter', 'reviewer', 'department_head')
            LIMIT 1
          `))[0];
          if (!reviewer) {
            return { error: 'The assigned reviewer is no longer active. Please contact the form owner.' };
          }
          assignedReviewerId = String(reviewer.id);
        }

        const { firstName, lastName } = splitApplicantName(respondentName);
        const phone = phoneField ? String(submissionData[phoneKey] || '').trim().slice(0, 50) : '';
        const applicationNumber = rows(await tx.execute(sql`
          SELECT 'ERA-' || EXTRACT(YEAR FROM NOW())::int::text || '-' ||
            UPPER(SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 10)) AS number
        `))[0]?.number;
        const inserted = rows(await tx.execute(sql`
          INSERT INTO applications (
            application_number, role_id, applicant_user_id, first_name, last_name, email,
            phone, city, portfolio_url, department_snapshot, role_title_snapshot, level,
            status, raw_submission, fee_paid, fee_paid_at, assigned_reviewer_id
          ) VALUES (
            ${applicationNumber}, ${role.id}, ${account.id}, ${firstName.slice(0, 100)},
            ${lastName.slice(0, 100)}, ${account.email}, ${phone}, '', '',
            ${applicationLink.department_name || role.department_id || ''},
            ${role.title}, ${role.level}, 'submitted', ${JSON.stringify(submissionData)}::jsonb,
            false, NULL, ${assignedReviewerId}
          )
          RETURNING id, application_number
        `));
        const created = inserted[0];
        if (!created?.id) throw new Error('Application insert returned no record.');
        await tx.execute(sql`
          INSERT INTO application_stage_events (
            application_id, from_stage, to_stage, actor_user_id, actor_name, note
          ) VALUES (
            ${created.id}, NULL, 'submitted', ${account.id},
            ${respondentName.slice(0, 200)}, 'Application submitted through a linked form.'
          )
        `);
        await tx.execute(sql`
          INSERT INTO form_responses (
            form_id, data, respondent_name, respondent_email, respondent_phone,
            payment_status, ip_address, application_id, applicant_user_id
          ) VALUES (
            ${form.id}, ${JSON.stringify(submissionData)}::jsonb,
            ${respondentName.slice(0, 200)}, ${account.email}, ${phone || null},
            'none', ${String(clientAddress || '').slice(0, 64) || null}, ${created.id}, ${account.id}
          )
        `);
        return { applicationId: String(created.id), applicationNumber: String(created.application_number), duplicate: false };
      });
    } catch (error) {
      console.error('[forms/submit] linked application transaction failed:', error instanceof Error ? error.message : error);
      return json({ ok: false, error: 'We could not record your application. No submission was saved; please retry.' }, 503);
    }

    if (applicationResult.error) return json({ ok: false, error: applicationResult.error }, 409);
    if (applicationResult.duplicate) {
      return json({
        ok: true,
        redirect: '/portal/applications?existing=1&application=' + encodeURIComponent(applicationResult.applicationId),
        message: 'You already have an active application for this position.',
      });
    }
    return json({
      ok: true,
      redirect: '/portal/applications?submitted=1&application=' + encodeURIComponent(applicationResult.applicationId),
      message: 'Application received. Reference: ' + applicationResult.applicationNumber,
    });
  }

  // Validate required + extract respondent identity.
  let name = '', email = '', phone = '';
  for (const f of fields) {
    const v = submissionData[f.key];
    if (f.type === 'email' && !email && v) email = String(v).trim();
    if (f.type === 'phone' && !phone && v) phone = String(v).trim();
    if (f.type === 'text' && !name && v) name = String(v).trim();
  }
  if (!name) name = (submissionData.full_name || submissionData.name || '').toString().trim();
  if (!email) email = (submissionData.email || '').toString().trim();
  if (!phone) phone = (submissionData.phone || '').toString().trim();
  // These three are read straight out of the caller's object and go into their own columns, so they
  // need bounding independently of the jsonb cap below — they are extracted before it is applied.
  name = name.slice(0, 200);
  email = email.slice(0, 320);
  phone = phone.slice(0, 40);

  const ip = (clientAddress || '').toString().slice(0, 64);
  const dataJson = sql.raw("'" + rawJson.replace(/'/g, "''") + "'::jsonb");
  const feeChf = parseInt(form.fee_chf || 0) || 0;

  if (feeChf <= 0) {
    try {
      await db.execute(sql`
        INSERT INTO form_responses (form_id, data, respondent_name, respondent_email, respondent_phone, payment_status, ip_address)
        VALUES (${form.id}, ${dataJson}, ${name || null}, ${email || null}, ${phone || null}, 'none', ${ip || null})
      `);
    } catch (error) {
      console.error('[forms/submit] response persistence failed:', dbErrorMessage(error));
      return json({ ok: false, error: 'We could not record your response. Please retry.' }, 503);
    }
    return json({ ok: true, done: true, message: form.success_message || 'Thank you — your response has been recorded.' });
  }

  if (!isConfigured()) return json({ ok: false, error: 'Payments not configured for this form.' }, 503);
  const fx = await convertToInrPaise('CHF', feeChf * 100);
  const receipt = 'form_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const result = await createOrder({ amountPaise: fx.paise, currency: 'INR', receipt, notes: { purpose: 'form_fee', formSlug: slug, email, name } });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);
  try {
    await db.execute(sql`
      INSERT INTO form_responses (form_id, data, respondent_name, respondent_email, respondent_phone, payment_status, order_id, ip_address)
      VALUES (${form.id}, ${dataJson}, ${name || null}, ${email || null}, ${phone || null}, 'pending', ${result.order.id}, ${ip || null})
    `);
  } catch (error) {
    console.error('[forms/submit] pending payment response persistence failed:', dbErrorMessage(error));
    return json({ ok: false, error: 'We could not save your payment request. Please contact the form owner before trying again.' }, 503);
  }
  return json({ ok: true, paid: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise: fx.paise, currency: 'INR', formTitle: form.title, prefill: { name, email, contact: phone } });
};
