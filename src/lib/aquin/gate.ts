// src/lib/aquin/gate.ts — reading and writing an AquinTutor session, and guarding its admin.
//
// The thin layer between Astro and ./identity.ts. Everything here is about cookies and redirects;
// every decision about WHO somebody is and WHAT they may do lives in identity.ts, so a page cannot
// accidentally invent an authorisation by reading a cookie itself.

import type { APIContext, AstroCookies } from 'astro';
import { AQUIN_COOKIE, tenantForRequest, type Tenant } from './tenant';
import { aquinStore } from './store';
import { resolveAquinUser, mayOpenAquinAdmin, isAquinSuperAdmin, ANONYMOUS, type AquinPrincipal } from './identity';

export const AQUIN_ADMIN_LOGIN = '/aquintutor/admin/login';

export function readAquinCookie(cookies: AstroCookies): string | null {
  try { return cookies.get(AQUIN_COOKIE)?.value || null; } catch { return null; }
}

export function setAquinCookie(cookies: AstroCookies, token: string, expiresAt: Date): void {
  cookies.set(AQUIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    path: '/',
    expires: expiresAt,
  });
}

export function clearAquinCookie(cookies: AstroCookies): void {
  try { cookies.delete(AQUIN_COOKIE, { path: '/' }); } catch { /* already gone */ }
}

/**
 * Resolve the AquinTutor principal for a request.
 *
 * COSTS NOTHING WHEN NOBODY IS SIGNED IN TO AQUINTUTOR. No cookie means no database call at all,
 * which matters because this runs on every request to the whole site during the transition — and a
 * lookup per request for a product most visitors are not using is how the compute bill on this
 * project has been burned before.
 */
export async function resolveAquinPrincipal(context: APIContext): Promise<AquinPrincipal> {
  const token = readAquinCookie(context.cookies);
  if (!token) return ANONYMOUS;
  try {
    const store = await aquinStore();
    return await resolveAquinUser(store, token);
  } catch (e: any) {
    console.error('[aquin/gate] principal resolution failed:', e?.cause?.message || e?.message);
    // identity.ts already fails closed; this catch only covers the store not loading at all.
    return { ...ANONYMOUS, roles: [], capabilities: new Set(), degraded: true, reason: 'AquinTutor sign-in could not be checked.' };
  }
}

export interface AquinGate {
  ok: boolean;
  principal: AquinPrincipal;
  /** Set when the caller should be sent somewhere instead of being shown the page. */
  redirect: string | null;
  /** Set when the caller is signed in but not permitted — a sentence, not a code. */
  message: string | null;
}

/**
 * May this caller open the AquinTutor admin?
 *
 * THREE OUTCOMES, NOT TWO. Signed out is a redirect to the AquinTutor login. Signed in without an
 * administrative role is a refusal with a sentence. A DEGRADED lookup is also a refusal — but it
 * says the check failed rather than that the person is not allowed, because telling somebody they
 * lack permission during a database hiccup sends them to ask for access they already have.
 */
export async function requireAquinAdmin(context: APIContext, next?: string): Promise<AquinGate> {
  const principal = await resolveAquinPrincipal(context);
  const back = next || new URL(context.request.url).pathname;

  if (principal.degraded) {
    return {
      ok: false, principal, redirect: null,
      message: principal.reason || 'Your AquinTutor sign-in could not be checked just now. Nothing is wrong with your account — try again in a moment.',
    };
  }
  if (!principal.userId) {
    return { ok: false, principal, redirect: AQUIN_ADMIN_LOGIN + '?next=' + encodeURIComponent(back), message: null };
  }
  if (!mayOpenAquinAdmin(principal)) {
    return {
      ok: false, principal, redirect: null,
      message: 'This account is signed in to AquinTutor but holds no administrative role. '
        + 'An AquinTutor super admin can grant one; an EduRankAI account does not carry over.',
    };
  }
  return { ok: true, principal, redirect: null, message: null };
}

/** The super-admin-only gate, for the screens that decide who else may administer. */
export async function requireAquinSuperAdmin(context: APIContext, next?: string): Promise<AquinGate> {
  const gate = await requireAquinAdmin(context, next);
  if (!gate.ok) return gate;
  if (!isAquinSuperAdmin(gate.principal)) {
    return {
      ok: false, principal: gate.principal, redirect: null,
      message: 'Only an AquinTutor super admin can open this. Administrators cannot appoint administrators, which is the whole difference between the two roles.',
    };
  }
  return gate;
}

/** The tenant for this request, for a page that needs to know which product it is serving. */
export function tenantOf(context: APIContext): Tenant {
  return tenantForRequest(context.request);
}
