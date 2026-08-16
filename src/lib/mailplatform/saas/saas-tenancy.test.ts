// The service layer, exercised end to end against the in-memory store.
//
// These run the REAL functions from ./service.ts — the same code the API routes and admin screens
// call — with the store swapped underneath. Nothing here re-implements the logic it is testing.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  billingOverview,
  changeOrganizationPlan,
  checkCapability,
  createOrganization,
  ingestBillingEvent,
  inviteMember,
  meter,
  reconcile,
  removeMember,
  resolveTenantForUser,
  setMemberRole,
  tenantContext,
  useMemoryStore,
} from './service';
import type { MemorySaasStore } from './store';
import { applyBillingEvent, changePlan, invoiceTotals, invoiceStatusFor, renew } from './billing';
import { usageKey } from './usage';
import type { BillingEvent, Subscription } from './types';

let store: MemorySaasStore;

const ALICE = 'user_alice';
const BOB = 'user_bob';
const MALLORY = 'user_mallory';

async function makeOrg(name: string, owner: string, planKey = 'starter') {
  const { organization } = await createOrganization({
    name,
    orgType: 'company',
    createdByUserId: owner,
    planKey,
  });
  return organization;
}

beforeEach(() => {
  store = useMemoryStore();
});

describe('tenant isolation', () => {
  it('refuses a capability check from a member of another organization', async () => {
    const a = await makeOrg('Acme', ALICE);
    await makeOrg('Umbrella', MALLORY);

    const own = await checkCapability(a.id, ALICE, 'mail.send');
    expect(own.allowed).toBe(true);

    const theirs = await checkCapability(a.id, MALLORY, 'mail.send');
    expect(theirs.allowed).toBe(false);
    expect(theirs.reason).toBe('org_mismatch');
  });

  it('does not leak a usage figure to an outsider', async () => {
    const a = await makeOrg('Acme', ALICE);
    await meter(a.id, { metric: 'emails_sent', quantity: 4_000, source: 'test' });
    const theirs = await checkCapability(a.id, MALLORY, 'mail.send');
    expect(theirs.limits).toHaveLength(0);
    expect(JSON.stringify(theirs)).not.toContain('4000');
  });

  it('will not resolve a tenant a user does not belong to', async () => {
    const a = await makeOrg('Acme', ALICE);
    expect(await resolveTenantForUser(ALICE, a.id)).toBe(a.id);
    expect(await resolveTenantForUser(MALLORY, a.id)).toBeNull();
    expect(await resolveTenantForUser(null, a.id)).toBeNull();
  });

  it('gives a user with no membership no default tenant', async () => {
    await makeOrg('Acme', ALICE);
    expect(await resolveTenantForUser('user_nobody')).toBeNull();
  });

  it('keeps usage separate between tenants', async () => {
    const a = await makeOrg('Acme', ALICE);
    const b = await makeOrg('Umbrella', MALLORY);
    await meter(a.id, { metric: 'emails_sent', quantity: 500, source: 'test' });
    await meter(b.id, { metric: 'emails_sent', quantity: 7, source: 'test' });

    expect((await tenantContext(a.id))?.usage.values.emails_sent).toBe(500);
    expect((await tenantContext(b.id))?.usage.values.emails_sent).toBe(7);
  });

  it('lists only the organizations a user belongs to', async () => {
    const a = await makeOrg('Acme', ALICE);
    await makeOrg('Umbrella', MALLORY);
    const forAlice = await store.listOrganizationsForUser(ALICE);
    expect(forAlice.map((o) => o.id)).toEqual([a.id]);
  });

  it('an outsider cannot change a plan', async () => {
    const a = await makeOrg('Acme', ALICE);
    const attempt = await changeOrganizationPlan(a.id, MALLORY, 'business');
    expect(attempt.ok).toBe(false);
    expect((await tenantContext(a.id))?.subscription.planKey).toBe('starter');
  });
});

describe('plan restrictions', () => {
  it('a Free tenant cannot send a campaign, and is told which plan can', async () => {
    const org = await makeOrg('Solo', ALICE, 'free');
    const d = await checkCapability(org.id, ALICE, 'campaign.send');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('plan');
    expect(d.upgradeToPlanKey).toBe('starter');
  });

  it('the same tenant can once the plan changes', async () => {
    const org = await makeOrg('Solo', ALICE, 'free');
    await changeOrganizationPlan(org.id, ALICE, 'professional');
    const d = await checkCapability(org.id, ALICE, 'campaign.send');
    expect(d.allowed).toBe(true);
  });

  it('a role without the permission is refused regardless of plan', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    await inviteMember(org.id, ALICE, BOB, 'analyst');
    const d = await checkCapability(org.id, BOB, 'campaign.send');
    expect(d.reason).toBe('permission');
  });
});

