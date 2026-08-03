import type { User } from '@/lib/db/schema';

export type Permission =
  | 'admin.access'
  | 'roles.view' | 'roles.edit'
  | 'applications.view' | 'applications.edit' | 'applications.score'
  | 'events.view' | 'events.edit'
  | 'products.view' | 'products.edit'
  | 'content.view' | 'content.edit'
  | 'users.view' | 'users.edit'
  | 'settings.view' | 'settings.edit'
  // Offer-letter verification requests (the QR two-path flow). These were referenced by
  // /admin/offer-verifications before they existed here, so can() returned false for EVERY role
  // including super_admin and the console redirected everyone away — firms could be charged for a
  // verification that no human could then open and answer.
  | 'offers.view' | 'offers.edit'
  // Money leaving the company. /api/admin/payments/refund and refund-manual used to be gated by
  // `user.role !== 'applicant'` — the exact test warned against in canAccessSection() below — on an
  // endpoint that issues a REAL Razorpay refund. Every internal role passed it, including the
  // `editor` the 2026 offer-signing promotion handed to every intern, and /api/* is not covered by
  // the /admin middleware gate, so nothing else stood in front of that URL.
  //
  // The refund console itself (/admin/finance) has always been super_admin + hr, so these are
  // granted to exactly those two: the capability records the policy the product already had, it
  // does not invent a new one. `payments.refund` is SENSITIVE in registry.ts — granting it to a
  // custom role must be provably on the record.
  | 'payments.view' | 'payments.refund'
  // APPROVALS AND PEOPLE. docs/workforce-os/AUTHORIZATION_FIRST.md:68-74 names CanApproveLeave,
  // CanApprovePayroll, CanManageEmployees and CanManageDepartments as the vocabulary a widget must
  // declare instead of a role name. None of them existed anywhere — not here, not in
  // BUILTIN_PERMISSIONS — which is the whole reason src/lib/hr-wallet.ts, src/lib/hr-leave.ts,
  // src/lib/workforce/composer.ts and src/lib/auth/workspace-access.ts still compare role STRINGS:
  // there was nothing to translate into. Written in this file's existing dotted style rather than in
  // the spec's CamelCase, because two naming conventions for one concept is how a check ends up
  // asking for a permission that nobody granted.
  //
  // THIS COMMIT IS MECHANISM, NOT POLICY. Every grant in PERMS_BY_ROLE below reproduces the authority
  // the code enforces TODAY, derived from the checks listed above the matrix. Nothing yet ASKS for
  // these keys, so no effective access changes; the conversion of the four role-name tests is a
  // separate, verifiable step.
  | 'leave.approve'
  | 'payouts.approve' | 'payouts.pay'
  | 'employees.manage'
  | 'department.lead'
  | 'audit.view';

