// src/lib/mailplatform/saas/roles.ts — the nine team roles and what each one may actually do.
//
// PURE. No database, no imports beyond types. Every function here is a decision over plain data,
// which is what lets the whole permission matrix be tested without a connection — and a permission
// matrix nobody can test is a permission matrix nobody has checked.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT
//
// 1. `mail.read` IS NOT A HARMLESS DEFAULT. It means reading the contents of mailboxes. A role
//    named "Viewer" sounds like the least dangerous role in the product, and if it carried
//    `mail.read` it would be the most: an org would hand it to a contractor expecting they could
//    look at dashboards, and they could read the founder's inbox. Viewer and Analyst deliberately
//    do NOT have it. Neither does Analyst, whose whole job is aggregates.
//
// 2. THE LAST OWNER CANNOT BE REMOVED OR DEMOTED. An organization with no owner is an organization
//    nobody can pay for, change the plan of, or delete — a support ticket that requires a database
//    write to resolve. `canChangeRole()` and `canRemoveMember()` refuse it, and the caller gets a
//    sentence explaining why rather than a failed write.
//
// 3. NOBODY MAY GRANT WHAT THEY DO NOT HOLD. Assignment is rank-ordered: you may only place someone
//    strictly below yourself, and only an owner may create another owner. Without that rule an
//    Admin promotes themselves to Owner in one request and the hierarchy is decorative.

import type { MailPermission, OrgMemberRole } from '../types';
import type { Capability, TeamRole } from './types';
import { TEAM_ROLES } from './types';

/**
 * Permissions this layer needs that the platform contract does not define.
 *
 * Additive, and declared here rather than in ../types.ts for the reason given at the top of
 * ./types.ts: that file is a shared contract and this is a local need. Billing is separated from
 * `org.manage` because the two are genuinely different jobs — an Admin runs the organization, an
 * Owner pays for it, and plenty of customers want exactly that split.
 */
export type SaasOnlyPermission = 'billing.read' | 'billing.manage' | 'team.manage' | 'usage.read';

export type SaasPermission = MailPermission | SaasOnlyPermission;

/** Display strings. The UI reads these; nothing branches on them. */
export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  mail_admin: 'Mail Admin',
  campaign_manager: 'Campaign Manager',
  developer: 'Developer',
  analyst: 'Analyst',
  support_agent: 'Support Agent',
  member: 'Member',
  viewer: 'Viewer',
};

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: 'Full control, including the plan, payment method and closing the organization.',
  admin: 'Runs the organization and its people. Sees billing, cannot change the plan.',
  mail_admin: 'Mailboxes, domains, deliverability and suppression. Not campaigns or billing.',
  campaign_manager: 'Builds, schedules and sends campaigns. Owns contacts and templates.',
  developer: 'API keys, webhooks and programmatic sending. No access to mailbox contents.',
  analyst: 'Reports and exports. Reads aggregates, never the contents of a mailbox.',
  support_agent: 'Works a shared mailbox: reads and replies, and updates contact records.',
  member: 'Uses their own mailbox and the shared templates. No administration.',
  viewer: 'Read-only over campaigns, templates and reports. No mailbox access at all.',
};

/**
 * Rank, used ONLY for assignment authority. It is not a permission ladder: a Developer outranks a
 * Member yet cannot read a mailbox the Member reads every day, and that is correct. Rank answers
 * one question — who may hand out which role.
 */
export const TEAM_ROLE_RANK: Record<TeamRole, number> = {
  owner: 100,
  admin: 80,
  mail_admin: 60,
  campaign_manager: 60,
  developer: 60,
  analyst: 40,
  support_agent: 40,
  member: 20,
  viewer: 10,
};

const READ_ONLY_SET: SaasPermission[] = [
  'campaigns.read', 'templates.read', 'contacts.read', 'domains.read', 'automation.read',
  'events.read', 'usage.read',
];

/**
 * The matrix.
 *
 * Written out per role rather than composed from "role X plus these" on purpose: a matrix you can
 * read top to bottom is a matrix an operator can audit, and inheritance chains are how a role
 * quietly acquires a permission nobody intended to give it.
 */
