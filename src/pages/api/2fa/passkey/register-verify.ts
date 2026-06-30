// POST /api/2fa/passkey/register-verify  { id, rawId, response:{attestationObject, clientDataJSON}, name, transports }
// Verifies the attestation ourselves (CBOR + COSE + authData) and stores the credential.
import type { APIRoute } from 'astro';
import { rpFromRequest, verifyRegistration } from '@/lib/auth/webauthn';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  const challenge = cookies.get('wa_chal')?.value || '';
  if (!challenge) return json({ ok: false, error: 'Setup expired — start again.' }, 400);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  const { origin, rpId } = rpFromRequest(request);
  try {
    const r = await verifyRegistration(user.id, body, { challenge, origin, rpId });
    cookies.delete('wa_chal', { path: '/' });
    return json({ ok: true, id: r.credentialId });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'Could not register this device' }, 400);
  }
};
