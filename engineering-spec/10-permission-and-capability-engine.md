# Engineering Block 10 — Kernel Permission & Capability Engine (KPE)

| Field | Value |
|---|---|
| **Spec source** | AES Vol 3 (Educational Operating Kernel Engineering) Part I, Ch. 24–25 pp. 66–121 — "Kernel Capability Management System", "Kernel Permission Engine", "Runtime Access Matrix & Policy Enforcement", "Capability Tokens", "Permission Lifecycle", "Conflict Resolution", "Permission Decision Matrix" |
| **Repo target** | Extend `src/lib/rbac/{schema.ts,types.ts,engine.ts,store.ts,index.ts}`; add `src/lib/rbac/{tokens.ts,objectAcl.ts,policy.ts}`; add endpoints `src/pages/api/rbac/check.ts` + `src/pages/api/admin/rbac/tokens.ts`; reconcile with `kernel_objects.permissions[]` (`src/lib/kernel/types.ts` `Permission`). Leaves `src/lib/auth/permissions.ts` (legacy hiring RBAC) untouched. |
| **Status** | partial (deterministic subject×action×resource engine, grant model, 9-state permission lifecycle, audit, role inheritance, and the `/api/admin/rbac` management surface already exist; capability **tokens**, per-object **ACL reconciliation**, **cascade** inheritance, and a formalized **policy ladder** are the work) |
| **Depends on** | Block 01 (Object Model & Kernel Envelope — supplies `kernel_objects.permissions[]`, `owner`, `securityLabels[]`, `part_of` edges); Identity & Session Auth (`src/lib/auth/session.ts` supplies `locals.user`); Audit log (`rbac_audit`). |

## 1. Purpose
Fine-grained, deterministic access control for every protected operation in AquinTutor. A single function answers "may this **subject** perform this **action** (capability) on this **resource** under this **context**?" by evaluating role-derived capabilities, explicit permission grants, per-object ACLs, and delegated capability tokens through one fixed precedence ladder that defaults to deny. It also manages the permission-grant lifecycle, issues/validates/revokes scoped capability tokens (delegated authority), and writes an immutable audit row for every decision. It does **not** do login or session management — it consumes the already-authenticated `locals.user`.

## 2. Repo mapping — exists vs. build

**Already implemented (do not duplicate):**
- `src/lib/rbac/capabilities.ts` — the 16 atomic capabilities (`read write create delete execute configure manage allocate release schedule audit replicate backup restore delegate administer`), a runtime registry (`registerCapability`/`isCapability`), and the `ADMINISTER` god-capability.
- `src/lib/rbac/roles.ts` — seed role roster (admin + main surfaces), student `Stage`s + `MINOR_STAGES`, and `resolveRoleCapabilities()` (cycle-safe transitive `inherits` union).
- `src/lib/rbac/types.ts` — `PermissionGrant`, `RuleConditions`, the 9-state `PERMISSION_STATES` lifecycle + `PERMISSION_TRANSITIONS` guard, `LIVE_PERMISSION_STATES`, and the evaluation I/O types (`Principal`, `ResourceRef`, `EvalContext`, `Decision`).
- `src/lib/rbac/engine.ts` — `evaluate(principal, capability, resource, ctx)`: the pure, side-effect-free pipeline (Resolve Identity → Verify Session → Verify Authorization → Validate Capability → Load Context → Evaluate Rules → Apply Constraints → Decision), explicit-deny-wins, security-label gating, ownership rule, minor/guardian constraint.
- `src/lib/rbac/guard.ts` — `enforce()` (evaluate + one audit row via injectable sink), `can()`, `requireCapability()` (throws `ForbiddenError`), `requireAdminRole()`.
- `src/lib/rbac/store.ts` — self-bootstrapping DDL (`ensureRbacSchema`), `seedRbac()`, `resolvePrincipal()` (maps legacy `users.role` + `rbac_user_roles` + grants + guardian links into a `Principal`), `writeAudit()`, `createGrant()`, `transitionGrant()`.
- `src/lib/rbac/schema.ts` — `rbac_capabilities`, `rbac_roles`, `rbac_role_capabilities`, `rbac_user_roles`, `rbac_permission_grants`, `rbac_guardian_links`, `rbac_audit` (+ `RBAC_DDL`).
- `src/lib/rbac/access.ts` — `accessSummary()` for the learner-facing "your access" view.
- `src/pages/api/admin/rbac.ts` — management actions (`seed | assignRole | removeRole | setStage | linkGuardian | unlinkGuardian | toggleCap | createRole`), self-gated by `can(user, 'manage', {type:'rbac'})`.
- `src/lib/kernel/types.ts` — `Permission { subject, roles: ('read'|'write'|'publish')[] }` and `kernel_objects.permissions jsonb` + `security_labels text[]` (per-object ACL **storage** already exists).

