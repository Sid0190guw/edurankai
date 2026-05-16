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
  | 'audit.view';

const PERMS_BY_ROLE: Record<User['role'], Permission[]> = {
  super_admin: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    'events.view', 'events.edit',
    'products.view', 'products.edit',
    'content.view', 'content.edit',
    'users.view', 'users.edit',
    'settings.view', 'settings.edit',
    'audit.view'
  ],
  hr: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    'events.view', 'events.edit',
    'content.view'
  ],
  recruiter: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.edit', 'applications.score'
  ],
  reviewer: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.score'
  ],
  department_head: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score'
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
  applicant: []
};

export function can(user: User | null, perm: Permission): boolean {
  if (!user || !user.isActive) return false;
  return PERMS_BY_ROLE[user.role].includes(perm);
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
  applicant: 'Applicant'
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
