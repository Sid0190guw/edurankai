// src/lib/mailplatform/saas/entitlements.ts — the one place a premium capability is decided.
//
// PURE. Data in, decision out. No database, no clock, no prices (a test asserts this file never
// imports ./pricing.ts).
//
// Section 7 of the brief: every premium capability checks organization, plan, entitlement, usage
// and permission. Those five checks exist in ONE function here, in one order, and every caller in
// the platform goes through it. The alternative — each route deciding for itself — is how a
// campaign send ends up checking the plan while the API route that sends the same campaign checks
// only the permission, and the customer discovers the gap before we do.
//
// THE ORDER IS THE DESIGN, and it is the order a person would reason in:
//
//   1. Is there a caller at all?
//   2. Is the caller inside the tenant they are asking about?     <- tenant isolation, first-class
//   3. Is the organization in a state where we do work for it?
//   4. Is the subscription in such a state?
//   5. Is this person allowed to?                                 <- permission
//   6. Does the plan include it?                                  <- entitlement
//   7. Is there quota left?                                       <- usage
//
// Permission before plan is deliberate. An Analyst asking to send a campaign should be told they
// are not allowed to, not offered an upgrade — quoting a price at somebody who lacks the permission
// is both wrong and slightly insulting, and it sends them to their Admin asking to spend money that
// would not have helped.
//
// ONE MORE RULE, AND IT IS THE ANTI-ABUSE ONE: only capabilities marked `criticalEligible` may
// claim the transactional carve-out in ./quota.ts. Without that, `critical: true` on a campaign
// send is a one-line bypass of every sending limit in the product.

import type {
  Capability,
  EntitlementDecision,
  LimitStatus,
  MetricKey,
  OveragePolicy,
  Plan,
  PlanFeature,
  PlanLimits,
  SubscriptionStatus,
  UsageSnapshot,
  UUID,
} from './types';
import type { OrganizationStatus } from '../types';
import type { TeamRole } from './types';
import type { SaasPermission } from './roles';
import { CAPABILITY_PERMISSION, roleHas } from './roles';
import { SUSPENDED_STILL_ALLOWED, canConsume, isServiceable } from './quota';
import { METRICS, cheapestPlanForMetric, cheapestPlanWithFeature, describeMetricValue } from './plans';

// ---------------------------------------------------------------------------
// The capability registry
// ---------------------------------------------------------------------------

export interface CapabilityDescriptor {
  key: Capability;
  label: string;
  /** Which plan flag must be present. Null means every plan includes it. */
  feature: PlanFeature | null;
  /** Metrics this call consumes. Checked in order; the first refusal decides. */
  meters: MetricKey[];
  /**
   * May this capability claim the transactional carve-out?
   *
   * True for exactly the two paths that carry password resets and receipts. A campaign cannot claim
   * it however loudly the caller asks, which is the point — see the file header.
   */
  criticalEligible: boolean;
  /** Still available while the organization or subscription is suspended. */
  allowedWhenSuspended: boolean;
}

function cap(
  key: Capability,
  label: string,
  feature: PlanFeature | null,
  meters: MetricKey[],
  extra: Partial<Pick<CapabilityDescriptor, 'criticalEligible' | 'allowedWhenSuspended'>> = {},
): CapabilityDescriptor {
  return {
    key,
    label,
    feature,
    meters,
    criticalEligible: extra.criticalEligible === true,
    allowedWhenSuspended: extra.allowedWhenSuspended === true,
  };
}

export const CAPABILITIES: Record<Capability, CapabilityDescriptor> = {
  // Messaging. `mail.send` is the transactional path, so it is critical-eligible.
  'mail.send': cap('mail.send', 'Send mail', null, ['emails_sent'], { criticalEligible: true }),
  'mail.read': cap('mail.read', 'Read mail', null, [], { allowedWhenSuspended: true }),
  'mailbox.create': cap('mailbox.create', 'Create a mailbox', null, ['mailboxes']),

  // Campaigns. Deliberately NOT critical-eligible: a marketing send is never an emergency.
  'campaign.create': cap('campaign.create', 'Create a campaign', 'campaigns', []),
  'campaign.send': cap('campaign.send', 'Send a campaign', 'campaigns', ['campaign_recipients', 'emails_sent']),
  'campaign.schedule': cap('campaign.schedule', 'Schedule a campaign', 'campaigns', []),

  'contact.create': cap('contact.create', 'Add a contact', null, ['contacts']),
  'contact.import': cap('contact.import', 'Import contacts', null, ['contacts']),

  'domain.add': cap('domain.add', 'Add a domain', null, ['domains']),
  'domain.verify': cap('domain.verify', 'Verify a domain', null, []),
  'domain.custom_tracking': cap('domain.custom_tracking', 'Custom tracking domain', 'custom_tracking_domain', []),

  'automation.create': cap('automation.create', 'Create an automation', 'automation', ['automations']),
  'automation.execute': cap('automation.execute', 'Run an automation', 'automation', ['automation_runs']),

  // The API is the other transactional path.
  'api.send': cap('api.send', 'Send through the API', 'api', ['api_calls', 'emails_sent'], { criticalEligible: true }),
  'api.key.create': cap('api.key.create', 'Create an API key', 'api', []),
  'webhook.create': cap('webhook.create', 'Create a webhook', 'webhooks', []),
  'webhook.deliver': cap('webhook.deliver', 'Deliver a webhook', 'webhooks', ['webhook_deliveries']),

  'ai.summarize': cap('ai.summarize', 'Summarise with AI', 'ai', ['ai_units']),
  'ai.compose': cap('ai.compose', 'Compose with AI', 'ai', ['ai_units']),

  'analytics.view': cap('analytics.view', 'View analytics', null, [], { allowedWhenSuspended: true }),
  'analytics.export': cap('analytics.export', 'Export analytics', 'analytics_export', []),

  // Administration stays available while suspended, on purpose: the actions that FIX a suspension
  // are billing and organization management, and locking those behind the suspension would leave
  // the customer with no way out except a support ticket.
  'org.manage': cap('org.manage', 'Manage the organization', null, [], { allowedWhenSuspended: true }),
  'billing.manage': cap('billing.manage', 'Manage billing', null, [], { allowedWhenSuspended: true }),
  'team.manage': cap('team.manage', 'Manage the team', null, [], { allowedWhenSuspended: true }),
  'team.invite': cap('team.invite', 'Invite a team member', null, ['users']),
  'team.create': cap('team.create', 'Create a team', null, ['teams']),
};

