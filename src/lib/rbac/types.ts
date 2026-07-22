// src/lib/rbac/types.ts — permission model + lifecycle + evaluation I/O types.
import { z } from 'zod';
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
  capabilityTokens?: CapabilityToken[];   // already-validated bearer tokens presented this request (Block 10)
}
export interface ResourceRef {
  id?: string;
  type?: string;                          // object type token
  ownerId?: string | null;
  securityLabels?: SecurityLabel[];
  state?: string;                         // lifecycleState
  institutionId?: string | null;
  flags?: string[];                       // hard-policy flags, e.g. 'kernel-locked' (Block 10 Tier 0)
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
  stage: string;                          // which policy tier / pipeline stage produced the decision
  matchedGrant?: string | null;
  capability: Capability;
  resource: string;
}

// ==========================================================================
// Block 10 — capability tokens (delegated, scoped, revocable authority).
// ==========================================================================
export interface CapabilityScope {
  institutionId?: string | null;
  namespace?: string | null;
  node?: string | null;
  missionId?: string | null;
  timeWindow?: { startHour?: number; endHour?: number };
}

export const CAPABILITY_TOKEN_STATES = [
  'issued', 'activated', 'delegated', 'suspended', 'revoked', 'archived', 'destroyed',
] as const;
export type CapabilityTokenState = (typeof CAPABILITY_TOKEN_STATES)[number];

export const TOKEN_TRANSITIONS: Record<CapabilityTokenState, CapabilityTokenState[]> = {
  issued:    ['activated', 'delegated', 'suspended', 'revoked'],
  activated: ['delegated', 'suspended', 'revoked'],
  delegated: ['suspended', 'revoked'],
  suspended: ['activated', 'revoked'],
  revoked:   ['archived'],
  archived:  ['destroyed'],
  destroyed: [],
};
/** A token participates in validation only while LIVE. */
export const LIVE_TOKEN_STATES: CapabilityTokenState[] = ['issued', 'activated', 'delegated'];

export interface CapabilityToken {
  tokenId: string;
  ownerIdentity: string;
  issuedBy: string | null;
  targetResource: string;                 // id | 'type:<T>' | '*'
  allowedOperations: Capability[];        // subset of registered capabilities, or ['*']
  scope: CapabilityScope;
  delegatedFrom: string | null;
  delegationDepth: number;                // remaining re-delegations
  status: CapabilityTokenState;
  version: number;
  expiresAt: string | null;               // ISO
}

export interface TokenValidation {
  valid: boolean;
  reason: string;
  token?: CapabilityToken;
}

// ---- zod schemas (API + delegation input validation) ----
export const capabilityScopeSchema = z.object({
  institutionId: z.string().nullish(),
  namespace: z.string().nullish(),
  node: z.string().nullish(),
  missionId: z.string().nullish(),
  timeWindow: z.object({
    startHour: z.number().int().min(0).max(23).optional(),
    endHour: z.number().int().min(1).max(24).optional(),
  }).optional(),
}).strict();

export const issueTokenSchema = z.object({
  ownerIdentity: z.string().uuid(),
  targetResource: z.string().min(1),
  allowedOperations: z.array(z.string().min(1)).min(1),
  scope: capabilityScopeSchema.default({}),
  maxDelegationDepth: z.number().int().min(0).max(8).default(0),
  expiresAt: z.string().datetime().nullish(),
  reason: z.string().max(500).optional(),
});

export const checkRequestSchema = z.object({
  capability: z.string().min(1),
  resource: z.object({
    id: z.string().optional(),
    type: z.string().optional(),
    ownerId: z.string().nullish(),
    securityLabels: z.array(z.string()).optional(),
    state: z.string().optional(),
    institutionId: z.string().nullish(),
    flags: z.array(z.string()).optional(),
  }).default({}),
  context: z.object({
    sensitive: z.boolean().optional(),
    institutionId: z.string().nullish(),
    location: z.string().optional(),
  }).default({}),
});
