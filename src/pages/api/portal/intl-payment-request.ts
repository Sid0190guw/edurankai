// POST /api/portal/intl-payment-request
// Body: { intentId, country, preferredMethod, notes }
// International applicants who cannot complete Razorpay (or whose cards are
// rejected by the Indian gateway) can request an invoice / wire / PayPal flow
// here. Stores the request in application_intl_payments, notifies admins, and
// pauses the application in a 'pending_intl_payment' state until manually
// reconciled. Self-bootstrapping schema.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS application_intl_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      intent_id UUID,
      country VARCHAR(80),
      preferred_method VARCHAR(40),
      applicant_notes TEXT,
      admin_notes TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      invoice_url TEXT,
      reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS intl_pay_user_idx ON application_intl_payments(user_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS intl_pay_status_idx ON application_intl_payments(status, created_at DESC)`);
  } catch (_) {}
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  if (user.role !== 'applicant') return json({ ok: false, error: 'forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const intentId = (body.intentId || '').toString().trim() || null;
  const country = (body.country || '').toString().trim().slice(0, 80);
  const preferredMethod = (body.preferredMethod || '').toString().trim().slice(0, 40);
  const notes = (body.notes || '').toString().trim().slice(0, 4000);

  if (!country) return json({ ok: false, error: 'Country is required.' }, 400);
  if (!preferredMethod) return json({ ok: false, error: 'Preferred payment method is required.' }, 400);

  await ensureSchema();

  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO application_intl_payments (user_id, intent_id, country, preferred_method, applicant_notes, status)
      VALUES (${user.id}, ${intentId}, ${country}, ${preferredMethod}, ${notes}, 'pending')
      RETURNING id
    `));
    const reqId = ins[0]?.id;

    try {
      const { sendPushToAdmins } = await import('@/lib/push');
      await sendPushToAdmins({
        type: 'intl_payment_request',
        title: 'International payment request',
        body: (user.name || user.email || 'Applicant') + ' (' + country + ') needs ' + preferredMethod + ' for the application fee.',
        url: '/admin/intl-payments',
        tag: 'intl-pay-' + (reqId || ''),
      });
    } catch (_) {}

    return json({ ok: true, requestId: reqId });
  } catch (e: any) {
    console.error('[intl-payment-request] error:', e);
    return json({ ok: false, error: e?.message || 'request failed' }, 500);
  }
};
