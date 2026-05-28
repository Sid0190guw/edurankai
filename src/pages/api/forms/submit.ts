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

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, clientAddress }) => {
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

  const ip = (clientAddress || '').toString().slice(0, 64);
  const dataJson = sql.raw("'" + JSON.stringify(data).replace(/'/g, "''") + "'::jsonb");
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
