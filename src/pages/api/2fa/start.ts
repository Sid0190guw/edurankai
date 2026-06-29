// POST /api/2fa/start — begin authenticator-app enrolment for the signed-in
// user. Generates a fresh secret (unconfirmed) and returns the otpauth URI +
// the human-readable key. Nothing is enforced until /api/2fa/confirm succeeds.
import type { APIRoute } from 'astro';
import { startTotpEnrollment, otpauthUri, formatSecret } from '@/lib/auth/twofactor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  try {
    const secret = await startTotpEnrollment(user.id);
    const account = user.email || user.internalHandle || user.name || 'account';
    return json({ ok: true, secret, formatted: formatSecret(secret), otpauth: otpauthUri(secret, account) });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Could not start setup' }, 500);
  }
};