describe('usage calculation from durable events', () => {
  it('accumulates a counter and holds a gauge', async () => {
    const org = await makeOrg('Acme', ALICE);
    await meter(org.id, { metric: 'emails_sent', quantity: 100, source: 'send' });
    await meter(org.id, { metric: 'emails_sent', quantity: 50, source: 'send' });
    await meter(org.id, { metric: 'mailboxes', quantity: 3, source: 'admin' });
    await meter(org.id, { metric: 'mailboxes', quantity: -1, source: 'admin' });

    const ctx = await tenantContext(org.id);
    expect(ctx?.usage.values.emails_sent).toBe(150);
    expect(ctx?.usage.values.mailboxes).toBe(2);
  });

  it('counts the owner as a seat from the moment the tenant exists', async () => {
    const org = await makeOrg('Acme', ALICE);
    expect((await tenantContext(org.id))?.usage.values.users).toBe(1);
  });

  it('does not count the same fact twice when a job is retried', async () => {
    const org = await makeOrg('Acme', ALICE);
    const key = usageKey('message.sent', 'msg_42');
    const first = await meter(org.id, { metric: 'emails_sent', quantity: 1, source: 'send', idempotencyKey: key });
    const retry = await meter(org.id, { metric: 'emails_sent', quantity: 1, source: 'send', idempotencyKey: key });

    expect(first.recorded).toBe(true);
    expect(retry.duplicate).toBe(true);
    expect((await tenantContext(org.id))?.usage.values.emails_sent).toBe(1);
  });

  it('handles concurrent metering of the same fact without double counting', async () => {
    const org = await makeOrg('Acme', ALICE);
    const key = usageKey('message.sent', 'msg_99');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        meter(org.id, { metric: 'emails_sent', quantity: 1, source: 'send', idempotencyKey: key })),
    );
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect((await tenantContext(org.id))?.usage.values.emails_sent).toBe(1);
  });

  it('rebuilds counters from events when they drift', async () => {
    const org = await makeOrg('Acme', ALICE);
    await meter(org.id, { metric: 'emails_sent', quantity: 40, source: 'send' });

    const ctx = await tenantContext(org.id);
    const period = ctx!.period;
    // Corrupt the cache the way a half-finished write would.
    await store.saveCounters(org.id, [{
      orgId: org.id, metric: 'emails_sent', periodStart: period.start,
      value: 999_999, peak: 999_999, updatedAt: new Date().toISOString(),
    }]);

    const result = await reconcile(org.id);
    expect(result.changes.some((c) => c.metric === 'emails_sent' && c.to === 40)).toBe(true);
    expect((await tenantContext(org.id))?.usage.values.emails_sent).toBe(40);
  });

  it('gives a seat back when a member is removed', async () => {
    const org = await makeOrg('Acme', ALICE);
    await inviteMember(org.id, ALICE, BOB, 'member');
    expect((await tenantContext(org.id))?.usage.values.users).toBe(2);
    await removeMember(org.id, ALICE, BOB);
    expect((await tenantContext(org.id))?.usage.values.users).toBe(1);
  });
});

describe('quota enforcement through the service', () => {
  it('refuses the seat that would exceed the plan', async () => {
    // Starter allows three seats. The owner is one.
    const org = await makeOrg('Acme', ALICE, 'starter');
    expect((await inviteMember(org.id, ALICE, 'u2', 'member')).ok).toBe(true);
    expect((await inviteMember(org.id, ALICE, 'u3', 'member')).ok).toBe(true);
    const fourth = await inviteMember(org.id, ALICE, 'u4', 'member');
    expect(fourth.ok).toBe(false);
    expect(fourth.message).toMatch(/team members/i);
  });

  it('records a threshold notice exactly once per period', async () => {
    const org = await makeOrg('Acme', ALICE, 'starter');
    const first = await meter(org.id, { metric: 'emails_sent', quantity: 8_100, source: 'send' });
    expect(first.crossed.map((c) => c.threshold)).toContain(0.8);

    const second = await meter(org.id, { metric: 'emails_sent', quantity: 10, source: 'send' });
    expect(second.crossed).toHaveLength(0);
  });

  it('lets a transactional send through past the hard limit and says so', async () => {
    const org = await makeOrg('Solo', ALICE, 'free');
    await meter(org.id, { metric: 'emails_sent', quantity: 600, source: 'send' });
    const d = await checkCapability(org.id, ALICE, 'mail.send', { critical: true });
    expect(d.allowed).toBe(true);
    expect(d.overage).toBe(true);
    expect(d.notice).toMatch(/transactional/i);
  });

  it('refuses the same send when it is not transactional', async () => {
    const org = await makeOrg('Solo', ALICE, 'free');
    await meter(org.id, { metric: 'emails_sent', quantity: 600, source: 'send' });
    expect((await checkCapability(org.id, ALICE, 'mail.send')).allowed).toBe(false);
  });
});

