// POST /api/payments/tool-pass/order — start a purchase of the 24-hour tools day pass.
//
// =================================================================================================
// THE WALLET WAS SPENT WITH A READ, A COMPARISON IN JAVASCRIPT, AND A BLIND WRITE
// =================================================================================================
//
// This route was the last spender of account credit in the product still doing it by hand:
//
//     if ((await getCreditBalance(user.id)) >= PASS_INR_PAISE) {
//       await grantCredit(user.id, -PASS_INR_PAISE, 'Paid with credit: Tool day pass');
//       await activatePass({ ... });
//       return json({ ok: true, paidWithCredit: true });
//     }
//
// Four separate faults sat in those four lines, and every other checkout in the codebase
// (start-registration-fee, start-application-fee, start-event-level-fee, start-test-enrollment) had
// already been moved onto coverWithCredit() precisely to be rid of them:
//
//   1. READ-MODIFY-WRITE ON A BALANCE. The balance was read, compared here, and the debit written
//      several round trips later. Two presses of "Pay" (a double tap, a retried POST, two tabs) both
//      saw the same balance and both debited it — the wallet goes NEGATIVE and two passes are minted
//      out of one balance. coverWithCredit() tests the balance INSIDE the insert, so the second
//      attempt writes nothing at all.
//   2. grantCredit() REFUSES WITHOUT THROWING. It returns { ok: false, error } — it does not raise —
//      and its answer was discarded. A debit that never landed was followed by activatePass()
//      regardless: a free day pass, with nothing recording that the money was not taken.
//   3. NO payments ROW. The card path below writes a tool_day_passes row; the credit path wrote
//      nothing to `payments` at all, so a purchase made from the wallet appeared on no finance
//      console, on no receipt, and against nothing that could be refunded. coverWithCredit() writes
//      that row, and reverses the debit if it cannot.
//   4. `catch (_) {}` AROUND THE WHOLE THING. If activatePass() threw AFTER a successful debit the
//      failure was swallowed and execution fell through to CREATE A RAZORPAY ORDER — so somebody
//      whose wallet had just been emptied was shown a card checkout for the same pass and paid for
//      it twice, with no line in any log saying so.
//
// WHAT THE CREDIT PATH DOES NOW. coverWithCredit() debits atomically, records the payment, and
// reverses itself (alerting admins if even that fails) when the record cannot be written. Only then
// is the pass switched on. An activation that fails after a recorded payment is NOT reported as
// "your credit was not used" — it was — and it is not allowed to fall through to a card charge.
//
// ALREADY HOLDING A PASS IS NOT A REASON TO SELL ANOTHER ONE. Nothing asked, so a second press after
// a successful purchase (or a stale tab left open) charged again for hours the person already had.
// If that question cannot be answered because the read failed, nothing is charged and the caller is
// asked to try again — the one answer that cannot take money for something already bought.
import type { APIRoute } from 'astro';
import { ensureToolPassSchema } from '@/lib/tool-pass';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// Declared before the handler that reads them — `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// 1 CHF in centimes = 100. Razorpay needs INR for India; we convert 1 CHF
// roughly to ~100 INR (100 paise). The existing CHF→INR converter used in the
// rest of the codebase normalises this; here we hardcode a safe rounded value
// because the unit is fixed.
const PASS_INR_PAISE = 10000; // 100 INR

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorised' }, 401);

  await ensureToolPassSchema();

  // Do they already hold one? An empty answer and a failed read are different things, and only the
  // first of them may lead to a charge.
  try {
    const live = rowsOf(await db.execute(sql`
      SELECT expires_at FROM tool_day_passes
       WHERE user_id = ${user.id} AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`));
    if (live.length) {
      return json({ ok: true, alreadyActive: true, expiresAt: live[0]?.expires_at || null });
    }
  } catch (e: any) {
    console.error('[payments/tool-pass/order] could not check for an existing pass for user', String(user.id), '-', causeOf(e));
    return json({ ok: false, error: 'We could not check whether you already have a pass, so nothing was charged. Try again in a moment.' }, 503);
  }

  // Universal account credit: activate the day pass straight from the wallet
  // (no card charge, works even if Razorpay is not configured).
  const creditOrderId = 'CREDIT-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  let covered = false;
  try {
    const { coverWithCredit } = await import('@/lib/account-credit');
    const cov = await coverWithCredit({
      userId: user.id,
      amountPaise: PASS_INR_PAISE,
      purpose: 'tool_pass',
      referenceType: 'tool_pass',
      referenceId: creditOrderId,
      email: user.email || '',
      label: 'Tool day pass',
    });
    covered = cov.covered;
    // coverWithCredit() sets `error` only when something went wrong that it could not undo cleanly,
    // and its own message tells the person whether anything was deducted. Falling through to a card
    // order on top of that message is how somebody pays twice, so this refuses instead.
    if (!covered && cov.error) return json({ ok: false, error: cov.error }, 500);
  } catch (e: any) {
    // A throw out of coverWithCredit deducts nothing — it reverses its own debit — so the card path
    // below is safe. It is logged rather than swallowed so a wallet that has stopped working is
    // visible instead of quietly pushing everybody onto a card.
    console.error('[payments/tool-pass/order] wallet payment failed for user', String(user.id), '-', causeOf(e));
  }

  if (covered) {
    // The payment is recorded by this point. An activation failure is NOT "your credit was not used".
    try {
      const { activatePass } = await import('@/lib/tool-pass');
      await activatePass({ userId: user.id, orderId: creditOrderId, paymentId: 'credit', signature: 'credit' });
      return json({ ok: true, paidWithCredit: true });
    } catch (e: any) {
      console.error('[payments/tool-pass/order] PAID FROM CREDIT BUT THE PASS WAS NOT ACTIVATED — order', creditOrderId, 'user', String(user.id), '-', causeOf(e));
      try {
        const { sendPushToAdmins } = await import('@/lib/push');
        await sendPushToAdmins({
          type: 'tool_pass_stranded',
          title: 'Tool pass paid from credit, not activated',
          body: 'A day pass was paid for out of account credit (order ' + creditOrderId + ') and the pass could not be switched on. It needs activating or refunding by hand.',
          url: '/admin/finance',
          tag: 'tool-pass-stranded-' + creditOrderId,
        });
      } catch (e2: any) {
        console.error('[payments/tool-pass/order] could not alert admins about the stranded pass -', causeOf(e2));
      }
      return json({
        ok: false,
        error: 'Your credit was used and the payment is recorded, but the pass could not be switched on. Do not pay again — our team has been alerted.',
      }, 500);
    }
  }

  const keyId = import.meta.env.RAZORPAY_KEY_ID || import.meta.env.PUBLIC_RAZORPAY_KEY_ID;
  const secret = import.meta.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) return json({ ok: false, error: 'Razorpay not configured' }, 500);

  try {
    const auth = Buffer.from(keyId + ':' + secret).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + auth },
      body: JSON.stringify({ amount: PASS_INR_PAISE, currency: 'INR', notes: { kind: 'tool_pass', user_id: user.id } }),
    });
    const j = await r.json();
    if (!j.id) return json({ ok: false, error: j?.error?.description || 'order create failed' }, 500);
    // The pending row is what ./verify.ts promotes in place. If it cannot be written there is no
    // pending order to promote and the pass could never be activated, so the order id is NOT handed
    // back and nobody is charged — the unused Razorpay order expires on its own.
    await db.execute(sql`
      INSERT INTO tool_day_passes (user_id, candidate_email, amount_chf, razorpay_order_id, status)
      VALUES (${user.id}, ${user.email}, 1.00, ${j.id}, 'pending')
    `);
    return json({ ok: true, key: keyId, orderId: j.id, amount: PASS_INR_PAISE, currency: 'INR' });
  } catch (e: any) {
    // Its sibling ./verify.ts already logs the cause and answers a sentence; this one still handed
    // back 240 characters of the failed SQL.
    console.error('[payments/tool-pass/order]', causeOf(e));
    return json({ ok: false, error: 'We could not start that purchase just now, so nothing was charged. Try again in a moment.' }, 500);
  }
};
