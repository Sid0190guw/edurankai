// src/lib/mailplatform/saas/index.ts — the commercial layer's front door.
//
// Everything another subsystem needs is re-exported here, so a caller writes one import:
//
//   import { checkCapability, meter, usageKey } from '@/lib/mailplatform/saas';
//
// THE TWO CALLS ANOTHER SUBSYSTEM ACTUALLY NEEDS
//
//   checkCapability(orgId, userId, 'campaign.send', { amount: recipients })
//       Before doing the work. Returns a decision with a sentence to show; never throws.
//
//   meter(orgId, { metric: 'emails_sent', quantity: n, source: 'send-service',
//                  idempotencyKey: usageKey('message.sent', messageId) })
//       After doing it. The idempotency key identifies the FACT, so a retry is free.
//
// Nothing else in the platform should reach past these into ./quota or ./entitlements to make its
// own decision. One engine, one answer — the alternative is a send path and an API path that
// disagree about whether a tenant is over their limit, which the customer notices first.

export * from './types';

export {
  METRICS,
  METRIC_KEYS,
  COUNTER_METRICS,
  GAUGE_METRICS,
  PLAN_CATALOG,
  DEFAULT_PLAN_KEY,
  DEFAULT_OVERAGE,
  ORG_TYPE_DEFAULTS,
  PLAN_TIER_LABELS,
  FEATURE_LABELS,
  catalogPlan,
  cheapestPlanForMetric,
  cheapestPlanWithFeature,
  describeLimit,
  describeMetricValue,
  formatBytes,
  formatCount,
  isDowngrade,
  isMetricKey,
  isOrganizationType,
  limitFor,
  nextPlanUp,
  planHasFeature,
  resolveLimits,
  resolveOverage,
  resolvePlan,
  zeroMetrics,
} from './plans';

export { PLAN_PRICING, annualSavingPercent, currenciesFor, formatMoney, priceFor } from './pricing';

export type { SaasPermission, SaasOnlyPermission, RoleChangeContext, RoleChangeVerdict } from './roles';
export {
  ALL_SAAS_PERMISSIONS,
  CAPABILITY_PERMISSION,
  ROLE_PERMISSIONS,
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  TEAM_ROLE_RANK,
  canChangeRole,
  canRemoveMember,
  effectivePermissions,
  effectiveRole,
  normalizeTeamRole,
  permissionsFor,
  platformRoleFor,
  roleHas,
  teamRoleFor,
} from './roles';

export {
  addMonthsUtc,
  allCrossings,
  calendarPeriod,
  closingGauges,
  crossedThresholds,
  dailySeries,
  daysRemaining,
  emptySnapshot,
  inPeriod,
  nextPeriod,
  periodFor,
  periodProgress,
  projectedTotal,
  rollup,
  snapshotFromCounters,
  usageKey,
} from './usage';
export type { RollupInput, ThresholdCrossing, UsagePoint } from './usage';

export {
  SUSPENDED_STILL_ALLOWED,
  attentionNeeded,
  canConsume,
  checkRateLimit,
  describeSubscription,
  evaluateAll,
  isServiceable,
  limitStatus,
  suspensionAdvice,
} from './quota';
export type { ConsumeOptions, QuotaVerdict, SuspensionAdvice } from './quota';

export { CAPABILITIES, CAPABILITY_KEYS, checkEntitlement, explainAll, isCapability, refusalText } from './entitlements';
export type { CapabilityDescriptor, EntitlementContext, EntitlementOptions } from './entitlements';

export {
  ManualBillingProvider,
  PLANNED_PROVIDERS,
  applyBillingEvent,
  billingProviderStatus,
  changePlan,
  invoiceStatusFor,
  invoiceTotals,
  overageLines,
  registerBillingProvider,
  renew,
  resolveBillingProvider,
} from './billing';
export type {
  ApplyResult,
  BillingEffect,
  BillingProvider,
  CheckoutRequest,
  PlanChangeResult,
  WebhookInput,
} from './billing';

export { MemorySaasStore } from './store';
export type { MembershipRow, RecordResult, SaasStore, UsageEventQuery } from './store';
export { PgSaasStore, SAAS_DDL, ensureSaasSchema, saasSchemaSql } from './pg-store';

export {
  actorFor,
  billingOverview,
  changeOrganizationPlan,
  checkCapability,
  checkCapabilityForPrincipal,
  createOrganization,
  currentPeriod,
  entitlementContext,
  explainCapabilities,
  getSaasStore,
  ingestBillingEvent,
  inviteMember,
  meter,
  operatorActor,
  readMetric,
  recordPlatformBillingEvent,
  reconcile,
  removeMember,
  resolveTenantForUser,
  setMemberRole,
  setSaasStore,
  slugify,
  tenantContext,
  usageSnapshot,
  useMemoryStore,
} from './service';
export type {
  Actor,
  BillingOverview,
  MemberChangeResult,
  MeterInput,
  MeterResult,
  PlanChangeOutcome,
  TenantContext,
  WebhookOutcome,
} from './service';