export const ROLE_PERMISSIONS: Record<TeamRole, SaasPermission[]> = {
  owner: [
    'mail.read', 'mail.send', 'mail.manage', 'mailbox.manage',
    'contacts.read', 'contacts.write',
    'campaigns.read', 'campaigns.write', 'campaigns.send',
    'templates.read', 'templates.write',
    'domains.read', 'domains.manage',
    'automation.read', 'automation.write',
    'events.read', 'webhooks.manage',
    'org.manage', 'team.manage', 'usage.read', 'billing.read', 'billing.manage',
  ],
  // Everything an Owner has except the ability to CHANGE what is being paid. Reading billing is
  // kept, because an Admin who cannot see the invoice cannot answer the question they get asked.
  admin: [
    'mail.read', 'mail.send', 'mail.manage', 'mailbox.manage',
    'contacts.read', 'contacts.write',
    'campaigns.read', 'campaigns.write', 'campaigns.send',
    'templates.read', 'templates.write',
    'domains.read', 'domains.manage',
    'automation.read', 'automation.write',
    'events.read', 'webhooks.manage',
    'org.manage', 'team.manage', 'usage.read', 'billing.read',
  ],
  // Infrastructure, not marketing. Can create a mailbox and fix SPF; cannot send a campaign to the
  // contact list, which is the thing that cannot be taken back once it has gone out.
  mail_admin: [
    'mail.read', 'mail.send', 'mail.manage', 'mailbox.manage',
    'templates.read',
    'domains.read', 'domains.manage',
    'events.read', 'usage.read',
  ],
  campaign_manager: [
    'contacts.read', 'contacts.write',
    'campaigns.read', 'campaigns.write', 'campaigns.send',
    'templates.read', 'templates.write',
    'automation.read', 'automation.write',
    'domains.read', 'events.read', 'usage.read',
  ],
  // `mail.send` without `mail.read`: a developer's integration sends transactional mail through the
  // API. Nothing about that job requires reading what arrived in somebody's inbox.
  developer: [
    'mail.send',
    'templates.read', 'domains.read',
    'automation.read',
    'events.read', 'webhooks.manage', 'usage.read',
  ],
  analyst: [...READ_ONLY_SET],
  // The one role that reads a mailbox it does not own — that is the job. Bounded to reading and
  // replying plus contact records; no template authoring, no campaigns, no configuration.
  support_agent: [
    'mail.read', 'mail.send',
    'contacts.read', 'contacts.write',
    'templates.read',
  ],
  member: [
    'mail.read', 'mail.send',
    'templates.read', 'contacts.read',
  ],
  viewer: [...READ_ONLY_SET.filter((p) => p !== 'usage.read')],
};

/** Every permission any role can hold. Useful for rendering the matrix and for tests. */
export const ALL_SAAS_PERMISSIONS: SaasPermission[] = Array.from(
  new Set(TEAM_ROLES.flatMap((r) => ROLE_PERMISSIONS[r])),
).sort();

/** Does this role hold this permission? The single question the rest of the layer asks. */
export function roleHas(role: TeamRole | null | undefined, permission: SaasPermission): boolean {
  if (!role) return false;
  const grants = ROLE_PERMISSIONS[role];
  if (!grants) return false;
  return grants.includes(permission);
}

/** The permission set for a role, copied so a caller cannot mutate the matrix. */
export function permissionsFor(role: TeamRole): SaasPermission[] {
  return [...(ROLE_PERMISSIONS[role] || [])];
}

// ---------------------------------------------------------------------------
// Mapping to and from the platform contract's five roles
// ---------------------------------------------------------------------------

/**
 * Nine down to five, for code that predates this layer.
 *
 * The rule is NARROWING, never widening. `viewer` maps to `analyst` rather than `member` because
 * the contract's `member` can send mail and a Viewer must not; mapping it to `member` would have
 * handed send rights to the most restricted role in the product through the back door of a type
 * conversion. Where a role has no exact counterpart, the closest role that grants LESS wins.
 */
export function platformRoleFor(role: TeamRole): OrgMemberRole {
  switch (role) {
    case 'owner': return 'owner';
    case 'admin': return 'admin';
    case 'mail_admin': return 'admin';
    case 'campaign_manager': return 'member';
    case 'developer': return 'member';
    case 'support_agent': return 'member';
    case 'member': return 'member';
    case 'analyst': return 'analyst';
    case 'viewer': return 'analyst';
    default: return 'member';
  }
}

