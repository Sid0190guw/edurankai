// src/lib/rbac/roles.ts — the SEED role roster (stored as a seed in the DB, not hard-coded
// into logic; the engine reads DB rows, this is the source data seeded once). Each role
// declares its surface, its own capabilities, and optional parent roles it INHERITS from.
import type { Capability } from './capabilities';

export type Surface = 'admin' | 'main';

// Student stages (attribute on the `student` role). The first three are MINOR stages that
// require a linked guardian.
export const STAGES = ['tots', 'primary', 'sub_junior', 'junior', 'scholar', 'undergraduate', 'research', 'atelier'] as const;
export type Stage = (typeof STAGES)[number];
export const MINOR_STAGES: Stage[] = ['tots', 'primary', 'junior'];
export function isMinorStage(stage?: string | null): boolean {
  return !!stage && (MINOR_STAGES as string[]).includes(stage);
}

export interface SeedRole {
  key: string;
  surface: Surface;
  description: string;
  capabilities: Capability[];   // own capabilities
  inherits?: string[];          // parent role keys — capabilities are unioned transitively
  color?: string;
}

// ---- ADMIN / STAFF surface (gated under /admin) ----
const ADMIN_ROLES: SeedRole[] = [
  { key: 'superadmin', surface: 'admin', description: 'Full control of everything.', capabilities: ['administer'], color: 'red' },
  { key: 'registrar', surface: 'admin', description: 'Admissions, enrolment, records, issue/revoke credentials.', capabilities: ['read', 'write', 'create', 'manage', 'audit', 'delegate'], color: 'plum' },
  { key: 'dean', surface: 'admin', description: 'Manage one school: its departments, faculty, courses.', capabilities: ['manage', 'configure', 'schedule'], inherits: ['faculty'], color: 'teal' },
  { key: 'faculty', surface: 'admin', description: 'Author + teach: create/edit KnowledgeObjects, courses, lessons, assessments; publish.', capabilities: ['read', 'write', 'create', 'execute'], inherits: ['content_author'], color: 'sky' },
  { key: 'teaching_assistant', surface: 'admin', description: 'Assist faculty: grade, moderate lesson discussion.', capabilities: ['read', 'write', 'execute'], color: 'sky' },
  { key: 'content_author', surface: 'admin', description: 'Create/edit KnowledgeObjects and lessons (no publish).', capabilities: ['read', 'write', 'create'], color: 'gold' },
  { key: 'reviewer_examiner', surface: 'admin', description: 'Review/approve content; set and score official examinations.', capabilities: ['read', 'write', 'execute', 'audit'], color: 'plum' },
  { key: 'proctor', surface: 'admin', description: 'Run ATLAS proctored exams; view proctoring event logs.', capabilities: ['read', 'execute', 'audit'], color: 'orange' },
  { key: 'moderator', surface: 'admin', description: 'Moderate community/discussion.', capabilities: ['read', 'write', 'delete'], color: 'teal' },
  { key: 'support', surface: 'admin', description: 'Read-only records + correspondence.', capabilities: ['read'], color: 'gray' },
];

// ---- MAIN / LEARNER surface ----
const MAIN_ROLES: SeedRole[] = [
  { key: 'applicant', surface: 'main', description: 'Pre-enrolment, screening interview, catalogue.', capabilities: ['read'], color: 'gray' },
  { key: 'student', surface: 'main', description: 'Enrolled learning (carries a stage attribute).', capabilities: ['read', 'execute'], color: 'sky' },
  { key: 'guardian', surface: 'main', description: 'Oversight of linked minor student accounts: view progress, manage settings, consent.', capabilities: ['read', 'configure'], color: 'plum' },
  { key: 'researcher', surface: 'main', description: 'Research desk / research workspace access.', capabilities: ['read', 'write', 'execute'], color: 'teal' },
  { key: 'partner', surface: 'main', description: 'Institutional partner portal (read partnership data).', capabilities: ['read'], color: 'gold' },
  { key: 'guest', surface: 'main', description: 'Public catalogue browsing only.', capabilities: ['read'], color: 'gray' },
];

export const SEED_ROLES: SeedRole[] = [...ADMIN_ROLES, ...MAIN_ROLES];
export const ADMIN_ROLE_KEYS = ADMIN_ROLES.map((r) => r.key);
export const MAIN_ROLE_KEYS = MAIN_ROLES.map((r) => r.key);

/** Resolve a role's full capability set, following `inherits` transitively (cycle-safe). */
export function resolveRoleCapabilities(roleKey: string, roles: SeedRole[] = SEED_ROLES, seen = new Set<string>()): Set<Capability> {
  const caps = new Set<Capability>();
  if (seen.has(roleKey)) return caps;
  seen.add(roleKey);
  const role = roles.find((r) => r.key === roleKey);
  if (!role) return caps;
  for (const c of role.capabilities) caps.add(c);
  for (const parent of role.inherits ?? []) for (const c of resolveRoleCapabilities(parent, roles, seen)) caps.add(c);
  return caps;
}
