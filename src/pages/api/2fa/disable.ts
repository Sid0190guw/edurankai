// POST /api/2fa/disable  { code }
// Turns 2FA off — but only after proving control with a current authenticator
// code or an unused backup code, so a hijacked session alone can't disable it.
import type { APIRoute } from 'astro';
import { verifyLoginCode, disableTotp, isTotpEnabled } from '@/lib/auth/twofactor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let code = '';
  try { code = ((await request.json())?.code || '').toString(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  try {
    if (!(await isTotpEnabled(user.id))) { await disableTotp(user.id); return json({ ok: true }); }
    const ok = await verifyLoginCode(user.id, code);
    if (!ok) return json({ ok: false, error: 'Enter a current authenticator code (or a backup code) to turn off 2FA.' }, 400);
    await disableTotp(user.id);
    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Could not disable' }, 500);
  }
};
