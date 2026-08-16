// src/lib/mailgov/policy.test.ts — the authorisation rules, exhaustively.
//
// These are the tests worth having. Every other test in this patch checks that a function does what
// it says; these check that a function REFUSES what it should, which is the half that is never
// exercised by using the product normally and is exactly the half an attacker exercises first.
//
// Pure module, no database, no mocking. authorizeGov() takes a value and returns a value.
import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES_BY_GOV_ROLE, GOV_CAPABILITIES, GOV_ROLE_RANK,
  assignableRoles, authorizeGov, govRoleForMembership, holdsGovCapability, membershipIsActive,
  requiresSecondPerson,
  type GovActor, type GovCapability, type GovRole,
} from './policy';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const actor = (role: GovRole, orgId: string | null = null, userId = 'user-1'): GovActor =>
  ({ userId, email: role + '@example.test', role, orgId });

describe('the capability matrix', () => {
  it('gives platform_owner every capability and none to a role of none', () => {
    expect(CAPABILITIES_BY_GOV_ROLE.platform_owner.length).toBe(GOV_CAPABILITIES.length);
    expect(CAPABILITIES_BY_GOV_ROLE.none.length).toBe(0);
  });

  it('withholds the four owner-only powers from a platform administrator', () => {
    const admin = CAPABILITIES_BY_GOV_ROLE.platform_admin;
    for (const cap of ['org.delete', 'support.content.approve', 'hold.release', 'platform.grant'] as GovCapability[]) {
      expect(admin.includes(cap)).toBe(false);
      expect(CAPABILITIES_BY_GOV_ROLE.platform_owner.includes(cap)).toBe(true);
    }
  });

  it('gives an auditor no write capability at all', () => {
    // The point of an auditor is that they can check without being able to change what they check.
    const writes = CAPABILITIES_BY_GOV_ROLE.auditor.filter((c) =>
      /\.(suspend|restore|disable|delete|edit|change|remove|revoke|rotate|place|release|approve|request|resolve|create|grant)$/.test(c));
    expect(writes).toEqual([]);
  });

  it('never lets support read message content unaided', () => {
    expect(CAPABILITIES_BY_GOV_ROLE.support.includes('support.content.approve')).toBe(false);
    expect(CAPABILITIES_BY_GOV_ROLE.support.includes('support.content.request')).toBe(true);
  });

  it('withholds every capability from an unauthenticated actor', () => {
    for (const cap of GOV_CAPABILITIES) {
      expect(holdsGovCapability(null, cap)).toBe(false);
      expect(holdsGovCapability({ userId: null, email: null, role: 'platform_owner', orgId: null }, cap)).toBe(false);
    }
  });
});

