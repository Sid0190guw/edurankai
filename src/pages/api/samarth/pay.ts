// POST /api/samarth/pay   { ref, target: 'fee' | 'engagement', engagementId? }
//
// Opens a gateway order for a SAMARTH booking fee or an accepted quotation. The caller must hold the
// request's private access cookie (src/lib/samarth/access.ts); the AMOUNT is read from the stored
// record, never from this body. Verification happens afterwards at /api/payments/verify and the
// signed webhook, which apply the effect through src/lib/payment-effects.ts.
import type { APIRoute } from 'astro';
import { getApplicationByRef } from '@/lib/samarth/applications';
import { getEngagement } from '@/lib/samarth/engagements';
import { startFeeCheckout, startEngagementCheckout } from '@/lib/samarth/payments';
import { checkAccess, isSecureRequest } from '@/lib/samarth/access';
import { normaliseRef, isRef } from '@/lib/samarth/validate';
import { clientIp, overPublicFormLimit } from '@/lib/public-form-limit';

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }

export const POST: APIRoute = async ({ request, cookies, url }) => {
  // Counted first: every call may reach the payment provider. Refused when the counter is down.
  const limit = await overPublicFormLimit('samarth-pay', clientIp(request.headers), { whenUnavailable: 'refuse', max: 20 });
  if (limit.blocked) return json({ ok: false, error: 'Too many payment attempts from your connection. Wait a few minutes. Nothing was charged.' }, 429);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const ref = normaliseRef(body?.ref);
  if (!isRef(ref, 'A')) return json({ ok: false, error: 'Unknown request.' }, 404);
  const app = await getApplicationByRef(ref);
  if (!app.ready) return json({ ok: false, error: 'Your request could not be read just now. Nothing was charged. Try again in a moment.' }, 503);
  if (!app.value) return json({ ok: false, error: 'Unknown request.' }, 404);
  const access = checkAccess(cookies, url, ref, app.value.accessHash, isSecureRequest(url));
  if (!access.ok) return json({ ok: false, error: 'Open this request from your private link first.' }, 403);

  if (body?.target === 'engagement') {
    const eng = await getEngagement(String(body?.engagementId || ''));
    if (!eng.ready) return json({ ok: false, error: 'The quotation could not be read just now. Nothing was charged.' }, 503);
    if (!eng.value || eng.value.applicationId !== app.value.id) return json({ ok: false, error: 'That quotation is not part of this request.' }, 404);
    const r = await startEngagementCheckout(eng.value, app.value);
    return r.ok ? json(r) : json(r, r.status);
  }
  const r = await startFeeCheckout(app.value);
  return r.ok ? json(r) : json(r, r.status);
};
