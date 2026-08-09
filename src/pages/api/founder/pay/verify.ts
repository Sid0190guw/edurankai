// POST /api/founder/pay/verify — confirm a founder-service payment.
// Verifies the Razorpay HMAC + captured status, marks the payment and booking
// paid, then returns what the buyer unlocks: the direct line (text) or a
// booking confirmation with a one-click add-to-calendar link (consult).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';
import { getFounder, markServicePaid, directConnectHref, gcalLink } from '@/lib/founder';

// Declared before the handler that uses them - `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const TERMINAL = ['refunded', 'partially_refunded'];

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const orderId = (b.razorpay_order_id || '').toString();
  const paymentId = (b.razorpay_payment_id || '').toString();
  const signature = (b.razorpay_signature || '').toString();
  if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'missing payment fields' }, 400);

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try { await db.execute(sql`UPDATE payments SET status='signature_mismatch', updated_at=NOW() WHERE order_id=${orderId}`); }
    catch (e: any) { console.error('[founder/pay/verify] could not flag the signature mismatch on order', orderId, '-', causeOf(e)); }
    return json({ ok: false, error: 'Signature mismatch' }, 400);
  }
  const remote = await fetchPayment(paymentId);
  const captured = remote && (remote.status === 'captured' || remote.status === 'authorized');
  if (!captured) return json({ ok: false, error: 'Payment not captured yet. Try again in a moment.' }, 402);

  // -----------------------------------------------------------------------------------------------
  // A REFUND IS TERMINAL AND THIS ROUTE COULD UNDO ONE.
  //
  // The body is the triple Razorpay handed the payer's own browser; the HMAC covers `order|payment`
  // and nothing else, so it stays valid forever. The UPDATE below carried no state guard, so a
  // founder-service payment that had since been refunded was written back to 'paid', the booking was
  // re-marked paid, the direct line was handed back, and getRevenue() counted the money again.
  // /api/payments/verify already carries this guard; this confirmation path did not.
  //
  // A row that cannot be read is UNKNOWN, not "not refunded": nothing is written and nothing is
  // revealed, and the webhook settles the order on its own.
  let priorStatus = '';
  try {
    const prior = rowsOf(await db.execute(sql`SELECT status FROM payments WHERE order_id = ${orderId} LIMIT 1`))[0] as any;
    priorStatus = String(prior?.status || '');
  } catch (e: any) {
    console.error('[founder/pay/verify] could not read the stored status of order', orderId, '-', causeOf(e));
    return json({ ok: false, error: 'We could not confirm that payment just now. Nothing was charged twice - try again in a moment.' }, 503);
  }
  if (TERMINAL.indexOf(priorStatus) >= 0) {
    console.error('[founder/pay/verify] replayed against a REFUNDED order', orderId, '- nothing was changed');
    return json({ ok: false, error: 'This payment has been refunded. Nothing was changed.' }, 409);
  }

  try {
    // The guard is repeated on the statement so a refund landing between the read and this write
    // still wins. The `payment_id` fallback exists because older rows predate that column; both
    // failures are LOGGED rather than swallowed - a payment marked paid nowhere is a booking nobody
    // can find.
    try {
      await db.execute(sql`UPDATE payments SET status='paid', payment_id=${paymentId}, updated_at=NOW()
        WHERE order_id=${orderId} AND status NOT IN ('refunded', 'partially_refunded')`);
    } catch (e: any) {
      console.error('[founder/pay/verify] payment_id update failed for order', orderId, '- retrying without it -', causeOf(e));
      try {
        await db.execute(sql`UPDATE payments SET status='paid', updated_at=NOW()
          WHERE order_id=${orderId} AND status NOT IN ('refunded', 'partially_refunded')`);
      } catch (e2: any) {
        console.error('[founder/pay/verify] the payments row for order', orderId, 'was NOT marked paid -', causeOf(e2));
      }
    }
    const booking = await markServicePaid(orderId);
    const f = await getFounder();
    if (!booking) return json({ ok: true, kind: '', message: 'Payment received.' });
    if (booking.kind === 'text') {
      // Message is delivered either way (it's stored + shown in the console). If
      // a direct-line number is configured, also hand back the deep link.
      return json({ ok: true, kind: 'text', revealHref: directConnectHref(f.connectNumber, f.connectMessage), label: f.connectLabel });
    }
    const title = 'Consultation with ' + (f.name || 'Founder');
    const details = 'Booked via edurankai.in/founder\nGuest: ' + (booking.name || '') + ' <' + (booking.email || '') + '>' + (booking.note ? '\nNote: ' + booking.note : '');
    const calHref = booking.preferred ? gcalLink(title, new Date(booking.preferred).toISOString(), booking.duration_min || 30, details) : '';
    return json({ ok: true, kind: 'consult', calendarHref: calHref, calendarUrl: f.calendarUrl });
  } catch (e: any) {
    // The database's own words are logged, never returned: e.message is only the failed SQL.
    console.error('[founder/pay/verify] finalise failed for order', orderId, '-', causeOf(e));
    return json({ ok: false, error: 'Your payment went through but we could not finish setting it up. Do not pay again - write to connect@edurankai.in with your payment id.' }, 500);
  }
};
