// POST/GET /api/render/negotiate — Block 05: stateless capability negotiation.
// POST: validate client telemetry → merge with header Client Hints → selectRenderProfile →
// best-effort persist (signed-in) → return the authoritative profile. GET: last persisted profile.
import type { APIRoute } from 'astro';
import { signalsFromHeaders } from '@/lib/edu-runtime';
import { deviceTelemetryZ, mergeTelemetry, selectRenderProfile, saveDeviceProfile, getDeviceProfile } from '@/lib/render-profile';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  let body: unknown = {};
  try { body = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const parsed = deviceTelemetryZ.safeParse(body);
  if (!parsed.success) return j({ ok: false, error: 'invalid telemetry' }, 400);

  const telemetry = mergeTelemetry(signalsFromHeaders(request.headers), parsed.data);
  const profile = selectRenderProfile(telemetry);

  const user = (locals as any)?.user;
  if (user?.id) { try { await saveDeviceProfile(user.id, telemetry, profile); } catch { /* best-effort */ } }
  return j({ ok: true, profile, source: 'client+headers' });
};

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  const profile = user?.id ? await getDeviceProfile(user.id).catch(() => null) : null;
  return j({ ok: true, profile });
};