// Exported so a read-only console can SHOW the matrix instead of a second, hand-typed copy of it
// drifting away from the real one (/admin/access-preview). Nothing outside this file may decide
// access from it — use can(), which is the single test every other caller already uses.
//
// ---------------------------------------------------------------------------------------------
// HOW THE FIVE APPROVAL/PEOPLE GRANTS BELOW WERE DERIVED. Read this before changing one of them.
//
// Each was taken from the checks that enforce the authority today, not from what the shape of the
// permission suggests it ought to mean:
//
//   leave.approve     src/lib/hr-leave.ts decideLeave -> approverRole() (hr-wallet.ts:189);
//                     pendingLeaveForApprover() seesAll (hr-leave.ts:106);
//                     /admin/hr/leave gate canAccessSection('leave','edit') and ROLE_SECTIONS below.
//   payouts.approve   src/lib/hr-wallet.ts decideWithdrawal -> approverRole();
//                     pendingWithdrawalsForApprover() seesAll (hr-wallet.ts:163);
//                     /admin/hr/wallet gate canAccessSection('payouts','edit').
//   payouts.pay       src/lib/hr-wallet.ts payWithdrawal, which narrows approverRole()'s answer to
//                     'admin' | 'super_admin' | 'hr_head' — a reporting manager may APPROVE a
//                     withdrawal and may NOT release the money. Two keys, because it is two powers.
//   employees.manage  src/lib/auth/workspace-access.ts requireHr(); /admin/hr isHrDesk;
//                     /admin/hr/completion/[id] isHrDesk; middleware gates /admin/hr/employees on
//                     the 'employees' section, which only `hr` holds in ROLE_SECTIONS.
//   department.lead   src/lib/auth/workspace-access.ts requireTeamLead() (role must be exactly
//                     'department_head'); src/lib/workforce/composer.ts leadsDepartment.
//
// THE 'admin' ARM IN THOSE CHECKS IS DEAD and is deliberately not reproduced here. 'admin' is not a
// value of userRoleEnum (src/lib/db/schema.ts:10-16), so no account can hold it and no grant can
// correspond to it. Dropping a dead arm removes nothing from anybody.
//
// TWO AUTHORITIES DELIBERATELY NOT EXPRESSED AS ROLE GRANTS, because they are not role-shaped:
//
//   1. THE REPORTING MANAGER. approverRole() returns 'reporting_manager' when
//      hr_employees.reporting_manager_id equals the user's id. That is a RELATIONSHIP to one
//      employee, not a role, and it is per-row: the same person may decide Ravi's leave and not
//      Priya's. A role grant cannot say that, so any conversion of approverRole() must keep that
//      arm as the row-level check it already is. Granting leave.approve to a role in order to
//      "cover managers" would hand every manager authority over every employee — a policy change,
//      and the widest one available here.
//   2. SUPER_ADMIN IS NOT A TEAM LEAD. requireTeamLead() refuses super_admin today, so
//      department.lead is granted to department_head ONLY. It is a SCOPING signal (which department
//      am I confined to), not a rank, and adding it to super_admin would confine the founder to one
//      department rather than widen anything.
//
// CUSTOM ROLES ARE A THIRD PATH THIS MATRIX CANNOT SEE. /admin/hr/leave and /admin/hr/wallet gate on
// canAccessSection(), which honours a custom role holding the 'leave'/'payouts' section — and the
// registry resolves those rows as `leave.edit` / `payouts.edit`, NEVER as `leave.approve`. So a
// conversion that swaps canAccessSection() for a bare can(..., 'leave.approve') would REMOVE access
// from every custom role that has it today. Convert by accepting either, or by granting the new key
// to those roles first and verifying it landed.
// ---------------------------------------------------------------------------------------------
export const PERMS_BY_ROLE: Record<User['role'], Permission[]> = {
  super_admin: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    'events.view', 'events.edit',
    'products.view', 'products.edit',
    'content.view', 'content.edit',
    'users.view', 'users.edit',
    'settings.view', 'settings.edit',
    'offers.view', 'offers.edit',
    'payments.view', 'payments.refund',
    // Already holds every one of these: approverRole() answers 'super_admin' first, and
    // getViewableSectionKeys()/canAccessSection() return "unrestricted" for this role. Not
    // 'department.lead' — requireTeamLead() refuses super_admin today and that must not move.
    'leave.approve', 'payouts.approve', 'payouts.pay', 'employees.manage',
    'audit.view'
  ],
  hr: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    'events.view', 'events.edit',
    // HR issues the offer letters, so HR answers the verifications that come back against them.
    'offers.view', 'offers.edit',
    // /admin/finance has been super_admin + hr since it was written; the refund buttons on it are
    // HR's. Recorded here so the endpoint can ask for the ability instead of for the role name.
    'payments.view', 'payments.refund',
    // The exact role 'hr' — never a substring — is what approverRole() reads as 'hr_head', what
    // pendingLeaveForApprover()/pendingWithdrawalsForApprover() treat as "sees every request", what
    // payWithdrawal() accepts for releasing money, and what requireHr() and isHrDesk admit. It is
    // also the only built-in role carrying 'leave', 'payouts', 'employees' and 'hr' in ROLE_SECTIONS
    // below, which is what the middleware and both page gates actually enforce. Same four abilities,
    // named instead of spelled.
    'leave.approve', 'payouts.approve', 'payouts.pay', 'employees.manage',
    'content.view'
  ],
  recruiter: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.edit', 'applications.score',
    // A recruiter can see who is checking a candidate's letter, but answering on the record is
    // HR's call — read-only here.
    'offers.view'
  ],
  reviewer: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.score'
  ],
  department_head: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    // The ONLY holder of this key, and the only role requireTeamLead() admits. It grants no approval
    // authority: department_head holds no HR section in ROLE_SECTIONS and approverRole() returns
    // nothing for it, so a department head can decide a request today only by being that employee's
    // reporting manager — a row-level fact this matrix cannot and must not encode.
    //
    // NOT a licence to see the department either. composer.ts adds `engagement !== 'internship'`
    // and requireTeamLead() refuses an intern record outright; both conditions are per-PERSON, they
    // survive this grant, and a conversion must keep them.
    'department.lead'
  ],
  marketing: [
    'admin.access',
    'content.view', 'content.edit',
    'events.view', 'events.edit',
    'products.view', 'products.edit'
  ],
  editor: [
    'admin.access',
    'roles.view',
    'events.view', 'events.edit',
    'products.view', 'products.edit',
    'content.view', 'content.edit'
  ],
  applicant: [],
  // AquinTutor-scoped roles hold NO main-admin permission (no admin.access), so
  // the middleware confines them to /aquintutor/admin. Their abilities live in
  // their own panels (partner = host courses, teacher = author, moderator = review).
  partner: [],
  teacher: [],
  technical_moderator: []
};