describe('tenant isolation', () => {
  it('refuses a tenant actor a record belonging to another organization', () => {
    const d = authorizeGov(actor('org_admin', ORG_A), 'user.view', { orgId: ORG_B });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('cross-tenant');
  });

  it('refuses a tenant actor a platform-wide view even when they hold the capability', () => {
    const d = authorizeGov(actor('org_admin', ORG_A), 'audit.view', { platformWide: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('cross-tenant');
  });

  it('refuses a tenant actor an action with no organization named', () => {
    const d = authorizeGov(actor('org_admin', ORG_A), 'consent.edit', {});
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('tenant-required');
  });

  it('allows a tenant actor their own organization', () => {
    expect(authorizeGov(actor('org_admin', ORG_A), 'user.view', { orgId: ORG_A }).allowed).toBe(true);
  });

  it('refuses a platform actor a tenant WRITE with no organization named', () => {
    // The commonest real bug this catches: a route that forgot to pass the id, which would otherwise
    // run the statement against every tenant at once.
    const d = authorizeGov(actor('platform_admin'), 'org.suspend', {});
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('tenant-required');
  });

  it('allows a platform actor a cross-tenant LIST, which is what those capabilities are for', () => {
    expect(authorizeGov(actor('platform_admin'), 'org.view', {}).allowed).toBe(true);
    expect(authorizeGov(actor('platform_admin'), 'audit.view', {}).allowed).toBe(true);
  });

  it('isolates every tenant-scoped capability, not a hand-picked few', () => {
    const tenantActor = actor('platform_admin', ORG_A);
    for (const cap of CAPABILITIES_BY_GOV_ROLE.platform_admin) {
      const d = authorizeGov(tenantActor, cap, { orgId: ORG_B });
      expect(d.allowed, cap + ' must not cross tenants').toBe(false);
    }
  });
});

describe('privilege escalation', () => {
  it('refuses granting a role at or above the actor rank', () => {
    const d = authorizeGov(actor('org_admin', ORG_A), 'user.role.change', {
      orgId: ORG_A, userId: 'someone-else', currentRole: 'none', newRole: 'platform_admin',
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('role-escalation');
  });

  it('refuses a platform admin minting anybody at all — they do not hold the grant capability', () => {
    // Refused one step EARLIER than the rank rule: platform.grant is owner-only, so a platform admin
    // never reaches the escalation check. Both refusals are correct and this asserts the stronger one.
    const d = authorizeGov(actor('platform_admin'), 'platform.grant', { newRole: 'support' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('capability-missing');
  });

  it('refuses even the owner granting a role equal to their own', () => {
    const d = authorizeGov(actor('platform_owner'), 'platform.grant', { newRole: 'platform_owner' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('role-escalation');
  });

  it('refuses acting on somebody who holds an equal or higher role', () => {
    const d = authorizeGov(actor('platform_admin'), 'user.suspend', {
      orgId: ORG_A, userId: 'the-owner', currentRole: 'platform_owner',
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('peer-or-above');
  });

  it('refuses self-targeting for role changes and suspension', () => {
    const me = actor('platform_admin', null, 'me');
    for (const cap of ['user.role.change', 'user.suspend', 'user.disable', 'user.membership.remove'] as GovCapability[]) {
      const d = authorizeGov(me, cap, { orgId: ORG_A, userId: 'me', currentRole: 'org_admin', newRole: 'org_admin' });
      expect(d.allowed, cap + ' on self must be refused').toBe(false);
      expect(d.code).toBe('self-target');
    }
  });

  it('still allows revoking your OWN sessions', () => {
    // Signing yourself out everywhere is the correct response to suspecting a compromise. Refusing it
    // would be actively harmful, so it is deliberately not on the self-target list.
    const me = actor('org_admin', ORG_A, 'me');
    expect(authorizeGov(me, 'user.sessions.revoke', { orgId: ORG_A, userId: 'me' }).allowed).toBe(true);
  });

  it('offers only roles strictly below the actor', () => {
    expect(assignableRoles(actor('org_admin'))).toEqual(['none', 'auditor', 'support']);
    expect(assignableRoles(actor('platform_owner')).includes('platform_owner')).toBe(false);
    expect(assignableRoles(actor('none'))).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });

  it('ranks the roles in the order the refusals depend on', () => {
    expect(GOV_ROLE_RANK.none).toBeLessThan(GOV_ROLE_RANK.auditor);
    expect(GOV_ROLE_RANK.auditor).toBeLessThan(GOV_ROLE_RANK.support);
    expect(GOV_ROLE_RANK.support).toBeLessThan(GOV_ROLE_RANK.org_admin);
    expect(GOV_ROLE_RANK.org_admin).toBeLessThan(GOV_ROLE_RANK.platform_admin);
    expect(GOV_ROLE_RANK.platform_admin).toBeLessThan(GOV_ROLE_RANK.platform_owner);
  });
});

describe('refusals name the right reason', () => {
  it('distinguishes not-authenticated from no-role from capability-missing', () => {
    expect(authorizeGov(null, 'org.view', {}).code).toBe('not-authenticated');
    expect(authorizeGov(actor('none'), 'org.view', {}).code).toBe('no-governance-role');
    expect(authorizeGov(actor('support'), 'org.suspend', { orgId: ORG_A }).code).toBe('capability-missing');
  });

  it('always gives a sentence a person can act on', () => {
    const d = authorizeGov(actor('support'), 'retention.edit', { orgId: ORG_A });
    expect(d.allowed).toBe(false);
    expect(d.reason.length).toBeGreaterThan(20);
  });
});

describe('two-person control', () => {
  it('requires a second person for content approval and organization deletion, and nothing else', () => {
    expect(requiresSecondPerson('support.content.approve')).toBe(true);
    expect(requiresSecondPerson('org.delete')).toBe(true);
    expect(requiresSecondPerson('org.suspend')).toBe(false);
    expect(requiresSecondPerson('export.request')).toBe(false);
  });
});

describe('membership mapping', () => {
  it('maps owner and admin to an organization administrator', () => {
    expect(govRoleForMembership('owner')).toBe('org_admin');
    expect(govRoleForMembership('admin')).toBe('org_admin');
  });

  it('maps analyst to a read-only auditor', () => {
    expect(govRoleForMembership('analyst')).toBe('auditor');
  });

  it('gives member and service NO console access — a membership is not an administrative grant', () => {
    expect(govRoleForMembership('member')).toBe('none');
    expect(govRoleForMembership('service')).toBe('none');
    expect(govRoleForMembership(null)).toBe('none');
    expect(govRoleForMembership('something-new')).toBe('none');
  });

  it('treats only an active membership as usable', () => {
    expect(membershipIsActive('active')).toBe(true);
    for (const s of ['suspended', 'disabled', 'removed', '', null, undefined]) {
      expect(membershipIsActive(s as any)).toBe(false);
    }
  });
});
