// SAMARTH payments, built on the platform's existing, hardened payment path rather than beside it.
//
//   order        created here: the AMOUNT IS READ FROM THE DATABASE (the applicant's accepted fee
//                snapshot, or the accepted quotation), never from the request, and recorded in the
//                shared `payments` table with purpose samarth_booking_fee or samarth_engagement.
//   verification /api/payments/verify (HMAC + a server-side fetch from the gateway) and the signed
//                webhook /api/payments/webhook. A browser redirect never marks anything paid.
//   effect       applyPaidEffects() in src/lib/payment-effects.ts calls applySamarthPaid() below,
//                from whichever of verify, webhook or reconcile lands first. Idempotent.
//   refunds      /api/admin/payments/refund and the refund webhook, unchanged; the SAMARTH screens
//                read the payment row's live status, so a refund shows there too.
//   receipts     /receipt/<order>; invoices through src/lib/invoices.ts (raiseInvoice below).
//
// CURRENCY. Fees and quotations are priced and shown in the applicant's currency. The gateway is
// charged the INR equivalent at the live reference rate at the moment the order is created, and the
// applicant sees that rate and that figure before paying. A rate that is not live is refused for a
// non-INR charge: guessing an exchange rate on somebody's payment is not acceptable.
//
// CHECKOUT IS OFF UNTIL SOMEONE TURNS IT ON. Two feature flags (samarthFeeCheckout,
// samarthEngagementCheckout) gate online payment; until then payment is against an invoice and
// recorded by staff. Turn them on after a sandbox (Razorpay test-key) payment has gone through.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { fxRateToInr } from '@/lib/fx';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { toSettlementPaise, formatMoney, currencyDef } from '@/lib/samarth/currency';
import { getFee } from '@/lib/samarth/fees';
import { markFeePaidByGateway, setApplicationInvoice, type Application } from '@/lib/samarth/applications';
import { markEngagementPaidByGateway, setEngagementInvoice, engagementBreakdown, type Engagement } from '@/lib/samarth/engagements';
import { emailFeePaid, emailUpdate, alertAdmins, workspaceUrl } from '@/lib/samarth/notify';
import { rows, str, num, isUuid, json, addEvent, type ActorRef } from '@/lib/samarth/store-core';

export const PURPOSE_FEE = 'samarth_booking_fee';
export const PURPOSE_ENGAGEMENT = 'samarth_engagement';
export const REF_TYPE_APPLICATION = 'samarth_application';
export const REF_TYPE_ENGAGEMENT = 'samarth_engagement';

/** 'test' for a Razorpay test key, 'live' for a live key, null when no key is configured. */
export function gatewayKeyMode(): 'test' | 'live' | null {
  const k = getPublicKeyId() || '';
  if (!k) return null;
  return k.startsWith('rzp_test_') ? 'test' : 'live';
}

export interface Readiness {
  gatewayConnected: boolean;
  keyMode: 'test' | 'live' | null;
  webhookSecret: boolean;
  feeCheckoutOn: boolean;
  engagementCheckoutOn: boolean;
  /** At least one SAMARTH payment captured with a TEST key. */
  sandboxTested: boolean;
  /** At least one SAMARTH payment captured with a LIVE key. */
  productionVerified: boolean;
  mailConfigured: boolean;
}

