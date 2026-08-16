// src/lib/mailgov/guard.ts — THE DOOR. Every governance route and console page comes through here.
//
// It does four things, in this order, and the order is the design:
//
//   1. RESOLVES WHO IS ASKING into a GovActor, by composing answers that already exist elsewhere in
//      this repository rather than inventing a second identity system.
//   2. ASKS ./policy.ts whether that actor may do this, to this tenant. Pure, testable, one place.
//   3. RECORDS THE REFUSAL when the answer is no — in the audit log AND as a security event. A
//      denial that leaves no trace is how a probe looks exactly like a mistyped URL.
//   4. RECORDS THE INTENT BEFORE THE WRITE HAPPENS for anything that changes state, and refuses to
//      perform the write if the audit could not be written. An action nobody can prove happened is
//      the one thing an enterprise administration console must not produce.
//
// HOW SOMEBODY BECOMES A GOVERNANCE ACTOR — five arms, cheapest and narrowest first, and each is an
// answer that already exists:
//
//   1. THE FOUNDER, by email. The same test src/lib/legal-hold.ts uses for held records, kept
//      identical on purpose so there is one answer to "who is the owner of last resort".
//   2. AN EXPLICIT PLATFORM GRANT (mailapi_platform_admins). This is how a support engineer or an
//      auditor exists at all — they need no EduRankAI admin role, and being a company super admin
//      does not make somebody a support engineer here.
//   3. `settings.edit` in the EduRankAI matrix — super_admin only today. This preserves the state of
//      the world before this patch: the people who already administer mail configuration continue to
//      administer the mail platform. Removing it would have locked the current administrators out of
//      a console built for them.
//   4. AN ACTIVE ORGANIZATION MEMBERSHIP, mapped through govRoleForMembership(). owner/admin become
//      a tenant-scoped org_admin; analyst becomes a tenant-scoped auditor; member and service get
//      nothing, because a membership row is not an administrative grant.
//   5. Otherwise nothing.
//
// IT FAILS CLOSED EVERYWHERE. A thrown lookup returns role 'none' and the reason is logged with the
// real Postgres message (e.cause — e.message is only the failed SQL). A database hiccup refuses an
// administrator; it never admits one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can } from '@/lib/auth/permissions';
import { logEvent } from '@/lib/logger';
import { ensureGovernanceSchema, rows, dbReason } from './schema';
import { recordAudit, AUDIT_ACTIONS } from './audit';
import {
  authorizeGov, govRoleForMembership, membershipIsActive,
  type GovActor, type GovCapability, type GovDecision, type GovRole, type GovTarget,
} from './policy';

// Declared before every function that uses them — `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down on this project.
const json = (d: any, status: number): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });

const NOBODY: GovActor = { userId: null, email: null, role: 'none', orgId: null, via: 'none' };

/** The founder address, resolved exactly as src/lib/legal-hold.ts resolves it. */
function founderEmail(): string {
  return (process.env.FOUNDER_EMAIL || 'siddharth@edurankai.in').toLowerCase();
}

const PLATFORM_GRANT_ROLES: GovRole[] = ['platform_admin', 'support', 'auditor'];

/**
 * Turn a signed-in EduRankAI user into a governance actor.
 *
 * `orgHint` narrows a PLATFORM actor to one organization for the duration of a request — used by the
 * tenant screens so a platform admin browsing one customer is scoped like a tenant while they are
 * there. It can only ever NARROW: a tenant-scoped actor passing a different org hint stays pinned to
 * their own, because the hint is applied after the membership arm, not before it.
 */
