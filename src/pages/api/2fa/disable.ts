// POST /api/2fa/disable  { code }
// Turns 2FA off — but only after proving control with a current authenticator
// code or an unused backup code, so a hijacked session alone can't disable it.
import type { APIRoute } from 'astro';
import { verifyLoginCode, disableTotp, deleteTotpSecret, isTotpEnabled } from '@/lib/auth/twofactor';
import { isSecondStepRequired, availableSecondFactors, countAttempt } from '@/lib/auth/two-factor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Declared before the handler that reads them — `const` is not hoisted.
const MAX_PER_WINDOW = 10;
const WINDOW_SECONDS = 900;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let code = '';
  try { code = ((await request.json())?.code || '').toString(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  try {
    if (!(await isTotpEnabled(user.id))) {
      // NOTHING IS PROVED ON THIS BRANCH, so nothing that cannot be replaced may be destroyed.
      //
      // It used to call disableTotp(), which also deletes every recovery code. isTotpEnabled() is
      // false for an account whose second step is enforced through FACE, so one POST from any
      // signed-in session — no code, no confirmation — wiped the ten single-use codes that are the
      // documented way back in after a lost phone, and they are stored as hashes so nobody can put
      // them back. Abandoning an unconfirmed authenticator enrolment only needs the secret gone.
      await deleteTotpSecret(user.id);
      return json({ ok: true });
    }

    // Shared Postgres state, so retrying from a fresh invocation does not reset the count. This
    // endpoint accepts a recovery code, and an unlimited guessing loop against ten of them is the
    // same hole the sign-in surfaces already closed.
    if (await countAttempt('2fa:disable:' + user.id, WINDOW_SECONDS) > MAX_PER_WINDOW) {
      return json({ ok: false, error: 'Too many attempts. Please wait 15 minutes.' }, 429);
    }

    // REFUSE TO CREATE AN ENFORCED-BUT-IMPOSSIBLE ACCOUNT.
    //
    // disableTotp() removes the authenticator AND every recovery code, but it does not touch
    // user_2fa_policy. For an account that opted in to a mandatory second step with the authenticator
    // as its only factor, that combination leaves `required = true` with nothing left to complete:
    // the sign-in pages then quietly stop enforcing (canCompleteSecondStep is false), while the JSON
    // sign-in routes still gate and dead-end the passkey and authenticator paths on a challenge
    // screen that offers no step at all. Turning enforcement off is a deliberate act with its own
    // endpoint (/api/auth/2fa/enforce, which also takes a code), so this points there instead of
    // silently doing it on the caller's behalf.
    if (await isSecondStepRequired(user.id)) {
      const remaining = (await availableSecondFactors(user.id)).filter((m) => m !== 'totp');
      if (remaining.length === 0) {
        return json({
          ok: false,
          error: 'Your account requires a second step and this authenticator is the only factor on it. Turn the required second step off in Security settings first, or enrol your face, and then remove the authenticator.',
        }, 409);
      }
    }

    const ok = await verifyLoginCode(user.id, code);
    if (!ok) return json({ ok: false, error: 'Enter a current authenticator code (or a backup code) to turn off 2FA.' }, 400);
    await disableTotp(user.id);
    return json({ ok: true });
  } catch (e: any) {
    // NEVER RETURNED VERBATIM — e.message is the failed SQL and e.cause is the database's own words.
    console.error('[api/2fa/disable]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Could not turn that off. Please try again.' }, 500);
  }
};