/**
 * Five up to nine, for a membership row written before `team_role` existed or by a subsystem that
 * does not know about it. Never invents authority: `member` becomes `member`, not something better.
 */
export function teamRoleFor(role: OrgMemberRole | string | null | undefined): TeamRole {
  switch (role) {
    case 'owner': return 'owner';
    case 'admin': return 'admin';
    case 'analyst': return 'analyst';
    case 'service': return 'developer';
    case 'member': return 'member';
    default: return 'viewer';
  }
}

/** Reads a stored value that may be either vocabulary. Persisted strings are never trusted. */
export function normalizeTeamRole(value: unknown, fallback: OrgMemberRole | null = null): TeamRole {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((TEAM_ROLES as readonly string[]).includes(v)) return v as TeamRole;
  return teamRoleFor(fallback);
}

// ---------------------------------------------------------------------------
// Assignment authority
// ---------------------------------------------------------------------------

export interface RoleChangeContext {
  /** The role of the person making the change. */
  actorRole: TeamRole;
  /** The role the target holds now. Null when inviting somebody new. */
  targetCurrentRole: TeamRole | null;
  /** The role being assigned. Null when removing the member. */
  targetNewRole: TeamRole | null;
  /** Whether the actor and the target are the same account. */
  isSelf: boolean;
  /** How many owners the organization has RIGHT NOW, including the target if they are one. */
  ownerCount: number;
}

export interface RoleChangeVerdict {
  ok: boolean;
  /** A sentence for the person who tried. Present whenever `ok` is false. */
  reason: string | null;
  code: 'ok' | 'not_permitted' | 'rank' | 'last_owner' | 'owner_only' | 'self_demotion' | null;
}

const OK: RoleChangeVerdict = { ok: true, reason: null, code: 'ok' };

/**
 * May the actor set the target's role to `targetNewRole`?
 *
 * Order matters here, and it is the order a person would reason in: first are you allowed to touch
 * membership at all, then is this a role you are senior enough to hand out, then does the change
 * leave the organization with an owner.
 */
export function canChangeRole(ctx: RoleChangeContext): RoleChangeVerdict {
  const { actorRole, targetCurrentRole, targetNewRole, isSelf, ownerCount } = ctx;

  if (!roleHas(actorRole, 'team.manage')) {
    return { ok: false, code: 'not_permitted', reason: 'Only an Owner or Admin can change who is on the team.' };
  }
  if (!targetNewRole) {
    return { ok: false, code: 'not_permitted', reason: 'No role was given to assign.' };
  }
  // Only an owner makes an owner. An Admin promoting themselves would otherwise be one request.
  if (targetNewRole === 'owner' && actorRole !== 'owner') {
    return { ok: false, code: 'owner_only', reason: 'Only an Owner can make somebody else an Owner.' };
  }
  const actorRank = TEAM_ROLE_RANK[actorRole];
  // An Owner may assign the Owner role (checked above) and anything below. Everyone else is capped
  // strictly below their own rank, so an Admin cannot mint another Admin and lose control of the
  // organization to somebody they cannot then demote.
  const ceiling = actorRole === 'owner' ? TEAM_ROLE_RANK.owner : actorRank - 1;
  if (TEAM_ROLE_RANK[targetNewRole] > ceiling) {
    return {
      ok: false,
      code: 'rank',
      reason: 'You can only assign roles below your own. ' + TEAM_ROLE_LABELS[targetNewRole] + ' is not below ' + TEAM_ROLE_LABELS[actorRole] + '.',
    };
  }
  // Moving a member who currently outranks you is the same problem seen from the other side.
  if (targetCurrentRole && !isSelf && TEAM_ROLE_RANK[targetCurrentRole] >= actorRank && actorRole !== 'owner') {
    return {
      ok: false,
      code: 'rank',
      reason: 'You cannot change the role of a ' + TEAM_ROLE_LABELS[targetCurrentRole] + '.',
    };
  }
  // The organization must always have somebody who can pay for it.
  if (targetCurrentRole === 'owner' && targetNewRole !== 'owner' && ownerCount <= 1) {
    return {
      ok: false,
      code: 'last_owner',
      reason: 'This is the only Owner. Make somebody else an Owner first, then change this role.',
    };
  }
  if (isSelf && targetCurrentRole === 'owner' && targetNewRole !== 'owner' && ownerCount <= 1) {
    return { ok: false, code: 'self_demotion', reason: 'You are the only Owner and cannot step down until there is another one.' };
  }
  return OK;
}

