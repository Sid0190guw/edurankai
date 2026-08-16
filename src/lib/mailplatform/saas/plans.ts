// src/lib/mailplatform/saas/plans.ts — the metric registry and the plan catalog.
//
// PURE. No database, no prices (those are in ./pricing.ts and nothing here imports them).
//
// A PLAN IS DATA, NOT CODE. Nothing in this layer says `if (plan === 'professional')`. Everything a
// plan changes is expressed as a limit number or a feature flag, so a new plan is a new row in the
// catalog — or a custom row in `mp_plans` for one negotiated enterprise contract — and no engine
// changes. `resolvePlan()` is the only thing that knows a custom plan and a catalog plan are stored
// differently, and it returns the same `Plan` shape for both.
//
// TWO NUMBERS THAT LOOK ALIKE AND MEAN OPPOSITE THINGS
//
//   null = UNLIMITED. `0` = NOT AVAILABLE ON THIS PLAN.
//
// Reading a missing field as 0 would un-sell every unlimited Enterprise limit; reading 0 as
// "falsy, so no limit" would give the Free plan an unmetered API. Both mistakes are one `||` away,
// so every read of a limit in this layer goes through helpers that take the distinction seriously,
// and `saas-plans.test.ts` asserts it in both directions.

import type {
  MetricDescriptor,
  MetricKey,
  OrganizationType,
  OveragePolicy,
  Plan,
  PlanFeature,
  PlanLimits,
  PlanTier,
} from './types';

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * Every metered quantity, in display order.
 *
 * `limitField` is the join between a metric and the plan: the quota engine never contains a switch
 * over metric names, it reads this table. Adding a metered quantity is therefore one entry here
 * plus one field in PlanLimits, and nothing else in the layer is touched.
 */
export const METRICS: Record<MetricKey, MetricDescriptor> = {
  emails_sent: {
    key: 'emails_sent', kind: 'counter', label: 'Emails sent', unit: 'count',
    limitField: 'monthlySendQuota',
    hint: 'Outbound messages accepted for delivery this period, campaign and transactional alike.',
  },
  emails_received: {
    key: 'emails_received', kind: 'counter', label: 'Emails received', unit: 'count',
    limitField: 'monthlyReceiveQuota',
    hint: 'Inbound messages accepted into a mailbox this period.',
  },
  contacts: {
    key: 'contacts', kind: 'gauge', label: 'Contacts', unit: 'count',
    limitField: 'maxContacts',
    hint: 'Contact records held right now. Deleting contacts frees the allowance immediately.',
  },
  mailboxes: {
    key: 'mailboxes', kind: 'gauge', label: 'Mailboxes', unit: 'count',
    limitField: 'maxMailboxes',
    hint: 'Mailboxes that exist right now, including shared and group mailboxes.',
  },
  domains: {
    key: 'domains', kind: 'gauge', label: 'Domains', unit: 'count',
    limitField: 'maxDomains',
    hint: 'Sending and receiving domains attached to this organization.',
  },
  storage_bytes: {
    key: 'storage_bytes', kind: 'gauge', label: 'Storage', unit: 'bytes',
    limitField: 'storageBytes',
    hint: 'Message bodies and stored attachments across every mailbox.',
  },
  attachments: {
    key: 'attachments', kind: 'counter', label: 'Attachments', unit: 'count',
    // Metered but never capped as a count: the meaningful limit on attachments is the SIZE of any
    // one of them (maxAttachmentBytes), which is checked at upload rather than against a period.
    limitField: null,
    hint: 'Attachments stored this period. Metered for reporting; the size cap is per attachment.',
  },
  api_calls: {
    key: 'api_calls', kind: 'counter', label: 'API calls', unit: 'count',
    limitField: 'monthlyApiCalls',
    hint: 'Authenticated requests to the transactional API this period.',
  },
  webhook_deliveries: {
    key: 'webhook_deliveries', kind: 'counter', label: 'Webhook deliveries', unit: 'count',
    limitField: 'monthlyWebhookDeliveries',
    hint: 'Successful and failed webhook attempts. A retry counts, because it costs the same.',
  },
  automation_runs: {
    key: 'automation_runs', kind: 'counter', label: 'Automation runs', unit: 'count',
    limitField: 'monthlyAutomationRuns',
    hint: 'Workflow executions started this period.',
  },
  ai_units: {
    key: 'ai_units', kind: 'counter', label: 'AI usage', unit: 'count',
    limitField: 'monthlyAiUnits',
    hint: 'AI units consumed this period. One unit is one thousand tokens of model work.',
  },
  campaign_recipients: {
    key: 'campaign_recipients', kind: 'counter', label: 'Campaign recipients', unit: 'count',
    limitField: 'monthlyCampaignRecipients',
    hint: 'Recipients addressed by campaigns this period, counted once per recipient per campaign.',
  },
  users: {
    key: 'users', kind: 'gauge', label: 'Team members', unit: 'count',
    limitField: 'maxUsers',
    hint: 'Accounts that are members of this organization right now.',
  },
  teams: {
    key: 'teams', kind: 'gauge', label: 'Teams', unit: 'count',
    limitField: 'maxTeams',
    hint: 'Teams inside this organization right now.',
  },
  automations: {
    key: 'automations', kind: 'gauge', label: 'Automations', unit: 'count',
    limitField: 'maxAutomations',
    hint: 'Workflows that exist right now, active or paused.',
  },
};

