// src/lib/mailplatform/saas/service.ts — where the pure engines meet the store.
//
// Everything above this file (API routes, admin screens, other subsystems) calls these functions.
// Everything below it is pure. That split is deliberate: the engines can be tested exhaustively
// without a database, and this file — the only part that cannot — stays thin enough to read.
//
// THE STORE IS INJECTABLE, AND THAT IS THE WHOLE TESTING STRATEGY.
//
// `setSaasStore()` swaps the Postgres store for the in-memory one, so the tenant-isolation,
// quota-enforcement, plan-change and idempotency tests exercise THESE functions rather than a
// re-implementation of them in the test file. A test that re-implements the thing it is testing
// passes when the real code is broken, which is worse than no test at all. This repository's rules
// forbid touching the production database, so injection is not a convenience here, it is the only
// honest way to test the layer at all.

import type { Organization, UUID } from '../types';
import type {
  BillingEvent,
  Capability,
  EntitlementDecision,
  EnterpriseTerms,
  Invoice,
  LimitStatus,
  MetricKey,
  OrganizationType,
  OrgProfile,
  OveragePolicy,
  Plan,
  PlanLimits,
  Subscription,
  TeamRole,
  UsagePeriod,
  UsageSnapshot,
} from './types';
import type { MembershipRow, SaasStore } from './store';
import { MemorySaasStore } from './store';
import { PgSaasStore } from './pg-store';
import {
  DEFAULT_PLAN_KEY,
  METRICS,
  METRIC_KEYS,
  ORG_TYPE_DEFAULTS,
  isMetricKey,
  limitFor,
  resolveLimits,
  resolveOverage,
  resolvePlan,
} from './plans';
import {
  addMonthsUtc,
  crossedThresholds,
  emptySnapshot,
  periodFor,
  rollup,
  snapshotFromCounters,
  usageKey,
} from './usage';
import { attentionNeeded, describeSubscription, evaluateAll, suspensionAdvice } from './quota';
import type { EntitlementContext, EntitlementOptions } from './entitlements';
import { checkEntitlement, explainAll } from './entitlements';
import { applyBillingEvent, changePlan as changePlanPure, resolveBillingProvider } from './billing';
import { canChangeRole, canRemoveMember, normalizeTeamRole } from './roles';

// ---------------------------------------------------------------------------
// Store wiring
// ---------------------------------------------------------------------------

let store: SaasStore | null = null;

export function getSaasStore(): SaasStore {
  if (!store) store = new PgSaasStore();
  return store;
}

/** Swap the store. Returns the previous one so a test can put it back. */
export function setSaasStore(next: SaasStore): SaasStore | null {
  const prev = store;
  store = next;
  return prev;
}

/** A fresh in-memory store, wired in. Used by tests and by nothing else. */
export function useMemoryStore(): MemorySaasStore {
  const mem = new MemorySaasStore();
  setSaasStore(mem);
  return mem;
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

export interface TenantContext {
  organization: Organization;
  profile: OrgProfile | null;
  subscription: Subscription;
  plan: Plan;
  limits: PlanLimits;
  overage: OveragePolicy;
  period: UsagePeriod;
  usage: UsageSnapshot;
  enterprise: EnterpriseTerms | null;
}

/**
 * Everything about one tenant's commercial standing, resolved once.
 *
 * A tenant with no subscription row gets one created on the Free plan rather than an error. An
 * organization that exists but cannot be billed is a support ticket waiting to happen, and the
 * first thing anybody would do about it is exactly this.
 */
export async function tenantContext(orgId: UUID): Promise<TenantContext | null> {
  const s = getSaasStore();
  const organization = await s.getOrganization(orgId);
  if (!organization) return null;

  const profile = await s.getProfile(orgId);
  const subscription = await ensureSubscription(orgId, organization);
  const customPlans = await s.listCustomPlans(orgId);
  const plan = resolvePlan(subscription.planKey, customPlans);
  const limits = resolveLimits(plan, subscription.customLimits);
  const overage = resolveOverage(plan, subscription.customOverage);
  const period = currentPeriod(subscription);
  const usage = await usageSnapshot(orgId, period);
  const enterprise = await s.getEnterpriseTerms(orgId);

  return { organization, profile, subscription, plan, limits, overage, period, usage, enterprise };
}

/** The period the subscription is in. Falls back to computing it from the anchor if the row is stale. */
export function currentPeriod(subscription: Subscription, nowIso: string | Date = new Date()): UsagePeriod {
  const now = (nowIso instanceof Date ? nowIso : new Date(nowIso)).getTime();
  const start = new Date(subscription.periodStart).getTime();
  const end = new Date(subscription.periodEnd).getTime();
  if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end) {
    return { start: subscription.periodStart, end: subscription.periodEnd };
  }
  // The stored window has lapsed — renewal has not run yet. Compute the window we are ACTUALLY in
  // so usage lands in the right period, rather than piling onto a window that ended last month.
  return periodFor(subscription.periodStart, nowIso);
}

