// src/lib/rbac/schema.ts — persistence for the Kernel Permission Engine. Tables are
// `rbac_`-prefixed so they NEVER collide with the existing hiring `roles`, `team_roles`,
// `role_permissions`, or `user_role_assignments` (which keep working, untouched). Created
// via self-bootstrapping DDL (store.ensureRbacSchema), the repo's dominant pattern.
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';

export const rbacCapabilities = pgTable('rbac_capabilities', {
  key: text('key').primaryKey(),
  description: text('description'),
});

export const rbacRoles = pgTable('rbac_roles', {
  key: text('key').primaryKey(),
  surface: text('surface').notNull(),            // 'admin' | 'main'
  description: text('description'),
  color: text('color').notNull().default('orange'),
  isSystem: boolean('is_system').notNull().default(true),
  inherits: text('inherits').array().notNull().default([]),
});

export const rbacRoleCapabilities = pgTable('rbac_role_capabilities', {
  roleKey: text('role_key').notNull(),
  capability: text('capability').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleKey, t.capability] }) }));

export const rbacUserRoles = pgTable('rbac_user_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  roleKey: text('role_key').notNull(),
  stage: text('stage'),                          // only meaningful for role_key='student'
  assignedBy: uuid('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ userIdx: index('rbac_user_roles_user_idx').on(t.userId) }));

export const rbacPermissionGrants = pgTable('rbac_permission_grants', {
  permissionId: uuid('permission_id').primaryKey().defaultRandom(),
  identityRef: text('identity_ref').notNull(),
  resourceRef: text('resource_ref').notNull(),
  operation: text('operation').notNull(),
  effect: text('effect').notNull().default('allow'),
  state: text('state').notNull().default('defined'),
  inheritancePolicy: text('inheritance_policy').notNull().default('none'),
  conditions: jsonb('conditions').notNull().default({}),
  priority: integer('priority').notNull().default(0),
  version: integer('version').notNull().default(1),
  flags: text('flags').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ idIdx: index('rbac_grants_identity_idx').on(t.identityRef) }));

export const rbacGuardianLinks = pgTable('rbac_guardian_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  guardianUserId: uuid('guardian_user_id').notNull(),
  minorUserId: uuid('minor_user_id').notNull(),
  consent: jsonb('consent').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ minorIdx: index('rbac_guardian_minor_idx').on(t.minorUserId) }));

export const rbacAudit = pgTable('rbac_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id'),
  capability: text('capability').notNull(),
  resource: text('resource').notNull(),
  allow: boolean('allow').notNull(),
  reason: text('reason').notNull(),
  stage: text('stage').notNull(),
  matchedGrant: text('matched_grant'),
  context: jsonb('context').notNull().default({}),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ userIdx: index('rbac_audit_user_idx').on(t.userId), atIdx: index('rbac_audit_at_idx').on(t.at) }));

// Block 10 — delegated, scoped, revocable capability tokens (KCMS). The opaque bearer
// secret is returned once at issue time; only its sha256 is stored (mirrors auth/session.ts).
export const rbacCapabilityTokens = pgTable('rbac_capability_tokens', {
  tokenId: uuid('token_id').primaryKey().defaultRandom(),
  ownerIdentity: uuid('owner_identity').notNull(),
  issuedBy: uuid('issued_by'),
  targetResource: text('target_resource').notNull(),
  allowedOperations: text('allowed_operations').array().notNull().default([]),
  scope: jsonb('scope').notNull().default({}),
  delegatedFrom: uuid('delegated_from'),
  delegationDepth: integer('delegation_depth').notNull().default(0),
  status: text('status').notNull().default('issued'),
  version: integer('version').notNull().default(1),
  secretHash: text('secret_hash').notNull(),
  reason: text('reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerIdx: index('rbac_captok_owner_idx').on(t.ownerIdentity),
  hashIdx: index('rbac_captok_hash_idx').on(t.secretHash),
  parentIdx: index('rbac_captok_parent_idx').on(t.delegatedFrom),
}));

export const RBAC_TOKENS_DDL = [
  `CREATE TABLE IF NOT EXISTS rbac_capability_tokens (
     token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_identity UUID NOT NULL,
     issued_by UUID,
     target_resource TEXT NOT NULL,
     allowed_operations TEXT[] NOT NULL DEFAULT '{}',
     scope JSONB NOT NULL DEFAULT '{}'::jsonb,
     delegated_from UUID,
     delegation_depth INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'issued',
     version INTEGER NOT NULL DEFAULT 1,
     secret_hash TEXT NOT NULL,
     reason TEXT,
     expires_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS rbac_captok_owner_idx  ON rbac_capability_tokens (owner_identity)`,
  `CREATE INDEX IF NOT EXISTS rbac_captok_hash_idx   ON rbac_capability_tokens (secret_hash)`,
  `CREATE INDEX IF NOT EXISTS rbac_captok_parent_idx ON rbac_capability_tokens (delegated_from)`,
];

export const RBAC_DDL = [
  `CREATE TABLE IF NOT EXISTS rbac_capabilities (key TEXT PRIMARY KEY, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS rbac_roles (key TEXT PRIMARY KEY, surface TEXT NOT NULL, description TEXT, color TEXT NOT NULL DEFAULT 'orange', is_system BOOLEAN NOT NULL DEFAULT true, inherits TEXT[] NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS rbac_role_capabilities (role_key TEXT NOT NULL, capability TEXT NOT NULL, PRIMARY KEY (role_key, capability))`,
  `CREATE TABLE IF NOT EXISTS rbac_user_roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, role_key TEXT NOT NULL, stage TEXT, assigned_by UUID, assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, role_key))`,
  `CREATE INDEX IF NOT EXISTS rbac_user_roles_user_idx ON rbac_user_roles (user_id)`,
  `CREATE TABLE IF NOT EXISTS rbac_permission_grants (permission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), identity_ref TEXT NOT NULL, resource_ref TEXT NOT NULL, operation TEXT NOT NULL, effect TEXT NOT NULL DEFAULT 'allow', state TEXT NOT NULL DEFAULT 'defined', inheritance_policy TEXT NOT NULL DEFAULT 'none', conditions JSONB NOT NULL DEFAULT '{}'::jsonb, priority INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, flags TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS rbac_grants_identity_idx ON rbac_permission_grants (identity_ref)`,
  `CREATE TABLE IF NOT EXISTS rbac_guardian_links (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), guardian_user_id UUID NOT NULL, minor_user_id UUID NOT NULL, consent JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (guardian_user_id, minor_user_id))`,
  `CREATE INDEX IF NOT EXISTS rbac_guardian_minor_idx ON rbac_guardian_links (minor_user_id)`,
  `CREATE TABLE IF NOT EXISTS rbac_audit (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, capability TEXT NOT NULL, resource TEXT NOT NULL, allow BOOLEAN NOT NULL, reason TEXT NOT NULL, stage TEXT NOT NULL, matched_grant TEXT, context JSONB NOT NULL DEFAULT '{}'::jsonb, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS rbac_audit_user_idx ON rbac_audit (user_id)`,
  `CREATE INDEX IF NOT EXISTS rbac_audit_at_idx ON rbac_audit (at DESC)`,
];
