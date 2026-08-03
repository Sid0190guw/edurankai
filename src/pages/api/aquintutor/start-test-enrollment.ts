// POST /api/aquintutor/start-test-enrollment
// Body: { testSlug }
// - If test is free (or already paid): { ok, paid:false, redirect:'/aquintutor/test/<slug>/run' }
// - If test is premium and unpaid: returns Razorpay order + key for browser checkout.
//   On success, browser calls /api/aquintutor/confirm-test-payment which records the
//   payment as 'paid'. Paid access is then read from the payments table by the test page.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in to start this test.', loginUrl: '/portal/login' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const testSlug = (body?.testSlug || '').toString().trim();
  if (!testSlug) return json({ ok: false, error: 'testSlug required' }, 400);

  try {
    const t = await db.execute(sql`
      SELECT id, slug, title, is_premium, price_inr_paise, price_chf, currency
      FROM tests WHERE slug = ${testSlug} AND is_published = true LIMIT 1
    `);
    const tRows = Array.isArray(t) ? t : (t?.rows || []);
    if (tRows.length === 0) return json({ ok: false, error: 'Test not found' }, 404);
    const test = tRows[0] as any;

    // Free criteria — any one of these is enough:
    //   is_premium=false, price_chf=0, or price_inr_paise<100 (legacy)
    const priceChf = Number(test.price_chf || 0);
    const treatAsFree = !test.is_premium
      || priceChf <= 0 && (test.price_inr_paise || 0) < 100;
    const runUrl = '/aquintutor/test/' + test.slug + '/run';

    if (treatAsFree) {
      return json({ ok: true, paid: false, redirect: runUrl });
    }

    // Paid-test override, for reviewing and moderating a premium test without buying it.
    //
    // WAS: ['admin','super_admin','editor','reviewer'].includes(user.role).
    // Two defects. 'admin' is not a value in userRoleEnum (src/lib/db/schema.ts), so that arm was
    // dead and misleading. And 'editor' is the role the offer-signing defect handed to EVERY intern
    // who accepted an offer — so every intern could take any paid test for free, on an endpoint
    // that /api/ exempts from the middleware gate entirely.
    //
    // Now asks for the ability to manage test content, which is what a reviewer of a premium test
    // actually needs. This narrows access: 'editor' holds content.edit and keeps the override, but
    // it is now recorded as a capability rather than a role name, and a custom role can be granted
    // it deliberately. Reviewer loses it — it was never on the console they use, and taking a paid
    // test for free is not part of scoring an application.
    const { can } = await import('@/lib/auth/permissions');
    const isAdmin = can(user as any, 'content.edit');
    if (isAdmin) {
      return json({ ok: true, paid: false, adminOverride: true, redirect: runUrl });
    }

    // Premium: check if user has already paid
    const p = await db.execute(sql`
      SELECT id FROM payments
      WHERE user_id = ${user.id} AND reference_type = 'test' AND reference_id = ${test.id}
        AND status = 'paid'
      LIMIT 1
    `);
    const pRows = Array.isArray(p) ? p : (p?.rows || []);
    if (pRows.length > 0) {
      return json({ ok: true, paid: false, alreadyPaid: true, redirect: runUrl });
    }

    if (!isConfigured()) {
      return json({ ok: false, error: 'Payments not yet configured. Contact hr@edurankai.in to enrol.' }, 503);
    }

    // CRITICAL: price_chf is the canonical price (set by every test seed at
    // 1 CHF). The legacy price_inr_paise=100 column was being used as a
    // standalone INR amount, which was charging 1 INR for a test that should
    // cost ~108 INR (1 CHF) — losing ~99% of revenue. We now prefer price_chf
    // and only fall back to price_inr_paise if price_chf is 0.
    let amountPaise: number;
    let displayCurrency = 'INR';
    let displayAmountMinor: number;
    let fxRate: number | null = null;
    let fxDate: string | null = null;
    let fxLive: boolean | null = null;
    if (priceChf > 0) {
      // 1 CHF = 100 centimes — convertToInrPaise expects MINOR units
      const fx = await convertToInrPaise('CHF', Math.round(priceChf * 100));
      amountPaise = fx.paise;
      displayCurrency = 'CHF';
      displayAmountMinor = Math.round(priceChf * 100);
      fxRate = fx.rate;
      fxDate = fx.date;
      fxLive = fx.live;
    } else {
      amountPaise = Math.max(1, parseInt(test.price_inr_paise || 100));
      displayAmountMinor = amountPaise;
    }

    // FAIL LOUDLY ON AN ABSURD PRICE. price_inr_paise is in PAISE, and a test configured with 120
    // meaning "Rs 120" charges Rs 1.20 — which is exactly what happened to the Quantum Science & ASI
    // bootcamp. The old floor was Math.max(1, ...), i.e. one paise, so any unit mistake sailed
    // through and took real money at ~1% of the intended price. Refusing is strictly better than
    // charging a nonsense amount: a failed checkout is a support message, whereas a wrong charge is
    // a refund, a reconciliation problem, and a candidate who believes they have paid.
    const MIN_SANE_PAISE = 1000;   // Rs 10 — below this a paid test is misconfigured, not cheap
    if (amountPaise > 0 && amountPaise < MIN_SANE_PAISE) {
      console.error('[start-test-enrollment] refusing absurd price', {
        testId: test.id, slug: test.slug, amountPaise, priceChf, price_inr_paise: test.price_inr_paise,
      });
      return json({
        ok: false,
        error: 'This test is not correctly priced yet, so we have not taken any payment. Please write to hr@edurankai.in and we will sort it out.',
      }, 409);
    }
    const receipt = 'qt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    // Universal account credit: pay the test fee from the wallet if it covers it.
    {
      const { coverWithCredit } = await import('@/lib/account-credit');
      const cov = await coverWithCredit({ userId: user.id, amountPaise, purpose: 'test_enrollment', referenceType: 'test', referenceId: test.id, email: user.email || '', label: 'Test: ' + (test.title || test.slug || '') });
      if (cov.covered) return json({ ok: true, paid: true, paidWithCredit: true, redirect: runUrl });
    }

    const result = await createOrder({
      amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        purpose: 'test_enrollment',
        testSlug: test.slug,
        userId: user.id,
        email: user.email || '',
        displayCurrency,
        displayAmountMinor: displayAmountMinor.toString(),
        ...(fxRate != null ? { fxRate: fxRate.toString(), fxDate: fxDate || '' } : {}),
      },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);

    const notesJson = JSON.stringify({ receipt, testSlug: test.slug, displayCurrency, displayAmountMinor, fxRate, fxDate, fxLive });
    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, notes
      ) VALUES (
        ${result.order.id}, ${amountPaise}, 'INR', 'created', 'test_enrollment',
        'test', ${test.id}, ${user.id}, ${user.email || 'unknown@edurankai.in'},
        ${notesJson}::jsonb
      )
    `).catch(() => {});

    return json({
      ok: true,
      paid: true,
      orderId: result.order.id,
      keyId: getPublicKeyId(),
      amountPaise,
      currency: 'INR',
      displayCurrency,
      displayAmountMinor,
      fxRate, fxDate,
      testTitle: test.title,
      testSlug: test.slug,
      prefill: { name: user.name || '', email: user.email || '' },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