**To build (this block):**
1. **Capability token model** — `rbac_capability_tokens` table + `src/lib/rbac/tokens.ts`: bearer tokens carrying `allowedOperations`, `scope`, `delegationDepth`, integrity via hashed secret (mirrors `session.ts`). The current "capability" is only an atomic action label; the spec's KCMS capability is a *delegated, transferable, revocable, scoped* token. This is the largest genuine gap.
2. **Per-object ACL reconciliation** — `src/lib/rbac/objectAcl.ts`: translate `kernel_objects.permissions[]` (`Permission[]`) into evaluation-time `PermissionGrant`s scoped to that object id, plus a `canObject(user, cap, kernelObject, ctx)` guard helper. Today `resolvePrincipal` loads only `rbac_permission_grants`; per-object ACLs are stored but **never enforced**.
3. **Cascade inheritance** — resolve `inheritancePolicy: 'cascade'` grants from ancestor objects by walking `part_of` edges (`kernel_edges`). Today `'cascade'` is a declared type value with no evaluation behavior.
4. **Formalized policy ladder** — `src/lib/rbac/policy.ts`: name the precedence tiers (Kernel Policy → Explicit Deny → Administrative Override → Explicit Grant / Token → Inherited → Role Default → Deny) as constants and align `engine.ts` to them; add a hard "kernel policy" deny list.
5. **API surface** — `POST /api/rbac/check` (subject×action×resource decision) + `POST /api/admin/rbac/tokens` (`issue | delegate | revoke | list`).

## 3. Data model

All additions are additive and follow repo conventions (`pgTable`, `uuid`, `jsonb`, `text[]`, zod, `*_DDL` self-bootstrap).

