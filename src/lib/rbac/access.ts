// src/lib/rbac/access.ts — pure, DB-free helpers for the MAIN-surface "your access" view and
// for role-gating pages. accessSummary() turns a resolved Principal into a plain, renderable
// shape (roles, stage, minor/guardian status, capabilities with human labels). Kept pure so
// it is unit-tested without a database (see rbac-ui.test.ts).
import { ADMIN_ROLE_KEYS, MAIN_ROLE_KEYS, isMinorStage } from './roles';
import { ADMINISTER, type Capability } from './capabilities';
import type { Principal } from './types';

// Plain-language description of each capability, shown to a signed-in user on /aquintutor/access.
export const CAPABILITY_LABELS: Record<string, string> = {
  read: 'View courses, lessons and records',
  write: 'Edit content and records',
  create: 'Create new courses, lessons and objects',
  delete: 'Remove content',
  execute: 'Run labs, assessments and tools',
  configure: 'Change settings',
  manage: 'Manage people and resources',
  allocate: 'Allocate compute and resources',
  release: 'Release held resources',
  schedule: 'Schedule sessions and examinations',
  audit: 'View audit and proctoring logs',
  replicate: 'Replicate data across nodes',
  backup: 'Create backups',
  restore: 'Restore from backups',
  delegate: 'Delegate permissions to others',
  administer: 'Full control of everything',
};

export interface AccessSummary {
  userId: string | null;
  signedIn: boolean;
  roles: string[];
  adminRoles: string[];
  mainRoles: string[];
  stage: string | null;
  isMinor: boolean;
  hasGuardian: boolean;
  needsGuardian: boolean;          // minor student with no linked guardian -> sensitive actions blocked
  isSuperadmin: boolean;
  capabilities: { key: string; label: string }[];
}

/** Turn a resolved Principal into a renderable summary. Pure — no DB, no side effects. */
export function accessSummary(p: Principal): AccessSummary {
  const isMinor = isMinorStage(p.stage);
  const caps = [...p.capabilities]
    .map((k) => ({ key: k, label: CAPABILITY_LABELS[k] || k }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    userId: p.userId,
    signedIn: !!p.userId,
    roles: [...p.roles].sort(),
    adminRoles: p.roles.filter((r) => ADMIN_ROLE_KEYS.includes(r)).sort(),
    mainRoles: p.roles.filter((r) => MAIN_ROLE_KEYS.includes(r)).sort(),
    stage: p.stage ?? null,
    isMinor,
    hasGuardian: !!p.hasGuardian,
    needsGuardian: isMinor && !p.hasGuardian,
    isSuperadmin: p.capabilities.has(ADMINISTER as Capability),
    capabilities: caps,
  };
}
