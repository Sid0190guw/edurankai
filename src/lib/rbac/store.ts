// src/lib/rbac/store.ts — DB layer for the permission engine. Self-bootstraps + seeds,
// resolves a Principal from the EXISTING auth user (locals.user), writes audit rows, and
// drives permission-grant lifecycle. Built ON TOP of the existing auth/session — it never
// touches login, sessions, users, team_roles, or user_role_assignments.
import { CORE_CAPABILITIES, type Capability } from './capabilities';
import { SEED_ROLES, resolveRoleCapabilities, type SeedRole } from './roles';
import { RBAC_DDL, RBAC_TOKENS_DDL } from './schema';
import { assertPermissionTransition, type CapabilityToken, type PermissionGrant, type PermissionState, type Principal } from './types';
import type { AuditEntry } from './guard';
import { textIn } from '@/lib/pg-array';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// Map the existing coarse users.role enum onto an education RBAC role so current users keep
// working without any new assignment. Admins refine via the (2b) management UI.
const LEGACY_ROLE_MAP: Record<string, string> = {
  super_admin: 'superadmin', applicant: 'applicant', editor: 'content_author', hr: 'support',
};

let bootstrapped = false;
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

export async function ensureRbacSchema(): Promise<void> {
  if (bootstrapped) return;
  const { db, sql } = await ctx();
  for (const ddl of [...RBAC_DDL, ...RBAC_TOKENS_DDL]) await db.execute(sql.raw(ddl));
  bootstrapped = true;
}

/** Idempotently seed capabilities + roles + role_capabilities from the code roster. */
export async function seedRbac(): Promise<{ roles: number; capabilities: number }> {
  await ensureRbacSchema();
  const { db, sql } = await ctx();
  for (const c of CORE_CAPABILITIES) {
    await db.execute(sql`INSERT INTO rbac_capabilities (key) VALUES (${c}) ON CONFLICT (key) DO NOTHING`);
  }
  for (const r of SEED_ROLES) {
    await db.execute(sql`INSERT INTO rbac_roles (key, surface, description, color, is_system, inherits)
      VALUES (${r.key}, ${r.surface}, ${r.description}, ${r.color || 'orange'}, true, ${r.inherits ?? []})
      ON CONFLICT (key) DO NOTHING`);
    for (const cap of r.capabilities) {
      await db.execute(sql`INSERT INTO rbac_role_capabilities (role_key, capability) VALUES (${r.key}, ${cap}) ON CONFLICT DO NOTHING`);
    }
  }
  return { roles: SEED_ROLES.length, capabilities: CORE_CAPABILITIES.length };
}

/**
 * Load the role graph from the database.
 *
 * AN EMPTY TABLE AND AN UNREADABLE ONE ARE NOT THE SAME ANSWER, and they used to share a `catch`.
 * No rows means the module has not been seeded yet, and the code roster IS what seedRbac() would
 * write, so returning it is a correct bootstrap answer and stays. A failed READ means we do not know
 * what the roles grant — and falling back to the code roster there is fail-OPEN whenever an
 * administrator has since narrowed a role in the database, because a hiccup would silently restore
 * the capabilities they removed. That case now reports `degraded`, and the caller turns it into a
 * denial rather than a guess.
 */
async function loadRoleGraph(): Promise<{ graph: SeedRole[]; degraded: boolean }> {
  try {
    const { db, sql } = await ctx();
    const roleRows = rows(await db.execute(sql`SELECT key, surface, inherits FROM rbac_roles`));
    if (!roleRows.length) return { graph: SEED_ROLES, degraded: false };
    const capRows = rows(await db.execute(sql`SELECT role_key, capability FROM rbac_role_capabilities`));
    return {
      graph: roleRows.map((r: any) => ({
        key: r.key, surface: r.surface, description: '',
        inherits: r.inherits ?? [],
        capabilities: capRows.filter((c: any) => c.role_key === r.key).map((c: any) => c.capability as Capability),
      })),
      degraded: false,
    };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[rbac] role graph read failed', e?.cause?.message || e?.message);
    return { graph: SEED_ROLES, degraded: true };
  }
}

/** Resolve a full Principal from the existing auth user object (locals.user) or null.
 *  `presentedTokens` (e.g. from an `x-capability-token` header) are validated and the live
 *  ones attached to `Principal.capabilityTokens` for engine Tier 4. */
