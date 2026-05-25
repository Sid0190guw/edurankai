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
      SELECT id, slug, title, is_premium, price_inr_paise, currency
      FROM tests WHERE slug = ${testSlug} AND is_published = true LIMIT 1
    `);
    const tRows = Array.isArray(t) ? t : (t?.rows || []);
    if (tRows.length === 0) return json({ ok: false, error: 'Test not found' }, 404);
    const test = tRows[0] as any;

    const treatAsFree = !test.is_premium || (test.price_inr_paise || 0) < 100;
    const runUrl = '/aquintutor/test/' + test.slug + '/run';

    if (treatAsFree) {
      return json({ ok: true, paid: false, redirect: runUrl });
    }

    // Admin override: admin/super_admin/staff can access premium tests without paying
    // (for review, moderation, and management). Audit on the payments table.
    const isAdmin = user.role && ['admin','super_admin','editor','reviewer'].includes(user.role);
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

    // Display currency may be CHF / USD / EUR etc; Razorpay India settles in
    // INR, so we convert at the live ECB rate (frankfurter.app), cached 1h.
    const displayCurrency = (test.currency || 'INR').toUpperCase();
    const displayAmountMinor = Math.max(1, parseInt(test.price_inr_paise || 100));
    const fx = await convertToInrPaise(displayCurrency, displayAmountMinor);
    const amountPaise = fx.paise;
    const receipt = 'qt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

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
        fxRate: fx.rate.toString(),
        fxDate: fx.date,
      },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);

    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, notes
      ) VALUES (
        ${result.order.id}, ${amountPaise}, 'INR', 'created', 'test_enrollment',
        'test', ${test.id}, ${user.id}, ${user.email || 'unknown@edurankai.in'},
        ${sql.raw("'" + JSON.stringify({ receipt, testSlug: test.slug, displayCurrency, displayAmountMinor, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live }).replace(/'/g, "''") + "'::jsonb")}
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
      fxRate: fx.rate,
      fxDate: fx.date,
      testTitle: test.title,
      testSlug: test.slug,
      prefill: { name: user.name || '', email: user.email || '' },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
