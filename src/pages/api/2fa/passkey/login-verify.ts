// POST /api/2fa/passkey/login-verify  { id, rawId, response:{authenticatorData, clientDataJSON, signature, userHandle} }
// Resolves the account from the presented credential, verifies the assertion
// ourselves, and starts a session. Passwordless sign-in.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { rpFromRequest, findPasskeyUser, verifyAuthentication } from '@/lib/auth/webauthn';
import { generateSessionToken, createSession } from '@/lib/auth/session';
import { setSessionCookie } from '@/lib/auth/cookie';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const challenge = cookies.get('wa_chal')?.value || '';
  if (!challenge) return json({ ok: false, error: 'Sign-in expired — try again.' }, 400);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  const { origin, rpId } = rpFromRequest(request);
  try {
    const owner = await findPasskeyUser(body.id);
    if (!owner) return json({ ok: false, error: 'This passkey is not registered here.' }, 400);
    await verifyAuthentication(owner.userId, body, { challenge, origin, rpId });
    cookies.delete('wa_chal', { path: '/' });

    const found = await db.select().from(users).where(eq(users.id, owner.userId)).limit(1);
    const u = found[0];
    if (!u || !u.isActive) return json({ ok: false, error: 'Account is inactive.' }, 403);
    const token = generateSessionToken();
    const session = await createSession(token, u.id, { userAgent: request.headers.get('user-agent') || undefined, ipAddress: clientAddress });
    setSessionCookie(cookies, token, session.expiresAt);
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, u.id));
    return json({ ok: true, redirect: u.role === 'applicant' ? '/portal' : '/admin' });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'Verification failed' }, 400);
  }
};
