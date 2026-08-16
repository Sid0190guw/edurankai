// src/lib/mailgov/users.ts — USER AND MEMBERSHIP ADMINISTRATION.
//
// WHAT "CREATE A USER" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT. This platform does not mint
// sign-in accounts. EduRankAI has a self-built multi-method authentication stack — password, passkey,
// face, TOTP (src/lib/auth/*) — and a mail platform that created its own accounts would be a second
// identity system with a second password policy, a second recovery path and a second thing to get
// wrong. So creating a user here means CREATING A MEMBERSHIP for an account that already exists, and
// an address with no account is refused with an explanation rather than quietly conjured into one.
//
// EVERY ACTION IS SCOPED TO A MEMBERSHIP, not to the person's EduRankAI account. Suspending somebody
// on the mail platform must not disable their company login, and this file has no path that could.
// The one action that reaches beyond the platform is revokeSessions(), which deletes rows from the
// shared `sessions` table and therefore signs the person out of everything — that is stated on the
// screen that offers it, because an administrator pressing it should know it is not a mail-only act.
//
// THE ESCALATION RULES ARE NOT ENFORCED IN THIS FILE. They live in ./policy.ts and are applied by the
// route through authorizeGov() before any of these functions are called, with the target's current
// and proposed roles supplied. Two places deciding the same thing is how they come to disagree; this
// file does the work and trusts the door, which is the only arrangement where the door is worth
// having.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureGovernanceSchema, rows, dbReason } from './schema';
import { ORG_MEMBER_ROLES, govRoleForMembership, type GovRole, type MemberStatus, type OrgMemberRole } from './policy';

export interface MemberRow {
  id: string;
  orgId: string;
  orgName: string | null;
  userId: string;
  email: string | null;
  name: string | null;
  accountRole: string | null;
  accountActive: boolean | null;
  role: OrgMemberRole;
  /** What that membership role means in the governance console. */
  govRole: GovRole;
  status: MemberStatus;
  suspendedReason: string | null;
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  activeSessions: number | null;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): MemberRow {
  const role = String(r.role || 'member') as OrgMemberRole;
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    orgName: r.org_name ?? null,
    userId: String(r.user_id),
    email: r.email ?? null,
    name: r.name ?? null,
    accountRole: r.account_role ?? null,
    accountActive: r.account_active === null || r.account_active === undefined ? null : !!r.account_active,
    role,
    govRole: govRoleForMembership(role),
    status: String(r.status || 'active') as MemberStatus,
    suspendedReason: r.suspended_reason ?? null,
    invitedBy: r.invited_by ? String(r.invited_by) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    removedAt: r.removed_at ? new Date(r.removed_at).toISOString() : null,
    activeSessions: r.active_sessions === null || r.active_sessions === undefined ? null : Number(r.active_sessions),
  };
}

export interface MemberQuery {
  orgId?: string | null;
  userId?: string | null;
  status?: MemberStatus | null;
  q?: string | null;
  includeRemoved?: boolean;
  limit?: number;
}

/**
 * List memberships, joined to the account so the screen can show a name rather than a UUID.
 *
 * LEFT JOIN, never INNER. A membership whose account row is missing is exactly the kind of orphan an
 * administrator needs to see; an inner join would hide it and the screen would show a member count
 * that does not match the list underneath it.
 */