describe('membership rules through the service', () => {
  it('will not let an Admin promote anybody to Owner', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    await inviteMember(org.id, ALICE, BOB, 'admin');
    const attempt = await inviteMember(org.id, BOB, 'u9', 'owner');
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toMatch(/only an owner/i);
  });

  it('will not remove the last owner', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    const attempt = await removeMember(org.id, ALICE, ALICE);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toMatch(/only owner/i);
  });

  it('lets an owner step back once a second owner exists', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    await inviteMember(org.id, ALICE, BOB, 'owner');
    expect((await setMemberRole(org.id, ALICE, ALICE, 'admin')).ok).toBe(true);
  });
});

describe('subscription changes', () => {
  it('applies an upgrade immediately', async () => {
    const org = await makeOrg('Acme', ALICE, 'starter');
    const result = await changeOrganizationPlan(org.id, ALICE, 'business');
    expect(result.ok).toBe(true);
    expect(result.immediate).toBe(true);
    expect((await tenantContext(org.id))?.plan.key).toBe('business');
  });

  it('defers a downgrade to the end of the paid period', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    const result = await changeOrganizationPlan(org.id, ALICE, 'starter');
    expect(result.ok).toBe(true);
    expect(result.immediate).toBe(false);

    const ctx = await tenantContext(org.id);
    // Capacity already paid for is not confiscated mid-period.
    expect(ctx?.plan.key).toBe('business');
    expect(ctx?.subscription.pendingPlanKey).toBe('starter');
    expect(result.message).toMatch(/already paid for/i);
  });

  it('applies the pending downgrade at renewal', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    await changeOrganizationPlan(org.id, ALICE, 'starter');
    const before = (await tenantContext(org.id))!.subscription;
    const { subscription } = renew(before, before.periodEnd);
    expect(subscription.planKey).toBe('starter');
    expect(subscription.pendingPlanKey).toBeNull();
    expect(subscription.periodStart).toBe(before.periodEnd);
  });

  it('cancels a scheduled downgrade by changing back', async () => {
    const org = await makeOrg('Acme', ALICE, 'business');
    await changeOrganizationPlan(org.id, ALICE, 'starter');
    const back = await changeOrganizationPlan(org.id, ALICE, 'business');
    expect(back.ok).toBe(true);
    expect((await tenantContext(org.id))?.subscription.pendingPlanKey).toBeNull();
  });

  it('refuses a plan that does not exist', async () => {
    const org = await makeOrg('Acme', ALICE);
    const result = await changeOrganizationPlan(org.id, ALICE, 'platinum');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no plan called/i);
  });

  it('honours a per-tenant custom limit over the plan', async () => {
    const org = await makeOrg('Contoso', ALICE, 'starter');
    const sub = (await tenantContext(org.id))!.subscription;
    await store.saveSubscription(org.id, { ...sub, customLimits: { maxUsers: 25 } });
    await inviteMember(org.id, ALICE, 'u2', 'member');
    await inviteMember(org.id, ALICE, 'u3', 'member');
    const fourth = await inviteMember(org.id, ALICE, 'u4', 'member');
    expect(fourth.ok).toBe(true);
  });
});

