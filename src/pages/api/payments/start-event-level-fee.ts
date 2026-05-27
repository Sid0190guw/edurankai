// POST /api/payments/start-event-level-fee
// Body: { registrationId, levelId }
// Computes the level fee AUTHORITATIVELY from event_levels.fee_chf, ensures a
// progress row, creates a Razorpay order + payments row, returns checkout data.
// On verify, /api/payments/verify marks the progress paid (and auto-issues a
// no-test artifact if the level is configured for it).

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { convertToInrPaise } from '@/lib/fx';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in.', loginUrl: '/portal/login' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const registrationId = (body?.registrationId || '').toString().trim();
  const levelId = (body?.levelId || '').toString().trim();
  if (!registrationId || !levelId) return json({ ok: false, error: 'registrationId and levelId required' }, 400);

  try {
    const reg = rows(await db.execute(sql`SELECT id, event_id, user_id, participant_name, participant_email FROM event_registrations WHERE id = ${registrationId} LIMIT 1`))[0] as any;
    if (!reg) return json({ ok: false, error: 'Registration not found' }, 404);
    if (reg.user_id && reg.user_id !== user.id) return json({ ok: false, error: 'Not your registration' }, 403);

    const lv = rows(await db.execute(sql`SELECT id, event_id, name, fee_chf FROM event_levels WHERE id = ${levelId} AND event_id = ${reg.event_id} LIMIT 1`))[0] as any;
    if (!lv) return json({ ok: false, error: 'Level not found' }, 404);

    const feeChf = parseInt(lv.fee_chf || 0) || 0;
    const panelUrl = '/events/panel/' + reg.event_id;
    if (feeChf <= 0) {
      // Free level: just mark paid/registered.
      await db.execute(sql`
        INSERT INTO event_level_progress (registration_id, level_id, event_id, status, fee_paid, fee_paid_at)
        VALUES (${registrationId}, ${levelId}, ${reg.event_id}, 'paid', true, NOW())
        ON CONFLICT (registration_id, level_id) DO UPDATE SET fee_paid = true, status = 'paid', updated_at = NOW()
      `);
      return json({ ok: true, free: true, redirect: panelUrl });
    }

    // Ensure a progress row exists; use its id as the payment reference.
    const prog = rows(await db.execute(sql`
      INSERT INTO event_level_progress (registration_id, level_id, event_id, status)
      VALUES (${registrationId}, ${levelId}, ${reg.event_id}, 'pending')
      ON CONFLICT (registration_id, level_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, fee_paid
    `))[0] as any;
    if (prog?.fee_paid) return json({ ok: true, alreadyPaid: true, redirect: panelUrl });

    if (!isConfigured()) return json({ ok: false, error: 'Payments not yet configured. Contact hr@edurankai.in.' }, 503);

    const fx = await convertToInrPaise('CHF', feeChf * 100);
    const amountPaise = fx.paise;
    const receipt = 'evl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    const result = await createOrder({
      amountPaise, currency: 'INR', receipt,
      notes: { purpose: 'event_level', progressId: prog.id, registrationId, levelId, userId: user.id, email: reg.participant_email || user.email || '', feeChf: feeChf.toString() },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);

    await db.execute(sql`
      INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
      VALUES (${result.order.id}, ${amountPaise}, 'INR', 'created', 'event_level', 'event_level', ${prog.id}, ${user.id}, ${reg.participant_email || user.email || 'unknown@edurankai.in'},
        ${sql.raw("'" + JSON.stringify({ receipt, registrationId, levelId, feeChf, fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live }).replace(/'/g, "''") + "'::jsonb")})
    `).catch(() => {});

    return json({
      ok: true, orderId: result.order.id, keyId: getPublicKeyId(), amountPaise, currency: 'INR',
      feeChf, levelName: lv.name,
      prefill: { name: reg.participant_name || user.name || '', email: reg.participant_email || user.email || '' },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
