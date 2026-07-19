// src/lib/rbac/tokens.ts — Block 10: capability tokens (delegated, scoped, revocable).
// The opaque bearer secret is returned exactly once at issue/delegate time; only its sha256
// is stored (mirrors auth/session.ts). Pure matchers (tokenCovers/resourceMatches/scopeMatches)
// are side-effect free so engine.ts can consult already-validated tokens without any DB.
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';
import { randomBytes } from 'node:crypto';
import { registerCapability, type Capability } from './capabilities';
import {
  LIVE_TOKEN_STATES, type CapabilityToken, type CapabilityScope, type TokenValidation, type EvalContext,
} from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}
let ready = false;
async function ensure() {
  if (ready) return;
  const { db, sql } = await ctx();
  const { RBAC_TOKENS_DDL } = await import('./schema');
  for (const ddl of RBAC_TOKENS_DDL) await db.execute(sql.raw(ddl));
  ready = true;
}

// ---- crypto (same primitives as auth/session.ts) ----
/** Opaque bearer secret (base32, 20 random bytes). Returned to the caller ONCE. */
export function generateTokenSecret(): string {
  return encodeBase32LowerCaseNoPadding(randomBytes(20));
}
export function hashTokenSecret(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

// ---- pure matchers (no I/O; used by engine Tier 4 and by validateToken) ----
export function resourceMatches(target: string, resource: { id?: string; type?: string }): boolean {
  if (target === '*') return true;
  if (target.startsWith('type:')) return target.slice(5) === resource.type;
  return target === resource.id;
}
export function scopeMatches(scope: CapabilityScope, ctx?: EvalContext, now?: Date): boolean {
  if (scope.institutionId && ctx?.institutionId && scope.institutionId !== ctx.institutionId) return false;
  if (scope.timeWindow) {
    const h = (now ?? new Date()).getHours();
    const { startHour = 0, endHour = 24 } = scope.timeWindow;
    if (h < startHour || h >= endHour) return false;
  }
  return true;
}
/** True iff a live, unexpired token authorizes (operation, resource, scope). Pure. */
export function tokenCovers(t: CapabilityToken, cap: Capability, resource: { id?: string; type?: string }, ctx?: EvalContext): boolean {
  if (!LIVE_TOKEN_STATES.includes(t.status)) return false;
  if (t.expiresAt && Date.now() >= Date.parse(t.expiresAt)) return false;
  if (!t.allowedOperations.includes(cap) && !t.allowedOperations.includes('*' as Capability)) return false;
  if (!resourceMatches(t.targetResource, resource)) return false;
  if (!scopeMatches(t.scope, ctx)) return false;
  return true;
}
/** Delegation may only NARROW: child ops ⊆ parent ops (unless parent is '*'). */
export function opsSubset(child: Capability[], parent: Capability[]): boolean {
  if (parent.includes('*' as Capability)) return true;
  const set = new Set(parent);
  return child.every((op) => set.has(op));
}
/** child resource must be narrower-or-equal to parent's. */
export function resourceNarrowerOrEqual(child: string, parent: string): boolean {
  if (parent === '*') return true;
  if (parent.startsWith('type:')) return child === parent || (!child.startsWith('type:') && child !== '*');
  return child === parent;   // parent is a concrete id -> child must equal it
}

function rowToToken(r: any): CapabilityToken {
  return {
    tokenId: r.token_id, ownerIdentity: r.owner_identity, issuedBy: r.issued_by ?? null,
    targetResource: r.target_resource, allowedOperations: (r.allowed_operations ?? []) as Capability[],
    scope: (r.scope ?? {}) as CapabilityScope, delegatedFrom: r.delegated_from ?? null,
    delegationDepth: Number(r.delegation_depth), status: r.status, version: Number(r.version),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}

// ---- DB operations ----
export async function issueToken(
  input: {
    ownerIdentity: string; targetResource: string; allowedOperations: Capability[];
    scope?: CapabilityScope; maxDelegationDepth?: number; expiresAt?: string | null; reason?: string;
  },
  issuedBy: string | null,
): Promise<{ tokenId: string; token: string }> {
  await ensure();
  const { db, sql } = await ctx();
  for (const op of input.allowedOperations) if (op !== '*') registerCapability(op);
  const secret = generateTokenSecret();
  const r = rows(await db.execute(sql`INSERT INTO rbac_capability_tokens
    (owner_identity, issued_by, target_resource, allowed_operations, scope, delegated_from, delegation_depth, status, secret_hash, reason, expires_at)
    VALUES (${input.ownerIdentity}, ${issuedBy}, ${input.targetResource}, ${input.allowedOperations as any},
            ${JSON.stringify(input.scope ?? {})}::jsonb, ${null}, ${input.maxDelegationDepth ?? 0}, 'issued',
            ${hashTokenSecret(secret)}, ${input.reason ?? null}, ${input.expiresAt ?? null})
    RETURNING token_id`));
  return { tokenId: r[0].token_id, token: secret };
}

export async function validateToken(
  token: string,
  need: { operation: Capability; resource: { id?: string; type?: string }; ctx?: EvalContext },
): Promise<TokenValidation> {
  await ensure();
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT * FROM rbac_capability_tokens WHERE secret_hash = ${hashTokenSecret(token)} LIMIT 1`))[0];
  if (!r) return { valid: false, reason: 'invalid token' };
  const t = rowToToken(r);
  if (!LIVE_TOKEN_STATES.includes(t.status)) return { valid: false, reason: `token ${t.status}` };
  if (t.expiresAt && Date.now() >= Date.parse(t.expiresAt)) return { valid: false, reason: 'token expired' };
  if (!t.allowedOperations.includes(need.operation) && !t.allowedOperations.includes('*' as Capability)) {
    return { valid: false, reason: 'operation not allowed' };
  }
  if (!resourceMatches(t.targetResource, need.resource)) return { valid: false, reason: 'resource mismatch' };
  if (!scopeMatches(t.scope, need.ctx)) return { valid: false, reason: 'scope mismatch' };
  return { valid: true, reason: 'ok', token: t };
}

/** Resolve a bearer secret to its token if it is live+unexpired (no op/resource filtering).
 *  Used to attach presented tokens to a Principal; the engine does op/resource/scope matching. */
export async function resolveToken(token: string): Promise<CapabilityToken | null> {
  await ensure();
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT * FROM rbac_capability_tokens WHERE secret_hash = ${hashTokenSecret(token)} LIMIT 1`))[0];
  if (!r) return null;
  const t = rowToToken(r);
  if (!LIVE_TOKEN_STATES.includes(t.status)) return null;
  if (t.expiresAt && Date.now() >= Date.parse(t.expiresAt)) return null;
  return t;
}

