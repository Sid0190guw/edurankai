// src/lib/auth/api-guard.ts — the gate for endpoints the /admin middleware never sees.
//
// WHY THIS EXISTS. src/middleware.ts protects /admin with three server-side gates: an anonymous
// redirect, canOpenAdmin() (deny by default), and the PATH_SECTION section gate. None of them reach
// src/pages/api/admin/**, because isAdminPath() (middleware.ts:19-22) matches only `/admin` and
// `/admin/*`, and isExempt() (middleware.ts:111) hard-returns true for anything starting `/api/`.
// So an admin API route is, structurally, an UNGUARDED URL: whatever it checks for itself is the
// only thing standing in front of it, and twenty of them checked `user.role !== 'applicant'` —
// the test src/lib/auth/permissions.ts explicitly warns against, which every internal role passes,
// including the `editor` the 2026 offer-signing promotion handed to every intern, and including the
// partner / teacher / technical_moderator scopes the middleware bounces off /admin entirely.
//
// src/pages/api/admin/search.ts noticed first and called canOpenAdmin() itself. This module is that
// one line, made reusable, so the answer at an /api/admin URL is the SAME answer as at the /admin
// page it belongs to, and never a weaker one.
//
// IT FAILS CLOSED, because everything it calls fails closed: canOpenAdmin() denies when the employee
// lookup throws, and canAccessSection() denies for an unknown role and returns false on a query
// error. A database hiccup refuses a refund; it never authorises one.
//
// IT AUTHORISES BEFORE THE HANDLER RUNS. Call it on the first line, before reading the body and
// before any SELECT. docs/workforce-os/AUTHORIZATION_FIRST.md: filtering after fetching is
// prohibited, and a query that ran for an unauthorised principal has already happened whatever the
// response says.
import { canOpenAdmin } from '@/lib/auth/admin-access';
import { canAccessSection, can, type Permission, type PermissionAction } from '@/lib/auth/permissions';
import { logEvent } from '@/lib/logger';

// Declared at the very top: `const` is not hoisted, and a handler reaching a later declaration has
// taken pages down on this project.
const json = (d: any, status: number): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });

export interface AdminApiGuardOptions {
  /**
   * An admin section key from src/lib/admin-sections.ts (the same keys middleware.ts:48-98 maps
   * paths to). When given, the caller must hold it — so the URL cannot do what the sidebar would
   * not have offered. Omit ONLY when the surface has no section key at all; canOpenAdmin still runs.
   */
  section?: string;
  /** The action on that section. Defaults to 'view'; use 'edit' for anything that writes. */
  action?: PermissionAction;
  /**
   * A built-in permission from src/lib/auth/permissions.ts, for abilities that are not a section —
   * `payments.refund` is the reason this exists.
   */
  permission?: Permission;
  /** Included verbatim in the refusal log line, so a denial names the endpoint. */
  label?: string;
}

/**
 * Refuse, or return null and let the handler run.
 *
 *   const denied = await denyAdminApi(locals, { section: 'applications', action: 'edit' });
 *   if (denied) return denied;
 *
 * 401 when nobody is signed in (the caller can sign in and retry), 403 for everything else. The
 * body is a bare `{ ok: false, error }` on purpose: a refusal that explains which capability was
 * missing tells an unauthorised caller what to go looking for.
 */
export async function denyAdminApi(
  locals: any,
  opts: AdminApiGuardOptions = {},
): Promise<Response | null> {
  const user = locals?.user;

  // 1. May this person open an admin surface AT ALL? Same question, same answer, as /admin.
  const verdict = await canOpenAdmin(user);
  if (!verdict.allowed) {
    logEvent('warn', 'admin.api.refused', {
      label: opts.label || null,
      userId: user?.id || null,
      role: verdict.role,
      reason: verdict.reason,
    });
    return json({ ok: false, error: 'unauthorized' }, verdict.reason === 'not-signed-in' ? 401 : 403);
  }

  // 2. A named ability, when the surface has one that is not a section.
  if (opts.permission) {
    let held = can(user, opts.permission);
    if (!held) {
      // A custom role created in the admin panel can hold it too — that is the whole point of the
      // registry. Asked only after the compiled matrix says no, and it resolves to an empty set on
      // any error, so this arm can widen access only by an explicit, audited grant.
      try {
        const { hasPermission } = await import('@/lib/auth/registry');
        held = await hasPermission(String(user?.id || ''), opts.permission, { locals });
      } catch (e: any) {
        logEvent('error', 'admin.api.registry-lookup-failed', {
          label: opts.label || null,
          message: String(e?.cause?.message || e?.message || 'unknown error'),
        });
        held = false;
      }
    }
    if (!held) {
      logEvent('warn', 'admin.api.refused', {
        label: opts.label || null,
        userId: user?.id || null,
        role: verdict.role,
        reason: 'missing-permission',
        permission: opts.permission,
      });
      return json({ ok: false, error: 'forbidden' }, 403);
    }
  }

  // 3. The section gate the middleware would have applied to the matching /admin page.
  if (opts.section) {
    const action: PermissionAction = opts.action || 'view';
    const ok = await canAccessSection(user, opts.section, action);
    if (!ok) {
      logEvent('warn', 'admin.api.refused', {
        label: opts.label || null,
        userId: user?.id || null,
        role: verdict.role,
        reason: 'section-denied',
        section: opts.section,
        action,
      });
      return json({ ok: false, error: 'forbidden' }, 403);
    }
  }

  return null;
}