### 3.1 Capability tokens — extend `src/lib/rbac/schema.ts`
```ts
export const rbacCapabilityTokens = pgTable('rbac_capability_tokens', {
  tokenId: uuid('token_id').primaryKey().defaultRandom(),
  ownerIdentity: uuid('owner_identity').notNull(),          // the holder (userId)
  issuedBy: uuid('issued_by'),                              // granting identity (null = system)
  targetResource: text('target_resource').notNull(),        // resource id, 'type:<T>', or '*'
  allowedOperations: text('allowed_operations').array().notNull().default([]),
  scope: jsonb('scope').notNull().default({}),              // CapabilityScope (see 3.2)
  delegatedFrom: uuid('delegated_from'),                    // parent token (null = root)
  delegationDepth: integer('delegation_depth').notNull().default(0), // remaining re-delegations
  status: text('status').notNull().default('issued'),      // capability-token lifecycle (3.2)
  version: integer('version').notNull().default(1),
  secretHash: text('secret_hash').notNull(),               // hex sha256 of the opaque bearer token
  reason: text('reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerIdx: index('rbac_captok_owner_idx').on(t.ownerIdentity),
  hashIdx: index('rbac_captok_hash_idx').on(t.secretHash),
  parentIdx: index('rbac_captok_parent_idx').on(t.delegatedFrom),
}));

// Append to RBAC_DDL (self-bootstrap path — matches the columns above):
export const RBAC_TOKENS_DDL = [
  `CREATE TABLE IF NOT EXISTS rbac_capability_tokens (
     token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_identity UUID NOT NULL,
     issued_by UUID,
     target_resource TEXT NOT NULL,
     allowed_operations TEXT[] NOT NULL DEFAULT '{}',
     scope JSONB NOT NULL DEFAULT '{}'::jsonb,
     delegated_from UUID,
     delegation_depth INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'issued',
     version INTEGER NOT NULL DEFAULT 1,
     secret_hash TEXT NOT NULL,
     reason TEXT,
     expires_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS rbac_captok_owner_idx  ON rbac_capability_tokens (owner_identity)`,
  `CREATE INDEX IF NOT EXISTS rbac_captok_hash_idx   ON rbac_capability_tokens (secret_hash)`,
  `CREATE INDEX IF NOT EXISTS rbac_captok_parent_idx ON rbac_capability_tokens (delegated_from)`,
];
```
`ensureRbacSchema()` runs `[...RBAC_DDL, ...RBAC_TOKENS_DDL]`.

### 3.2 Token TS model + lifecycle — extend `src/lib/rbac/types.ts`
```ts
export interface CapabilityScope {
  institutionId?: string | null;
  namespace?: string | null;
  node?: string | null;
  missionId?: string | null;                         // educational-mission scope
  timeWindow?: { startHour?: number; endHour?: number };
}

// Capability-token lifecycle (spec Ch. 24 §7). A token participates in validation only
// while LIVE; suspend/revoke/archive/destroy take it out immediately.
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
export const LIVE_TOKEN_STATES: CapabilityTokenState[] = ['issued', 'activated', 'delegated'];

export interface CapabilityToken {
  tokenId: string;
  ownerIdentity: string;
  issuedBy: string | null;
  targetResource: string;                            // id | 'type:<T>' | '*'
  allowedOperations: Capability[];                   // subset of registered capabilities, or ['*']
  scope: CapabilityScope;
  delegatedFrom: string | null;
  delegationDepth: number;                           // remaining re-delegations
  status: CapabilityTokenState;
  version: number;
  expiresAt: string | null;                          // ISO
}

export interface TokenValidation {
  valid: boolean;
  reason: string;
  token?: CapabilityToken;
}
```

### 3.3 zod schemas — extend `src/lib/rbac/types.ts` (or a `validation.ts`)
```ts
import { z } from 'zod';

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
  }).default({}),
  context: z.object({
    sensitive: z.boolean().optional(),
    institutionId: z.string().nullish(),
    location: z.string().optional(),
  }).default({}),
});
```

### 3.4 Per-object ACL payload — already in `src/lib/kernel/types.ts`
`kernel_objects.permissions` stores `Permission[]` where `Permission = { subject: string; roles: ('read'|'write'|'publish')[] }`. No schema change; Block 10 adds the *interpreter* (3.5 / §5.3).

## 4. Interfaces & API contracts

### 4.1 `src/lib/rbac/tokens.ts` (new)
```ts
import type { Capability } from './capabilities';
import type { CapabilityToken, CapabilityScope, TokenValidation, EvalContext } from './types';

/** Opaque bearer secret (base32, 20 random bytes) — mirrors auth/session.ts. Returned ONCE. */
export function generateTokenSecret(): string;

/** Mint a root capability token. Returns the DB id + the one-time bearer secret. */
export function issueToken(
  input: {
    ownerIdentity: string; targetResource: string; allowedOperations: Capability[];
    scope?: CapabilityScope; maxDelegationDepth?: number; expiresAt?: string | null; reason?: string;
  },
  issuedBy: string | null,
): Promise<{ tokenId: string; token: string }>;

/** Bearer-token check: hash → load → status/expiry/operation/resource/scope. Side-effect free. */
export function validateToken(
  token: string,
  need: { operation: Capability; resource: { id?: string; type?: string }; ctx?: EvalContext },
): Promise<TokenValidation>;

/** Delegate a subset of a parent token to another identity. Authority can only NARROW. */
export function delegateToken(
  parentToken: string,
  delegatorUserId: string,
  sub: {
    ownerIdentity: string; allowedOperations: Capability[]; targetResource?: string;
    scope?: CapabilityScope; expiresAt?: string | null; reason?: string;
  },
): Promise<{ tokenId: string; token: string }>;

/** Revoke a token (and, by default, every token delegated from it). Returns count revoked. */
export function revokeToken(tokenId: string, opts?: { cascade?: boolean }): Promise<number>;

/** List live tokens a subject holds (secrets never returned). */
export function listTokens(ownerIdentity: string): Promise<CapabilityToken[]>;
```

### 4.2 `src/lib/rbac/objectAcl.ts` (new)
```ts
import type { PermissionGrant, ResourceRef, EvalContext, Decision } from './types';
import type { KernelObject } from '@/lib/kernel/types';

export interface ObjectAclEntry { subject: string; roles: ('read' | 'write' | 'publish')[]; }

/** Compile an object's permissions[] into eval-time grants scoped to THAT object id. Pure. */
export function aclToGrants(objectId: string, acl: ObjectAclEntry[]): PermissionGrant[];

/** Resolve grants inherited from ancestors via `part_of` edges (cascade grants only). */
export function resolveInheritedGrants(objectId: string): Promise<PermissionGrant[]>;

/** Guard helper: evaluate against a full KernelObject (ACL + cascade + central grants). */
export function canObject(
  user: unknown, cap: string, obj: KernelObject, ctx?: EvalContext,
): Promise<Decision>;
```

### 4.3 `src/lib/rbac/engine.ts` (extend — Principal gains a token channel)
```ts
// types.ts: add to Principal
//   capabilityTokens?: CapabilityToken[];   // already-validated tokens presented this request
// engine.ts: at "Evaluate Rules", a live token whose allowedOperations ∋ capability and whose
// targetResource matches counts as an Explicit-Grant-tier allow (see §5.1 tier 4).
export function evaluate(
  p: Principal, capability: Capability, resource?: ResourceRef, ctx?: EvalContext,
): Decision; // signature unchanged; behaviour extended per §5.1
```

### 4.4 Astro endpoints
```
POST /api/rbac/check                      (src/pages/api/rbac/check.ts)
  auth:    any signed-in user (checks are evaluated as THAT user)
  body:    checkRequestSchema  { capability, resource, context }
  200:     { allow: boolean, reason: string, stage: string, matchedGrant: string|null }
  400:     { ok:false, error:'invalid body' }   401: not signed in

POST /api/admin/rbac/tokens               (src/pages/api/admin/rbac/tokens.ts)
  auth:    caller must hold 'delegate' (or 'administer'); enforced via requireCapability
  body:    { action: 'issue'|'delegate'|'revoke'|'list', ... }
    issue:    issueTokenSchema                    -> 200 { ok:true, tokenId, token }  // token shown ONCE
    delegate: { parentToken, ownerIdentity, allowedOperations, targetResource?, scope?, expiresAt? }
                                                  -> 200 { ok:true, tokenId, token }
    revoke:   { tokenId, cascade?:boolean }       -> 200 { ok:true, revoked:number }
    list:     { ownerIdentity }                   -> 200 { ok:true, tokens: CapabilityToken[] }
  403:     { ok:false, error, reason }            // ForbiddenError from requireCapability
```

## 5. Core logic / algorithms

### 5.1 Policy evaluation ladder (`src/lib/rbac/policy.ts` — formalizes conflict resolution, spec Ch. 25 §12)
First decisive tier wins; ambiguity ⇒ deny. This names what `engine.ts` already does and adds tiers 4-token and 5-inherited.
```
TIER 0  Kernel Policy (hard invariants)      -> DENY on: no identity | invalid session |
                                                 unknown capability | resource flag 'kernel-locked'
TIER 1  Explicit Deny                        -> DENY if any applicable grant/ACL has effect='deny'
TIER 2  Administrative Override              -> ALLOW if principal holds ADMINISTER
TIER 3  Explicit Grant (central + object ACL) -> ALLOW if an allow-grant applies
TIER 4  Capability Token                      -> ALLOW if a live token authorizes (op,resource,scope)
TIER 5  Inherited Permission (cascade)        -> ALLOW if a cascade grant from an ancestor applies
TIER 6  Role Default                          -> ALLOW if a role capability covers it, subject to
                                                 security-label gating + ownership + minor/guardian rules
TIER 7  Default                               -> DENY
```
```ts
export const POLICY_TIERS = [
  'kernel-policy', 'explicit-deny', 'administrative-override',
  'explicit-grant', 'capability-token', 'inherited', 'role-default', 'default-deny',
] as const;
export type PolicyTier = (typeof POLICY_TIERS)[number];
```

### 5.2 `evaluate()` — deterministic subject×action×resource check (existing, extended)
```
INPUT: principal p, capability cap, resource r, context ctx
 1. resTok := r.id ?? (r.type ? 'type:'+r.type : '*')
 2. [TIER 0] if p == null or p.userId === undefined            -> DENY 'resolve-identity'
 3. [TIER 0] if p.userId !== null and !p.sessionValid          -> DENY 'verify-session'
 4. roles := p.roles.length ? p.roles : ['guest']
 5. [TIER 0] if !isCapability(cap)                             -> DENY 'validate-capability'
 6. applicable := p.grants.filter(g => grantApplies(g,p,cap,r,ctx)).sort(desc priority)
       // p.grants now = central grants ++ aclToGrants(r.id) ++ resolveInheritedGrants(r.id)
 7. [TIER 1] if applicable.any(effect=='deny')                 -> DENY 'explicit-deny'
 8. superadmin := p.capabilities.has(ADMINISTER)
 9. [TIER 2] if superadmin                                     -> ALLOW 'administrative-override'  (*)
10. hasGrant := applicable.any(effect=='allow' && flags∌'inherited')       // TIER 3
11. hasToken := (p.capabilityTokens ?? []).any(t => tokenCovers(t,cap,r))  // TIER 4
12. hasInherited := applicable.any(effect=='allow' && flags∋'inherited')   // TIER 5
13. hasRole := p.capabilities.has(cap)                                     // TIER 6
14. if !(hasGrant || hasToken || hasInherited || hasRole)     -> DENY 'evaluate-rules'
15. // constraints apply to every non-admin allow path:
16. if r.securityLabels?.length && !r.securityLabels.every(l => labelAdmits(l,p)) -> DENY
17. if (cap∈{write,delete}) && r.ownerId != null && r.ownerId != p.userId
        && !p.capabilities.has('manage')                       -> DENY 'not owner'
18. if isMinorStage(p.stage) && ctx.sensitive && !p.hasGuardian -> DENY 'apply-constraints'
19. -> ALLOW  (stage = highest matched tier)
```
`(*)` Tier 2 runs after Tier 1 so an **explicit deny still beats a superadmin** — matches the spec's "explicit deny overrides" while keeping administer above ordinary grants. `tokenCovers(t,cap,r)` = `t` live ∧ (`cap ∈ t.allowedOperations` ∨ `'*'`) ∧ resource match ∧ scope match.

### 5.3 ACL reconciliation — `aclToGrants` (spec: reconcile RBAC with per-object ACLs)
```
ACL_ROLE_TO_OPS = { read: [read], write: [write,create,delete], publish: [execute] }
for each entry {subject, roles} in object.permissions:
    identityRef := subject=='*'            ? '*'
                 : subject starts 'role:'  ? subject
                 : isUuid(subject)         ? subject            // a user/object id
                 : 'role:'+subject                              // bare role name
    ops := union of ACL_ROLE_TO_OPS[r] for r in roles
    for op in ops:
        emit PermissionGrant {
          permissionId: 'acl:'+objectId+':'+subject+':'+op,
          identityRef, resourceRef: objectId, operation: op,
          effect:'allow', state:'activated', inheritancePolicy:'none',
          conditions:{}, priority: 5, version:1, flags:['object-acl'] }
```
These synthetic grants flow through the **same** ladder (§5.1), so a central `rbac_permission_grants` deny at higher priority still overrides an object ACL allow — that is the reconciliation contract. `canObject()` merges them: `{ ...principal, grants: [...principal.grants, ...aclToGrants(obj.id, obj.permissions), ...await resolveInheritedGrants(obj.id)] }`, then calls `enforce()`.

### 5.4 Cascade inheritance — `resolveInheritedGrants` (BFS up `part_of` edges)
```
resolveInheritedGrants(objectId):
   inherited := []; frontier := [objectId]; seen := {objectId}; depth := 0
   while frontier not empty and depth < MAX_DEPTH (8):
       parents := SELECT to_id FROM kernel_edges
                  WHERE from_id = ANY(frontier) AND type='part_of'
       next := []
       for pid in parents where pid not in seen:
           seen.add(pid); next.push(pid)
           // central grants on the ancestor marked cascade
           for g in grantsFor(pid) where g.inheritancePolicy=='cascade':
               inherited.push({ ...g, resourceRef: objectId,
                                state:'inherited', priority: g.priority - 1,
                                flags:[...g.flags,'inherited'] })
           // ancestor ACLs also cascade (as inherited-tier allows)
           for ag in aclToGrants(objectId, aclOf(pid)):
               inherited.push({ ...ag, state:'inherited', priority: 3,
                                flags:[...ag.flags,'inherited'] })
       frontier := next; depth++
   return inherited
```
Inherited grants land in Tier 5 (below explicit grants) and **never widen** authority — they only re-point an ancestor's allow at the descendant object id. Deny grants are not cascaded (denials stay explicit at their own scope).

### 5.5 `validateToken()` — bearer capability check (spec Ch. 24 §11 pipeline)
```
validateToken(token, {operation, resource, ctx}):
 1. h := hexSha256(token)                                  // same hash as session.ts
 2. row := SELECT * FROM rbac_capability_tokens WHERE secret_hash = h LIMIT 1
 3. if !row                                   -> {valid:false, reason:'invalid token'}
 4. if row.status ∉ LIVE_TOKEN_STATES         -> {valid:false, reason:'token '+row.status}
 5. if row.expires_at && now >= expires_at    -> {valid:false, reason:'token expired'}
 6. if operation ∉ row.allowed_operations && '*' ∉ row.allowed_operations
                                              -> {valid:false, reason:'operation not allowed'}
 7. if !resourceMatches(row.target_resource, resource)  // exact id | 'type:'+type | '*'
                                              -> {valid:false, reason:'resource mismatch'}
 8. if row.scope.institutionId && ctx.institutionId && they differ
                                              -> {valid:false, reason:'institution scope'}
 9. if row.scope.timeWindow && hour(now) outside window
                                              -> {valid:false, reason:'time scope'}
10. -> {valid:true, reason:'ok', token: toCapabilityToken(row)}
```
No cache: on serverless each request re-reads the row, so revocation is visible on the **next** request with zero propagation delay (see §7).

### 5.6 `delegateToken()` — authority only narrows (spec Ch. 24 §10)
```
delegateToken(parentToken, delegatorUserId, sub):
 1. v := validateToken(parentToken, {operation: sub.allowedOperations[0], resource:{}})
 2. if !v.valid                              -> throw 'parent token invalid'
 3. parent := v.token
 4. if parent.delegationDepth <= 0           -> throw 'delegation depth exhausted'
 5. if !subset(sub.allowedOperations, parent.allowedOperations) // unless parent has '*'
                                             -> throw 'cannot widen operations'
 6. target := sub.targetResource ?? parent.targetResource
    if !resourceNarrowerOrEqual(target, parent.targetResource) -> throw 'cannot widen resource'
 7. exp := min(sub.expiresAt ?? parent.expiresAt, parent.expiresAt)
 8. secret := generateTokenSecret()
 9. INSERT rbac_capability_tokens { owner_identity: sub.ownerIdentity, issued_by: delegatorUserId,
      target_resource: target, allowed_operations: sub.allowedOperations,
      scope: {...parent.scope, ...sub.scope}, delegated_from: parent.tokenId,
      delegation_depth: parent.delegationDepth - 1, status:'delegated',
      secret_hash: hexSha256(secret), expires_at: exp }
10. return { tokenId, token: secret }        // secret shown once
```

### 5.7 `revokeToken()` — immediate, cascading (spec Ch. 24 §13)
```
revokeToken(tokenId, {cascade=true}):
   ids := cascade ? descendantsOf(tokenId) ++ [tokenId] : [tokenId]
   // descendantsOf via recursive walk of delegated_from
   UPDATE rbac_capability_tokens SET status='revoked', updated_at=NOW()
     WHERE token_id = ANY(ids) AND status IN ('issued','activated','delegated')
   return rowCount
```

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20). Steps 1–10 done; `rbac.test.ts` **40/40** (incl. all Block 10 scenarios), `rbac-ui.test.ts` **18/18** (no regression), `astro check` reports **zero errors** in Block 10 files (repo error count unchanged at 184). Step 11 (wiring `canObject` into live endpoints) deferred — the guard is exported and ready to adopt, but flipping a live mutation endpoint onto per-object ACLs warrants its own review. Engine `Decision.stage` values changed from pipeline-step names to `PolicyTier` names; no caller asserted on the old strings.