/** May the actor remove this member? Same reasoning, minus the new role. */
export function canRemoveMember(ctx: Omit<RoleChangeContext, 'targetNewRole'>): RoleChangeVerdict {
  const { actorRole, targetCurrentRole, isSelf, ownerCount } = ctx;
  // Leaving voluntarily is not a management action — anybody may do it, except the last owner.
  if (!isSelf && !roleHas(actorRole, 'team.manage')) {
    return { ok: false, code: 'not_permitted', reason: 'Only an Owner or Admin can remove somebody from the team.' };
  }
  if (targetCurrentRole === 'owner' && ownerCount <= 1) {
    return {
      ok: false,
      code: 'last_owner',
      reason: 'This is the only Owner. An organization cannot be left without one.',
    };
  }
  if (
    !isSelf && targetCurrentRole &&
    TEAM_ROLE_RANK[targetCurrentRole] >= TEAM_ROLE_RANK[actorRole] && actorRole !== 'owner'
  ) {
    return { ok: false, code: 'rank', reason: 'You cannot remove a ' + TEAM_ROLE_LABELS[targetCurrentRole] + '.' };
  }
  return OK;
}

/**
 * The effective role for work inside a team.
 *
 * A team role NARROWS: somebody who is a Member of the organization does not become an Admin by
 * being made an admin of one team. The lower rank wins, and the permissions are intersected rather
 * than the lower role's set being used wholesale, so no path through a team can add a permission
 * the organization role does not already grant.
 */
export function effectiveRole(orgRole: TeamRole, teamRole: TeamRole | null | undefined): TeamRole {
  if (!teamRole) return orgRole;
  return TEAM_ROLE_RANK[teamRole] < TEAM_ROLE_RANK[orgRole] ? teamRole : orgRole;
}

export function effectivePermissions(orgRole: TeamRole, teamRole?: TeamRole | null): SaasPermission[] {
  const base = permissionsFor(orgRole);
  if (!teamRole) return base;
  const scoped = new Set(permissionsFor(teamRole));
  return base.filter((p) => scoped.has(p));
}

// ---------------------------------------------------------------------------
// Capability shorthand
// ---------------------------------------------------------------------------

/**
 * Which permission a capability needs.
 *
 * This is the seam between the two vocabularies, and it lives here (with the roles) rather than in
 * the entitlement engine so that one file answers "who may do what" end to end. The engine adds the
 * plan and quota questions on top; it does not re-decide this one.
 */
export const CAPABILITY_PERMISSION: Record<Capability, SaasPermission> = {
  'mail.send': 'mail.send',
  'mail.read': 'mail.read',
  'mailbox.create': 'mailbox.manage',
  'campaign.create': 'campaigns.write',
  'campaign.send': 'campaigns.send',
  'campaign.schedule': 'campaigns.write',
  'contact.create': 'contacts.write',
  'contact.import': 'contacts.write',
  'domain.add': 'domains.manage',
  'domain.verify': 'domains.manage',
  'domain.custom_tracking': 'domains.manage',
  'automation.create': 'automation.write',
  'automation.execute': 'automation.write',
  'api.send': 'mail.send',
  'api.key.create': 'org.manage',
  'webhook.create': 'webhooks.manage',
  'webhook.deliver': 'webhooks.manage',
  'ai.summarize': 'mail.read',
  'ai.compose': 'mail.send',
  'analytics.view': 'events.read',
  'analytics.export': 'events.read',
  'org.manage': 'org.manage',
  'billing.manage': 'billing.manage',
  'team.manage': 'team.manage',
  'team.invite': 'team.manage',
  'team.create': 'team.manage',
};