export async function resolveGovActor(
  user: { id?: string; email?: string | null; role?: string | null; isActive?: boolean } | null | undefined,
  orgHint?: string | null,
): Promise<GovActor> {
  if (!user?.id) return NOBODY;

  const email = (user.email || '').toLowerCase() || null;
  const narrow = (a: GovActor): GovActor =>
    (a.orgId === null && orgHint) ? { ...a, orgId: orgHint } : a;

  // 1. The founder.
  if (email && email === founderEmail()) {
    return narrow({ userId: user.id, email, role: 'platform_owner', orgId: null, via: 'founder' });
  }

  // 2. An explicit platform grant.
  try {
    await ensureGovernanceSchema();
    const g = rows(await db.execute(sql`
      SELECT role FROM mailapi_platform_admins
       WHERE user_id = ${user.id}::uuid AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`))[0];
    const granted = String(g?.role || '') as GovRole;
    if (granted && PLATFORM_GRANT_ROLES.includes(granted)) {
      return narrow({ userId: user.id, email, role: granted, orgId: null, via: 'platform-grant' });
    }
  } catch (e: any) {
    // Fails closed by falling through, and says so. A grant lookup that did not run must not admit
    // anybody, and must not be silent about why they were refused.
    logEvent('error', 'mailgov.actor.grant-lookup-failed', { userId: user.id, message: dbReason(e) });
  }

  // 3. The EduRankAI permission that already governs mail configuration.
  if (can(user as any, 'settings.edit')) {
    return narrow({ userId: user.id, email, role: 'platform_admin', orgId: null, via: 'admin-permission' });
  }

  // 4. An active organization membership.
  try {
    const m = rows(await db.execute(sql`
      SELECT org_id, role, status FROM mailapi_org_members
       WHERE user_id = ${user.id}::uuid AND removed_at IS NULL
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'analyst' THEN 2 ELSE 3 END
       LIMIT 1`))[0];
    if (m && membershipIsActive(String(m.status))) {
      const role = govRoleForMembership(String(m.role));
      if (role !== 'none') {
        return { userId: user.id, email, role, orgId: String(m.org_id), via: 'org-membership' };
      }
    }
  } catch (e: any) {
    logEvent('error', 'mailgov.actor.membership-lookup-failed', { userId: user.id, message: dbReason(e) });
  }

  return { ...NOBODY, userId: user.id, email };
}

