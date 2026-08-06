// POST /api/2fa/start — begin authenticator-app enrolment for the signed-in
// user. Generates a fresh secret (unconfirmed) and returns the otpauth URI +
// the human-readable key. Nothing is enforced until /api/2fa/confirm succeeds.
import type { APIRoute } from 'astro';
import { startTotpEnrollment, otpauthUri, formatSecret, isTotpEnabled } from '@/lib/auth/twofactor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  try {
    // A CONFIRMED AUTHENTICATOR IS NOT OVERWRITTEN WITHOUT PROVING ONE.
    //
    // startTotpEnrollment() is `ON CONFLICT (user_id) DO UPDATE SET secret = <new>, confirmed_at =
    // NULL`, so one POST here replaces a WORKING authenticator with a fresh unconfirmed secret. That
    // is the exact act /api/2fa/disable demands a current code for ("so a hijacked session can't
    // disable it") — reachable, with no code at all, one route over. The damage is not theoretical:
    // isTotpEnabled() goes false, availableSecondFactors() stops reporting 'totp', the enrolled app
    // on the owner's phone starts producing codes for a secret nobody holds, and whoever sent the
    // POST can confirm the new one from their own app and own the second factor outright.
    //
    // Nothing legitimate is refused. The panel that calls this route (src/components/security/
    // TwoFactorPanel.astro) renders its setup box only while 2FA is off, so the daily path — first
    // enrolment, and re-starting an enrolment that was never confirmed — is untouched. Someone who
    // really has lost their authenticator removes it through /api/2fa/disable, which accepts a
    // recovery code for exactly this case, and then enrols again.
    if (await isTotpEnabled(user.id)) {
      return json({
        ok: false,
        error: 'An authenticator app is already set up on this account. Remove the current one first (that needs a code from it, or one of your recovery codes) and then set up the new device.',
      }, 409);
    }
    const secret = await startTotpEnrollment(user.id);
    const account = user.email || user.internalHandle || user.name || 'account';
    return json({ ok: true, secret, formatted: formatSecret(secret), otpauth: otpauthUri(secret, account) });
  } catch (e: any) {
    // NEVER RETURNED VERBATIM. The real Postgres reason is on e.cause and e.message is only the SQL
    // that failed, so echoing either hands a failed statement — table and column names included — to
    // the caller while writing nothing anywhere an operator would look. The log gets the truth.
    console.error('[api/2fa/start]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Could not start authenticator setup. Please try again.' }, 500);
  }
};
