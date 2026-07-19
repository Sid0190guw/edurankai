// src/lib/security/authz.ts — Block 11: the single zero-trust per-request gate. Deny-by-default.
// Thin wrapper over the existing RBAC engine + guard (no new policy engine). Re-verifies identity
// + capability on every call; writes exactly one rbac_audit row (via requireCapability).
import type { Capability } from '@/lib/rbac/capabilities';
import type { ResourceRef, EvalContext, Decision } from '@/lib/rbac/types';

/** Verify a live session on locals.user AND a capability allow. Throws ForbiddenError (403) on deny. */
export async function authorizeRequest(
  locals: { user: unknown | null },
  cap: Capability,
  res: ResourceRef = {},
  ctx: EvalContext = {},
): Promise<Decision> {
  const { requireCapability, ForbiddenError } = await import('@/lib/rbac');
  const user = (locals as any)?.user ?? null;
  if (!user) {
    throw new ForbiddenError({ allow: false, reason: 'no identity', stage: 'kernel-policy', capability: cap, resource: res.id || (res.type ? `type:${res.type}` : '*'), matchedGrant: null });
  }
  return requireCapability(user, cap, res, ctx);   // throws ForbiddenError when denied
}
