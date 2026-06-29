// POST /api/2fa/confirm  { token }
// Confirms authenticator enrolment by checking a live 6-digit code, then turns
// 2FA on and issues a fresh set of one-time backup codes (shown ONCE).
import type { APIRoute } from 'astro';
import { confirmTotp, generateBackupCodes, storeBackupCodes } from '@/lib/auth/twofactor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let token = '';
  try { token = ((await request.json())?.token || '').toString(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  try {
    const ok = await confirmTotp(user.id, token);
    if (!ok) return json({ ok: false, error: 'That code is not right. Check the time on your phone and try the current code.' }, 400);
    const codes = generateBackupCodes(10);
    await storeBackupCodes(user.id, codes);
    return json({ ok: true, backupCodes: codes });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Could not confirm' }, 500);
  }
};