export const METRIC_KEYS: MetricKey[] = Object.keys(METRICS) as MetricKey[];

export const COUNTER_METRICS: MetricKey[] = METRIC_KEYS.filter((k) => METRICS[k].kind === 'counter');
export const GAUGE_METRICS: MetricKey[] = METRIC_KEYS.filter((k) => METRICS[k].kind === 'gauge');

/** A metric key that arrived as a string from a request body or a database row. */
export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(METRICS, value);
}

/** Every metric at zero. The starting point for a snapshot, so no metric is ever `undefined`. */
export function zeroMetrics(): Record<MetricKey, number> {
  const out = {} as Record<MetricKey, number>;
  for (const k of METRIC_KEYS) out[k] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Overage policy
// ---------------------------------------------------------------------------

/**
 * The default policy, shared by every catalog plan.
 *
 * Sending and API traffic are SOFT: they can burst past the limit by a tenth and keep working,
 * because the alternative is that a customer's Monday morning stops at 09:14 with no warning.
 * Everything not listed is HARD — a tenant does not get to hold 200% of their contact allowance,
 * since that is storage somebody is not paying for and deleting it later is the customer's problem.
 *
 * `blockTransactionalOnHardLimit: false` is the important line, and section 8 of the brief is the
 * reason: never silently block critical transactional email. Here it is not silent and it is not
 * blocked — it is allowed, marked as overage, and reported.
 */
export const DEFAULT_OVERAGE: OveragePolicy = {
  softMetrics: ['emails_sent', 'api_calls', 'webhook_deliveries', 'campaign_recipients', 'ai_units'],
  softCeilingRatio: 0.1,
  warnThresholds: [0.8, 0.95, 1],
  blockTransactionalOnHardLimit: false,
};

/** The Free plan gets no burst room: an unpaid tenant bursting is an unpaid bill. */
const FREE_OVERAGE: OveragePolicy = {
  ...DEFAULT_OVERAGE,
  softMetrics: [],
  softCeilingRatio: 0,
};

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

function limits(l: PlanLimits): PlanLimits {
  return l;
}

const FREE_LIMITS = limits({
  maxUsers: 2, maxTeams: 1, maxMailboxes: 1, maxDomains: 1, maxContacts: 500,
  monthlySendQuota: 500, monthlyReceiveQuota: 5_000, monthlyCampaignRecipients: 500,
  monthlyAutomationRuns: 0, maxAutomations: 0,
  monthlyApiCalls: 0, apiRateLimitPerMinute: 0, monthlyWebhookDeliveries: 0, monthlyAiUnits: 0,
  storageBytes: 1 * GB, maxAttachmentBytes: 10 * MB, analyticsRetentionDays: 7,
});

const STARTER_LIMITS = limits({
  maxUsers: 3, maxTeams: 2, maxMailboxes: 5, maxDomains: 1, maxContacts: 5_000,
  monthlySendQuota: 10_000, monthlyReceiveQuota: 50_000, monthlyCampaignRecipients: 10_000,
  monthlyAutomationRuns: 1_000, maxAutomations: 5,
  monthlyApiCalls: 25_000, apiRateLimitPerMinute: 60, monthlyWebhookDeliveries: 25_000,
  monthlyAiUnits: 0,
  storageBytes: 10 * GB, maxAttachmentBytes: 25 * MB, analyticsRetentionDays: 30,
});

const PROFESSIONAL_LIMITS = limits({
  maxUsers: 10, maxTeams: 10, maxMailboxes: 25, maxDomains: 5, maxContacts: 50_000,
  monthlySendQuota: 100_000, monthlyReceiveQuota: 500_000, monthlyCampaignRecipients: 100_000,
  monthlyAutomationRuns: 25_000, maxAutomations: 50,
  monthlyApiCalls: 250_000, apiRateLimitPerMinute: 300, monthlyWebhookDeliveries: 250_000,
  monthlyAiUnits: 50_000,
  storageBytes: 100 * GB, maxAttachmentBytes: 50 * MB, analyticsRetentionDays: 180,
});

const BUSINESS_LIMITS = limits({
  maxUsers: 50, maxTeams: 50, maxMailboxes: 200, maxDomains: 25, maxContacts: 500_000,
  monthlySendQuota: 1_000_000, monthlyReceiveQuota: 5_000_000, monthlyCampaignRecipients: 1_000_000,
  monthlyAutomationRuns: 250_000, maxAutomations: 500,
  monthlyApiCalls: 2_500_000, apiRateLimitPerMinute: 1_200, monthlyWebhookDeliveries: 2_500_000,
  monthlyAiUnits: 500_000,
  storageBytes: 1_024 * GB, maxAttachmentBytes: 100 * MB, analyticsRetentionDays: 365,
});

/** Every field null: unlimited across the board. Real ceilings come from the negotiated contract. */
const ENTERPRISE_LIMITS = limits({
  maxUsers: null, maxTeams: null, maxMailboxes: null, maxDomains: null, maxContacts: null,
  monthlySendQuota: null, monthlyReceiveQuota: null, monthlyCampaignRecipients: null,
  monthlyAutomationRuns: null, maxAutomations: null,
  monthlyApiCalls: null, apiRateLimitPerMinute: null, monthlyWebhookDeliveries: null,
  monthlyAiUnits: null,
  storageBytes: null, maxAttachmentBytes: 250 * MB, analyticsRetentionDays: null,
});

export const PLAN_CATALOG: Plan[] = [
  {
    key: 'free', name: 'Free', tier: 'free', sortOrder: 0, isCustom: false, orgId: null, isActive: true,
    description: 'One mailbox, one domain and enough sending to try the platform properly.',
    limits: FREE_LIMITS, features: [], overage: FREE_OVERAGE,
  },
  {
    key: 'starter', name: 'Starter', tier: 'starter', sortOrder: 1, isCustom: false, orgId: null, isActive: true,
    description: 'A small team sending campaigns and transactional mail from one domain.',
    limits: STARTER_LIMITS,
    features: ['campaigns', 'api', 'webhooks', 'automation'],
    overage: DEFAULT_OVERAGE,
  },
  {
    key: 'professional', name: 'Professional', tier: 'professional', sortOrder: 2, isCustom: false, orgId: null, isActive: true,
    description: 'Multiple domains, real automation, AI assistance and a year of reporting.',
    limits: PROFESSIONAL_LIMITS,
    features: ['campaigns', 'automation', 'api', 'webhooks', 'ai', 'advanced_analytics', 'custom_tracking_domain'],
    overage: DEFAULT_OVERAGE,
  },
  {
    key: 'business', name: 'Business', tier: 'business', sortOrder: 3, isCustom: false, orgId: null, isActive: true,
    description: 'Volume sending, single sign-on, exportable analytics and an audit log.',
    limits: BUSINESS_LIMITS,
    features: [
      'campaigns', 'automation', 'api', 'webhooks', 'ai', 'advanced_analytics',
      'custom_tracking_domain', 'analytics_export', 'sso', 'audit_log', 'priority_support',
    ],
    overage: DEFAULT_OVERAGE,
  },
  {
    key: 'enterprise', name: 'Enterprise', tier: 'enterprise', sortOrder: 4, isCustom: false, orgId: null, isActive: true,
    description: 'Negotiated limits, dedicated sending infrastructure and a contracted SLA.',
    limits: ENTERPRISE_LIMITS,
    features: [
      'campaigns', 'automation', 'api', 'webhooks', 'ai', 'advanced_analytics',
      'custom_tracking_domain', 'analytics_export', 'sso', 'audit_log', 'priority_support',
      'dedicated_ip', 'custom_smtp', 'sla',
    ],
    overage: DEFAULT_OVERAGE,
  },
];

export const DEFAULT_PLAN_KEY = 'free';

const CATALOG_BY_KEY: Record<string, Plan> = Object.fromEntries(PLAN_CATALOG.map((p) => [p.key, p]));

/** A catalog plan by key, or null. Never throws on an unknown key — callers decide what that means. */
export function catalogPlan(key: string | null | undefined): Plan | null {
  if (!key) return null;
  return CATALOG_BY_KEY[key] || null;
}

/**
 * The plan a tenant is actually on.
 *
 * `customPlans` are rows from `mp_plans` — negotiated Enterprise contracts, or a plan built for one
 * partner. A custom plan wins over a catalog plan with the same key, which is how "Enterprise, but
 * with 40 domains" is expressed without inventing a plan tier.
 *
 * An unknown key falls back to Free and SAYS SO through the returned plan's key, rather than
 * throwing: a tenant whose plan row references a plan somebody deleted must still be able to read
 * their mail while an operator sorts it out. Refusing to resolve would take the tenant down.
 */
export function resolvePlan(planKey: string | null | undefined, customPlans: Plan[] = []): Plan {
  const custom = customPlans.find((p) => p.key === planKey && p.isActive);
  if (custom) return custom;
  return catalogPlan(planKey) || CATALOG_BY_KEY[DEFAULT_PLAN_KEY];
}

// ---------------------------------------------------------------------------
// Limit resolution
// ---------------------------------------------------------------------------

/**
 * Plan limits with per-tenant overrides applied.
 *
 * THE SUBTLETY: `undefined` and `null` are different answers in `overrides`.
 *   - a field ABSENT (undefined) means "not negotiated, use the plan's number"
 *   - a field set to `null` means "negotiated to unlimited"
 * A spread would collapse the two, because `{...plan, ...{maxDomains: undefined}}` sets
 * `maxDomains` to undefined and the tenant loses their limit entirely. So this walks the keys and
 * only takes an override that was actually provided.
 */
export function resolveLimits(plan: Plan, overrides?: Partial<PlanLimits> | null): PlanLimits {
  const base = { ...plan.limits };
  if (!overrides) return base;
  for (const key of Object.keys(base) as (keyof PlanLimits)[]) {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) {
      base[key] = overrides[key] as number | null;
    }
  }
  return base;
}

