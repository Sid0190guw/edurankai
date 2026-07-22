// src/lib/kernel/access.ts — Block 01 capability check. Pure, no I/O.
// Answers "may this actor perform this action on this object?" by combining the object's
// owner, its permissions[] grants (matched by actor id OR role token), and its security
// labels. The role-token format bridges to src/lib/rbac (pinned by Block 10).
import type { KernelActor, KernelEnvelope, PermissionRole } from './types';

/** True iff `actor` may perform `need` on `object`. */
export function can(actor: KernelActor, object: KernelEnvelope, need: PermissionRole): boolean {
  if (object.lifecycleState === 'deleted') return false;
  if (actor.id != null && actor.id === object.owner) return true;   // owner has all roles

  const tokens = new Set(actor.roleTokens ?? []);
  const granted = new Set<PermissionRole>();                        // union of roles from matching grants
  for (const perm of object.permissions) {
    if (perm.subject === actor.id || tokens.has(perm.subject)) {
      for (const r of perm.roles) granted.add(r);
    }
  }
  const hasExplicit = granted.has(need);

  if (need === 'read') {                                            // the security-label gate applies to reads only
    const labels = object.securityLabels;
    if (labels.includes('public')) return true;
    if (labels.includes('enrolled-only')) {
      return (actor.enrolledObjectIds ?? []).includes(object.id) || hasExplicit;
    }
    if (labels.includes('exam-secure')) return hasExplicit;        // never public
    return hasExplicit;                                            // no label => explicit grant required
  }
  return hasExplicit;                                               // write / publish always need an explicit grant
}

/** Filter a list to only the objects `actor` may `read`. */
export function readable<T extends KernelEnvelope>(actor: KernelActor, objs: T[]): T[] {
  return objs.filter((o) => can(actor, o, 'read'));
}
