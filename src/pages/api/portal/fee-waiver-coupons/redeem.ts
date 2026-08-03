// POST /api/portal/fee-waiver-coupons/redeem
// Body: { code: string, intentId: string }
// Validates a coupon against the signed-in user + intent, materialises the
// application with fee_waiver_granted=true, and records the redemption.
import type { APIRoute } from 'astro';
import { previewCoupon, recordRedemption } from '@/lib/fee-waiver-coupons';
import { materialiseFromIntent } from '@/lib/fee-waiver';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  // DELIBERATELY NOT CONVERTED TO A CAPABILITY, AND NOT AN OVERSIGHT — recorded here so a later sweep
  // does not read it as an unconverted call site.
  //
  // This is an INVERSE role test: it restricts TO a role rather than requiring an ability. Every
  // internal role, including super_admin, is refused, and that is the intended meaning — a fee-waiver
  // coupon belongs to the candidate paying the fee. No key in the Permission union can express "is an
  // applicant" (applicant's grant list is empty, which is the whole point of it), and granting any key
  // to make this pass would open coupon redemption to staff. So the role comparison stays a role
  // comparison. See src/lib/auth/permissions.ts, where `applicant: []` carries the same reasoning.
  if (user.role !== 'applicant') return json({ ok: false, error: 'forbidden' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const code = (body.code || '').toString().trim();
  const intentId = (body.intentId || '').toString().trim() || null;
  if (!code) return json({ ok: false, error: 'enter a code' }, 400);

  const intent = intentId ? rows(await db.execute(sql`SELECT id FROM application_intents WHERE id = ${intentId} AND user_id = ${user.id} LIMIT 1`))[0] : null;
  if (intentId && !intent) return json({ ok: false, error: 'application not found' }, 404);

  const preview = await previewCoupon(code, user.id, intentId);
  if (!preview.ok || !preview.coupon) return json({ ok: false, error: preview.error || 'invalid code' }, 400);

  const appId = intentId ? await materialiseFromIntent(intentId, { paid: false, waiverGranted: true, waiverReason: 'Fee waiver coupon: ' + preview.coupon.code + (preview.coupon.reason ? ' — ' + preview.coupon.reason : '') }) : null;
  if (intentId && !appId) return json({ ok: false, error: 'could not finalise application' }, 500);

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
  const ua = request.headers.get('user-agent') || null;
  const rec = await recordRedemption({
    couponId: preview.coupon.id,
    userId: user.id,
    intentId,
    applicationId: appId,
    ipAddress: ip,
    userAgent: ua,
  });
  if (!rec.ok) return json({ ok: false, error: rec.error || 'redemption failed' }, 500);

  // Notify admins so they know a fee-waiver code was redeemed + a new application
  // landed in the funnel. Non-fatal — never break the redemption.
  try {
    const { sendPushToAdmins } = await import('@/lib/push');
    const candidate = (user.name || user.email || 'an applicant').toString();
    await sendPushToAdmins({
      type: 'fee_waiver_coupon_redeemed',
      title: 'Fee waiver coupon redeemed',
      body: candidate + ' used ' + preview.coupon.code + ' to bypass the fee.',
      url: appId ? '/admin/applications/' + appId : '/admin/fee-waiver-coupons?show=redeemed',
      tag: 'fwc-' + preview.coupon.id,
    });
  } catch (_) {}

  return json({ ok: true, applicationId: appId, code: preview.coupon.code });
};
