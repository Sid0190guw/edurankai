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
import { KERNEL_LOCK_FLAG } from './policy';
import { tokenCovers } from './tokens';

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

  // ---- TIER 0: kernel policy (hard invariants) ----
  if (!p || p.userId === undefined) return deny('kernel-policy', 'no identity', capability, resTok);
  if (p.userId !== null && !p.sessionValid) return deny('kernel-policy', 'session invalid or expired', capability, resTok);
  if (!isCapability(capability)) return deny('kernel-policy', `unknown capability "${capability}"`, capability, resTok);
  if (resource.flags?.includes(KERNEL_LOCK_FLAG)) return deny('kernel-policy', 'resource is kernel-locked', capability, resTok);
  const roles = p.roles.length ? p.roles : ['guest'];   // anonymous is treated as guest

  // Load applicable grants (central + object-ACL + inherited), split by effect, sorted by priority.
  const applicable = (p.grants ?? []).filter((g) => grantApplies(g, p, capability, resource, ctx))
    .sort((a, b) => b.priority - a.priority);
  const denies = applicable.filter((g) => g.effect === 'deny');
  const allows = applicable.filter((g) => g.effect === 'allow');

  // ---- TIER 1: explicit deny (overrides everything, incl. administer) ----
  if (denies.length) return deny('explicit-deny', 'explicit deny grant', capability, resTok, denies[0].permissionId);

  // ---- TIER 2: administrative override ----
  const superadmin = p.capabilities.has(ADMINISTER);
  if (superadmin) return allow('administrative-override', 'administer', capability, resTok, null);

  // Which tier authorizes this allow (if any).
  const grantAllows = allows.filter((g) => !(g.flags ?? []).includes('inherited'));
  const inheritedAllows = allows.filter((g) => (g.flags ?? []).includes('inherited'));
  const hasGrant = grantAllows.length > 0;                                                   // TIER 3
  const hasToken = (p.capabilityTokens ?? []).some((t) => tokenCovers(t, capability, resource, ctx)); // TIER 4
  const hasInherited = inheritedAllows.length > 0;                                            // TIER 5
  const hasRole = roles.length > 0 && p.capabilities.has(capability);                         // TIER 6

  if (!(hasGrant || hasToken || hasInherited || hasRole)) {
    return deny('default-deny', `no grant, token, inherited permission, or role capability for "${capability}"`, capability, resTok);
  }

  // ---- constraints apply to every non-admin allow path ----
  if (resource.securityLabels?.length) {
    const admitted = resource.securityLabels.every((l) => labelAdmits(l, p));
    if (!admitted) return deny('apply-constraints', `security label(s) ${resource.securityLabels.join(',')} not admitted`, capability, resTok);
  }
  if ((capability === 'write' || capability === 'delete') && resource.ownerId != null && resource.ownerId !== p.userId) {
    if (!p.capabilities.has('manage')) return deny('apply-constraints', 'not owner and lacks manage', capability, resTok);
  }
  if (isMinorStage(p.stage) && ctx.sensitive && !p.hasGuardian) {
    return deny('apply-constraints', 'minor account without a linked guardian is blocked from a sensitive action', capability, resTok);
  }

  // ---- decision: the highest matched tier wins ----
  if (hasGrant)     return allow('explicit-grant', 'explicit allow grant', capability, resTok, grantAllows[0].permissionId);
  if (hasToken)     return allow('capability-token', 'capability token', capability, resTok, null);
  if (hasInherited) return allow('inherited', 'inherited grant', capability, resTok, inheritedAllows[0].permissionId);
  return allow('role-default', 'role capability', capability, resTok, null);
}
