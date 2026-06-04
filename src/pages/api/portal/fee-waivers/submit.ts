// POST /api/portal/fee-waivers/submit
// Body: { intentId, situation, expertise, driveUrl }
// Inline waiver submission from /apply/pay. Idempotent — updates existing
// pending or rejected waiver, only inserts when none exists.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureFeeWaiverSchema } from '@/lib/fee-waiver';
import { getIntent } from '@/lib/application-intent';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  if (user.role !== 'applicant') return json({ ok: false, error: 'forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const intentId = (body.intentId || '').toString();
  const situation = (body.situation || '').toString().trim();
  const expertise = (body.expertise || '').toString().trim();
  const driveUrl = (body.driveUrl || body.drive_url || '').toString().trim();

  if (!intentId) return json({ ok: false, error: 'missing application reference' }, 400);
  if (!situation || !expertise || !driveUrl) return json({ ok: false, error: 'All three fields are required.' }, 400);
  if (situation.length > 6000 || expertise.length > 6000) return json({ ok: false, error: 'Notes must be under 6000 characters each.' }, 400);
  if (!/^https?:\/\/.+/i.test(driveUrl)) return json({ ok: false, error: 'Drive link must start with http(s)://' }, 400);

  await ensureFeeWaiverSchema();

  const intent = await getIntent(intentId, user.id);
  if (!intent) return json({ ok: false, error: 'application not found' }, 404);

  try {
    const prior = rows(await db.execute(sql`
      SELECT id, status FROM application_fee_waivers
      WHERE user_id = ${user.id} AND intent_id = ${intentId}
      ORDER BY created_at DESC LIMIT 1
    `))[0];

    let waiverId: string;
    let isNew = false;
    if (prior && prior.status !== 'approved') {
      await db.execute(sql`
        UPDATE application_fee_waivers
        SET situation_note = ${situation},
            expertise_note = ${expertise},
            drive_url = ${driveUrl},
            status = 'pending',
            reject_reason = NULL,
            reviewed_by_user_id = NULL,
            reviewed_at = NULL
        WHERE id = ${prior.id}
      `);
      waiverId = prior.id;
    } else if (prior && prior.status === 'approved') {
      return json({ ok: false, error: 'A waiver has already been approved for this application. Open your portal to continue.' }, 409);
    } else {
      const ins = rows(await db.execute(sql`
        INSERT INTO application_fee_waivers (user_id, intent_id, situation_note, expertise_note, drive_url, status)
        VALUES (${user.id}, ${intentId}, ${situation}, ${expertise}, ${driveUrl}, 'pending')
        RETURNING id
      `));
      waiverId = ins[0]?.id;
      isNew = true;
    }

    // Push notification to admins so this surfaces in the bell and admin feed.
    try {
      const { sendPushToAdmins } = await import('@/lib/push');
      const name = ((intent.first_name || '') + ' ' + (intent.last_name || '')).trim() || intent.email || 'Applicant';
      await sendPushToAdmins({
        type: 'fee_waiver_request',
        title: isNew ? 'Fee waiver request' : 'Fee waiver request updated',
        body: name + ' ' + (isNew ? 'is requesting' : 'updated their request for') + ' a fee waiver for ' + (intent.role_title_snapshot || 'an open role'),
        url: '/admin/fee-waivers',
        tag: 'fee-waiver-' + (waiverId || ''),
      });
    } catch (_) {}

    return json({ ok: true, waiverId, isNew });
  } catch (e: any) {
    console.error('[fee-waivers/submit] error:', e);
    return json({ ok: false, error: e?.message || 'submission failed' }, 500);
  }
};
