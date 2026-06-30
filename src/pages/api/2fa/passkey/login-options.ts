// POST /api/2fa/passkey/login-options — passwordless ("tap your fingerprint")
// login. allowCredentials is empty so the browser offers any discoverable
// passkey registered for this site; we resolve the account on verify.
import type { APIRoute } from 'astro';
import { rpFromRequest, newChallenge } from '@/lib/auth/webauthn';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const { rpId } = rpFromRequest(request);
    const challenge = newChallenge();
    cookies.set('wa_chal', challenge, { path: '/', httpOnly: true, maxAge: 300, sameSite: 'lax', secure: import.meta.env.PROD });
    return json({ ok: true, options: { challenge, rpId, allowCredentials: [], userVerification: 'preferred', timeout: 60000 } });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'Could not start' }, 500);
  }
};
