// src/lib/auth/registry.ts — the permission registry. Permissions are DATA, not a TypeScript union.
//
// WHY THIS EXISTS. An intern reached the super-admin console in production. Three fixes shipped:
// the offer-signing promotion was removed, /admin now denies by default in middleware
// (src/lib/auth/admin-access.ts), and interns were bulk-demoted. What none of them fixed is the
// shape of the model underneath: src/lib/auth/permissions.ts hardcodes both the roles (a TypeScript
// union) and the matrix that maps them to permissions (PERMS_BY_ROLE). Adding a role means editing
// code, building, and deploying. An organisation heading for 1100+ admin-created roles cannot run
// that way, and a system where the only way to express "this person may do X" is a code change is a
// system where people get handed a role that is roughly right — which is exactly how an intern
// ended up an `editor`, and `editor` holds admin.access.
//
// WHAT IT IS. A catalogue of permissions stored in a table (key, label, group, description), custom
// roles that hold them, and ONE function — resolvePermissions() — that answers what a person may do
// by merging the built-in matrix with whatever the admin panel has configured.
//
// WHAT IT IS NOT. A second, parallel RBAC. It EXTENDS what already exists:
//   - team_roles / role_permissions / user_role_assignments (src/lib/db/schema.ts) keep their
//     meaning; the page-key + view/edit/delete/export rows written by /admin/team/roles are read
//     here and folded into the same answer, so nothing that works today stops working.
//   - PERMS_BY_ROLE stays authoritative for the built-in roles. It is code, it needs no database,
//     and can() remains the pure test for callers that must survive an outage.
//   - src/lib/rbac/* (the kernel capability engine) is a different layer for a different surface and
//     is deliberately untouched.
//
// THE ONE INVARIANT: NO EXCEPTION PATH EVER ADDS A PERMISSION. Every failure in resolvePermissions
// returns an EMPTY set with degraded=true. A database hiccup denies; it never grants. This is the
// same trade admin-access.ts already made and states plainly: the cost is that an outage closes the
// console for everyone including the founder, and the alternative — a gate that opens when the
// database blinks — is not a gate.
//
// NO MIGRATIONS EXIST ON THIS PROJECT. Everything new self-bootstraps in ensureRegistrySchema()
// with CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, following src/lib/legal-hold.ts.
//
// HONEST LIMIT — READ THIS BEFORE ASSUMING A GRANT OPENS THE CONSOLE. Granting `admin.access`
// through a custom role is supported, recorded and resolvable here, but by itself it does NOT open
// /admin today: src/middleware.ts asks canOpenAdmin(), whose ALLOW list (ADMIN_CAPABLE_ROLES) is
// derived from the BUILT-IN role on users.role. That is a safe default, not an oversight — the
// registry cannot silently widen the blast radius of the incident it was written for. Honouring
// custom grants at the door is a one-line seam in admin-access.ts (ask
// `hasPermission(user.id, PERM_ADMIN_ACCESS)` alongside the ALLOW-list test); it is a deliberate
// decision for a human to make, not a side effect of this file landing.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { logEvent } from '@/lib/logger';
import { PERMS_BY_ROLE, type Permission } from '@/lib/auth/permissions';
import { ADMIN_SECTION_GROUPS } from '@/lib/admin-sections';
import type { User } from '@/lib/db/schema';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the very top because
// `const` is not hoisted and a handler reaching a later declaration has taken pages down here.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => logEvent('error', tag, { message: reason(e) });

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** The permission that caused the incident. Named once, referenced everywhere. */
export const PERM_ADMIN_ACCESS = 'admin.access';

/**
 * Held only by super_admin, and only ever ADDED to a set — never stored, never grantable, never
 * catalogued. It exists so resolvePermissions needs no catalogue read (and therefore has one fewer
 * way to fail) while still meaning "everything, including permissions invented next week".
 *
 * Callers that inspect the Set directly MUST go through holdsPermission() or hasPermission(), both
 * of which understand it. A bare `set.has('users.edit')` will answer false for a super_admin.
 */
export const WILDCARD = '*';

/** Actions the section matrix (/admin/team/roles) can grant, in the order the editor shows them. */
export const SECTION_ACTIONS = ['view', 'edit', 'delete', 'export'] as const;
export type SectionAction = typeof SECTION_ACTIONS[number];

const ROLE_NAME_MIN = 2;
const ROLE_NAME_MAX = 80;
/** `group.action` or `group.sub.action`; lowercase, dots and underscores only. */
const PERMISSION_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

// ---------------------------------------------------------------------------------------------
// The built-in catalogue.
//
// This map is typed `Record<Permission, ...>`, which is the point: TypeScript REFUSES TO COMPILE if
// a member of the Permission union has no entry here. Adding a permission to the union without
// describing it is a build failure rather than a silent gap in the admin UI, and the seeding step
// below then writes these into permission_catalogue — so day one of the registry grants exactly what
// day zero granted, and nothing regresses.
// ---------------------------------------------------------------------------------------------

export interface PermissionMeta {
  label: string;
  group: string;
  description: string;
  /**
   * A permission whose grant must be provably on the record. Granting one of these fails if the
   * audit entry cannot be written (see assignPermission). admin.access is the reason this flag
   * exists; the rest are the permissions that read or change who else can do what.
   */
  sensitive?: boolean;
}

