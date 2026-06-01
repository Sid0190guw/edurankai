// POST /api/payments/start-application-fee
// Body: { applicationId }
// Loads the signed-in applicant's own application, computes the processing &
// verification fee AUTHORITATIVELY from the role level (client cannot tamper),
// converts CHF -> INR paise at the live rate, creates a Razorpay order and a
// payments row, and returns the checkout payload.
//
// If the fee is already paid, returns { ok, alreadyPaid:true, redirect }.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';
import { resolveApplicationFeeChf } from '@/lib/application-fee';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in.', loginUrl: '/portal/login' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const appId = (body?.applicationId || '').toString().trim();
  const intentId = (body?.intentId || '').toString().trim();
  if (!appId && !intentId) return json({ ok: false, error: 'applicationId or intentId required' }, 400);

  try {
    // Intent path: pre-payment, no applications row exists yet. Look up the
    // intent + role fee, create the order, and stash intentId in the notes
    // so payment-effects can materialise the application after capture.
    if (intentId && !appId) {
      const intentRows = await db.execute(sql`
        SELECT i.id, i.role_id, i.level, i.email, i.first_name, i.last_name, i.role_title_snapshot,
               r.application_fee_amount AS role_fee
        FROM application_intents i
        LEFT JOIN roles r ON i.role_id = r.id
        WHERE i.id = ${intentId} AND i.user_id = ${user.id}
        LIMIT 1
      `);
      const intentRow = (Array.isArray(intentRows) ? intentRows : (intentRows?.rows || []))[0] as any;
      if (!intentRow) return json({ ok: false, error: 'Application intent not found' }, 404);
      if (!isConfigured()) return json({ ok: false, error: 'Payments not yet configured.' }, 503);

      const feeChf = resolveApplicationFeeChf({ roleFee: intentRow.role_fee, level: intentRow.level });
      const fx = await convertToInrPaise('CHF', feeChf * 100);
      const amountPaise = fx.paise;
      const receipt = 'appint_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

      const result = await createOrder({
        amountPaise, currency: 'INR', receipt,
        notes: {
          purpose: 'application_fee_intent',
          intentId: intentRow.id, userId: user.id,
          email: intentRow.email || user.email || '',
          feeChf: feeChf.toString(), fxRate: fx.rate.toString(), fxDate: fx.date,
        },
      });
      if (!result.ok) return json({ ok: false, error: result.error }, 502);

      await db.execute(sql`
        INSERT INTO payments (
          order_id, amount_paise, currency, status, purpose,
          reference_type, reference_id, user_id, email, notes
        ) VALUES (
          ${result.order.id}, ${amountPaise}, 'INR', 'created', 'application_fee_intent',
          'application_intent', ${intentRow.id}, ${user.id}, ${intentRow.email || user.email || 'unknown@edurankai.in'},
          ${sql.raw("'" + JSON.stringify({ receipt, intentId: intentRow.id, feeChf, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live }).replace(/'/g, "''") + "'::jsonb")}
        )
      `).catch(() => {});

      const candidateName = ((intentRow.first_name || '') + ' ' + (intentRow.last_name || '')).trim();
      return json({
        ok: true, orderId: result.order.id, keyId: getPublicKeyId(),
        amountPaise, currency: 'INR', feeChf, fxRate: fx.rate, fxDate: fx.date,
        roleTitle: intentRow.role_title_snapshot || '',
        prefill: { name: candidateName, email: intentRow.email || user.email || '' },
      });
    }

    const a = await db.execute(sql`
      SELECT a.id, a.level, a.fee_paid, a.first_name, a.last_name, a.email,
             a.role_title_snapshot,
             r.application_fee_amount AS role_fee, r.application_fee_currency AS role_fee_ccy
      FROM applications a
      LEFT JOIN roles r ON a.role_id = r.id
      WHERE a.id = ${appId} AND a.applicant_user_id = ${user.id}
      LIMIT 1
    `);
    const aRows = Array.isArray(a) ? a : (a?.rows || []);
    if (aRows.length === 0) return json({ ok: false, error: 'Application not found' }, 404);
    const app = aRows[0] as any;

    const confirmUrl = '/apply/confirmation?id=' + app.id;
    if (app.fee_paid) {
      return json({ ok: true, alreadyPaid: true, redirect: confirmUrl });
    }

    if (!isConfigured()) {
      return json({ ok: false, error: 'Payments not yet configured. Contact hr@edurankai.in.' }, 503);
    }

    // Authoritative fee: per-role amount (CHF) if set on the seeded role,
    // otherwise the level-tiered fallback. Currency is always treated as CHF
    // even if a different one is stored, until we add multi-currency settle.
    const feeChf = resolveApplicationFeeChf({ roleFee: app.role_fee, level: app.level });
    const fx = await convertToInrPaise('CHF', feeChf * 100);
    const amountPaise = fx.paise;
    const receipt = 'appfee_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    const result = await createOrder({
      amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        purpose: 'application_fee',
        applicationId: app.id,
        userId: user.id,
        email: app.email || user.email || '',
        feeChf: feeChf.toString(),
        fxRate: fx.rate.toString(),
        fxDate: fx.date,
      },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);

    // Record the chosen fee on the application so verify.ts / admin can see it.
    await db.execute(sql`UPDATE applications SET fee_chf = ${feeChf} WHERE id = ${app.id}`).catch(() => {});

    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, notes
      ) VALUES (
        ${result.order.id}, ${amountPaise}, 'INR', 'created', 'application_fee',
        'application', ${app.id}, ${user.id}, ${app.email || user.email || 'unknown@edurankai.in'},
        ${sql.raw("'" + JSON.stringify({ receipt, applicationId: app.id, feeChf, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live }).replace(/'/g, "''") + "'::jsonb")}
      )
    `).catch(() => {});

    const candidateName = ((app.first_name || '') + ' ' + (app.last_name || '')).trim();
    return json({
      ok: true,
      orderId: result.order.id,
      keyId: getPublicKeyId(),
      amountPaise,
      currency: 'INR',
      feeChf,
      fxRate: fx.rate,
      fxDate: fx.date,
      roleTitle: app.role_title_snapshot || '',
      prefill: { name: candidateName, email: app.email || user.email || '' },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
