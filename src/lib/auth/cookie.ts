import type { AstroCookies } from 'astro';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'edurankai_session';
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
