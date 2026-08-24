// src/lib/rbac/guard.ts — enforcement. `enforce()` is the testable core: evaluate + audit
// with an injectable sink. `can()` / `requireCapability()` / `requireAdminRole()` are the
// DB-facing helpers every protected Astro endpoint/page uses (they resolve the principal
// from the existing auth `locals.user` and write the audit row).
import { evaluate } from './engine';
import { ADMIN_ROLE_KEYS } from './roles';
import type { Capability } from './capabilities';
import type { Principal, ResourceRef, EvalContext, Decision } from './types';
// db-timeout.ts imports nothing and touches no driver, so this file stays free of the database at
// module scope — which is the whole reason the bound lives there and not in src/lib/db/index.ts.
import { withDbRetry, withDbTimeout, DB_TRY_MS } from '@/lib/db-timeout';

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
//
// ONE PRINCIPAL PER REQUEST, AND A BOUND ON WAITING FOR IT.
//
// What this cost before. resolvePrincipal() caches nothing — only the role graph is memoised
// (store.ts) — so every can() issued three SELECTs of its own: rbac_user_roles, then
// rbac_permission_grants, then rbac_guardian_links. A page that asks more than once paid all three
// again each time: the lesson view (src/pages/aquintutor/lesson/[id].astro) asks once per attached
// assessment on top of the runtime's own read/write pair, which is four resolutions of the same
// unchanged principal in one render — twelve statements for one person's roles.
//
// AND NONE OF THOSE WAITS WAS BOUNDED. That is the failure this pass is about: on this deployment
// opening a connection costs ~810ms when it works and a share of attempts never answer at all, so an
// unbounded resolvePrincipal did not fail — it hung, and the platform, not the page, decided what
// the visitor saw (FUNCTION_INVOCATION_TIMEOUT, no log line naming a cause).
//
// Bounding it does NOT open the gate. A timed-out resolution returns a principal with
// contextDegraded set, which is exactly what store.ts returns when it cannot read the grants, and
// the engine turns that into a Tier-0 denial (engine.ts). The availability cost is the one already
// stated there and accepted: while the permission tables are unreadable this gate refuses everyone,
// including the founder. The change is only that it refuses in seconds with a loggable reason
// instead of hanging the invocation.
//
// THE MEMO IS PER REQUEST BY CONSTRUCTION, NOT BY CONVENTION: the key is the `user` OBJECT that
// middleware assigns fresh on every request (src/middleware.ts), so a WeakMap keyed on it cannot
// leak between requests and needs no invalidation. The short TTL is a second belt for the one shape
// that holds a single user object open for a long time — a streaming endpoint — where a principal
// resolved minutes ago should not still be answering for a role that has since been revoked.
const PRINCIPAL_MEMO_MS = 5000;
const principalByUser = new WeakMap<object, { at: number; p: Promise<Principal> }>();

/** Resolve the principal with a bounded wait. Never rejects: a timeout is a DEGRADED principal. */
async function resolveBounded(user: any): Promise<Principal> {
  const { resolvePrincipal } = await import('./store');
  try {
    // A read, and only a read — three SELECTs, no write — so the single retry withDbRetry makes on a
    // timeout is safe here. It is also the right shape for the measured failure: what fails is
    // opening a connection, not answering the query, so asking again beats waiting longer, and it is
    // what src/middleware.ts already does at its own gates on this same per-request path.
    // The breaker caps what the second ask can cost on an endpoint that is polled every few seconds:
    // after three consecutive timeouts every further resolution is refused without sending a
    // statement at all, so this cannot turn a struggling database into a stampede.
    return await withDbRetry(() => resolvePrincipal(user), 'rbac.principal');
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[rbac] principal context did not answer -', e?.cause?.message || e?.message);
    // sessionValid stays true and userId is kept on purpose: the engine has separate Tier-0 reasons
    // for "no identity" and "session invalid or expired", and an audit row that misnames an outage
    // as a stale session sends whoever reads it to the wrong system.
    return { userId: user?.id ?? null, sessionValid: true, contextDegraded: true, roles: [], capabilities: new Set<Capability>() };
  }
}