export async function listMembers(q: MemberQuery): Promise<ReadResult<MemberRow>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const like = q.q ? '%' + String(q.q).toLowerCase().split('%').join('\\%') + '%' : null;
    const r = await db.execute(sql`
      SELECT m.*, o.name AS org_name, u.email, u.name, u.role AS account_role, u.is_active AS account_active,
             (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = m.user_id AND s.expires_at > now()) AS active_sessions
        FROM mailapi_org_members m
        LEFT JOIN mailapi_orgs o ON o.id = m.org_id
        LEFT JOIN users u ON u.id = m.user_id
       WHERE ${q.orgId ? sql`m.org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.userId ? sql`m.user_id = ${q.userId}::uuid` : sql`TRUE`}
         AND ${q.status ? sql`m.status = ${q.status}` : sql`TRUE`}
         AND ${q.includeRemoved ? sql`TRUE` : sql`m.removed_at IS NULL`}
         AND ${like ? sql`(LOWER(u.email) LIKE ${like} OR LOWER(u.name) LIKE ${like})` : sql`TRUE`}
       ORDER BY m.created_at DESC
       LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export async function getMember(orgId: string, userId: string): Promise<{ ok: boolean; member?: MemberRow; reason?: string }> {
  const r = await listMembers({ orgId, userId, includeRemoved: true, limit: 1 });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (!r.rows.length) return { ok: false, reason: 'No such membership.' };
  return { ok: true, member: r.rows[0] };
}

/**
 * Add somebody to an organization.
 *
 * Refuses an address with no EduRankAI account, and says what to do instead. It also refuses to
 * re-add somebody who is already a member — reviving a removed membership is `restoreMember`, which
 * keeps the original row and its history rather than creating a second one that looks like a new
 * person who happens to share an email address.
 */
