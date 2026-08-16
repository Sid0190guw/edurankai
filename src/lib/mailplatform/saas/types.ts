// src/lib/mailplatform/saas/types.ts — the commercial layer's domain model.
//
// This file sits ON TOP of ../types.ts (the platform contract owned jointly by the core-database,
// SMTP, webmail and DevOps agents). It adds nothing to that file and renames nothing in it. Where
// this layer needs a richer idea than the contract carries, it declares its OWN type here and
// supplies a total mapping back down — see TeamRole below, which is the important case.
//
// WHY A SEPARATE FILE RATHER THAN WIDENING ../types.ts
//
// ../types.ts says of itself: "additions are cheap and renames are not", and three other agents
// compile against it. `OrgMemberRole` there has five values and other subsystems switch on it.
// Patch 13 needs nine roles. Widening that union would have compiled here and broken every
// exhaustive switch elsewhere — a change to somebody else's subsystem, which this patch is
// explicitly not allowed to make. So the nine live here as `TeamRole`, the five stay authoritative
// for the platform, and `platformRoleFor()` in ./roles.ts maps every one of the nine onto one of
// the five. Old code keeps working and reads a member it has never heard of as the safest role that
// still describes them.
//
// THE OTHER RULE THIS FILE ENCODES: no money in the engine.
//
// `Plan` carries LIMITS. Prices live in `PlanPricing`, a separate record the engines never receive,
// because the moment a quota check can read a price the two become impossible to change apart —
// and prices change per market, per currency and per negotiated enterprise contract while limits do
// not. A test asserts the entitlement and quota engines never import pricing.

import type { ISODateString, UUID } from '../types';

/** Re-exported so a module in this layer imports one file rather than two. */
export type { ISODateString, UUID };

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/**
 * What kind of customer this tenant is.
 *
 * SUPPLIES DEFAULTS ONLY. Nothing downstream may branch a capability, a limit or a quota on this
 * value: a university on the Free plan gets exactly what a startup on the Free plan gets. The type
 * decides what we SUGGEST at signup (see ORG_TYPE_DEFAULTS in ./plans.ts) and how the tenant is
 * described in reporting. `saas-entitlements.test.ts` asserts the engine's answers are identical
 * across all seven types when the plan is held constant — that assertion is the enforcement.
 */
export type OrganizationType =
  | 'individual'
  | 'startup'
  | 'company'
  | 'university'
  | 'government'
  | 'enterprise'
  | 'partner';

export const ORGANIZATION_TYPES: readonly OrganizationType[] = [
  'individual', 'startup', 'company', 'university', 'government', 'enterprise', 'partner',
] as const;

