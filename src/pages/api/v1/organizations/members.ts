// GET    /api/v1/organizations/members?orgId=...  — who is on the team
// POST   /api/v1/organizations/members            — add somebody
// PATCH  /api/v1/organizations/members            — change a role
// DELETE /api/v1/organizations/members            — remove somebody
//
// Every one of these resolves the tenant from MEMBERSHIP, never from the `orgId` parameter alone.
// `resolveTenantForUser()` returns null when the caller is not a member, and a null tenant is a 403
// — so passing another organization's id changes nothing except which refusal you get.
import type { APIRoute } from 'astro';
import { error, ok, preflight, readJson, requirePrincipal } from '@/lib/mailplatform/api';
import {
  checkCapability,
  getSaasStore,
  inviteMember,
  removeMember,
  resolveTenantForUser,
  setMemberRole,
} from '@/lib/mailplatform/saas/service';
import { TEAM_ROLES } from '@/lib/mailplatform/saas/types';
import type { TeamRole } from '@/lib/mailplatform/saas/types';
import { TEAM_ROLE_DESCRIPTIONS, TEAM_ROLE_LABELS, permissionsFor } from '@/lib/mailplatform/saas/roles';

export const prerender = false;
export const OPTIONS: APIRoute = () => preflight();

function isTeamRole(v: unknown): v is TeamRole {
  return typeof v === 'string' && (TEAM_ROLES as readonly string[]).includes(v);
}

/** Resolve the tenant, or the Response that refuses. */
async function tenantOr403(userId: string, requested: string | null): Promise<string | Response> {
  const orgId = await resolveTenantForUser(userId, requested);
  if (!orgId) return error('forbidden', 403, 'not_a_member');
  return orgId;
}

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);
  const orgId = await tenantOr403(auth.principal.id, url.searchParams.get('orgId'));
  if (orgId instanceof Response) return orgId;

  try {
    const members = await getSaasStore().listMembers(orgId);
    return ok({
      orgId,
      members: members.map((m) => ({
        userId: m.userId,
        name: m.userName || null,
        email: m.userEmail || null,
        teamRole: m.teamRole,
        label: TEAM_ROLE_LABELS[m.teamRole],
        platformRole: m.role,
        joinedAt: m.createdAt,
      })),
      roles: TEAM_ROLES.map((r) => ({
        key: r,
        label: TEAM_ROLE_LABELS[r],
        description: TEAM_ROLE_DESCRIPTIONS[r],
        permissions: permissionsFor(r),
      })),
    });
  } catch (e: any) {
    const detail = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[api/v1/organizations/members] list failed -', detail);
    return error('The team could not be read: ' + detail, 500, 'read_failed');
  }
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<{ orgId?: string; userId?: string; teamRole?: string }>(ctx.request);
  if (body instanceof Response) return body;

  const orgId = await tenantOr403(auth.principal.id, body.orgId || null);
  if (orgId instanceof Response) return orgId;
  if (!body.userId) return error('Which account should be added? Send a userId.', 400, 'missing_user');
  if (!isTeamRole(body.teamRole)) {
    return error('Pick a role: ' + TEAM_ROLES.join(', ') + '.', 400, 'invalid_role');
  }

  // The service applies BOTH gates — the seat limit and the role rules — and returns the sentence
  // to show. A 409 rather than a 403: the caller is allowed to manage the team, this particular
  // change conflicts with the plan or with the hierarchy.
  const result = await inviteMember(orgId, auth.principal.id, String(body.userId), body.teamRole);
  if (!result.ok) return error(result.message, 409, 'refused');
  return ok({ orgId, member: { userId: body.userId, teamRole: body.teamRole }, message: result.message }, 201);
};

export const PATCH: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<{ orgId?: string; userId?: string; teamRole?: string }>(ctx.request);
  if (body instanceof Response) return body;

  const orgId = await tenantOr403(auth.principal.id, body.orgId || null);
  if (orgId instanceof Response) return orgId;
  if (!body.userId) return error('Whose role is changing? Send a userId.', 400, 'missing_user');
  if (!isTeamRole(body.teamRole)) {
    return error('Pick a role: ' + TEAM_ROLES.join(', ') + '.', 400, 'invalid_role');
  }

  const result = await setMemberRole(orgId, auth.principal.id, String(body.userId), body.teamRole);
  if (!result.ok) return error(result.message, 409, 'refused');
  return ok({ orgId, member: { userId: body.userId, teamRole: body.teamRole }, message: result.message });
};

export const DELETE: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<{ orgId?: string; userId?: string }>(ctx.request);
  if (body instanceof Response) return body;

  const orgId = await tenantOr403(auth.principal.id, body.orgId || null);
  if (orgId instanceof Response) return orgId;
  if (!body.userId) return error('Who should be removed? Send a userId.', 400, 'missing_user');

  const result = await removeMember(orgId, auth.principal.id, String(body.userId));
  if (!result.ok) return error(result.message, 409, 'refused');
  return ok({ orgId, removed: body.userId, message: result.message });
};

/** Exported for the admin screen, which asks the same question before drawing the controls. */
export async function canManageTeam(orgId: string, userId: string): Promise<boolean> {
  return (await checkCapability(orgId, userId, 'team.manage')).allowed;
}
