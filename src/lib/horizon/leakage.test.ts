// src/lib/horizon/leakage.test.ts — PATCH 19. FLOWS 11-15, TESTED BY TRYING TO BREAK THEM.
//
// =================================================================================================
// THE QUESTION THIS SUITE ASKS
// =================================================================================================
//
// Not "can the founder open the founder screen" — that is the easy direction and it is already
// tested by whoever owns each screen. The question here is the other one: WHAT DOES EACH VIEWER
// CLASS GET THAT IT SHOULD NOT, and do the three separate authorization mechanisms in this codebase
// still answer it the same way.
//
// THERE ARE THREE, AND THAT IS THE RISK:
//
//   src/lib/auth/permissions.ts   can()             pure, over the compiled PERMS_BY_ROLE matrix
//   src/lib/auth/capability.ts    holdsCapability() the same matrix, reached through a narrower user
//   src/lib/rbac/engine.ts        evaluate()        a six-tier grant engine with explicit DENY
//
// They are not redundant — they answer about different populations, and auth/capability.ts says so
// in its own comments — but every one of them is a door into the same data. A test that only drove
// one of them would pass while another was wide open.
//
// NOTHING HERE OPENS A DATABASE. Every function under test is pure or takes its context as an
// argument, which is why they are the ones worth driving hardest.
import { describe, it, expect } from 'vitest';

import { can, PERMS_BY_ROLE, type Permission } from '@/lib/auth/permissions';
import { holdsCapability, rolesHolding, decidesEveryRequest, leadsDepartment, APPROVAL_CAPABILITIES } from '@/lib/auth/capability';
import { evaluate } from '@/lib/rbac/engine';
import type { Principal, PermissionGrant, ResourceRef } from '@/lib/rbac/types';
import { ADMINISTER } from '@/lib/rbac/capabilities';
import { visibleEmployeeIds, type PerfViewer } from '@/lib/performance-scope';
import { VIEWER_CLASSES } from '@/lib/horizon/contract';

// -------------------------------------------------------------------------------------------------
// FIXTURES. Deliberately minimal: a fixture that carries more than the function reads is a fixture
// that hides which field the decision actually turned on.
// -------------------------------------------------------------------------------------------------

const userWithRole = (role: string | null, isActive = true) =>
  (role === null ? null : ({ id: 'u1', role, isActive } as any));

const ROLE_KEYS = Object.keys(PERMS_BY_ROLE) as (keyof typeof PERMS_BY_ROLE)[];

/** Every permission any role holds, so the cross-engine comparison covers the whole matrix. */
const ALL_PERMISSIONS: Permission[] = Array.from(
  new Set(ROLE_KEYS.flatMap((r) => PERMS_BY_ROLE[r] as Permission[])),
).sort() as Permission[];

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 'u1',
  sessionValid: true,
  roles: ['reviewer'],
  capabilities: new Set(['read']),
  ...over,
});

const grant = (over: Partial<PermissionGrant> = {}): PermissionGrant => ({
  permissionId: 'g1',
  identityRef: '*',
  resourceRef: '*',
  operation: 'read',
  effect: 'allow',
  state: 'activated',
  inheritancePolicy: 'none',
  conditions: {},
  priority: 1,
  version: 1,
  flags: [],
  ...over,
});

// -------------------------------------------------------------------------------------------------
// FLOWS 12-15. THE ROLE MATRIX, ASSERTED IN BOTH DIRECTIONS.
// -------------------------------------------------------------------------------------------------