export function can(user: User | null, perm: Permission): boolean {
  if (!user || !user.isActive) return false;
  // Roles not in the matrix (e.g. a partner/teacher scope) get NO built-in
  // permissions — they are confined to their own panel, never the main admin.
  return (PERMS_BY_ROLE[user.role] || []).includes(perm);
}

export function requireAdmin(user: User | null): User {
  if (!user || !can(user, 'admin.access')) {
    throw new Error('UNAUTHORIZED');
  }
  return user;
}

// Helper: human-readable role labels
export const ROLE_LABELS: Record<User['role'], string> = {
  super_admin: 'Super Admin',
  hr: 'HR',
  recruiter: 'Recruiter',
  reviewer: 'Reviewer',
  department_head: 'Department Head',
  marketing: 'Marketing',
  editor: 'Editor',
  applicant: 'Applicant',
  partner: 'AquinTutor Partner',
  teacher: 'AquinTutor Teacher',
  technical_moderator: 'AquinTutor Moderator'
};

// Roles that need a department assignment
export const DEPARTMENT_SCOPED_ROLES: User['role'][] = ['department_head', 'reviewer', 'recruiter'];

// =========================================================================
// Dynamic role system (additive)
// =========================================================================
// Custom roles created via /admin/team/roles. Used alongside the hardcoded
// PERMS_BY_ROLE matrix above. Existing pages keep using can(); new pages
// can opt into userCanAccess() for fine-grained, admin-configurable perms.

import { db } from '@/lib/db';
import { userRoleAssignments, rolePermissions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export type PermissionAction = 'view' | 'edit' | 'delete' | 'export';

/**
 * Returns true if the user has ANY custom role granting the specified action on the page.
 * If user has no custom roles, returns false (caller can fall through to legacy can()).
 */
export async function userCanAccess(userId: string, pageKey: string, action: PermissionAction): Promise<boolean> {
  const userRolesRows = await db.select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, userId));
  if (userRolesRows.length === 0) return false;

  const roleIds = userRolesRows.map(r => r.roleId);
  const perms = await db.select().from(rolePermissions)
    .where(and(inArray(rolePermissions.roleId, roleIds), eq(rolePermissions.pageKey, pageKey)));

  for (const p of perms) {
    if (action === 'view' && p.canView) return true;
    if (action === 'edit' && p.canEdit) return true;
    if (action === 'delete' && p.canDelete) return true;
    if (action === 'export' && p.canExport) return true;
  }
  return false;
}

// Default section access per built-in role (used when a user has NO custom role
// assigned). super_admin is unrestricted. Keys come from src/lib/admin-sections.ts.
const ROLE_SECTIONS: Record<string, string[]> = {
  hr: [
    'dashboard', 'applications', 'offers', 'messages', 'dms', 'discussion',
    'hr', 'employees', 'leave', 'attendance', 'payroll', 'payouts', 'training', 'finance',
    'roles', 'departments', 'interviews', 'interviews_manual', 'interviews_ai',
    'events', 'content', 'custom_offer',
  ],
  recruiter: [
    'dashboard', 'applications', 'offers', 'messages', 'dms',
    'roles', 'interviews', 'interviews_manual', 'interviews_ai',
    'tests', 'tests_proctoring', 'custom_offer',
  ],
  reviewer: [
    'dashboard', 'applications', 'interviews', 'interviews_manual', 'interviews_ai',
    'tests', 'tests_proctoring',
  ],
  department_head: [
    'dashboard', 'applications', 'offers', 'roles',
    'interviews', 'interviews_manual', 'interviews_ai', 'custom_offer',
  ],
  marketing: [
    'dashboard', 'content', 'products', 'events',
    'hei_institutions', 'hei_stories',
  ],
  editor: [
    'dashboard', 'content', 'products', 'events', 'lms', 'custom_offer',
  ],
  applicant: [],
  // These three were ABSENT from this map, and absence means "no section filtering" — so if any of
  // them ever reached the admin sidebar they would have seen all 108 entries, the widest view in the
  // product, purely because nobody had written a line for them. They are confined to
  // /aquintutor/admin by canOpenAdmin() and the middleware, so this was latent rather than live,
  // but a gap that depends on a separate guard never being changed is not a gap worth keeping.
  //
  // /admin/access-preview surfaced it. That is what the page is for: an unrestricted role reads as
  // "108 entries" on screen instead of hiding in an omission nobody would grep for.
  //
  // Empty means empty. Their abilities live in their own panels, never the main admin.
  partner: [],
  teacher: [],
  technical_moderator: [],
};