/** Overage policy with per-tenant overrides applied, same undefined-versus-null care. */
export function resolveOverage(plan: Plan, overrides?: Partial<OveragePolicy> | null): OveragePolicy {
  const base: OveragePolicy = {
    softMetrics: [...plan.overage.softMetrics],
    softCeilingRatio: plan.overage.softCeilingRatio,
    warnThresholds: [...plan.overage.warnThresholds],
    blockTransactionalOnHardLimit: plan.overage.blockTransactionalOnHardLimit,
  };
  if (!overrides) return normalizeOverage(base);
  if (overrides.softMetrics !== undefined && Array.isArray(overrides.softMetrics)) {
    base.softMetrics = [...overrides.softMetrics];
  }
  if (typeof overrides.softCeilingRatio === 'number') base.softCeilingRatio = overrides.softCeilingRatio;
  if (overrides.warnThresholds !== undefined && Array.isArray(overrides.warnThresholds)) {
    base.warnThresholds = [...overrides.warnThresholds];
  }
  if (typeof overrides.blockTransactionalOnHardLimit === 'boolean') {
    base.blockTransactionalOnHardLimit = overrides.blockTransactionalOnHardLimit;
  }
  return normalizeOverage(base);
}

/** Thresholds sorted, deduplicated and clamped; a negative ceiling ratio is read as none. */
function normalizeOverage(p: OveragePolicy): OveragePolicy {
  const thresholds = Array.from(new Set(p.warnThresholds.filter((t) => Number.isFinite(t) && t > 0)))
    .sort((a, b) => a - b);
  return {
    softMetrics: p.softMetrics.filter((m) => isMetricKey(m)),
    softCeilingRatio: Number.isFinite(p.softCeilingRatio) && p.softCeilingRatio > 0 ? p.softCeilingRatio : 0,
    warnThresholds: thresholds.length ? thresholds : [1],
    blockTransactionalOnHardLimit: p.blockTransactionalOnHardLimit === true,
  };
}

