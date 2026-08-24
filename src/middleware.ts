import { defineMiddleware } from 'astro:middleware';
import { validateSessionToken } from '@/lib/auth/session';
import { readSessionCookie, setSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
// A DATABASE THAT WILL NOT ANSWER MUST PRODUCE A PAGE, NOT A GATEWAY TIMEOUT.
//
// Every gate below awaits the database, and none of them were bounded. postgres-js has no query
// timeout, so when the transaction pooler accepts the connection and then never answers -- the
// documented failure of 2026-08-23, and the shape of the /admin 504s -- these awaits never settled
// and Vercel killed the function. The visitor got FUNCTION_INVOCATION_TIMEOUT from the platform;
// nothing in the application ever decided anything.
//
// Bounded, they fail CLOSED and they fail FAST, which is the only honest answer: we cannot verify
// who you are, so nothing is served and nothing is assumed. Deliberately not a redirect: sending an
// unverifiable session to /admin/login would sign people out over a five-second blip, and the login
// page needs the same database to do anything useful anyway.
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';
import { getViewableSectionKeys, can } from '@/lib/auth/permissions';
import { canOpenAdmin } from '@/lib/auth/admin-access';
import { logEvent } from '@/lib/logger';
// The AquinTutor scope -> panel table, imported rather than written out again. /portal resolves the
// landing for the same people with the same table (src/lib/workforce/landing.ts), so the door and the
// landing cannot come to disagree about where a teacher belongs. That module's top level is a plain
// array and a type import — it opens no database connection and pulls no page code into the
// middleware bundle; everything that touches the database in it is behind a dynamic import.
import { aquinPanelFor } from '@/lib/workforce/landing';
// The application gate. DB-free by construction — see the note at the call site, and the header of
// src/lib/talent/gate-pass.ts, for why this is not imported from src/lib/talent/gateway.ts.
import { applyGateRedirect, GATE_COOKIE } from '@/lib/talent/gate-pass';

// Every /admin path except this one must pass canOpenAdmin. Exactly one exemption, matched exactly:
// a prefix test here would let /admin/login-anything through, and a second entry is how an unguarded
// path gets added later "just for a moment".
const ADMIN_GUARD_EXEMPT = '/admin/login';
// Repeated slashes are collapsed before the test. `//admin/users` is the same resource to a router
// but a different string to startsWith(), and "the guard did not recognise the path" is exactly how
// a deny-by-default gate turns back into allow-by-default. Both the match AND the exemption use the
// normalised form, so `//admin/login` is still the login page and the hardening locks nobody out.
const normalisePath = (path: string): string => String(path || '').replace(/\/{2,}/g, '/');
function isAdminPath(path: string): boolean {
  const p = normalisePath(path);
  return p === '/admin' || p.startsWith('/admin/');
}
/** The single exemption, matched exactly (never by prefix) on the normalised path. */
function isAdminGuardExempt(path: string): boolean {
  return normalisePath(path) === ADMIN_GUARD_EXEMPT;
}
/**
 * An admin path asked for by somebody with NO valid session.
 *
 * canOpenAdmin cannot answer for a request that has no user, and the code below returns early for
 * both "no cookie" and "cookie no longer valid" — so without this the structural gate covers only
 * signed-in people, and the guarantee it advertises (a new admin page is protected the day it is
 * written) does not hold for an anonymous visitor. Today every admin page but the login screen
 * renders inside AdminLayout, which redirects a signed-out user itself; that redirect runs AFTER the
 * page's own frontmatter, so the queries still execute, and a page written next month that renders
 * its own shell would have served its content outright.
 *
 * Same destination as AdminLayout's redirect, so the two never disagree.
 */
function signedOutAdminRedirect(path: string): Response | null {
  if (!isAdminPath(path) || isAdminGuardExempt(path)) return null;
  return new Response(null, { status: 302, headers: { Location: '/admin/login', 'cache-control': 'no-store' } });
}

// Map an /admin/* path to its permission section key (longest-prefix wins).
// Universal/auth paths (dashboard, mail, notifications, login, logout) are not
// listed -> never gated. Unmapped admin paths fall through (allowed).
const PATH_SECTION: [string, string][] = ([
  // TALENT-TO-ORGANIZATION. The four desks are gated separately from the console itself, so the
  // hiring desk cannot reach the access engine (spec section 35). Order here is irrelevant — the
  // `.sort()` at the end of this array makes the longest prefix win — but the SPECIFIC entries are
  // load-bearing: without them every one of these subtrees resolves to 'talent', which `recruiter`
  // and `reviewer` hold.
  ['/admin/talent/access', 'talent_access'],
  ['/admin/talent/identity', 'talent_identity'],
  ['/admin/talent/onboarding', 'talent_onboarding'],
  ['/admin/talent/codes', 'talent_onboarding'],
  ['/admin/talent/selected', 'talent_onboarding'],
  ['/admin/talent', 'talent'],
  ['/admin/applications', 'applications'],
  ['/admin/help', 'messages'],
  ['/admin/messages', 'dms'],
  ['/admin/chat', 'discussion'],
  ['/admin/offer/blank', 'custom_offer'],
  ['/admin/offers', 'offers'],
  ['/admin/offer', 'offers'],
  // HORIZON — the assembled employee intelligence record (PATCH-11). Mapped to `employees` rather
  // than a section key of its own: a new section key would add a row to the role-permission matrix,
  // which is a policy change, and this surface is strictly narrower than the employee desk already
  // is. The page then asks for `people.view_360` in its own frontmatter and gates each of its twelve
  // tabs separately, so this entry is the outer door and not the whole lock.
  ['/admin/horizon', 'employees'],
  ['/admin/hr/employees', 'employees'],
  ['/admin/hr/leave', 'leave'],
  ['/admin/hr/attendance', 'attendance'],
  ['/admin/hr/payroll', 'payroll'],
  ['/admin/hr/payouts', 'payouts'],
  ['/admin/hr/training', 'training'],
  ['/admin/hr', 'hr'],
  ['/admin/finance', 'finance'],
  ['/admin/interviews/manual', 'interviews_manual'],
  ['/admin/interviews/ai', 'interviews_ai'],
  ['/admin/ai-interview-templates', 'interviews_ai'],
  ['/admin/interviews', 'interviews'],
  ['/admin/tests/attempts', 'tests_proctoring'],
  ['/admin/tests', 'tests'],
  ['/admin/identity-verifications', 'tests_proctoring'],
  ['/admin/aquintutor', 'lms'],
  ['/admin/schools', 'lms'],
  ['/admin/courses', 'lms'],
  ['/admin/paths', 'lms'],
  ['/admin/instructors', 'lms'],
  ['/admin/hei/entity-types', 'hei_entity_types'],
  ['/admin/hei/import', 'hei_import'],
  ['/admin/hei/submetrics', 'hei_submetrics'],
  ['/admin/hei/v1-methodology', 'hei_v1'],
  ['/admin/hei/stories', 'hei_stories'],
  ['/admin/hei/claims', 'hei_claims'],
  ['/admin/hei/submissions', 'hei_submissions'],
  ['/admin/hei/findings', 'hei_findings'],
  ['/admin/hei/institutions', 'hei_institutions'],
  ['/admin/hei', 'hei_institutions'],
  ['/admin/team/roles', 'team_roles'],
  ['/admin/roles', 'roles'],
  ['/admin/departments', 'departments'],
  ['/admin/events', 'events'],
  ['/admin/forms', 'content'],
  ['/admin/products', 'products'],
  ['/admin/content', 'content'],
  ['/admin/users', 'users'],
  ['/admin/analytics', 'audit'],
  // WORKFORCE ANALYTICS IS NOT WEBSITE ANALYTICS, AND THE DOOR HAD THE WRONG KEY ON IT.
  //
  // '/admin/analytics' is the WEBSITE traffic console and 'audit' is the right section for it. But
  // the prefix match above also covered /admin/analytics/workforce, whose capability
  // (`analytics.view`) is documented in permissions.ts and registry.ts as being held by super_admin
  // AND hr — and `hr` does not hold the 'audit' section in ROLE_SECTIONS. So every hr account was
  // bounced to /admin?denied=audit before the page's own gate ever ran, while the page's header
  // said middleware had no key for that path at all.
  //
  // Longest-prefix wins (the sort below), so these two entries take precedence over the line above
  // for exactly these two subtrees and change nothing about the traffic console. 'hr' is the section
  // whose built-in holders — super_admin (unrestricted) and hr — are precisely the holders of
  // `analytics.view`, so the door now admits the population the capability was written for and the
  // capability check on the page stays the real lock. A custom role granted `analytics.view` but not
  // the 'hr' section is still refused here; that is the fail-closed direction and it is worth a
  // decision on the record rather than a wider prefix.
  ['/admin/analytics/workforce', 'hr'],
  ['/admin/analytics/domains', 'hr'],
  ['/admin/audit', 'audit'],
  ['/admin/settings', 'settings'],
  ['/admin/diagnostics', 'settings'],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);

function resolveAdminSection(path: string): string | null {
  for (const [prefix, key] of PATH_SECTION) {
    if (path === prefix || path.startsWith(prefix + '/')) return key;
  }
  return null;
}

// Paths that ALWAYS bypass the face-enrollment gate.
// Login surfaces + enrollment surfaces + APIs + public marketing all skip the gate.
function isExempt(path: string): boolean {
  if (!path) return true;
  if (path.startsWith('/api/')) return true;
  if (path.startsWith('/_astro/')) return true;
  if (path.startsWith('/favicon')) return true;
  if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/manifest.webmanifest' || path === '/sw.js') return true;
  // Auth + enrollment surfaces
  if (path === '/enroll-face') return true;
  if (path === '/portal/face-setup') return true;
  if (path === '/portal/enroll-face') return true;
  if (path === '/identity-setup') return true;
  if (path === '/verify-by-questions') return true;
  if (path === '/forgot-password') return true;
  // The redemption surface for the emailed one-time reset link. It must be reachable by someone who
  // is signed out and, by definition, has no face enrolment — the gate below would otherwise bounce
  // the one page that gets them back in. It reads nothing but the token and grants no access.
  if (path === '/reset-password') return true;
  if (path === '/admin/login' || path === '/portal/login' || path === '/hei/login') return true;
  if (path === '/aquintutor/login' || path === '/aquintutor/signup') return true;
  if (path === '/portal/signup' || path === '/portal/forgot') return true;
  if (path === '/hei/register' || path === '/hei/claim') return true;
  if (path.startsWith('/portal/claim/')) return true;
  if (path === '/logout' || path === '/portal/logout' || path === '/admin/logout' || path === '/hei/logout') return true;
  // THE SIGN-OUT CONFIRMATION MUST BE EXEMPT TOO, or the gate below eats the way out.
  //
  // /portal/logout stopped answering GET with a session delete (a GET that destroys state gets fired
  // by a prefetch or a link preview) and now redirects to /portal/sign-out, which carries the POST
  // button. But /portal/sign-out matches isProtected() via the `/portal/` prefix and was not listed
  // here, so a signed-in user WITHOUT a face enrollment was bounced off it to /enroll-face — and
  // /enroll-face's own "Sign out" is a plain link to /portal/login that clears nothing. That account
  // had no way to end its session at all: every portal page is face-gated, so the drawer holding the
  // POST button is unreachable, and typing /portal/logout — which used to work, because it is
  // exempt and used to sign you out on the GET — now lands on a page the gate refuses.
  //
  // Exempting it is safe: the page reads Astro.locals.user, which middleware sets only from an
  // already-validated session, and shows that person their own name and address and nothing else.
  // It grants no access to any surface; it is the door out.
  if (path === '/portal/sign-out') return true;
  return false;
}

// Pages that require a face-enrolled, 2FA-protected session.
// Anything starting with these triggers the gate.
function isProtected(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('/admin/')) return true;
  if (path === '/admin') return true;
  if (path.startsWith('/portal/')) return true;
  if (path === '/portal') return true;
  if (path.startsWith('/hei/portal')) return true;
  return false;
}

// Individual virtual-lab pages require a signed-in account to OPEN. The labs
// catalogue (/aquintutor/labs) stays public for discovery; opening any specific
// lab (/aquintutor/labs/<slug>) needs sign-in. Embedded labs inside a lesson
// still load because the signed-in learner's cookie rides the same-origin frame.
// TEMPORARY: the labs are open to everyone (no sign-in) while we gather user
// feedback. Flip LABS_PUBLIC back to false to restore the login gate.
const LABS_PUBLIC = true;
function isGatedLab(path: string): boolean {
  if (!path) return false;
  if (LABS_PUBLIC) return path.startsWith('/aquintutor/teach'); // keep only the teacher console gated
  if (path === '/aquintutor/labs' || path === '/aquintutor/labs/') return false;
  // Every individual lab + the advanced simulators require sign-in so the work
  // can't be copied by anonymous visitors. The catalogue index stays public.
  return path.startsWith('/aquintutor/labs/')
    || path.startsWith('/aquintutor/quantum/')
    || path.startsWith('/aquintutor/hpc/')
    || path.startsWith('/aquintutor/teach');
}

// THREE ANSWERS, NOT TWO. `catch (_) { return false }` meant an unreachable database read as "this
// person has not enrolled a face", and the gate below then bounced EVERY signed-in user -- staff and
// applicants alike -- to face enrollment, a page that needs the same database to enroll anything. A
// database blip became a site-wide dead end. 'unknown' is now its own answer and the gate refuses
// rather than redirects.
type FaceState = 'enrolled' | 'absent' | 'unknown';
async function hasFaceEnrolled(userId: string): Promise<FaceState> {
  try {
    const r = await withDbTimeout(
      db.execute(sql`SELECT id FROM user_face_enrollments WHERE user_id = ${userId} AND is_active = true LIMIT 1`),
      'middleware.faceEnrolled');
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    return rows.length > 0 ? 'enrolled' : 'absent';
  } catch (e: any) {
    if (isDbUnavailable(e)) return 'unknown';
    // A real query error (a missing table on a fresh database) is still "not enrolled", which is what
    // this has always done and what keeps first-run enrollment reachable.
    return 'absent';
  }
}

/**
 * The one response for "we could not reach the database".
 *
 * 503 with Retry-After, never a redirect: a redirect to any page that also needs the database is how
 * a database outage becomes ERR_TOO_MANY_REDIRECTS on top of an outage. no-store so a CDN cannot pin
 * it after the database recovers. The text says what is actually true, because "something went wrong"
 * has cost this project hours before.
 */
function dbUnavailable(where: string): Response {
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'error', event: 'middleware.db_unavailable', gate: where,
  }));
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Temporarily unavailable</title>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0b0f;color:#e7e7ea;'
    + 'display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}div{max-width:34rem}'
    + 'h1{font-size:1.25rem;margin:0 0 .75rem}p{line-height:1.6;color:#9aa6b6;margin:0 0 .75rem}'
    + 'a{color:#FF7040}</style>'
    + '<div><h1>We cannot reach the database right now</h1>'
    + '<p>Your sign-in could not be verified, so nothing is being shown rather than something wrong. '
    + 'This is a database problem on our side, not a problem with your account.</p>'
    + '<p><a href="">Try again</a></p></div>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '15', 'cache-control': 'no-store' } });
}

