// src/lib/rbac/policy.ts — Block 10: the named precedence ladder used by engine.evaluate().
// First decisive tier wins; ambiguity => deny. This formalizes the spec's conflict-resolution
// order (Ch.25 §12) and gives every Decision.stage a stable tier name.
//
//   TIER 0  kernel-policy            hard invariants -> DENY (no identity / bad session /
//                                    unknown capability / resource flag 'kernel-locked')
//   TIER 1  explicit-deny            any applicable deny grant/ACL -> DENY
//   TIER 2  administrative-override  principal holds ADMINISTER    -> ALLOW
//   TIER 3  explicit-grant           an allow grant / object ACL applies -> ALLOW
//   TIER 4  capability-token         a live token authorizes (op, resource, scope) -> ALLOW
//   TIER 5  inherited                a cascade grant from an ancestor applies -> ALLOW
//   TIER 6  role-default             a role capability covers it (subject to label/owner/minor) -> ALLOW
//   TIER 7  default-deny             -> DENY
export const POLICY_TIERS = [
  'kernel-policy', 'explicit-deny', 'administrative-override',
  'explicit-grant', 'capability-token', 'inherited', 'role-default', 'default-deny',
] as const;
export type PolicyTier = (typeof POLICY_TIERS)[number];

/** A resource carrying this flag is hard-denied at Tier 0 regardless of any grant. */
export const KERNEL_LOCK_FLAG = 'kernel-locked';

/** Depth bound for BFS over part_of ancestry / token delegation chains. */
export const MAX_INHERITANCE_DEPTH = 8;