export async function resolvePrincipal(user: any, presentedTokens: string[] = []): Promise<Principal> {
  const loaded = await loadRoleGraph();
  const graph = loaded.graph;
  // THE ONE FLAG. Any source that did not answer sets it, and the engine denies at Tier 0. See the
  // note on Principal.contextDegraded in ./types.ts for why a partial read cannot be evaluated.
  let contextDegraded = loaded.degraded;
  const capsFor = (keys: string[]) => {
    const s = new Set<Capability>();
    for (const k of keys) for (const c of resolveRoleCapabilities(k, graph)) s.add(c);
    return s;
  };

  if (!user?.id) {
    return { userId: null, sessionValid: true, contextDegraded, roles: ['guest'], capabilities: capsFor(['guest']) };
  }

  const userId: string = user.id;
  let roleKeys: string[] = [];
  let stage: string | null = user.stage ?? null;
  let grants: PermissionGrant[] = [];
  let hasGuardian = false;

  const legacy = LEGACY_ROLE_MAP[user.role as string];
  if (legacy) roleKeys.push(legacy);

  try {
    await ensureRbacSchema();
    const { db, sql } = await ctx();
    const ur = rows(await db.execute(sql`SELECT role_key, stage FROM rbac_user_roles WHERE user_id = ${userId}`));
    for (const r of ur) { roleKeys.push(r.role_key); if (r.role_key === 'student' && r.stage) stage = r.stage; }
    const roleIdents = roleKeys.map((k) => `role:${k}`);
    const g = rows(await db.execute(sql`SELECT * FROM rbac_permission_grants WHERE identity_ref = ${userId} OR identity_ref IN ${textIn(roleIdents)}`));
    grants = g.map((r: any) => ({
      permissionId: r.permission_id, identityRef: r.identity_ref, resourceRef: r.resource_ref, operation: r.operation,
      effect: r.effect, state: r.state, inheritancePolicy: r.inheritance_policy, conditions: r.conditions ?? {},
      priority: Number(r.priority), version: Number(r.version), flags: r.flags ?? [],
    }));
    const gl = rows(await db.execute(sql`SELECT 1 FROM rbac_guardian_links WHERE minor_user_id = ${userId} LIMIT 1`));
    hasGuardian = gl.length > 0;
  } catch (e: any) {
    // THE SHADOW PATH THAT USED TO LIVE HERE IS GONE. This catch read
    // `/* DB unreachable -> proceed with the legacy-mapped role only */` and did exactly that: it
    // kept the LEGACY_ROLE_MAP role and its inherited capabilities — super_admin maps to
    // 'superadmin', which carries `administer`, the engine's Tier-2 administrative override — while
    // throwing away every row of rbac_permission_grants.
    //
    // THAT WAS FAIL-OPEN IN THE ONE DIRECTION THAT MATTERS. rbac_permission_grants is where explicit
    // DENY grants live, and Tier 1 evaluates them before anything else specifically so a deny can
    // override `administer`. Dropping them meant a principal whose access had been NARROWED by a
    // deny grant was evaluated as though the deny had never been written — on a gate that stands in
    // front of real reads and writes through plugins/host.ts and security/authz.ts. Losing an ALLOW
    // was fail-closed and harmless; losing a DENY was a hole that opened exactly when the database
    // was least healthy.
    //
    // There is now one path and no fallback: unknown permission context is a denial, decided in the
    // engine so every caller inherits it and the audit row says what actually happened.
    //
    // THE COST IS REAL AND IS STATED. While this read is failing, every surface gated by this engine
    // refuses everyone, including the founder — the same trade canOpenAdmin() already makes for the
    // /admin door, and the direction AUTHORIZATION_FIRST names for a database timeout. It is an
    // availability cost, and it is the safe direction.
    contextDegraded = true;
    console.error('[rbac] principal context read failed', e?.cause?.message || e?.message);
  }

  if (!roleKeys.length) roleKeys = ['applicant'];   // signed-in but unassigned -> minimal role
  roleKeys = [...new Set(roleKeys)];

  // Attach any presented bearer capability tokens that validate as live (engine Tier 4).
  let capabilityTokens: CapabilityToken[] | undefined;
  if (presentedTokens.length) {
    try {
      const { resolveToken } = await import('./tokens');
      const live: CapabilityToken[] = [];
      for (const raw of presentedTokens) {
        const t = await resolveToken(raw);   // liveness/expiry only; engine matches op/resource/scope
        if (t) live.push(t);
      }
      if (live.length) capabilityTokens = live;
    } catch { /* token store unreachable -> no tokens attached */ }
  }

  return { userId, sessionValid: true, contextDegraded, roles: roleKeys, capabilities: capsFor(roleKeys), stage: stage as any, hasGuardian, grants, capabilityTokens };
}

export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    await ensureRbacSchema();
    const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO rbac_audit (user_id, capability, resource, allow, reason, stage, matched_grant, context, at)
      VALUES (${e.userId}, ${e.capability}, ${e.resource}, ${e.allow}, ${e.reason}, ${e.stage}, ${e.matchedGrant}, ${JSON.stringify(e.context)}::jsonb, ${e.at})`);
  } catch (err) { console.error('[rbac] audit write failed:', (err as any)?.cause?.message || (err as any)?.message); }
}

// ---- permission grant lifecycle ----
export async function createGrant(input: Omit<PermissionGrant, 'permissionId' | 'state' | 'version'> & { state?: PermissionState }): Promise<string> {
  await ensureRbacSchema();
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO rbac_permission_grants
    (identity_ref, resource_ref, operation, effect, state, inheritance_policy, conditions, priority, version, flags)
    VALUES (${input.identityRef}, ${input.resourceRef}, ${input.operation}, ${input.effect}, ${input.state ?? 'defined'},
            ${input.inheritancePolicy}, ${JSON.stringify(input.conditions || {})}::jsonb, ${input.priority}, 1, ${input.flags ?? []})
    RETURNING permission_id`));
  return r[0].permission_id;
}
export async function transitionGrant(permissionId: string, to: PermissionState): Promise<void> {
  await ensureRbacSchema();
  const { db, sql } = await ctx();
  const cur = rows(await db.execute(sql`SELECT state FROM rbac_permission_grants WHERE permission_id = ${permissionId} LIMIT 1`))[0];
  if (!cur) throw new Error('grant not found');
  assertPermissionTransition(cur.state, to);
  const bumpVersion = to === 'modified';
  await db.execute(sql`UPDATE rbac_permission_grants SET state = ${to}, updated_at = NOW()${bumpVersion ? sql`, version = version + 1` : sql``} WHERE permission_id = ${permissionId}`);
}