/** Every organization a platform actor may switch between, or the one a tenant actor is pinned to. */
export async function organizationsFor(actor: GovActor): Promise<{ id: string; slug: string; name: string }[]> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT id, slug, name FROM mailapi_orgs
       WHERE ${actor.orgId ? sql`id = ${actor.orgId}::uuid` : sql`TRUE`}
       ORDER BY name ASC LIMIT 500`);
    return rows(r).map((x: any) => ({ id: String(x.id), slug: String(x.slug), name: String(x.name) }));
  } catch (e: any) {
    logEvent('error', 'mailgov.orgs.read-failed', { message: dbReason(e) });
    return [];
  }
}

export interface RequestFacts {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * What we know about the call, for the audit row.
 *
 * The request id is generated when the platform edge did not supply one, so every audit event has a
 * correlation handle — a support conversation that cannot name a specific request ends up quoting the
 * recipient's address instead, which is the disclosure the id exists to avoid.
 */
export function requestFacts(request: Request | null | undefined): RequestFacts {
  const h = request?.headers;
  const fwd = h?.get('x-forwarded-for') || '';
  return {
    ip: (fwd.split(',')[0] || h?.get('x-real-ip') || '').trim() || null,
    userAgent: h?.get('user-agent') || null,
    requestId: h?.get('x-request-id') || h?.get('x-vercel-id') || 'gov_' + Math.random().toString(36).slice(2, 12),
  };
}

export interface GovGate {
  actor: GovActor;
  decision: GovDecision;
  facts: RequestFacts;
}

/**
 * Decide, and RECORD THE REFUSAL if it is one.
 *
 * A denial writes two rows: an audit event (so the tenant's own administrators can see that somebody
 * was refused something on their organization) and a security event (so the platform can see a
 * pattern across tenants). They answer different questions and neither substitutes for the other.
 */
export async function gate(
  user: any,
  cap: GovCapability,
  target: GovTarget,
  request?: Request | null,
  orgHint?: string | null,
): Promise<GovGate> {
  const actor = await resolveGovActor(user, orgHint);

  // A TENANT ACTOR WHO NAMED NO ORGANIZATION MEANT THEIR OWN — there is no other answer available to
  // them. policy.ts stays strict about this on purpose (a missing orgId from a PLATFORM caller is a
  // call site that forgot to pass one, and answering it would sweep every tenant), but the policy
  // module has no actor to fall back on. The guard does, so the substitution belongs here.
  //
  // This cannot widen anything: the value substituted is the actor's own organization, which is the
  // only one they may reach, and a target naming a DIFFERENT organization is left untouched and
  // refused as cross-tenant. Without it, an organization administrator opening the console overview
  // was refused their own front page.
  const scoped: GovTarget = (actor.orgId && !target.orgId && !target.platformWide)
    ? { ...target, orgId: actor.orgId }
    : target;

  const decision = authorizeGov(actor, cap, scoped);
  const facts = requestFacts(request);

  if (!decision.allowed) {
    // Neither write may take the refusal down with it: the caller is being refused either way, and a
    // logging failure must not turn a 403 into a 500 that reads like a bug in the console.
    try {
      await recordAudit({
        actor, action: AUDIT_ACTIONS.ACCESS_DENIED,
        orgId: scoped.orgId ?? actor.orgId ?? null,
        targetType: 'capability', targetId: cap,
        result: 'denied', reason: decision.code + ': ' + decision.reason,
        meta: { capability: cap, target: { orgId: scoped.orgId ?? null, userId: scoped.userId ?? null } },
        ip: facts.ip, userAgent: facts.userAgent, requestId: facts.requestId,
      });
    } catch (e: any) {
      logEvent('error', 'mailgov.deny.audit-failed', { message: dbReason(e) });
    }
    try {
      const { recordSecurityEvent } = await import('./security-events');
      await recordSecurityEvent({
        type: decision.code === 'role-escalation' || decision.code === 'peer-or-above'
          ? 'permission.escalation_refused'
          : 'admin.access_denied',
        orgId: scoped.orgId ?? actor.orgId ?? null,
        subject: actor.email,
        actorUserId: actor.userId,
        ip: facts.ip, userAgent: facts.userAgent, requestId: facts.requestId,
        detail: { capability: cap, code: decision.code, role: actor.role },
      });
    } catch (e: any) {
      logEvent('error', 'mailgov.deny.security-event-failed', { message: dbReason(e) });
    }

    logEvent('warn', 'mailgov.refused', {
      capability: cap, code: decision.code, role: actor.role,
      userId: actor.userId, orgId: scoped.orgId ?? null,
    });
  }

  return { actor, decision, facts };
}

/**
 * The API-route form. Returns a Response to send, or null to continue.
 *
 *   const g = await requireGov(locals, 'org.suspend', { orgId }, request);
 *   if (g.denied) return g.denied;
 *   // g.actor is authorized from here on
 *
 * 401 when nobody is signed in, 403 for everything else. The body names the capability that was
 * missing ONLY for an authenticated actor who holds a governance role — telling an anonymous caller
 * which capability they lack is telling them what to go looking for.
 */
export async function requireGov(
  locals: any,
  cap: GovCapability,
  target: GovTarget = {},
  request?: Request | null,
  orgHint?: string | null,
): Promise<{ denied: Response | null; actor: GovActor; facts: RequestFacts }> {
  const g = await gate(locals?.user, cap, target, request, orgHint);
  if (g.decision.allowed) return { denied: null, actor: g.actor, facts: g.facts };

  const anonymous = g.decision.code === 'not-authenticated';
  return {
    denied: json(
      anonymous
        ? { ok: false, error: 'unauthorized' }
        : { ok: false, error: 'forbidden', code: g.decision.code, reason: g.decision.reason },
      anonymous ? 401 : 403,
    ),
    actor: g.actor,
    facts: g.facts,
  };
}

export interface AuditedResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  auditId?: string;
}

/**
 * PERFORM A STATE CHANGE, WITH THE RECORD WRITTEN FIRST.
 *
 * The audit event goes in BEFORE the mutation runs. If it cannot be written, the mutation does not
 * happen and the caller is told why — which is the only ordering that cannot produce an action
 * nobody can prove happened. The alternative (act, then log) fails in exactly the case that matters:
 * the log write is the one that failed, the change is already made, and there is no record of who
 * made it.
 *
 * If the work then throws, a SECOND event is appended with result 'failed' and the reason. So the
 * log reads "authorised and attempted" followed by "failed", which is what actually happened —
 * rather than a success event for something that did not succeed.
 */
export async function auditedWrite<T>(
  call: {
    actor: GovActor;
    action: string;
    orgId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    reason?: string | null;
    meta?: Record<string, unknown>;
    facts?: RequestFacts;
  },
  work: () => Promise<T>,
): Promise<AuditedResult<T>> {
  const write = await recordAudit({
    actor: call.actor,
    action: call.action,
    orgId: call.orgId ?? call.actor.orgId ?? null,
    targetType: call.targetType ?? null,
    targetId: call.targetId ?? null,
    result: 'ok',
    reason: call.reason ?? null,
    meta: call.meta || {},
    ip: call.facts?.ip ?? null,
    userAgent: call.facts?.userAgent ?? null,
    requestId: call.facts?.requestId ?? null,
  });

  if (!write.ok) {
    return {
      ok: false,
      error: 'This action was not performed, because it could not be recorded in the audit log: '
        + (write.error || 'unknown reason') + '. Nothing has changed.',
    };
  }

  try {
    const data = await work();
    return { ok: true, data, auditId: write.id };
  } catch (e: any) {
    const reason = dbReason(e);
    await recordAudit({
      actor: call.actor,
      action: call.action,
      orgId: call.orgId ?? call.actor.orgId ?? null,
      targetType: call.targetType ?? null,
      targetId: call.targetId ?? null,
      result: 'failed',
      reason,
      meta: { ...(call.meta || {}), followsAuditId: write.id },
      ip: call.facts?.ip ?? null,
      userAgent: call.facts?.userAgent ?? null,
      requestId: call.facts?.requestId ?? null,
    });
    logEvent('error', 'mailgov.write.failed', { action: call.action, message: reason });
    return { ok: false, error: reason, auditId: write.id };
  }
}

/**
 * The console-page form: resolve the actor and decide, recording a refusal exactly as the API does.
 *
 * Pages do NOT get a redirect helper. A governance screen that bounces you to a login page when you
 * are signed in but unauthorised teaches people to re-authenticate at a page they should not be
 * opening; every page in this console renders the refusal, with its reason, in place.
 *
 * THE PAGE MUST CHECK `decision.allowed` BEFORE IT QUERIES ANYTHING. The layout renders the refusal,
 * but a layout runs after the frontmatter — so a page that loads its data first has already read a
 * tenant's rows for somebody who may not see them, whatever the screen ends up showing. Every page in
 * this console follows the same shape:
 *
 *     const { actor, decision } = await pageGate(Astro.locals, 'org.view', { orgId }, Astro.request);
 *     if (decision.allowed) { ...load... }
 */
export async function pageGate(
  locals: any,
  cap: GovCapability,
  target: GovTarget = {},
  request?: Request | null,
  orgHint?: string | null,
): Promise<{ actor: GovActor; decision: GovDecision; facts: RequestFacts }> {
  return gate(locals?.user, cap, target, request, orgHint);
}

/** Just the actor, for a page that needs to know who is looking before it decides anything else. */
export async function pageActor(locals: any, orgHint?: string | null): Promise<GovActor> {
  return resolveGovActor(locals?.user, orgHint);
}
