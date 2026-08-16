// src/lib/mailgov/policy.ts — WHO MAY ADMINISTER WHAT, OVER WHICH TENANT, AND WHAT THEY MAY NOT
// HAND THEMSELVES.
//
// PURE. No database, no session, no framework. Every decision the governance surfaces make is
// decided here and only here, so the answer can be tested exhaustively without a connection — and
// so there is exactly one place to read when somebody asks "could a support engineer have done
// that?".
//
// THIS DOES NOT FORK THE EXISTING RBAC. src/lib/auth/permissions.ts (~1400 lines) decides who may
// open the EduRankAI admin console; src/lib/auth/registry.ts decides what a custom role adds.
// Neither is touched. This module answers a DIFFERENT question — "what may this person do to the
// mail platform's tenants" — and src/lib/mailgov/guard.ts is the one place that translates an
// EduRankAI session into a GovActor by composing those existing answers. The rule is: an EduRankAI
// permission may ADMIT somebody here, and nothing here ever grants an EduRankAI permission back.
//
// THREE SEPARATE REFUSALS, DELIBERATELY NOT COLLAPSED. A denial answers one of three questions and
// the distinction matters both in the log and on screen:
//
//   1. CAPABILITY  — the role does not carry this ability at all.
//   2. TENANCY     — the ability exists but the target belongs to another organization. This is the
//                    isolation boundary, and it is checked on every call, reads included.
//   3. ESCALATION  — ability and tenant are both fine, but performing it would hand the actor (or
//                    somebody they control) more authority than the actor holds. This is the one the
//                    brief calls "never allow an administrator to bypass authorization checks
//                    accidentally", and the one that cannot be left to each call site.
//
// A CAPABILITY IS NOT A ROLE NAME. Call sites ask for the ability by name — authorizeGov(actor,
// 'org.suspend', { orgId }) — never `if (actor.role === 'platform_admin')`. A role-name test inside
// a handler is how a new role silently gains or loses a power six months later.

/**
 * Governance roles, narrowest first.
 *
 * `org_admin` and `auditor` may be TENANT-SCOPED (actor.orgId set); the platform roles never are.
 * The rank is what stops an administrator minting an administrator above themselves — see
 * assignableRoles() below. Ranks are spaced by 10 so a role can be inserted between two without
 * renumbering the rest.
 */
export type GovRole = 'none' | 'auditor' | 'support' | 'org_admin' | 'platform_admin' | 'platform_owner';

export const GOV_ROLE_RANK: Record<GovRole, number> = {
  none: 0,
  auditor: 10,
  support: 20,
  org_admin: 30,
  platform_admin: 40,
  platform_owner: 50,
};

export const GOV_ROLE_LABEL: Record<GovRole, string> = {
  none: 'No governance access',
  auditor: 'Auditor (read-only)',
  support: 'Support',
  org_admin: 'Organization administrator',
  platform_admin: 'Platform administrator',
  platform_owner: 'Platform owner',
};

/**
 * Every ability the governance surfaces can be asked for.
 *
 * Dotted `<subject>.<action>`, matching the shape src/lib/admin-sections.ts already uses for the
 * EduRankAI console, so a reader moving between the two reads one naming convention.
 *
 * Adding a capability is additive. REMOVING one, or changing what it covers, is a breaking change:
 * a grant row in mailapi_platform_admins and an audit event from last year both name it.
 */
export const GOV_CAPABILITIES = [
  // organizations
  'org.view', 'org.usage.view', 'org.suspend', 'org.restore',
  'org.sending.disable', 'org.receiving.disable', 'org.campaigns.disable',
  'org.credentials.rotate', 'org.delete',
  // users and membership
  'user.view', 'user.create', 'user.disable', 'user.suspend', 'user.restore',
  'user.sessions.revoke', 'user.role.change', 'user.membership.remove',
  // audit
  'audit.view', 'audit.verify', 'audit.export',
  // retention
  'retention.view', 'retention.edit',
  // export
  'export.view', 'export.request', 'export.download',
  // deletion
  'deletion.view', 'deletion.request', 'deletion.approve', 'deletion.cancel',
  // consent
  'consent.view', 'consent.edit',
  // security
  'security.view', 'security.resolve',
  // legal hold
  'hold.view', 'hold.place', 'hold.release',
  // support
  'support.metadata.view', 'support.message.retry', 'support.content.request', 'support.content.approve',
  // cross-cutting
  'search.run', 'health.view', 'platform.grant',
] as const;

