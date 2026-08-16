// src/lib/mailplatform/saas/quota.ts — soft limits, hard limits, warnings, overage, suspension.
//
// PURE. Takes a usage snapshot and a limit set, returns decisions. No database, no clock of its own
// (every function that needs "now" is handed it), no prices.
//
// THE POLICY THIS FILE IMPLEMENTS, IN ORDER OF HOW MUCH IT MATTERS
//
// 1. CRITICAL TRANSACTIONAL MAIL IS NEVER SILENTLY BLOCKED. Section 8 of the brief says so, and it
//    is the correct rule: a password reset, a verification code and a payment receipt are somebody
//    ELSE'S user being locked out of an account, and they cannot upgrade the plan to fix it. Out of
//    quota, a critical send is ALLOWED, flagged as overage, and reported. It can be blocked only
//    when the tenant has explicitly turned `blockTransactionalOnHardLimit` on — a deliberate,
//    recorded, per-tenant decision — and even then the refusal carries a sentence saying why.
//
// 2. `null` IS UNLIMITED, `0` IS NOT INCLUDED. The two look alike in a truthiness test and mean
//    opposite things. Every read here goes through an explicit `=== null` check.
//
// 3. A SOFT LIMIT IS NOT AN UNLIMITED LIMIT. It has a ceiling. Past the ceiling a soft metric
//    refuses like any other — otherwise "soft" means "there is no limit", and the number on the
//    pricing page is decoration.
//
// 4. NOTHING SUSPENDS ITSELF QUIETLY. `suspensionAdvice()` returns advice with a reason in words,
//    for a caller to act on and record. This file never decides that a customer is cut off; it says
//    what the policy implies and who it applies to.

import type {
  LimitStatus,
  MetricKey,
  OveragePolicy,
  PlanLimits,
  QuotaState,
  Subscription,
  SubscriptionStatus,
  UsageSnapshot,
} from './types';
import { METRICS, METRIC_KEYS, describeMetricValue, limitFor } from './plans';

// ---------------------------------------------------------------------------
// One metric against its limit
// ---------------------------------------------------------------------------

/**
 * Where one metric stands.
 *
 * `used` is what the meter says. The returned status is complete — a caller never has to recompute
 * a ratio or decide what a state means, which is how two screens end up disagreeing about whether
 * a tenant is over their limit.
 */
export function limitStatus(
  metric: MetricKey,
  used: number,
  limits: PlanLimits,
  overage: OveragePolicy,
): LimitStatus {
  const kind = METRICS[metric] ? METRICS[metric].kind : 'counter';
  const limit = limitFor(metric, limits);
  const u = Number.isFinite(used) ? Math.max(0, used) : 0;

  // Unlimited, or metered-but-never-limited. Ratio 0 so a progress bar reads as no ceiling rather
  // than as full.
  if (limit === null) {
    return {
      metric, kind, used: u, limit: null, ratio: 0, state: 'ok',
      overage: 0, crossedThreshold: null, remaining: null,
    };
  }

  // Not included on this plan. There is no allowance to be part-way through, so it is exceeded from
  // the first unit — including zero, because zero units of an allowance of zero still means the
  // next call is refused.
  if (limit === 0) {
    return {
      metric, kind, used: u, limit: 0, ratio: 1, state: 'hard_exceeded',
      overage: u, crossedThreshold: 1, remaining: 0,
    };
  }

  const ratio = u / limit;
  const isSoft = overage.softMetrics.includes(metric);
  const ceiling = isSoft ? limit * (1 + Math.max(0, overage.softCeilingRatio)) : limit;

  // STRICTLY GREATER THAN, not >=. A limit of 10,000 means the ten-thousandth message is allowed
  // and the ten-thousand-and-first is not. Using >= here costs the customer the last unit of every
  // allowance they bought, which is the sort of off-by-one that reads as deliberate.
  let state: QuotaState = 'ok';
  if (u > ceiling) state = 'hard_exceeded';
  else if (u > limit) state = 'soft_exceeded';
  else if (overage.warnThresholds.some((t) => t < 1 && ratio >= t)) state = 'warning';

  const crossed = [...overage.warnThresholds]
    .filter((t) => ratio >= t)
    .sort((a, b) => b - a)[0];

  return {
    metric,
    kind,
    used: u,
    limit,
    ratio,
    state,
    overage: u > limit ? u - limit : 0,
    crossedThreshold: crossed === undefined ? null : crossed,
    remaining: Math.max(0, Math.floor(ceiling - u)),
  };
}

/** Every metric's standing, in display order. Nothing is omitted, including unlimited metrics. */
export function evaluateAll(
  snapshot: UsageSnapshot,
  limits: PlanLimits,
  overage: OveragePolicy,
): LimitStatus[] {
  return METRIC_KEYS.map((m) => limitStatus(m, snapshot.values[m] || 0, limits, overage));
}

