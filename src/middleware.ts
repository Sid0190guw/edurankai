import { defineMiddleware } from 'astro:middleware';
import { validateSessionToken } from '@/lib/auth/session';
import { readSessionCookie, setSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { getViewableSectionKeys } from '@/lib/auth/permissions';

// Map an /admin/* path to its permission section key (longest-prefix wins).
// Universal/auth paths (dashboard, mail, notifications, login, logout) are not
// listed -> never gated. Unmapped admin paths fall through (allowed).
const PATH_SECTION: [string, string][] = [
  ['/admin/applications', 'applications'],
  ['/admin/help', 'messages'],
  ['/admin/messages', 'dms'],
  ['/admin/chat', 'discussion'],
  ['/admin/offer/blank', 'custom_offer'],
  ['/admin/offers', 'offers'],
  ['/admin/offer', 'offers'],
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
  ['/admin/audit', 'audit'],
  ['/admin/settings', 'settings'],
  ['/admin/diagnostics', 'settings'],
].sort((a, b) => b[0].length - a[0].length);

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
  if (path === '/identity-setup') return true;
  if (path === '/verify-by-questions') return true;
  if (path === '/forgot-password') return true;
  if (path === '/admin/login' || path === '/portal/login' || path === '/hei/login') return true;
  if (path === '/aquintutor/login' || path === '/aquintutor/signup') return true;
  if (path === '/portal/signup' || path === '/portal/forgot') return true;
  if (path === '/hei/register' || path === '/hei/claim') return true;
  if (path.startsWith('/portal/claim/')) return true;
  if (path === '/logout' || path === '/portal/logout' || path === '/admin/logout' || path === '/hei/logout') return true;
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

async function hasFaceEnrolled(userId: string): Promise<boolean> {
  try {
    const r = await db.execute(sql`SELECT id FROM user_face_enrollments WHERE user_id = ${userId} AND is_active = true LIMIT 1`);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    return rows.length > 0;
  } catch (_) { return false; }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = new URL(context.request.url).pathname;

  // Viśvambhara deep modules ALWAYS require sign-in + admin approval. Handled
  // first so unauthenticated visitors are bounced to the access page instead
  // of seeing raw HTML.
  if (path.startsWith('/visvambhara/')) {
    const tokenEarly = readSessionCookie(context.cookies);
    let userEarly: any = null;
    if (tokenEarly) {
      const v = await validateSessionToken(tokenEarly);
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

  const token = readSessionCookie(context.cookies);
  if (!token) {
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }
  const result = await validateSessionToken(token);
  if (!result) {
    clearSessionCookie(context.cookies);
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }
  setSessionCookie(context.cookies, token, result.session.expiresAt);
  context.locals.user = result.user;
  context.locals.session = result.session;

  // Applicants get full access only in the application portal, never the admin
  // panel. Central guard (complements per-page checks).
  if (result.user.role === 'applicant' && path !== '/admin/login' && (path === '/admin' || path.startsWith('/admin/'))) {
    return new Response(null, { status: 302, headers: { Location: '/portal' } });
  }

  // Permission gate: a user assigned a custom role only reaches sections that
  // role grants view on. Mirrors the sidebar filter so URL-typing can't bypass
  // it. super_admins / unrestricted users return null (no gating).
  if (result.user.role !== 'applicant' && path.startsWith('/admin/') && path !== '/admin/login' && path !== '/admin/logout') {
    const sectionKey = resolveAdminSection(path);
    if (sectionKey) {
      const allowed = await getViewableSectionKeys(result.user);
      if (allowed && !allowed.has(sectionKey)) {
        return new Response(null, { status: 302, headers: { Location: '/admin?denied=' + encodeURIComponent(sectionKey) } });
      }
    }
  }

  // 2FA gate: every authenticated request to a protected route must come from
  // an account that has a face descriptor on file. If not, route to /enroll-face.
  if (!isExempt(path) && isProtected(path)) {
    const hasFace = await hasFaceEnrolled(result.user.id);
    if (!hasFace) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/enroll-face' },
      });
    }
  }

  return next();
});
