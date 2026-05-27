// POST /api/payments/create-order
// Body: { purpose, referenceType?, referenceId?, amountPaise, currency?, email, contact? }
// Returns: { ok, orderId, keyId, amountPaise, currency } for the browser checkout.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';

const ALLOWED_PURPOSES = new Set(['event', 'aquintutor_test', 'course_premium', 'donation', 'application_fee', 'other']);
const ALLOWED_CURRENCIES = new Set(['INR', 'USD']);

export const POST: APIRoute = async ({ request, locals }) => {
  if (!isConfigured()) {
    return json({ ok: false, error: 'Payments not configured' }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const purpose = String(body?.purpose || '').trim();
  const amountPaise = Number(body?.amountPaise);
  const currency = (body?.currency || 'INR').toString().toUpperCase();
  const email = String(body?.email || '').trim().toLowerCase();
  const contact = body?.contact ? String(body.contact).trim() : null;
  const referenceType = body?.referenceType ? String(body.referenceType).trim() : null;
  const referenceId = body?.referenceId ? String(body.referenceId).trim() : null;

  if (!ALLOWED_PURPOSES.has(purpose)) return json({ ok: false, error: 'invalid purpose' }, 400);
  if (!ALLOWED_CURRENCIES.has(currency)) return json({ ok: false, error: 'invalid currency' }, 400);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) return json({ ok: false, error: 'amountPaise must be integer >= 100' }, 400);
  if (!email || !email.includes('@')) return json({ ok: false, error: 'valid email required' }, 400);

  // Local receipt id (also stored on Razorpay's side)
  const receipt = 'era_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const result = await createOrder({
    amountPaise,
    currency,
    receipt,
    notes: {
      purpose,
      referenceType: referenceType || '',
      referenceId: referenceId || '',
      email,
    },
  });
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }

  const userId = (locals as any)?.user?.id || null;
  try {
    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, contact, notes
      ) VALUES (
        ${result.order.id}, ${amountPaise}, ${currency}, 'created', ${purpose},
        ${referenceType}, ${referenceId}, ${userId}, ${email}, ${contact},
        ${sql.raw("'" + JSON.stringify({ receipt }).replace(/'/g, "''") + "'::jsonb")}
      )
    `);
  } catch (e: any) {
    // Don't fail the user-facing call on insert failure - Razorpay still has the order
    console.error('[payments] insert failed:', e?.message);
  }

  return json({
    ok: true,
    orderId: result.order.id,
    keyId: getPublicKeyId(),
    amountPaise,
    currency,
  });
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
