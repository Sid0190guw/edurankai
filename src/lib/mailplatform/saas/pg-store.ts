// src/lib/mailplatform/saas/pg-store.ts — the Postgres implementation of SaasStore.
//
// THE RULE THIS FILE IS WRITTEN TO, AND THE TEST THAT ENFORCES IT
//
// Every statement that touches a tenant-scoped table names `org_id` in its predicate. Not "usually",
// not "where it matters" — every one, including the ones where the id being looked up is already
// unique. A subscription id is unique, so `WHERE id = $1` would return the right row; it would also
// return it to a caller from another tenant who guessed the id. Adding `AND org_id = $2` costs
// nothing and closes that door permanently.
//
// `saas-isolation.test.ts` reads THIS FILE'S SOURCE, finds every statement against a tenant table,
// and fails if one of them has no `org_id` in it. That test is the reason the rule survives the
// next person to add a query here, including a future me who is in a hurry.
//
// The one exemption is `mp_organizations` itself, whose primary key IS the tenant id — a query
// filtering `id = $1` on that table is already tenant-scoped by definition.
//
// SCHEMA BOOTSTRAP DEFERS TO THE CORE AGENT AND THEN ADDS ONLY WHAT IS MISSING.
//
// `mp_organizations` and `mp_organization_members` belong to src/lib/mailplatform/schema.ts. This
// file does not define them — it calls `ensureMailPlatformSchema()` and then creates the eleven
// tables that are this layer's own, plus ONE additive column (`team_role`) on the members table.
// Writing a second CREATE TABLE for a table somebody else owns is how two definitions drift: both
// are `IF NOT EXISTS`, so whichever runs first silently wins and the other's constraints never
// exist. Their members table, for instance, enforces uniqueness with a PARTIAL index rather than a
// column constraint, which a duplicate definition here would have quietly replaced.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { ensureMailPlatformSchema } from '../schema';
import {
  addMember as coreAddMember,
  createOrg as coreCreateOrg,
  removeMember as coreRemoveMember,
} from '../orgs';
import type { Organization, UUID } from '../types';
import type {
  BillingEvent,
  BillingEventType,
  EnterpriseTerms,
  Invoice,
  MetricKey,
  OrgProfile,
  Plan,
  QuotaNotice,
  Subscription,
  Team,
  TeamMember,
  TeamRole,
  UsageCounter,
  UsageEvent,
} from './types';
import type { MembershipRow, RecordResult, SaasStore, UsageEventQuery } from './store';
import { normalizeTeamRole, platformRoleFor } from './roles';
import { DEFAULT_OVERAGE } from './plans';

/** postgres-js returns a plain array, never `{ rows }`. See CLAUDE.md; this has broken before. */
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/** The real Postgres reason lives on `cause`; `e.message` is only the SQL that failed. */
function reason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown database error');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

