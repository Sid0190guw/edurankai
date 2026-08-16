// src/lib/mailplatform/orgs.ts — organizations, membership, and the default tenant.
//
// TENANCY FROM DAY ONE, EVEN THOUGH THERE IS ONE TENANT TODAY. Every row in this subsystem carries
// an org_id. Retrofitting that column onto twenty tables holding millions of rows, and then finding
// every query that forgot to filter on it, is one of the most expensive migrations there is — and
// the brief names multi-tenant SaaS as an explicit destination. Adding the column now costs a few
// bytes a row; adding it later costs a weekend and a data-leak review.
//
// EduRankAI itself is org `edurankai`, created on first use. Existing single-tenant behaviour is
// unchanged: callers that pass no org get that one.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailPlatformSchema } from './schema';
import { mailRoleForInternalUser } from './permissions';
import type { Organization, OrganizationMember, OrgMemberRole, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** The slug of the organization that IS EduRankAI. Never a user-supplied value. */
export const DEFAULT_ORG_SLUG = 'edurankai';
export const DEFAULT_ORG_NAME = 'EduRankAI';

function toOrg(row: any): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    settings: row.settings || {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
  };
}

function iso(v: any): string {
  return v instanceof Date ? v.toISOString() : String(v ?? '');
}

// The resolved id is cached per process: it is looked up on nearly every request and it never
// changes for the lifetime of a deployment. A failed lookup is NOT cached — see the note in
// schema.ts about memoising a failure as a success.
let defaultOrgIdCache: string | null = null;

/**
 * The default organization, created if it does not exist.
 *
 * Returns null rather than throwing when the database is unreachable, so a caller can render a
 * refusal that names the real problem instead of a stack trace.
 */
export async function ensureDefaultOrg(): Promise<Organization | null> {
  const schema = await ensureMailPlatformSchema();
  if (!schema.ok) {
    console.error('[mailplatform/orgs] schema not applied:', schema.error);
    return null;
  }
  try {
    const existing = rows(await db.execute(sql`
      SELECT * FROM mp_organizations WHERE lower(slug) = ${DEFAULT_ORG_SLUG} AND deleted_at IS NULL LIMIT 1`));
    if (existing.length) {
      defaultOrgIdCache = existing[0].id;
      return toOrg(existing[0]);
    }
    const created = rows(await db.execute(sql`
      INSERT INTO mp_organizations (slug, name, status)
      VALUES (${DEFAULT_ORG_SLUG}, ${DEFAULT_ORG_NAME}, 'active')
      ON CONFLICT DO NOTHING
      RETURNING *`));
    if (created.length) {
      defaultOrgIdCache = created[0].id;
      return toOrg(created[0]);
    }
    // A concurrent request won the insert. Read it back rather than reporting failure.
    const raced = rows(await db.execute(sql`
      SELECT * FROM mp_organizations WHERE lower(slug) = ${DEFAULT_ORG_SLUG} AND deleted_at IS NULL LIMIT 1`));
    if (raced.length) {
      defaultOrgIdCache = raced[0].id;
      return toOrg(raced[0]);
    }
    return null;
  } catch (e: any) {
    console.error('[mailplatform/orgs] ensureDefaultOrg failed -', causeOf(e));
    return null;
  }
}

/** The default org's id, cached. Null when the database could not answer. */
export async function defaultOrgId(): Promise<UUID | null> {
  if (defaultOrgIdCache) return defaultOrgIdCache;
  const org = await ensureDefaultOrg();
  return org?.id ?? null;
}

export async function getOrg(idOrSlug: string): Promise<Organization | null> {
  if (!idOrSlug) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug.trim());
    const r = rows(await db.execute(
      isUuid
        ? sql`SELECT * FROM mp_organizations WHERE id = ${idOrSlug.trim()} AND deleted_at IS NULL LIMIT 1`
        : sql`SELECT * FROM mp_organizations WHERE lower(slug) = ${idOrSlug.trim().toLowerCase()} AND deleted_at IS NULL LIMIT 1`,
    ));
    return r.length ? toOrg(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/orgs] getOrg failed -', causeOf(e));
    return null;
  }
}

export async function listOrgs(limit = 100): Promise<Organization[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_organizations WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT ${Math.min(limit, 500)}`));
    return r.map(toOrg);
  } catch (e: any) {
    console.error('[mailplatform/orgs] listOrgs failed -', causeOf(e));
    return [];
  }
}

export async function createOrg(input: {
  slug: string;
  name: string;
  settings?: Record<string, unknown>;
}): Promise<{ ok: boolean; org?: Organization; error?: string }> {
  const slug = String(input.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug)) {
    return { ok: false, error: 'Slug must be 3-80 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen.' };
  }
  if (!String(input.name || '').trim()) return { ok: false, error: 'Name is required.' };
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_organizations (slug, name, settings)
      VALUES (${slug}, ${String(input.name).trim().slice(0, 200)}, ${JSON.stringify(input.settings || {})}::jsonb)
      RETURNING *`));
    return { ok: true, org: toOrg(r[0]) };
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key|unique/i.test(reason)) return { ok: false, error: `An organization with the slug "${slug}" already exists.` };
    return { ok: false, error: reason };
  }
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