async function ensureSubscription(orgId: UUID, org: Organization): Promise<Subscription> {
  const s = getSaasStore();
  const existing = await s.getSubscription(orgId);
  if (existing) return existing;
  const start = org.createdAt || new Date().toISOString();
  const period = periodFor(start);
  return s.createSubscription(orgId, {
    planKey: DEFAULT_PLAN_KEY,
    status: 'active',
    periodStart: period.start,
    periodEnd: period.end,
    trialEndsAt: null,
    cancelAt: null,
    cancelledAt: null,
    pendingPlanKey: null,
    pendingPlanAt: null,
    customLimits: null,
    customOverage: null,
    lastBillingEventAt: null,
    provider: 'manual',
    providerRef: null,
    suspendedReason: null,
    suspendedAt: null,
  });
}

/**
 * The usage snapshot for a period.
 *
 * Reads the rolled-up counters first — that is one indexed row per metric, and a quota check runs
 * on the hot path of every send. Falls back to folding the raw events when no counters exist yet,
 * which is what makes the counters a CACHE of the durable log rather than the record itself. The
 * events remain the truth; a counter can always be rebuilt from them, and `reconcile()` does.
 */
export async function usageSnapshot(orgId: UUID, period: UsagePeriod): Promise<UsageSnapshot> {
  const s = getSaasStore();
  const counters = await s.getCounters(orgId, period.start);
  if (counters.length > 0) return snapshotFromCounters(orgId, period, counters);

  const events = await s.listUsageEvents(orgId, { period });
  if (events.length === 0) {
    // No counters and no events in this period does not mean the tenant holds nothing: gauges carry
    // forward. Look back one period for the levels before declaring everything zero.
    const opening = await openingGauges(orgId, period);
    if (Object.keys(opening).length === 0) return emptySnapshot(orgId, period);
    return rollup({ orgId, period, events: [], opening });
  }
  const opening = await openingGauges(orgId, period);
  return rollup({ orgId, period, events, opening });
}

