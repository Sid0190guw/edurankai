import { defineMiddleware } from 'astro:middleware';
import { validateSessionToken } from '@/lib/auth/session';
import { readSessionCookie, setSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

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

  // 2FA gate: every authenticated request to a protected route must come from
  // an account that has a face descriptor on file. If not, route to /enroll-face.
  const path = new URL(context.request.url).pathname;
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