export const CAPABILITY_KEYS: Capability[] = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

// ---------------------------------------------------------------------------
// The context a decision is made against
// ---------------------------------------------------------------------------

export interface EntitlementContext {
  /** The tenant the request is ABOUT. */
  orgId: UUID;
  /**
   * The signed-in account, or null when nobody is signed in.
   *
   * Separate from `role` and from `principalOrgId` because "nobody is here" and "somebody is here
   * who does not belong to this tenant" are different refusals with different next steps, and
   * collapsing them tells a signed-in user to sign in.
   */
  principalId?: string | null;
  /** The tenant the caller belongs to. A mismatch is refused before anything else is read. */
  principalOrgId: UUID | null;
  orgStatus: OrganizationStatus;
  role: TeamRole | null;
  /**
   * An explicit permission set, for callers whose authority is narrower than their role — an API
   * key with scopes, for instance. When present it REPLACES the role's set rather than adding to
   * it, so a scoped key can never do more than its scopes say.
   */
  permissions?: SaasPermission[] | null;
  subscriptionStatus: SubscriptionStatus;
  plan: Plan;
  limits: PlanLimits;
  overage: OveragePolicy;
  usage: UsageSnapshot;
}

export interface EntitlementOptions {
  /** Units to be consumed, applied to every metric the capability meters. Defaults to 1. */
  amount?: number;
  /** Per-metric amounts, for calls that consume different quantities of different things. */
  amounts?: Partial<Record<MetricKey, number>>;
  /**
   * The caller asserts this is transactional and that refusing it locks somebody out. Honoured
   * only for a `criticalEligible` capability; ignored, silently and correctly, everywhere else.
   */
  critical?: boolean;
}

function deny(
  capability: Capability,
  reason: EntitlementDecision['reason'],
  message: string,
  extra: Partial<EntitlementDecision> = {},
): EntitlementDecision {
  return {
    capability,
    allowed: false,
    reason,
    message,
    metric: null,
    requiredFeature: null,
    upgradeToPlanKey: null,
    limits: [],
    overage: false,
    notice: null,
    ...extra,
  };
}

/**
 * The whole question, answered once.
 *
 * Returns a decision rather than throwing, for the reason stated at the top of ../interfaces.ts: an
 * expected failure that arrives as an exception ends up in somebody's `catch {}` and disappears.
 * A tenant being out of quota is an expected failure and happens every day.
 */
