// POST /api/founder/pay/verify — confirm a founder-service payment.
// Verifies the Razorpay HMAC + captured status, marks the payment and booking
// paid, then returns what the buyer unlocks: the direct line (text) or a
// booking confirmation with a one-click add-to-calendar link (consult).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyPaymentSignature, fetchPayment } from '@/lib/razorpay';
import { getFounder, markServicePaid, directConnectHref, gcalLink } from '@/lib/founder';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const orderId = (b.razorpay_order_id || '').toString();
  const paymentId = (b.razorpay_payment_id || '').toString();
  const signature = (b.razorpay_signature || '').toString();
  if (!orderId || !paymentId || !signature) return json({ ok: false, error: 'missing payment fields' }, 400);

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    try { await db.execute(sql`UPDATE payments SET status='signature_mismatch', updated_at=NOW() WHERE order_id=${orderId}`); } catch (_) {}
    return json({ ok: false, error: 'Signature mismatch' }, 400);
  }
  const remote = await fetchPayment(paymentId);
  const captured = remote && (remote.status === 'captured' || remote.status === 'authorized');
  if (!captured) return json({ ok: false, error: 'Payment not captured yet. Try again in a moment.' }, 402);

  try {
    await db.execute(sql`UPDATE payments SET status='paid', payment_id=${paymentId}, updated_at=NOW() WHERE order_id=${orderId}`).catch(async () => {
      await db.execute(sql`UPDATE payments SET status='paid', updated_at=NOW() WHERE order_id=${orderId}`).catch(() => {});
    });
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
    return json({ ok: false, error: e?.cause?.message || e?.message || 'finalise failed' }, 500);
  }
};
