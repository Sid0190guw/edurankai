// src/lib/rbac/engine.ts — the DETERMINISTIC evaluation pipeline (Spec Vol II).
// Pure and side-effect-free until the decision is returned; the audit write happens in the
// guard (store) AFTER this returns, so evaluation itself never mutates anything.
//
// Exact order:
//   Resolve Identity -> Verify Session -> Verify Authorization -> Validate Capability ->
//   Load Permission Context -> Evaluate Rules -> Apply Constraints -> Return Decision
// (Audit is the guard's responsibility.)
import { ADMINISTER, isCapability, type Capability } from './capabilities';
import { isMinorStage } from './roles';
import {
  type Principal, type ResourceRef, type EvalContext, type Decision,
  type PermissionGrant, LIVE_PERMISSION_STATES,
} from './types';

function deny(stage: string, reason: string, cap: Capability, res: string, matched?: string | null): Decision {
  return { allow: false, reason, stage, capability: cap, resource: res, matchedGrant: matched ?? null };
}
function allow(stage: string, reason: string, cap: Capability, res: string, matched?: string | null): Decision {
  return { allow: true, reason, stage, capability: cap, resource: res, matchedGrant: matched ?? null };
}

function grantApplies(g: PermissionGrant, p: Principal, cap: Capability, resource: ResourceRef, ctx: EvalContext): boolean {
  if (!LIVE_PERMISSION_STATES.includes(g.state)) return false;
  if (g.operation !== cap && g.operation !== ('*' as Capability)) return false;
  // identity: userId or a role the principal holds
  const idOk = g.identityRef === p.userId || g.identityRef === '*' ||
    (g.identityRef.startsWith('role:') && p.roles.includes(g.identityRef.slice(5)));
  if (!idOk) return false;
  // resource: exact id, a type token, or wildcard
  const resOk = g.resourceRef === '*' || g.resourceRef === resource.id ||
    (g.resourceRef.startsWith('type:') && g.resourceRef.slice(5) === resource.type);
  if (!resOk) return false;
  // conditions
  const c = g.conditions || {};
  if (c.requireOwner && resource.ownerId !== p.userId) return false;
  if (c.resourceState && resource.state && !c.resourceState.includes(resource.state)) return false;
  if (c.institutionId && resource.institutionId && c.institutionId !== resource.institutionId) return false;
  if (c.timeWindow) {
    const h = (ctx.now ?? new Date()).getHours();
    const { startHour = 0, endHour = 24 } = c.timeWindow;
    if (h < startHour || h >= endHour) return false;
  }
  if (c.location && ctx.location && !c.location.includes(ctx.location)) return false;
  return true;
}

// Security-label gating: which roles a label admits (main-surface classification).
function labelAdmits(label: string, p: Principal): boolean {
  switch (label) {
    case 'public': return true;
    case 'enrolled-only': return p.roles.includes('student') || p.roles.includes('faculty') || p.roles.includes('researcher') || p.capabilities.has(ADMINISTER);
    case 'exam-secure': return p.roles.includes('proctor') || p.roles.includes('reviewer_examiner') || p.roles.includes('faculty') || p.capabilities.has(ADMINISTER);
    default: return p.capabilities.has(ADMINISTER);   // unknown label: only superadmin
  }
}

export function evaluate(p: Principal, capability: Capability, resource: ResourceRef = {}, ctx: EvalContext = {}): Decision {
  const resTok = resource.id || (resource.type ? `type:${resource.type}` : '*');

  // 1. Resolve Identity
  if (!p || p.userId === undefined) return deny('resolve-identity', 'no identity', capability, resTok);
  // 2. Verify Session
  if (p.userId !== null && !p.sessionValid) return deny('verify-session', 'session invalid or expired', capability, resTok);
  // 3. Verify Authorization (must hold at least one role; anonymous is treated as guest)
  const roles = p.roles.length ? p.roles : ['guest'];
  // 4. Validate Capability
  if (!isCapability(capability)) return deny('validate-capability', `unknown capability "${capability}"`, capability, resTok);

  // 5. Load Permission Context: explicit grants applicable here, split by effect, sorted by priority.
  const applicable = (p.grants ?? []).filter((g) => grantApplies(g, p, capability, resource, ctx))
    .sort((a, b) => b.priority - a.priority);
  const denies = applicable.filter((g) => g.effect === 'deny');
  const allows = applicable.filter((g) => g.effect === 'allow');

  // Explicit DENY overrides everything (spec: explicit deny overrides allow).
  if (denies.length) return deny('apply-constraints', 'explicit deny grant', capability, resTok, denies[0].permissionId);

  // 6. Evaluate Rules
  const superadmin = p.capabilities.has(ADMINISTER);
  const hasCapByRole = superadmin || p.capabilities.has(capability);
  const hasCapByGrant = allows.length > 0;
  if (!hasCapByRole && !hasCapByGrant) return deny('evaluate-rules', `no role capability or grant for "${capability}"`, capability, resTok);

  // Security-label gating (skip for superadmin).
  if (!superadmin && resource.securityLabels?.length) {
    const admitted = resource.securityLabels.every((l) => labelAdmits(l, p));
    if (!admitted) return deny('evaluate-rules', `security label(s) ${resource.securityLabels.join(',')} not admitted`, capability, resTok);
  }

  // Ownership rule for mutating capabilities (write/delete): non-owners need manage/administer.
  if (!superadmin && (capability === 'write' || capability === 'delete') && resource.ownerId != null && resource.ownerId !== p.userId) {
    if (!p.capabilities.has('manage')) return deny('evaluate-rules', 'not owner and lacks manage', capability, resTok);
  }

  // 7. Apply Constraints: minor accounts need a guardian for sensitive actions.
  if (isMinorStage(p.stage) && ctx.sensitive && !p.hasGuardian) {
    return deny('apply-constraints', 'minor account without a linked guardian is blocked from a sensitive action', capability, resTok);
  }

  // 8. Return Decision
  return allow('return-decision', hasCapByGrant && !hasCapByRole ? 'explicit allow grant' : (superadmin ? 'administer' : 'role capability'), capability, resTok, allows[0]?.permissionId ?? null);
}
