// POST /api/payments/start-partnership
// Body: { applicationId }
// Starts the Razorpay checkout for the AquinTutor partnership STARTER fee
// (a fixed one-time CHF 100). The amount is computed server-side (CHF -> INR at
// the live rate) so the client can never set its own price. On success the
// browser pays via Razorpay, then /api/payments/verify -> applyPaidEffects marks
// the partnership application's starter fee paid.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';

const STARTER_FEE_CHF = 100;

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  if (!isConfigured()) return json({ ok: false, error: 'Payments not configured. Please contact partnerships@edurankai.in.' }, 503);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const applicationId = String(body?.applicationId || '').trim();
  if (!applicationId) return json({ ok: false, error: 'applicationId required' }, 400);

  // Look up the application (do NOT reference starter_fee_paid — that column is
  // added lazily by applyPaidEffects, so it may not exist on older rows yet).
  const app = rows(await db.execute(sql`
    SELECT id, tier, org_name, contact_email, contact_phone
    FROM partnership_applications WHERE id = ${applicationId} LIMIT 1
  `).catch(() => []))[0] as any;
  if (!app) return json({ ok: false, error: 'application not found' }, 404);
  if (app.tier !== 'starter') return json({ ok: false, error: 'Only the Starter tier has an upfront fee. The Scale tier is 15% revenue share, billed on what each course earns.' }, 400);

  const fx = await convertToInrPaise('CHF', STARTER_FEE_CHF * 100);
  const amountPaise = fx.paise;
  const email = (app.contact_email || (locals as any)?.user?.email || 'partner@edurankai.in').toString().toLowerCase();
  const receipt = 'pship_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const result = await createOrder({
    amountPaise, currency: 'INR', receipt,
    notes: { purpose: 'partnership_starter', applicationId, email, feeChf: String(STARTER_FEE_CHF), fxRate: String(fx.rate), fxDate: fx.date },
  });
  if (!result.ok) return json({ ok: false, error: result.error }, 502);

  await db.execute(sql`
    INSERT INTO payments (
      order_id, amount_paise, currency, status, purpose,
      reference_type, reference_id, user_id, email, contact, notes
    ) VALUES (
      ${result.order.id}, ${amountPaise}, 'INR', 'created', 'partnership_starter',
      'partnership_application', ${applicationId}, ${(locals as any)?.user?.id || null}, ${email}, ${app.contact_phone || null},
      ${sql.raw("'" + JSON.stringify({ receipt, feeChf: STARTER_FEE_CHF, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live, org: app.org_name }).replace(/'/g, "''") + "'::jsonb")}
    )
  `).catch(() => {});

  return json({ ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise, currency: 'INR', email, name: app.org_name || '', feeChf: STARTER_FEE_CHF });
};
