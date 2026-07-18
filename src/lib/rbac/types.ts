// src/lib/rbac/types.ts — permission model + lifecycle + evaluation I/O types.
import type { Capability } from './capabilities';
import type { Stage } from './roles';

export type SecurityLabel = 'public' | 'enrolled-only' | 'exam-secure' | (string & {});
export type Effect = 'allow' | 'deny';

// ---- a runtime permission grant (immutable except via lifecycle transitions) ----
export interface RuleConditions {
  requireOwner?: boolean;                 // only the resource owner may act
  resourceState?: string[];               // resource lifecycleState must be one of these
  timeWindow?: { startHour?: number; endHour?: number };   // 0..23 local
  institutionId?: string;                 // resource must belong to this institution/tenant
  location?: string[];                    // allowed location tags
}
export interface PermissionGrant {
  permissionId: string;
  identityRef: string;                    // userId or role key (role:<key>)
  resourceRef: string;                    // resource id, a type token (type:<Type>), or '*'
  operation: Capability;
  effect: Effect;                         // allow | deny  (deny overrides allow)
  state: PermissionState;
  inheritancePolicy: 'none' | 'cascade';  // cascade = applies to child resources too
  conditions: RuleConditions;
  priority: number;                       // higher wins
  version: number;
  flags: string[];
}

// ---- permission lifecycle ----
export const PERMISSION_STATES = [
  'defined', 'granted', 'validated', 'activated', 'inherited', 'modified', 'suspended', 'revoked', 'archived',
] as const;
export type PermissionState = (typeof PERMISSION_STATES)[number];

export const PERMISSION_TRANSITIONS: Record<PermissionState, PermissionState[]> = {
  defined:   ['granted'],
  granted:   ['validated'],
  validated: ['activated'],
  activated: ['inherited', 'modified', 'suspended', 'revoked'],
  inherited: ['modified', 'suspended', 'revoked'],
  modified:  ['activated', 'suspended', 'revoked'],
  suspended: ['activated', 'revoked'],
  revoked:   ['archived'],
  archived:  [],
};
export class PermissionLifecycleError extends Error {
  constructor(public from: PermissionState, public to: PermissionState) {
    super(`illegal permission transition: ${from} -> ${to}`);
    this.name = 'PermissionLifecycleError';
  }
}
export function assertPermissionTransition(from: PermissionState, to: PermissionState): void {
  if (!PERMISSION_TRANSITIONS[from]?.includes(to)) throw new PermissionLifecycleError(from, to);
}
/** A grant is "live" (participates in evaluation) only in these states. */
export const LIVE_PERMISSION_STATES: PermissionState[] = ['activated', 'inherited', 'modified'];

// ---- evaluation I/O ----
export interface Principal {
  userId: string | null;                  // null = anonymous
  sessionValid: boolean;
  roles: string[];                        // role keys the user holds
  capabilities: Set<Capability>;          // union of role (inherited) capabilities
  stage?: Stage | null;                   // when a student
  hasGuardian?: boolean;                  // a linked guardian exists (for minor accounts)
  trustLevel?: 'low' | 'normal' | 'high';
  grants?: PermissionGrant[];             // explicit grants targeting this user
}
export interface ResourceRef {
  id?: string;
  type?: string;                          // object type token
  ownerId?: string | null;
  securityLabels?: SecurityLabel[];
  state?: string;                         // lifecycleState
  institutionId?: string | null;
}
export interface EvalContext {
  now?: Date;
  institutionId?: string | null;
  node?: string;
  location?: string;
  sensitive?: boolean;                    // a sensitive action (minor accounts need guardian consent)
}
export interface Decision {
  allow: boolean;
  reason: string;
  stage: string;                          // which pipeline stage produced the decision
  matchedGrant?: string | null;
  capability: Capability;
  resource: string;
}
