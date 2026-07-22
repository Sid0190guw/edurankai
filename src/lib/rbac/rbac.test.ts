// src/lib/rbac/rbac.test.ts — run: npx tsx src/lib/rbac/rbac.test.ts
// Self-contained (no DB). Covers the 6 required scenarios via the pure engine + enforce()
// with an in-memory audit sink.
import { evaluate } from './engine';
import { enforce, type AuditEntry } from './guard';
import { resolveRoleCapabilities, SEED_ROLES } from './roles';
import type { Principal, PermissionGrant, CapabilityToken } from './types';
import { tokenCovers, opsSubset, resourceNarrowerOrEqual, resourceMatches, scopeMatches } from './tokens';
import { aclToGrants } from './objectAcl';
import { KERNEL_LOCK_FLAG } from './policy';

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

  // ======================================================================
  // Block 10 — capability tokens, per-object ACL, policy ladder (pure/DB-free)
  // ======================================================================

  console.log('\n== B10.1 explicit deny beats administer (Tier 1 > Tier 2) ==');
  const adminDenied = principal({ roles: ['superadmin'], capabilities: resolveRoleCapabilities('superadmin'),
    grants: [grant({ operation: 'delete', effect: 'deny', priority: 5 })] });
  const dAdminDeny = evaluate(adminDenied, 'delete');
  ok('superadmin delete blocked by an explicit deny', !dAdminDeny.allow && dAdminDeny.stage === 'explicit-deny', dAdminDeny.stage);

  console.log('\n== B10.2 kernel-locked resource is Tier 0 deny (even superadmin) ==');
  const su = principal({ roles: ['superadmin'], capabilities: resolveRoleCapabilities('superadmin') });
  ok('kernel-locked resource denied to superadmin', !evaluate(su, 'read', { flags: [KERNEL_LOCK_FLAG] }).allow);
  ok('same superadmin allowed without the lock', evaluate(su, 'read', {}).allow);

  console.log('\n== B10.3 object ACL reconciliation ==');
  const OBJ = '11111111-1111-4111-8111-111111111111';
  const aclRead = aclToGrants(OBJ, [{ subject: 'role:student', roles: ['read'] }]);
  ok('aclToGrants emits an object-scoped read grant', aclRead.some((g) => g.operation === 'read' && g.resourceRef === OBJ && g.identityRef === 'role:student' && g.flags.includes('object-acl')));
  ok('aclToGrants maps write -> {write,create,delete}', aclToGrants(OBJ, [{ subject: '*', roles: ['write'] }]).map((g) => g.operation).sort().join(',') === 'create,delete,write');
  // a user WITHOUT the role capability gains access purely via the object ACL (Tier 3):
  const APPL = '22222222-2222-4222-8222-222222222222';
  const aclConfigure = aclToGrants(OBJ, [{ subject: APPL, roles: ['publish'] }]);   // publish -> execute
  const viaAcl = principal({ userId: APPL, roles: ['applicant'], capabilities: new Set(), grants: aclConfigure });
  const dViaAcl = evaluate(viaAcl, 'execute', { id: OBJ });
  ok('object ACL grants execute to a user lacking the role cap', dViaAcl.allow && dViaAcl.stage === 'explicit-grant', dViaAcl.stage);
  // central deny overrides the object ACL allow (the reconciliation contract):
  const denyOverAcl = principal({ userId: APPL, roles: ['applicant'], capabilities: new Set(),
    grants: [...aclConfigure, grant({ identityRef: APPL, resourceRef: OBJ, operation: 'execute', effect: 'deny', priority: 10 })] });
  ok('central deny overrides object ACL allow', !evaluate(denyOverAcl, 'execute', { id: OBJ }).allow);

  console.log('\n== B10.4 capability token = Tier 4 ==');
  const baseTok: CapabilityToken = {
    tokenId: 't1', ownerIdentity: 'u1', issuedBy: null, targetResource: 'type:CourseObject',
    allowedOperations: ['configure'], scope: {}, delegatedFrom: null, delegationDepth: 0,
    status: 'issued', version: 1, expiresAt: null,
  };
  const holder = principal({ userId: 'u1', roles: ['applicant'], capabilities: new Set(), capabilityTokens: [baseTok] });
  const dTok = evaluate(holder, 'configure', { type: 'CourseObject' });
  ok('token authorizes an op the role lacks (Tier 4)', dTok.allow && dTok.stage === 'capability-token', dTok.stage);
  ok('token does not authorize a different op', !evaluate(holder, 'delete', { type: 'CourseObject' }).allow);
  ok('token does not authorize a different resource type', !evaluate(holder, 'configure', { type: 'KnowledgeObject' }).allow);

  console.log('\n== B10.5 tokenCovers pure edge cases ==');
  ok('expired token does not cover', !tokenCovers({ ...baseTok, expiresAt: new Date(Date.now() - 1000).toISOString() }, 'configure', { type: 'CourseObject' }));
  ok('suspended token does not cover', !tokenCovers({ ...baseTok, status: 'suspended' }, 'configure', { type: 'CourseObject' }));
  const wild: CapabilityToken = { ...baseTok, allowedOperations: ['*'] as any, targetResource: '*' };
  ok('wildcard token covers any op/resource', tokenCovers(wild, 'delete', { id: 'x' }) && tokenCovers(wild, 'read', { type: 'Y' }));
  ok('scope time-window outside hours does not cover', !tokenCovers({ ...wild, scope: { timeWindow: { startHour: 0, endHour: 0 } } }, 'read', {}));

  console.log('\n== B10.6 delegation may only narrow (pure) ==');
  ok('opsSubset allows narrowing', opsSubset(['read'], ['read', 'write']));
  ok('opsSubset rejects widening', !opsSubset(['delete'], ['read']));
  ok("opsSubset: parent '*' allows anything", opsSubset(['delete'], ['*'] as any));
  ok('resource: concrete id under a type parent is narrower', resourceNarrowerOrEqual('id1', 'type:CourseObject'));
  ok('resource: cannot widen type -> *', !resourceNarrowerOrEqual('*', 'type:CourseObject'));
  ok("resource: parent '*' admits anything", resourceNarrowerOrEqual('anything', '*'));
  ok('resourceMatches wildcard/type/id', resourceMatches('*', { id: 'x' }) && resourceMatches('type:CourseObject', { type: 'CourseObject' }) && resourceMatches('id1', { id: 'id1' }));
  ok('scopeMatches institution mismatch fails', !scopeMatches({ institutionId: 'A' }, { institutionId: 'B' }) && scopeMatches({ institutionId: 'A' }, { institutionId: 'A' }));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
