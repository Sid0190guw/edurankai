// POST /api/founder/pay/create — start a paid request for the founder's time.
// kind 'text' (direct message) or 'consult' (call). No login: this is a public,
// serious-intent filter. Price is admin-controlled (default 100 / 500 CHF),
// charged in INR via live FX. If a channel is free (gate off / price 0 / gateway
// not configured) it resolves immediately without payment.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';
import { getFounder, createServicePending, directConnectHref, isSlotAvailable } from '@/lib/founder';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const kind = b.kind === 'text' ? 'text' : b.kind === 'consult' ? 'consult' : '';
  if (!kind) return json({ ok: false, error: 'invalid kind' }, 400);
  const name = (b.name || '').toString().trim().slice(0, 120);
  const email = (b.email || '').toString().trim().slice(0, 200);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: 'Name and a valid email are required.' }, 400);
  const durationMin = [15, 30, 45, 60].includes(Number(b.durationMin)) ? Number(b.durationMin) : 30;
  let preferred: string | null = null;
  if (b.preferred) { const d = new Date(b.preferred); if (!isNaN(d.getTime())) preferred = d.toISOString(); }
  const phone = (b.phone || '').toString().slice(0, 40);
  const note = (b.note || '').toString().slice(0, 1000);
  // Optional supporting-docs link (Google Drive etc). Only accept a real http(s) URL.
  const rawDocs = (b.docsUrl || '').toString().trim().slice(0, 500);
  const docsUrl = /^https?:\/\/\S+\.\S+/.test(rawDocs) ? rawDocs : null;

  const f = await getFounder();
  const priceChf = kind === 'text' ? f.textPriceChf : f.consultPriceChf;
  const gated = kind === 'text' ? f.gateText : f.gateConsult;
  // Consultancy must land on a real open slot — re-check server-side so two
  // people cannot pay for the same time.
  if (kind === 'consult' && preferred) {
    if (!(await isSlotAvailable(preferred))) return json({ ok: false, error: 'That time was just taken. Please pick another slot.' }, 409);
  }
  if (kind === 'consult' && !preferred) return json({ ok: false, error: 'Please choose a time slot.' }, 400);

  // Free path
  if (!gated || priceChf <= 0 || !isConfigured()) {
    const id = await createServicePending({ kind, name, email, phone, preferred, durationMin, note, docsUrl, amountPaise: 0, currency: f.currency, paid: !isConfigured() ? false : true });
    if (kind === 'text') return json({ ok: true, free: true, revealHref: directConnectHref(f.connectNumber, f.connectMessage) });
    return json({ ok: true, free: true, confirmed: true, bookingId: id });
  }

  // Paid path
  try {
    const fx = await convertToInrPaise(f.currency, Math.round(priceChf * 100));
    const order = await createOrder({ amountPaise: fx.paise, currency: 'INR', receipt: ('fdr_' + kind + '_' + Date.now()).slice(0, 40), notes: { kind, email, service: 'founder' } });
    if (!order.ok) return json({ ok: false, error: order.error }, 502);
    const bookingId = await createServicePending({ kind, name, email, phone, preferred, durationMin, note, docsUrl, orderId: order.order.id, amountPaise: fx.paise, currency: 'INR', paid: false });
    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, email, notes)
      VALUES (${order.order.id}, ${fx.paise}, 'INR', 'created', ${'founder_' + kind}, 'founder', ${bookingId}, ${email},
        ${sql.raw("'" + JSON.stringify({ kind, priceChf, name }).replace(/'/g, "''") + "'::jsonb")})
    `).catch(() => {});
    const inrLabel = '₹' + (fx.paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    return json({ ok: true, paid: true, orderId: order.order.id, keyId: getPublicKeyId(), amountPaise: fx.paise, currency: 'INR', name, email, priceLabel: priceChf + ' ' + f.currency, inrLabel });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'could not start payment' }, 500);
  }
};
