// How an applicant, partner or SAMARTH X candidate reaches their own record without an account.
//
// They receive a private link once: /samarth/r/<ref>?k=<token> (and the partner and X equivalents).
// Only a hash of the token is stored. On the first visit the token is moved out of the URL into an
// HttpOnly cookie scoped to this record and the page redirects to the clean URL, so the token does
// not linger in history, in screenshots, or in the Referer header sent to the payment provider.
// A lost link is replaced, never recovered: "resend my link" issues a new token by email.

import type { AstroCookies } from 'astro';
import { tokenMatches } from '@/lib/samarth/validate';

const MAX_AGE = 60 * 60 * 24 * 90; // 90 days

export const cookieName = (ref: string) => 'sam_' + String(ref || '').toLowerCase().replace(/[^a-z0-9]/g, '_');

export type AccessVerdict =
  | { ok: true; fromLink: boolean }
  | { ok: false };

/**
 * Check the visitor holds this record's token, from the link or from the cookie it was moved into.
 * When it came from the link the cookie is set; the caller should then redirect to the clean URL.
 */
export function checkAccess(cookies: AstroCookies, url: URL, ref: string, storedHash: string, secure: boolean): AccessVerdict {
  const fromQuery = url.searchParams.get('k');
  if (fromQuery && tokenMatches(fromQuery, storedHash)) {
    cookies.set(cookieName(ref), fromQuery, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE });
    return { ok: true, fromLink: true };
  }
  const fromCookie = cookies.get(cookieName(ref))?.value;
  if (fromCookie && tokenMatches(fromCookie, storedHash)) return { ok: true, fromLink: false };
  return { ok: false };
}

/** After a token was replaced (resend), the old cookie no longer matches and is simply ignored. */
export function setAccessCookie(cookies: AstroCookies, ref: string, token: string, secure: boolean): void {
  cookies.set(cookieName(ref), token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE });
}

export function isSecureRequest(url: URL): boolean {
  return url.protocol === 'https:';
}
