// POST /api/apply/location — record a precise location (or a refusal) from the application flow.
//
// Precise location cannot be taken silently: the browser prompts, and the applicant may say no.
// This endpoint therefore accepts BOTH outcomes. A refusal is stored rather than discarded, because
// on a security-cleared programme "declined to share location" is itself information a reviewer
// should see — while remaining advisory, never an automatic rejection.
//
// Always returns 200. The applicant's ability to proceed must never depend on this succeeding.
import type { APIRoute } from 'astro';
import { recordLocation, coarseFromRequest, type GpsStatus } from '@/lib/applicant-location';

export const prerender = false;

const VALID: GpsStatus[] = ['granted', 'denied', 'unavailable', 'timeout'];

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const ok = () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

  try {
    const body = await request.json().catch(() => ({} as any));
    const status: GpsStatus = VALID.includes(body?.status) ? body.status : 'unavailable';

    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const lat = num(body?.latitude);
    const lon = num(body?.longitude);

    // The coarse read comes from the request itself and cannot be forged by the client, so it is
    // recorded alongside the reported position. If the two disagree wildly the admin view surfaces
    // it as a possible VPN — which is why we never trust the posted coordinates alone.
    const coarse = coarseFromRequest(request, clientAddress);

    await recordLocation({
      applicationId: typeof body?.applicationId === 'string' ? body.applicationId : null,
      intentId: typeof body?.intentId === 'string' ? body.intentId : null,
      userId: (locals as any)?.user?.id || null,
      email: typeof body?.email === 'string' ? body.email : null,
      step: typeof body?.step === 'string' ? body.step.slice(0, 60) : 'gps',
      source: 'gps',
      gpsStatus: status,
      // Only keep coordinates when permission was actually granted.
      latitude: status === 'granted' ? lat : null,
      longitude: status === 'granted' ? lon : null,
      accuracyM: status === 'granted' ? num(body?.accuracy) : null,
      ip: coarse.ip,
      country: coarse.country,
      region: coarse.region,
      city: coarse.city,
      timezone: coarse.timezone,
      userAgent: coarse.userAgent,
      // Device-side signals. These are the ones a VPN cannot touch, so they are what actually
      // exposes the true origin when the network location has been rerouted.
      browserTimezone: typeof body?.browserTimezone === 'string' ? body.browserTimezone.slice(0, 60) : null,
      utcOffsetMin: typeof body?.utcOffsetMin === 'number' && Number.isFinite(body.utcOffsetMin) ? body.utcOffsetMin : null,
      browserLanguages: Array.isArray(body?.languages) ? body.languages.join(',').slice(0, 120)
        : (typeof body?.languages === 'string' ? body.languages.slice(0, 120) : null),
      platform: typeof body?.platform === 'string' ? body.platform.slice(0, 60) : null,
      screenWh: typeof body?.screen === 'string' ? body.screen.slice(0, 24) : null,
    });
  } catch (_) {
    // Swallowed on purpose — see the note above about never blocking the applicant.
  }
  return ok();
};
