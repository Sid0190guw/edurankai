// src/lib/rbac/objectAcl.ts — Block 10: make kernel_objects.permissions[] (per-object ACLs)
// actually enforced. Translates an object's ACL entries into eval-time PermissionGrants scoped
// to that object id, resolves cascade grants from part_of ancestors, and offers canObject() —
// a guard that evaluates a full KernelObject through the same policy ladder as central grants.
import type { PermissionGrant, ResourceRef, EvalContext, Decision } from './types';
import type { Capability } from './capabilities';
import type { KernelObject } from '@/lib/kernel/types';
import { MAX_INHERITANCE_DEPTH } from './policy';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

export interface ObjectAclEntry { subject: string; roles: ('read' | 'write' | 'publish')[]; }

// kernel ACL roles (read|write|publish) -> engine capabilities. `publish` maps to `execute`
// (see Block 10 §7 — a documented assumption; register a first-class 'publish' capability to change it).
const ACL_ROLE_TO_OPS: Record<'read' | 'write' | 'publish', Capability[]> = {
  read: ['read'],
  write: ['write', 'create', 'delete'],
  publish: ['execute'],
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compile an object's permissions[] into eval-time allow-grants scoped to THAT object id. Pure. */
export function aclToGrants(objectId: string, acl: ObjectAclEntry[]): PermissionGrant[] {
  const grants: PermissionGrant[] = [];
  for (const entry of acl ?? []) {
    const subject = entry.subject;
    const identityRef = subject === '*' ? '*'
      : subject.startsWith('role:') ? subject
      : UUID_RE.test(subject) ? subject
      : `role:${subject}`;
    const ops = new Set<Capability>();
    for (const r of entry.roles ?? []) for (const op of ACL_ROLE_TO_OPS[r] ?? []) ops.add(op);
    for (const op of ops) {
      grants.push({
        permissionId: `acl:${objectId}:${subject}:${op}`,
        identityRef, resourceRef: objectId, operation: op,
        effect: 'allow', state: 'activated', inheritancePolicy: 'none',
        conditions: {}, priority: 5, version: 1, flags: ['object-acl'],
      });
    }
  }
  return grants;
}

/** Resolve grants inherited from ancestors via `part_of` edges (BFS up, cascade + ancestor ACLs). */
export async function resolveInheritedGrants(objectId: string): Promise<PermissionGrant[]> {
  const inherited: PermissionGrant[] = [];
  try {
    const { db, sql } = await ctx();
    let frontier = [objectId];
    const seen = new Set([objectId]);
    for (let depth = 0; depth < MAX_INHERITANCE_DEPTH && frontier.length; depth++) {
      const parents = rows(await db.execute(sql`SELECT to_id FROM kernel_edges WHERE from_id = ANY(${frontier as any}) AND type = 'part_of'`))
        .map((r: any) => r.to_id).filter((pid: string) => !seen.has(pid));
      const next: string[] = [];
      for (const pid of parents) {
        seen.add(pid); next.push(pid);
        // central grants on the ancestor marked cascade -> re-pointed at the descendant, one tier lower.
        const g = rows(await db.execute(sql`SELECT * FROM rbac_permission_grants WHERE resource_ref = ${pid} AND inheritance_policy = 'cascade'`));
        for (const r of g) {
          inherited.push({
            permissionId: r.permission_id, identityRef: r.identity_ref, resourceRef: objectId, operation: r.operation,
            effect: r.effect, state: 'inherited', inheritancePolicy: 'cascade',
            conditions: r.conditions ?? {}, priority: Math.max(0, Number(r.priority) - 1),
            version: Number(r.version), flags: [...(r.flags ?? []), 'inherited'],
          });
        }
        // ancestor ACLs also cascade down (as inherited-tier allows).
        const ao = rows(await db.execute(sql`SELECT permissions FROM kernel_objects WHERE id = ${pid} LIMIT 1`))[0];
        for (const ag of aclToGrants(objectId, (ao?.permissions ?? []) as ObjectAclEntry[])) {
          inherited.push({ ...ag, state: 'inherited', priority: 3, flags: [...ag.flags, 'inherited'] });
        }
      }
      frontier = next;
    }
  } catch { /* cold/unreachable DB -> no inherited grants */ }
  return inherited;
}

/** Guard: evaluate a capability against a full KernelObject (central grants + object ACL + cascade). */
export async function canObject(user: unknown, cap: string, obj: KernelObject, ctx?: EvalContext): Promise<Decision> {
  const { resolvePrincipal, writeAudit } = await import('./store');
  const { enforce } = await import('./guard');
  const p = await resolvePrincipal(user);
  const aclGrants = aclToGrants(obj.id, (obj.permissions ?? []) as ObjectAclEntry[]);
  const inherited = await resolveInheritedGrants(obj.id);
  const merged = { ...p, grants: [...(p.grants ?? []), ...aclGrants, ...inherited] };
  const res: ResourceRef = {
    id: obj.id, type: obj.type, ownerId: obj.owner,
    securityLabels: obj.securityLabels, state: obj.lifecycleState,
  };
  return enforce(merged, cap as Capability, res, ctx ?? {}, writeAudit);
}