function principalFor(user: any): Promise<Principal> {
  const key: any = user && typeof user === 'object' && user.id ? user : null;
  if (!key) return resolveBounded(user);   // guest / synthetic caller: nothing stable to key on
  const hit = principalByUser.get(key);
  if (hit && Date.now() - hit.at < PRINCIPAL_MEMO_MS) return hit.p;
  const p = resolveBounded(user);
  principalByUser.set(key, { at: Date.now(), p });
  return p;
}

/**
 * The audit sink for every helper below, with the WAIT bounded and nothing made fire-and-forget.
 *
 * `void writeAudit(...)` would be the obvious way to get this INSERT off the hot path and it is
 * wrong here: on this platform the instance can be frozen the moment the response is returned, so
 * the row would silently never land and enforce()'s contract — exactly one audit row per decision —
 * would quietly become "usually one row". writeAudit() already swallows its own errors, so the only
 * thing this adds is a ceiling on how long a decision may wait for its own paper trail.
 *
 * When that ceiling is hit the entry is written to the server log instead, in full. The row may
 * still land (withDbTimeout sheds the wait, not the work) — but a decision that goes unrecorded in
 * both places is not something an authorization gate may do quietly.
 */
const auditToDb: AuditSink = async (e: AuditEntry) => {
  const { writeAudit } = await import('./store');
  try {
    await withDbTimeout(writeAudit(e), 'rbac.audit', DB_TRY_MS);
  } catch (err: any) {
    console.error(JSON.stringify({
      ts: e.at, level: 'error', event: 'rbac.audit.unwritten',
      userId: e.userId, capability: e.capability, resource: e.resource, allow: e.allow,
      reason: e.reason, stage: e.stage, why: err?.name || 'unknown',
    }));
  }
};

export async function can(user: any, cap: Capability, res: ResourceRef = {}, ctx: EvalContext = {}): Promise<Decision> {
  const p = await principalFor(user);
  return enforce(p, cap, res, ctx, auditToDb);
}

/**
 * Was this request's permission context readable at all?
 *
 * For surfaces that must not report a denial as though it were a fact about the CONTENT or the
 * person. A lesson that says "locked" and a lesson whose permissions could not be read look
 * identical in a Decision — both are `allow: false` — and telling a student the material is above
 * their clearance when the truth is that our database did not answer is a claim we cannot support.
 *
 * Writes no audit row: it decides nothing and grants nothing, it only reports why a decision that
 * was already made and already audited came out the way it did. Free on any request that has
 * already asked can() once, because it reads the same memoised principal.
 */
export async function permissionContextDegraded(user: any): Promise<boolean> {
  return (await principalFor(user)).contextDegraded === true;
}

/** Throws ForbiddenError when denied (for endpoints/actions). */
export async function requireCapability(user: any, cap: Capability, res: ResourceRef = {}, ctx: EvalContext = {}): Promise<Decision> {
  const d = await can(user, cap, res, ctx);
  if (!d.allow) throw new ForbiddenError(d);
  return d;
}
/** True if the user holds ANY admin-surface role (or superadmin). Audited via can('read'). */
export async function requireAdminRole(user: any): Promise<boolean> {
  const p = await principalFor(user);
  // THE ONLY DECISION IN THIS FILE THAT DOES NOT GO THROUGH evaluate(), so the Tier-0 refusal the
  // engine now makes for an unresolved permission context has to be repeated here or this function
  // becomes the way around it. `p.roles` after a failed read is the LEGACY_ROLE_MAP guess alone,
  // which is precisely the shadow answer store.ts stopped returning: admitting on it would let a
  // database outage hand two admin pages to whoever a stale session claims to be.
  const isAdmin = p.contextDegraded !== true && p.roles.some((r) => ADMIN_ROLE_KEYS.includes(r));
  await auditToDb({
    userId: p.userId, capability: 'read', resource: 'admin:surface', allow: isAdmin,
    reason: p.contextDegraded === true
      ? 'permission context could not be resolved'
      : (isAdmin ? 'holds an admin-surface role' : 'no admin-surface role'),
    stage: 'verify-authorization',
    matchedGrant: null, context: { roles: p.roles, contextDegraded: p.contextDegraded === true }, at: new Date().toISOString(),
  });
  return isAdmin;
}
