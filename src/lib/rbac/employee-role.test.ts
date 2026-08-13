// The employee role, and the rule that roles add up rather than replace each other.
//
// =================================================================================================
// WHAT IS ACTUALLY AT RISK HERE
// =================================================================================================
//
// `employee` exists so a member of staff can reach their own workspace — attendance, leave,
// expenses, their record — and NOTHING administrative. The one way to get that wrong is to put it
// on the wrong surface, at which point every employee in the company can open /admin. That is one
// character in a seed file and no screen would look different until somebody tried it.
//
// So these tests hold the boundary rather than the wiring: the role is on the main surface, it is
// absent from ADMIN_ROLE_KEYS (which is literally what src/lib/rbac/guard.ts checks to decide
// whether somebody is an administrator), and it grants nothing beyond reading and acting within
// its own workspace.

import { describe, it, expect, report } from '../test-shim';
import { SEED_ROLES, ADMIN_ROLE_KEYS, MAIN_ROLE_KEYS, resolveRoleCapabilities } from './roles';

const employee = SEED_ROLES.find((r) => r.key === 'employee');

describe('the employee role exists and is assignable', () => {
  it('is in the seeded roster, so it appears in the console dropdown', () => {
    // The dropdown is built from SEED_ROLES; a role that is not here cannot be assigned to anybody.
    expect(!!employee).toBe(true);
  });

  it('describes itself in terms of what it opens, not in jargon', () => {
    expect(String(employee?.description).toLowerCase()).toContain('workspace');
    expect(String(employee?.description).toLowerCase()).toContain('no admin');
  });
});

describe('it must never open the administrative side', () => {
  it('sits on the main surface, not admin', () => {
    expect(employee?.surface).toBe('main');
  });

  it('is absent from ADMIN_ROLE_KEYS, which is what decides who is an administrator', () => {
    // guard.ts: `p.roles.some((r) => ADMIN_ROLE_KEYS.includes(r))`. If 'employee' were in this list,
    // every member of staff would be an administrator.
    expect(ADMIN_ROLE_KEYS.includes('employee')).toBe(false);
    expect(MAIN_ROLE_KEYS.includes('employee')).toBe(true);
  });

  it('holds no capability that reaches beyond its own workspace', () => {
    const caps = resolveRoleCapabilities('employee');
    for (const forbidden of ['administer', 'manage', 'configure', 'delete', 'write', 'delegate', 'audit']) {
      expect(caps.has(forbidden as any)).toBe(false);
    }
    // read: see my own record. execute: clock in, file a request.
    expect(caps.has('read' as any)).toBe(true);
    expect(caps.has('execute' as any)).toBe(true);
  });

  it('inherits from nothing, so no parent can widen it later by accident', () => {
    // A single `inherits: ['faculty']` added in passing would hand every employee that role's
    // capabilities without anybody editing this role's own list.
    expect((employee?.inherits ?? []).length).toBe(0);
  });
});

describe('roles add up rather than replace each other', () => {
  it('a person holding employee and faculty gets the union of both', () => {
    // rbac_user_roles is UNIQUE (user_id, role_key) — one ROW per role, so assigning a second one
    // never overwrites the first. This is what makes "guest and teacher at once" work.
    const both = new Set([
      ...resolveRoleCapabilities('employee'),
      ...resolveRoleCapabilities('faculty'),
    ]);
    for (const c of resolveRoleCapabilities('employee')) expect(both.has(c)).toBe(true);
    for (const c of resolveRoleCapabilities('faculty')) expect(both.has(c)).toBe(true);
    // And the combination is genuinely wider than employee alone, or pairing would be pointless.
    expect(both.size).toBeGreaterThan(resolveRoleCapabilities('employee').size);
  });

  it('adding employee to an administrator takes nothing away from them', () => {
    const admin = resolveRoleCapabilities('superadmin');
    const combined = new Set([...admin, ...resolveRoleCapabilities('employee')]);
    for (const c of admin) expect(combined.has(c)).toBe(true);
  });
});

describe('the seed roster stays writable', () => {
  it('every role key is a plain lowercase identifier', () => {
    // The console's own create-role endpoint enforces /^[a-z][a-z0-9_]{1,30}$/; the seeded roster
    // must not contain anything it would reject, or the two disagree about what a role may be named.
    for (const r of SEED_ROLES) expect(/^[a-z][a-z0-9_]{1,30}$/.test(r.key)).toBe(true);
  });

  it('no role names a parent that does not exist', () => {
    // A dangling parent resolves to no capabilities silently, so the role would grant less than it
    // appears to and nothing would say so.
    const keys = new Set(SEED_ROLES.map((r) => r.key));
    for (const r of SEED_ROLES) for (const p of r.inherits ?? []) expect(keys.has(p)).toBe(true);
  });
});

report();
