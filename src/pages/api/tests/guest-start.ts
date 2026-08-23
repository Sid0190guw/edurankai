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
import { clientIp, overPublicFormLimit } from '@/lib/public-form-limit';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  // Same shape as /api/forms/submit: unauthenticated, writes a row, and on the premium branch opens
  // a live payment order. Fails CLOSED — a fabricated pending order costs gateway quota and buries
  // real payments in the reconciliation run.
  const spend = await overPublicFormLimit('tests-guest-start', clientIp(request.headers) || String(clientAddress || ''), { whenUnavailable: 'refuse' });
  if (spend.blocked) return json({ ok: false, error: 'Too many attempts from this connection. Please try again later.' }, 429);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const testSlug = (body?.testSlug || '').toString().trim();
  const name = (body?.name || '').toString().trim().slice(0, 200);
  const email = (body?.email || '').toString().trim().toLowerCase().slice(0, 320);
  const phoneRaw = (body?.phone || '').toString().trim().slice(0, 40);
  const phoneCountry = (body?.phoneCountry || 'IN').toString().trim();
  if (!testSlug) return json({ ok: false, error: 'testSlug required' }, 400);
  if (!name || name.length < 2) return json({ ok: false, error: 'Please enter your full name.' }, 400);
  if (!email || !/.+@.+\..+/.test(email)) return json({ ok: false, error: 'Please enter a valid email.' }, 400);
  const ph = validatePhone(phoneCountry, phoneRaw);
  if (!ph.valid) return json({ ok: false, error: ph.reason || 'Enter a valid phone number.' }, 400);

  try {
    const test = rows(await db.execute(sql`SELECT id, slug, title, is_premium, price_inr_paise, price_chf, currency FROM tests WHERE slug = ${testSlug} AND is_published = true LIMIT 1`))[0] as any;
    if (!test) return json({ ok: false, error: 'Test not found' }, 404);

    const priceChf = Number(test.price_chf || 0);
    const treatAsFree = !test.is_premium
      || (priceChf <= 0 && (test.price_inr_paise || 0) < 100);
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
    // Prefer price_chf as canonical (legacy price_inr_paise was charging 1 INR
    // for 1 CHF tests — ~99% revenue loss). Fall back only when price_chf=0.
    let fx;
    if (priceChf > 0) {
      fx = await convertToInrPaise('CHF', Math.round(priceChf * 100));
    } else {
      fx = await convertToInrPaise('INR', Math.max(1, parseInt(test.price_inr_paise || 100)));
    }
    // Same absurd-price guard as the logged-in path (start-test-enrollment.ts). price_inr_paise is
    // in PAISE, so a test configured with 120 meaning "Rs 120" charges Rs 1.20. Refuse rather than
    // take a nonsense payment — a failed checkout is a support message, a wrong charge is a refund.
    if (fx.paise > 0 && fx.paise < 1000) {
      console.error('[guest-start] refusing absurd price', { slug: test.slug, paise: fx.paise, priceChf, price_inr_paise: test.price_inr_paise });
      return json({ ok: false, error: 'This test is not correctly priced yet, so we have not taken any payment. Please write to hr@edurankai.in and we will sort it out.' }, 409);
    }

    const receipt = 'gqt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const result = await createOrder({
      amountPaise: fx.paise, currency: 'INR', receipt,
      notes: { purpose: 'test_enrollment', guest: 'true', testSlug: test.slug, name, email, phone: ph.e164 || '' },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);
    // THE PAYMENTS ROW IS NOT OPTIONAL, AND ITS FAILURE MUST NOT BE SWALLOWED.
    //
    // It ended in `.catch(() => {})`. This row is the only record a GUEST payment has — there is no
    // account behind it — and it is what the confirmation path reads to unlock the test. Without it
    // the person paid, the test stayed locked, and nobody could find the payment by name, e-mail or
    // order to put it right. Refusing costs an unused order at the gateway, which charges nobody.
    try {
      await db.execute(sql`
        INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, contact, notes)
        VALUES (${result.order.id}, ${fx.paise}, 'INR', 'created', 'test_enrollment', 'test', ${test.id}, NULL, ${email}, ${ph.e164},
          ${sql.raw("'" + JSON.stringify({ receipt, guest: true, testSlug: test.slug, name }).replace(/'/g, "''") + "'::jsonb")})
      `);
    } catch (e: any) {
      console.error('[tests/guest-start] order', result.order.id, 'could not be recorded for', email, 'test', test.id,
        '-', e?.cause?.message || e?.message);
      return json({ ok: false, error: 'We could not open checkout just now, so nothing was charged. Try again in a moment.' }, 500);
    }
    return json({ ok: true, paid: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise: fx.paise, currency: 'INR', testTitle: test.title, testSlug: test.slug, prefill: { name, email, contact: ph.e164 } });
  } catch (e: any) {
    // `.message` on a drizzle/postgres-js error is only the SQL that failed; the reason is on
    // `.cause` and belongs in the log rather than in a stranger's browser.
    console.error('[tests/guest-start]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not start that just now, so nothing was charged. Try again in a moment.' }, 500);
  }
};
