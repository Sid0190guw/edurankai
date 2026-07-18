// src/lib/rbac/rbac-ui.test.ts — run: npx tsx src/lib/rbac/rbac-ui.test.ts
// Prompt 2b UI/route logic, DB-free. Covers the required 2b scenarios against the SAME pure
// engine + roster the pages use: admin gate denies non-admins; assigning a role grants its
// caps immediately; seeding is idempotent (data-level); a guardian link clears the minor
// block; and the "your access" summary reflects real roles/caps.
import { evaluate } from './engine';
import { resolveRoleCapabilities, SEED_ROLES } from './roles';
import { CORE_CAPABILITIES, type Capability } from './capabilities';
import { accessSummary } from './access';
import type { Principal } from './types';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

function capsFor(keys: string[]): Set<Capability> {
  const s = new Set<Capability>();
  for (const k of keys) for (const c of resolveRoleCapabilities(k)) s.add(c);
  return s;
}
function principal(roles: string[], over: Partial<Principal> = {}): Principal {
  return { userId: 'u1', sessionValid: true, roles, capabilities: capsFor(roles), ...over };
}

function main() {
  // The gate the /admin/rbac page + API use: can(user, 'manage', { type:'rbac' }).
  console.log('\n== 1. a non-admin is denied the admin gate (server-side) ==');
  ok('applicant denied manage:rbac', !evaluate(principal(['applicant']), 'manage', { type: 'rbac' }).allow);
  ok('plain student denied manage:rbac', !evaluate(principal(['student']), 'manage', { type: 'rbac' }).allow);
  ok('superadmin allowed manage:rbac', evaluate(principal(['superadmin']), 'manage', { type: 'rbac' }).allow);
  ok('registrar allowed manage:rbac', evaluate(principal(['registrar']), 'manage', { type: 'rbac' }).allow);

  console.log('\n== 2. assigning a role grants its capabilities immediately ==');
  const before = principal(['applicant']);
  ok('applicant cannot create (before)', !evaluate(before, 'create').allow);
  const after = principal(['applicant', 'faculty']);   // registrar assigns faculty
  ok('can create right after faculty assigned', evaluate(after, 'create').allow);
  ok('new cap set includes faculty own+inherited', after.capabilities.has('create') && after.capabilities.has('write') && after.capabilities.has('read'));

  console.log('\n== 3. seeding is idempotent (data-level: no duplicate keys to re-insert) ==');
  const roleKeys = SEED_ROLES.map((r) => r.key);
  ok('role keys are unique', new Set(roleKeys).size === roleKeys.length, roleKeys.length);
  ok('capability keys are unique', new Set(CORE_CAPABILITIES).size === CORE_CAPABILITIES.length, CORE_CAPABILITIES.length);
  // every role capability is a known capability (so ON CONFLICT targets are stable)
  const unknown = SEED_ROLES.flatMap((r) => r.capabilities).filter((c) => !(CORE_CAPABILITIES as readonly string[]).includes(c));
  ok('every seeded role cap is a registered capability', unknown.length === 0, unknown);

  console.log('\n== 4. linking a guardian clears the minor block ==');
  const minorNoG = principal(['student'], { stage: 'primary', hasGuardian: false });
  ok('minor without guardian blocked from sensitive action', !evaluate(minorNoG, 'execute', {}, { sensitive: true }).allow);
  const minorWithG = principal(['student'], { stage: 'primary', hasGuardian: true });
  ok('same minor allowed once a guardian is linked', evaluate(minorWithG, 'execute', {}, { sensitive: true }).allow);

  console.log('\n== 5. "your access" summary reflects real roles/caps ==');
  const s = accessSummary(minorNoG);
  ok('summary lists the student role', s.roles.includes('student'));
  ok('summary reports the minor stage', s.stage === 'primary' && s.isMinor);
  ok('summary flags needsGuardian for an unlinked minor', s.needsGuardian === true);
  ok('summary clears needsGuardian once linked', accessSummary(minorWithG).needsGuardian === false);
  const sf = accessSummary(principal(['faculty']));
  ok('faculty summary surfaces create + human label', sf.capabilities.some((c) => c.key === 'create' && !!c.label));
  ok('superadmin summary flagged', accessSummary(principal(['superadmin'])).isSuperadmin === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