/**
 * The section keys a BUILT-IN role gets when the person has no custom role assigned — the tail of
 * getViewableSectionKeys(), lifted out so it can be answered for a role rather than for a person.
 * Pure: no database, no session, safe to call for every role at once (/admin/access-preview does).
 *
 * null means "no section filtering", which covers two different situations and the caller must not
 * confuse them: super_admin (unrestricted on purpose) and a role with NO entry in ROLE_SECTIONS
 * (unrestricted by omission — for partner/teacher/technical_moderator the thing actually keeping
 * them out of the admin panel is lacking admin.access, not this filter).
 */
export function defaultSectionKeysForRole(role: string): Set<string> | null {
  if (role === 'super_admin') return null;
  const defaults = ROLE_SECTIONS[role];
  if (!defaults) return null; // unknown role -> don't restrict
  return new Set<string>(defaults);
}

/**
 * Returns the set of admin section keys this user may VIEW, used to filter the
 * sidebar (and enforce in middleware) so people only see pages they can open.
 *   - super_admin            -> null  (means "everything", no filtering)
 *   - has >=1 custom role    -> exactly the granted view page-keys (+ dashboard)
 *   - else built-in role     -> that role's default section set (ROLE_SECTIONS)
 * Custom-role assignment is the precise override; built-in roles get sane
 * defaults so a Marketing/Recruiter/etc. account no longer sees every tab.
 */
export async function getViewableSectionKeys(user: { id: string; role: string } | null): Promise<Set<string> | null> {
  if (!user) return new Set();
  if (user.role === 'super_admin') return null;
  const assigns = await db.select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, user.id));
  if (assigns.length > 0) {
    const roleIds = assigns.map(r => r.roleId);
    const perms = await db.select({ pageKey: rolePermissions.pageKey, canView: rolePermissions.canView })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));
    const set = new Set<string>(['dashboard']);
    for (const p of perms) if (p.canView) set.add(p.pageKey);
    return set;
  }
  return defaultSectionKeysForRole(user.role);
}

/**
 * Authorise ONE action on ONE admin section — the check to use in API routes and page POST
 * handlers, so a URL cannot do what the sidebar would not offer.
 *
 * Use this rather than `userCanAccess`, which consults ONLY custom role assignments and so
 * returns false for a super_admin (who typically has none) — that silently locks out the very
 * people a feature is built for. And never use `user.role !== 'applicant'` as an authorisation
 * test: every internal role passes it, including the `editor` that offer letters auto-assign to
 * candidates who have not yet accepted.
 *
 *   super_admin           -> allowed
 *   >=1 custom role       -> exactly what those roles grant for this page key + action
 *   else built-in role    -> that role's ROLE_SECTIONS defaults (a granted section implies
 *                            view/edit/export on it; delete stays super_admin-only)
 *   unknown role          -> DENIED (deny by default; the sidebar filter's "don't restrict"
 *                            fallback is not a safe answer for a write or a bulk export)
 */
export async function canAccessSection(
  user: { id: string; role: string } | null | undefined,
  sectionKey: string,
  action: PermissionAction = 'view',
): Promise<boolean> {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'applicant') return false;

  try {
    const assigns = await db.select({ roleId: userRoleAssignments.roleId })
      .from(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, user.id));
    if (assigns.length > 0) {
      return await userCanAccess(user.id, sectionKey, action);
    }
  } catch { return false; }

  const defaults = ROLE_SECTIONS[user.role];
  if (!defaults) return false;
  if (!defaults.includes(sectionKey)) return false;
  return action !== 'delete';
}

/** Standard page-key constants. Use these instead of hardcoding strings. */
export const PAGE_KEYS = {
  DASHBOARD: 'dashboard',
  APPLICATIONS: 'applications',
  MESSAGES: 'messages',
  OFFERS: 'offers',
  USERS: 'users',
  ROLES: 'roles',
  DEPARTMENTS: 'departments',
  EVENTS: 'events',
  PRODUCTS: 'products',
  CONTENT: 'content',
  AUDIT: 'audit',
  SETTINGS: 'settings',
  HEI_INSTITUTIONS: 'hei_institutions',
  HEI_ENTITY_TYPES: 'hei_entity_types',
  HEI_IMPORT: 'hei_import',
  HEI_SUBMETRICS: 'hei_submetrics',
  HEI_V1: 'hei_v1',
  HEI_STORIES: 'hei_stories',
  HEI_CLAIMS: 'hei_claims',
  HEI_SUBMISSIONS: 'hei_submissions',
  HEI_FINDINGS: 'hei_findings',
  TEAM_ROLES: 'team_roles'
} as const;

export type PageKey = typeof PAGE_KEYS[keyof typeof PAGE_KEYS];
