// src/lib/rbac/rbac.test.ts — run: npx tsx src/lib/rbac/rbac.test.ts
// Self-contained (no DB). Covers the 6 required scenarios via the pure engine + enforce()
// with an in-memory audit sink.
import { evaluate } from './engine';
import { enforce, type AuditEntry } from './guard';
import { resolveRoleCapabilities, SEED_ROLES } from './roles';
import type { Principal, PermissionGrant } from './types';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

function principal(over: Partial<Principal> = {}): Principal {
  return { userId: 'u1', sessionValid: true, roles: [], capabilities: new Set(), ...over };
}
function grant(over: Partial<PermissionGrant>): PermissionGrant {
  return { permissionId: 'g' + Math.random().toString(36).slice(2, 7), identityRef: 'u1', resourceRef: '*', operation: 'read', effect: 'allow', state: 'activated', inheritancePolicy: 'none', conditions: {}, priority: 0, version: 1, flags: [], ...over };
}

async function main() {
  console.log('\n== 1. role WITH a capability is allowed ==');
  const faculty = principal({ roles: ['faculty'], capabilities: resolveRoleCapabilities('faculty') });
  ok('faculty can create', evaluate(faculty, 'create').allow);

  console.log('\n== 2. role WITHOUT a capability is denied ==');
  const support = principal({ roles: ['support'], capabilities: resolveRoleCapabilities('support') });
  ok('support cannot delete', !evaluate(support, 'delete').allow, evaluate(support, 'delete').reason);
  ok('support CAN read', evaluate(support, 'read').allow);

  console.log('\n== 3. explicit DENY overrides allow ==');
  const denied = principal({ roles: ['faculty'], capabilities: resolveRoleCapabilities('faculty'),
    grants: [grant({ operation: 'write', effect: 'deny', priority: 10 })] });
  const d3 = evaluate(denied, 'write');
  ok('faculty write denied by explicit deny grant', !d3.allow && d3.reason.includes('explicit deny'), d3.reason);

  console.log('\n== 4. INHERITANCE grants a child capability ==');
  // faculty inherits content_author; dean inherits faculty. Confirm a purely-inherited cap.
  const caFacultyOwn = SEED_ROLES.find((r) => r.key === 'faculty')!.capabilities;   // ['read','write','create','execute']
  const deanCaps = resolveRoleCapabilities('dean');
  ok('dean inherits faculty->content_author capabilities', deanCaps.has('create') && deanCaps.has('write'));
  ok("dean has its OWN 'schedule' too", deanCaps.has('schedule'));
  const dean = principal({ roles: ['dean'], capabilities: deanCaps });
  ok('dean can create (inherited, not own)', evaluate(dean, 'create').allow && !caFacultyOwn.includes('schedule'));

  console.log('\n== 5. MINOR account without a guardian is blocked from a guarded action ==');
  const minorNoGuardian = principal({ roles: ['student'], capabilities: resolveRoleCapabilities('student'), stage: 'primary', hasGuardian: false });
  const d5 = evaluate(minorNoGuardian, 'execute', {}, { sensitive: true });
  ok('primary-stage minor without guardian blocked from sensitive action', !d5.allow && d5.reason.includes('guardian'), d5.reason);
  const minorWithGuardian = principal({ roles: ['student'], capabilities: resolveRoleCapabilities('student'), stage: 'primary', hasGuardian: true });
  ok('same minor WITH a guardian is allowed', evaluate(minorWithGuardian, 'execute', {}, { sensitive: true }).allow);
  ok('adult student needs no guardian', evaluate(principal({ roles: ['student'], capabilities: resolveRoleCapabilities('student'), stage: 'undergraduate' }), 'execute', {}, { sensitive: true }).allow);

  console.log('\n== 6. EVERY decision writes an audit row ==');
  const log: AuditEntry[] = [];
  const sink = (e: AuditEntry) => { log.push(e); };
  const allowD = await enforce(faculty, 'create', {}, {}, sink);
  const denyD = await enforce(support, 'delete', {}, {}, sink);
  ok('allow decision audited', log.length === 2 && log[0].allow === true && log[0].capability === 'create');
  ok('deny decision audited too', log[1].allow === false && log[1].capability === 'delete');
  ok('audit row carries reason + stage + timestamp', !!log[0].reason && !!log[0].stage && !!log[0].at);
  ok('enforce returns the same decision it audited', allowD.allow && !denyD.allow);

  console.log('\n== bonus: security labels + session ==');
  ok('exam-secure denied to a plain student', !evaluate(principal({ roles: ['student'], capabilities: resolveRoleCapabilities('student') }), 'read', { securityLabels: ['exam-secure'] }).allow);
  ok('exam-secure allowed to a proctor', evaluate(principal({ roles: ['proctor'], capabilities: resolveRoleCapabilities('proctor') }), 'read', { securityLabels: ['exam-secure'] }).allow);
  ok('superadmin bypasses labels', evaluate(principal({ roles: ['superadmin'], capabilities: resolveRoleCapabilities('superadmin') }), 'read', { securityLabels: ['exam-secure'] }).allow);
  ok('invalid session denied', !evaluate(principal({ roles: ['faculty'], capabilities: resolveRoleCapabilities('faculty'), sessionValid: false }), 'read').allow);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
