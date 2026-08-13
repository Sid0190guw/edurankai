// src/lib/aquin/tenant.ts — which product is this request for?
//
// =================================================================================================
// THE ONE DECISION EVERYTHING ELSE HANGS OFF
// =================================================================================================
//
// AquinTutor now has its own domain, aquintutor.com, and is to become its own system: its own user
// accounts, its own administrators, its own idea of who may do what. For a while it shares this
// Supabase database, and later it will not.
//
// Sharing a database is survivable. Sharing an IDENTITY is not — and that is the failure this file
// exists to prevent. Both products currently resolve a caller from the same `sessions` and `users`
// tables through one cookie. If aquintutor.com kept doing that, then:
//
//   - an EduRankAI super admin would silently be an AquinTutor super admin, and the reverse;
//   - revoking somebody on one domain would leave them signed in on the other;
//   - and the eventual separation would not be a migration, it would be an unpicking, because no
//     row anywhere would record which product a person actually belonged to.
//
// So the boundary is drawn HERE, at the front door, before any lookup happens, and it is drawn on
// the HOST rather than on the path. A host cannot be forged by a link.
//
// =================================================================================================
// WHY NOT JUST CHECK THE PATH
// =================================================================================================
//
// /aquintutor/* has served AquinTutor from edurankai.in for months and must keep working while the
// domains run side by side. But a path is chosen by whoever writes the URL: if the tenant came from
// the path, then edurankai.in/aquintutor/admin would be an AquinTutor admin surface reachable with
// an EduRankAI session, which is precisely the leak. The path therefore selects a SURFACE; the host
// selects the IDENTITY DOMAIN. They are different questions and this module keeps them apart.

export type Tenant = 'edurankai' | 'aquintutor';

/** Hosts that are AquinTutor's own. Matched exactly, and on the bare host with any port removed. */
const AQUIN_HOSTS = new Set<string>([
  'aquintutor.com',
  'www.aquintutor.com',
  'aquintutor.in',
  'www.aquintutor.in',
]);

/** Hosts that are EduRankAI's own. */
const ERA_HOSTS = new Set<string>([
  'edurankai.in',
  'www.edurankai.in',
  'edurankai.com',
  'www.edurankai.com',
]);

/**
 * A preview or local host carries no product identity of its own, so it needs a default. It is
 * EduRankAI, because that is what every existing deployment already is and a silent change of
 * identity domain on preview would be the worst place to discover this file.
 */
export const DEFAULT_TENANT: Tenant = 'edurankai';

/** Strip the port and lowercase. `Host` arrives as `example.com:4321` in dev and behind proxies. */
export function normaliseHost(raw: string | null | undefined): string {
  const h = String(raw || '').trim().toLowerCase();
  if (!h) return '';
  // IPv6 literals arrive bracketed — [::1]:4321 — so the port split must not eat the address.
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return close === -1 ? h : h.slice(0, close + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * Which identity domain does this host belong to?
 *
 * UNKNOWN HOSTS ARE NOT AQUINTUTOR. A preview URL, a bare IP, a misconfigured proxy — none of them
 * may be treated as the new product, because the direction of the mistake matters: wrongly treating
 * a request as EduRankAI shows a login page, while wrongly treating it as AquinTutor would hand a
 * brand-new identity domain to whatever host happened to resolve.
 */
export function tenantForHost(host: string | null | undefined): Tenant {
  const h = normaliseHost(host);
  if (!h) return DEFAULT_TENANT;
  if (AQUIN_HOSTS.has(h)) return 'aquintutor';
  if (ERA_HOSTS.has(h)) return 'edurankai';

  // A subdomain of an AquinTutor apex is AquinTutor: app.aquintutor.com, admin.aquintutor.com.
  // Checked with a leading dot so `notaquintutor.com` cannot match by suffix.
  for (const apex of ['aquintutor.com', 'aquintutor.in']) {
    if (h.endsWith('.' + apex)) return 'aquintutor';
  }
  return DEFAULT_TENANT;
}

/** The tenant for a whole request, read from the Host header. */
export function tenantForRequest(request: Request): Tenant {
  return tenantForHost(request.headers.get('host'));
}

// -------------------------------------------------------------------------------------------------
// Cookies. SEPARATE NAMES ARE THE MECHANISM, not a nicety.
// -------------------------------------------------------------------------------------------------
//
// Two products on two domains could share a cookie name without colliding, because cookies are
// scoped by host anyway. They get different names regardless, so that a session issued by one can
// never be READ by the other even when both are served from a single origin during the transition
// — which is exactly the situation edurankai.in/aquintutor/* is in today.

export const ERA_COOKIE_FALLBACK = 'edurankai_session';
export const AQUIN_COOKIE = 'aquin_session';

export function sessionCookieName(tenant: Tenant): string {
  return tenant === 'aquintutor' ? AQUIN_COOKIE : (process.env.SESSION_COOKIE_NAME || ERA_COOKIE_FALLBACK);
}

/**
 * Is this surface part of AquinTutor, judged by path?
 *
 * Used for CHOOSING A LAYOUT AND A NAV, never for choosing an identity. See the header: a path is
 * whatever the link said.
 */
export function isAquinPath(pathname: string): boolean {
  const p = String(pathname || '');
  return p === '/aquintutor' || p.startsWith('/aquintutor/');
}

/**
 * Where a signed-out visitor to this tenant is sent.
 *
 * Deliberately different pages: AquinTutor's own login must never be EduRankAI's, or the separation
 * ends at the first expired session.
 */
export function loginPathFor(tenant: Tenant, next?: string): string {
  const base = tenant === 'aquintutor' ? '/aquintutor/login' : '/admin/login';
  return next ? base + '?next=' + encodeURIComponent(next) : base;
}