export const BUILTIN_PERMISSIONS: Record<Permission, PermissionMeta> = {
  'admin.access': {
    label: 'Open the admin console',
    group: 'Access',
    description: 'Reach any admin surface at all. This is the permission an intern held through the `editor` role; grant it deliberately, to named people, and expect the grant to be read back to you in the audit log.',
    sensitive: true,
  },
  'roles.view': { label: 'View job roles', group: 'Hiring', description: 'See the job-role catalogue and its descriptions.' },
  'roles.edit': { label: 'Edit job roles', group: 'Hiring', description: 'Create, change and retire job roles and their descriptions.' },
  'applications.view': { label: 'View applications', group: 'Hiring', description: 'Open the applicant pipeline and read individual applications.' },
  'applications.edit': { label: 'Edit applications', group: 'Hiring', description: 'Change application state, notes and stage.' },
  'applications.score': { label: 'Score applications', group: 'Hiring', description: 'Record evaluations and scores against an application.' },
  'offers.view': { label: 'View offer letters', group: 'Hiring', description: 'Read issued offer letters and the verification requests raised against them.' },
  'offers.edit': { label: 'Issue and answer offers', group: 'Hiring', description: 'Issue offer letters and answer verification requests on the record.' },
  'events.view': { label: 'View events', group: 'Content', description: 'See scheduled events and their registrations.' },
  'events.edit': { label: 'Edit events', group: 'Content', description: 'Create and change events.' },
  'products.view': { label: 'View products', group: 'Content', description: 'See product and venture pages.' },
  'products.edit': { label: 'Edit products', group: 'Content', description: 'Create and change product and venture pages.' },
  'content.view': { label: 'View content pages', group: 'Content', description: 'See site content pages and their drafts.' },
  'content.edit': { label: 'Edit content pages', group: 'Content', description: 'Publish and change site content.' },
  'users.view': { label: 'View users', group: 'Access', description: 'See the list of accounts, their roles and their status.' },
  'users.edit': {
    label: 'Edit users',
    group: 'Access',
    description: 'Change an account\'s role, department or active status. Whoever holds this can change who else can do anything.',
    sensitive: true,
  },
  'settings.view': { label: 'View settings', group: 'System', description: 'See platform configuration.' },
  'settings.edit': {
    label: 'Edit settings',
    group: 'System',
    description: 'Change platform configuration, including integrations and mail.',
    sensitive: true,
  },
  'audit.view': {
    label: 'Read the audit log',
    group: 'System',
    description: 'Read the record of who did what. Granting it is itself worth recording.',
    sensitive: true,
  },
};

/** Every built-in permission key, at runtime. Derived — it cannot drift from the union. */
export const BUILTIN_PERMISSION_KEYS: string[] = Object.keys(BUILTIN_PERMISSIONS);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface PermissionRecord {
  key: string;
  label: string;
  group: string;
  description: string | null;
  /** True when the key came from the code catalogue above rather than from an admin. */
  isBuiltin: boolean;
  isSensitive: boolean;
  sortOrder: number;
}

export interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isSystem: boolean;
  /** How many people hold this role right now. deleteRole() refuses while this is above zero. */
  memberCount: number;
  permissionCount: number;
  /** Surfaced on the list so nobody has to open a role to discover it opens the console. */
  grantsAdminAccess: boolean;
  createdAt: string | null;
}

export interface RoleGrantRecord {
  key: string;
  label: string;
  group: string;
  isSensitive: boolean;
  /**
   * 'grant'         — an explicit row in role_permission_grants (this registry).
   * 'section-matrix' — derived from the page-key checkboxes /admin/team/roles already writes into
   *                    role_permissions. Shown so an admin can SEE where an ability came from
   *                    instead of wondering why a role can do something no grant mentions.
   */
  source: 'grant' | 'section-matrix';
  grantedByEmail: string | null;
  grantedAt: string | null;
}

/** Everything a person may do, plus how confident we are in the answer. */
export interface ResolvedPermissions {
  userId: string;
  /** The built-in role on users.role, or null when the account could not be read. */
  role: string | null;
  /**
   * The answer. Empty whenever `degraded` is true — see the invariant at the top of this file.
   * Contains WILDCARD for super_admin; use holdsPermission()/hasPermission() rather than .has().
   */
  permissions: Set<string>;
  customRoles: { id: string; name: string }[];
  /** True when something failed. An empty set with degraded=false means "genuinely nothing". */
  degraded: boolean;
  reason: 'ok' | 'no-user-id' | 'not-found' | 'account-disabled' | 'lookup-failed';
}

export interface Actor {
  id: string;
  email?: string | null;
  name?: string | null;
  ip?: string | null;
}

export type RegistryResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

const fail = (error: string): RegistryResult<never> => ({ ok: false, error });

// ---------------------------------------------------------------------------------------------
// Schema — self-bootstrapping. No migrations exist on this project.
// ---------------------------------------------------------------------------------------------

