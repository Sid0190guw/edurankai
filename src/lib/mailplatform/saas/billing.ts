// src/lib/mailplatform/saas/billing.ts — the payment-provider seam and the subscription reducer.
//
// SECTION 6 OF THE BRIEF: the application must not depend directly on one payment provider. So the
// application depends on `BillingProvider`, and the only implementation shipped here is
// `ManualBillingProvider` — configuration-driven, no vendor, no SDK, no keys. Razorpay and Stripe
// are named in exactly one place in this file: the registry's list of adapters that DO NOT EXIST
// YET, which reports itself honestly rather than pretending to be configured.
//
// That is deliberate and it is the instruction: do not implement payment-provider-specific code
// unless it fits the abstraction. Writing a Razorpay adapter now would mean guessing at which
// account, which keys, and which webhook secret — and this repository already has live Razorpay
// credentials for a different product, which an adapter written on a guess would happily have
// charged against. The seam is built; wiring a provider into it is a decision with a person's name
// on it, not something a patch does on its own initiative.
//
// THE REDUCER IS PURE AND ORDER-TOLERANT.
//
// `applyBillingEvent()` takes a subscription and an event and returns a new subscription. It never
// writes anything. Two properties matter and both have tests:
//
//   IDEMPOTENT — the same event applied twice produces the same subscription. Providers retry
//                webhooks; a retry that cancels a subscription a second time, or extends a period
//                twice, is a customer-visible error caused entirely by our own bookkeeping.
//   ORDERED    — events are applied by the PROVIDER's clock, not by arrival order. Webhooks arrive
//                out of order routinely (a retry of an older event overtakes a newer one), and an
//                out-of-order apply silently reinstates a cancelled subscription.
//
// Staleness is decided against `subscription.lastBillingEventAt` — the provider's own timestamp on
// the last event we applied. NOT against `updatedAt`, which moves on the platform's clock: mixing
// the two makes every event look older than the row it is about to change. An event that loses the
// comparison is recorded and says so, instead of failing.

import type { OperationResult, ProviderInfo } from '../interfaces';
import type {
  BillingEvent,
  BillingEventType,
  CheckoutSession,
  Invoice,
  InvoiceStatus,
  MetricKey,
  Subscription,
  SubscriptionStatus,
  UUID,
} from './types';
import { isDowngrade } from './plans';
import { addMonthsUtc } from './usage';

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  orgId: UUID;
  planKey: string;
  currency: string;
  interval: 'month' | 'year';
  /** Where the customer lands after paying. Absolute URL. */
  returnUrl: string;
  /** Passed back on every event for this subscription, so a webhook can find its tenant. */
  metadata?: Record<string, string>;
}

export interface WebhookInput {
  /** The RAW body. A parsed body cannot be signature-verified, so this must not be an object. */
  rawBody: string;
  headers: Record<string, string>;
}

/**
 * A payment provider, reduced to what this platform actually needs.
 *
 * Every method returns an `OperationResult` rather than throwing: a declined card and an
 * unreachable provider are ordinary Tuesdays in billing, and turning them into exceptions is how
 * they end up swallowed by a `catch {}` in a route.
 */
export interface BillingProvider {
  info(): ProviderInfo;

  /** Start a payment. `url: null` means the provider takes payment without redirecting. */
  createCheckout(req: CheckoutRequest): Promise<OperationResult<CheckoutSession>>;

  /** Move an existing subscription to another plan at the provider. */
  changePlan(subscription: Subscription, toPlanKey: string): Promise<OperationResult<{ effectiveAt: string }>>;

  /** `atPeriodEnd: false` cancels immediately; true lets the paid period run out. */
  cancelSubscription(subscription: Subscription, atPeriodEnd: boolean): Promise<OperationResult<void>>;

  /** Invoices as the provider knows them. The platform's own copies live in `mp_invoices`. */
  listInvoices(orgId: UUID, limit?: number): Promise<OperationResult<Invoice[]>>;

  /**
   * Verify a webhook and turn it into a platform event.
   *
   * MUST verify the signature before parsing. An unverified webhook endpoint is an unauthenticated
   * write to the subscription table, which is the most valuable table in the product.
   */
  verifyWebhook(input: WebhookInput): Promise<OperationResult<Omit<BillingEvent, 'id' | 'receivedAt' | 'processedAt' | 'error'>>>;
}

// ---------------------------------------------------------------------------
// The manual provider
// ---------------------------------------------------------------------------

