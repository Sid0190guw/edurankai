// POST /api/2fa/passkey/register-options — begin passkey (fingerprint) enrolment
// for the signed-in user. Stores the challenge in a short-lived httpOnly cookie.
import type { APIRoute } from 'astro';
import { rpFromRequest, newChallenge, registrationOptions } from '@/lib/auth/webauthn';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  try {
    const { rpId } = rpFromRequest(request);
    const challenge = newChallenge();
    cookies.set('wa_chal', challenge, { path: '/', httpOnly: true, maxAge: 300, sameSite: 'lax', secure: import.meta.env.PROD });
    const options = await registrationOptions({ userId: user.id, email: user.email, name: user.name, rpId, challenge });
    return json({ ok: true, options });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Could not start' }, 500);
  }
};
