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
import { computeCheckout, breakdownForNotes } from '@/lib/checkout-summary';

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
               r.application_fee_amount AS role_fee, r.engagement_type AS role_engagement
        FROM application_intents i
        LEFT JOIN roles r ON i.role_id = r.id
        WHERE i.id = ${intentId} AND i.user_id = ${user.id}
        LIMIT 1
      `);
      const intentRow = (Array.isArray(intentRows) ? intentRows : (intentRows?.rows || []))[0] as any;
      if (!intentRow) return json({ ok: false, error: 'Application intent not found' }, 404);

      // FEE-FREE SHORT-CIRCUIT. Applications carry no fee (see application-fee.ts), so never try
      // to open a ₹0 gateway order — Razorpay rejects amounts under ₹1, which would strand the
      // applicant. Materialise the application as free and send them to confirmation. This also
      // covers any stale/cached pay page that still POSTs here after the fee was removed.
      if (resolveApplicationFeeChf({ roleFee: intentRow.role_fee, level: intentRow.level, engagementType: intentRow.role_engagement }) <= 0) {
        try {
          const { materialiseFromIntent } = await import('@/lib/fee-waiver');
          const newId = await materialiseFromIntent(intentRow.id, { paid: false, waiverGranted: true, waiverReason: 'No application fee (applications are free).' });
          if (newId) return json({ ok: true, alreadyPaid: true, free: true, redirect: '/apply/confirmation?id=' + newId });
        } catch (_) {}
        return json({ ok: true, alreadyPaid: true, free: true, redirect: '/portal' });
      }

      // IDEMPOTENCY (prevents the double-charge): if this intent already has a
      // captured payment, do NOT create a new order. Re-run the materialisation
      // (in case it failed the first time) and send the applicant to their
      // confirmation instead of charging again.
      const rowsOf = (r: any) => (Array.isArray(r) ? r : (r?.rows || []));
      const priorPaid = rowsOf(await db.execute(sql`
        SELECT order_id, razorpay_payment_id FROM payments
        WHERE reference_id = ${intentRow.id} AND status IN ('paid','captured','authorized')
        ORDER BY updated_at DESC LIMIT 1
      `).catch(() => []))[0] as any;
      if (priorPaid) {
        let appId2: string | undefined;
        try {
          const { applyPaidEffects } = await import('@/lib/payment-effects');
          const r2 = await applyPaidEffects(priorPaid.order_id, priorPaid.razorpay_payment_id || null);
          appId2 = (r2 && (r2 as any).applicationId) || undefined;
        } catch (_) {}
        if (!appId2) {
          const a2 = rowsOf(await db.execute(sql`SELECT id FROM applications WHERE applicant_user_id = ${user.id} ORDER BY created_at DESC LIMIT 1`).catch(() => []))[0] as any;
          appId2 = a2?.id;
        }
        return json({ ok: true, alreadyPaid: true, redirect: appId2 ? '/apply/confirmation?id=' + appId2 : '/portal' });
      }

      // Webhook-independent double-charge guard: an earlier order for this intent
      // may have been CAPTURED at Razorpay without us recording it (tab closed
      // before /verify, webhook off). Reconcile those against Razorpay BEFORE
      // creating a new order; if one already captured, settle it and send the
      // applicant to confirmation instead of charging a second time.
      const priorOrders = rowsOf(await db.execute(sql`
        SELECT order_id FROM payments
        WHERE reference_id = ${intentRow.id} AND status IN ('created','attempted','authorized') AND order_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 5
      `).catch(() => []));
      for (const po of priorOrders) {
        try {
          const { reconcileOrder } = await import('@/lib/payment-effects');
          const rec = await reconcileOrder((po as any).order_id);
          if (rec.reconciled) {
            let appId3 = rec.applicationId;
            if (!appId3) {
              const a3 = rowsOf(await db.execute(sql`SELECT id FROM applications WHERE applicant_user_id = ${user.id} ORDER BY created_at DESC LIMIT 1`).catch(() => []))[0] as any;
              appId3 = a3?.id;
            }
            return json({ ok: true, alreadyPaid: true, redirect: appId3 ? '/apply/confirmation?id=' + appId3 : '/portal' });
          }
        } catch (_) {}
      }

      // Holistic amount: base fee minus any active admin offer. Computed once
      // here and reused for both the wallet-cover path and the card order.
      const co = await computeCheckout({ roleFee: intentRow.role_fee, level: intentRow.level, engagementType: intentRow.role_engagement });

      // Universal account credit: if the applicant's wallet covers the (net)
      // fee, pay from credit (works even if card payments aren't configured).
      {
        const { coverWithCredit } = await import('@/lib/account-credit');
        const cov = await coverWithCredit({ userId: user.id, amountPaise: co.netInrPaise, purpose: 'application_fee_intent', referenceType: 'application_intent', referenceId: intentRow.id, email: intentRow.email || user.email || '', label: 'Application fee' });
        if (cov.covered) {
          let appIdC = cov.applicationId;
          if (!appIdC) { const aC = rowsOf(await db.execute(sql`SELECT id FROM applications WHERE applicant_user_id = ${user.id} ORDER BY created_at DESC LIMIT 1`).catch(() => []))[0] as any; appIdC = aC?.id; }
          return json({ ok: true, alreadyPaid: true, paidWithCredit: true, redirect: appIdC ? '/apply/confirmation?id=' + appIdC : '/portal' });
        }
      }

      if (!isConfigured()) return json({ ok: false, error: 'Payments not yet configured.' }, 503);

      const feeChf = co.baseChf;
      const amountPaise = co.netInrPaise;
      const receipt = 'appint_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const bd = breakdownForNotes(co);

      const result = await createOrder({
        amountPaise, currency: 'INR', receipt,
        notes: {
          purpose: 'application_fee_intent',
          intentId: intentRow.id, userId: user.id,
          email: intentRow.email || user.email || '',
          feeChf: feeChf.toString(), fxRate: co.fxRate.toString(), fxDate: co.fxDate,
        },
      });
      if (!result.ok) return json({ ok: false, error: result.error }, 502);

      // THE PAYMENTS ROW IS NOT OPTIONAL, AND ITS FAILURE MUST NOT BE SWALLOWED.
      //
      // It ended in `.catch(() => {})`. This row is the ONLY link between the money and the intent:
      // applyPaidEffects() materialises the application from `payments.reference_id`, and
      // reconcilePending() finds stranded payers by scanning `payments` for reference_type
      // 'application_intent'. Without the row the applicant pays the fee and NO application is ever
      // created — the exact "paid but lost application" that machinery exists to prevent — with
      // nothing for the backstop to find and nothing to refund against.
      //
      // Refusing costs an unused order at the gateway, which expires on its own and charges nobody.
      try {
        await db.execute(sql`
          INSERT INTO payments (
            order_id, amount_paise, currency, status, purpose,
            reference_type, reference_id, user_id, email, notes
          ) VALUES (
            ${result.order.id}, ${amountPaise}, 'INR', 'created', 'application_fee_intent',
            'application_intent', ${intentRow.id}, ${user.id}, ${intentRow.email || user.email || 'unknown@edurankai.in'},
            ${sql.raw("'" + JSON.stringify({ receipt, intentId: intentRow.id, feeChf, fxRate: co.fxRate, fxDate: co.fxDate, fxLive: co.fxLive, breakdown: bd }).replace(/'/g, "''") + "'::jsonb")}
          )
        `);
      } catch (e: any) {
        console.error('[payments] application-fee order', result.order.id, 'could not be recorded for intent', intentRow.id,
          '-', e?.cause?.message || e?.message);
        return json({ ok: false, error: 'We could not open checkout just now, so nothing was charged. Try again in a moment.' }, 500);
      }

      const candidateName = ((intentRow.first_name || '') + ' ' + (intentRow.last_name || '')).trim();
      return json({
        ok: true, orderId: result.order.id, keyId: getPublicKeyId(),
        amountPaise, currency: 'INR', feeChf, fxRate: co.fxRate, fxDate: co.fxDate,
        roleTitle: intentRow.role_title_snapshot || '',
        prefill: { name: candidateName, email: intentRow.email || user.email || '' },
      });
    }

    const a = await db.execute(sql`
      SELECT a.id, a.level, a.fee_paid, a.first_name, a.last_name, a.email,
             a.role_title_snapshot,
             r.application_fee_amount AS role_fee, r.application_fee_currency AS role_fee_ccy,
             r.engagement_type AS role_engagement
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

    // FEE-FREE SHORT-CIRCUIT (see the intent branch above and application-fee.ts): applications
    // are free, so mark this one settled and confirm it rather than opening a ₹0 gateway order.
    if (resolveApplicationFeeChf({ roleFee: app.role_fee, level: app.level, engagementType: app.role_engagement }) <= 0) {
      await db.execute(sql`UPDATE applications SET fee_paid = true, updated_at = NOW() WHERE id = ${app.id}`).catch(() => {});
      return json({ ok: true, alreadyPaid: true, free: true, redirect: confirmUrl });
    }

    // Webhook-independent double-charge guard for the direct app-fee path: settle
    // any already-captured order for this application before charging again.
    {
      const rowsOf2 = (r: any) => (Array.isArray(r) ? r : (r?.rows || []));
      const priorOrders = rowsOf2(await db.execute(sql`
        SELECT order_id FROM payments
        WHERE reference_id = ${app.id} AND status IN ('created','attempted','authorized') AND order_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 5
      `).catch(() => []));
      for (const po of priorOrders) {
        try {
          const { reconcileOrder } = await import('@/lib/payment-effects');
          const rec = await reconcileOrder((po as any).order_id);
          if (rec.reconciled) return json({ ok: true, alreadyPaid: true, redirect: confirmUrl });
        } catch (_) {}
      }
    }

    // Universal account credit: cover the fee from the applicant's wallet if it
    // is enough (no card charge, works even if Razorpay isn't configured).
    {
      const feeChfC = resolveApplicationFeeChf({ roleFee: app.role_fee, level: app.level, engagementType: app.role_engagement });
      const fxC = await convertToInrPaise('CHF', feeChfC * 100);
      const { coverWithCredit } = await import('@/lib/account-credit');
      const cov = await coverWithCredit({ userId: user.id, amountPaise: fxC.paise, purpose: 'application_fee', referenceType: 'application', referenceId: app.id, email: app.email || user.email || '', label: 'Application fee' });
      if (cov.covered) return json({ ok: true, alreadyPaid: true, paidWithCredit: true, redirect: confirmUrl });
    }

    if (!isConfigured()) {
      return json({ ok: false, error: 'Payments not yet configured. Contact hr@edurankai.in.' }, 503);
    }

    // Authoritative fee: per-role amount (CHF) if set on the seeded role,
    // otherwise the level-tiered fallback. Currency is always treated as CHF
    // even if a different one is stored, until we add multi-currency settle.
    const feeChf = resolveApplicationFeeChf({ roleFee: app.role_fee, level: app.level, engagementType: app.role_engagement });
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

    // Record the chosen fee on the application so verify.ts / admin can see it. Not fatal — the fee is
    // also in the payments row and in the order's notes — but the reason belongs in the log rather
    // than on the floor.
    await db.execute(sql`UPDATE applications SET fee_chf = ${feeChf} WHERE id = ${app.id}`)
      .catch((e: any) => console.error('[payments] could not stamp fee_chf on application', app.id, '-', e?.cause?.message || e?.message));

    // THE PAYMENTS ROW IS NOT OPTIONAL, AND ITS FAILURE MUST NOT BE SWALLOWED. applyPaidEffects()
    // reads the order out of `payments` and returns IMMEDIATELY when there is none, so a failed
    // insert here meant the applicant paid the processing fee and the application never joined the
    // live queue — invisible to every admin, with no row for reconcile or a refund to work from.
    try {
      await db.execute(sql`
        INSERT INTO payments (
          order_id, amount_paise, currency, status, purpose,
          reference_type, reference_id, user_id, email, notes
        ) VALUES (
          ${result.order.id}, ${amountPaise}, 'INR', 'created', 'application_fee',
          'application', ${app.id}, ${user.id}, ${app.email || user.email || 'unknown@edurankai.in'},
          ${sql.raw("'" + JSON.stringify({ receipt, applicationId: app.id, feeChf, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live }).replace(/'/g, "''") + "'::jsonb")}
        )
      `);
    } catch (e: any) {
      console.error('[payments] application-fee order', result.order.id, 'could not be recorded for application', app.id,
        '-', e?.cause?.message || e?.message);
      return json({ ok: false, error: 'We could not open checkout just now, so nothing was charged. Try again in a moment.' }, 500);
    }

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
    // e.message on a postgres-js/drizzle error is the FAILED SQL — table and column names handed to
    // whoever posted, and nothing they can act on. The real reason is on e.cause and belongs in the
    // log: a checkout that never opened left no trace for anyone asked why the applicant could not pay.
    console.error('[payments/start-application-fee]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not open checkout just now, so nothing was charged. Try again in a moment.' }, 500);
  }
};