async function openingGauges(orgId: UUID, period: UsagePeriod): Promise<Partial<Record<MetricKey, number>>> {
  const previousStart = addMonthsUtc(new Date(period.start), -1).toISOString();
  const previous = await getSaasStore().getCounters(orgId, previousStart);
  const out: Partial<Record<MetricKey, number>> = {};
  for (const c of previous) {
    if (METRICS[c.metric] && METRICS[c.metric].kind === 'gauge') out[c.metric] = c.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

export interface MeterInput {
  metric: MetricKey;
  quantity: number;
  source: string;
  /** Identifies the FACT. Same fact, same key — see `usageKey()` in ./usage.ts. */
  idempotencyKey?: string | null;
  mode?: 'delta' | 'set';
  meta?: Record<string, unknown>;
  occurredAt?: string;
}

export interface MeterResult {
  recorded: boolean;
  duplicate: boolean;
  /** The metric's value after this event. Unchanged from before when the event was a duplicate. */
  value: number;
  /** Thresholds crossed by this event, already recorded so each one fires once per period. */
  crossed: { metric: MetricKey; threshold: number }[];
}

/**
 * Record one metering fact and move the counter.
 *
 * Writes the durable event FIRST, then updates the counter. That order matters: if the process dies
 * between the two, the event survives and `reconcile()` rebuilds the counter from it. The other
 * order loses the fact and leaves a counter nobody can justify.
 */
export async function meter(orgId: UUID, input: MeterInput): Promise<MeterResult> {
  const s = getSaasStore();
  const occurredAt = input.occurredAt || new Date().toISOString();

  // READ THE STANDING BEFORE WRITING THE EVENT. The snapshot falls back to folding raw events when
  // no counters exist yet, so reading it afterwards would fold in the event about to be applied and
  // count it twice. The durable event is still written before the counter moves, which is the
  // ordering that matters for recovery.
  const ctx = await tenantContext(orgId);
  if (!ctx) return { recorded: false, duplicate: false, value: 0, crossed: [] };
  const before = ctx.usage.values[input.metric] || 0;

  const write = await s.recordUsage(orgId, {
    orgId,
    metric: input.metric,
    quantity: input.quantity,
    mode: input.mode || 'delta',
    source: input.source,
    idempotencyKey: input.idempotencyKey || null,
    meta: input.meta || {},
    occurredAt,
  });

  if (write.duplicate) {
    // Nothing moved. Reporting the current value is still useful and is not a lie about the write.
    return { recorded: false, duplicate: true, value: before, crossed: [] };
  }

  const period = ctx.period;
  const after = input.mode === 'set'
    ? Math.max(0, input.quantity)
    : Math.max(0, before + input.quantity);

  // SEED THE WHOLE PERIOD ON THE FIRST WRITE INTO IT.
  //
  // Once any counter row exists for a period, `usageSnapshot()` reads counters and stops folding
  // events — so a period holding one row would report every OTHER metric as zero, including the
  // gauges carried forward from last month. Seeding costs one burst of writes per tenant per
  // period and removes a whole class of "my contact count reset itself" reports.
  const existing = await s.getCounters(orgId, period.start);
  if (existing.length === 0) {
    await s.saveCounters(orgId, METRIC_KEYS.map((m) => ({
      orgId,
      metric: m,
      periodStart: period.start,
      value: ctx.usage.values[m] || 0,
      peak: ctx.usage.peaks[m] || 0,
      updatedAt: new Date().toISOString(),
    })));
  }

  await s.saveCounters(orgId, [{
    orgId,
    metric: input.metric,
    periodStart: period.start,
    value: after,
    peak: Math.max(after, ctx.usage.peaks[input.metric] || 0),
    updatedAt: new Date().toISOString(),
  }]);

  // Threshold notices. Recorded through the store's unique index, so the same warning cannot be
  // sent twice in a period even if two workers cross the line at the same instant.
  const limit = limitFor(input.metric, ctx.limits);
  const crossings = crossedThresholds(input.metric, before, after, limit, ctx.overage.warnThresholds);
  const crossed: { metric: MetricKey; threshold: number }[] = [];
  for (const c of crossings) {
    const note = await s.recordQuotaNotice(orgId, {
      orgId,
      metric: c.metric,
      periodStart: period.start,
      threshold: c.threshold,
      state: c.threshold >= 1 ? 'hard_exceeded' : 'warning',
      notifiedAt: new Date().toISOString(),
    });
    if (note.recorded) {
      crossed.push({ metric: c.metric, threshold: c.threshold });
      await recordPlatformBillingEvent(orgId, 'usage.threshold_reached', {
        metric: c.metric,
        threshold: c.threshold,
        used: c.used,
        limit: c.limit,
      });
    }
  }

  return { recorded: true, duplicate: false, value: after, crossed };
}

/**
 * Rebuild the counters for a period from the durable events.
 *
 * This is the answer to "the number looks wrong". Counters are a cache; the events are the record;
 * this function makes the cache match the record and reports what it changed, so an operator can
 * see whether drift existed rather than being told everything is fine.
 */
export async function reconcile(orgId: UUID, period?: UsagePeriod): Promise<{
  period: UsagePeriod;
  changes: { metric: MetricKey; from: number; to: number }[];
}> {
  const s = getSaasStore();
  const sub = await s.getSubscription(orgId);
  const window = period || (sub ? currentPeriod(sub) : periodFor(new Date().toISOString()));

  const events = await s.listUsageEvents(orgId, { period: window });
  const opening = await openingGauges(orgId, window);
  const rebuilt = rollup({ orgId, period: window, events, opening });

  const existing = await s.getCounters(orgId, window.start);
  const byMetric = new Map(existing.map((c) => [c.metric, c]));
  const changes: { metric: MetricKey; from: number; to: number }[] = [];
  const toSave = [];
  for (const metric of Object.keys(rebuilt.values) as MetricKey[]) {
    const was = byMetric.get(metric);
    const from = was ? was.value : 0;
    const to = rebuilt.values[metric];
    if (from !== to) changes.push({ metric, from, to });
    toSave.push({
      orgId,
      metric,
      periodStart: window.start,
      value: to,
      peak: Math.max(rebuilt.peaks[metric], was ? was.peak : 0),
      updatedAt: new Date().toISOString(),
    });
  }
  await s.saveCounters(orgId, toSave);
  return { period: window, changes };
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

export interface Actor {
  userId: UUID | null;
  /** The tenant this actor is acting in. Resolved from membership, never from a request parameter. */
  orgId: UUID | null;
  role: TeamRole | null;
}

/**
 * Who is this user, inside this tenant?
 *
 * Returns a role only when a live membership row says so. There is no path here that infers
 * membership from anything else — not from an EduRankAI admin role, not from a query parameter.
 * A platform operator who needs to look at a tenant is handled separately and visibly, in the
 * admin surface, rather than by quietly widening this function.
 */
export async function actorFor(orgId: UUID, userId: UUID | null): Promise<Actor> {
  if (!userId) return { userId: null, orgId: null, role: null };
  const membership = await getSaasStore().getMembership(orgId, userId);
  if (!membership) return { userId, orgId: null, role: null };
  return { userId, orgId, role: normalizeTeamRole(membership.teamRole, membership.role) };
}

/**
 * PLATFORM OPERATOR ACCESS. A deliberate widening, kept in its own function so it is impossible to
 * reach by accident.
 *
 * EduRankAI's own staff run support: a customer emails asking to be moved to Business, and somebody
 * has to do it. Without this they could not, because they hold no membership in the customer's
 * organization — and the alternative, quietly inserting a membership row so the check passes, would
 * make an operator indistinguishable from an Owner in every subsequent audit.
 *
 * So the widening is explicit, it is separate, and the caller has to ASK for it:
 *   - only `/admin/*` passes `asOperator`, and only after the repository's own `can(user, ...)` gate
 *   - the screen says on it that the viewer is acting as platform staff, not as a member
 *   - anything an operator changes is recorded with `actorKind: 'operator'` in the billing history
 *
 * It grants the Owner role for the decision, and nothing else. It does not create a membership, it
 * does not survive the request, and it never applies to an API-key caller.
 */
export function operatorActor(orgId: UUID, userId: UUID | null): Actor {
  return { userId, orgId: userId ? orgId : null, role: userId ? 'owner' : null };
}

/** Build the context the pure engine decides against. */
export function entitlementContext(ctx: TenantContext, actor: Actor): EntitlementContext {
  return {
    orgId: ctx.organization.id,
    principalId: actor.userId,
    principalOrgId: actor.orgId,
    orgStatus: ctx.organization.status,
    role: actor.role,
    subscriptionStatus: ctx.subscription.status,
    plan: ctx.plan,
    limits: ctx.limits,
    overage: ctx.overage,
    usage: ctx.usage,
  };
}

/**
 * The call every premium surface makes.
 *
 * Refuses with `org_mismatch` when the organization does not exist, rather than saying so: whether
 * a given organization id exists is itself information, and handing it to somebody who is not a
 * member of it is a small leak that maps out the customer list one guess at a time.
 */
export async function checkCapability(
  orgId: UUID,
  userId: UUID | null,
  capability: Capability,
  opts: EntitlementOptions & { asOperator?: boolean } = {},
): Promise<EntitlementDecision> {
  const ctx = await tenantContext(orgId);
  const actor = opts.asOperator ? operatorActor(orgId, userId) : await actorFor(orgId, userId);
  if (!ctx) {
    return {
      capability,
      allowed: false,
      reason: 'org_mismatch',
      message: 'This account does not belong to that organization.',
      metric: null,
      requiredFeature: null,
      upgradeToPlanKey: null,
      limits: [],
      overage: false,
      notice: null,
    };
  }
  return checkEntitlement(capability, entitlementContext(ctx, actor), opts);
}

/**
 * The same check for a caller who arrived through the API rather than a session.
 *
 * A `Principal` of kind `api_key` has an id that is a KEY id, not a user id, so it has no
 * membership row to resolve a team role from. Its authority is the permission set the key was
 * issued with, which is passed straight through — a scoped key can therefore never do more than its
 * scopes, no matter who created it or what role that person holds.
 */
export async function checkCapabilityForPrincipal(
  principal: { kind: string; id: string; orgId: UUID; permissions: string[] },
  capability: Capability,
  opts: EntitlementOptions = {},
): Promise<EntitlementDecision> {
  const ctx = await tenantContext(principal.orgId);
  if (!ctx) {
    return {
      capability, allowed: false, reason: 'org_mismatch',
      message: 'This account does not belong to that organization.',
      metric: null, requiredFeature: null, upgradeToPlanKey: null,
      limits: [], overage: false, notice: null,
    };
  }
  const actor = principal.kind === 'user'
    ? await actorFor(principal.orgId, principal.id)
    : { userId: principal.id, orgId: principal.orgId, role: null };

  return checkEntitlement(capability, {
    ...entitlementContext(ctx, actor),
    principalId: principal.id,
    principalOrgId: principal.orgId,
    permissions: principal.kind === 'user' ? null : (principal.permissions as any),
  }, opts);
}

/** Every capability decided at once, for the entitlement matrix on the billing screen. */
export async function explainCapabilities(
  orgId: UUID,
  userId: UUID | null,
  opts: { asOperator?: boolean } = {},
): Promise<EntitlementDecision[]> {
  const ctx = await tenantContext(orgId);
  if (!ctx) return [];
  const actor = opts.asOperator ? operatorActor(orgId, userId) : await actorFor(orgId, userId);
  return explainAll(entitlementContext(ctx, actor));
}

// ---------------------------------------------------------------------------
// Organizations and membership
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'org';
}

/**
 * Create a tenant, with the creator as its Owner and a Free subscription.
 *
 * The three happen together on purpose. An organization with no owner cannot be administered and an
 * organization with no subscription cannot be metered, so creating one without the other two just
 * moves the failure to whoever opens it first.
 */
export async function createOrganization(input: {
  name: string;
  orgType: OrganizationType;
  createdByUserId: UUID | null;
  billingEmail?: string | null;
  currency?: string;
  country?: string | null;
  planKey?: string;
}): Promise<{ organization: Organization; subscription: Subscription }> {
  const s = getSaasStore();
  const base = slugify(input.name);
  let slug = base;
  // Uniqueness by probing rather than by catching a constraint violation: the slug is in URLs, and
  // a failed create is a worse answer than a slug with a number on the end.
  for (let i = 2; i < 50; i++) {
    const taken = await s.getOrganizationBySlug(slug);
    if (!taken) break;
    slug = base + '-' + i;
  }

  const defaults = ORG_TYPE_DEFAULTS[input.orgType] || ORG_TYPE_DEFAULTS.individual;
  const { organization } = await s.createOrganization({
    name: input.name,
    slug,
    createdByUserId: input.createdByUserId,
    profile: {
      orgType: input.orgType,
      billingEmail: input.billingEmail || null,
      currency: (input.currency || 'INR').toUpperCase(),
      timezone: 'UTC',
      taxId: null,
      country: input.country || null,
    },
  });

  const period = periodFor(organization.createdAt);
  const subscription = await s.createSubscription(organization.id, {
    // The organization type SUGGESTS a plan; it never imposes one. An explicit choice wins.
    planKey: input.planKey || defaults.suggestedPlanKey || DEFAULT_PLAN_KEY,
    status: 'active',
    periodStart: period.start,
    periodEnd: period.end,
    trialEndsAt: null,
    cancelAt: null,
    cancelledAt: null,
    pendingPlanKey: null,
    pendingPlanAt: null,
    customLimits: null,
    customOverage: null,
    lastBillingEventAt: null,
    provider: 'manual',
    providerRef: null,
    suspendedReason: null,
    suspendedAt: null,
  });

  // The owner is a seat. Metering it at creation keeps `users` honest from the first moment rather
  // than from whenever the second member joins.
  if (input.createdByUserId) {
    await meter(organization.id, {
      metric: 'users',
      quantity: 1,
      source: 'org-create',
      idempotencyKey: usageKey('member.added', organization.id, input.createdByUserId),
    });
  }

  await recordPlatformBillingEvent(organization.id, 'subscription.created', {
    planKey: subscription.planKey,
    status: subscription.status,
    periodEnd: subscription.periodEnd,
  });

  return { organization, subscription };
}

export interface MemberChangeResult {
  ok: boolean;
  message: string;
  member?: MembershipRow;
}

/**
 * Add somebody to a tenant.
 *
 * Two gates, in this order: the seat limit (a plan question) and the role rules (an authority
 * question). Seats first, because being told "you are out of seats" is more useful than being told
 * "you cannot assign that role" to somebody who could not have been added at all.
 */
export async function inviteMember(
  orgId: UUID,
  actorUserId: UUID | null,
  targetUserId: UUID,
  teamRole: TeamRole,
): Promise<MemberChangeResult> {
  const s = getSaasStore();
  const actor = await actorFor(orgId, actorUserId);
  if (!actor.role) return { ok: false, message: 'You are not a member of this organization.' };

  const seat = await checkCapability(orgId, actorUserId, 'team.invite', { amount: 1 });
  if (!seat.allowed) return { ok: false, message: seat.message || 'Cannot add another member.' };

  const verdict = canChangeRole({
    actorRole: actor.role,
    targetCurrentRole: null,
    targetNewRole: teamRole,
    isSelf: actorUserId === targetUserId,
    ownerCount: await s.countOwners(orgId),
  });
  if (!verdict.ok) return { ok: false, message: verdict.reason || 'That role cannot be assigned.' };

  const member = await s.addMember(orgId, targetUserId, teamRole, actorUserId);
  await meter(orgId, {
    metric: 'users',
    quantity: 1,
    source: 'member-invite',
    idempotencyKey: usageKey('member.added', orgId, targetUserId),
    meta: { role: teamRole },
  });
  return { ok: true, message: 'Added as ' + teamRole + '.', member };
}

export async function setMemberRole(
  orgId: UUID,
  actorUserId: UUID | null,
  targetUserId: UUID,
  teamRole: TeamRole,
): Promise<MemberChangeResult> {
  const s = getSaasStore();
  const actor = await actorFor(orgId, actorUserId);
  if (!actor.role) return { ok: false, message: 'You are not a member of this organization.' };
  const target = await s.getMembership(orgId, targetUserId);
  if (!target) return { ok: false, message: 'That person is not a member of this organization.' };

  const verdict = canChangeRole({
    actorRole: actor.role,
    targetCurrentRole: target.teamRole,
    targetNewRole: teamRole,
    isSelf: actorUserId === targetUserId,
    ownerCount: await s.countOwners(orgId),
  });
  if (!verdict.ok) return { ok: false, message: verdict.reason || 'That change is not allowed.' };

  const member = await s.setMemberRole(orgId, targetUserId, teamRole);
  return {
    ok: true,
    message: 'Role changed to ' + teamRole + '.',
    member: member || undefined,
  };
}

export async function removeMember(
  orgId: UUID,
  actorUserId: UUID | null,
  targetUserId: UUID,
): Promise<MemberChangeResult> {
  const s = getSaasStore();
  const actor = await actorFor(orgId, actorUserId);
  if (!actor.role) return { ok: false, message: 'You are not a member of this organization.' };
  const target = await s.getMembership(orgId, targetUserId);
  if (!target) return { ok: false, message: 'That person is not a member of this organization.' };

  const verdict = canRemoveMember({
    actorRole: actor.role,
    targetCurrentRole: target.teamRole,
    isSelf: actorUserId === targetUserId,
    ownerCount: await s.countOwners(orgId),
  });
  if (!verdict.ok) return { ok: false, message: verdict.reason || 'That removal is not allowed.' };

  await s.removeMember(orgId, targetUserId);
  // The seat is given back immediately. A plan limit that only ever counts up is a plan limit that
  // eventually blocks a customer who is well inside it.
  await meter(orgId, {
    metric: 'users',
    quantity: -1,
    source: 'member-remove',
    idempotencyKey: usageKey('member.removed', orgId, targetUserId, new Date().toISOString().slice(0, 19)),
  });
  return { ok: true, message: 'Removed from the organization.' };
}

// ---------------------------------------------------------------------------
// Plan changes
// ---------------------------------------------------------------------------

export interface PlanChangeOutcome {
  ok: boolean;
  message: string;
  subscription?: Subscription;
  immediate?: boolean;
  effectiveAt?: string;
}

/**
 * Change a tenant's plan.
 *
 * Permission is checked through the entitlement engine like everything else — `billing.manage`,
 * which only an Owner holds. The provider is told after the platform's own state is written, and a
 * provider failure does NOT roll the change back: under the manual provider there is nothing to
 * fail, and under a real one, a customer who has paid must not lose the plan they paid for because
 * a webhook acknowledgement timed out.
 */
export async function changeOrganizationPlan(
  orgId: UUID,
  actorUserId: UUID | null,
  toPlanKey: string,
  opts: { asOperator?: boolean } = {},
): Promise<PlanChangeOutcome> {
  const allowed = await checkCapability(orgId, actorUserId, 'billing.manage', { asOperator: opts.asOperator });
  if (!allowed.allowed) {
    return { ok: false, message: allowed.message || 'You cannot change the plan for this organization.' };
  }
  const s = getSaasStore();
  const current = await s.getSubscription(orgId);
  if (!current) return { ok: false, message: 'This organization has no subscription to change.' };

  const customPlans = await s.listCustomPlans(orgId);
  const target = resolvePlan(toPlanKey, customPlans);
  if (target.key !== toPlanKey) {
    return { ok: false, message: 'There is no plan called "' + toPlanKey + '".' };
  }

  const result = changePlanPure(current, toPlanKey);
  const saved = await s.saveSubscription(orgId, result.subscription);

  const provider = resolveBillingProvider(saved.provider);
  const remote = await provider.changePlan(saved, toPlanKey);
  const providerNote = remote.ok
    ? ''
    : ' The platform record is updated; the billing provider reported: ' + (remote.error || 'no detail') + '.';

  await recordPlatformBillingEvent(orgId, 'plan.changed', {
    planKey: toPlanKey,
    immediate: result.immediate,
    previousPlanKey: current.planKey,
    actorUserId,
    // Recorded so the billing history distinguishes "the customer changed their plan" from
    // "EduRankAI staff changed it for them". Those are different facts and support will be asked.
    actorKind: opts.asOperator ? 'operator' : 'member',
  });

  return {
    ok: true,
    message: result.note + providerNote,
    subscription: saved,
    immediate: result.immediate,
    effectiveAt: result.effectiveAt,
  };
}

// ---------------------------------------------------------------------------
// Billing events
// ---------------------------------------------------------------------------

/**
 * Record an event this platform generated itself, and apply it.
 *
 * Platform-generated events get an id built from the fact, so the same fact recorded twice is one
 * row. That is the same idempotency the provider path relies on, and it means a retried job cannot
 * produce two "plan changed" entries in the customer's billing history.
 */
export async function recordPlatformBillingEvent(
  orgId: UUID,
  type: BillingEvent['type'],
  payload: Record<string, unknown>,
): Promise<{ duplicate: boolean }> {
  const s = getSaasStore();
  const stamp = new Date().toISOString();
  const eventId = usageKey('platform', type, orgId, JSON.stringify(payload), stamp.slice(0, 16));
  const written = await s.recordBillingEvent({
    orgId,
    provider: 'platform',
    eventId,
    type,
    payload,
    occurredAt: stamp,
  });
  if (written.event && !written.duplicate) {
    await s.markBillingEventProcessed(written.event.id, null);
  }
  return { duplicate: written.duplicate };
}

export interface WebhookOutcome {
  ok: boolean;
  duplicate: boolean;
  applied: boolean;
  message: string;
}

/**
 * Take a verified provider event and apply it to the subscription.
 *
 * The event is RECORDED FIRST and applied second, and it is recorded even when applying it fails —
 * `error` on the row, never a dropped event. A billing event that cannot be applied is something a
 * person needs to look at; a billing event that was thrown away is something nobody can look at.
 */
export async function ingestBillingEvent(
  event: Omit<BillingEvent, 'id' | 'receivedAt' | 'processedAt' | 'error'>,
): Promise<WebhookOutcome> {
  const s = getSaasStore();
  const written = await s.recordBillingEvent(event);
  if (written.duplicate) {
    return {
      ok: true,
      duplicate: true,
      applied: false,
      message: 'Already received event ' + event.eventId + ' from ' + event.provider + '; nothing was applied again.',
    };
  }
  const row = written.event;
  if (!row) {
    return { ok: false, duplicate: false, applied: false, message: 'The billing event could not be recorded.' };
  }
  if (!row.orgId) {
    await s.markBillingEventProcessed(row.id, 'No organization could be resolved for this event.');
    return {
      ok: false,
      duplicate: false,
      applied: false,
      message: 'Event ' + row.eventId + ' names no organization this platform knows. It is stored for review.',
    };
  }

  const subscription = await s.getSubscription(row.orgId);
  if (!subscription) {
    await s.markBillingEventProcessed(row.id, 'The organization has no subscription.');
    return {
      ok: false,
      duplicate: false,
      applied: false,
      message: 'Organization ' + row.orgId + ' has no subscription to apply this to. The event is stored.',
    };
  }

  try {
    const result = applyBillingEvent(subscription, row);
    if (result.changed) await s.saveSubscription(row.orgId, result.subscription);
    await s.markBillingEventProcessed(row.id, null);
    return { ok: true, duplicate: false, applied: result.changed, message: result.note };
  } catch (e: any) {
    // NEVER SWALLOWED. The row keeps the reason so the event can be replayed after a fix, and the
    // caller is told the truth rather than receiving a 200 that means nothing happened.
    const detail = String(e?.cause?.message || e?.message || 'unknown error');
    await s.markBillingEventProcessed(row.id, detail);
    return { ok: false, duplicate: false, applied: false, message: 'Applying the event failed: ' + detail };
  }
}

// ---------------------------------------------------------------------------
// The dashboard view
// ---------------------------------------------------------------------------

export interface BillingOverview {
  context: TenantContext;
  statuses: LimitStatus[];
  attention: LimitStatus[];
  standing: ReturnType<typeof describeSubscription>;
  suspension: ReturnType<typeof suspensionAdvice>;
  invoices: Invoice[];
  events: BillingEvent[];
  members: MembershipRow[];
}

/** Everything the admin billing screen renders, gathered in one call. */
export async function billingOverview(orgId: UUID): Promise<BillingOverview | null> {
  const context = await tenantContext(orgId);
  if (!context) return null;
  const s = getSaasStore();
  const statuses = evaluateAll(context.usage, context.limits, context.overage);
  const suspension = suspensionAdvice(context.subscription);
  return {
    context,
    statuses,
    attention: attentionNeeded(statuses),
    standing: describeSubscription(context.subscription.status, suspension),
    suspension,
    invoices: await s.listInvoices(orgId, 12),
    events: await s.listBillingEvents(orgId, 20),
    members: await s.listMembers(orgId),
  };
}

/**
 * Which tenant is this user acting in?
 *
 * A requested organization is honoured only if they are a member of it. Otherwise their first
 * membership is used, and a user with no membership gets null — never a default tenant, which would
 * silently drop somebody into somebody else's data.
 */
export async function resolveTenantForUser(
  userId: UUID | null,
  requestedOrgId?: string | null,
): Promise<UUID | null> {
  if (!userId) return null;
  const s = getSaasStore();
  if (requestedOrgId) {
    const membership = await s.getMembership(requestedOrgId, userId);
    if (membership) return requestedOrgId;
    return null;
  }
  const memberships = await s.listMembershipsForUser(userId);
  return memberships.length > 0 ? memberships[0].orgId : null;
}

/** A metric key from a request body, or null. Never trusts the string. */
export function readMetric(value: unknown): MetricKey | null {
  return isMetricKey(value) ? value : null;
}