/**
 * Billing without a payment gateway.
 *
 * This is not a placeholder. Invoicing an enterprise customer on thirty-day terms, a university
 * paying by purchase order, a partner settling quarterly — none of those touch a card gateway, and
 * all of them are real customers of a product shaped like this one. The manual provider records
 * what an operator did: the plan changes when somebody with `billing.manage` changes it, and an
 * invoice is marked paid when somebody marks it paid, with an audit row either way.
 *
 * It reports `enabled: true` because it genuinely works. A provider that lies about being enabled
 * is worse than one that is absent.
 */
export class ManualBillingProvider implements BillingProvider {
  readonly kind = 'manual';

  info(): ProviderInfo {
    return {
      kind: 'manual',
      enabled: true,
      detail:
        'Plans and invoices are recorded by an operator. No payment gateway is connected, so no '
        + 'card is ever charged automatically; invoices are issued and marked paid by hand.',
    };
  }

  async createCheckout(req: CheckoutRequest): Promise<OperationResult<CheckoutSession>> {
    // There is nowhere to send the customer, and saying so is the honest answer. Returning a fake
    // URL would produce a checkout page that cannot take money.
    return {
      ok: true,
      data: {
        id: 'manual:' + req.orgId + ':' + req.planKey,
        url: null,
        provider: 'manual',
        expiresAt: null,
      },
    };
  }

  async changePlan(_subscription: Subscription, toPlanKey: string): Promise<OperationResult<{ effectiveAt: string }>> {
    // The platform applies the change itself; there is no remote subscription to keep in step.
    return { ok: true, data: { effectiveAt: new Date().toISOString() } };
  }

  async cancelSubscription(): Promise<OperationResult<void>> {
    return { ok: true };
  }

  async listInvoices(): Promise<OperationResult<Invoice[]>> {
    // The manual provider holds no invoices of its own. The platform's own table is the record, and
    // an empty array here is a true statement about the PROVIDER, not about the customer.
    return { ok: true, data: [] };
  }

