// src/lib/mailplatform/permissions.ts — who may do what inside the mail platform.
//
// Pure. No database, no request, no framework — so it is fully testable and can be reasoned about
// by reading one file. Resolution of WHO the caller is lives in ./adapters/auth-platform.ts; this
// module only answers, given a role, what that role may do.
//
// This is a SEPARATE capability space from src/lib/auth/permissions.ts. That module governs the
// EduRankAI admin console and is ~1400 lines with 60+ roles; the mail platform is a product other
// organizations will eventually hold accounts in, and folding its capabilities into the internal
// admin role table would mean a tenant's role change edits the same catalogue that decides who can
// read HR records. The bridge between the two is one function — mailRoleForInternalUser() — and it
// is deliberately narrow.

import type { MailPermission, OrgMemberRole, Principal } from './types';

/** The complete capability catalogue. Order is display order. */
export const MAIL_PERMISSIONS: { key: MailPermission; label: string; group: string }[] = [
  { key: 'mail.read', label: 'Read messages in mailboxes they can access', group: 'Mail' },
  { key: 'mail.send', label: 'Send and reply from an allowed identity', group: 'Mail' },
  { key: 'mail.manage', label: 'Manage delivery, suppression and transport settings', group: 'Mail' },
  { key: 'mailbox.manage', label: 'Create, rename and assign mailboxes and aliases', group: 'Mail' },
  { key: 'contacts.read', label: 'View contacts and lists', group: 'Contacts' },
  { key: 'contacts.write', label: 'Create, edit, import and delete contacts', group: 'Contacts' },
  { key: 'campaigns.read', label: 'View campaigns and their results', group: 'Marketing' },
  { key: 'campaigns.write', label: 'Create and edit campaigns', group: 'Marketing' },
  { key: 'campaigns.send', label: 'Start or schedule a campaign send', group: 'Marketing' },
  { key: 'templates.read', label: 'View templates', group: 'Marketing' },
  { key: 'templates.write', label: 'Create and publish template versions', group: 'Marketing' },
  { key: 'domains.read', label: 'View domains and their DNS status', group: 'Domains' },
  { key: 'domains.manage', label: 'Add domains, rotate DKIM keys, change sending settings', group: 'Domains' },
  { key: 'automation.read', label: 'View automation workflows and runs', group: 'Automation' },
  { key: 'automation.write', label: 'Create, edit, activate and pause workflows', group: 'Automation' },
  { key: 'events.read', label: 'Query the platform event stream', group: 'Platform' },
  { key: 'webhooks.manage', label: 'Register and revoke webhook endpoints', group: 'Platform' },
  { key: 'org.manage', label: 'Manage organization settings and membership', group: 'Platform' },
];

export const ALL_MAIL_PERMISSIONS: MailPermission[] = MAIL_PERMISSIONS.map((p) => p.key);

const READ_ONLY: MailPermission[] = [
  'mail.read',
  'contacts.read',
  'campaigns.read',
  'templates.read',
  'domains.read',
  'automation.read',
  'events.read',
];

/**
 * Role to capability.
 *
 * `member` deliberately cannot send a CAMPAIGN. Sending one message as yourself and sending fifty
 * thousand as the organization are different acts with different consequences, and a single
 * "can send email" capability collapses them. `campaigns.send` is the separate switch.
 *
 * `service` is what an API key acts as: it can send transactional mail and read what it needs to
 * compose one, and it can do nothing administrative. A leaked integration key must not be able to
 * add a sending domain or read the whole contact database.
 */
export const PERMISSIONS_BY_ROLE: Record<OrgMemberRole, MailPermission[]> = {
  owner: [...ALL_MAIL_PERMISSIONS],
  admin: ALL_MAIL_PERMISSIONS.filter((p) => p !== 'org.manage'),
  member: [
    'mail.read',
    'mail.send',
    'contacts.read',
    'contacts.write',
    'campaigns.read',
    'campaigns.write',
    'templates.read',
    'templates.write',
    'automation.read',
  ],
  analyst: [...READ_ONLY],
  service: ['mail.send', 'mail.read', 'contacts.read', 'templates.read', 'events.read'],
};

/** True when this role holds this capability. The single place the question is answered. */
export function roleHas(role: OrgMemberRole | null | undefined, permission: MailPermission): boolean {
  if (!role) return false;
  const list = PERMISSIONS_BY_ROLE[role];
  return Array.isArray(list) && list.includes(permission);
}

/**
 * Capability check for a resolved principal.
 *
 * Reads the principal's OWN permission list, not its role, because an API key may be issued with a
 * narrower set than its role would give (scopes on api_keys). Falls back to the role only when the
 * list is absent, so an older key with no scopes recorded keeps working exactly as before.
 */
export function can(principal: Principal | null | undefined, permission: MailPermission): boolean {
  if (!principal) return false;
  if (Array.isArray(principal.permissions) && principal.permissions.length > 0) {
    return principal.permissions.includes(permission);
  }
  return roleHas(principal.role, permission);
}

/** Every capability a principal holds, for a settings screen that must show the truth. */
export function permissionsOf(principal: Principal | null | undefined): MailPermission[] {
  if (!principal) return [];
  if (Array.isArray(principal.permissions) && principal.permissions.length > 0) return [...principal.permissions];
  return [...(PERMISSIONS_BY_ROLE[principal.role] || [])];
}

/** Narrow a permission set by requested scopes. Intersection only — scopes can never widen. */
export function intersectScopes(base: MailPermission[], scopes: string[] | null | undefined): MailPermission[] {
  if (!scopes || scopes.length === 0) return [...base];
  const wanted = new Set(scopes.map((s) => String(s).trim()).filter(Boolean));
  if (wanted.has('*')) return [...base];
  return base.filter((p) => wanted.has(p));
}

/**
 * The bridge from an internal EduRankAI account to a platform role, for the DEFAULT organization.
 *
 * Kept to one small function on purpose. Everything else in the platform asks
 * mp_organization_members; this is only how an existing EduRankAI admin gets a seat on day one
 * without a manual invite, and how an internal role change stays reflected. It grants `owner` to
 * nobody: ownership of the tenant is a deliberate act recorded in the members table, not something
 * inferred from a job title.
 */
export function mailRoleForInternalUser(
  user: { role?: string | null; isActive?: boolean } | null | undefined,
): OrgMemberRole | null {
  if (!user || user.isActive === false) return null;
  const role = String(user.role || '').toLowerCase();
  if (!role) return null;
  if (role === 'super_admin' || role === 'admin') return 'admin';
  if (role === 'analyst' || role === 'auditor' || role === 'reviewer') return 'analyst';
  // Every other internal role that reaches the mail platform at all is an ordinary member. The
  // question of whether they reach it is answered by canUseMailbox() in src/lib/auth/mail-access.ts,
  // which this does not duplicate or override.
  return 'member';
}

/** A one-line refusal an API can return without telling an unauthorised caller what to go find. */
export function refusalFor(permission: MailPermission): { error: string; code: string } {
  return { error: 'forbidden', code: 'insufficient_permission' };
}

/** The human sentence for an in-product screen, where naming the missing capability IS the help. */
export function explainPermission(permission: MailPermission): string {
  const meta = MAIL_PERMISSIONS.find((p) => p.key === permission);
  return meta ? meta.label : permission;
}
