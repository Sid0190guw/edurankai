// POST /api/auth/totp-login  { email, code }
// Sign in with an authenticator code alone (one of several independent methods).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq, or } from 'drizzle-orm';
import { verifyLoginCode, isTotpEnabled } from '@/lib/auth/twofactor';
import { generateSessionToken, createSession } from '@/lib/auth/session';
import { setSessionCookie } from '@/lib/auth/cookie';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  let email = '', code = '';
  try { const b = await request.json(); email = (b.email || '').toString().trim().toLowerCase(); code = (b.code || '').toString().trim(); }
  catch { return json({ ok: false, error: 'Bad request' }, 400); }
  if (!email || !code) return json({ ok: false, error: 'Email and code are required.' }, 400);
  try {
    const found = await db.select().from(users).where(or(eq(users.email, email), eq(users.internalHandle, email))).limit(1);
    const u = found[0];
    // One generic error — never reveal whether the account exists or has 2FA.
    if (!u || !u.isActive || !(await isTotpEnabled(u.id)) || !(await verifyLoginCode(u.id, code))) {
      return json({ ok: false, error: 'Invalid email or code.' }, 400);
    }
    const token = generateSessionToken();
    const session = await createSession(token, u.id, { userAgent: request.headers.get('user-agent') || undefined, ipAddress: clientAddress });
    setSessionCookie(cookies, token, session.expiresAt);
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, u.id));
    return json({ ok: true, redirect: u.role === 'applicant' ? '/portal' : '/admin' });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Sign-in failed' }, 500);
  }
};