export type GovCapability = (typeof GOV_CAPABILITIES)[number];

const ALL: GovCapability[] = [...GOV_CAPABILITIES];

/**
 * READ-ONLY EVERYTHING, PLUS NOTHING. An auditor exists so that "who checks the checkers" has an
 * answer which does not require handing somebody the ability to change what they are checking.
 * Deliberately includes audit.export (an audit nobody can take away and read is not much of an
 * audit) and deliberately excludes every write, every content path and every support grant.
 */
const AUDITOR: GovCapability[] = [
  'org.view', 'org.usage.view', 'user.view', 'audit.view', 'audit.verify', 'audit.export',
  'retention.view', 'export.view', 'deletion.view', 'consent.view', 'security.view',
  'hold.view', 'search.run', 'health.view',
];

/**
 * SUPPORT SEES ENVELOPES, NOT LETTERS.
 *
 * The one write a support engineer holds unaided is `support.message.retry`, and that is a retry of
 * a message the platform already accepted — it reveals nothing and creates nothing. Reading what a
 * message SAID needs support.content.request, which only ASKS; the approval is a different
 * capability held by a different person (see requiresSecondPerson()).
 */
const SUPPORT: GovCapability[] = [
  'org.view', 'user.view', 'search.run', 'health.view', 'security.view',
  'support.metadata.view', 'support.message.retry', 'support.content.request',
  'export.view', 'deletion.view', 'hold.view', 'audit.view',
];

/**
 * An organization's own administrator. Everything here is tenant-scoped by authorizeGov() — the
 * capability list says WHAT, the actor's orgId says OVER WHOM, and neither is sufficient alone.
 *
 * NOT included, on purpose: org.suspend / org.restore (a tenant suspending itself is a support
 * conversation, not a self-service button), org.delete, platform.grant, support.content.approve,
 * hold.release (a customer releasing a hold placed on their own records defeats the hold), and
 * health.view (that is the platform's health, not theirs).
 */
const ORG_ADMIN: GovCapability[] = [
  'org.view', 'org.usage.view', 'org.sending.disable', 'org.receiving.disable', 'org.campaigns.disable',
  'org.credentials.rotate',
  'user.view', 'user.create', 'user.disable', 'user.suspend', 'user.restore',
  'user.sessions.revoke', 'user.role.change', 'user.membership.remove',
  'audit.view', 'audit.export',
  'retention.view', 'retention.edit',
  'export.view', 'export.request', 'export.download',
  'deletion.view', 'deletion.request', 'deletion.approve', 'deletion.cancel',
  'consent.view', 'consent.edit',
  'security.view', 'security.resolve',
  'hold.view',
  'support.metadata.view', 'support.message.retry',
  'search.run',
];

/**
 * PLATFORM ADMINISTRATOR — everything except the four powers that are the owner's alone:
 *
 *   org.delete               destroying a tenant outright
 *   support.content.approve  authorising a human to read somebody's mail
 *   hold.release             lifting a retention hold on records under a legal matter
 *   platform.grant           appointing another platform administrator
 *
 * Each of those is irreversible, or makes every other control reversible. Splitting them off is what
 * lets the audit trail answer "who could have done this" with a name rather than a group.
 */
const PLATFORM_ADMIN: GovCapability[] = ALL.filter(
  (c) => !(['org.delete', 'support.content.approve', 'hold.release', 'platform.grant'] as string[]).includes(c),
);

export const CAPABILITIES_BY_GOV_ROLE: Record<GovRole, GovCapability[]> = {
  none: [],
  auditor: AUDITOR,
  support: SUPPORT,
  org_admin: ORG_ADMIN,
  platform_admin: PLATFORM_ADMIN,
  platform_owner: ALL,
};

/**
 * The person or key asking.
 *
 * `orgId === null` means PLATFORM SCOPE — the actor may address any tenant. Any other value confines
 * every call to that one organization, reads included. There is no third state and no "sometimes
 * wider" flag: a widening would have to be a role change, and a role change is audited.
 */
export interface GovActor {
  userId: string | null;
  email: string | null;
  role: GovRole;
  /** null = platform scope. A UUID = this organization and no other. */
  orgId: string | null;
  /** How guard.ts arrived at this role, for the log line and the diagnostics screen. */
  via?: 'founder' | 'platform-grant' | 'admin-permission' | 'org-membership' | 'none';
}