describe('flows 12-15: every viewer class holds what it must and nothing it must not', () => {
  for (const viewer of VIEWER_CLASSES) {
    it(`${viewer.label} holds every capability its surfaces need`, () => {
      const user = userWithRole(viewer.role);
      for (const key of viewer.mustHold) {
        expect({ viewer: viewer.key, key, holds: can(user, key as Permission) })
          .toEqual({ viewer: viewer.key, key, holds: true });
      }
    });

    it(`${viewer.label} holds NONE of the capabilities that would widen it`, () => {
      const user = userWithRole(viewer.role);
      for (const key of viewer.mustNotHold) {
        expect({ viewer: viewer.key, key, holds: can(user, key as Permission) })
          .toEqual({ viewer: viewer.key, key, holds: false });
      }
    });
  }

  it('gives an applicant account no admin capability of any kind', () => {
    // FLOW 15. The floor of the whole system: the account class every employee-facing surface is
    // reached from must hold nothing that opens an admin door.
    const user = userWithRole('applicant');
    for (const key of ALL_PERMISSIONS) {
      expect({ key, holds: can(user, key) }).toEqual({ key, holds: false });
    }
  });

  it('gives a caller with no session nothing at all', () => {
    for (const key of ALL_PERMISSIONS) {
      expect({ key, holds: can(null, key) }).toEqual({ key, holds: false });
      expect({ key, holds: holdsCapability(null, key) }).toEqual({ key, holds: false });
    }
  });

  it('gives a DEACTIVATED account nothing, whatever its role says', () => {
    // The one field that is not a role. A deactivated super_admin must be a deactivated account.
    const dead = userWithRole('super_admin', false);
    for (const key of ALL_PERMISSIONS) {
      expect({ key, holds: can(dead, key) }).toEqual({ key, holds: false });
      expect({ key, holds: holdsCapability({ role: 'super_admin', isActive: false }, key) })
        .toEqual({ key, holds: false });
    }
  });

  it('gives an unknown role nothing, rather than defaulting to something', () => {
    // A role outside the matrix (a partner scope, a typo, a role a migration invented) must fall to
    // nothing. Defaulting the other way is how a console opens itself to everybody.
    for (const key of ALL_PERMISSIONS) {
      expect({ key, holds: can(userWithRole('not_a_real_role'), key) }).toEqual({ key, holds: false });
    }
  });
});

describe('the two matrix entry points can never answer differently', () => {
  it('agrees on every role and every permission in the matrix', () => {
    // can() takes a User; holdsCapability() takes anything carrying a role, trims and lowercases it,
    // and reads isActive as "not explicitly false". Those two adaptations are the only differences
    // there may ever be, and this asserts they change nothing for a well-formed account.
    for (const role of ROLE_KEYS) {
      for (const key of ALL_PERMISSIONS) {
        const a = can(userWithRole(String(role)), key);
        const b = holdsCapability({ role: String(role), isActive: true }, key);
        expect({ role, key, a, b }).toEqual({ role, key, a, b: a });
      }
    }
  });

  it('reads a role with surrounding whitespace and casing as the same role', () => {
    expect(holdsCapability({ role: '  SUPER_ADMIN ' }, 'admin.access')).toBe(true);
    expect(holdsCapability({ role: 'Department_Head' }, 'department.lead')).toBe(true);
  });

  it('treats an absent isActive as active, so a narrow caller keeps the access it had', () => {
    expect(holdsCapability({ role: 'hr' }, 'employee.manage')).toBe(true);
    expect(holdsCapability({ role: 'hr', isActive: null }, 'employee.manage')).toBe(true);
    expect(holdsCapability({ role: 'hr', isActive: false }, 'employee.manage')).toBe(false);
  });
});