/** The limit for one metric, or null when the metric is unlimited or not limited at all. */
export function limitFor(metric: MetricKey, limits: PlanLimits): number | null {
  const field = METRICS[metric].limitField;
  if (!field) return null;
  const value = limits[field];
  return value === undefined ? null : value;
}

export function planHasFeature(plan: Plan, feature: PlanFeature): boolean {
  return plan.features.includes(feature);
}

// ---------------------------------------------------------------------------
// Upgrade suggestions
// ---------------------------------------------------------------------------

/**
 * The cheapest active catalog plan that includes a feature.
 *
 * "Cheapest" is read from `sortOrder`, NOT from a price — this file must not know what anything
 * costs (see the header). Catalog order is the commercial ladder, and a price change does not
 * reorder it.
 */
export function cheapestPlanWithFeature(feature: PlanFeature, from: Plan[] = PLAN_CATALOG): string | null {
  const found = [...from]
    .filter((p) => p.isActive && !p.isCustom && p.features.includes(feature))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return found ? found.key : null;
}

/** The cheapest active catalog plan whose limit for `metric` covers `needed`. */
export function cheapestPlanForMetric(
  metric: MetricKey,
  needed: number,
  from: Plan[] = PLAN_CATALOG,
): string | null {
  const found = [...from]
    .filter((p) => p.isActive && !p.isCustom)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .find((p) => {
      const l = limitFor(metric, p.limits);
      return l === null || l >= needed;
    });
  return found ? found.key : null;
}