  async verifyWebhook(): Promise<OperationResult<Omit<BillingEvent, 'id' | 'receivedAt' | 'processedAt' | 'error'>>> {
    return {
      ok: false,
      code: 'no_webhooks',
      error: 'The manual billing provider has no webhooks. Nothing external can change a subscription.',
    };
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const PROVIDERS = new Map<string, BillingProvider>([['manual', new ManualBillingProvider()]]);

/** Adapters the interface is designed for, that nobody has written yet. Listed so an ops screen can say so. */
export const PLANNED_PROVIDERS: { kind: string; detail: string }[] = [
  {
    kind: 'razorpay',
    detail:
      'Not implemented. The interface fits it; wiring it needs a decision about which Razorpay '
      + 'account and webhook secret this platform uses, which is not a decision code should make.',
  },
  {
    kind: 'stripe',
    detail: 'Not implemented. Same shape as above: the seam exists, the account does not.',
  },
];

/** Register an adapter. The one line a new provider adds to the application. */
export function registerBillingProvider(kind: string, provider: BillingProvider): void {
  PROVIDERS.set(kind, provider);
}

/**
 * The provider for a subscription.
 *
 * Falls back to manual and SAYS SO through the returned provider's `info()`, rather than throwing:
 * a subscription row naming a provider nobody registered must not stop the tenant reading their
 * billing page — that page is where they would find out what is wrong.
 */
export function resolveBillingProvider(kind: string | null | undefined): BillingProvider {
  const found = kind ? PROVIDERS.get(kind) : null;
  return found || (PROVIDERS.get('manual') as BillingProvider);
}

export function billingProviderStatus(): ProviderInfo[] {
  const live = Array.from(PROVIDERS.values()).map((p) => p.info());
  const planned = PLANNED_PROVIDERS
    .filter((p) => !PROVIDERS.has(p.kind))
    .map((p) => ({ kind: p.kind, enabled: false, detail: p.detail }));
  return [...live, ...planned];
}

// ---------------------------------------------------------------------------
// The subscription reducer
// ---------------------------------------------------------------------------

export interface BillingEffect {
  kind: 'platform_event' | 'notify' | 'audit';
  /** Event type or notification key. */
  name: string;
  payload: Record<string, unknown>;
}

export interface ApplyResult {
  subscription: Subscription;
  changed: boolean;
  /** Why nothing changed, when nothing did. Never empty on a no-op. */
  note: string;
  /** What the caller must do as a consequence. The reducer performs no side effects itself. */
  effects: BillingEffect[];
}

function unchanged(subscription: Subscription, note: string): ApplyResult {
  return { subscription, changed: false, note, effects: [] };
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

const VALID_STATUSES: SubscriptionStatus[] = [
  'trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired',
];

function statusFrom(payload: Record<string, unknown>): SubscriptionStatus | null {
  const s = str(payload, 'status');
  return s && (VALID_STATUSES as string[]).includes(s) ? (s as SubscriptionStatus) : null;
}

/**
 * Apply one billing event to a subscription.
 *
 * PURE. Returns a new object; the input is never mutated, so a caller can compare before and after
 * to decide what to persist and what to announce.
 */
export function applyBillingEvent(
  subscription: Subscription,
  event: BillingEvent,
  nowIso: string = new Date().toISOString(),
): ApplyResult {
  // Ordering, before anything else. An event from before the last one we applied is a late retry of
  // something already superseded — applying it would walk the subscription backwards.
  //
  // BOTH SIDES OF THIS COMPARISON ARE PROVIDER TIMESTAMPS. Comparing against `updatedAt` would put
  // the platform's clock on one side and the provider's on the other, and a subscription written a
  // second ago would then reject every event that occurred before that write — which is every
  // event, since a webhook always describes something that already happened.
  const eventTime = new Date(event.occurredAt).getTime();
  const lastApplied = subscription.lastBillingEventAt
    ? new Date(subscription.lastBillingEventAt).getTime()
    : null;
  if (lastApplied !== null && Number.isFinite(eventTime) && Number.isFinite(lastApplied) && eventTime < lastApplied) {
    return unchanged(
      subscription,
      'Event ' + event.eventId + ' is older (' + event.occurredAt + ') than the last event applied ('
      + subscription.lastBillingEventAt + '), so it was recorded but not applied.',
    );
  }
  if (event.orgId && event.orgId !== subscription.orgId) {
    // Tenant isolation reaches billing too: a webhook naming another tenant does not get to write
    // to this one, however well it was signed.
    return unchanged(
      subscription,
      'Event ' + event.eventId + ' names organization ' + event.orgId + ', not ' + subscription.orgId + '.',
    );
  }

  const next: Subscription = { ...subscription };
  const effects: BillingEffect[] = [];
  const payload = event.payload || {};
  let changed = false;
  let note = '';

  switch (event.type as BillingEventType) {
    case 'subscription.created': {
      const planKey = str(payload, 'planKey');
      const status = statusFrom(payload);
      if (planKey && planKey !== next.planKey) { next.planKey = planKey; changed = true; }
      if (status && status !== next.status) { next.status = status; changed = true; }
      const periodEnd = str(payload, 'periodEnd');
      if (periodEnd && periodEnd !== next.periodEnd) { next.periodEnd = periodEnd; changed = true; }
      const ref = str(payload, 'providerRef');
      if (ref && ref !== next.providerRef) { next.providerRef = ref; changed = true; }
      note = changed ? 'Subscription created.' : 'Subscription already reflected this creation.';
      break;
    }

    case 'subscription.updated': {
      const status = statusFrom(payload);
      if (status && status !== next.status) { next.status = status; changed = true; }
      const periodStart = str(payload, 'periodStart');
      const periodEnd = str(payload, 'periodEnd');
      if (periodStart && periodStart !== next.periodStart) { next.periodStart = periodStart; changed = true; }
      if (periodEnd && periodEnd !== next.periodEnd) { next.periodEnd = periodEnd; changed = true; }
      note = changed ? 'Subscription updated.' : 'Nothing in the update differed from what is stored.';
      break;
    }

    case 'subscription.cancelled': {
      const atPeriodEnd = payload.atPeriodEnd === true;
      if (atPeriodEnd) {
        // Cancel at period end: the customer paid for the period and keeps it. Status stays what it
        // was, so nothing about their service changes today.
        if (next.cancelAt !== next.periodEnd) { next.cancelAt = next.periodEnd; changed = true; }
        note = changed ? 'Cancellation scheduled for the end of the paid period.' : 'Cancellation was already scheduled.';
      } else {
        if (next.status !== 'cancelled') {
          next.status = 'cancelled';
          next.cancelledAt = str(payload, 'cancelledAt') || event.occurredAt;
          changed = true;
        }
        note = changed ? 'Subscription cancelled.' : 'Subscription was already cancelled.';
      }
      if (changed) {
        effects.push({ kind: 'notify', name: 'subscription.cancelled', payload: { orgId: subscription.orgId } });
      }
      break;
    }

    case 'payment.succeeded': {
      // A successful payment CLEARS a past-due or suspended state. That is the whole point of the
      // grace period, and forgetting to clear it is how a customer pays and stays cut off.
      if (next.status === 'past_due' || next.status === 'suspended' || next.status === 'trialing') {
        next.status = 'active';
        next.suspendedReason = null;
        next.suspendedAt = null;
        changed = true;
      }
      const periodEnd = str(payload, 'periodEnd');
      if (periodEnd && periodEnd !== next.periodEnd) {
        next.periodStart = next.periodEnd;
        next.periodEnd = periodEnd;
        changed = true;
      }
      note = changed ? 'Payment recorded; the subscription is current.' : 'Payment recorded; the subscription was already current.';
      if (changed) {
        effects.push({ kind: 'notify', name: 'payment.succeeded', payload: { orgId: subscription.orgId } });
      }
      break;
    }

    case 'payment.failed': {
      if (next.status === 'active' || next.status === 'trialing') {
        next.status = 'past_due';
        changed = true;
      }
      note = changed
        ? 'Payment failed; the subscription is past due and inside its grace period.'
        : 'Payment failed; the subscription was already past due.';
      effects.push({
        kind: 'notify',
        name: 'payment.failed',
        payload: { orgId: subscription.orgId, reason: str(payload, 'reason') },
      });
      break;
    }

    case 'plan.changed': {
      const planKey = str(payload, 'planKey');
      if (!planKey) { note = 'plan.changed carried no planKey.'; break; }
      const immediate = payload.immediate === true || !isDowngrade(next.planKey, planKey);
      if (immediate) {
        if (next.planKey !== planKey) {
          next.planKey = planKey;
          next.pendingPlanKey = null;
          next.pendingPlanAt = null;
          changed = true;
        }
        note = changed ? 'Plan changed to ' + planKey + ' immediately.' : 'Already on ' + planKey + '.';
      } else {
        if (next.pendingPlanKey !== planKey) {
          next.pendingPlanKey = planKey;
          next.pendingPlanAt = next.periodEnd;
          changed = true;
        }
        note = changed
          ? 'Downgrade to ' + planKey + ' scheduled for ' + next.periodEnd + '.'
          : 'That downgrade was already scheduled.';
      }
      break;
    }

    case 'usage.threshold_reached': {
      // Records a fact about usage; it never changes what the customer is paying for.
      effects.push({
        kind: 'notify',
        name: 'usage.threshold_reached',
        payload: {
          orgId: subscription.orgId,
          metric: payload.metric,
          threshold: payload.threshold,
        },
      });
      note = 'Usage threshold recorded.';
      break;
    }

    default:
      return unchanged(subscription, 'Unrecognised billing event type: ' + String(event.type) + '.');
  }

  if (changed) {
    next.updatedAt = nowIso;
    next.lastBillingEventAt = event.occurredAt;
    effects.push({
      kind: 'platform_event',
      name: event.type,
      payload: { orgId: subscription.orgId, planKey: next.planKey, status: next.status },
    });
  }
  return { subscription: next, changed, note, effects };
}

// ---------------------------------------------------------------------------
// Plan changes initiated inside the platform
// ---------------------------------------------------------------------------

export interface PlanChangeResult {
  subscription: Subscription;
  /** True when the new plan applies now; false when it waits for the period boundary. */
  immediate: boolean;
  effectiveAt: string;
  note: string;
}

/**
 * Move a tenant to another plan.
 *
 * UPGRADES APPLY NOW. DOWNGRADES APPLY AT PERIOD END. The asymmetry is not indecision: an upgrade
 * is somebody choosing to pay for more and they should have it within the second; a downgrade
 * mid-period would confiscate capacity that has already been paid for, and the tenant would
 * discover it as a failed send rather than as a billing change.
 *
 * A downgrade that has been scheduled can be cancelled by changing back — `pendingPlanKey` is
 * cleared whenever the target equals the current plan.
 */
export function changePlan(
  subscription: Subscription,
  toPlanKey: string,
  nowIso: string = new Date().toISOString(),
): PlanChangeResult {
  const next: Subscription = { ...subscription };

  if (toPlanKey === subscription.planKey) {
    next.pendingPlanKey = null;
    next.pendingPlanAt = null;
    next.updatedAt = nowIso;
    return {
      subscription: next,
      immediate: true,
      effectiveAt: nowIso,
      note: subscription.pendingPlanKey
        ? 'Scheduled change to ' + subscription.pendingPlanKey + ' cancelled; staying on ' + toPlanKey + '.'
        : 'Already on ' + toPlanKey + '.',
    };
  }

  if (isDowngrade(subscription.planKey, toPlanKey)) {
    next.pendingPlanKey = toPlanKey;
    next.pendingPlanAt = subscription.periodEnd;
    next.updatedAt = nowIso;
    return {
      subscription: next,
      immediate: false,
      effectiveAt: subscription.periodEnd,
      note:
        'Downgrade to ' + toPlanKey + ' takes effect on ' + subscription.periodEnd + '. The current '
        + 'plan and its limits stay in place until then, because they are already paid for.',
    };
  }

  next.planKey = toPlanKey;
  next.pendingPlanKey = null;
  next.pendingPlanAt = null;
  next.updatedAt = nowIso;
  return {
    subscription: next,
    immediate: true,
    effectiveAt: nowIso,
    note: 'Upgraded to ' + toPlanKey + '. The new limits apply immediately.',
  };
}

/**
 * Roll a subscription into its next period.
 *
 * Applies any pending downgrade, advances the window, and clears a scheduled cancellation by
 * ending the subscription. Called by whatever runs at the boundary; it is pure so that "what will
 * happen at renewal" can be answered on screen before it happens.
 */
export function renew(
  subscription: Subscription,
  nowIso: string = new Date().toISOString(),
): { subscription: Subscription; note: string } {
  const next: Subscription = { ...subscription };
  const notes: string[] = [];

  if (next.cancelAt && new Date(next.cancelAt).getTime() <= new Date(nowIso).getTime()) {
    next.status = 'cancelled';
    next.cancelledAt = nowIso;
    next.cancelAt = null;
    next.updatedAt = nowIso;
    return { subscription: next, note: 'The scheduled cancellation took effect; the subscription is cancelled.' };
  }

  if (next.pendingPlanKey) {
    notes.push('Scheduled change to ' + next.pendingPlanKey + ' applied.');
    next.planKey = next.pendingPlanKey;
    next.pendingPlanKey = null;
    next.pendingPlanAt = null;
  }

  const end = new Date(next.periodEnd);
  if (!Number.isNaN(end.getTime())) {
    next.periodStart = next.periodEnd;
    next.periodEnd = addMonthsUtc(end, 1).toISOString();
    notes.push('Period advanced to ' + next.periodEnd + '.');
  }
  next.updatedAt = nowIso;
  return { subscription: next, note: notes.join(' ') || 'Nothing to do at renewal.' };
}

// ---------------------------------------------------------------------------
// Invoice arithmetic
// ---------------------------------------------------------------------------

/**
 * Totals from lines. Integers throughout — see the note about money in ./pricing.ts.
 *
 * `taxMinor` is passed in rather than computed: tax rates depend on the customer's country, their
 * registration status and what is being sold, and a function that guesses at that produces an
 * invoice that is wrong in a way somebody eventually has to explain to a tax authority.
 */
export function invoiceTotals(
  lines: { quantity: number; unitAmountMinor: number }[],
  taxMinor = 0,
): { subtotalMinor: number; taxMinor: number; totalMinor: number } {
  const subtotal = lines.reduce(
    (sum, l) => sum + Math.round(Number(l.quantity) || 0) * Math.round(Number(l.unitAmountMinor) || 0),
    0,
  );
  const tax = Math.round(Number(taxMinor) || 0);
  return { subtotalMinor: subtotal, taxMinor: tax, totalMinor: subtotal + tax };
}

/** What an invoice's status should be, given what has been paid against it. */
export function invoiceStatusFor(
  totalMinor: number,
  amountPaidMinor: number,
  current: InvoiceStatus,
): InvoiceStatus {
  if (current === 'void' || current === 'uncollectible' || current === 'draft') return current;
  if (amountPaidMinor >= totalMinor && totalMinor > 0) return 'paid';
  if (totalMinor === 0) return 'paid';
  return 'open';
}

/**
 * Overage lines for a period.
 *
 * Only metrics that actually went over produce a line, and each line names the metric so the
 * customer can see WHICH allowance they exceeded rather than a single unexplained "overage" figure.
 * An invoice line a customer cannot account for is an invoice line they dispute.
 */
export function overageLines(
  overages: { metric: MetricKey; units: number; unitAmountMinor: number; label: string }[],
): { description: string; quantity: number; unitAmountMinor: number; amountMinor: number; metric: MetricKey }[] {
  return overages
    .filter((o) => o.units > 0 && o.unitAmountMinor > 0)
    .map((o) => ({
      description: o.label + ' over the plan allowance',
      quantity: Math.round(o.units),
      unitAmountMinor: Math.round(o.unitAmountMinor),
      amountMinor: Math.round(o.units) * Math.round(o.unitAmountMinor),
      metric: o.metric,
    }));
}
