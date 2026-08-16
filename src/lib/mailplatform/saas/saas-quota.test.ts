// Soft and hard limits, the transactional carve-out, and the entitlement engine's order.
import { describe, expect, it } from 'vitest';
import {
  canConsume,
  checkRateLimit,
  describeSubscription,
  evaluateAll,
  isServiceable,
  limitStatus,
  suspensionAdvice,
} from './quota';
import { CAPABILITIES, checkEntitlement, explainAll } from './entitlements';
import type { EntitlementContext } from './entitlements';
import { catalogPlan, resolveLimits, resolveOverage, zeroMetrics } from './plans';
import { ORGANIZATION_TYPES } from './types';
import type { MetricKey, Plan, Subscription, UsageSnapshot } from './types';

const PERIOD = { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' };

function snapshot(values: Partial<Record<MetricKey, number>> = {}): UsageSnapshot {
  const base = zeroMetrics();
  return {
    orgId: 'org_1',
    period: PERIOD,
    values: { ...base, ...values },
    peaks: { ...base, ...values },
  };
}

const starter = catalogPlan('starter') as Plan;
const starterLimits = resolveLimits(starter, null);
const starterOverage = resolveOverage(starter, null);

const free = catalogPlan('free') as Plan;
const freeLimits = resolveLimits(free, null);
const freeOverage = resolveOverage(free, null);

describe('one metric against its limit', () => {
  it('reports an unlimited metric as having no ceiling, not as full', () => {
    const enterprise = catalogPlan('enterprise') as Plan;
    const s = limitStatus('emails_sent', 5_000_000, resolveLimits(enterprise, null), starterOverage);
    expect(s.limit).toBeNull();
    expect(s.ratio).toBe(0);
    expect(s.state).toBe('ok');
    expect(s.remaining).toBeNull();
  });

  it('reports a zero limit as exceeded from the start', () => {
    const s = limitStatus('api_calls', 0, freeLimits, freeOverage);
    expect(s.limit).toBe(0);
    expect(s.state).toBe('hard_exceeded');
    expect(s.remaining).toBe(0);
  });

  it('warns before the limit', () => {
    const s = limitStatus('emails_sent', 8_500, starterLimits, starterOverage);
    expect(s.state).toBe('warning');
    expect(s.crossedThreshold).toBe(0.8);
  });

  it('goes soft-exceeded past the limit and hard-exceeded past the ceiling', () => {
    const soft = limitStatus('emails_sent', 10_500, starterLimits, starterOverage);
    expect(soft.state).toBe('soft_exceeded');
    expect(soft.overage).toBe(500);

    const hard = limitStatus('emails_sent', 11_001, starterLimits, starterOverage);
    expect(hard.state).toBe('hard_exceeded');
  });

  it('a soft limit still has a ceiling', () => {
    // Otherwise "soft" means "no limit at all" and the pricing page is decoration.
    const ceiling = starterLimits.monthlySendQuota as number * 1.1;
    expect(limitStatus('emails_sent', ceiling, starterLimits, starterOverage).state).toBe('soft_exceeded');
    expect(limitStatus('emails_sent', ceiling + 1, starterLimits, starterOverage).state).toBe('hard_exceeded');
  });

  it('the last unit of an allowance belongs to the customer', () => {
    // Exactly at the limit is spent, not exceeded; one past it is exceeded. Reading `>=` here would
    // quietly withhold the last unit of every allowance somebody paid for.
    expect(limitStatus('contacts', 5_000, starterLimits, starterOverage).state).not.toBe('hard_exceeded');
    expect(limitStatus('contacts', 5_001, starterLimits, starterOverage).state).toBe('hard_exceeded');
  });

  it('evaluates every metric and sorts the ones needing attention', () => {
    const all = evaluateAll(snapshot({ emails_sent: 9_900, contacts: 6_000 }), starterLimits, starterOverage);
    expect(all.length).toBeGreaterThan(10);
    const attention = all.filter((s) => s.state !== 'ok');
    expect(attention.some((s) => s.metric === 'contacts')).toBe(true);
  });
});

describe('consuming more', () => {
  it('projects forward rather than checking the current value', () => {
    // A campaign of 200,000 must not start because the tenant was at 99% when it began.
    const verdict = canConsume('campaign_recipients', 9_000, starterLimits, starterOverage, { amount: 200_000 });
    expect(verdict.allowed).toBe(false);
  });

  it('allows a call that fits', () => {
    expect(canConsume('emails_sent', 10, starterLimits, starterOverage, { amount: 5 }).allowed).toBe(true);
  });

  it('allows a soft overage and says so', () => {
    const v = canConsume('emails_sent', 10_000, starterLimits, starterOverage, { amount: 1 });
    expect(v.allowed).toBe(true);
    expect(v.overage).toBe(true);
    expect(v.message).toMatch(/overage is being recorded/i);
  });

  it('refuses past the ceiling, with a sentence naming the limit', () => {
    const v = canConsume('emails_sent', 11_500, starterLimits, starterOverage, { amount: 1 });
    expect(v.allowed).toBe(false);
    expect(v.message).toMatch(/10,000/);
  });
});

describe('critical transactional mail is never silently blocked', () => {
  it('goes out past a hard limit, flagged as overage', () => {
    const v = canConsume('emails_sent', 999_999, freeLimits, freeOverage, { amount: 1, critical: true });
    expect(v.allowed).toBe(true);
    expect(v.overage).toBe(true);
    expect(v.message).toMatch(/lock somebody out/i);
  });

  it('is blocked only when the tenant explicitly chose that, and the refusal explains itself', () => {
    const strict = { ...freeOverage, blockTransactionalOnHardLimit: true };
    const v = canConsume('emails_sent', 999_999, freeLimits, strict, { amount: 1, critical: true });
    expect(v.allowed).toBe(false);
    expect(v.message).toMatch(/explicitly chosen to block/i);
  });

  it('a non-critical send past the same limit is refused', () => {
    expect(canConsume('emails_sent', 999_999, freeLimits, freeOverage, { amount: 1 }).allowed).toBe(false);
  });
});

describe('the API rate limit is its own kind of limit', () => {
  it('refuses at the ceiling and reports what is left below it', () => {
    expect(checkRateLimit(59, starterLimits).allowed).toBe(true);
    expect(checkRateLimit(59, starterLimits).remaining).toBe(1);
    expect(checkRateLimit(60, starterLimits).allowed).toBe(false);
  });

  it('says the API is not included rather than "rate limited" on a plan without it', () => {
    const v = checkRateLimit(0, freeLimits);
    expect(v.allowed).toBe(false);
    expect(v.message).toMatch(/not included/i);
  });
});

describe('subscription standing', () => {
  const base: Pick<Subscription, 'status' | 'periodEnd' | 'suspendedReason'> = {
    status: 'past_due',
    periodEnd: '2026-03-01T00:00:00.000Z',
    suspendedReason: null,
  };

  it('treats past_due as serviceable', () => {
    // A failed card is a card problem, not a decision to stop being a customer.
    expect(isServiceable('past_due')).toBe(true);
    expect(isServiceable('active')).toBe(true);
    expect(isServiceable('suspended')).toBe(false);
  });

  it('counts down inside the grace window rather than surprising anybody', () => {
    const advice = suspensionAdvice(base, '2026-03-04T00:00:00.000Z', 7);
    expect(advice.suspend).toBe(false);
    expect(advice.graceDaysLeft).toBe(4);
  });

  it('advises suspension once the grace window has passed, with a reason', () => {
    const advice = suspensionAdvice(base, '2026-03-10T00:00:00.000Z', 7);
    expect(advice.suspend).toBe(true);
    expect(advice.reason).toMatch(/grace period/i);
  });

  it('describes every state in words', () => {
    for (const s of ['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired'] as const) {
      const d = describeSubscription(s);
      expect(d.label).not.toBe('');
      expect(d.detail.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------

function ctx(over: Partial<EntitlementContext> = {}): EntitlementContext {
  return {
    orgId: 'org_1',
    principalOrgId: 'org_1',
    orgStatus: 'active',
    role: 'owner',
    subscriptionStatus: 'active',
    plan: starter,
    limits: starterLimits,
    overage: starterOverage,
    usage: snapshot(),
    ...over,
  };
}

describe('the entitlement engine checks in the right order', () => {
  it('refuses a caller from another tenant before reading anything', () => {
    const d = checkEntitlement('mail.send', ctx({ principalOrgId: 'org_2' }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('org_mismatch');
    // No usage figure leaks across the boundary.
    expect(d.limits).toHaveLength(0);
  });

  it('refuses when the tenant was never resolved', () => {
    expect(checkEntitlement('mail.send', ctx({ principalOrgId: null })).reason).toBe('org_mismatch');
  });

  it('refuses with no role at all', () => {
    expect(checkEntitlement('mail.send', ctx({ role: null })).reason).toBe('no_principal');
  });

  it('checks the permission BEFORE the plan', () => {
    // An Analyst asking to send a campaign is told they are not allowed, not offered an upgrade.
    const d = checkEntitlement('campaign.send', ctx({ role: 'analyst', plan: free, limits: freeLimits, overage: freeOverage }));
    expect(d.reason).toBe('permission');
    expect(d.upgradeToPlanKey).toBeNull();
  });

  it('offers an upgrade when the plan is the only obstacle', () => {
    const d = checkEntitlement('campaign.send', ctx({ plan: free, limits: freeLimits, overage: freeOverage }));
    expect(d.reason).toBe('plan');
    expect(d.requiredFeature).toBe('campaigns');
    expect(d.upgradeToPlanKey).toBe('starter');
  });

  it('refuses on a limit and names the metric', () => {
    const d = checkEntitlement('contact.create', ctx({ usage: snapshot({ contacts: 5_000 }) }));
    expect(d.reason).toBe('limit');
    expect(d.metric).toBe('contacts');
    expect(d.upgradeToPlanKey).toBe('professional');
  });

  it('allows an overage and flags it rather than hiding it', () => {
    const d = checkEntitlement('mail.send', ctx({ usage: snapshot({ emails_sent: 10_000 }) }));
    expect(d.allowed).toBe(true);
    expect(d.overage).toBe(true);
    expect(d.notice).toBeTruthy();
  });

  it('keeps administration reachable while suspended, so the account can be fixed', () => {
    const suspended = ctx({ orgStatus: 'suspended' });
    expect(checkEntitlement('mail.send', suspended).allowed).toBe(false);
    expect(checkEntitlement('billing.manage', suspended).allowed).toBe(true);
    expect(checkEntitlement('mail.read', suspended).allowed).toBe(true);
  });

  it('always explains a refusal', () => {
    for (const d of explainAll(ctx({ role: 'viewer', plan: free, limits: freeLimits, overage: freeOverage }))) {
      if (!d.allowed) expect((d.message || '').length).toBeGreaterThan(10);
    }
  });
});

describe('the critical carve-out cannot be claimed by a campaign', () => {
  it('only two capabilities are eligible', () => {
    const eligible = Object.values(CAPABILITIES).filter((c) => c.criticalEligible).map((c) => c.key);
    expect(eligible.sort()).toEqual(['api.send', 'mail.send']);
  });

  it('ignores critical:true on a campaign send', () => {
    const d = checkEntitlement(
      'campaign.send',
      ctx({ usage: snapshot({ campaign_recipients: 11_000 }) }),
      { critical: true, amount: 1 },
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('limit');
  });

  it('honours it on a transactional send', () => {
    const d = checkEntitlement(
      'mail.send',
      ctx({ usage: snapshot({ emails_sent: 999_999 }) }),
      { critical: true },
    );
    expect(d.allowed).toBe(true);
    expect(d.overage).toBe(true);
  });
});

describe('organization type changes nothing', () => {
  it('gives identical answers across all seven types on the same plan', () => {
    // Section 2 of the brief, asserted rather than asserted-about: the engine has no way to read
    // the organization type, so this is a check that it never grows one.
    const answers = ORGANIZATION_TYPES.map(() =>
      JSON.stringify(explainAll(ctx()).map((d) => [d.capability, d.allowed, d.reason])));
    expect(new Set(answers).size).toBe(1);
  });
});

describe('the capability matrix answers "could you do this now"', () => {
  it('shows a tenant with room to spare as able to act', () => {
    const decisions = explainAll(ctx({ usage: snapshot({ contacts: 4_999 }) }));
    expect(decisions.find((d) => d.capability === 'contact.create')?.allowed).toBe(true);
  });

  it('shows a tenant who has spent the allowance as unable', () => {
    const decisions = explainAll(ctx({ usage: snapshot({ contacts: 5_000 }) }));
    expect(decisions.find((d) => d.capability === 'contact.create')?.allowed).toBe(false);
  });
});