describe('billing events are idempotent and ordered', () => {
  const sub = (over: Partial<Subscription> = {}): Subscription => ({
    id: 'sub_1', orgId: 'org_1', planKey: 'starter', status: 'active',
    periodStart: '2026-03-01T00:00:00.000Z', periodEnd: '2026-04-01T00:00:00.000Z',
    trialEndsAt: null, cancelAt: null, cancelledAt: null,
    pendingPlanKey: null, pendingPlanAt: null, customLimits: null, customOverage: null,
    lastBillingEventAt: null,
    provider: 'manual', providerRef: null, suspendedReason: null, suspendedAt: null,
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    ...over,
  });

  const event = (over: Partial<BillingEvent> = {}): BillingEvent => ({
    id: 'bev_1', orgId: 'org_1', provider: 'test', eventId: 'evt_1',
    type: 'payment.failed', payload: {},
    occurredAt: '2026-03-15T00:00:00.000Z', receivedAt: '2026-03-15T00:00:00.000Z',
    processedAt: null, error: null,
    ...over,
  });

  it('a payment failure moves an active subscription to past due', () => {
    const r = applyBillingEvent(sub(), event());
    expect(r.subscription.status).toBe('past_due');
    expect(r.changed).toBe(true);
  });

  it('applying the same event twice changes nothing the second time', () => {
    const first = applyBillingEvent(sub(), event());
    const second = applyBillingEvent(first.subscription, event({ occurredAt: '2026-03-15T00:00:00.000Z' }));
    expect(second.changed).toBe(false);
    expect(second.subscription.status).toBe('past_due');
  });

  it('a successful payment clears past due', () => {
    const failed = applyBillingEvent(sub(), event()).subscription;
    const paid = applyBillingEvent(failed, event({
      eventId: 'evt_2', type: 'payment.succeeded', occurredAt: '2026-03-16T00:00:00.000Z',
    }));
    expect(paid.subscription.status).toBe('active');
    expect(paid.subscription.suspendedReason).toBeNull();
  });

  it('will not walk the subscription backwards on an out-of-order retry', () => {
    const cancelled = applyBillingEvent(sub(), event({
      type: 'subscription.cancelled', occurredAt: '2026-03-20T00:00:00.000Z',
    }), '2026-03-20T00:00:00.000Z').subscription;

    const late = applyBillingEvent(cancelled, event({
      eventId: 'evt_old', type: 'payment.succeeded', occurredAt: '2026-03-10T00:00:00.000Z',
    }));
    expect(late.changed).toBe(false);
    expect(late.subscription.status).toBe('cancelled');
    expect(late.note).toMatch(/older/i);
  });

  it('refuses an event naming another tenant', () => {
    const r = applyBillingEvent(sub(), event({ orgId: 'org_other' }));
    expect(r.changed).toBe(false);
    expect(r.note).toMatch(/org_other/);
  });

  it('a cancellation at period end does not stop service today', () => {
    const r = applyBillingEvent(sub(), event({
      type: 'subscription.cancelled', payload: { atPeriodEnd: true },
    }));
    expect(r.subscription.status).toBe('active');
    expect(r.subscription.cancelAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('a scheduled cancellation takes effect at renewal', () => {
    const scheduled = applyBillingEvent(sub(), event({
      type: 'subscription.cancelled', payload: { atPeriodEnd: true },
    })).subscription;
    const { subscription } = renew(scheduled, '2026-04-01T00:00:00.000Z');
    expect(subscription.status).toBe('cancelled');
  });

  it('a plan.changed downgrade schedules rather than applies', () => {
    const r = applyBillingEvent(sub({ planKey: 'business' }), event({
      type: 'plan.changed', payload: { planKey: 'free' },
    }));
    expect(r.subscription.planKey).toBe('business');
    expect(r.subscription.pendingPlanKey).toBe('free');
  });
});

describe('billing event ingestion', () => {
  it('stores an event once and reports a replay as a duplicate, not a failure', async () => {
    const org = await makeOrg('Acme', ALICE);
    const payload = {
      orgId: org.id, provider: 'test', eventId: 'evt_dup', type: 'payment.failed' as const,
      payload: {}, occurredAt: new Date().toISOString(),
    };
    const first = await ingestBillingEvent(payload);
    const replay = await ingestBillingEvent(payload);

    expect(first.ok).toBe(true);
    expect(first.applied).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.applied).toBe(false);
    expect((await store.listBillingEvents(org.id, 50)).filter((e) => e.eventId === 'evt_dup')).toHaveLength(1);
  });

  it('keeps an event it cannot attribute, rather than dropping it', async () => {
    const result = await ingestBillingEvent({
      orgId: null, provider: 'test', eventId: 'evt_orphan', type: 'payment.succeeded',
      payload: {}, occurredAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/stored for review/i);
  });

  it('a payment failure reaches the subscription', async () => {
    const org = await makeOrg('Acme', ALICE);
    await ingestBillingEvent({
      orgId: org.id, provider: 'test', eventId: 'evt_pf', type: 'payment.failed',
      payload: { reason: 'card_declined' }, occurredAt: new Date().toISOString(),
    });
    const ctx = await tenantContext(org.id);
    expect(ctx?.subscription.status).toBe('past_due');
    // Past due is still serviceable: the customer keeps working during the grace period.
    expect((await checkCapability(org.id, ALICE, 'mail.send')).allowed).toBe(true);
  });
});

describe('invoice arithmetic', () => {
  it('works in integers', () => {
    const totals = invoiceTotals([{ quantity: 3, unitAmountMinor: 99_900 }], 53_946);
    expect(totals.subtotalMinor).toBe(299_700);
    expect(totals.totalMinor).toBe(353_646);
  });

  it('marks an invoice paid only when it is covered', () => {
    expect(invoiceStatusFor(1000, 999, 'open')).toBe('open');
    expect(invoiceStatusFor(1000, 1000, 'open')).toBe('paid');
    expect(invoiceStatusFor(1000, 1000, 'void')).toBe('void');
  });
});

describe('the billing overview a screen renders', () => {
  it('gathers plan, usage, standing, members and events in one call', async () => {
    const org = await makeOrg('Acme', ALICE, 'starter');
    await meter(org.id, { metric: 'emails_sent', quantity: 9_000, source: 'send' });
    const view = await billingOverview(org.id);

    expect(view).not.toBeNull();
    expect(view!.context.plan.key).toBe('starter');
    expect(view!.standing.label).toBe('Active');
    expect(view!.attention.some((s) => s.metric === 'emails_sent')).toBe(true);
    expect(view!.members).toHaveLength(1);
    expect(view!.events.length).toBeGreaterThan(0);
  });

  it('returns null for an organization that does not exist', async () => {
    expect(await billingOverview('org_does_not_exist')).toBeNull();
  });
});

describe('the isolation rule holds in the SQL itself', () => {
  // Reads pg-store.ts and checks that every statement against a tenant-scoped table names org_id.
  // This is what keeps the rule true for the next query somebody adds.
  const TENANT_TABLES = [
    'mp_org_profiles', 'mp_teams', 'mp_team_members', 'mp_plans', 'mp_subscriptions',
    'mp_enterprise_terms', 'mp_usage_events', 'mp_usage_counters', 'mp_quota_notices',
    'mp_invoices', 'mp_organization_members',
  ];

  const source = readFileSync(fileURLToPath(new URL('./pg-store.ts', import.meta.url)), 'utf8');

  // Split into individual statements: every sql`...` template in the file.
  const statements = Array.from(source.matchAll(/sql`([\s\S]*?)`/g)).map((m) => m[1]);

  it('finds statements to check', () => {
    expect(statements.length).toBeGreaterThan(20);
  });

  it('never touches a tenant table without naming org_id', () => {
    const offenders: string[] = [];
    for (const stmt of statements) {
      // DDL creates the column rather than filtering on it.
      if (/CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE/i.test(stmt)) continue;
      // A statement may be cross-tenant only by SAYING SO in the SQL, where a reviewer reading the
      // query sees the exemption next to the query rather than in a list somewhere else.
      if (/CROSS-TENANT BY DESIGN/.test(stmt)) continue;
      const touches = TENANT_TABLES.filter((t) => new RegExp('\\b' + t + '\\b').test(stmt));
      if (touches.length === 0) continue;
      if (!/org_id/.test(stmt)) {
        offenders.push(touches.join(',') + ' :: ' + stmt.replace(/\s+/g, ' ').trim().slice(0, 110));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never selects from a tenant table with a bare id lookup', () => {
    // `WHERE id = $1` on a tenant table returns the right row to the wrong tenant.
    const offenders: string[] = [];
    for (const stmt of statements) {
      if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(stmt)) continue;
      if (/CROSS-TENANT BY DESIGN/.test(stmt)) continue;
      const touches = TENANT_TABLES.some((t) => new RegExp('\\b' + t + '\\b').test(stmt));
      if (!touches) continue;
      if (/WHERE\s+id\s*=/i.test(stmt) && !/org_id/.test(stmt)) {
        offenders.push(stmt.replace(/\s+/g, ' ').trim().slice(0, 110));
      }
    }
    expect(offenders).toEqual([]);
  });
});
