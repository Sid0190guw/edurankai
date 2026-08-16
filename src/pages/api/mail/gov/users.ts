// GET  /api/mail/gov/users     ?org=<id> memberships; ?grants=1 platform appointments
// POST /api/mail/gov/users     { action, ... }
//
// User and membership administration.
//
// THE ESCALATION CHECK IS THE INTERESTING PART OF THIS FILE. Every action that touches somebody else
// passes their CURRENT governance role and, for a role change, the PROPOSED one into
// authorizeGov() — which refuses a grant at or above the actor's own rank, refuses acting on a peer
// or superior, and refuses self-targeting. Those three refusals are what stop "an administrator can
// change roles" from meaning "an administrator can make themselves an owner", and they are decided in
// src/lib/mailgov/policy.ts rather than here, because a rule enforced at each call site is a rule
// that will be missing from one of them.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { govRoleForMembership, type GovCapability, type GovRole, type OrgMemberRole } from '@/lib/mailgov/policy';
import {
  changeMemberRole, createMember, getMember, grantPlatformRole, listMembers, listPlatformGrants,
  removeMembership, revokePlatformRole, revokeSessions, setMemberStatus,
} from '@/lib/mailgov/users';
import { recordSecurityEvent } from '@/lib/mailgov/security-events';

export const GET: APIRoute = async ({ locals, request, url }) => {
  if (url.searchParams.get('grants') === '1') {
    const g = await requireGov(locals, 'platform.grant', { platformWide: true }, request);
    if (g.denied) return g.denied;
    const grants = await listPlatformGrants(url.searchParams.get('all') === '1');
    return grants.ok ? govJson({ ok: true, grants: grants.rows }) : govJson({ ok: false, error: grants.reason }, 500);
  }

  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'user.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const list = await listMembers({
    orgId: orgParam(url, g.actor.orgId),
    userId: url.searchParams.get('user'),
    q: url.searchParams.get('q'),
    includeRemoved: url.searchParams.get('removed') === '1',
  });
  return list.ok ? govJson({ ok: true, members: list.rows }) : govJson({ ok: false, error: list.reason }, 500);
};

