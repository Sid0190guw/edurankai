// POST /api/apply/location — record a precise location (or a refusal) from the application flow.
//
// Precise location cannot be taken silently: the browser prompts, and the applicant may say no.
// This endpoint therefore accepts BOTH outcomes. A refusal is stored rather than discarded, because
// on a security-cleared programme "declined to share location" is itself information a reviewer
// should see — while remaining advisory, never an automatic rejection.
//
// Always returns 200. The applicant's ability to proceed must never depend on this succeeding.
//
// BUT THE BODY TELLS THE TRUTH. `stored` says whether a usable row was actually written. It used to
// return a bare {ok:true} whether or not anything reached the database, and the apply page printed
// "Location access granted. You can continue." off the back of it — so on a security-classified role
// the applicant was told they were done, and the server then refused the submission for a location
// it had never received. A 200 means "we handled your report", never "we have your location".
import type { APIRoute } from 'astro';
import { recordLocation, coarseFromRequest, type GpsStatus } from '@/lib/applicant-location';

export const prerender = false;

const VALID: GpsStatus[] = ['granted', 'denied', 'unavailable', 'timeout'];

// Declared before the handler on purpose: a const is not hoisted, and a helper referenced from
// inside the handler but declared after it throws on the first request.
const reply = (body: Record<string, unknown>) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  let stored = false;
  let status: GpsStatus = 'unavailable';

  try {
    const body = await request.json().catch(() => ({} as any));
    status = VALID.includes(body?.status) ? body.status : 'unavailable';

    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const lat = num(body?.latitude);
    const lon = num(body?.longitude);
    // Coordinates the trail check would later discard are not a grant, whatever the client claims.
    const usableCoords = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

    // The coarse read comes from the request itself and cannot be forged by the client, so it is
    // recorded alongside the reported position. If the two disagree wildly the admin view surfaces
    // it as a possible VPN — which is why we never trust the posted coordinates alone.
    const coarse = coarseFromRequest(request, clientAddress);

    const written = await recordLocation({
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
    // A "granted" report only counts as stored when the row carries coordinates the gate can find.
    stored = written && (status !== 'granted' || usableCoords);
  } catch (e: any) {
    // Never rethrown — see the note above about not blocking the applicant. Logged with the real
    // Postgres reason (e.cause), and reported as stored:false rather than dressed up as success.
    console.error('apply/location failed:', e?.cause?.message || e?.message);
  }
  return reply({ ok: true, stored, status });
};