/** Connected, sandbox-tested and production-verified are three different facts and are reported apart. */
export async function readiness(): Promise<Readiness> {
  let sandboxTested = false, productionVerified = false;
  try {
    const r = rows(await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE notes->>'keyMode' = 'test')::int AS t, COUNT(*) FILTER (WHERE notes->>'keyMode' = 'live')::int AS l
        FROM payments WHERE purpose IN (${PURPOSE_FEE}, ${PURPOSE_ENGAGEMENT}) AND status = 'paid'`))[0];
    sandboxTested = (num(r?.t) || 0) > 0;
    productionVerified = (num(r?.l) || 0) > 0;
  } catch (e: any) {
    console.error('[samarth/payments] readiness read failed:', String(e?.cause?.message || e?.message || e));
  }
  let mailConfigured = false;
  try { const { getMailConfig } = await import('@/lib/mail'); const c: any = await getMailConfig(); mailConfigured = !!(c && (c.smtpHost || c.host) && c.fromAddress); } catch { mailConfigured = false; }
  return {
    gatewayConnected: isConfigured(),
    keyMode: gatewayKeyMode(),
    webhookSecret: !!process.env.RAZORPAY_WEBHOOK_SECRET,
    feeCheckoutOn: await isFeatureEnabled('samarthFeeCheckout'),
    engagementCheckoutOn: await isFeatureEnabled('samarthEngagementCheckout'),
    sandboxTested,
    productionVerified,
    mailConfigured,
  };
}

export interface CheckoutOrder {
  ok: true;
  orderId: string;
  keyId: string | null;
  amountPaise: number;
  currency: 'INR';
  displayAmount: string;
  fxRate: number;
  fxDate: string;
  name: string;
  email: string;
  description: string;
}
export type CheckoutResult = CheckoutOrder | { ok: false; error: string; status: number; alreadyPaid?: boolean };

async function conversion(totalMinor: number, currency: string): Promise<{ paise: number; rate: number; date: string } | { error: string }> {
  if (!currencyDef(currency)) return { error: 'That currency is not supported for payment.' };
  if (currency === 'INR') return { paise: Math.round(totalMinor), rate: 1, date: new Date().toISOString().slice(0, 10) };
  const fx = await fxRateToInr(currency);
  if (!fx.live) return { error: 'The exchange rate for ' + currency + ' cannot be fetched right now, so nothing can be charged. Try again in a few minutes, or ask for an invoice instead.' };
  const paise = toSettlementPaise(totalMinor, currency, fx.rate);
  if (!paise) return { error: 'That amount cannot be charged.' };
  return { paise, rate: fx.rate, date: fx.date };
}

async function paymentRowStatus(orderId: string): Promise<string> {
  if (!orderId) return '';
  return str(rows(await db.execute(sql`SELECT status FROM payments WHERE order_id = ${orderId} LIMIT 1`))[0]?.status);
}

/** Whether a payment against this order may already have gone through (paid, or captured but unrecorded). */
export async function paymentMayBeCaptured(orderId: string): Promise<boolean> {
  if (!orderId) return false;
  const s = await paymentRowStatus(orderId).catch(() => 'unknown');
  if (s === 'paid' || s === 'unknown' || s === 'attempted') return true;
  try {
    const { reconcileOrder } = await import('@/lib/payment-effects');
    const r = await reconcileOrder(orderId);
    return r.reconciled;
  } catch { return true; }
}

async function insertPaymentRow(o: { orderId: string; paise: number; purpose: string; refType: string; refId: string; email: string; phone: string; notes: Record<string, unknown> }): Promise<void> {
  await db.execute(sql`
    INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, contact, notes)
    VALUES (${o.orderId}, ${o.paise}, 'INR', 'created', ${o.purpose}, ${o.refType}, ${o.refId}, NULL, ${o.email}, ${o.phone || null}, ${json(o.notes)}::jsonb)`);
}

/** Online payment of the consultation booking fee. */
export async function startFeeCheckout(a: Application): Promise<CheckoutResult> {
  if (!(await isFeatureEnabled('samarthFeeCheckout'))) return { ok: false, status: 409, error: 'Online payment is not open yet. Choose payment against an invoice, and the SAMARTH team will send it to you.' };
  if (!isConfigured()) return { ok: false, status: 503, error: 'Online payment is not configured on this server, so nothing can be charged. Choose payment against an invoice instead.' };
  if (a.status === 'FEE_PAID' || a.paidAt) return { ok: false, status: 409, error: 'This booking fee is already paid.', alreadyPaid: true };
  if (a.status !== 'FEE_PENDING' || !a.feeSnapshot || !a.feeTotalMinor) return { ok: false, status: 409, error: 'Accept the booking fee and its terms first.' };
  if (a.feeSnapshot.method !== 'online') return { ok: false, status: 409, error: 'You chose to pay against an invoice. Change the payment method first.' };

  // The accepted snapshot is honoured only while its fee is still the published one.
  const fee = a.feeScheduleId ? await getFee(a.feeScheduleId) : null;
  if (!fee || fee.status !== 'approved') return { ok: false, status: 409, error: 'The booking fee was revised after you accepted it. Review the current fee and accept it again.' };

  // An earlier order that may already have been paid is settled before anything new is charged.
  if (a.paymentOrderId) {
    if (await paymentMayBeCaptured(a.paymentOrderId)) {
      return { ok: false, status: 409, alreadyPaid: true, error: 'A payment for this fee may already have gone through. Reload this page in a minute; do not pay again.' };
    }
  }

  const conv = await conversion(a.feeTotalMinor, a.feeSnapshot.currency);
  if ('error' in conv) return { ok: false, status: 503, error: conv.error };
  const receipt = 'samf_' + a.ref.slice(-8).toLowerCase() + '_' + Date.now().toString(36);
  const keyMode = gatewayKeyMode();
  const order = await createOrder({ amountPaise: conv.paise, currency: 'INR', receipt, notes: { purpose: PURPOSE_FEE, ref: a.ref, currency: a.feeSnapshot.currency, totalMinor: String(a.feeTotalMinor), fxRate: String(conv.rate) } });
  if (!order.ok) return { ok: false, status: 502, error: 'The payment provider did not accept the order, so nothing was charged. Try again in a moment.' };
  try {
    await insertPaymentRow({
      orderId: order.order.id, paise: conv.paise, purpose: PURPOSE_FEE, refType: REF_TYPE_APPLICATION, refId: a.id, email: a.contactEmail, phone: a.contactPhone,
      notes: { ref: a.ref, receipt, priced: { currency: a.feeSnapshot.currency, totalMinor: a.feeTotalMinor }, fxRate: conv.rate, fxDate: conv.date, keyMode, feeId: a.feeScheduleId },
    });
    await db.execute(sql`UPDATE samarth_applications SET payment_order_id = ${order.order.id}, charged_inr_paise = ${conv.paise}, fx_rate = ${conv.rate}, fx_date = ${conv.date}, updated_at = NOW() WHERE id = ${a.id}::uuid AND status = 'FEE_PENDING'`);
  } catch (e: any) {
    console.error('[samarth/payments] fee order', order.order.id, 'could not be recorded for', a.ref, '-', String(e?.cause?.message || e?.message));
    return { ok: false, status: 500, error: 'Checkout could not be opened just now, so nothing was charged. Try again in a moment.' };
  }
  return {
    ok: true, orderId: order.order.id, keyId: getPublicKeyId(), amountPaise: conv.paise, currency: 'INR',
    displayAmount: formatMoney(a.feeTotalMinor, a.feeSnapshot.currency), fxRate: conv.rate, fxDate: conv.date,
    name: a.orgName || a.contactName, email: a.contactEmail, description: 'SAMARTH consultation booking fee ' + a.ref,
  };
}

/** Online payment of an accepted quotation. */
export async function startEngagementCheckout(e: Engagement, a: Application): Promise<CheckoutResult> {
  if (!(await isFeatureEnabled('samarthEngagementCheckout'))) return { ok: false, status: 409, error: 'Online payment for engagements is not open. The SAMARTH team will invoice you.' };
  if (!isConfigured()) return { ok: false, status: 503, error: 'Online payment is not configured on this server. The SAMARTH team will invoice you.' };
  if (e.paymentState === 'paid') return { ok: false, status: 409, error: 'This engagement is already paid.', alreadyPaid: true };
  if (e.status !== 'ACCEPTED') return { ok: false, status: 409, error: 'Accept the quotation first.' };
  if (e.paymentMethod !== 'online') return { ok: false, status: 409, error: 'This quotation is paid against an invoice.' };
  if (e.paymentOrderId && await paymentMayBeCaptured(e.paymentOrderId)) {
    return { ok: false, status: 409, alreadyPaid: true, error: 'A payment for this engagement may already have gone through. Reload in a minute; do not pay again.' };
  }
  const total = engagementBreakdown(e).total;
  if (!total) return { ok: false, status: 409, error: 'This quotation has no amount.' };
  const conv = await conversion(total, e.currency);
  if ('error' in conv) return { ok: false, status: 503, error: conv.error };
  const receipt = 'same_' + e.ref.slice(-8).toLowerCase() + '_' + Date.now().toString(36);
  const keyMode = gatewayKeyMode();
  const order = await createOrder({ amountPaise: conv.paise, currency: 'INR', receipt, notes: { purpose: PURPOSE_ENGAGEMENT, ref: e.ref, currency: e.currency, totalMinor: String(total), fxRate: String(conv.rate) } });
  if (!order.ok) return { ok: false, status: 502, error: 'The payment provider did not accept the order, so nothing was charged. Try again in a moment.' };
  try {
    await insertPaymentRow({
      orderId: order.order.id, paise: conv.paise, purpose: PURPOSE_ENGAGEMENT, refType: REF_TYPE_ENGAGEMENT, refId: e.id, email: a.contactEmail, phone: a.contactPhone,
      notes: { ref: e.ref, applicationRef: a.ref, receipt, priced: { currency: e.currency, totalMinor: total }, fxRate: conv.rate, fxDate: conv.date, keyMode },
    });
    await db.execute(sql`UPDATE samarth_engagements SET payment_order_id = ${order.order.id}, charged_inr_paise = ${conv.paise}, fx_rate = ${conv.rate}, payment_state = 'pending', updated_at = NOW() WHERE id = ${e.id}::uuid`);
  } catch (err: any) {
    console.error('[samarth/payments] engagement order', order.order.id, 'could not be recorded for', e.ref, '-', String(err?.cause?.message || err?.message));
    return { ok: false, status: 500, error: 'Checkout could not be opened just now, so nothing was charged. Try again in a moment.' };
  }
  return {
    ok: true, orderId: order.order.id, keyId: getPublicKeyId(), amountPaise: conv.paise, currency: 'INR',
    displayAmount: formatMoney(total, e.currency), fxRate: conv.rate, fxDate: conv.date,
    name: a.orgName || a.contactName, email: a.contactEmail, description: 'SAMARTH engagement ' + e.ref,
  };
}

/**
 * The paid effect, called from applyPaidEffects() for a SAMARTH purpose. THROWS on failure so the
 * caller records it on the payment row and alerts admins (a captured payment that was not applied
 * must never be silent). Idempotent: a second delivery changes nothing.
 */
export async function applySamarthPaid(purpose: string, referenceType: string, referenceId: string, orderId: string, paymentId: string | null): Promise<void> {
  if (!isUuid(referenceId)) throw new Error('the payment row does not name a SAMARTH record');
  if (purpose === PURPOSE_FEE || referenceType === REF_TYPE_APPLICATION) {
    const r = await markFeePaidByGateway(referenceId, orderId, paymentId);
    if (!r.app) throw new Error('the SAMARTH application ' + referenceId + ' does not exist');
    if (r.changed) {
      await emailFeePaid(r.app.contactEmail, r.app.contactName, r.app.ref, r.app.feeTotalMinor, r.app.feeCurrency, orderId);
      await alertAdmins('samarth_payment', 'SAMARTH booking fee paid', r.app.ref + ' (' + (r.app.orgName || r.app.contactName) + ') paid the booking fee. Next: the applicant books the call.', '/admin/samarth/applications/' + r.app.id, 'samfee-' + r.app.id);
    } else if (r.app.paymentOrderId && r.app.paymentOrderId !== orderId && r.app.paidAt) {
      // A SECOND captured payment for a fee that was already paid. The money is real; somebody has to refund it.
      await addEvent('application', r.app.id, { kind: 'payment', body: 'A second payment (order ' + orderId + ') was captured after the fee was already paid. It must be refunded.' });
      await alertAdmins('samarth_payment', 'Duplicate SAMARTH payment', r.app.ref + ': a second booking-fee payment was captured (order ' + orderId + '). Refund it from Finance.', '/admin/finance', 'samdup-' + orderId);
    }
    return;
  }
  if (purpose === PURPOSE_ENGAGEMENT || referenceType === REF_TYPE_ENGAGEMENT) {
    const r = await markEngagementPaidByGateway(referenceId, orderId, paymentId);
    if (!r.engagement) throw new Error('the SAMARTH engagement ' + referenceId + ' does not exist');
    if (r.changed) {
      const app = rows(await db.execute(sql`SELECT ref, contact_email, contact_name, org_name FROM samarth_applications WHERE id = ${r.engagement.applicationId}::uuid LIMIT 1`))[0];
      if (app) await emailUpdate(str(app.contact_email), str(app.ref), 'Payment received', 'We have received your payment for ' + r.engagement.ref + ' (' + r.engagement.title + '). Your receipt: ' + workspaceUrl(str(app.ref)), workspaceUrl(str(app.ref)));
      await alertAdmins('samarth_payment', 'SAMARTH engagement paid', r.engagement.ref + ' (' + r.engagement.title + ') was paid online.', '/admin/samarth/engagements/' + r.engagement.id, 'sameng-' + r.engagement.id);
    }
    return;
  }
  throw new Error('unknown SAMARTH payment purpose ' + purpose);
}

/**
 * Raise a receivable invoice in the platform's invoice module for a booking fee or an engagement.
 * The invoice is a DRAFT there: finance applies tax components and sends it from /admin/finance/invoices.
 */
export async function raiseInvoice(kind: 'application' | 'engagement', a: Application, e: Engagement | null, who: ActorRef): Promise<{ ok: true; invoiceId: string } | { ok: false; error: string }> {
  const { createReceivable, addLine } = await import('@/lib/invoices');
  if (kind === 'application' && a.invoiceId) return { ok: false, error: 'An invoice was already raised for this booking fee.' };
  if (kind === 'engagement' && e?.invoiceId) return { ok: false, error: 'An invoice was already raised for this engagement.' };
  const currency = kind === 'application' ? (a.feeSnapshot?.currency || '') : (e?.currency || '');
  const def = currencyDef(currency);
  if (!def) return { ok: false, error: 'There is no confirmed amount to invoice yet.' };
  const baseMinor = kind === 'application' ? (a.feeSnapshot?.breakdown?.base || 0) : (e ? engagementBreakdown(e).base : 0);
  if (!baseMinor) return { ok: false, error: 'There is no confirmed amount to invoice yet.' };
  const taxNote = kind === 'application'
    ? (a.feeSnapshot && a.feeSnapshot.taxMode !== 'none' ? 'Fee schedule tax: ' + a.feeSnapshot.taxLabel + ' ' + (a.feeSnapshot.taxRateBp / 100) + '% (' + a.feeSnapshot.taxMode + '). Apply the matching tax component.' : 'No tax applies under the fee schedule.')
    : (e && e.taxMode !== 'none' ? 'Quotation tax: ' + e.taxLabel + ' ' + (e.taxRateBp / 100) + '% (' + e.taxMode + '). Apply the matching tax component.' : 'No tax applies under the quotation.');
  const official = a.official;
  const created = await createReceivable({
    partyKind: 'client',
    partyName: a.orgName || a.contactName,
    partyEmail: official?.repEmail || a.contactEmail,
    partyAddress: [a.city, a.region, a.country].filter(Boolean).join(', '),
    partyTaxReference: a.orgRegistration || null,
    partyReference: kind === 'application' ? a.ref : (e?.ref || a.ref),
    currency: def.code,
    notes: (kind === 'application' ? 'SAMARTH consultation booking fee ' + a.ref : 'SAMARTH engagement ' + (e?.ref || '') + ': ' + (e?.title || '')) + '. ' + taxNote
      + (official?.procurement?.tenderRef ? ' Procurement reference: ' + official.procurement.tenderRef + '.' : ''),
    terms: kind === 'application' ? (a.feeSnapshot?.terms || null) : (e?.terms || null),
  }, who.userId);
  if (!created.ok || !created.id) return { ok: false, error: created.error || 'The invoice could not be created.' };
  const rate = baseMinor / Math.pow(10, def.exponent);
  const line = await addLine(created.id, {
    description: kind === 'application' ? 'Consultation booking fee (' + a.ref + ')' : (e?.title || 'Engagement') + ' (' + (e?.ref || '') + ')',
    quantity: 1, unit: kind === 'application' ? 'booking' : 'engagement', rate,
  }, who.userId);
  if (!line.ok) return { ok: false, error: 'The invoice was created but its line could not be added: ' + (line.error || 'unknown') + '. Open it in Finance to finish it.' };
  if (kind === 'application') await setApplicationInvoice(a.id, created.id, who);
  else if (e) await setEngagementInvoice(e.id, created.id, who);
  return { ok: true, invoiceId: created.id };
}

/** The live gateway status of a stored order, for the admin screens (refunds included). */
export async function paymentStatusOf(orderId: string): Promise<{ status: string; amountPaise: number | null; refundedAt: string | null } | null> {
  if (!orderId) return null;
  try {
    const r = rows(await db.execute(sql`SELECT status, amount_paise, refunded_at FROM payments WHERE order_id = ${orderId} LIMIT 1`))[0];
    return r ? { status: str(r.status), amountPaise: num(r.amount_paise), refundedAt: r.refunded_at ? String(r.refunded_at) : null } : null;
  } catch { return null; }
}
