// POST /api/auth/2fa/enforce  { enabled: boolean, code?: string }
//
// Turns the per-account second step on or off. This is the ONLY switch that
// changes the platform's any-one-method model, and only for the account that
// asks for it.
//
// Turning it ON returns ten single-use recovery codes. They are shown once and
// stored only as hashes — the server cannot show them again, which is the point.
// Turning it OFF requires proving a factor first, so a hijacked session cannot
// quietly strip the protection.
import type { APIRoute } from 'astro';
import {
  enableSecondStep, disableSecondStep, isSecondStepRequired,
  availableSecondFactors, verifyLoginCode, countAttempt,
} from '@/lib/auth/two-factor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Declared before the handler that uses them — `const` is not hoisted.
const MAX_PER_WINDOW = 10;
const WINDOW_SECONDS = 900;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first.' }, 401);

  let enabled = false, code = '';
  try {
    const b = await request.json();
    enabled = !!b?.enabled;
    code = (b?.code || '').toString().trim();
  } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  try {
    if (enabled) {
      const result = await enableSecondStep(user.id);
      if (!result.ok) return json({ ok: false, error: result.error }, 400);
      return json({
        ok: true,
        enabled: true,
        recoveryCodes: result.recoveryCodes,
        message: 'Save these ten codes now. Each works once, and they cannot be shown again.',
      });
    }

    // Turning it off. Prove a factor first.
    if (!(await isSecondStepRequired(user.id))) {
      await disableSecondStep(user.id);
      return json({ ok: true, enabled: false });
    }
    const attempts = await countAttempt('2fa:disable:' + user.id, WINDOW_SECONDS);
    if (attempts > MAX_PER_WINDOW) {
      return json({ ok: false, error: 'Too many attempts. Please wait 15 minutes.' }, 429);
    }
    const methods = await availableSecondFactors(user.id);
    if (!code) {
      return json({
        ok: false,
        error: methods.indexOf('totp') >= 0
          ? 'Enter a current authenticator code, or a recovery code, to turn this off.'
          : 'Enter a recovery code to turn this off.',
      }, 400);
    }
    if (!(await verifyLoginCode(user.id, code))) {
      return json({ ok: false, error: 'That code is not right. Try again, or use a recovery code.' }, 400);
    }
    await disableSecondStep(user.id);
    return json({ ok: true, enabled: false });
  } catch (e: any) {
    // Postgres puts the real reason on e.cause, not e.message.
    console.error('[api/auth/2fa/enforce]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Could not update that setting. Please try again.' }, 500);
  }
};
