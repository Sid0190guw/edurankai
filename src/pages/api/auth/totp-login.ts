// POST /api/auth/totp-login  { email, code, surface? }
// Sign in with an authenticator code alone — one of several independent
// methods. `email` accepts a personal email OR an internal handle.
//
// Two things this route must not become:
//   - an account-enumeration oracle (one generic message, always);
//   - an unlimited 6-digit guessing machine (shared Postgres attempt limit).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { findUserByLoginIdentifier } from '@/lib/auth/handle';
import { verifyLoginCode, isTotpEnabled } from '@/lib/auth/twofactor';
import { countAttempt, clearAttempts, gateApiSignIn, type SignInSurface } from '@/lib/auth/two-factor';
import { generateSessionToken, createSession } from '@/lib/auth/session';
import { setSessionCookie } from '@/lib/auth/cookie';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Declared before the handler that uses them — `const` is not hoisted.
const GENERIC = 'Invalid email or code.';
const SURFACES = ['admin', 'portal', 'aquintutor', 'hei'];
const MAX_PER_WINDOW = 10;
const WINDOW_SECONDS = 900;

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  let identifier = '', code = '', surface: SignInSurface = 'portal';
  try {
    const b = await request.json();
    identifier = (b.email || '').toString().trim();
    code = (b.code || '').toString().trim();
    const s = (b.surface || '').toString();
    if (SURFACES.indexOf(s) >= 0) surface = s as SignInSurface;
  } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  if (!identifier || !code) return json({ ok: false, error: 'Email and code are required.' }, 400);

  try {
    // Limit by identifier AND by source address, in shared Postgres state.
    // A per-request sleep would limit nothing: on serverless there is no memory
    // between invocations, so every guess would arrive in a fresh one.
    const ipKey = (clientAddress || request.headers.get('x-forwarded-for') || 'unknown')
      .toString().split(',')[0].trim().slice(0, 64);
    const byId = await countAttempt('totp-login:id:' + identifier.toLowerCase(), WINDOW_SECONDS);
    const byIp = await countAttempt('totp-login:ip:' + ipKey, WINDOW_SECONDS);
    if (byId > MAX_PER_WINDOW || byIp > MAX_PER_WINDOW * 5) {
      return json({ ok: false, error: 'Too many attempts. Please wait 15 minutes and try again.' }, 429);
    }

    const u = await findUserByLoginIdentifier(identifier);
    // One generic error — never reveal whether the account exists or has 2FA.
    if (!u || !u.isActive || !(await isTotpEnabled(u.id)) || !(await verifyLoginCode(u.id, code))) {
      return json({ ok: false, error: GENERIC }, 400);
    }

    // The code was the FIRST factor. If this account opted in to a second step,
    // it still owes one — otherwise this endpoint would be the hole that lets
    // one factor through while the sign-in pages enforce two.
    const gate = await gateApiSignIn(u.id, surface, 'totp', cookies);
    if (gate.gated) {
      await clearAttempts('totp-login:id:' + identifier.toLowerCase());
      return json({ ok: true, pending: true, redirect: gate.redirect });
    }

    const token = generateSessionToken();
    const session = await createSession(token, u.id, { userAgent: request.headers.get('user-agent') || undefined, ipAddress: clientAddress });
    setSessionCookie(cookies, token, session.expiresAt);
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, u.id));
    await clearAttempts('totp-login:id:' + identifier.toLowerCase());
    return json({ ok: true, redirect: u.role === 'applicant' ? '/portal' : '/admin' });
  } catch (e: any) {
    // Never swallowed — a bare catch in a login path once hid a total sign-in
    // outage here. Postgres puts the real reason on e.cause, not e.message.
    console.error('[api/auth/totp-login]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Sign-in is temporarily unavailable. Please try again.' }, 500);
  }
};
