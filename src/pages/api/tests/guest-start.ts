// POST /api/tests/guest-start
// Lets a person take a test WITHOUT an account, capturing their key details
// (name, email, phone) instead. For a free test we create the attempt and set
// a cookie tying the browser to it. For a premium test we return a Razorpay
// order; the browser pays, then /api/tests/guest-confirm finalises.
//
// Body: { testSlug, name, email, phone, phoneCountry }

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';
import { validatePhone } from '@/lib/phone-validate';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const testSlug = (body?.testSlug || '').toString().trim();
  const name = (body?.name || '').toString().trim();
  const email = (body?.email || '').toString().trim().toLowerCase();
  const phoneRaw = (body?.phone || '').toString().trim();
  const phoneCountry = (body?.phoneCountry || 'IN').toString().trim();
  if (!testSlug) return json({ ok: false, error: 'testSlug required' }, 400);
  if (!name || name.length < 2) return json({ ok: false, error: 'Please enter your full name.' }, 400);
  if (!email || !/.+@.+\..+/.test(email)) return json({ ok: false, error: 'Please enter a valid email.' }, 400);
  const ph = validatePhone(phoneCountry, phoneRaw);
  if (!ph.valid) return json({ ok: false, error: ph.reason || 'Enter a valid phone number.' }, 400);

  try {
    const test = rows(await db.execute(sql`SELECT id, slug, title, is_premium, price_inr_paise, currency FROM tests WHERE slug = ${testSlug} AND is_published = true LIMIT 1`))[0] as any;
    if (!test) return json({ ok: false, error: 'Test not found' }, 404);

    const treatAsFree = !test.is_premium || (test.price_inr_paise || 0) < 100;
    const runUrl = '/aquintutor/test/' + test.slug + '/run';

    if (treatAsFree) {
      const att = rows(await db.execute(sql`
        INSERT INTO test_attempts (test_id, candidate_id, candidate_email, candidate_name, status, max_score)
        VALUES (${test.id}, NULL, ${email}, ${name}, 'in_progress', ${test.total_marks || 0})
        RETURNING id`))[0] as any;
      // Capture phone on the attempt for the record (best-effort).
      await db.execute(sql`UPDATE test_attempts SET candidate_phone = ${ph.e164} WHERE id = ${att.id}`).catch(() => {});
      cookies.set('gat_' + test.id, att.id, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 6 });
      return json({ ok: true, free: true, redirect: runUrl });
    }

    // Premium: guest pays via Razorpay, then guest-confirm finalises.
    if (!isConfigured()) return json({ ok: false, error: 'Payments not configured. Please sign in to pay, or contact us.' }, 503);
    const displayCurrency = (test.currency || 'INR').toUpperCase();
    const displayAmountMinor = Math.max(1, parseInt(test.price_inr_paise || 100));
    const fx = await convertToInrPaise(displayCurrency, displayAmountMinor);
    const receipt = 'gqt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const result = await createOrder({
      amountPaise: fx.paise, currency: 'INR', receipt,
      notes: { purpose: 'test_enrollment', guest: 'true', testSlug: test.slug, name, email, phone: ph.e164 },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);
    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, contact, notes)
      VALUES (${result.order.id}, ${fx.paise}, 'INR', 'created', 'test_enrollment', 'test', ${test.id}, NULL, ${email}, ${ph.e164},
        ${sql.raw("'" + JSON.stringify({ receipt, guest: true, testSlug: test.slug, name }).replace(/'/g, "''") + "'::jsonb")})
    `).catch(() => {});
    return json({ ok: true, paid: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise: fx.paise, currency: 'INR', testTitle: test.title, testSlug: test.slug, prefill: { name, email, contact: ph.e164 } });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
