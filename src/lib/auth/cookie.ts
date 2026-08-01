import type { AstroCookies } from 'astro';

const FALLBACK_COOKIE_NAME = 'edurankai_session';

/**
 * The session cookie name, sanitised.
 *
 * A cookie name must be an RFC 6265 token: no whitespace, no control characters, no separators.
 * This one comes from an environment variable, and a value pasted with a stray space or newline
 * produces an invalid Set-Cookie header that THROWS at the moment of login. Every sign-in path
 * calls setSessionCookie, so one mis-pasted variable locks every user out while the rest of the
 * site looks perfectly healthy — and the throw surfaces as a generic "login error" that says
 * nothing about the cause.
 *
 * An unusable value therefore degrades to the default name instead of taking authentication down.
 * Losing a custom cookie name is a cosmetic problem; being unable to issue sessions is not.
 */
function safeCookieName(raw: string | undefined): string {
  const v = (raw || '').trim();
  if (!v) return FALLBACK_COOKIE_NAME;
  if (!/^[A-Za-z0-9!#$%&'*+._|~^-]+$/.test(v)) {
    console.error('[auth/cookie] SESSION_COOKIE_NAME is not a valid cookie name; using the default. Check it for stray whitespace.');
    return FALLBACK_COOKIE_NAME;
  }
  return v;
}

const COOKIE_NAME = safeCookieName(process.env.SESSION_COOKIE_NAME);
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function setSessionCookie(cookies: AstroCookies, token: string, expiresAt: Date): void {
  cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    path: '/',
    expires: expiresAt
  });
}

export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    path: '/',
    maxAge: 0
  });
}

export function readSessionCookie(cookies: AstroCookies): string | null {
  return cookies.get(COOKIE_NAME)?.value ?? null;
}
