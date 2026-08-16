// Plans, limits and the role matrix. Pure functions only — no store, no database.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_OVERAGE,
  METRICS,
  METRIC_KEYS,
  ORG_TYPE_DEFAULTS,
  PLAN_CATALOG,
  catalogPlan,
  cheapestPlanForMetric,
  cheapestPlanWithFeature,
  describeLimit,
  isDowngrade,
  limitFor,
  nextPlanUp,
  resolveLimits,
  resolveOverage,
  resolvePlan,
} from './plans';
import {
  ROLE_PERMISSIONS,
  TEAM_ROLE_RANK,
  canChangeRole,
  canRemoveMember,
  effectivePermissions,
  effectiveRole,
  normalizeTeamRole,
  platformRoleFor,
  roleHas,
  teamRoleFor,
} from './roles';
import { ORGANIZATION_TYPES, TEAM_ROLES } from './types';
import type { Plan, PlanLimits } from './types';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (f: string) => readFileSync(here + f, 'utf8');

describe('metric registry', () => {
  it('covers the twelve metrics the brief names', () => {
    for (const m of [
      'emails_sent', 'emails_received', 'contacts', 'mailboxes', 'domains', 'storage_bytes',
      'attachments', 'api_calls', 'webhook_deliveries', 'automation_runs', 'ai_units',
      'campaign_recipients',
    ]) {
      expect(METRIC_KEYS).toContain(m);
    }
  });

  it('every metric declares a kind and a hint an operator can act on', () => {
    for (const key of METRIC_KEYS) {
      const d = METRICS[key];
      expect(['counter', 'gauge']).toContain(d.kind);
      expect(d.hint.length).toBeGreaterThan(20);
      expect(d.label).not.toBe('');
    }
  });

  it('seats, teams, mailboxes, domains, contacts and storage are gauges, not counters', () => {
    // The distinction that decides whether last month's number is part of this month's answer.
    for (const m of ['users', 'teams', 'mailboxes', 'domains', 'contacts', 'storage_bytes'] as const) {
      expect(METRICS[m].kind).toBe('gauge');
    }
    for (const m of ['emails_sent', 'api_calls', 'campaign_recipients'] as const) {
      expect(METRICS[m].kind).toBe('counter');
    }
  });

  it('every limited metric points at a real PlanLimits field', () => {
    const free = catalogPlan('free') as Plan;
    for (const key of METRIC_KEYS) {
      const field = METRICS[key].limitField;
      if (field) expect(Object.prototype.hasOwnProperty.call(free.limits, field)).toBe(true);
    }
  });
});

describe('null is unlimited, zero is not included', () => {
  it('reads them as opposite answers', () => {
    const enterprise = catalogPlan('enterprise') as Plan;
    const free = catalogPlan('free') as Plan;
    expect(limitFor('emails_sent', enterprise.limits)).toBeNull();
    expect(limitFor('api_calls', free.limits)).toBe(0);
    expect(describeLimit(null)).toBe('Unlimited');
    expect(describeLimit(0)).toBe('Not included');
  });

  it('describes a byte limit in bytes and a count in counts', () => {
    expect(describeLimit(1073741824, 'bytes')).toBe('1 GB');
    expect(describeLimit(10000)).toBe('10,000');
  });
});

describe('limit resolution', () => {
  const plan = catalogPlan('professional') as Plan;

  it('an absent override leaves the plan number alone', () => {
    const resolved = resolveLimits(plan, { maxDomains: 40 });
    expect(resolved.maxDomains).toBe(40);
    expect(resolved.maxUsers).toBe(plan.limits.maxUsers);
  });

  it('an explicit null override means unlimited, not "unset"', () => {
    // The subtlety a spread would destroy: undefined and null must not collapse together.
    const resolved = resolveLimits(plan, { monthlySendQuota: null });
    expect(resolved.monthlySendQuota).toBeNull();
  });

  it('an override of undefined does NOT wipe the plan limit', () => {
    const overrides = { maxDomains: undefined } as Partial<PlanLimits>;
    const resolved = resolveLimits(plan, overrides);
    expect(resolved.maxDomains).toBe(plan.limits.maxDomains);
  });

  it('returns a copy, so a caller cannot mutate the catalog', () => {
    const resolved = resolveLimits(plan, null);
    resolved.maxUsers = 9999;
    expect((catalogPlan('professional') as Plan).limits.maxUsers).toBe(plan.limits.maxUsers);
  });
});