function toMember(row: any): OrganizationMember {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role,
    invitedBy: row.invited_by ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
  };
}

/** The membership row, or null. Does NOT fall back to an internal role — see resolveOrgRole(). */
export async function getMembership(orgId: UUID, userId: UUID): Promise<OrganizationMember | null> {
  if (!orgId || !userId) return null;
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_organization_members
      WHERE org_id = ${orgId} AND user_id = ${userId} AND deleted_at IS NULL LIMIT 1`));
    return r.length ? toMember(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/orgs] getMembership failed -', causeOf(e));
    return null;
  }
}

/**
 * The role this user holds in this organization.
 *
 * Order matters and is deliberate:
 *   1. An explicit membership row always wins. If someone has been made an `analyst` of this
 *      tenant, an internal job title must not silently upgrade them.
 *   2. Only for the DEFAULT organization, and only when there is no membership row at all, an
 *      internal EduRankAI role is mapped through (admin -> admin, and so on). That is what lets the
 *      existing admin console keep working on day one without an invite step.
 *   3. Otherwise: no role. A user with no membership in another tenant is not a member of it, no
 *      matter what they are internally. This is the line that stops the mail platform from becoming
 *      a way for an EduRankAI employee to read a customer's mailbox.
 */
export async function resolveOrgRole(
  orgId: UUID,
  user: { id: string; role?: string | null; isActive?: boolean } | null | undefined,
): Promise<OrgMemberRole | null> {
  if (!user?.id || !orgId) return null;
  const membership = await getMembership(orgId, user.id);
  if (membership) return membership.role;
  const fallbackOrg = await defaultOrgId();
  if (fallbackOrg && fallbackOrg === orgId) return mailRoleForInternalUser(user);
  return null;
}

export async function addMember(input: {
  orgId: UUID;
  userId: UUID;
  role: OrgMemberRole;
  invitedBy?: UUID | null;
}): Promise<{ ok: boolean; member?: OrganizationMember; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_organization_members (org_id, user_id, role, invited_by)
      VALUES (${input.orgId}, ${input.userId}, ${input.role}, ${input.invitedBy || null})
      ON CONFLICT DO NOTHING
      RETURNING *`));
    if (r.length) return { ok: true, member: toMember(r[0]) };
    // Already a member (possibly soft-deleted): restore rather than refuse, and set the new role.
    const restored = rows(await db.execute(sql`
      UPDATE mp_organization_members
      SET role = ${input.role}, deleted_at = NULL
      WHERE org_id = ${input.orgId} AND user_id = ${input.userId}
      RETURNING *`));
    return restored.length
      ? { ok: true, member: toMember(restored[0]) }
      : { ok: false, error: 'Could not add the member and could not find an existing row to restore.' };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/**
 * Remove a member. Answers whether THIS call removed them.
 *
 * `deleted_at IS NULL` is in the WHERE for a reason: without it, removing an already-removed member
 * returns "done" and an admin screen reports success for an action that changed nothing. That exact
 * pattern is written up in src/lib/api-keys.ts on this repository's key-revocation path.
 */
export async function removeMember(orgId: UUID, userId: UUID): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  try {
    // The last owner cannot be removed. An organization with no owner has no one who can add one,
    // which requires a database fix to undo.
    const owners = rows(await db.execute(sql`
      SELECT user_id FROM mp_organization_members
      WHERE org_id = ${orgId} AND role = 'owner' AND deleted_at IS NULL`));
    if (owners.length === 1 && owners[0].user_id === userId) {
      return { ok: false, removed: false, error: 'This is the last owner of the organization. Make someone else an owner first.' };
    }
    const r = rows(await db.execute(sql`
      UPDATE mp_organization_members SET deleted_at = NOW()
      WHERE org_id = ${orgId} AND user_id = ${userId} AND deleted_at IS NULL
      RETURNING id`));
    return { ok: true, removed: r.length > 0 };
  } catch (e: any) {
    return { ok: false, removed: false, error: causeOf(e) };
  }
}

export async function listMembers(orgId: UUID, limit = 200): Promise<(OrganizationMember & { email?: string; name?: string })[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT m.*, u.email, u.name AS name
      FROM mp_organization_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId} AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT ${Math.min(limit, 1000)}`));
    return r.map((row) => ({ ...toMember(row), email: row.email, name: row.name }));
  } catch (e: any) {
    console.error('[mailplatform/orgs] listMembers failed -', causeOf(e));
    return [];
  }
}
