// POST /api/auth/2fa/recovery-codes  { code }
//
// Re-issues ten single-use recovery codes, invalidating every previous one.
// Shown once. Requires proving a current factor, so a hijacked session cannot
// mint itself a fresh set of permanent bypasses.
//
// This exists because "I used my last code" and "I lost the paper" are the two
// ways a second step turns into a support ticket nobody can resolve.
import type { APIRoute } from 'astro';
import {
  regenerateRecoveryCodes, isSecondStepRequired, availableSecondFactors,
  verifyLoginCode, countUnusedBackupCodes, countAttempt,
} from '@/lib/auth/two-factor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Declared before the handler that uses them — `const` is not hoisted.
const MAX_PER_WINDOW = 10;
const WINDOW_SECONDS = 900;

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first.' }, 401);
  try {
    return json({
      ok: true,
      required: await isSecondStepRequired(user.id),
      methods: await availableSecondFactors(user.id),
      remaining: await countUnusedBackupCodes(user.id),
    });
  } catch (e: any) {
    console.error('[api/auth/2fa/recovery-codes GET]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Could not read your security settings.' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first.' }, 401);

  let code = '';
  try { code = ((await request.json())?.code || '').toString().trim(); }
  catch { return json({ ok: false, error: 'Bad request' }, 400); }

  try {
    const attempts = await countAttempt('2fa:recovery:' + user.id, WINDOW_SECONDS);
    if (attempts > MAX_PER_WINDOW) {
      return json({ ok: false, error: 'Too many attempts. Please wait 15 minutes.' }, 429);
    }
    const methods = await availableSecondFactors(user.id);
    if (!methods.length) {
      return json({ ok: false, error: 'Set up an authenticator app or enrol your face first.' }, 400);
    }
    if (!code || !(await verifyLoginCode(user.id, code))) {
      return json({
        ok: false,
        error: methods.indexOf('totp') >= 0
          ? 'Enter a current authenticator code, or one of your remaining recovery codes.'
          : 'Enter one of your remaining recovery codes.',
      }, 400);
    }
    const codes = await regenerateRecoveryCodes(user.id);
    return json({
      ok: true,
      recoveryCodes: codes,
      message: 'Your previous codes no longer work. Save these ten now.',
    });
  } catch (e: any) {
    console.error('[api/auth/2fa/recovery-codes POST]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Could not issue new codes. Please try again.' }, 500);
  }
};