/** The next plan up the ladder from this one, or null at the top. */
export function nextPlanUp(planKey: string, from: Plan[] = PLAN_CATALOG): string | null {
  const current = catalogPlan(planKey);
  const order = current ? current.sortOrder : -1;
  const next = [...from]
    .filter((p) => p.isActive && !p.isCustom && p.sortOrder > order)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return next ? next.key : null;
}

/**
 * Is moving from one plan to another a downgrade?
 *
 * Decides whether a change applies NOW or at period end. An upgrade takes effect immediately —
 * the customer has just paid for more and should get it. A downgrade waits for the period boundary,
 * because taking away capacity somebody has already paid for, mid-period, is a refund conversation
 * nobody wants to have.
 */
export function isDowngrade(fromKey: string, toKey: string, from: Plan[] = PLAN_CATALOG): boolean {
  const a = from.find((p) => p.key === fromKey) || catalogPlan(fromKey);
  const b = from.find((p) => p.key === toKey) || catalogPlan(toKey);
  if (!a || !b) return false;
  return b.sortOrder < a.sortOrder;
}

// ---------------------------------------------------------------------------
// Organization-type defaults
// ---------------------------------------------------------------------------

/**
 * What we SUGGEST when a tenant of this type signs up.
 *
 * Read exactly once, at organization creation, to pre-fill a form. No engine reads it, and section
 * 2 of the brief is why: behaviour must not be hard-coded to organization type. A university that
 * picks Free gets the Free plan's limits, identically to everybody else on Free.
 */