/** Only the metrics an operator needs to look at. Used for the banner on the billing screen. */
export function attentionNeeded(statuses: LimitStatus[]): LimitStatus[] {
  return statuses
    .filter((s) => s.state !== 'ok')
    .sort((a, b) => severity(b.state) - severity(a.state) || b.ratio - a.ratio);
}

function severity(state: QuotaState): number {
  if (state === 'hard_exceeded') return 3;
  if (state === 'soft_exceeded') return 2;
  if (state === 'warning') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// May I consume more?
// ---------------------------------------------------------------------------

export interface ConsumeOptions {
  /**
   * True when refusing this call would break somebody who is not the customer — a password reset,
   * a verification code, a receipt. Sets the carve-out in rule 1 at the top of this file.
   */
  critical?: boolean;
  /** How many units the call would consume. Defaults to 1. */
  amount?: number;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** The state the metric would be in AFTER this call. */
  state: QuotaState;
  /** True when the call is allowed while past the limit and must be recorded as overage. */
  overage: boolean;
  /** How far past the limit the call would put the tenant. */
  overageAmount: number;
  /** A sentence for a person. Present on every refusal, and on any allowed call worth flagging. */
  message: string | null;
  status: LimitStatus;
}

/**
 * The pre-flight check: may this tenant consume `amount` more of `metric`?
 *
 * Projects the metric FORWARD by `amount` before deciding, rather than checking the current value.
 * Checking the current value lets a single campaign to two hundred thousand recipients start
 * because the tenant was at 99% when it began — and a campaign, once started, is not a thing you
 * can take back out of people's inboxes.
 */
export function canConsume(
  metric: MetricKey,
  currentUsed: number,
  limits: PlanLimits,
  overage: OveragePolicy,
  opts: ConsumeOptions = {},
): QuotaVerdict {
  const amount = Number.isFinite(opts.amount as number) ? Math.max(0, opts.amount as number) : 1;
  const projected = Math.max(0, currentUsed) + amount;
  const status = limitStatus(metric, projected, limits, overage);
  const label = METRICS[metric] ? METRICS[metric].label.toLowerCase() : metric;

  if (status.limit === null) {
    return { allowed: true, state: 'ok', overage: false, overageAmount: 0, message: null, status };
  }

  if (status.state === 'hard_exceeded') {
    // The carve-out. A critical send past a hard limit goes out, and the caller is told loudly
    // enough that it cannot be mistaken for an ordinary success.
    if (opts.critical && !overage.blockTransactionalOnHardLimit) {
      return {
        allowed: true,
        state: 'hard_exceeded',
        overage: true,
        overageAmount: status.overage,
        message:
          'This account is past its ' + label + ' limit. The message was sent because it is '
          + 'transactional and blocking it would lock somebody out of their account. The overage is '
          + 'being recorded; upgrade the plan or raise the limit to stop it accumulating.',
        status,
      };
    }
    const because = opts.critical && overage.blockTransactionalOnHardLimit
      ? ' Transactional mail is being blocked because this organization has explicitly chosen to block it at the hard limit.'
      : '';
    return {
      allowed: false,
      state: 'hard_exceeded',
      overage: false,
      overageAmount: status.overage,
      message:
        (status.limit === 0
          ? 'The ' + label + ' allowance is not included on this plan.'
          : 'This would exceed the ' + label + ' limit of ' + describeMetricValue(metric, status.limit)
            + ' (' + describeMetricValue(metric, Math.max(0, currentUsed)) + ' used).')
        + because,
      status,
    };
  }

  if (status.state === 'soft_exceeded') {
    return {
      allowed: true,
      state: 'soft_exceeded',
      overage: true,
      overageAmount: status.overage,
      message:
        'Past the ' + label + ' limit of ' + describeMetricValue(metric, status.limit)
        + '. Still sending, and the overage is being recorded.',
      status,
    };
  }

  if (status.state === 'warning') {
    const pct = Math.round(status.ratio * 100);
    return {
      allowed: true,
      state: 'warning',
      overage: false,
      overageAmount: 0,
      message: pct + '% of the ' + label + ' limit used.',
      status,
    };
  }

  return { allowed: true, state: 'ok', overage: false, overageAmount: 0, message: null, status };
}

/**
 * The per-minute API rate limit.
 *
 * Separate from the period metrics because it is a different KIND of limit: a burst control, not an
 * allowance. Sharing the machinery would have meant either a one-minute "billing period" or a rate
 * limit that resets monthly, and both are wrong in ways that only show up under load.
 */
export function checkRateLimit(
  callsInWindow: number,
  limits: PlanLimits,
): { allowed: boolean; limit: number | null; remaining: number | null; message: string | null } {
  const limit = limits.apiRateLimitPerMinute;
  if (limit === null) return { allowed: true, limit: null, remaining: null, message: null };
  if (limit === 0) {
    return {
      allowed: false, limit: 0, remaining: 0,
      message: 'The API is not included on this plan.',
    };
  }
  const remaining = Math.max(0, limit - callsInWindow);
  if (callsInWindow >= limit) {
    return {
      allowed: false, limit, remaining: 0,
      message: 'Rate limit reached: ' + limit + ' API requests per minute on this plan. Retry shortly.',
    };
  }
  return { allowed: true, limit, remaining, message: null };
}

// ---------------------------------------------------------------------------
// Subscription standing
// ---------------------------------------------------------------------------

/** Statuses under which the platform does work for a tenant. */
const SERVICEABLE: SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

/**
 * Is this subscription in a state where the platform still serves the tenant?
 *
 * `past_due` IS serviceable, deliberately. A failed card is a card problem, not a decision to stop
 * being a customer, and cutting mail off the hour a renewal fails punishes the tenant for their
 * bank's fraud heuristic. The grace window in `suspensionAdvice()` is where that gets resolved.
 */
export function isServiceable(status: SubscriptionStatus): boolean {
  return SERVICEABLE.includes(status);
}

export interface SuspensionAdvice {
  suspend: boolean;
  /** Words an operator can read to a customer. Present whenever `suspend` is true. */
  reason: string | null;
  /** Days left before suspension, when past due but still inside the grace window. */
  graceDaysLeft: number | null;
}

/**
 * What the policy implies about a past-due subscription. ADVICE, not an action.
 *
 * Returns `suspend: false` with a countdown while inside the grace window, so the caller can warn
 * rather than wait until the day it happens. A suspension a customer was not warned about is a
 * support ticket that starts with "nobody told us".
 */
export function suspensionAdvice(
  subscription: Pick<Subscription, 'status' | 'periodEnd' | 'suspendedReason'>,
  nowIso: string | Date = new Date(),
  graceDays = 7,
): SuspensionAdvice {
  if (subscription.status === 'suspended') {
    return {
      suspend: true,
      reason: subscription.suspendedReason || 'The subscription is suspended.',
      graceDaysLeft: 0,
    };
  }
  if (subscription.status !== 'past_due') {
    return { suspend: false, reason: null, graceDaysLeft: null };
  }
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const end = new Date(subscription.periodEnd);
  if (Number.isNaN(end.getTime())) return { suspend: false, reason: null, graceDaysLeft: null };
  const daysSince = Math.floor((now.getTime() - end.getTime()) / (24 * 60 * 60 * 1000));
  if (daysSince >= graceDays) {
    return {
      suspend: true,
      reason: 'Payment has been outstanding for ' + daysSince + ' days, past the ' + graceDays + '-day grace period.',
      graceDaysLeft: 0,
    };
  }
  return { suspend: false, reason: null, graceDaysLeft: Math.max(0, graceDays - daysSince) };
}

/**
 * What a suspended tenant may still do.
 *
 * Reading and receiving stay available. Suspension is a commercial state, and deleting somebody's
 * access to mail they have already received turns a billing dispute into data loss — theirs, not
 * ours. Outbound work stops; the archive stays readable and the door stays open for the mail that
 * is already on its way.
 */
export const SUSPENDED_STILL_ALLOWED: readonly string[] = [
  'mail.read', 'analytics.view', 'billing.manage', 'org.manage', 'team.manage',
] as const;

/** A one-line description of the standing, for a status badge. */
export function describeSubscription(
  status: SubscriptionStatus,
  advice?: SuspensionAdvice,
): { label: string; tone: 'ok' | 'warn' | 'bad'; detail: string } {
  switch (status) {
    case 'trialing':
      return { label: 'Trial', tone: 'ok', detail: 'On trial. No payment has been taken yet.' };
    case 'active':
      return { label: 'Active', tone: 'ok', detail: 'Paid and current.' };
    case 'past_due':
      return {
        label: 'Past due',
        tone: 'warn',
        detail: advice && advice.graceDaysLeft !== null
          ? 'Payment failed. Service continues for another ' + advice.graceDaysLeft + ' day(s).'
          : 'Payment failed. Service continues during the grace period.',
      };
    case 'suspended':
      return { label: 'Suspended', tone: 'bad', detail: 'Sending is stopped. Existing mail stays readable.' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'warn', detail: 'Cancelled. Runs until the end of the paid period.' };
    case 'expired':
      return { label: 'Expired', tone: 'bad', detail: 'The subscription period has ended.' };
    default:
      return { label: String(status), tone: 'warn', detail: 'Unrecognised subscription state.' };
  }
}