describe('overage policy resolution', () => {
  it('sorts, deduplicates and clamps warn thresholds', () => {
    const plan = catalogPlan('starter') as Plan;
    const resolved = resolveOverage(plan, { warnThresholds: [1, 0.5, 0.5, -2, 0.9] });
    expect(resolved.warnThresholds).toEqual([0.5, 0.9, 1]);
  });

  it('never lets transactional blocking become true by accident', () => {
    for (const p of PLAN_CATALOG) {
      expect(resolveOverage(p, null).blockTransactionalOnHardLimit).toBe(false);
    }
  });

  it('honours an explicit per-tenant decision to block', () => {
    const plan = catalogPlan('business') as Plan;
    expect(resolveOverage(plan, { blockTransactionalOnHardLimit: true }).blockTransactionalOnHardLimit).toBe(true);
  });

  it('the free plan has no burst room', () => {
    expect((catalogPlan('free') as Plan).overage.softMetrics).toHaveLength(0);
    expect(DEFAULT_OVERAGE.softMetrics.length).toBeGreaterThan(0);
  });
});

describe('plan resolution and the ladder', () => {
  it('an unknown plan key falls back to free rather than throwing', () => {
    expect(resolvePlan('a-plan-somebody-deleted').key).toBe('free');
  });

  it('a custom plan wins over the catalog plan with the same key', () => {
    const custom: Plan = {
      ...(catalogPlan('enterprise') as Plan),
      key: 'enterprise',
      name: 'Enterprise (Contoso terms)',
      isCustom: true,
      orgId: 'org_1',
    };
    expect(resolvePlan('enterprise', [custom]).name).toBe('Enterprise (Contoso terms)');
  });

  it('an inactive custom plan does not win', () => {
    const custom: Plan = {
      ...(catalogPlan('enterprise') as Plan), isCustom: true, orgId: 'org_1', isActive: false,
    };
    expect(resolvePlan('enterprise', [custom]).name).toBe('Enterprise');
  });

  it('finds the cheapest plan with a feature and for a volume', () => {
    expect(cheapestPlanWithFeature('campaigns')).toBe('starter');
    expect(cheapestPlanWithFeature('ai')).toBe('professional');
    expect(cheapestPlanWithFeature('sso')).toBe('business');
    expect(cheapestPlanForMetric('emails_sent', 50_000)).toBe('professional');
    expect(cheapestPlanForMetric('emails_sent', 5_000_000)).toBe('enterprise');
  });

  it('knows an upgrade from a downgrade', () => {
    expect(isDowngrade('business', 'starter')).toBe(true);
    expect(isDowngrade('starter', 'business')).toBe(false);
    expect(isDowngrade('starter', 'starter')).toBe(false);
    expect(nextPlanUp('free')).toBe('starter');
    expect(nextPlanUp('enterprise')).toBeNull();
  });
});

describe('organization type supplies defaults and nothing else', () => {
  it('every type has a suggestion and a rationale', () => {
    for (const t of ORGANIZATION_TYPES) {
      expect(ORG_TYPE_DEFAULTS[t].suggestedPlanKey).toBeTruthy();
      expect(ORG_TYPE_DEFAULTS[t].rationale.length).toBeGreaterThan(10);
      expect(catalogPlan(ORG_TYPE_DEFAULTS[t].suggestedPlanKey)).not.toBeNull();
    }
  });

  it('no engine file reads the organization type', () => {
    // Section 2 of the brief: behaviour must not be hard-coded to organization type. The engines
    // never import it, and this is what keeps it that way.
    for (const f of ['entitlements.ts', 'quota.ts', 'usage.ts']) {
      expect(read(f)).not.toMatch(/ORG_TYPE_DEFAULTS|OrganizationType/);
    }
  });
});

describe('prices stay out of the engines', () => {
  it('no engine imports the pricing module', () => {
    for (const f of ['entitlements.ts', 'quota.ts', 'usage.ts', 'plans.ts']) {
      expect(read(f)).not.toMatch(/from '\.\/pricing'/);
    }
  });

  it('the plan type carries no amount', () => {
    for (const plan of PLAN_CATALOG) {
      expect(Object.keys(plan)).not.toContain('price');
      expect(Object.keys(plan)).not.toContain('amountMinor');
    }
  });
});