export async function delegateToken(
  parentToken: string,
  delegatorUserId: string,
  sub: {
    ownerIdentity: string; allowedOperations: Capability[]; targetResource?: string;
    scope?: CapabilityScope; expiresAt?: string | null; reason?: string;
  },
): Promise<{ tokenId: string; token: string }> {
  const v = await validateToken(parentToken, { operation: sub.allowedOperations[0], resource: {} });
  if (!v.valid || !v.token) throw new Error(`parent token invalid: ${v.reason}`);
  const parent = v.token;
  if (parent.delegationDepth <= 0) throw new Error('delegation depth exhausted');
  if (!opsSubset(sub.allowedOperations, parent.allowedOperations)) throw new Error('cannot widen operations');
  const target = sub.targetResource ?? parent.targetResource;
  if (!resourceNarrowerOrEqual(target, parent.targetResource)) throw new Error('cannot widen resource');
  const exp = ((): string | null => {
    const p = parent.expiresAt ? Date.parse(parent.expiresAt) : Infinity;
    const s = sub.expiresAt ? Date.parse(sub.expiresAt) : Infinity;
    const m = Math.min(p, s);
    return Number.isFinite(m) ? new Date(m).toISOString() : null;
  })();
  await ensure();
  const { db, sql } = await ctx();
  for (const op of sub.allowedOperations) if (op !== '*') registerCapability(op);
  const secret = generateTokenSecret();
  const r = rows(await db.execute(sql`INSERT INTO rbac_capability_tokens
    (owner_identity, issued_by, target_resource, allowed_operations, scope, delegated_from, delegation_depth, status, secret_hash, reason, expires_at)
    VALUES (${sub.ownerIdentity}, ${delegatorUserId}, ${target}, ${sub.allowedOperations as any},
            ${JSON.stringify({ ...parent.scope, ...(sub.scope ?? {}) })}::jsonb, ${parent.tokenId}, ${parent.delegationDepth - 1},
            'delegated', ${hashTokenSecret(secret)}, ${sub.reason ?? null}, ${exp})
    RETURNING token_id`));
  return { tokenId: r[0].token_id, token: secret };
}

export async function revokeToken(tokenId: string, opts: { cascade?: boolean } = {}): Promise<number> {
  await ensure();
  const { db, sql } = await ctx();
  const cascade = opts.cascade !== false;   // default true
  let ids = [tokenId];
  if (cascade) {
    let frontier = [tokenId];
    for (let depth = 0; depth < 32 && frontier.length; depth++) {
      const kids = rows(await db.execute(sql`SELECT token_id FROM rbac_capability_tokens WHERE delegated_from = ANY(${frontier as any})`)).map((x: any) => x.token_id);
      const fresh = kids.filter((k: string) => !ids.includes(k));
      ids = [...ids, ...fresh];
      frontier = fresh;
    }
  }
  const res = await db.execute(sql`UPDATE rbac_capability_tokens SET status='revoked', updated_at=NOW()
    WHERE token_id = ANY(${ids as any}) AND status IN ('issued','activated','delegated')`);
  return (res as any)?.rowCount ?? rows(res).length ?? ids.length;
}

/** Live tokens a subject holds (secrets are never returned). */
export async function listTokens(ownerIdentity: string): Promise<CapabilityToken[]> {
  await ensure();
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM rbac_capability_tokens
    WHERE owner_identity = ${ownerIdentity} AND status IN ('issued','activated','delegated') ORDER BY created_at DESC`)).map(rowToToken);
}
