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