export function ensureSaasSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = bootstrap().catch((e) => {
      // Reset so the NEXT call retries. A one-shot promise that caches a failure turns a transient
      // pooler timeout at boot into a permanently broken subsystem for the life of the process.
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/**
 * The DDL, as strings rather than as inline `sql` templates.
 *
 * Two reasons, both borrowed from the neighbouring src/lib/mailplatform/schema.ts. First, the same
 * array can be applied by the runtime AND emitted as a .sql file an operator runs by hand, so the
 * file and the code cannot drift — this project's rules say a migration against production is
 * handed over rather than run, and a hand-maintained copy of the schema is wrong within a week.
 * Second, it keeps DDL out of the `sql` templates the tenant-isolation test scans, so that test is
 * checking predicates rather than skipping CREATE statements by regular expression.
 */
export const SAAS_DDL: string[] = [
  // ADDITIVE, and the only change this layer makes to a table it does not own. The contract's
  // five-value `role` stays authoritative for other subsystems; the nine team roles live beside it.
  // See the header of ./types.ts for why this is a column and not a widened union.
  `ALTER TABLE mp_organization_members ADD COLUMN IF NOT EXISTS team_role VARCHAR(24)`,
  `CREATE TABLE IF NOT EXISTS mp_org_profiles (
    org_id UUID PRIMARY KEY REFERENCES mp_organizations(id) ON DELETE CASCADE,
    org_type VARCHAR(24) NOT NULL DEFAULT 'individual',
    billing_email VARCHAR(255),
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    tax_id VARCHAR(64),
    country VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS mp_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(org_id, slug))`,
  `CREATE TABLE IF NOT EXISTS mp_team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES mp_teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    team_role VARCHAR(24) NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS mp_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    tier VARCHAR(24) NOT NULL DEFAULT 'enterprise',
    description TEXT NOT NULL DEFAULT '',
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    features JSONB NOT NULL DEFAULT '[]'::jsonb,
    overage JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, key))`,
  `CREATE TABLE IF NOT EXISTS mp_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES mp_organizations(id) ON DELETE CASCADE,
    plan_key VARCHAR(64) NOT NULL DEFAULT 'free',
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    period_end TIMESTAMPTZ NOT NULL,
    trial_ends_at TIMESTAMPTZ,
    cancel_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    pending_plan_key VARCHAR(64),
    pending_plan_at TIMESTAMPTZ,
    custom_limits JSONB,
    custom_overage JSONB,
    last_billing_event_at TIMESTAMPTZ,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_ref VARCHAR(200),
    suspended_reason TEXT,
    suspended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS mp_enterprise_terms (
    org_id UUID PRIMARY KEY REFERENCES mp_organizations(id) ON DELETE CASCADE,
    sla_uptime_percent VARCHAR(16),
    sla_support_response VARCHAR(120),
    dedicated_infra BOOLEAN NOT NULL DEFAULT false,
    dedicated_ips JSONB NOT NULL DEFAULT '[]'::jsonb,
    custom_smtp_host VARCHAR(255),
    data_retention_days INTEGER,
    data_region VARCHAR(64),
    contract_ref VARCHAR(120),
    contract_ends_at TIMESTAMPTZ,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS mp_usage_events (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL,
    quantity NUMERIC NOT NULL DEFAULT 0,
    mode VARCHAR(8) NOT NULL DEFAULT 'delta',
    source VARCHAR(64) NOT NULL DEFAULT 'unknown',
    idempotency_key VARCHAR(200),
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_usage_idem_idx
    ON mp_usage_events(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS mp_usage_org_metric_idx
    ON mp_usage_events(org_id, metric, occurred_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mp_usage_counters (
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    value NUMERIC NOT NULL DEFAULT 0,
    peak NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, metric, period_start))`,
  `CREATE TABLE IF NOT EXISTS mp_quota_notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    threshold NUMERIC NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'warning',
    notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, metric, period_start, threshold))`,
  `CREATE TABLE IF NOT EXISTS mp_billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES mp_organizations(id) ON DELETE SET NULL,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    event_id VARCHAR(200) NOT NULL,
    type VARCHAR(48) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    error TEXT,
    UNIQUE(provider, event_id))`,
  `CREATE INDEX IF NOT EXISTS mp_billing_events_org_idx
    ON mp_billing_events(org_id, occurred_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mp_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    number VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    subtotal_minor BIGINT NOT NULL DEFAULT 0,
    tax_minor BIGINT NOT NULL DEFAULT 0,
    total_minor BIGINT NOT NULL DEFAULT 0,
    amount_paid_minor BIGINT NOT NULL DEFAULT 0,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    issued_at TIMESTAMPTZ,
    due_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_ref VARCHAR(200),
    hosted_url TEXT,
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, number))`,
];

/**
 * The whole SaaS schema as one .sql body, for an operator to apply by hand.
 *
 * Generated from SAAS_DDL, never written twice. Printed by `ensureSaasSchema()`'s failure path and
 * available to any admin screen that wants to hand over the command instead of running it.
 */
export function saasSchemaSql(): string {
  return [
    '-- db/mail-saas-schema.sql',
    '-- GENERATED. Source of truth: src/lib/mailplatform/saas/pg-store.ts (SAAS_DDL).',
    '--',
    '-- Apply AFTER db/mail-platform-schema.sql: every table here has a foreign key into',
    '-- mp_organizations. Idempotent and additive - safe on a fresh database and on a populated one.',
    '',
    ...SAAS_DDL.map((s) => s.trim() + ';'),
    '',
  ].join('\n');
}

async function bootstrap(): Promise<void> {
  // The tenant root and the membership table come from the core agent's migration. Everything below
  // has a foreign key into them, so a failure here is fatal and is reported with its real reason
  // rather than being pushed one statement further down.
  const core = await ensureMailPlatformSchema();
  if (!core.ok) {
    throw new Error(
      'The mail platform schema is not in place, so the SaaS tables cannot be created on top of it: '
      + (core.error || 'no reason reported') + '.',
    );
  }
  for (const stmt of SAAS_DDL) await db.execute(sql.raw(stmt));
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function iso(v: any): string {
  if (!v) return new Date(0).toISOString();
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function isoOrNull(v: any): string | null {
  return v ? iso(v) : null;
}

function num(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function obj(v: any): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return typeof v === 'object' ? v as Record<string, unknown> : {};
}

function arr(v: any): any[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function toOrganization(r: any): Organization {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    settings: obj(r.settings),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: isoOrNull(r.deleted_at),
  };
}

function toMembership(r: any): MembershipRow {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    role: r.role,
    teamRole: normalizeTeamRole(r.team_role, r.role),
    invitedBy: r.invited_by || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: isoOrNull(r.deleted_at),
    userName: r.user_name ?? null,
    userEmail: r.user_email ?? null,
  };
}

function toSubscription(r: any): Subscription {
  return {
    id: r.id,
    orgId: r.org_id,
    planKey: r.plan_key,
    status: r.status,
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    trialEndsAt: isoOrNull(r.trial_ends_at),
    cancelAt: isoOrNull(r.cancel_at),
    cancelledAt: isoOrNull(r.cancelled_at),
    pendingPlanKey: r.pending_plan_key || null,
    pendingPlanAt: isoOrNull(r.pending_plan_at),
    customLimits: r.custom_limits ? obj(r.custom_limits) as any : null,
    customOverage: r.custom_overage ? obj(r.custom_overage) as any : null,
    lastBillingEventAt: isoOrNull(r.last_billing_event_at),
    provider: r.provider || 'manual',
    providerRef: r.provider_ref || null,
    suspendedReason: r.suspended_reason || null,
    suspendedAt: isoOrNull(r.suspended_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toPlan(r: any): Plan {
  return {
    key: r.key,
    name: r.name,
    tier: r.tier,
    description: r.description || '',
    limits: obj(r.limits) as any,
    features: arr(r.features),
    overage: { ...DEFAULT_OVERAGE, ...(obj(r.overage) as any) },
    isCustom: true,
    orgId: r.org_id || null,
    isActive: r.is_active !== false,
    sortOrder: num(r.sort_order, 100),
  };
}

function toInvoice(r: any): Invoice {
  return {
    id: r.id,
    orgId: r.org_id,
    number: r.number,
    status: r.status,
    currency: r.currency || 'INR',
    subtotalMinor: num(r.subtotal_minor),
    taxMinor: num(r.tax_minor),
    totalMinor: num(r.total_minor),
    amountPaidMinor: num(r.amount_paid_minor),
    periodStart: isoOrNull(r.period_start),
    periodEnd: isoOrNull(r.period_end),
    issuedAt: isoOrNull(r.issued_at),
    dueAt: isoOrNull(r.due_at),
    paidAt: isoOrNull(r.paid_at),
    provider: r.provider || 'manual',
    providerRef: r.provider_ref || null,
    hostedUrl: r.hosted_url || null,
    lines: arr(r.lines),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class PgSaasStore implements SaasStore {
  describe() {
    return { kind: 'postgres', detail: 'Tables prefixed mp_, bootstrapped by ensureSaasSchema().' };
  }

  private async ready(): Promise<void> {
    await ensureSaasSchema();
  }

  // Organizations -----------------------------------------------------------

  async createOrganization(input: {
    name: string;
    slug: string;
    profile: Omit<OrgProfile, 'orgId' | 'createdAt' | 'updatedAt'>;
    createdByUserId: UUID | null;
  }): Promise<{ organization: Organization; profile: OrgProfile }> {
    await this.ready();
    // Delegated: ../orgs.ts owns organization creation, including the slug rules and the duplicate
    // message. Re-implementing the INSERT here would mean two places to fix when either changes.
    const created = await coreCreateOrg({ slug: input.slug, name: input.name });
    if (!created.ok || !created.org) {
      throw new Error(created.error || 'The organization could not be created.');
    }
    const org = created.org;
    const profile = await this.upsertProfile(org.id, input.profile);
    if (input.createdByUserId) {
      await this.addMember(org.id, input.createdByUserId, 'owner', null);
    }
    return { organization: org, profile };
  }

  async getOrganization(orgId: UUID): Promise<Organization | null> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_organizations WHERE id = ${orgId} AND deleted_at IS NULL LIMIT 1`);
    const row = rows(r)[0];
    return row ? toOrganization(row) : null;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_organizations WHERE slug = ${slug} AND deleted_at IS NULL LIMIT 1`);
    const row = rows(r)[0];
    return row ? toOrganization(row) : null;
  }

  async listOrganizations(limit = 100): Promise<Organization[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_organizations WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ${limit}`);
    return rows(r).map(toOrganization);
  }

  async listOrganizationsForUser(userId: UUID): Promise<Organization[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT o.* FROM mp_organizations o
      JOIN mp_organization_members m ON m.org_id = o.id
      WHERE m.user_id = ${userId} AND m.deleted_at IS NULL AND o.deleted_at IS NULL
      ORDER BY o.name ASC`);
    return rows(r).map(toOrganization);
  }

  async updateOrganization(
    orgId: UUID,
    patch: Partial<Pick<Organization, 'name' | 'status' | 'settings'>>,
  ): Promise<Organization | null> {
    await this.ready();
    const r = await db.execute(sql`
      UPDATE mp_organizations SET
        name = COALESCE(${patch.name ?? null}, name),
        status = COALESCE(${patch.status ?? null}, status),
        settings = COALESCE(${patch.settings ? JSON.stringify(patch.settings) : null}::jsonb, settings),
        updated_at = NOW()
      WHERE id = ${orgId} AND deleted_at IS NULL
      RETURNING *`);
    const row = rows(r)[0];
    return row ? toOrganization(row) : null;
  }

  async getProfile(orgId: UUID): Promise<OrgProfile | null> {
    await this.ready();
    const r = await db.execute(sql`SELECT * FROM mp_org_profiles WHERE org_id = ${orgId} LIMIT 1`);
    const row = rows(r)[0];
    if (!row) return null;
    return {
      orgId: row.org_id,
      orgType: row.org_type,
      billingEmail: row.billing_email || null,
      currency: row.currency || 'INR',
      timezone: row.timezone || 'UTC',
      taxId: row.tax_id || null,
      country: row.country || null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async upsertProfile(orgId: UUID, patch: Partial<Omit<OrgProfile, 'orgId' | 'createdAt'>>): Promise<OrgProfile> {
    await this.ready();
    await db.execute(sql`
      INSERT INTO mp_org_profiles (org_id, org_type, billing_email, currency, timezone, tax_id, country)
      VALUES (
        ${orgId}, ${patch.orgType || 'individual'}, ${patch.billingEmail ?? null},
        ${patch.currency || 'INR'}, ${patch.timezone || 'UTC'}, ${patch.taxId ?? null}, ${patch.country ?? null})
      ON CONFLICT (org_id) DO UPDATE SET
        org_type = COALESCE(${patch.orgType ?? null}, mp_org_profiles.org_type),
        billing_email = COALESCE(${patch.billingEmail ?? null}, mp_org_profiles.billing_email),
        currency = COALESCE(${patch.currency ?? null}, mp_org_profiles.currency),
        timezone = COALESCE(${patch.timezone ?? null}, mp_org_profiles.timezone),
        tax_id = COALESCE(${patch.taxId ?? null}, mp_org_profiles.tax_id),
        country = COALESCE(${patch.country ?? null}, mp_org_profiles.country),
        updated_at = NOW()`);
    const profile = await this.getProfile(orgId);
    if (!profile) throw new Error('Profile write for ' + orgId + ' reported success but read back nothing.');
    return profile;
  }

  // Members -----------------------------------------------------------------

  async listMembers(orgId: UUID): Promise<MembershipRow[]> {
    await this.ready();
    // LEFT JOIN so a membership whose user row is gone still lists — an orphaned member is exactly
    // what an operator needs to see, and an inner join would hide it.
    const r = await db.execute(sql`
      SELECT m.*, u.name AS user_name, u.email AS user_email
      FROM mp_organization_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId} AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC`);
    return rows(r).map(toMembership);
  }

  async getMembership(orgId: UUID, userId: UUID): Promise<MembershipRow | null> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_organization_members
      WHERE org_id = ${orgId} AND user_id = ${userId} AND deleted_at IS NULL LIMIT 1`);
    const row = rows(r)[0];
    return row ? toMembership(row) : null;
  }

  async listMembershipsForUser(userId: UUID): Promise<MembershipRow[]> {
    await this.ready();
    const r = await db.execute(sql`
      -- CROSS-TENANT BY DESIGN: this is the lookup that DISCOVERS which tenants a user belongs to,
      -- so it cannot be scoped to one of them. It returns membership rows only, never tenant data,
      -- and every caller uses the result to pick an org id that is then passed to scoped methods.
      -- The isolation test permits a statement carrying this marker and no others.
      SELECT * FROM mp_organization_members
      WHERE user_id = ${userId} AND deleted_at IS NULL ORDER BY created_at ASC`);
    return rows(r).map(toMembership);
  }

  async addMember(orgId: UUID, userId: UUID, teamRole: TeamRole, invitedBy: UUID | null): Promise<MembershipRow> {
    await this.ready();
    // Delegated for the row itself — ../orgs.ts already handles the restore-a-soft-deleted-member
    // case that this table's PARTIAL unique index makes fiddly. Then the team role is written
    // beside it. Both columns always move together: a row whose `team_role` disagrees with the
    // contract's `role` would answer one way to this layer and another to every subsystem that
    // predates it, which is the kind of split-brain nobody finds until an audit.
    const platform = platformRoleFor(teamRole);
    const added = await coreAddMember({ orgId, userId, role: platform, invitedBy: invitedBy || null });
    if (!added.ok) throw new Error(added.error || 'The member could not be added.');
    const r = await db.execute(sql`
      UPDATE mp_organization_members SET team_role = ${teamRole}, updated_at = NOW()
      WHERE org_id = ${orgId} AND user_id = ${userId} AND deleted_at IS NULL
      RETURNING *`);
    const row = rows(r)[0];
    if (!row) throw new Error('The member row for ' + userId + ' could not be read back after being added.');
    return toMembership(row);
  }

  async setMemberRole(orgId: UUID, userId: UUID, teamRole: TeamRole): Promise<MembershipRow | null> {
    await this.ready();
    const platform = platformRoleFor(teamRole);
    const r = await db.execute(sql`
      UPDATE mp_organization_members
      SET role = ${platform}, team_role = ${teamRole}, updated_at = NOW()
      WHERE org_id = ${orgId} AND user_id = ${userId} AND deleted_at IS NULL
      RETURNING *`);
    const row = rows(r)[0];
    return row ? toMembership(row) : null;
  }

  async removeMember(orgId: UUID, userId: UUID): Promise<boolean> {
    await this.ready();
    // Delegated. ../orgs.ts soft-deletes (a membership is referenced by audit rows, and hard
    // deleting it turns "who approved this campaign" into a dangling id) and refuses to remove the
    // last owner. This layer checks the same rule earlier, in ./roles.ts, with a sentence the
    // person who tried can read; the store-level refusal is the backstop under it.
    const removed = await coreRemoveMember(orgId, userId);
    if (!removed.ok) throw new Error(removed.error || 'The member could not be removed.');
    return removed.removed;
  }

  async countMembers(orgId: UUID): Promise<number> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM mp_organization_members
      WHERE org_id = ${orgId} AND deleted_at IS NULL`);
    return num(rows(r)[0]?.n);
  }

  async countOwners(orgId: UUID): Promise<number> {
    await this.ready();
    // COALESCE, because a row written before `team_role` existed carries only the contract's role.
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM mp_organization_members
      WHERE org_id = ${orgId} AND deleted_at IS NULL
        AND COALESCE(team_role, role) = 'owner'`);
    return num(rows(r)[0]?.n);
  }

  // Teams -------------------------------------------------------------------

  async listTeams(orgId: UUID): Promise<Team[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_teams WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY name ASC`);
    return rows(r).map((row: any) => ({
      id: row.id, orgId: row.org_id, name: row.name, slug: row.slug,
      description: row.description || null,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: isoOrNull(row.deleted_at),
    }));
  }

  async createTeam(orgId: UUID, input: { name: string; slug: string; description: string | null }): Promise<Team> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_teams (org_id, name, slug, description)
      VALUES (${orgId}, ${input.name}, ${input.slug}, ${input.description})
      RETURNING *`);
    const row = rows(r)[0];
    return {
      id: row.id, orgId: row.org_id, name: row.name, slug: row.slug,
      description: row.description || null,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: null,
    };
  }

  async countTeams(orgId: UUID): Promise<number> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM mp_teams WHERE org_id = ${orgId} AND deleted_at IS NULL`);
    return num(rows(r)[0]?.n);
  }

  async listTeamMembers(orgId: UUID, teamId: UUID): Promise<TeamMember[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_team_members WHERE org_id = ${orgId} AND team_id = ${teamId}
      ORDER BY created_at ASC`);
    return rows(r).map((row: any) => ({
      id: row.id, orgId: row.org_id, teamId: row.team_id, userId: row.user_id,
      teamRole: normalizeTeamRole(row.team_role), createdAt: iso(row.created_at),
    }));
  }

  async addTeamMember(orgId: UUID, teamId: UUID, userId: UUID, teamRole: TeamRole): Promise<TeamMember> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_team_members (org_id, team_id, user_id, team_role)
      VALUES (${orgId}, ${teamId}, ${userId}, ${teamRole})
      ON CONFLICT (team_id, user_id) DO UPDATE SET team_role = ${teamRole}
      RETURNING *`);
    const row = rows(r)[0];
    return {
      id: row.id, orgId: row.org_id, teamId: row.team_id, userId: row.user_id,
      teamRole: normalizeTeamRole(row.team_role), createdAt: iso(row.created_at),
    };
  }

  // Plans and subscription --------------------------------------------------

  async listCustomPlans(orgId: UUID): Promise<Plan[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_plans WHERE org_id = ${orgId} AND is_active = true ORDER BY sort_order ASC`);
    return rows(r).map(toPlan);
  }

  async upsertCustomPlan(orgId: UUID, plan: Plan): Promise<Plan> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_plans (org_id, key, name, tier, description, limits, features, overage, is_active, sort_order)
      VALUES (
        ${orgId}, ${plan.key}, ${plan.name}, ${plan.tier}, ${plan.description},
        ${JSON.stringify(plan.limits)}::jsonb, ${JSON.stringify(plan.features)}::jsonb,
        ${JSON.stringify(plan.overage)}::jsonb, ${plan.isActive}, ${plan.sortOrder})
      ON CONFLICT (org_id, key) DO UPDATE SET
        name = EXCLUDED.name, tier = EXCLUDED.tier, description = EXCLUDED.description,
        limits = EXCLUDED.limits, features = EXCLUDED.features, overage = EXCLUDED.overage,
        is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order, updated_at = NOW()
      RETURNING *`);
    return toPlan(rows(r)[0]);
  }

  async getSubscription(orgId: UUID): Promise<Subscription | null> {
    await this.ready();
    const r = await db.execute(sql`SELECT * FROM mp_subscriptions WHERE org_id = ${orgId} LIMIT 1`);
    const row = rows(r)[0];
    return row ? toSubscription(row) : null;
  }

  async createSubscription(
    orgId: UUID,
    input: Omit<Subscription, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>,
  ): Promise<Subscription> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_subscriptions (
        org_id, plan_key, status, period_start, period_end, trial_ends_at, provider, provider_ref)
      VALUES (
        ${orgId}, ${input.planKey}, ${input.status}, ${input.periodStart}, ${input.periodEnd},
        ${input.trialEndsAt}, ${input.provider}, ${input.providerRef})
      ON CONFLICT (org_id) DO UPDATE SET updated_at = NOW()
      RETURNING *`);
    return toSubscription(rows(r)[0]);
  }

  async saveSubscription(orgId: UUID, s: Subscription): Promise<Subscription> {
    await this.ready();
    const r = await db.execute(sql`
      UPDATE mp_subscriptions SET
        plan_key = ${s.planKey}, status = ${s.status},
        period_start = ${s.periodStart}, period_end = ${s.periodEnd},
        trial_ends_at = ${s.trialEndsAt}, cancel_at = ${s.cancelAt}, cancelled_at = ${s.cancelledAt},
        pending_plan_key = ${s.pendingPlanKey}, pending_plan_at = ${s.pendingPlanAt},
        custom_limits = ${s.customLimits ? JSON.stringify(s.customLimits) : null}::jsonb,
        custom_overage = ${s.customOverage ? JSON.stringify(s.customOverage) : null}::jsonb,
        last_billing_event_at = ${s.lastBillingEventAt},
        provider = ${s.provider}, provider_ref = ${s.providerRef},
        suspended_reason = ${s.suspendedReason}, suspended_at = ${s.suspendedAt},
        updated_at = NOW()
      WHERE org_id = ${orgId}
      RETURNING *`);
    const row = rows(r)[0];
    if (!row) throw new Error('No subscription for organization ' + orgId + ' to update.');
    return toSubscription(row);
  }

  async getEnterpriseTerms(orgId: UUID): Promise<EnterpriseTerms | null> {
    await this.ready();
    const r = await db.execute(sql`SELECT * FROM mp_enterprise_terms WHERE org_id = ${orgId} LIMIT 1`);
    const row = rows(r)[0];
    if (!row) return null;
    return {
      orgId: row.org_id,
      slaUptimePercent: row.sla_uptime_percent || null,
      slaSupportResponse: row.sla_support_response || null,
      dedicatedInfra: row.dedicated_infra === true,
      dedicatedIps: arr(row.dedicated_ips),
      customSmtpHost: row.custom_smtp_host || null,
      dataRetentionDays: row.data_retention_days === null ? null : num(row.data_retention_days),
      dataRegion: row.data_region || null,
      contractRef: row.contract_ref || null,
      contractEndsAt: isoOrNull(row.contract_ends_at),
      notes: row.notes || null,
    };
  }

  async upsertEnterpriseTerms(orgId: UUID, t: Omit<EnterpriseTerms, 'orgId'>): Promise<EnterpriseTerms> {
    await this.ready();
    await db.execute(sql`
      INSERT INTO mp_enterprise_terms (
        org_id, sla_uptime_percent, sla_support_response, dedicated_infra, dedicated_ips,
        custom_smtp_host, data_retention_days, data_region, contract_ref, contract_ends_at, notes)
      VALUES (
        ${orgId}, ${t.slaUptimePercent}, ${t.slaSupportResponse}, ${t.dedicatedInfra},
        ${JSON.stringify(t.dedicatedIps || [])}::jsonb, ${t.customSmtpHost}, ${t.dataRetentionDays},
        ${t.dataRegion}, ${t.contractRef}, ${t.contractEndsAt}, ${t.notes})
      ON CONFLICT (org_id) DO UPDATE SET
        sla_uptime_percent = EXCLUDED.sla_uptime_percent,
        sla_support_response = EXCLUDED.sla_support_response,
        dedicated_infra = EXCLUDED.dedicated_infra,
        dedicated_ips = EXCLUDED.dedicated_ips,
        custom_smtp_host = EXCLUDED.custom_smtp_host,
        data_retention_days = EXCLUDED.data_retention_days,
        data_region = EXCLUDED.data_region,
        contract_ref = EXCLUDED.contract_ref,
        contract_ends_at = EXCLUDED.contract_ends_at,
        notes = EXCLUDED.notes,
        updated_at = NOW()`);
    const saved = await this.getEnterpriseTerms(orgId);
    if (!saved) throw new Error('Enterprise terms write for ' + orgId + ' read back nothing.');
    return saved;
  }

  // Usage -------------------------------------------------------------------

  async recordUsage(orgId: UUID, event: Omit<UsageEvent, 'id'>): Promise<RecordResult> {
    await this.ready();
    // ON CONFLICT DO NOTHING against the partial unique index. The DUPLICATE IS DECIDED BY THE
    // DATABASE, not by a read-then-write in application code — two workers processing the same
    // queue message concurrently both pass a read-then-write check and both insert.
    const r = await db.execute(sql`
      INSERT INTO mp_usage_events (org_id, metric, quantity, mode, source, idempotency_key, meta, occurred_at)
      VALUES (
        ${orgId}, ${event.metric}, ${event.quantity}, ${event.mode || 'delta'},
        ${event.source}, ${event.idempotencyKey}, ${JSON.stringify(event.meta || {})}::jsonb,
        ${event.occurredAt})
      ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id`);
    const inserted = rows(r)[0];
    if (!inserted) return { recorded: false, duplicate: true, id: null };
    return { recorded: true, duplicate: false, id: String(inserted.id) };
  }

  async listUsageEvents(orgId: UUID, q: UsageEventQuery = {}): Promise<UsageEvent[]> {
    await this.ready();
    const metric = q.metric || null;
    const start = q.period ? q.period.start : null;
    const end = q.period ? q.period.end : null;
    const limit = q.limit && q.limit > 0 ? q.limit : 5000;
    const r = await db.execute(sql`
      SELECT * FROM mp_usage_events
      WHERE org_id = ${orgId}
        AND (${metric}::text IS NULL OR metric = ${metric})
        AND (${start}::timestamptz IS NULL OR occurred_at >= ${start})
        AND (${end}::timestamptz IS NULL OR occurred_at < ${end})
      ORDER BY occurred_at ASC
      LIMIT ${limit}`);
    return rows(r).map((row: any) => ({
      id: String(row.id),
      orgId: row.org_id,
      metric: row.metric as MetricKey,
      quantity: num(row.quantity),
      mode: row.mode === 'set' ? 'set' : 'delta',
      source: row.source,
      idempotencyKey: row.idempotency_key || null,
      meta: obj(row.meta),
      occurredAt: iso(row.occurred_at),
    }));
  }

  async getCounters(orgId: UUID, periodStart: string): Promise<UsageCounter[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_usage_counters WHERE org_id = ${orgId} AND period_start = ${periodStart}`);
    return rows(r).map((row: any) => ({
      orgId: row.org_id,
      metric: row.metric as MetricKey,
      periodStart: iso(row.period_start),
      value: num(row.value),
      peak: num(row.peak),
      updatedAt: iso(row.updated_at),
    }));
  }

  async saveCounters(orgId: UUID, counters: UsageCounter[]): Promise<void> {
    await this.ready();
    for (const c of counters) {
      await db.execute(sql`
        INSERT INTO mp_usage_counters (org_id, metric, period_start, value, peak, updated_at)
        VALUES (${orgId}, ${c.metric}, ${c.periodStart}, ${c.value}, ${c.peak}, NOW())
        ON CONFLICT (org_id, metric, period_start) DO UPDATE SET
          value = EXCLUDED.value,
          peak = GREATEST(mp_usage_counters.peak, EXCLUDED.peak),
          updated_at = NOW()`);
    }
  }

  async recordQuotaNotice(orgId: UUID, notice: Omit<QuotaNotice, 'id'>): Promise<RecordResult> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_quota_notices (org_id, metric, period_start, threshold, state)
      VALUES (${orgId}, ${notice.metric}, ${notice.periodStart}, ${notice.threshold}, ${notice.state})
      ON CONFLICT (org_id, metric, period_start, threshold) DO NOTHING
      RETURNING id`);
    const row = rows(r)[0];
    if (!row) return { recorded: false, duplicate: true, id: null };
    return { recorded: true, duplicate: false, id: row.id };
  }

  async listQuotaNotices(orgId: UUID, periodStart: string): Promise<QuotaNotice[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_quota_notices WHERE org_id = ${orgId} AND period_start = ${periodStart}
      ORDER BY notified_at DESC`);
    return rows(r).map((row: any) => ({
      id: row.id,
      orgId: row.org_id,
      metric: row.metric as MetricKey,
      periodStart: iso(row.period_start),
      threshold: num(row.threshold),
      state: row.state,
      notifiedAt: iso(row.notified_at),
    }));
  }

  // Billing -----------------------------------------------------------------

  async recordBillingEvent(
    event: Omit<BillingEvent, 'id' | 'receivedAt' | 'processedAt' | 'error'>,
  ): Promise<RecordResult & { event: BillingEvent | null }> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_billing_events (org_id, provider, event_id, type, payload, occurred_at)
      VALUES (
        ${event.orgId}, ${event.provider}, ${event.eventId}, ${event.type},
        ${JSON.stringify(event.payload || {})}::jsonb, ${event.occurredAt})
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING *`);
    const row = rows(r)[0];
    if (!row) {
      // Already seen. Read the original back so the caller can see what was decided the first time
      // rather than being told only that it is a duplicate.
      const prev = await db.execute(sql`
        SELECT * FROM mp_billing_events WHERE provider = ${event.provider} AND event_id = ${event.eventId} LIMIT 1`);
      const p = rows(prev)[0];
      return {
        recorded: false,
        duplicate: true,
        id: p ? p.id : null,
        event: p ? toBillingEvent(p) : null,
      };
    }
    return { recorded: true, duplicate: false, id: row.id, event: toBillingEvent(row) };
  }

  async markBillingEventProcessed(eventId: UUID, error: string | null): Promise<void> {
    await this.ready();
    await db.execute(sql`
      UPDATE mp_billing_events SET processed_at = NOW(), error = ${error} WHERE id = ${eventId}`);
  }

  async listBillingEvents(orgId: UUID, limit = 50): Promise<BillingEvent[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_billing_events WHERE org_id = ${orgId}
      ORDER BY occurred_at DESC LIMIT ${limit}`);
    return rows(r).map(toBillingEvent);
  }

  async listInvoices(orgId: UUID, limit = 50): Promise<Invoice[]> {
    await this.ready();
    const r = await db.execute(sql`
      SELECT * FROM mp_invoices WHERE org_id = ${orgId}
      ORDER BY COALESCE(issued_at, created_at) DESC LIMIT ${limit}`);
    return rows(r).map(toInvoice);
  }

  async upsertInvoice(orgId: UUID, inv: Invoice): Promise<Invoice> {
    await this.ready();
    const r = await db.execute(sql`
      INSERT INTO mp_invoices (
        org_id, number, status, currency, subtotal_minor, tax_minor, total_minor, amount_paid_minor,
        period_start, period_end, issued_at, due_at, paid_at, provider, provider_ref, hosted_url, lines)
      VALUES (
        ${orgId}, ${inv.number}, ${inv.status}, ${inv.currency}, ${inv.subtotalMinor}, ${inv.taxMinor},
        ${inv.totalMinor}, ${inv.amountPaidMinor}, ${inv.periodStart}, ${inv.periodEnd}, ${inv.issuedAt},
        ${inv.dueAt}, ${inv.paidAt}, ${inv.provider}, ${inv.providerRef}, ${inv.hostedUrl},
        ${JSON.stringify(inv.lines || [])}::jsonb)
      ON CONFLICT (org_id, number) DO UPDATE SET
        status = EXCLUDED.status, currency = EXCLUDED.currency,
        subtotal_minor = EXCLUDED.subtotal_minor, tax_minor = EXCLUDED.tax_minor,
        total_minor = EXCLUDED.total_minor, amount_paid_minor = EXCLUDED.amount_paid_minor,
        period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
        issued_at = EXCLUDED.issued_at, due_at = EXCLUDED.due_at, paid_at = EXCLUDED.paid_at,
        provider = EXCLUDED.provider, provider_ref = EXCLUDED.provider_ref,
        hosted_url = EXCLUDED.hosted_url, lines = EXCLUDED.lines, updated_at = NOW()
      RETURNING *`);
    return toInvoice(rows(r)[0]);
  }
}

function toBillingEvent(r: any): BillingEvent {
  return {
    id: r.id,
    orgId: r.org_id || null,
    provider: r.provider,
    eventId: r.event_id,
    type: r.type as BillingEventType,
    payload: obj(r.payload),
    occurredAt: iso(r.occurred_at),
    receivedAt: iso(r.received_at),
    processedAt: isoOrNull(r.processed_at),
    error: r.error || null,
  };
}

/** The reason string helper, exported so callers log the cause rather than the failed SQL. */
export { reason as dbReason };