/** Commercial facts about a tenant that the platform contract's `Organization` does not carry. */
export interface OrgProfile {
  orgId: UUID;
  orgType: OrganizationType;
  /** Billing contact address. Deliberately not a user id — it outlives any one member. */
  billingEmail: string | null;
  /** ISO 4217, upper case. Display only; never read by an engine. */
  currency: string;
  /** IANA zone. Decides where a billing period boundary actually falls for this tenant. */
  timezone: string;
  /** Tax/registration identifier as the customer supplied it. Never validated as a fact. */
  taxId: string | null;
  country: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Team roles
// ---------------------------------------------------------------------------

/**
 * The nine team roles.
 *
 * Persisted in `mp_organization_members.team_role`, an ADDITIVE column beside the contract's
 * `role`. A row written by another subsystem that knows only `role` reads back here through
 * `teamRoleFor()` in ./roles.ts, so a member is never roleless.
 */
export type TeamRole =
  | 'owner'
  | 'admin'
  | 'mail_admin'
  | 'campaign_manager'
  | 'developer'
  | 'analyst'
  | 'support_agent'
  | 'member'
  | 'viewer';

export const TEAM_ROLES: readonly TeamRole[] = [
  'owner', 'admin', 'mail_admin', 'campaign_manager', 'developer', 'analyst', 'support_agent',
  'member', 'viewer',
] as const;

/** A team inside a tenant. Teams scope membership; they never grant capability by themselves. */
export interface Team {
  id: UUID;
  orgId: UUID;
  name: string;
  slug: string;
  description: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface TeamMember {
  id: UUID;
  orgId: UUID;
  teamId: UUID;
  userId: UUID;
  /** A team role NARROWS the org role for work inside the team; it can never widen it. */
  teamRole: TeamRole;
  createdAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The dotted capability keys the entitlement engine answers about.
 *
 * These are NOT the platform's `MailPermission` values, and the difference matters. A permission
 * answers "is this person allowed to?". A capability answers the whole commercial question: is this
 * person allowed to, does their plan include it, and is there quota left. Each key maps down to a
 * permission in ./entitlements.ts, so the permission model stays the single source of truth for the
 * first of those three questions.
 */
export type Capability =
  // messaging
  | 'mail.send'
  | 'mail.read'
  | 'mailbox.create'
  // campaigns
  | 'campaign.create'
  | 'campaign.send'
  | 'campaign.schedule'
  // contacts
  | 'contact.create'
  | 'contact.import'
  // domains
  | 'domain.add'
  | 'domain.verify'
  | 'domain.custom_tracking'
  // automation
  | 'automation.create'
  | 'automation.execute'
  // developer surface
  | 'api.send'
  | 'api.key.create'
  | 'webhook.create'
  | 'webhook.deliver'
  // AI
  | 'ai.summarize'
  | 'ai.compose'
  // analytics and administration
  | 'analytics.view'
  | 'analytics.export'
  | 'org.manage'
  | 'billing.manage'
  | 'team.manage'
  // Metered administration. Separate keys from `team.manage` because these two are the ones that
  // consume a plan limit — seats and teams — and a capability that consumes nothing must not be
  // refused for being out of quota.
  | 'team.invite'
  | 'team.create';

/** Optional plan flags a capability may require. Absent flag means "every plan has it". */
export type PlanFeature =
  | 'campaigns'
  | 'automation'
  | 'api'
  | 'webhooks'
  | 'ai'
  | 'custom_tracking_domain'
  | 'advanced_analytics'
  | 'analytics_export'
  | 'sso'
  | 'audit_log'
  | 'dedicated_ip'
  | 'custom_smtp'
  | 'sla'
  | 'priority_support';

// ---------------------------------------------------------------------------
// Usage metering
// ---------------------------------------------------------------------------

/**
 * Everything the platform meters.
 *
 * The `kind` split below is the single most consequential distinction in this layer, so it is in
 * the type system rather than in a comment somewhere:
 *
 *   COUNTER — accumulates across a billing period and resets at the boundary. "10,000 emails per
 *             month" is a counter. The question is "how many since the period began".
 *   GAUGE   — a level that is true right now and does NOT reset. "5 mailboxes" is a gauge. The
 *             question is "how many exist", and last month's number is not part of the answer.
 *
 * Rolling a gauge up like a counter is the classic metering bug: it makes a tenant who created and
 * deleted a mailbox each week look like they hold four. Both the rollup in ./usage.ts and the quota
 * engine in ./quota.ts read this field and treat the two kinds differently.
 */
export type MetricKind = 'counter' | 'gauge';

export type MetricKey =
  // The twelve the brief names.
  | 'emails_sent'
  | 'emails_received'
  | 'contacts'
  | 'mailboxes'
  | 'domains'
  | 'storage_bytes'
  | 'attachments'
  | 'api_calls'
  | 'webhook_deliveries'
  | 'automation_runs'
  | 'ai_units'
  | 'campaign_recipients'
  // Three more, because the PLAN LIMITS name them and a limit with no metric behind it cannot be
  // enforced — "max users" is not a number you can honour without knowing how many users there are.
  // All three are gauges: seats and automations are levels, not monthly consumption.
  | 'users'
  | 'teams'
  | 'automations';

export interface MetricDescriptor {
  key: MetricKey;
  kind: MetricKind;
  label: string;
  /** How a number in this metric should be rendered. Display concern only. */
  unit: 'count' | 'bytes';
  /** The PlanLimits field this metric is checked against. Null means "metered, never limited". */
  limitField: keyof PlanLimits | null;
  /** One line an operator can act on when the limit is reached. */
  hint: string;
}

/**
 * A durable metering fact. Append-only.
 *
 * `idempotencyKey` is what makes metering survive the retries that a mail system is made of: a
 * queue redelivery, a webhook replay and a double-clicked Send all produce the same key, and the
 * second write is dropped by a unique index rather than counted twice. Usage that can be
 * double-counted is usage that gets argued about in a billing dispute, and the customer is right.
 */
export interface UsageEvent {
  id: string;
  orgId: UUID;
  metric: MetricKey;
  /** Signed. A gauge decrement (mailbox deleted) is -1; a counter is never negative. */
  quantity: number;
  /**
   * How to apply `quantity`.
   *
   *   'delta' (the default) — add it to what is already there. Every ordinary emitter uses this.
   *   'set'                 — `quantity` IS the true value; discard what was accumulated.
   *
   * 'set' exists because drift is certain, not possible. A mailbox deleted by a subsystem that
   * forgot to emit an event leaves the gauge one too high forever, and no amount of care at the
   * call sites prevents that permanently. A reconciler counts the rows and emits one 'set', and the
   * meter is correct again — without anybody editing a counter by hand in production.
   */
  mode?: 'delta' | 'set';
  /** Where the fact came from: 'send-service', 'api', 'webhook-dispatcher', 'reconciler'. */
  source: string;
  idempotencyKey: string | null;
  /** Free-form context for an audit: message id, campaign id, key id. Never secrets. */
  meta: Record<string, unknown>;
  occurredAt: ISODateString;
}

/** A billing period, half-open: [start, end). */
export interface UsagePeriod {
  start: ISODateString;
  end: ISODateString;
}

/** A rolled-up number for one metric in one period. */
export interface UsageCounter {
  orgId: UUID;
  metric: MetricKey;
  periodStart: ISODateString;
  /** Counters: the sum over the period. Gauges: the level as of the last event. */
  value: number;
  /** Highest value the metric reached in the period. For gauges this is what an audit asks for. */
  peak: number;
  updatedAt: ISODateString;
}

/** Everything the quota engine needs to know about one tenant's consumption. */
export interface UsageSnapshot {
  orgId: UUID;
  period: UsagePeriod;
  /** Present for every metric in METRICS; a metric with no events reads 0, never undefined. */
  values: Record<MetricKey, number>;
  peaks: Record<MetricKey, number>;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type PlanTier = 'free' | 'starter' | 'professional' | 'business' | 'enterprise';

/**
 * The limit set. `null` ALWAYS means unlimited, and `0` always means "not available on this plan".
 *
 * That distinction is load-bearing and has a test: `0` and `null` are opposite answers, and reading
 * a missing field as 0 would silently un-sell every feature on the Enterprise plan.
 */
export interface PlanLimits {
  maxUsers: number | null;
  maxTeams: number | null;
  maxMailboxes: number | null;
  maxDomains: number | null;
  maxContacts: number | null;
  monthlySendQuota: number | null;
  monthlyReceiveQuota: number | null;
  monthlyCampaignRecipients: number | null;
  monthlyAutomationRuns: number | null;
  maxAutomations: number | null;
  monthlyApiCalls: number | null;
  apiRateLimitPerMinute: number | null;
  monthlyWebhookDeliveries: number | null;
  monthlyAiUnits: number | null;
  storageBytes: number | null;
  maxAttachmentBytes: number | null;
  analyticsRetentionDays: number | null;
}

/** Which metric may exceed its limit, and by how much, before anything is refused. */
export interface OveragePolicy {
  /** Metrics allowed to run past the limit at all. Everything else is a hard limit. */
  softMetrics: MetricKey[];
  /**
   * How far past the limit a soft metric may go, as a fraction. 0.1 = 110% of the limit.
   * Reaching the ceiling turns a soft limit into a hard one; it does not suspend the tenant.
   */
  softCeilingRatio: number;
  /** Fractions of the limit at which the tenant is warned. Sorted ascending, deduplicated. */
  warnThresholds: number[];
  /**
   * Whether transactional mail may be HARD-blocked when out of quota.
   *
   * Defaults false on every plan, and the default is the policy: a password reset that silently
   * fails to send is a lockout, and the customer discovers it from their own users. When false, a
   * transactional send past a hard limit is ALLOWED and reported as overage, loudly. Setting it
   * true is a deliberate act, recorded per tenant, and the decision still carries a notice.
   */
  blockTransactionalOnHardLimit: boolean;
}

export interface Plan {
  key: string;
  name: string;
  tier: PlanTier;
  description: string;
  limits: PlanLimits;
  features: PlanFeature[];
  overage: OveragePolicy;
  /** True for a per-tenant negotiated plan stored in mp_plans rather than the built-in catalog. */
  isCustom: boolean;
  /** Set only on a custom plan: the tenant it belongs to. A catalog plan is available to all. */
  orgId: UUID | null;
  isActive: boolean;
  /** Ordering for display; nothing branches on it. */
  sortOrder: number;
}

/**
 * Prices. Kept OUT of `Plan` on purpose — see the file header.
 *
 * `amountMinor` is in the currency's minor unit (paise, cents) because storing money as a float is
 * how a rounding error becomes an invoice. Nothing in ./entitlements.ts or ./quota.ts may import
 * this type; a test enforces that.
 */
export interface PlanPricing {
  planKey: string;
  currency: string;
  interval: 'month' | 'year';
  amountMinor: number;
  /** What the provider calls this price. Set when a provider is configured; null for manual. */
  providerPriceRef: string | null;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled'
  | 'expired';

export interface Subscription {
  id: UUID;
  orgId: UUID;
  planKey: string;
  status: SubscriptionStatus;
  /** Half-open period the current usage counters belong to. */
  periodStart: ISODateString;
  periodEnd: ISODateString;
  trialEndsAt: ISODateString | null;
  /** Set when a cancellation is scheduled for period end rather than applied immediately. */
  cancelAt: ISODateString | null;
  cancelledAt: ISODateString | null;
  /** A downgrade that takes effect at period end, so paid-for capacity is not confiscated. */
  pendingPlanKey: string | null;
  pendingPlanAt: ISODateString | null;
  /** Per-tenant limit overrides, merged over the plan's. Enterprise contracts live here. */
  customLimits: Partial<PlanLimits> | null;
  /** Per-tenant overage overrides, including the deliberate transactional-block decision. */
  customOverage: Partial<OveragePolicy> | null;
  /**
   * When the last billing event we APPLIED occurred, on the PROVIDER's clock.
   *
   * Ordering is decided against this and never against `updatedAt`. `updatedAt` moves on the
   * platform's clock — it is stamped `NOW()` by the store on every write — so comparing an event's
   * provider timestamp against it compares two different clocks, and the answer is wrong by
   * whatever the delivery lag happens to be. Null until the first event lands.
   */
  lastBillingEventAt: ISODateString | null;
  /** Which BillingProvider owns this subscription: 'manual', 'razorpay', 'stripe'. */
  provider: string;
  providerRef: string | null;
  /** Why the tenant is suspended, in words an operator can read out to the customer. */
  suspendedReason: string | null;
  suspendedAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** Enterprise contract metadata. Descriptive; no engine reads it. */
export interface EnterpriseTerms {
  orgId: UUID;
  /** e.g. '99.9'. A string because it is contract text, not a computation input. */
  slaUptimePercent: string | null;
  slaSupportResponse: string | null;
  dedicatedInfra: boolean;
  dedicatedIps: string[];
  customSmtpHost: string | null;
  dataRetentionDays: number | null;
  dataRegion: string | null;
  contractRef: string | null;
  contractEndsAt: ISODateString | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Entitlement decisions
// ---------------------------------------------------------------------------

/**
 * Why a capability was refused. Machine-readable so a caller can branch, and so the UI can offer
 * the right next step: 'plan' offers an upgrade, 'permission' does not.
 */
export type DenyReason =
  | 'no_principal'
  | 'org_mismatch'
  | 'org_suspended'
  | 'subscription_inactive'
  | 'permission'
  | 'plan'
  | 'limit'
  | 'rate_limit'
  | 'unknown_capability';

export type QuotaState = 'ok' | 'warning' | 'soft_exceeded' | 'hard_exceeded';

/** One metric's standing against its limit. Returned whole so a UI never recomputes it. */
export interface LimitStatus {
  metric: MetricKey;
  kind: MetricKind;
  used: number;
  /** null = unlimited. */
  limit: number | null;
  /** Fraction of the limit consumed. 0 when unlimited, so a progress bar reads "no ceiling". */
  ratio: number;
  state: QuotaState;
  /** Amount consumed beyond `limit`. Zero unless state is soft_exceeded or hard_exceeded. */
  overage: number;
  /** The highest warn threshold this metric has crossed, or null. */
  crossedThreshold: number | null;
  /** How much more may be consumed before a refusal. null = no ceiling. */
  remaining: number | null;
}

export interface EntitlementDecision {
  capability: Capability;
  allowed: boolean;
  reason: DenyReason | null;
  /** One sentence for a human. Always present when `allowed` is false. Never "not allowed". */
  message: string | null;
  /** The metric that decided it, when a limit did. */
  metric: MetricKey | null;
  /** Present whenever the plan is the obstacle, so the UI can name the cheapest plan that works. */
  requiredFeature: PlanFeature | null;
  upgradeToPlanKey: string | null;
  /** The standing of every metric this capability consumes, limit reached or not. */
  limits: LimitStatus[];
  /**
   * True when the call was ALLOWED while past a limit. The caller must record overage and tell
   * somebody. This is how a critical transactional send survives an exhausted quota without the
   * exhaustion becoming invisible.
   */
  overage: boolean;
  /** A warning to surface even on an allowed call: "you have used 95% of your monthly sends". */
  notice: string | null;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export type BillingEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'plan.changed'
  | 'usage.threshold_reached';

export const BILLING_EVENT_TYPES: readonly BillingEventType[] = [
  'subscription.created', 'subscription.updated', 'subscription.cancelled',
  'payment.succeeded', 'payment.failed', 'plan.changed', 'usage.threshold_reached',
] as const;

/**
 * A billing fact, from a provider webhook or from this platform itself.
 *
 * `eventId` is UNIQUE per provider and is the idempotency key. Providers retry webhooks; a retry
 * that applies a plan change twice, or records a payment twice, is a customer-visible error. The
 * store refuses the duplicate at the index, and ./billing.ts reports it as `duplicate: true` rather
 * than as a failure — a provider retrying is correct behaviour, not an error condition.
 */
export interface BillingEvent {
  id: UUID;
  orgId: UUID | null;
  provider: string;
  eventId: string;
  type: BillingEventType;
  payload: Record<string, unknown>;
  /** Provider clock. Ordering is decided by this, never by arrival order. */
  occurredAt: ISODateString;
  receivedAt: ISODateString;
  processedAt: ISODateString | null;
  /** Set when applying the event failed. The row stays so it can be replayed, never dropped. */
  error: string | null;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface Invoice {
  id: UUID;
  orgId: UUID;
  number: string;
  status: InvoiceStatus;
  currency: string;
  /** Minor units. Subtotal excludes tax; total is what is owed. */
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number;
  periodStart: ISODateString | null;
  periodEnd: ISODateString | null;
  issuedAt: ISODateString | null;
  dueAt: ISODateString | null;
  paidAt: ISODateString | null;
  provider: string;
  providerRef: string | null;
  /** Provider-hosted invoice page. Null under the manual provider. */
  hostedUrl: string | null;
  lines: InvoiceLine[];
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
  /** Set when the line is metered overage rather than a subscription fee. */
  metric: MetricKey | null;
}

/** What a provider hands back when a customer is sent off to pay. */
export interface CheckoutSession {
  id: string;
  url: string | null;
  provider: string;
  expiresAt: ISODateString | null;
}

/** A threshold notice, recorded so the same warning is not sent twice in one period. */
export interface QuotaNotice {
  id: UUID;
  orgId: UUID;
  metric: MetricKey;
  periodStart: ISODateString;
  threshold: number;
  state: QuotaState;
  notifiedAt: ISODateString;
}