export const ORG_TYPE_DEFAULTS: Record<OrganizationType, {
  label: string;
  suggestedPlanKey: string;
  /** Shown next to the suggestion so the choice is explained rather than imposed. */
  rationale: string;
}> = {
  individual: {
    label: 'Individual', suggestedPlanKey: 'free',
    rationale: 'One person, one mailbox. Move up when you add a second domain.',
  },
  startup: {
    label: 'Startup', suggestedPlanKey: 'starter',
    rationale: 'A small team that needs the API and campaigns from day one.',
  },
  company: {
    label: 'Company', suggestedPlanKey: 'professional',
    rationale: 'Several domains, automation and reporting that outlives a quarter.',
  },
  university: {
    label: 'University', suggestedPlanKey: 'business',
    rationale: 'Departmental mailboxes, high volume at intake, and single sign-on.',
  },
  government: {
    label: 'Government', suggestedPlanKey: 'business',
    rationale: 'Audit log, exportable analytics and a documented retention period.',
  },
  enterprise: {
    label: 'Enterprise', suggestedPlanKey: 'enterprise',
    rationale: 'Negotiated limits, dedicated infrastructure and a contracted SLA.',
  },
  partner: {
    label: 'Partner', suggestedPlanKey: 'professional',
    rationale: 'Sends on behalf of its own customers; usually needs custom tracking domains.',
  },
};

export function isOrganizationType(value: unknown): value is OrganizationType {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(ORG_TYPE_DEFAULTS, value);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Bytes as a human string. Kept here so the admin screens and the API agree on the wording. */
export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= GB) return (n / GB).toFixed(n % GB === 0 ? 0 : 1) + ' GB';
  if (abs >= MB) return (n / MB).toFixed(n % MB === 0 ? 0 : 1) + ' MB';
  if (abs >= KB) return (n / KB).toFixed(0) + ' KB';
  return String(n) + ' B';
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(n));
}

/** A limit as words. This is the one place `null` and `0` are turned into English. */
export function describeLimit(value: number | null, unit: 'count' | 'bytes' = 'count'): string {
  if (value === null) return 'Unlimited';
  if (value === 0) return 'Not included';
  return unit === 'bytes' ? formatBytes(value) : formatCount(value);
}

export function describeMetricValue(metric: MetricKey, value: number): string {
  return METRICS[metric].unit === 'bytes' ? formatBytes(value) : formatCount(value);
}

export const PLAN_TIER_LABELS: Record<PlanTier, string> = {
  free: 'Free',
  starter: 'Starter',
  professional: 'Professional',
  business: 'Business',
  enterprise: 'Enterprise',
};

export const FEATURE_LABELS: Record<PlanFeature, string> = {
  campaigns: 'Campaigns',
  automation: 'Automation workflows',
  api: 'Transactional API',
  webhooks: 'Webhooks',
  ai: 'AI assistance',
  custom_tracking_domain: 'Custom tracking domain',
  advanced_analytics: 'Advanced analytics',
  analytics_export: 'Analytics export',
  sso: 'Single sign-on',
  audit_log: 'Audit log',
  dedicated_ip: 'Dedicated sending IP',
  custom_smtp: 'Custom SMTP relay',
  sla: 'Contracted SLA',
  priority_support: 'Priority support',
};
