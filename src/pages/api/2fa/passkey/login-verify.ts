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
import { gateApiSignIn, type SignInSurface } from '@/lib/auth/two-factor';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Declared before the handler that uses them — `const` is not hoisted.
const SURFACES = ['admin', 'portal', 'aquintutor', 'hei'];

/**
 * Which sign-in page this passkey press came from.
 *
 * The shared client (public/webauthn-client.js) posts no `surface`, so every
 * gated passkey sign-in defaulted to the portal: an admin who owes a second step
 * was handed a PORTAL challenge cookie and redirected to /portal/login, on a page
 * that had nothing to do with the one they were on. The Referer only chooses
 * which sign-in page collects the second step and which cookie carries it — it
 * grants nothing and skips nothing, so a forged one buys an attacker a different
 * login page and no access at all.
 */
const surfaceFromReferer = (referer: string | null): SignInSurface => {
  const path = (() => { try { return new URL(referer || '').pathname; } catch { return ''; } })();
  if (path.indexOf('/admin') === 0) return 'admin';
  if (path.indexOf('/aquintutor') === 0) return 'aquintutor';
  if (path.indexOf('/hei') === 0) return 'hei';
  return 'portal';
};

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

    // The passkey was the FIRST factor. If this account opted in to a second
    // step it still owes one — without this the API route would let a single
    // factor through while the sign-in pages enforce two.
    let surface: SignInSurface = surfaceFromReferer(request.headers.get('referer'));
    const wanted = (body?.surface || '').toString();
    if (SURFACES.indexOf(wanted) >= 0) surface = wanted as SignInSurface;
    const gate = await gateApiSignIn(u.id, surface, 'passkey', cookies);
    if (gate.gated) return json({ ok: true, pending: true, redirect: gate.redirect });

    const token = generateSessionToken();
    const session = await createSession(token, u.id, { userAgent: request.headers.get('user-agent') || undefined, ipAddress: clientAddress });
    setSessionCookie(cookies, token, session.expiresAt);
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, u.id));
    return json({ ok: true, redirect: u.role === 'applicant' ? '/portal' : '/admin' });
  } catch (e: any) {
    // NEVER SWALLOWED, and never repeated verbatim to the caller either.
    //
    // The real Postgres reason lives on e.cause and e.message is only the SQL that
    // failed, so returning e.message unread handed a failed statement to an
    // unauthenticated caller while writing nothing anywhere a person would look.
    // The log gets the truth; the browser gets a sentence. Our own assertion
    // failures (challenge mismatch, bad signature) carry no cause and stay
    // readable, because "your passkey did not verify" is the answer in that case.
    // THE CHALLENGE IS BURNED ON FAILURE TOO. It was only deleted on the success path, so a
    // challenge that had already been presented and rejected stayed in the cookie for its full five
    // minutes and could be re-presented as often as the caller liked. A WebAuthn challenge is
    // single-use by definition — the freshness of the signed data is the whole reason it exists —
    // and leaving a spent one live hands an attacker an unlimited window to work in. Nothing
    // legitimate is lost: public/webauthn-client.js requests fresh options on every press.
    try { cookies.delete('wa_chal', { path: '/' }); } catch (_) {}
    const cause = e?.cause?.message;
    console.error('[api/2fa/passkey/login-verify]', cause || e?.message, e?.stack);
    return json({ ok: false, error: cause ? 'Passkey sign-in is temporarily unavailable. Please try again.' : (e?.message || 'Verification failed') }, 400);
  }
};