// The three tables that already exist are (re)declared IF NOT EXISTS so a fresh database bootstraps
// to the SAME shape src/lib/db/schema.ts describes. On production every one of these is a no-op.
//
// Deliberately NOT added to user_role_assignments: a UNIQUE (user_id, role_id) constraint. It is the
// right shape, but adding a unique index to a live table fails outright if a duplicate pair already
// exists — turning one bad row into a total outage of this module. Duplicates are handled in code
// instead (resolvePermissions unions, assignments are checked before insert).
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS team_roles (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name VARCHAR(80) NOT NULL UNIQUE,
     description TEXT,
     color VARCHAR(20) NOT NULL DEFAULT 'orange',
     is_system BOOLEAN NOT NULL DEFAULT false,
     created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT 'orange'`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  `CREATE TABLE IF NOT EXISTS role_permissions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
     page_key VARCHAR(80) NOT NULL,
     can_view BOOLEAN NOT NULL DEFAULT false,
     can_edit BOOLEAN NOT NULL DEFAULT false,
     can_delete BOOLEAN NOT NULL DEFAULT false,
     can_export BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE INDEX IF NOT EXISTS role_permissions_role_idx ON role_permissions (role_id)`,

  `CREATE TABLE IF NOT EXISTS user_role_assignments (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
     assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS user_role_assign_user_idx ON user_role_assignments (user_id)`,
  `CREATE INDEX IF NOT EXISTS user_role_assign_role_idx ON user_role_assignments (role_id)`,

  // THE CATALOGUE. Permissions live here as rows, which is the whole point of the module: a new
  // permission is an INSERT, not a union member, a build and a deploy.
  `CREATE TABLE IF NOT EXISTS permission_catalogue (
     key TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     group_key TEXT NOT NULL DEFAULT 'Other',
     description TEXT,
     is_builtin BOOLEAN NOT NULL DEFAULT false,
     is_sensitive BOOLEAN NOT NULL DEFAULT false,
     sort_order INTEGER NOT NULL DEFAULT 100,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS permission_catalogue_group_idx ON permission_catalogue (group_key, sort_order)`,

  // WHO HOLDS WHAT. The permission_key FK is ON DELETE RESTRICT on purpose: a permission that is
  // still granted to somebody cannot be quietly deleted out from under them.
  //
  // granted_by_email is denormalised deliberately. "Who granted admin.access" must still have an
  // answer after that person's account is deleted, and a UUID pointing at a dead row is not one.
  `CREATE TABLE IF NOT EXISTS role_permission_grants (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
     permission_key TEXT NOT NULL REFERENCES permission_catalogue(key) ON DELETE RESTRICT,
     granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     granted_by_email TEXT,
     reason TEXT,
     granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (role_id, permission_key))`,
  `CREATE INDEX IF NOT EXISTS role_permission_grants_role_idx ON role_permission_grants (role_id)`,
  `CREATE INDEX IF NOT EXISTS role_permission_grants_key_idx ON role_permission_grants (permission_key)`,
];

/** Every permission the code knows about, ready to seed. Pure — no database, safe to unit test. */
export function seedCatalogueRows(): (PermissionMeta & { key: string; isBuiltin: boolean; sortOrder: number })[] {
  const out: (PermissionMeta & { key: string; isBuiltin: boolean; sortOrder: number })[] = [];
  const seen = new Set<string>();

  // 1. The built-in union, first, so it wins any key collision with a derived one below.
  let i = 0;
  for (const key of BUILTIN_PERMISSION_KEYS) {
    const meta = BUILTIN_PERMISSIONS[key as Permission];
    out.push({ key, ...meta, isBuiltin: true, sortOrder: i++ });
    seen.add(key);
  }

  // 2. The admin sections, as `<section>.<action>`. This is the SAME key shape the existing
  //    /admin/team/roles matrix produces (page_key + a checkbox), so the two systems name the same
  //    ability the same way and a legacy row folds into the catalogue instead of shadowing it.
  //    Adding a section to src/lib/admin-sections.ts therefore adds four grantable permissions with
  //    no code change here.
  const ACTION_LABEL: [SectionAction, string][] = [
    ['view', 'View'], ['edit', 'Edit'], ['delete', 'Delete'], ['export', 'Export'],
  ];
  let order = 1000;
  for (const group of ADMIN_SECTION_GROUPS) {
    for (const section of group.sections) {
      for (const [action, verb] of ACTION_LABEL) {
        const key = section.key + '.' + action;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          key,
          label: verb + ' ' + section.label,
          group: group.label,
          description: (section.hint ? section.hint + '. ' : '') + verb + ' access to the ' + section.label + ' section of the admin console.',
          // Deleting is the irreversible one, so it is flagged everywhere rather than only where
          // somebody remembered to.
          sensitive: action === 'delete',
          isBuiltin: false,
          sortOrder: order++,
        });
      }
    }
  }
  return out;
}

/**
 * Create anything missing and seed the catalogue. Idempotent, and runs at most once per process
 * (ensureOnce). Called at the top of every public function in this file, so no caller has to
 * remember it.
 */
export function ensureRegistrySchema(): Promise<void> {
  return ensureOnce('auth_registry_v1', async () => {
    for (const stmt of DDL) await db.execute(sql.raw(stmt));

    const all = seedCatalogueRows();
    const builtin = all.filter((p) => p.isBuiltin);
    const derived = all.filter((p) => !p.isBuiltin);

    // Built-ins are code-owned: their wording is re-asserted on every boot so an edit to this file
    // reaches the admin UI. is_builtin is forced true so a hand-inserted row cannot masquerade.
    if (builtin.length > 0) {
      const values = sql.join(
        builtin.map((p) => sql`(${p.key}, ${p.label}, ${p.group}, ${p.description}, true, ${!!p.sensitive}, ${p.sortOrder})`),
        sql`, `,
      );
      await db.execute(sql`
        INSERT INTO permission_catalogue (key, label, group_key, description, is_builtin, is_sensitive, sort_order)
        VALUES ${values}
        ON CONFLICT (key) DO UPDATE SET
          label = EXCLUDED.label,
          group_key = EXCLUDED.group_key,
          description = EXCLUDED.description,
          is_builtin = true,
          is_sensitive = EXCLUDED.is_sensitive,
          sort_order = EXCLUDED.sort_order`);
    }

    // Section-derived entries seed once and are then left alone: an admin who renames one in the
    // console should not have it overwritten on the next deploy.
    if (derived.length > 0) {
      const CHUNK = 200; // one statement never gets absurdly large
      for (let i = 0; i < derived.length; i += CHUNK) {
        const part = derived.slice(i, i + CHUNK);
        const values = sql.join(
          part.map((p) => sql`(${p.key}, ${p.label}, ${p.group}, ${p.description}, false, ${!!p.sensitive}, ${p.sortOrder})`),
          sql`, `,
        );
        await db.execute(sql`
          INSERT INTO permission_catalogue (key, label, group_key, description, is_builtin, is_sensitive, sort_order)
          VALUES ${values}
          ON CONFLICT (key) DO NOTHING`);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Audit. Everything that changes who can do what goes through here.
// ---------------------------------------------------------------------------------------------

interface AuditInput {
  actor: Actor;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown>;
}

/**
 * Ordinary audit write: src/lib/audit.ts, which swallows its own failures so a logging hiccup never
 * blocks somebody's work. Right for `content.view`; not right for admin.access.
 */
async function record(input: AuditInput): Promise<void> {
  await logAudit({
    userId: input.actor.id || null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    diff: input.diff,
    ipAddress: input.actor.ip || undefined,
  });
}

/**
 * The same row, written so that a failure is VISIBLE. logAudit() catches and logs; this throws, and
 * the caller undoes the change it was recording.
 *
 * "Granting admin.access must write an audit entry naming who granted it" is only true if the grant
 * cannot outlive a failed write. Same table, same shape, same reader — only the error handling
 * differs.
 */
async function recordStrict(input: AuditInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (user_id, action, entity, entity_id, diff, ip_address)
    VALUES (${input.actor.id || null}, ${input.action}, ${input.entity}, ${input.entityId},
            ${JSON.stringify(input.diff)}::jsonb, ${input.actor.ip || null})`);
}

/** Who did it, in a form that survives the account being deleted. Included in every diff. */
function actorFacts(actor: Actor): Record<string, unknown> {
  return {
    byUserId: actor.id || null,
    byEmail: actor.email || null,
    byName: actor.name || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

const mapPermission = (r: any): PermissionRecord => ({
  key: String(r.key),
  label: String(r.label || r.key),
  group: String(r.group_key || 'Other'),
  description: r.description ?? null,
  isBuiltin: r.is_builtin === true,
  isSensitive: r.is_sensitive === true,
  sortOrder: Number(r.sort_order) || 0,
});

/**
 * The catalogue: every permission that exists, grouped for the editor UI.
 *
 * Read this instead of hardcoding a list. It is what makes /admin/team/roles able to offer a
 * permission that was invented after the page was written.
 */
export async function listPermissions(opts: { group?: string } = {}): Promise<PermissionRecord[]> {
  try {
    await ensureRegistrySchema();
    const where = opts.group ? sql`WHERE group_key = ${opts.group}` : sql``;
    const r = await db.execute(sql`
      SELECT key, label, group_key, description, is_builtin, is_sensitive, sort_order
        FROM permission_catalogue
        ${where}
       ORDER BY sort_order ASC, key ASC`);
    return rows(r).map(mapPermission);
  } catch (e: any) {
    logFail('auth.registry.listPermissions', e);
    return [];
  }
}

/** The catalogue grouped the way the editor renders it, without a second pass in the .astro file. */
export async function listPermissionGroups(): Promise<{ label: string; permissions: PermissionRecord[] }[]> {
  const all = await listPermissions();
  const order: string[] = [];
  const byGroup = new Map<string, PermissionRecord[]>();
  for (const p of all) {
    if (!byGroup.has(p.group)) { byGroup.set(p.group, []); order.push(p.group); }
    (byGroup.get(p.group) as PermissionRecord[]).push(p);
  }
  return order.map((label) => ({ label, permissions: byGroup.get(label) || [] }));
}

/**
 * Custom roles, with the two numbers an admin actually needs before touching one: how many people
 * hold it, and whether it opens the console.
 */
export async function listRoles(): Promise<RoleRecord[]> {
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT tr.id, tr.name, tr.description, tr.color, tr.is_system, tr.created_at,
             (SELECT COUNT(*)::int FROM user_role_assignments ura WHERE ura.role_id = tr.id) AS member_count,
             (SELECT COUNT(*)::int FROM role_permission_grants g WHERE g.role_id = tr.id) AS permission_count,
             EXISTS (SELECT 1 FROM role_permission_grants g
                      WHERE g.role_id = tr.id AND g.permission_key = ${PERM_ADMIN_ACCESS}) AS grants_admin
        FROM team_roles tr
       ORDER BY tr.name ASC`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      name: String(x.name),
      description: x.description ?? null,
      color: String(x.color || 'orange'),
      isSystem: x.is_system === true,
      memberCount: Number(x.member_count) || 0,
      permissionCount: Number(x.permission_count) || 0,
      grantsAdminAccess: x.grants_admin === true,
      createdAt: x.created_at ? String(x.created_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.listRoles', e);
    return [];
  }
}

/**
 * What one role grants — explicit grants AND the abilities implied by the section-matrix rows the
 * existing editor writes, labelled by source so an admin can tell them apart.
 *
 * Showing both is the point. A role can already do things through role_permissions that no grant
 * row mentions, and a screen that hides that is a screen that lies about access.
 */
export async function permissionsForRole(roleId: string): Promise<RoleGrantRecord[]> {
  if (!roleId) return [];
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT s.key, s.source, s.granted_by_email, s.granted_at,
             COALESCE(c.label, s.key) AS label,
             COALESCE(c.group_key, 'Other') AS group_key,
             COALESCE(c.is_sensitive, false) AS is_sensitive,
             COALESCE(c.sort_order, 9999) AS sort_order
        FROM (
          SELECT g.permission_key AS key, 'grant' AS source, g.granted_by_email, g.granted_at
            FROM role_permission_grants g WHERE g.role_id = ${roleId}::uuid
          UNION ALL
          SELECT x.key, 'section-matrix' AS source, NULL::text, NULL::timestamptz
            FROM (
              SELECT rp.page_key || '.view'   AS key FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_view
              UNION SELECT rp.page_key || '.edit'    FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_edit
              UNION SELECT rp.page_key || '.delete'  FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_delete
              UNION SELECT rp.page_key || '.export'  FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_export
            ) x
           WHERE NOT EXISTS (
             SELECT 1 FROM role_permission_grants g2
              WHERE g2.role_id = ${roleId}::uuid AND g2.permission_key = x.key)
        ) s
        LEFT JOIN permission_catalogue c ON c.key = s.key
       ORDER BY sort_order ASC, s.key ASC`);
    return rows(r).map((x: any) => ({
      key: String(x.key),
      label: String(x.label),
      group: String(x.group_key),
      isSensitive: x.is_sensitive === true,
      source: x.source === 'grant' ? 'grant' : 'section-matrix',
      grantedByEmail: x.granted_by_email ?? null,
      grantedAt: x.granted_at ? String(x.granted_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.permissionsForRole', e);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// resolvePermissions — the ONE function that answers what a person may do.
// ---------------------------------------------------------------------------------------------

/**
 * The per-request memo. One entry per user id, hung on Astro's `locals` exactly like
 * src/lib/vsm/memo.ts, so a page that checks eight permissions pays for one resolve.
 *
 * NOT a process cache, deliberately. Caching an answer across requests means a revoked permission
 * keeps working until a TTL expires, and "we removed their access an hour ago" has to be true the
 * moment it is said.
 */
function memoOf(locals: any): Map<string, Promise<ResolvedPermissions>> | null {
  if (!locals || typeof locals !== 'object') return null;
  if (!locals.__permRegistryMemo) locals.__permRegistryMemo = new Map<string, Promise<ResolvedPermissions>>();
  return locals.__permRegistryMemo as Map<string, Promise<ResolvedPermissions>>;
}

/** Drop a memoised answer — call after granting or revoking inside the same request. */
export function invalidateResolved(locals: any, userId?: string): void {
  const memo = memoOf(locals);
  if (!memo) return;
  if (userId) memo.delete('u:' + userId); else memo.clear();
}

function denied(userId: string, r: ResolvedPermissions['reason'], role: string | null = null): ResolvedPermissions {
  return { userId, role, permissions: new Set<string>(), customRoles: [], degraded: r !== 'not-found' && r !== 'account-disabled', reason: r };
}

/**
 * Everything this person may do, merged from every source, in one answer.
 *
 *   built-in role  -> PERMS_BY_ROLE (code; the existing matrix, unchanged)
 *   super_admin    -> WILDCARD, so a permission invented tomorrow is already held
 *   custom roles   -> explicit grants in role_permission_grants
 *                  -> plus the page-key matrix in role_permissions, as `<page_key>.<action>`
 *
 * A custom role ADDS to the built-in role; it never subtracts. There is no deny rule, on purpose —
 * "this role removes a permission the built-in role grants" reads clearly in an editor and is
 * impossible to reason about at three in the morning during an incident. To take an ability away,
 * change the built-in role.
 *
 * A legacy section-matrix row can NEVER produce admin.access, whatever page_key somebody types.
 * That permission is grantable only as itself, deliberately, by name, with an audit entry — because
 * a checkbox that quietly opens the console is the incident this module was written after.
 *
 * FAILS CLOSED. Any error returns an empty set with degraded=true. Callers that must keep working
 * during a database outage should use can() from permissions.ts, which needs no database at all.
 */
export async function resolvePermissions(
  userId: string,
  opts: { locals?: any } = {},
): Promise<ResolvedPermissions> {
  if (!userId) return denied('', 'no-user-id');

  const memo = memoOf(opts.locals);
  const memoKey = 'u:' + userId;
  const cached = memo?.get(memoKey);
  if (cached) return cached;

  const work = (async (): Promise<ResolvedPermissions> => {
    try {
      await ensureRegistrySchema();

      // One round trip for the account AND its custom roles. LEFT JOIN so a person with no custom
      // role still returns their row rather than looking like a missing account.
      const head = rows(await db.execute(sql`
        SELECT u.role, u.is_active, tr.id AS role_id, tr.name AS role_name
          FROM users u
          LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
          LEFT JOIN team_roles tr ON tr.id = ura.role_id
         WHERE u.id = ${userId}::uuid`));

      if (head.length === 0) return denied(userId, 'not-found');

      const role = String(head[0].role || '').trim() || null;
      // A deactivated account keeps its role. Checked separately so the reason is honest.
      if (head[0].is_active === false) return denied(userId, 'account-disabled', role);

      const customRoles: { id: string; name: string }[] = [];
      const seenRole = new Set<string>();
      for (const h of head) {
        if (!h.role_id) continue;
        const id = String(h.role_id);
        if (seenRole.has(id)) continue;   // duplicate assignment rows are tolerated, not counted twice
        seenRole.add(id);
        customRoles.push({ id, name: String(h.role_name || 'role') });
      }

      const permissions = new Set<string>();
      for (const p of (PERMS_BY_ROLE[role as User['role']] || [])) permissions.add(p);
      if (role === 'super_admin') permissions.add(WILDCARD);

      if (customRoles.length > 0) {
        const ids = sql.join(customRoles.map((r) => sql`${r.id}::uuid`), sql`, `);
        // customRoleKeys() has already excluded admin.access from the section-matrix arm, so no
        // page-key row can spell its way to the console however this set is used.
        for (const key of await customRoleKeys(ids)) permissions.add(key);
      }

      return { userId, role, permissions, customRoles, degraded: false, reason: 'ok' };
    } catch (e: any) {
      // THE INVARIANT. No exception path adds a permission — this one returns nothing at all.
      logEvent('error', 'auth.registry.resolve-failed', { userId, message: reason(e) });
      return denied(userId, 'lookup-failed');
    }
  })();

  memo?.set(memoKey, work);
  return work;
}

/**
 * The permission keys a set of custom roles grants: explicit grants UNION the section matrix.
 *
 * Two-step on purpose. role_permission_grants is new, and on a database where its DDL has not run
 * yet (a blocked deploy, a replica behind) the first query fails — at which point falling straight
 * to "deny everyone" would take the console down for a system that has worked for months. So the
 * fallback re-asks the LEGACY table alone, which is exactly today's behaviour and cannot grant more
 * than today grants. If that fails too, the error propagates and resolvePermissions denies.
 */
async function customRoleKeys(ids: any): Promise<string[]> {
  // `admin.access` is filtered out of the section-matrix arm, not merely absent from it: page_key is
  // free text written by a form, and `<page_key>.<action>` must not be able to spell it.
  const legacyArm = sql`
      SELECT rp.page_key || '.view'   AS k FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_view
      UNION SELECT rp.page_key || '.edit'   FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_edit
      UNION SELECT rp.page_key || '.delete' FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_delete
      UNION SELECT rp.page_key || '.export' FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_export`;

  try {
    const r = await db.execute(sql`
      SELECT k FROM (
        SELECT g.permission_key AS k FROM role_permission_grants g WHERE g.role_id IN (${ids})
        UNION
        SELECT k FROM (${legacyArm}) legacy WHERE k <> ${PERM_ADMIN_ACCESS}
      ) merged`);
    return rows(r).map((x: any) => String(x.k)).filter(Boolean);
  } catch (e: any) {
    logEvent('warn', 'auth.registry.grants-unavailable', { message: reason(e) });
    const r = await db.execute(sql`SELECT k FROM (${legacyArm}) legacy WHERE k <> ${PERM_ADMIN_ACCESS}`);
    return rows(r).map((x: any) => String(x.k)).filter(Boolean);
  }
}

/** Wildcard-aware membership test. Use this rather than `resolved.permissions.has(key)`. */
export function holdsPermission(resolved: ResolvedPermissions | null | undefined, key: string): boolean {
  if (!resolved || !key) return false;
  return resolved.permissions.has(WILDCARD) || resolved.permissions.has(key);
}

/**
 * The single test callers use.
 *
 *   if (!(await hasPermission(user.id, 'offers.edit', { locals: Astro.locals }))) return deny();
 *
 * Pass `locals` wherever you have it: the resolve is then memoised for the rest of the request and
 * eight checks on one page cost one lookup.
 */
export async function hasPermission(userId: string, key: string, opts: { locals?: any } = {}): Promise<boolean> {
  if (!userId || !key) return false;
  const resolved = await resolvePermissions(userId, opts);
  return holdsPermission(resolved, key);
}

/** True only if the person holds EVERY key. Same fail-closed behaviour. */
export async function hasAllPermissions(userId: string, keys: string[], opts: { locals?: any } = {}): Promise<boolean> {
  if (!userId || !keys?.length) return false;
  const resolved = await resolvePermissions(userId, opts);
  return keys.every((k) => holdsPermission(resolved, k));
}

// ---------------------------------------------------------------------------------------------
// Writes. Every one of them is audited.
// ---------------------------------------------------------------------------------------------

async function roleRow(roleId: string): Promise<{ id: string; name: string; isSystem: boolean } | null> {
  const r = rows(await db.execute(sql`SELECT id, name, is_system FROM team_roles WHERE id = ${roleId}::uuid LIMIT 1`))[0];
  return r ? { id: String(r.id), name: String(r.name), isSystem: r.is_system === true } : null;
}

async function permissionRow(key: string): Promise<{ key: string; label: string; isSensitive: boolean } | null> {
  const r = rows(await db.execute(sql`SELECT key, label, is_sensitive FROM permission_catalogue WHERE key = ${key} LIMIT 1`))[0];
  return r ? { key: String(r.key), label: String(r.label), isSensitive: r.is_sensitive === true } : null;
}

/**
 * Create a custom role. Empty of permissions until somebody grants some, which is the correct
 * starting point: a new role that can do nothing is safe, a new role that inherits "roughly what
 * the last one had" is how an intern gets admin.access.
 */
export async function createRole(
  input: { name: string; description?: string | null; color?: string | null },
  actor: Actor,
): Promise<RegistryResult<{ id: string }>> {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim() || null;
  const color = String(input.color || 'orange').trim().slice(0, 20) || 'orange';

  if (name.length < ROLE_NAME_MIN) return fail('Give the role a name of at least ' + ROLE_NAME_MIN + ' characters.');
  if (name.length > ROLE_NAME_MAX) return fail('Role names are limited to ' + ROLE_NAME_MAX + ' characters.');
  if (!actor?.id) return fail('A signed-in person must be recorded as creating the role.');

  try {
    await ensureRegistrySchema();
    const clash = rows(await db.execute(sql`SELECT id FROM team_roles WHERE lower(name) = ${name.toLowerCase()} LIMIT 1`));
    if (clash.length > 0) return fail('A role called "' + name + '" already exists.');

    const created = rows(await db.execute(sql`
      INSERT INTO team_roles (name, description, color, created_by_user_id)
      VALUES (${name}, ${description}, ${color}, ${actor.id}::uuid)
      RETURNING id`))[0];
    const id = String(created.id);

    await record({
      actor, action: 'role.create', entity: 'team_role', entityId: id,
      diff: { name, description, color, ...actorFacts(actor) },
    });
    return { ok: true, data: { id } };
  } catch (e: any) {
    logFail('auth.registry.createRole', e);
    return fail(reason(e));
  }
}

/** Rename or re-describe a role. Its permissions are changed with assign/revokePermission, not here. */
export async function updateRole(
  roleId: string,
  patch: { name?: string; description?: string | null; color?: string | null },
  actor: Actor,
): Promise<RegistryResult> {
  if (!roleId) return fail('No role given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as making the change.');

  try {
    await ensureRegistrySchema();
    const before = rows(await db.execute(sql`
      SELECT id, name, description, color, is_system FROM team_roles WHERE id = ${roleId}::uuid LIMIT 1`))[0];
    if (!before) return fail('No such role.');

    const name = patch.name === undefined ? String(before.name) : String(patch.name || '').trim();
    if (name.length < ROLE_NAME_MIN) return fail('Give the role a name of at least ' + ROLE_NAME_MIN + ' characters.');
    if (name.length > ROLE_NAME_MAX) return fail('Role names are limited to ' + ROLE_NAME_MAX + ' characters.');
    // A system role is referenced by name elsewhere; renaming it silently breaks those references.
    if (before.is_system === true && name !== String(before.name)) {
      return fail('This is a system role. Its name is referenced elsewhere and cannot be changed here.');
    }

    const clash = rows(await db.execute(sql`
      SELECT id FROM team_roles WHERE lower(name) = ${name.toLowerCase()} AND id <> ${roleId}::uuid LIMIT 1`));
    if (clash.length > 0) return fail('Another role is already called "' + name + '".');

    const description = patch.description === undefined
      ? (before.description ?? null)
      : (String(patch.description || '').trim() || null);
    const color = patch.color === undefined
      ? String(before.color || 'orange')
      : (String(patch.color || 'orange').trim().slice(0, 20) || 'orange');

    await db.execute(sql`
      UPDATE team_roles SET name = ${name}, description = ${description}, color = ${color}, updated_at = NOW()
       WHERE id = ${roleId}::uuid`);

    await record({
      actor, action: 'role.update', entity: 'team_role', entityId: roleId,
      diff: {
        before: { name: before.name, description: before.description ?? null, color: before.color },
        after: { name, description, color },
        ...actorFacts(actor),
      },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.updateRole', e);
    return fail(reason(e));
  }
}

/**
 * Delete a role — and REFUSE while anyone still holds it.
 *
 * The database would happily cascade the assignments away. That is precisely the failure to avoid:
 * the people holding the role silently lose whatever it granted, nobody is told which people or
 * which abilities, and the first symptom is somebody unable to do their job with no explanation.
 * Unassign them first, deliberately, and the removal is visible to whoever does it.
 */
export async function deleteRole(roleId: string, actor: Actor): Promise<RegistryResult> {
  if (!roleId) return fail('No role given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as deleting the role.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');
    if (role.isSystem) return fail('"' + role.name + '" is a system role and cannot be deleted.');

    const holders = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM user_role_assignments WHERE role_id = ${roleId}::uuid`))[0];
    const n = Number(holders?.n) || 0;
    if (n > 0) {
      return fail(
        n + (n === 1 ? ' person still holds' : ' people still hold') + ' "' + role.name + '". '
        + 'Remove them from the role first — deleting it now would take away whatever it grants '
        + 'without telling anyone.',
      );
    }

    // Captured BEFORE the delete: an audit line that says only "role deleted" cannot answer what
    // was destroyed.
    const held = rows(await db.execute(sql`
      SELECT permission_key FROM role_permission_grants WHERE role_id = ${roleId}::uuid`))
      .map((x: any) => String(x.permission_key));

    await db.execute(sql`DELETE FROM role_permission_grants WHERE role_id = ${roleId}::uuid`);
    await db.execute(sql`DELETE FROM role_permissions WHERE role_id = ${roleId}::uuid`);
    await db.execute(sql`DELETE FROM team_roles WHERE id = ${roleId}::uuid`);

    await record({
      actor, action: 'role.delete', entity: 'team_role', entityId: roleId,
      diff: { name: role.name, permissionsHeld: held, ...actorFacts(actor) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.deleteRole', e);
    return fail(reason(e));
  }
}

/**
 * Grant one permission to one role.
 *
 * A SENSITIVE permission (admin.access, users.edit, settings.edit, audit.view, any `.delete`) is
 * written and then AUDITED STRICTLY: if the audit row cannot be written, the grant is rolled back
 * and the caller is told. The requirement is not "log the grant if convenient" — it is that a grant
 * of admin.access cannot exist without a record naming the person who made it, and the only way to
 * mean that is to undo the grant when the record fails.
 */
export async function assignPermission(
  roleId: string,
  permissionKey: string,
  actor: Actor,
  opts: { reason?: string } = {},
): Promise<RegistryResult> {
  const key = String(permissionKey || '').trim();
  if (!roleId) return fail('No role given.');
  if (!key) return fail('No permission given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as granting the permission.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const perm = await permissionRow(key);
    // Not catalogued means not grantable. A typo must fail loudly rather than create a permission
    // nothing will ever check, which reads as "granted" on a screen and grants nothing.
    if (!perm) return fail('"' + key + '" is not a known permission. Add it to the catalogue first.');

    const why = String(opts.reason || '').trim().slice(0, 2000) || null;

    const inserted = rows(await db.execute(sql`
      INSERT INTO role_permission_grants (role_id, permission_key, granted_by_user_id, granted_by_email, reason)
      VALUES (${roleId}::uuid, ${key}, ${actor.id}::uuid, ${actor.email || null}, ${why})
      ON CONFLICT (role_id, permission_key) DO NOTHING
      RETURNING id`));
    if (inserted.length === 0) return { ok: true };   // already granted; nothing changed, nothing to log

    const diff: Record<string, unknown> = {
      roleId, roleName: role.name, permissionKey: key, permissionLabel: perm.label,
      sensitive: perm.isSensitive, reason: why, ...actorFacts(actor),
    };
    if (key === PERM_ADMIN_ACCESS) {
      // Written in words, in the record itself. Whoever reads this log later should not have to
      // know what the key means to understand what happened.
      diff.notice = (actor.email || actor.name || actor.id)
        + ' granted admin console access to the role "' + role.name + '".';
    }

    if (!perm.isSensitive) {
      await record({ actor, action: 'permission.grant', entity: 'role_permission', entityId: roleId + ':' + key, diff });
      return { ok: true };
    }

    try {
      await recordStrict({ actor, action: 'permission.grant.sensitive', entity: 'role_permission', entityId: roleId + ':' + key, diff });
    } catch (auditErr: any) {
      // The grant must not survive the failed record. If the rollback ALSO fails there is now an
      // unaudited sensitive grant, which is the one situation worth shouting about.
      try {
        await db.execute(sql`
          DELETE FROM role_permission_grants WHERE role_id = ${roleId}::uuid AND permission_key = ${key}`);
      } catch (rollbackErr: any) {
        logEvent('error', 'auth.registry.unaudited-grant', {
          roleId, roleName: role.name, permissionKey: key,
          byUserId: actor.id, byEmail: actor.email || null,
          auditError: reason(auditErr), rollbackError: reason(rollbackErr),
        });
        return fail('"' + perm.label + '" was granted but could NOT be recorded in the audit log, and the grant could not be undone. Revoke it by hand and tell whoever runs this system.');
      }
      logFail('auth.registry.assignPermission.audit', auditErr);
      return fail('"' + perm.label + '" was not granted: the audit log could not record who granted it, and a sensitive permission is not granted off the record. Try again.');
    }

    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.assignPermission', e);
    return fail(reason(e));
  }
}

/**
 * Take a permission away from a role.
 *
 * NOTE THE ASYMMETRY WITH assignPermission, which is deliberate. A grant that cannot be recorded is
 * refused; a REVOKE that cannot be recorded still happens. Refusing to remove access because the
 * logging is down is failing OPEN, and the log line is written loudly instead.
 */
export async function revokePermission(
  roleId: string,
  permissionKey: string,
  actor: Actor,
): Promise<RegistryResult> {
  const key = String(permissionKey || '').trim();
  if (!roleId) return fail('No role given.');
  if (!key) return fail('No permission given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as revoking the permission.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const removed = rows(await db.execute(sql`
      DELETE FROM role_permission_grants
       WHERE role_id = ${roleId}::uuid AND permission_key = ${key}
       RETURNING id`));

    // A section-matrix row can grant the same ability. Say so rather than reporting success and
    // leaving the person still able to do the thing that was just "removed".
    const stillVia = key === PERM_ADMIN_ACCESS ? [] : rows(await db.execute(sql`
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.view') = ${key} AND rp.can_view
       UNION ALL
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.edit') = ${key} AND rp.can_edit
       UNION ALL
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.delete') = ${key} AND rp.can_delete
       UNION ALL
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.export') = ${key} AND rp.can_export
       LIMIT 1`));

    if (removed.length > 0) {
      await record({
        actor, action: 'permission.revoke', entity: 'role_permission', entityId: roleId + ':' + key,
        diff: { roleId, roleName: role.name, permissionKey: key, ...actorFacts(actor) },
      });
    }

    if (stillVia.length > 0) {
      return fail(
        'The grant was removed, but "' + role.name + '" still has this through the page permissions '
        + 'matrix. Untick it there as well, or the role keeps the ability.',
      );
    }
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.revokePermission', e);
    return fail(reason(e));
  }
}

/**
 * Add a permission to the catalogue from the admin panel — the reason permissions are data.
 *
 * A key here is a promise that something checks it. Registering `reports.export` does not create a
 * check; a caller still has to ask hasPermission(). The description field is where that gets written
 * down, so an admin granting it later knows what it actually controls.
 */
export async function registerPermission(
  input: { key: string; label: string; group?: string | null; description?: string | null; isSensitive?: boolean },
  actor: Actor,
): Promise<RegistryResult> {
  const key = String(input.key || '').trim().toLowerCase();
  const label = String(input.label || '').trim();
  const group = String(input.group || 'Other').trim() || 'Other';
  const description = String(input.description || '').trim() || null;
  const isSensitive = input.isSensitive === true;

  if (!PERMISSION_KEY_RE.test(key)) {
    return fail('A permission key looks like "reports.export": lowercase words separated by dots.');
  }
  if (label.length < 3) return fail('Give the permission a label somebody will understand on a checkbox.');
  if (!actor?.id) return fail('A signed-in person must be recorded as adding the permission.');

  try {
    await ensureRegistrySchema();
    const existing = await permissionRow(key);
    // Built-ins are owned by the code catalogue above; editing them here would be overwritten on the
    // next deploy, so it is refused rather than silently lost.
    if (existing) {
      const isBuiltin = rows(await db.execute(sql`SELECT is_builtin FROM permission_catalogue WHERE key = ${key} LIMIT 1`))[0]?.is_builtin === true;
      if (isBuiltin) return fail('"' + key + '" is a built-in permission and is described in code.');
    }

    await db.execute(sql`
      INSERT INTO permission_catalogue (key, label, group_key, description, is_builtin, is_sensitive, sort_order)
      VALUES (${key}, ${label}, ${group}, ${description}, false, ${isSensitive}, 5000)
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        group_key = EXCLUDED.group_key,
        description = EXCLUDED.description,
        is_sensitive = EXCLUDED.is_sensitive`);

    await record({
      actor, action: existing ? 'permission.catalogue.update' : 'permission.catalogue.add',
      entity: 'permission_catalogue', entityId: key,
      diff: { key, label, group, description, isSensitive, ...actorFacts(actor) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.registerPermission', e);
    return fail(reason(e));
  }
}

/**
 * Everyone who holds a given permission through a custom role, for the question that follows an
 * incident: "who can open the console, and who gave it to them?"
 *
 * Built-in roles are NOT included — those are answered by PERMS_BY_ROLE and /admin/access-preview,
 * which needs no query at all.
 */
export async function whoHolds(permissionKey: string): Promise<{
  userId: string; name: string | null; email: string | null;
  roleId: string; roleName: string; grantedByEmail: string | null; grantedAt: string | null;
}[]> {
  const key = String(permissionKey || '').trim();
  if (!key) return [];
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT u.id AS user_id, u.name, u.email, tr.id AS role_id, tr.name AS role_name,
             g.granted_by_email, g.granted_at
        FROM role_permission_grants g
        JOIN team_roles tr ON tr.id = g.role_id
        JOIN user_role_assignments ura ON ura.role_id = tr.id
        JOIN users u ON u.id = ura.user_id
       WHERE g.permission_key = ${key}
       ORDER BY tr.name ASC, u.name ASC
       LIMIT 500`);
    return rows(r).map((x: any) => ({
      userId: String(x.user_id),
      name: x.name ?? null,
      email: x.email ?? null,
      roleId: String(x.role_id),
      roleName: String(x.role_name),
      grantedByEmail: x.granted_by_email ?? null,
      grantedAt: x.granted_at ? String(x.granted_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.whoHolds', e);
    return [];
  }
}
