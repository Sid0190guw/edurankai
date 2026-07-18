// src/lib/rbac/guard.ts — enforcement. `enforce()` is the testable core: evaluate + audit
// with an injectable sink. `can()` / `requireCapability()` / `requireAdminRole()` are the
// DB-facing helpers every protected Astro endpoint/page uses (they resolve the principal
// from the existing auth `locals.user` and write the audit row).
import { evaluate } from './engine';
import { ADMIN_ROLE_KEYS } from './roles';
import type { Capability } from './capabilities';
import type { Principal, ResourceRef, EvalContext, Decision } from './types';

export interface AuditEntry {
  userId: string | null;
  capability: Capability;
  resource: string;
  allow: boolean;
  reason: string;
  stage: string;
  matchedGrant: string | null;
  context: Record<string, unknown>;
  at: string;
}
export type AuditSink = (e: AuditEntry) => void | Promise<void>;

/** Evaluate a decision and write EXACTLY ONE audit row for it. Pure engine + injectable sink. */
export async function enforce(p: Principal, cap: Capability, res: ResourceRef, ctx: EvalContext, audit: AuditSink): Promise<Decision> {
  const d = evaluate(p, cap, res, ctx);
  await audit({
    userId: p.userId, capability: cap, resource: d.resource, allow: d.allow, reason: d.reason,
    stage: d.stage, matchedGrant: d.matchedGrant ?? null,
    context: { type: res.type ?? null, securityLabels: res.securityLabels ?? null, sensitive: !!ctx.sensitive, institutionId: ctx.institutionId ?? null },
    at: new Date().toISOString(),
  });
  return d;
}

export class ForbiddenError extends Error {
  constructor(public decision: Decision) { super(`forbidden: ${decision.reason}`); this.name = 'ForbiddenError'; }
}

// ---- DB-facing helpers (resolve principal from the existing auth user; audit to DB) ----
export async function can(user: any, cap: Capability, res: ResourceRef = {}, ctx: EvalContext = {}): Promise<Decision> {
  const { resolvePrincipal, writeAudit } = await import('./store');
  const p = await resolvePrincipal(user);
  return enforce(p, cap, res, ctx, writeAudit);
}
/** Throws ForbiddenError when denied (for endpoints/actions). */
export async function requireCapability(user: any, cap: Capability, res: ResourceRef = {}, ctx: EvalContext = {}): Promise<Decision> {
  const d = await can(user, cap, res, ctx);
  if (!d.allow) throw new ForbiddenError(d);
  return d;
}
/** True if the user holds ANY admin-surface role (or superadmin). Audited via can('read'). */
export async function requireAdminRole(user: any): Promise<boolean> {
  const { resolvePrincipal, writeAudit } = await import('./store');
  const p = await resolvePrincipal(user);
  const isAdmin = p.roles.some((r) => ADMIN_ROLE_KEYS.includes(r));
  await writeAudit({
    userId: p.userId, capability: 'read', resource: 'admin:surface', allow: isAdmin,
    reason: isAdmin ? 'holds an admin-surface role' : 'no admin-surface role', stage: 'verify-authorization',
    matchedGrant: null, context: { roles: p.roles }, at: new Date().toISOString(),
  });
  return isAdmin;
}
