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

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Counted before the form is even looked up. This route is unauthenticated by design, and on a
  // form with a fee each call reaches convertToInrPaise() and then createOrder() — a live call to
  // the payment gateway with production keys. Fails CLOSED for that reason: a dropped submission is
  // retryable, a stream of fabricated pending orders is quota spent and a reconciliation run that
  // has to separate real payments from noise.
  const spend = await overPublicFormLimit('forms-submit', clientIp(request.headers) || String(clientAddress || ''), { whenUnavailable: 'refuse' });
  if (spend.blocked) return json({ ok: false, error: 'Too many submissions from this connection. Please try again later.' }, 429);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const slug = (body?.slug || '').toString().trim();
  const data = (body && typeof body.data === 'object' && body.data) ? body.data : {};
  if (!slug) return json({ ok: false, error: 'slug required' }, 400);

  const form: any = rows(await db.execute(sql`SELECT * FROM forms WHERE slug = ${slug} AND is_published = true LIMIT 1`))[0];
  if (!form) return json({ ok: false, error: 'Form not found' }, 404);
  const fields = Array.isArray(form.fields) ? form.fields : [];

  // Validate required + extract respondent identity.
  let name = '', email = '', phone = '';
  for (const f of fields) {
    const v = data[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (f.required && empty) return json({ ok: false, error: 'Please fill: ' + f.label }, 400);
    if (f.type === 'email' && !email && v) email = String(v).trim();
    if (f.type === 'phone' && !phone && v) phone = String(v).trim();
    if (f.type === 'text' && !name && v) name = String(v).trim();
  }
  if (!name) name = (data.full_name || data.name || '').toString().trim();
  if (!email) email = (data.email || '').toString().trim();
  if (!phone) phone = (data.phone || '').toString().trim();
  // These three are read straight out of the caller's object and go into their own columns, so they
  // need bounding independently of the jsonb cap below — they are extracted before it is applied.
  name = name.slice(0, 200);
  email = email.slice(0, 320);
  phone = phone.slice(0, 40);

  // `data` went into jsonb whole. The loop above only checks that REQUIRED declared fields are
  // non-empty — it never rejects keys the form did not declare, and nothing capped the size, so one
  // POST could carry megabytes of undeclared keys into form_responses. Keep the declared keys, drop
  // the rest, and refuse anything still oversized rather than truncating it: a real answer that is
  // too long should be reported to the person who wrote it, not silently cut in half.
  const declared = new Set(fields.map((f: any) => String(f.key)));
  const clean: Record<string, any> = {};
  for (const k of Object.keys(data)) if (declared.has(k)) clean[k] = (data as any)[k];
  const rawJson = JSON.stringify(clean);
  if (rawJson.length > 64_000) return json({ ok: false, error: 'That submission is too large.' }, 413);

  const ip = (clientAddress || '').toString().slice(0, 64);
  const dataJson = sql.raw("'" + rawJson.replace(/'/g, "''") + "'::jsonb");
  const feeChf = parseInt(form.fee_chf || 0) || 0;

  if (feeChf <= 0) {
    await db.execute(sql`
      INSERT INTO form_responses (form_id, data, respondent_name, respondent_email, respondent_phone, payment_status, ip_address)
      VALUES (${form.id}, ${dataJson}, ${name || null}, ${email || null}, ${phone || null}, 'none', ${ip || null})
    `);
    return json({ ok: true, done: true, message: form.success_message || 'Thank you — your response has been recorded.' });
  }

  if (!isConfigured()) return json({ ok: false, error: 'Payments not configured for this form.' }, 503);
  const fx = await convertToInrPaise('CHF', feeChf * 100);
  const receipt = 'form_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const result = await createOrder({ amountPaise: fx.paise, currency: 'INR', receipt, notes: { purpose: 'form_fee', formSlug: slug, email, name } });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);
  await db.execute(sql`
    INSERT INTO form_responses (form_id, data, respondent_name, respondent_email, respondent_phone, payment_status, order_id, ip_address)
    VALUES (${form.id}, ${dataJson}, ${name || null}, ${email || null}, ${phone || null}, 'pending', ${result.order.id}, ${ip || null})
  `);
  return json({ ok: true, paid: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise: fx.paise, currency: 'INR', formTitle: form.title, prefill: { name, email, contact: phone } });
};