1. [x] `rbacCapabilityTokens` + `RBAC_TOKENS_DDL` added to `schema.ts`; `ensureRbacSchema()` now runs `[...RBAC_DDL, ...RBAC_TOKENS_DDL]`.
2. [x] `CapabilityScope`, `CapabilityToken`, `CAPABILITY_TOKEN_STATES`, `TOKEN_TRANSITIONS`, `LIVE_TOKEN_STATES`, `TokenValidation`, `Principal.capabilityTokens`, `ResourceRef.flags`, and zod schemas added to `types.ts`.
3. [x] `src/lib/rbac/tokens.ts`: `generateTokenSecret`/`hashTokenSecret` (oslo, like `session.ts`), `issueToken`, `validateToken`, `resolveToken`, `delegateToken`, `revokeToken`, `listTokens` + pure matchers (`tokenCovers`, `resourceMatches`, `scopeMatches`, `opsSubset`, `resourceNarrowerOrEqual`).
4. [x] `src/lib/rbac/objectAcl.ts`: `aclToGrants` (pure), `resolveInheritedGrants` (BFS up `part_of`), `canObject`.
5. [x] `src/lib/rbac/policy.ts`: `POLICY_TIERS`, `PolicyTier`, `KERNEL_LOCK_FLAG`, `MAX_INHERITANCE_DEPTH`.
6. [x] `engine.ts` rewritten to the 8-tier ladder: kernel-lock Tier 0, explicit-deny Tier 1 (beats administer), admin Tier 2, explicit-grant Tier 3, capability-token Tier 4, inherited Tier 5, role-default Tier 6, default-deny Tier 7. Stays pure.
7. [x] `store.ts` `resolvePrincipal(user, presentedTokens?)` attaches live bearer tokens via `resolveToken`.
8. [x] `POST /api/rbac/check` and `POST /api/admin/rbac/tokens` (`issue|delegate|revoke|list`, gated by `requireCapability(user,'delegate',{type:'rbac'})`).
9. [x] New surface exported from `src/lib/rbac/index.ts`.
10. [x] `rbac.test.ts` extended: deny-beats-admin, kernel-lock Tier 0, ACL reconciliation (ACL allow works / central deny overrides it), token Tier 4, tokenCovers edge cases (expired/suspended/scope), delegation-narrowing matchers.
11. [ ] **Deferred** — wire `canObject()` into live call sites (e.g. `src/pages/api/admin/knowledge.ts`). Guard is ready; adoption is a separate reviewed change.