// Public pages safe to edge-cache for ANONYMOUS visitors so repeat hits are served
// from the CDN and never touch the database. Excludes auth, forms (contact/apply/waiver),
// portal, and admin — those stay dynamic/private. Signed-in users never hit this
// path (they carry a session token), and Vary:Cookie keeps the two apart.
const PUBLIC_CACHEABLE_EXACT = new Set([
  '/', '/careers', '/about', '/research', '/team', '/ecosystem',
  '/developers', '/faq', '/accessibility', '/policy', '/hei', '/events',
  '/resume',
]);
function isPublicCacheable(path: string): boolean {
  if (!path) return false;
  if (PUBLIC_CACHEABLE_EXACT.has(path)) return true;
  if (path.startsWith('/policy/')) return true;
  // Public venture/product detail pages — content is the same for everyone.
  if (/^\/ecosystem\/[^/]+$/.test(path)) return true;
  // Public role-detail pages (job descriptions); the two form pages stay dynamic.
  if (/^\/careers\/[^/]+$/.test(path) && path !== '/careers/fee-waiver' && path !== '/careers/hr-support') return true;
  return false;
}

export const onRequest = defineMiddleware(async (context, next) => {
  // NORMALISED ONCE, HERE, AND EVERY GATE BELOW READS THIS VALUE.
  //
  // normalisePath() was added for the canOpenAdmin gate alone, and the four other gates in this file
  // kept testing the raw pathname with startsWith('/admin/') — so `//admin/finance` reached
  // canOpenAdmin (which normalises) but slipped past the applicant bounce, the AquinTutor-scope
  // bounce, the PATH_SECTION permission gate and the face-enrolment gate, all of which compared the
  // raw string. A gate that does not recognise the path is a gate that admits, and collapsing the
  // slashes in one place is the only way the five cannot disagree about which path they are judging.
  //
  // Nothing downstream sees a rewritten request: next() still runs against context.request. This
  // value is used only to DECIDE, and for the `next=` parameter on the sign-in redirects, where the
  // collapsed form is the one that should be returned to anyway.
  const path = normalisePath(new URL(context.request.url).pathname);

  // ===============================================================================================
  // THE APPLICATION GATE — /apply/* AND /onboarding/* ARE UNREACHABLE WITHOUT A GATE PASS
  // ===============================================================================================
  //
  // FIRST, ON PURPOSE, BEFORE THE SESSION IS EVEN RESOLVED. The gate covers external candidates who
  // have no account at all AND serving employees who do, so it cannot live behind any of the
  // signed-in branches below — three of which return early. An internal applicant with a private
  // entrance is exactly how an internal hire ends up with no application record, no evaluation trail
  // and no selection decision.
  //
  // IT ALSO KEEPS THE TWO DOORS APART. A pass earned by declaring "I have no code" must never reach
  // /onboarding — that would be direct onboarding with no selection behind it — and a pass earned
  // WITH a code must not wander into the ordinary application flow, which is how one hire acquires
  // both a selection and a contradictory application. applyGateRedirect() owns both rules.
  //
  // IMPORTED FROM './gate-pass', NOT FROM './gateway'. gateway.ts reaches the tal_* tables, which
  // pulls src/lib/db — postgres-js plus the whole Drizzle schema — into a bundle that runs on EVERY
  // request. gate-pass.ts imports nothing but node:crypto. This is the same trap this file already
  // documents for the AquinTutor landing table.
  //
  // THE GATE IS NOT THE ONLY LOCK. Middleware sees PAGE requests; `/api/*` is not behind the /admin
  // gate in this codebase, so the endpoint that actually creates an application calls
  // requireGatePass() itself and refuses rather than redirects.
  const applyGate = applyGateRedirect(path, context.cookies.get(GATE_COOKIE)?.value ?? null);
  if (applyGate) return applyGate;

  // ===============================================================================================
  // AQUINTUTOR'S OWN PRINCIPAL, RESOLVED BEFORE ANYTHING ELSE AND KEPT SEPARATE FROM `user`
  // ===============================================================================================
  //
  // aquintutor.com is its own product with its own accounts (docs/aquintutor-independence.md). It
  // carries its own cookie and its own aq_* tables, and NOTHING below may treat one identity as a
  // fallback for the other — an EduRankAI super admin has no standing on AquinTutor until somebody
  // creates them an account there.
  //
  // Set here, once, so it exists on EVERY path out of this middleware. Three of the branches below
  // return early after setting locals.user = null, and a field that is only assigned on the long
  // path is a field that reads `undefined` on exactly the requests nobody tested.
  //
  // COSTS NOTHING WHEN THE COOKIE IS ABSENT. No AquinTutor cookie means no lookup at all, which
  // matters while both products share one deployment: a database call per request for a product
  // most visitors are not using is how the compute bill here has been burned before.
  context.locals.aquin = null;
  try {
    const { readAquinCookie, resolveAquinPrincipal } = await import('@/lib/aquin/gate');
    if (readAquinCookie(context.cookies)) {
      context.locals.aquin = await resolveAquinPrincipal(context as any);
    }
  } catch (e: any) {
    // Never fatal to the request. resolveAquinPrincipal already fails closed on its own errors; this
    // covers the module itself failing to load, which must not take the whole site down.
    console.error('[middleware] AquinTutor principal could not be resolved:', e?.cause?.message || e?.message);
  }

  // FEATURES THAT ARE NOT OPEN YET — answered here, before any database work, so that EVERY door
  // into a held-back feature gets the same answer: a nav entry, a deep link, an old bookmark, a link
  // somebody pasted into a chat months ago.
  //
  // Doing this per page is how a paused feature stays half-live. This product has already shipped a
  // messaging path that threw on every send for four months while the screen looked entirely normal,
  // and the reason nobody noticed is that the failure was in one place and the doors were in six.
  //
  // A REDIRECT, NOT A 404. The feature is being finished, not removed, and telling somebody their
  // page does not exist when it does is a lie that costs a support message. /upcoming says which
  // feature, why, and what to do instead.
  //
  // GETs only: a POST to a held-back endpoint should fail as a POST rather than be bounced to a page
  // that will look like a success in a fetch handler.
  if (context.request.method === 'GET') {
    const { upcomingForPath } = await import('@/lib/upcoming');
    const held = upcomingForPath(path);
    if (held) {
      return context.redirect('/upcoming?f=' + encodeURIComponent(held.key), 302);
    }
  }

  // CIRCUIT BREAKER — answered before any database work, deliberately.
  //
  // sos.js v5 registered a new geolocation watcher every 60 seconds and never cleared any of them,
  // so a single tab left open accumulated watchers and POSTed here on every GPS tick from each one.
  // Each POST paid a session lookup in this middleware, which exhausted the connection pool, which
  // made the session query itself fail — and once THAT fails every authenticated page returns 500.
  // The apply flow and the admin application view both went down from a location beacon.
  //
  // v6 fixes the leak, but a browser tab opened before the fix keeps running v5 and cannot be
  // reached by deploying. So the endpoint is retired at the edge of the request: 410 costs no
  // connection, which lets the pool recover while old tabs drain. sos.js v6+ sends at most one
  // update per minute and stops on 410.
  //
  // Remove this block only when v5 traffic has stopped appearing in the logs.
  if (path === '/api/location/update') {
    return new Response(JSON.stringify({ ok: false, retired: true }), {
      status: 410,
      headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // Viśvambhara deep modules ALWAYS require sign-in + admin approval. Handled
  // first so unauthenticated visitors are bounced to the access page instead
  // of seeing raw HTML.
  if (path.startsWith('/visvambhara/')) {
    const tokenEarly = readSessionCookie(context.cookies);
    let userEarly: any = null;
    if (tokenEarly) {
      // Bounded like the main path below. A timeout here redirects to the access page rather than
      // hanging; this branch already fails closed on every other error.
      const v = await withDbTimeout(validateSessionToken(tokenEarly), 'middleware.session.visvambhara')
        .catch(() => null);
      if (v) userEarly = v.user;
    }
    if (!userEarly) {
      return new Response(null, { status: 302, headers: { Location: '/products/visvambhara/access' } });
    }
    try {
      const { hasApprovedAccess } = await import('@/lib/visvambhara-access');
      // Non-applicant staff (admins, HR, editors) can always view internal research.
      if (userEarly.role === 'applicant') {
        const ok = await hasApprovedAccess(userEarly.id);
        if (!ok) return new Response(null, { status: 302, headers: { Location: '/products/visvambhara/access' } });
      }
    } catch (_) { /* fail-closed: redirect rather than leak */
      return new Response(null, { status: 302, headers: { Location: '/products/visvambhara/access' } });
    }
  }

  // Partner LMS embedding: a valid signed embed_token lets a specific lab load
  // without a login (used by universities iframing our labs via the v1 API).
  async function gatedLabAllowedByEmbed(): Promise<boolean> {
    if (!isGatedLab(path)) return false;
    try {
      const tok = new URL(context.request.url).searchParams.get('embed_token') || '';
      if (!tok) return false;
      const slug = path.split('/').filter(Boolean).pop() || '';
      const { verifyEmbedToken } = await import('@/lib/api-keys');
      return verifyEmbedToken(slug, tok);
    } catch (_) { return false; }
  }

  const token = readSessionCookie(context.cookies);
  if (!token) {
    context.locals.user = null;
    context.locals.session = null;
    // No cookie at all. Deny by default reaches nobody-at-all too — see signedOutAdminRedirect.
    const anonAdmin = signedOutAdminRedirect(path);
    if (anonAdmin) return anonAdmin;
    if (isGatedLab(path) && !(await gatedLabAllowedByEmbed())) return new Response(null, { status: 302, headers: { Location: '/aquintutor/login?next=' + encodeURIComponent(path) } });
    // Anonymous + public page -> let the CDN cache it so repeat hits never touch the database.
    if (context.request.method === 'GET' && isPublicCacheable(path)) {
      const res = await next();
      // Never CDN-cache a DEGRADED render (a DB hiccup that emptied the page): otherwise that broken
      // response gets pinned at the edge for up to 15 min even after the DB recovers. A page signals
      // degradation by setting the 'x-era-degraded' header when a data query failed.
      if (res.headers.get('x-era-degraded')) {
        res.headers.set('Cache-Control', 'no-store');
        res.headers.delete('x-era-degraded');
      } else {
        res.headers.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=900');
      }
      res.headers.set('Vary', 'Cookie');
      return res;
    }
    return next();
  }
  // BOUNDED, AND A TIMEOUT IS NOT THE SAME AS AN INVALID SESSION. Falling into the !result branch on
  // an unreachable database would clear a perfectly good cookie and sign the whole company out over
  // a pooler hiccup, so the two outcomes are kept apart: no session is a redirect, no answer is a 503.
  let result: Awaited<ReturnType<typeof validateSessionToken>>;
  try {
    result = await withDbTimeout(validateSessionToken(token), 'middleware.session');
  } catch (e: any) {
    if (isDbUnavailable(e)) {
      // A PAGE THAT NEEDS NO USER MUST STAY REACHABLE WHILE THE DATABASE IS NOT.
      //
      // This gate only runs for somebody who already HOLDS a session cookie — an anonymous visitor
      // returned above and never gets here — so a bare 503 here locked exactly the wrong person out
      // of exactly the wrong doors: signing out, /api/health in a browser, the reset and enrolment
      // surfaces. Every one of those is on the exemption list precisely because it does not need to
      // know who you are, and every one of them was answering 503 to the admin trying to diagnose
      // the outage while answering 200 to a signed-out stranger.
      //
      // So: for an exempt path, an unreachable database is treated as no session rather than as a
      // refusal. Nothing is granted by this — locals.user stays null, so any page that does need a
      // user still finds none, and isProtected() below still guards what it always guarded.
      if (isExempt(path)) {
        console.warn('[middleware] session unreadable on exempt path, continuing anonymous:', path);
        context.locals.user = null;
        context.locals.session = null;
        return next();
      }
      return dbUnavailable('session');
    }
    // Any other failure is treated as it always was: no valid session.
    console.error('[middleware] session validation failed', e?.cause?.message || e?.message);
    result = null as any;
  }
  if (!result) {
    clearSessionCookie(context.cookies);
    context.locals.user = null;
    context.locals.session = null;
    // Expired or revoked session. The cookie has just been cleared above; /admin/login is exempt, so
    // the very next request renders the sign-in form normally and nobody can be stuck in a loop.
    const staleAdmin = signedOutAdminRedirect(path);
    if (staleAdmin) return staleAdmin;
    if (isGatedLab(path) && !(await gatedLabAllowedByEmbed())) return new Response(null, { status: 302, headers: { Location: '/aquintutor/login?next=' + encodeURIComponent(path) } });
    return next();
  }
  setSessionCookie(context.cookies, token, result.session.expiresAt);
  context.locals.user = result.user;

  // Belt-and-braces auto-promote: any applicant who is still on
  // access_status='pending' gets promoted on EVERY page load. Account
  // creation is free and the application fee is the only paid step, so
  // pending = approved for applicants. This catches every race / fallback
  // path where the post-signup UPDATE didn't fire, so admins never have to
  // hand-click Approve on applicant accounts ever again.
  // Run the promote at most ONCE per user per browser (cookie guard) instead of a
  // write on every request. Already-approved applicants then make zero writes on
  // navigation, so the database stays idle. The WHERE clause still no-ops safely.
  if (result.user.role === 'applicant' && context.cookies.get('era_appr')?.value !== result.user.id) {
    try {
      await db.execute(sql`UPDATE users SET access_status = 'approved', updated_at = NOW() WHERE id = ${result.user.id} AND access_status = 'pending'`);
    } catch (_) { /* never block the request on this */ }
    try { context.cookies.set('era_appr', result.user.id, { path: '/', maxAge: 60 * 60 * 24 * 30, httpOnly: true, sameSite: 'lax' }); } catch (_) {}
  }
  context.locals.session = result.session;

  // Applicants get full access only in the application portal, never the admin
  // panel. Central guard (complements per-page checks).
  if (result.user.role === 'applicant' && path !== '/admin/login' && (path === '/admin' || path.startsWith('/admin/'))) {
    return new Response(null, { status: 302, headers: { Location: '/portal' } });
  }

  // AquinTutor partner / teacher / moderator scopes are confined to their own
  // panel: any signed-in role WITHOUT the admin.access permission is bounced off
  // the main EduRankAI admin to /aquintutor/admin. Internal staff (super_admin,
  // hr, editor, ...) all hold admin.access, so this only affects partner scopes.
  // AquinTutor scopes (partner / teacher / moderator) are confined to the
  // AquinTutor panel and NEVER touch /admin — not even the course-authoring tools,
  // because those render inside the EduRankAI admin shell (which exposes the
  // company's other projects: applications, mail, finance, HR). Their own course
  // management lives under /aquintutor/admin/*. Internal staff hold admin.access
  // and are unaffected.
  if (result.user.role !== 'applicant' && (path === '/admin' || path.startsWith('/admin/'))
      && path !== '/admin/login' && path !== '/admin/logout'
      && !can(result.user as any, 'admin.access')) {
    // Same table /portal lands these accounts with. It used to be a ternary written out here and
    // nowhere else, which meant /portal had no way to send a teacher to their own console and simply
    // rendered them the applicant portal instead — the wrong surface, live today. One definition, two
    // consumers, and the answer cannot drift between them.
    return new Response(null, { status: 302, headers: { Location: aquinPanelFor(result.user.role as string) } });
  }

  // DENY BY DEFAULT — the structural gate, and the only one that a NEW admin page cannot forget.
  //
  // Everything above this line is a rule about a role someone thought of: applicants go to /portal,
  // AquinTutor scopes go to their own panel. This one is the opposite shape. It asks canOpenAdmin
  // (src/lib/auth/admin-access.ts) whether this person may open an admin surface AT ALL, and the
  // default answer there is no. That matters because the escalation it exists to stop was not an
  // unhandled role: 'editor' was handled, held admin.access legitimately, and was handed to every
  // intern who signed an offer letter.
  //
  // Being here rather than in a page or a layout is the whole point. AdminLayout's intern check runs
  // only for pages that use AdminLayout; a page written next month that renders its own shell, or an
  // endpoint under /admin/api/*, is covered by this the day it is written rather than the day someone
  // notices. It also refuses BEFORE the page's frontmatter runs, so nothing sensitive is queried, let
  // alone rendered.
  //
  // /admin/login is the single exemption — gating it would lock everyone out of signing in. Note that
  // /admin/logout is NOT exempt: a refused person is bounced with their session intact and signs out
  // at /logout or /portal/logout, which is a smaller cost than a second hole in the guard.
  //
  // WHY THIS CANNOT LOOP WITH /portal, stated here as well as there because a redirect pair is only
  // safe if BOTH ends know the rule. This block sends /admin -> /portal when
  // canOpenAdmin(user).allowed is FALSE. src/lib/workforce/landing.ts — the only thing that redirects
  // /portal -> /admin — sends them the other way when the SAME call on the SAME user object is TRUE.
  // The two conditions are exact complements of one function's answer, so at most one can fire per
  // request and no input exists on which both do. Nothing else may redirect to /admin from /portal.
  // If a future rule needs to, it must ask THIS function, not a role value: the loop that produced
  // ERR_TOO_MANY_REDIRECTS and locked every wrongly-promoted intern out of the portal was exactly a
  // role test on one side and a rights test on the other.
  if (isAdminPath(path) && !isAdminGuardExempt(path)) {
    // canOpenAdmin already fails closed on a query error (it returns deny('lookup-failed')). What it
    // could not do is fail closed on NO ANSWER, and a deny-by-default gate that hangs is not a gate.
    let verdict: Awaited<ReturnType<typeof canOpenAdmin>>;
    try {
      verdict = await withDbTimeout(canOpenAdmin(result.user as any), 'middleware.canOpenAdmin');
    } catch (e: any) {
      if (isDbUnavailable(e)) return dbUnavailable('admin-gate');
      throw e;
    }
    if (!verdict.allowed) {
      // Logged as a refused ATTEMPT, not an error: the path and the user id are what turn "someone
      // reported they can see the pipeline" into a specific account on a specific screen.
      logEvent('warn', 'admin.access.refused', {
        path,
        userId: result.user.id,
        role: verdict.role,
        reason: verdict.reason,
      });
      // Same destination as AdminLayout's existing intern refusal, so the two guards never disagree
      // about where a refused person lands.
      const dest = verdict.reason === 'internship' ? '/portal?notice=admin-access-removed' : '/portal';
      return new Response(null, { status: 302, headers: { Location: dest, 'cache-control': 'no-store' } });
    }
  }

  // Permission gate: a user assigned a custom role only reaches sections that
  // role grants view on. Mirrors the sidebar filter so URL-typing can't bypass
  // it. super_admins / unrestricted users return null (no gating).
  if (result.user.role !== 'applicant' && path.startsWith('/admin/') && path !== '/admin/login' && path !== '/admin/logout') {
    const sectionKey = resolveAdminSection(path);
    if (sectionKey) {
      // A section gate that cannot read the grants must not silently become allow-by-default (it
      // returns null for "no gating"), and must not hang either. 503 on no answer.
      let allowed: Awaited<ReturnType<typeof getViewableSectionKeys>>;
      try {
        allowed = await withDbTimeout(getViewableSectionKeys(result.user), 'middleware.sectionKeys');
      } catch (e: any) {
        if (isDbUnavailable(e)) return dbUnavailable('section-gate');
        throw e;
      }
      if (allowed && !allowed.has(sectionKey)) {
        return new Response(null, { status: 302, headers: { Location: '/admin?denied=' + encodeURIComponent(sectionKey) } });
      }
    }
  }

  // 2FA gate: face-enrollment is REQUIRED for ALL signed-in users hitting a
  // protected surface — staff AND applicants. Per founder instruction:
  // every applicant must complete Face 2FA before accessing the portal.
  // Login / signup / enrollment flows are exempt via isExempt(path) above.
  if (!isExempt(path) && isProtected(path)) {
    const faceState = await hasFaceEnrolled(result.user.id);
    // 'unknown' means the database did not answer. Bouncing to face enrollment on that would send
    // every signed-in person to a page that cannot enroll anything, which is a dead end dressed up as
    // a security step.
    if (faceState === 'unknown') return dbUnavailable('face-2fa');
    if (faceState === 'absent') {
      // For applicants, route them through the portal-styled face-setup
      // page so the back-link goes back to /portal. Staff use /enroll-face.
      const target = result.user.role === 'applicant'
        ? '/portal/face-setup?next=' + encodeURIComponent(path)
        : '/enroll-face';
      return new Response(null, {
        status: 302,
        headers: { Location: target },
      });
    }
  }

  return next();
});