describe('the role matrix', () => {
  it('gives every one of the nine roles a permission set', () => {
    expect(TEAM_ROLES).toHaveLength(9);
    for (const r of TEAM_ROLES) expect(Array.isArray(ROLE_PERMISSIONS[r])).toBe(true);
  });

  it('does not let Viewer or Analyst read mailbox contents', () => {
    // The trap this matrix is built to avoid: "Viewer" sounding harmless while holding mail.read.
    expect(roleHas('viewer', 'mail.read')).toBe(false);
    expect(roleHas('analyst', 'mail.read')).toBe(false);
    expect(roleHas('support_agent', 'mail.read')).toBe(true);
  });

  it('only the Owner manages billing', () => {
    for (const r of TEAM_ROLES) {
      expect(roleHas(r, 'billing.manage')).toBe(r === 'owner');
    }
    expect(roleHas('admin', 'billing.read')).toBe(true);
  });

  it('a Developer sends without reading', () => {
    expect(roleHas('developer', 'mail.send')).toBe(true);
    expect(roleHas('developer', 'mail.read')).toBe(false);
  });

  it('a Mail Admin cannot send a campaign', () => {
    expect(roleHas('mail_admin', 'domains.manage')).toBe(true);
    expect(roleHas('mail_admin', 'campaigns.send')).toBe(false);
  });
});

describe('mapping to the platform contract', () => {
  it('narrows rather than widens', () => {
    // viewer -> analyst, NOT member: the contract's `member` can send mail and a Viewer must not.
    expect(platformRoleFor('viewer')).toBe('analyst');
    expect(platformRoleFor('mail_admin')).toBe('admin');
    expect(platformRoleFor('campaign_manager')).toBe('member');
  });

  it('reads a legacy row without inventing authority', () => {
    expect(teamRoleFor('member')).toBe('member');
    expect(teamRoleFor('service')).toBe('developer');
    expect(teamRoleFor(null)).toBe('viewer');
    expect(normalizeTeamRole('CAMPAIGN_MANAGER')).toBe('campaign_manager');
    expect(normalizeTeamRole('nonsense', 'admin')).toBe('admin');
  });
});

describe('assignment authority', () => {
  const base = { isSelf: false, ownerCount: 2 };

  it('refuses somebody who cannot manage the team', () => {
    const v = canChangeRole({ ...base, actorRole: 'analyst', targetCurrentRole: 'member', targetNewRole: 'admin' });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('not_permitted');
  });

  it('stops an Admin promoting anybody to Owner', () => {
    const v = canChangeRole({ ...base, actorRole: 'admin', targetCurrentRole: 'member', targetNewRole: 'owner' });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('owner_only');
  });

  it('stops an Admin minting another Admin', () => {
    const v = canChangeRole({ ...base, actorRole: 'admin', targetCurrentRole: 'member', targetNewRole: 'admin' });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('rank');
  });

  it('lets an Admin assign below themselves', () => {
    expect(canChangeRole({ ...base, actorRole: 'admin', targetCurrentRole: 'member', targetNewRole: 'campaign_manager' }).ok).toBe(true);
  });

  it('lets an Owner assign anything, including another Owner', () => {
    expect(canChangeRole({ ...base, actorRole: 'owner', targetCurrentRole: 'member', targetNewRole: 'owner' }).ok).toBe(true);
    expect(canChangeRole({ ...base, actorRole: 'owner', targetCurrentRole: 'admin', targetNewRole: 'viewer' }).ok).toBe(true);
  });

  it('will not demote or remove the last Owner', () => {
    const demote = canChangeRole({
      actorRole: 'owner', targetCurrentRole: 'owner', targetNewRole: 'admin', isSelf: true, ownerCount: 1,
    });
    expect(demote.ok).toBe(false);
    expect(['last_owner', 'self_demotion']).toContain(demote.code);

    const remove = canRemoveMember({
      actorRole: 'owner', targetCurrentRole: 'owner', isSelf: false, ownerCount: 1,
    });
    expect(remove.ok).toBe(false);
    expect(remove.code).toBe('last_owner');
  });

  it('lets an owner go when another one remains', () => {
    expect(canRemoveMember({ actorRole: 'owner', targetCurrentRole: 'owner', isSelf: false, ownerCount: 2 }).ok).toBe(true);
  });

  it('lets anybody remove themselves', () => {
    expect(canRemoveMember({ actorRole: 'member', targetCurrentRole: 'member', isSelf: true, ownerCount: 1 }).ok).toBe(true);
  });

  it('always explains a refusal in a sentence', () => {
    const v = canChangeRole({ ...base, actorRole: 'admin', targetCurrentRole: 'member', targetNewRole: 'owner' });
    expect(v.reason).toBeTruthy();
    expect((v.reason as string).length).toBeGreaterThan(15);
  });
});

describe('team roles narrow, never widen', () => {
  it('a team admin who is an org member stays a member', () => {
    expect(effectiveRole('member', 'admin')).toBe('member');
    expect(TEAM_ROLE_RANK.admin).toBeGreaterThan(TEAM_ROLE_RANK.member);
  });

  it('intersects permissions rather than substituting them', () => {
    const perms = effectivePermissions('admin', 'viewer');
    expect(perms).not.toContain('mail.send');
    expect(perms).toContain('campaigns.read');
  });
});