## 7. Reality checks & risks
- **In-memory permission cache is a metaphor** (spec Ch. 25 §13, Ch. 24 §15). Serverless functions are per-request and share no process memory, so a resident cache with cross-request invalidation does not exist. Realistic equivalent: **per-request memoization** (resolve the `Principal` and inherited grants once per request) and rely on Postgres for the source of truth. If evaluation latency becomes a problem, add an external cache (Vercel KV / Upstash Redis) keyed by `(userId, policyVersion)` with TTL — but note this **reintroduces** the invalidation problem the spec waves away. Default: no cache; correctness over latency.
- **"Immediate revocation visibility"** (§18, §15) is achievable but means *next-request*, not *in-flight*: an already-issued session/decision inside a running function is not interrupted. Revocation writes `status='revoked'`; the next `validateToken` DB read sees it. Acceptable for this product; true instantaneous revocation would need a resident enforcement layer we do not have.
- **Bearer capability tokens are security-sensitive.** The opaque secret is returned exactly once and only its `sha256` is stored (mirroring `auth/session.ts`). Never log the secret; the `token` field must never appear in `rbac_audit.context`. Delegated tokens must be transmitted over HTTPS only. **Human decision needed:** default token TTL and default `maxDelegationDepth` (proposed 0 = non-delegable unless explicitly requested).
- **`labelAdmits` / role→capability mapping is a minimal reasonable version.** The spec's context model (trust level, maintenance state, distributed node, tenant, active policies — §9) is broad; the engine implements identity, session, roles, ownership, security labels, time window, institution, location, and minor/guardian. Trust-level-adaptive and node/maintenance gating are **stubs on `EvalContext`** and out-of-scope until a concrete product rule exists. Flag for product owner.
- **ACL role→operation mapping (`publish → execute`) is an assumption.** `kernel_objects.permissions[]` uses `read|write|publish`, while the engine's operations are the 16 capabilities. The mapping in §5.3 is a reasonable default; if "publish" needs to be a first-class capability distinct from `execute`, register a `publish` capability and update the map. Decision needed.
- **Two RBAC systems coexist.** `src/lib/auth/permissions.ts` (legacy hiring/admin `can(user, 'applications.view')`, `userCanAccess`, `getViewableSectionKeys`) governs the `/admin` hiring surface and the `roles`/`rolePermissions`/`userRoleAssignments` tables; `src/lib/rbac/*` governs AquinTutor/kernel objects via `rbac_*` tables. Block 10 deliberately does **not** merge them (avoids a risky migration of live admin gating). The reconciliation point is `resolvePrincipal`, which already maps legacy `users.role` into an rbac role via `LEGACY_ROLE_MAP`. A full unification is a separate, larger migration — out of scope here.
- **Out of scope (spec drift):** post-quantum crypto, ABAC/ReBAC/Zero-Trust/risk-adaptive engines and "AI-assisted policy recommendations" (Ch. 25 §23), cross-cluster permission synchronization, and the "~255,000 LOC / 6,400 methods" estimate — these are aspirational. The delivered engine is the ABAC-ready contract (`RuleConditions` + `EvalContext` are the extension point) but ships none of those subsystems.
- **`recursive descendantsOf` and `part_of` BFS must be depth-bounded** (MAX_DEPTH = 8) to avoid unbounded queries on a malformed/cyclic edge set; the kernel object graph is expected acyclic but the guard must not assume it.