export async function createMember(input: {
  orgId: string;
  email: string;
  role: OrgMemberRole;
  invitedBy: string;
}): Promise<{ ok: boolean; memberId?: string; userId?: string; error?: string }> {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Give the address of the person to add.' };
  if (!(ORG_MEMBER_ROLES as readonly string[]).includes(input.role)) {
    return { ok: false, error: 'Unknown membership role: ' + input.role + '.' };
  }
  try {
    await ensureGovernanceSchema();
    const u = rows(await db.execute(sql`SELECT id, is_active FROM users WHERE LOWER(email) = ${email} LIMIT 1`))[0];
    if (!u?.id) {
      return {
        ok: false,
        error: 'No EduRankAI account exists for ' + email + '. This platform does not create sign-in accounts — the person signs up or is created in the main console first, and is then added here.',
      };
    }
    if (u.is_active === false) {
      return { ok: false, error: 'That account is deactivated. Reactivate it in the main console before adding it to an organization.' };
    }

    const existing = rows(await db.execute(sql`
      SELECT id, status, removed_at FROM mailapi_org_members
       WHERE org_id = ${input.orgId}::uuid AND user_id = ${u.id}::uuid
       ORDER BY created_at DESC LIMIT 1`))[0];
    if (existing && !existing.removed_at) {
      return { ok: false, error: 'They are already a member of this organization (' + String(existing.status) + ').' };
    }
    if (existing?.removed_at) {
      const revived = rows(await db.execute(sql`
        UPDATE mailapi_org_members
           SET status = 'active', role = ${input.role}, removed_at = NULL, suspended_reason = NULL, updated_at = now()
         WHERE id = ${existing.id}::uuid RETURNING id`))[0];
      return { ok: true, memberId: String(revived?.id), userId: String(u.id) };
    }

    const created = rows(await db.execute(sql`
      INSERT INTO mailapi_org_members (org_id, user_id, role, status, invited_by)
      VALUES (${input.orgId}::uuid, ${u.id}::uuid, ${input.role}, 'active', ${input.invitedBy}::uuid)
      RETURNING id`))[0];
    return { ok: true, memberId: String(created?.id), userId: String(u.id) };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Suspend, disable or restore a membership.
 *
 * Suspended and disabled both mean "cannot use this organization"; the difference is intent, and the
 * reason column is what carries it. Both are reversible with `active`, which is why neither of them
 * deletes anything. Access stops at the next request, because guard.ts calls membershipIsActive() on
 * every resolve rather than trusting a session issued earlier.
 */
export async function setMemberStatus(input: {
  orgId: string;
  userId: string;
  status: MemberStatus;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (input.status === 'removed') {
    return { ok: false, error: 'Use removeMembership to remove somebody, so the removal is recorded as one.' };
  }
  const reason = String(input.reason || '').trim();
  if ((input.status === 'suspended' || input.status === 'disabled') && reason.length < 5) {
    return { ok: false, error: 'Say why. The person will ask, and the answer should not have to be reconstructed.' };
  }
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_org_members
         SET status = ${input.status},
             suspended_reason = ${input.status === 'active' ? null : reason.slice(0, 1000)},
             updated_at = now()
       WHERE org_id = ${input.orgId}::uuid AND user_id = ${input.userId}::uuid AND removed_at IS NULL
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'No active membership for that person in this organization.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/** Change a membership role. The escalation check happens at the door — see the note at the top. */
export async function changeMemberRole(input: {
  orgId: string;
  userId: string;
  role: OrgMemberRole;
}): Promise<{ ok: boolean; error?: string; previous?: string }> {
  if (!(ORG_MEMBER_ROLES as readonly string[]).includes(input.role)) {
    return { ok: false, error: 'Unknown membership role: ' + input.role + '.' };
  }
  try {
    await ensureGovernanceSchema();
    const before = rows(await db.execute(sql`
      SELECT role FROM mailapi_org_members
       WHERE org_id = ${input.orgId}::uuid AND user_id = ${input.userId}::uuid AND removed_at IS NULL LIMIT 1`))[0];
    if (!before) return { ok: false, error: 'No active membership for that person in this organization.' };

    // The last owner may not be demoted. An organization with no owner has nobody who can appoint
    // one, which is a support ticket that requires a platform administrator to unpick — so it is
    // refused here rather than discovered later.
    if (String(before.role) === 'owner' && input.role !== 'owner') {
      const owners = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM mailapi_org_members
         WHERE org_id = ${input.orgId}::uuid AND role = 'owner' AND status = 'active' AND removed_at IS NULL`))[0];
      if ((Number(owners?.n) || 0) <= 1) {
        return { ok: false, error: 'This is the organization’s only owner. Appoint another owner first, or the organization is left with nobody who can.' };
      }
    }

    await db.execute(sql`
      UPDATE mailapi_org_members SET role = ${input.role}, updated_at = now()
       WHERE org_id = ${input.orgId}::uuid AND user_id = ${input.userId}::uuid AND removed_at IS NULL`);
    return { ok: true, previous: String(before.role) };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Remove somebody from an organization.
 *
 * A soft removal: `removed_at` is stamped and the row stays. The history of who was a member, in what
 * role, and when they stopped, is part of the audit picture — a hard delete would leave audit events
 * pointing at a membership nobody can look up.
 */
export async function removeMembership(input: {
  orgId: string;
  userId: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const owners = rows(await db.execute(sql`
      SELECT role, (SELECT COUNT(*)::int FROM mailapi_org_members
                     WHERE org_id = ${input.orgId}::uuid AND role = 'owner' AND status = 'active' AND removed_at IS NULL) AS owner_count
        FROM mailapi_org_members
       WHERE org_id = ${input.orgId}::uuid AND user_id = ${input.userId}::uuid AND removed_at IS NULL LIMIT 1`))[0];
    if (!owners) return { ok: false, error: 'No active membership for that person in this organization.' };
    if (String(owners.role) === 'owner' && (Number(owners.owner_count) || 0) <= 1) {
      return { ok: false, error: 'This is the organization’s only owner. Appoint another owner before removing them.' };
    }

    await db.execute(sql`
      UPDATE mailapi_org_members
         SET removed_at = now(), status = 'removed',
             suspended_reason = ${String(input.reason || '').slice(0, 1000) || null}, updated_at = now()
       WHERE org_id = ${input.orgId}::uuid AND user_id = ${input.userId}::uuid AND removed_at IS NULL`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Sign somebody out everywhere.
 *
 * THIS IS ACCOUNT-WIDE, NOT MAIL-ONLY. `sessions` is the one session store this repository has, so
 * revoking here signs the person out of EduRankAI entirely. That is the correct response to a
 * suspected compromise and the wrong response to a routine membership change, and the console says
 * so at the point of use rather than in a document.
 *
 * Returns the count so the screen can say "4 sessions ended" rather than "done" — the number is how
 * an administrator learns whether the account was in use somewhere they did not expect.
 */
export async function revokeSessions(userId: string): Promise<{ ok: boolean; revoked: number; error?: string }> {
  try {
    const before = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = ${userId}::uuid AND expires_at > now()`))[0];
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}::uuid`);
    return { ok: true, revoked: Number(before?.n) || 0 };
  } catch (e: any) {
    return { ok: false, revoked: 0, error: dbReason(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Platform grants — appointing the people who administer the platform itself.
// ---------------------------------------------------------------------------------------------

export interface PlatformGrantRow {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  role: GovRole;
  grantedBy: string | null;
  reason: string | null;
  grantedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export async function listPlatformGrants(includeRevoked = false): Promise<ReadResult<PlatformGrantRow>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT g.*, u.email, u.name FROM mailapi_platform_admins g
        LEFT JOIN users u ON u.id = g.user_id
       WHERE ${includeRevoked ? sql`TRUE` : sql`g.revoked_at IS NULL`}
       ORDER BY g.granted_at DESC LIMIT 200`);
    return {
      ok: true,
      rows: rows(r).map((x: any) => ({
        id: String(x.id),
        userId: String(x.user_id),
        email: x.email ?? null,
        name: x.name ?? null,
        role: String(x.role) as GovRole,
        grantedBy: x.granted_by ? String(x.granted_by) : null,
        reason: x.reason ?? null,
        grantedAt: new Date(x.granted_at).toISOString(),
        revokedAt: x.revoked_at ? new Date(x.revoked_at).toISOString() : null,
        revokedReason: x.revoked_reason ?? null,
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

/**
 * Appoint a platform administrator, support engineer or auditor.
 *
 * `platform_owner` is NOT grantable here and never will be: the owner arm in guard.ts is the founder
 * address, which is a deployment fact rather than a database row. A grant table that can mint owners
 * is a grant table where one compromised administrator becomes every administrator.
 */
export async function grantPlatformRole(input: {
  userEmail: string;
  role: GovRole;
  grantedBy: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string; userId?: string }> {
  const allowed: GovRole[] = ['platform_admin', 'support', 'auditor'];
  if (!allowed.includes(input.role)) {
    return { ok: false, error: 'Only platform_admin, support and auditor can be granted here. Platform ownership is a deployment setting, not a row.' };
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < 10) return { ok: false, error: 'Say why this person is being appointed, in at least ten characters.' };

  const email = String(input.userEmail || '').trim().toLowerCase();
  try {
    await ensureGovernanceSchema();
    const u = rows(await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`))[0];
    if (!u?.id) return { ok: false, error: 'No EduRankAI account exists for ' + email + '.' };

    await db.execute(sql`
      UPDATE mailapi_platform_admins SET revoked_at = now(), revoked_reason = 'replaced by a new grant'
       WHERE user_id = ${u.id}::uuid AND revoked_at IS NULL`);
    await db.execute(sql`
      INSERT INTO mailapi_platform_admins (user_id, role, granted_by, reason)
      VALUES (${u.id}::uuid, ${input.role}, ${input.grantedBy}::uuid, ${reason.slice(0, 2000)})`);
    return { ok: true, userId: String(u.id) };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function revokePlatformRole(input: {
  grantId: string;
  byUserId: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_platform_admins
         SET revoked_at = now(), revoked_by = ${input.byUserId}::uuid,
             revoked_reason = ${String(input.reason || '').slice(0, 2000) || null}
       WHERE id = ${input.grantId}::uuid AND revoked_at IS NULL
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'That grant does not exist, or it was already revoked.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}