export function checkEntitlement(
  capability: Capability,
  ctx: EntitlementContext,
  opts: EntitlementOptions = {},
): EntitlementDecision {
  const descriptor = CAPABILITIES[capability];
  if (!descriptor) {
    return deny(capability, 'unknown_capability', 'No such capability: ' + String(capability) + '.');
  }

  // 1. Is there a caller at all? Identity, not authority — an outsider IS signed in, and is
  //    refused by the tenant check below rather than being told to sign in again.
  const hasIdentity = ctx.principalId !== undefined
    ? Boolean(ctx.principalId)
    : Boolean(ctx.role || ctx.permissions);
  if (!hasIdentity) {
    return deny(capability, 'no_principal', 'You are not signed in.');
  }

  // 2. TENANT ISOLATION. A caller from another organization is refused here, before a single
  //    number belonging to this tenant is read — the decision must not leak so much as a usage
  //    figure across the boundary. `principalOrgId: null` means the caller's tenant was never
  //    resolved, which is a refusal and not a wildcard.
  if (!ctx.principalOrgId || ctx.principalOrgId !== ctx.orgId) {
    return deny(capability, 'org_mismatch', 'This account does not belong to that organization.');
  }

  // 3. Organization standing.
  if (ctx.orgStatus !== 'active' && !descriptor.allowedWhenSuspended) {
    return deny(
      capability,
      'org_suspended',
      ctx.orgStatus === 'closed'
        ? 'This organization is closed.'
        : 'This organization is suspended. Billing and administration still work, so the suspension can be resolved from inside the account.',
    );
  }

  // 4. Subscription standing. `past_due` is serviceable on purpose — see ./quota.ts.
  if (!isServiceable(ctx.subscriptionStatus) && !descriptor.allowedWhenSuspended) {
    const permission = CAPABILITY_PERMISSION[capability];
    if (!SUSPENDED_STILL_ALLOWED.includes(permission)) {
      return deny(
        capability,
        'subscription_inactive',
        'The subscription is ' + ctx.subscriptionStatus + '. Reading existing mail and managing billing still work.',
      );
    }
  }

  // 5. Permission.
  const permission = CAPABILITY_PERMISSION[capability];
  const holds = ctx.permissions
    ? ctx.permissions.includes(permission)
    : roleHas(ctx.role, permission);
  if (!holds) {
    return deny(
      capability,
      'permission',
      'Your role does not include ' + descriptor.label.toLowerCase() + '.',
    );
  }

  // 6. Plan feature. Only now is an upgrade the right thing to offer.
  if (descriptor.feature && !ctx.plan.features.includes(descriptor.feature)) {
    const upgrade = cheapestPlanWithFeature(descriptor.feature);
    return deny(
      capability,
      'plan',
      descriptor.label + ' is not included on the ' + ctx.plan.name + ' plan.',
      { requiredFeature: descriptor.feature, upgradeToPlanKey: upgrade },
    );
  }

  // 7. Usage. Every metered quantity is checked; the first refusal decides, and the standing of all
  //    of them travels back either way so a UI can show the whole picture rather than one number.
  const critical = opts.critical === true && descriptor.criticalEligible;
  const statuses: LimitStatus[] = [];
  let overage = false;
  let notice: string | null = null;

  for (const metric of descriptor.meters) {
    const amount = amountFor(metric, opts);
    const verdict = canConsume(metric, ctx.usage.values[metric] || 0, ctx.limits, ctx.overage, {
      amount,
      critical,
    });
    statuses.push(verdict.status);

    if (!verdict.allowed) {
      const needed = (ctx.usage.values[metric] || 0) + amount;
      const upgrade = cheapestPlanForMetric(metric, needed);
      return deny(capability, 'limit', verdict.message || quotaFallbackMessage(metric, verdict.status.limit), {
        metric,
        limits: statuses,
        upgradeToPlanKey: upgrade === ctx.plan.key ? null : upgrade,
      });
    }
    if (verdict.overage) overage = true;
    if (verdict.message && !notice) notice = verdict.message;
  }

  return {
    capability,
    allowed: true,
    reason: null,
    message: null,
    metric: null,
    requiredFeature: null,
    upgradeToPlanKey: null,
    limits: statuses,
    overage,
    notice,
  };
}

function amountFor(metric: MetricKey, opts: EntitlementOptions): number {
  if (opts.amounts && Number.isFinite(opts.amounts[metric] as number)) {
    return Math.max(0, opts.amounts[metric] as number);
  }
  if (Number.isFinite(opts.amount as number)) return Math.max(0, opts.amount as number);
  return 1;
}

function quotaFallbackMessage(metric: MetricKey, limit: number | null): string {
  const label = METRICS[metric] ? METRICS[metric].label.toLowerCase() : metric;
  if (limit === null) return 'The ' + label + ' limit was reached.';
  return 'The ' + label + ' limit of ' + describeMetricValue(metric, limit) + ' was reached.';
}

// ---------------------------------------------------------------------------
// Bulk explanation, for screens
// ---------------------------------------------------------------------------

/**
 * Every capability, decided at once.
 *
 * This is what makes the entitlement engine something an operator can SEE rather than something
 * they infer from a refusal. The admin billing screen renders it as a matrix: here is every premium
 * capability, here is whether this tenant has it, and here is the reason when they do not.
 *
 * Asks the question at the DEFAULT amount of one, because "could you do this once more" is the
 * question a matrix answers. Asking at zero would show a tenant who has used their last contact as
 * still able to add one, which is the opposite of what the screen exists to tell them.
 */
export function explainAll(ctx: EntitlementContext): EntitlementDecision[] {
  return CAPABILITY_KEYS.map((key) => checkEntitlement(key, ctx));
}

/** The capabilities this context can currently exercise. */
export function allowedCapabilities(ctx: EntitlementContext): Capability[] {
  return explainAll(ctx).filter((d) => d.allowed).map((d) => d.capability);
}

/**
 * A short reason for a refusal, safe to show an end user.
 *
 * The engine's `message` is already written for a person, so this is a passthrough with a floor —
 * an empty message would render as a blank error box, which is the worst possible failure text.
 */
export function refusalText(decision: EntitlementDecision): string {
  if (decision.allowed) return '';
  return decision.message || 'That is not available on this account right now.';
}