describe('flow 14: the approval and lead rules, which are the widest policy in this area', () => {
  it('names exactly the roles that lead a department, and the SQL fragment reads the same list', () => {
    // src/lib/employee-tasks.ts builds its IN (...) list from rolesHolding('department.lead'). If a
    // role were added to that capability, this fragment would silently widen who reads every task
    // row in a department. Pinned so the widening is a failing test rather than a discovery.
    expect(rolesHolding('department.lead')).toEqual(['department_head']);
  });

  it('does not make the founder a department lead', () => {
    // department.lead is a SCOPE, not a rank. requireTeamLead() refuses super_admin today.
    expect(leadsDepartment({ role: 'super_admin' }, null)).toBe(false);
    expect(can(userWithRole('super_admin'), 'department.lead')).toBe(false);
  });

  it('refuses an INTERN the lead power even when the role holds it', () => {
    expect(leadsDepartment({ role: 'department_head' }, { isIntern: false })).toBe(true);
    expect(leadsDepartment({ role: 'department_head' }, null)).toBe(true);
    expect(leadsDepartment({ role: 'department_head' }, { isIntern: true })).toBe(false);
  });

  it('lets HR and the founder decide every request, and a department head decide none by capability', () => {
    expect(decidesEveryRequest({ role: 'super_admin' })).toBe(true);
    expect(decidesEveryRequest({ role: 'hr' })).toBe(true);
    // A department head decides their own reportees' requests by RELATIONSHIP, resolved per row.
    // No capability may stand in for that, and this asserts none does.
    expect(decidesEveryRequest({ role: 'department_head' })).toBe(false);
    expect(decidesEveryRequest({ role: 'applicant' })).toBe(false);
    for (const capability of APPROVAL_CAPABILITIES) {
      expect(decidesEveryRequest({ role: 'department_head' }, capability)).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// THE GRANT ENGINE. SIX TIERS, AND EVERY ONE OF THEM IS A DOOR.
// -------------------------------------------------------------------------------------------------

describe('flow 12: the capability engine fails closed on every tier-0 condition', () => {
  it('refuses a principal with no identity', () => {
    const d = evaluate({ } as unknown as Principal, 'read');
    expect(d.allow).toBe(false);
    expect(d.stage).toBe('kernel-policy');
  });

  it('refuses a signed-out principal even when the role would allow it', () => {
    const d = evaluate(principal({ sessionValid: false, capabilities: new Set(['read']) }), 'read');
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('session invalid or expired');
  });

  it('refuses when the permission context could not be resolved, rather than shrinking to a role', () => {
    // THE FAIL-OPEN THIS PREVENTS: losing an allow on a failed read is harmless; losing a DENY grant
    // means a principal whose access had been narrowed is evaluated as though it never was.
    const d = evaluate(principal({ contextDegraded: true, capabilities: new Set([ADMINISTER]) }), 'read');
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('permission context could not be resolved');
  });

  it('refuses a capability nobody registered, instead of treating it as open', () => {
    const d = evaluate(principal({ capabilities: new Set([ADMINISTER]) }), 'horizon-patch-19-not-a-capability');
    expect(d.allow).toBe(false);
    expect(d.stage).toBe('kernel-policy');
  });

  it('refuses a kernel-locked resource to the administrator as well', () => {
    const d = evaluate(principal({ capabilities: new Set([ADMINISTER]) }), 'write', { flags: ['kernel-locked'] });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('resource is kernel-locked');
  });
});

describe('flow 12: an explicit deny outranks the administrator', () => {
  it('denies a superadmin holding a matching deny grant', () => {
    const d = evaluate(
      principal({
        capabilities: new Set([ADMINISTER]),
        grants: [grant({ effect: 'deny', operation: 'read', permissionId: 'deny-1' })],
      }),
      'read',
    );
    expect(d.allow).toBe(false);
    expect(d.stage).toBe('explicit-deny');
    expect(d.matchedGrant).toBe('deny-1');
  });

  it('ignores a deny grant that is not live', () => {
    // A revoked or draft grant must not keep denying. `state` is the lifecycle, and only three
    // states participate.
    const d = evaluate(
      principal({
        capabilities: new Set([ADMINISTER]),
        grants: [grant({ effect: 'deny', state: 'revoked' })],
      }),
      'read',
    );
    expect(d.allow).toBe(true);
    expect(d.stage).toBe('administrative-override');
  });

  it('does not let a deny aimed at another user or another resource reach this one', () => {
    const other = evaluate(
      principal({ capabilities: new Set(['read']), grants: [grant({ effect: 'deny', identityRef: 'someone-else' })] }),
      'read',
    );
    expect(other.allow).toBe(true);
    const elsewhere = evaluate(
      principal({ capabilities: new Set(['read']), grants: [grant({ effect: 'deny', resourceRef: 'type:Other' })] }),
      'read',
      { type: 'Person' },
    );
    expect(elsewhere.allow).toBe(true);
  });
});

describe('flow 12: the constraints that apply to every non-admin allow', () => {
  it('refuses an exam-secure resource to a role the label does not admit', () => {
    const d = evaluate(
      principal({ roles: ['student'], capabilities: new Set(['read']) }),
      'read',
      { securityLabels: ['exam-secure'] } as ResourceRef,
    );
    expect(d.allow).toBe(false);
    expect(d.stage).toBe('apply-constraints');
  });

  it('refuses an UNKNOWN security label to everybody except the administrator', () => {
    // The default arm of labelAdmits(). A label nobody has taught the engine about must close, not
    // open — a new classification string is otherwise a hole the day it is introduced.
    const student = evaluate(
      principal({ roles: ['student'], capabilities: new Set(['read']) }),
      'read',
      { securityLabels: ['some-new-classification'] } as ResourceRef,
    );
    expect(student.allow).toBe(false);
    const admin = evaluate(
      principal({ roles: ['student'], capabilities: new Set([ADMINISTER]) }),
      'read',
      { securityLabels: ['some-new-classification'] } as ResourceRef,
    );
    expect(admin.allow).toBe(true);
  });

  it('refuses a write to somebody else’s object without `manage`', () => {
    const notOwner = evaluate(
      principal({ capabilities: new Set(['write']) }),
      'write',
      { ownerId: 'somebody-else' },
    );
    expect(notOwner.allow).toBe(false);
    expect(notOwner.reason).toBe('not owner and lacks manage');

    const owner = evaluate(principal({ capabilities: new Set(['write']) }), 'write', { ownerId: 'u1' });
    expect(owner.allow).toBe(true);
  });

  it('refuses a sensitive action to a minor account with no linked guardian', () => {
    const alone = evaluate(
      principal({ roles: ['student'], capabilities: new Set(['read']), stage: 'primary', hasGuardian: false }),
      'read',
      {},
      { sensitive: true },
    );
    expect(alone.allow).toBe(false);
    expect(alone.stage).toBe('apply-constraints');

    const withGuardian = evaluate(
      principal({ roles: ['student'], capabilities: new Set(['read']), stage: 'primary', hasGuardian: true }),
      'read',
      {},
      { sensitive: true },
    );
    expect(withGuardian.allow).toBe(true);
  });

  it('refuses everything to a principal that holds no matching capability at all', () => {
    const d = evaluate(principal({ capabilities: new Set([]) }), 'delete');
    expect(d.allow).toBe(false);
    expect(d.stage).toBe('default-deny');
  });

  it('honours a requireOwner condition on an otherwise matching grant', () => {
    const notOwner = evaluate(
      principal({ capabilities: new Set([]), grants: [grant({ conditions: { requireOwner: true } })] }),
      'read',
      { ownerId: 'somebody-else' },
    );
    expect(notOwner.allow).toBe(false);
    const owner = evaluate(
      principal({ capabilities: new Set([]), grants: [grant({ conditions: { requireOwner: true } })] }),
      'read',
      { ownerId: 'u1' },
    );
    expect(owner.allow).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// FLOW 14 / 15. THE ROW-LEVEL SCOPE, WHICH IS WHERE A LIST QUERY LEAKS.
// -------------------------------------------------------------------------------------------------

describe('flow 14: a manager sees their team and a manager only', () => {
  const viewer = (over: Partial<PerfViewer> = {}): PerfViewer => ({
    userId: '00000000-0000-4000-8000-000000000001',
    employeeId: '11111111-1111-4111-8111-111111111111',
    fullName: 'A Manager',
    departmentId: null,
    initialized: true,
    managesOrg: false,
    reports: [],
    reportIds: [],
    reviewSubjects: [],
    kind: 'manager',
    explanation: '',
    ...over,
  });

  it('returns an explicit list containing the viewer and their reports, and nobody else', () => {
    const reportA = '22222222-2222-4222-8222-222222222222';
    const reportB = '33333333-3333-4333-8333-333333333333';
    const ids = visibleEmployeeIds(viewer({ reportIds: [reportA, reportB] }));
    expect(ids).not.toBeNull();
    expect((ids as string[]).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      reportA,
      reportB,
    ].sort());
  });

  it('returns null — no restriction — ONLY for a performance.manage holder', () => {
    expect(visibleEmployeeIds(viewer({ managesOrg: true }))).toBeNull();
    expect(visibleEmployeeIds(viewer({ managesOrg: false }))).not.toBeNull();
  });

  it('returns an EMPTY list, never null, for a viewer with no employee record', () => {
    // The dangerous confusion in this function's contract: null means "everything". A viewer the
    // system could not resolve must get [] — which callers turn into "no rows" — and never null.
    expect(visibleEmployeeIds(viewer({ employeeId: null }))).toEqual([]);
  });

  it('drops any id that is not a uuid rather than passing it into a query', () => {
    const ids = visibleEmployeeIds(viewer({ reportIds: ['ERAI-EMP-002184', 'not-a-uuid', ''] }));
    expect(ids).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('includes a review subject, because reviewing somebody is a relationship too', () => {
    const subject = '44444444-4444-4444-8444-444444444444';
    const ids = visibleEmployeeIds(viewer({ reviewSubjects: [{ employeeId: subject } as never] }));
    expect((ids as string[]).includes(subject)).toBe(true);
  });

  it('never lets a manager reach an arbitrary employee id', () => {
    const stranger = '99999999-9999-4999-8999-999999999999';
    const ids = visibleEmployeeIds(viewer({ reportIds: ['22222222-2222-4222-8222-222222222222'] }));
    expect((ids as string[]).includes(stranger)).toBe(false);
  });
});