export interface GovTarget {
  /** The organization the action lands on. Required for everything except platform-wide reads. */
  orgId?: string | null;
  /** For user administration: who is being acted on, and what they would become. */
  userId?: string | null;
  currentRole?: GovRole | null;
  newRole?: GovRole | null;
  /** True when the target belongs to no tenant (platform health, cross-org search). */
  platformWide?: boolean;
}

export type GovDenyCode =
  | 'not-authenticated'
  | 'no-governance-role'
  | 'capability-missing'
  | 'cross-tenant'
  | 'tenant-required'
  | 'self-target'
  | 'role-escalation'
  | 'peer-or-above';

export interface GovDecision {
  allowed: boolean;
  code: GovDenyCode | 'ok';
  /** One sentence a human can act on. Rendered on screen and written into the audit event. */
  reason: string;
}

const OK: GovDecision = { allowed: true, code: 'ok', reason: 'Authorized.' };
const deny = (code: GovDenyCode, reason: string): GovDecision => ({ allowed: false, code, reason });

/** Does the role carry this ability at all? Tenancy and escalation are separate questions. */
export function holdsGovCapability(actor: GovActor | null | undefined, cap: GovCapability): boolean {
  if (!actor || !actor.userId) return false;
  return (CAPABILITIES_BY_GOV_ROLE[actor.role] || []).includes(cap);
}

/**
 * Capabilities that read or write NOTHING belonging to a tenant, and so may be exercised without an
 * orgId. Everything not on this list requires a target organization — including reads, because
 * "list every organization's security events" is precisely the cross-tenant leak this file exists to
 * prevent, and it is a read.
 */
const PLATFORM_SCOPED: GovCapability[] = ['health.view', 'platform.grant', 'audit.verify'];

/**
 * Capabilities a PLATFORM actor may exercise with no organization named, because listing across
 * tenants is the point of them. A TENANT actor never reaches this list — the orgId branch above it
 * has already pinned them to their own organization.
 */
const CROSS_TENANT_READS: GovCapability[] = [
  'org.view', 'user.view', 'audit.view', 'security.view', 'search.run',
  'export.view', 'deletion.view', 'hold.view', 'support.metadata.view', 'consent.view',
  'retention.view', 'org.usage.view',
];

/**
 * THE ONE ENTRY POINT. Every governance route and console page calls this before it reads or writes
 * anything — not after, and not instead of a role-name check.
 *
 * Order is deliberate: authentication, then capability, then tenancy, then escalation. A caller who
 * fails at the capability step is never told which tenant they failed against, and a caller who
 * fails at the tenancy step never learns whether the capability exists.
 */
export function authorizeGov(
  actor: GovActor | null | undefined,
  cap: GovCapability,
  target: GovTarget = {},
): GovDecision {
  if (!actor || !actor.userId) return deny('not-authenticated', 'Sign in to use the governance console.');
  if (actor.role === 'none') {
    return deny('no-governance-role', 'This account has no role on the mail platform.');
  }
  if (!holdsGovCapability(actor, cap)) {
    return deny('capability-missing', GOV_ROLE_LABEL[actor.role] + ' does not include ' + cap + '.');
  }

  // ---- tenancy -------------------------------------------------------------------------------
  const platformScoped = PLATFORM_SCOPED.includes(cap) || target.platformWide === true;
  if (actor.orgId) {
    // A tenant-scoped actor may never address the platform, and never another tenant.
    if (platformScoped) {
      return deny('cross-tenant', 'This view spans every organization; your access is limited to your own.');
    }
    if (!target.orgId) {
      return deny('tenant-required', 'This action needs an organization, and yours was not supplied.');
    }
    if (target.orgId !== actor.orgId) {
      return deny('cross-tenant', 'That record belongs to another organization.');
    }
  } else if (!platformScoped && !target.orgId) {
    // A platform actor with no organization named is asking for a cross-tenant sweep. Allowed only
    // where the capability says so — otherwise it is nearly always a call site that forgot to pass
    // the id, and answering it would quietly return every tenant's rows.
    if (!CROSS_TENANT_READS.includes(cap)) {
      return deny('tenant-required', 'Name the organization this applies to.');
    }
  }

  // ---- escalation ----------------------------------------------------------------------------
  return checkEscalation(actor, cap, target);
}