const ACTION_CAPABILITY: Record<string, GovCapability> = {
  create: 'user.create',
  suspend: 'user.suspend',
  disable: 'user.disable',
  restore: 'user.restore',
  change_role: 'user.role.change',
  remove: 'user.membership.remove',
  revoke_sessions: 'user.sessions.revoke',
  grant_platform_role: 'platform.grant',
  revoke_platform_role: 'platform.grant',
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const action = String(body.action || '');
  const capability = ACTION_CAPABILITY[action];
  if (!capability) {
    return govJson({ ok: false, error: 'Unknown action: ' + (action || '(none)') + '.', actions: Object.keys(ACTION_CAPABILITY) }, 400);
  }

  // ---- platform appointments --------------------------------------------------------------------
  if (action === 'grant_platform_role' || action === 'revoke_platform_role') {
    const newRole = action === 'grant_platform_role' ? (String(body.role || '') as GovRole) : null;
    const g = await requireGov(locals, 'platform.grant', { platformWide: true, newRole }, request);
    if (g.denied) return g.denied;

    if (action === 'grant_platform_role') {
      const out = await auditedWrite(
        { actor: g.actor, action: AUDIT_ACTIONS.PLATFORM_GRANT_CHANGED, targetType: 'platform_grant', targetId: String(body.email || ''), reason: String(body.reason || ''), meta: { role: newRole, granted: true }, facts: g.facts },
        async () => {
          const r = await grantPlatformRole({
            userEmail: String(body.email || ''), role: newRole as GovRole,
            grantedBy: g.actor.userId as string, reason: String(body.reason || ''),
          });
          if (!r.ok) throw new Error(r.error);
          return r;
        },
      );
      if (out.ok) {
        await recordSecurityEvent({
          type: 'permission.changed', subject: String(body.email || ''), actorUserId: g.actor.userId,
          ip: g.facts.ip, requestId: g.facts.requestId, detail: { role: newRole, kind: 'platform-grant' },
        });
      }
      return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
    }

    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.PLATFORM_GRANT_CHANGED, targetType: 'platform_grant', targetId: String(body.grantId || ''), reason: String(body.reason || ''), meta: { granted: false }, facts: g.facts },
      async () => {
        const r = await revokePlatformRole({ grantId: String(body.grantId || ''), byUserId: g.actor.userId as string, reason: String(body.reason || '') });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  // ---- membership actions -------------------------------------------------------------------------
  const orgId = String(body.orgId || url.searchParams.get('org') || '');
  const userId = String(body.userId || '');

  // The target's CURRENT role has to be known before the door can judge the action, so it is looked
  // up first — for a create there is no membership yet, and the proposed role is what matters.
  let currentRole: GovRole | null = null;
  if (userId && orgId) {
    const existing = await getMember(orgId, userId);
    if (existing.ok && existing.member) currentRole = existing.member.govRole;
  }
  const newRole: GovRole | null = action === 'change_role' || action === 'create'
    ? govRoleForMembership(String(body.role || ''))
    : null;

  const g = await requireGov(locals, capability, { orgId, userId: userId || undefined, currentRole, newRole }, request);
  if (g.denied) return g.denied;
  if (!orgId) return govJson({ ok: false, error: 'Name the organization.' }, 400);

  const reason = String(body.reason || '');

  if (action === 'create') {
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.USER_CREATED, orgId, targetType: 'membership', targetId: String(body.email || ''), reason, meta: { role: String(body.role || 'member') }, facts: g.facts },
      async () => {
        const r = await createMember({
          orgId, email: String(body.email || ''), role: String(body.role || 'member') as OrgMemberRole,
          invitedBy: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error, userId: out.data?.userId }, out.ok ? 200 : 400);
  }

  if (!userId) return govJson({ ok: false, error: 'Name the person.' }, 400);

  if (action === 'suspend' || action === 'disable' || action === 'restore') {
    const status = action === 'restore' ? 'active' : action === 'suspend' ? 'suspended' : 'disabled';
    const auditAction = action === 'restore' ? AUDIT_ACTIONS.USER_RESTORED
      : action === 'suspend' ? AUDIT_ACTIONS.USER_SUSPENDED : AUDIT_ACTIONS.USER_DISABLED;
    const out = await auditedWrite(
      { actor: g.actor, action: auditAction, orgId, targetType: 'membership', targetId: userId, reason, meta: { status }, facts: g.facts },
      async () => {
        const r = await setMemberStatus({ orgId, userId, status: status as any, reason });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  if (action === 'change_role') {
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.USER_ROLE_CHANGED, orgId, targetType: 'membership', targetId: userId, reason, meta: { role: String(body.role || '') }, facts: g.facts },
      async () => {
        const r = await changeMemberRole({ orgId, userId, role: String(body.role || '') as OrgMemberRole });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    if (out.ok) {
      await recordSecurityEvent({
        type: 'permission.changed', orgId, subject: userId, actorUserId: g.actor.userId,
        ip: g.facts.ip, requestId: g.facts.requestId,
        detail: { from: out.data?.previous, to: String(body.role || '') },
      });
    }
    return govJson({ ok: out.ok, error: out.error, previous: out.data?.previous }, out.ok ? 200 : 400);
  }

  if (action === 'remove') {
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.MEMBERSHIP_REMOVED, orgId, targetType: 'membership', targetId: userId, reason, facts: g.facts },
      async () => {
        const r = await removeMembership({ orgId, userId, reason });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  if (action === 'revoke_sessions') {
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.USER_SESSIONS_REVOKED, orgId, targetType: 'account', targetId: userId, reason, facts: g.facts },
      async () => {
        const r = await revokeSessions(userId);
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    if (out.ok) {
      await recordSecurityEvent({
        type: 'auth.session_revoked', orgId, subject: userId, actorUserId: g.actor.userId,
        ip: g.facts.ip, requestId: g.facts.requestId, detail: { revoked: out.data?.revoked || 0 },
      });
    }
    return govJson({
      ok: out.ok, error: out.error, revoked: out.data?.revoked || 0,
      note: 'This signs the person out of EduRankAI entirely, not only the mail platform.',
    }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unhandled action.' }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
