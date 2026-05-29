// Add this block to your existing src/middleware.ts (Astro 5).
// It forces every authenticated user on a "protected" path to either have a
// face enrolment on file, or get redirected to /face-2fa/enroll.
//
// Paths the user lists in `isExempt()` bypass the gate entirely.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// Paths that bypass the face gate (login, enrol, recovery, APIs, static).
function isExempt(path: string): boolean {
  if (!path) return true;
  if (path.startsWith('/api/')) return true;
  if (path.startsWith('/_astro/')) return true;
  if (path === '/login' || path === '/logout') return true;
  if (path.startsWith('/face-2fa/')) return true;       // enrol + verify pages
  if (path === '/forgot-password') return true;
  return false;
}

// Routes that require a face enrolment to view.
function isProtected(path: string): boolean {
  // Tighten/loosen for your app. Default: everything except exempt paths.
  return !isExempt(path);
}

async function hasFaceEnrolled(userId: string): Promise<boolean> {
  try {
    const r = await db.execute(sql`
      SELECT id FROM user_face_enrollments
      WHERE user_id = ${userId} AND is_active = true LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    return rows.length > 0;
  } catch { return false; }
}

// In your `onRequest` handler, AFTER you load `context.locals.user`, add:
//
//   if (context.locals.user && isProtected(path) && !isExempt(path)) {
//     const ok = await hasFaceEnrolled(context.locals.user.id);
//     if (!ok) {
//       return new Response(null, { status: 302, headers: { Location: '/face-2fa/enroll' } });
//     }
//   }
//
// That's it. Login still works (it's exempt), and after a user signs in they
// are redirected once to enrol, then never again.

export { isExempt, isProtected, hasFaceEnrolled };