/**
 * The refusals that survive holding the capability.
 *
 * SELF-TARGETING. An administrator may not change their own role, or suspend, disable or unseat
 * themselves. Not because it is dangerous to them — because a compromised session that can demote
 * its own account to something unaudited, or lock the real owner out, is the shape of every
 * account-takeover escalation. Revoking one's own SESSIONS stays allowed: signing yourself out
 * everywhere is the correct reaction to suspecting a compromise, and refusing it would be actively
 * harmful.
 *
 * RANK. Nobody may create, promote to, or act upon a role at or above their own. `platform_owner` is
 * therefore only ever assigned by another owner, and an org_admin cannot mint a platform_admin even
 * though they hold user.role.change — which is exactly the accidental bypass the brief names.
 */
function checkEscalation(actor: GovActor, cap: GovCapability, target: GovTarget): GovDecision {
  const actorRank = GOV_ROLE_RANK[actor.role];
  const selfTargeted = !!target.userId && !!actor.userId && target.userId === actor.userId;

  const SELF_REFUSED: GovCapability[] = ['user.role.change', 'user.suspend', 'user.disable', 'user.membership.remove'];
  if (selfTargeted && SELF_REFUSED.includes(cap)) {
    return deny('self-target', 'You cannot change your own role or access from here. Ask another administrator.');
  }

  if (cap === 'user.role.change' || cap === 'platform.grant') {
    const next = target.newRole;
    if (next && GOV_ROLE_RANK[next] >= actorRank) {
      return deny('role-escalation', 'You cannot grant a role at or above your own (' + GOV_ROLE_LABEL[actor.role] + ').');
    }
  }

  // Acting ON somebody at or above your rank — suspending a platform owner as a platform admin, for
  // instance. Reads are exempt: seeing that an owner exists is not a power over them.
  const WRITES: GovCapability[] = [
    'user.disable', 'user.suspend', 'user.restore', 'user.sessions.revoke',
    'user.role.change', 'user.membership.remove',
  ];
  if (WRITES.includes(cap) && target.currentRole && !selfTargeted) {
    if (GOV_ROLE_RANK[target.currentRole] >= actorRank) {
      return deny('peer-or-above', 'That account holds a role at or above yours. Only a higher role may act on it.');
    }
  }

  return OK;
}

/**
 * Which roles may `actor` assign? The same rule authorizeGov() applies, exported on its own so a
 * form can OFFER only the roles that would be accepted rather than presenting a choice and then
 * refusing it.
 */
export function assignableRoles(actor: GovActor | null | undefined): GovRole[] {
  if (!actor || actor.role === 'none') return [];
  const rank = GOV_ROLE_RANK[actor.role];
  return (Object.keys(GOV_ROLE_RANK) as GovRole[]).filter((r) => GOV_ROLE_RANK[r] < rank);
}

/**
 * Actions that must be performed by somebody OTHER than the person who asked for them.
 *
 * Two-person control is the only thing that makes an audit trail preventive rather than merely
 * explanatory: reading a customer's message, and destroying a tenant, are both things where "I
 * approved my own request" is indistinguishable from an abuse, after the fact, forever.
 */
export function requiresSecondPerson(cap: GovCapability): boolean {
  return cap === 'support.content.approve' || cap === 'org.delete';
}

/**
 * The ORG membership roles this module maps onto a GovRole.
 *
 * src/lib/mailplatform/types.ts already declared the membership vocabulary
 * ('owner' | 'admin' | 'member' | 'analyst' | 'service') as the mail platform's contract. This
 * translates it rather than inventing a second one: `member` and `service` get NO console access at
 * all, which is deliberate — a membership row is not an administrative grant.
 */
export function govRoleForMembership(membershipRole: string | null | undefined): GovRole {
  switch ((membershipRole || '').toLowerCase()) {
    case 'owner':
    case 'admin':
      return 'org_admin';
    case 'analyst':
      return 'auditor';
    default:
      return 'none';
  }
}

/** Membership roles a tenant may hold. Kept identical to OrgMemberRole in mailplatform/types.ts. */
export const ORG_MEMBER_ROLES = ['owner', 'admin', 'member', 'analyst', 'service'] as const;
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ['active', 'suspended', 'disabled', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * Is this membership usable right now? One definition, used by the guard and by the user screens, so
 * a suspended member cannot be admitted by one and listed as active by the other.
 */
export function membershipIsActive(status: string | null | undefined): boolean {
  return status === 'active';
}
