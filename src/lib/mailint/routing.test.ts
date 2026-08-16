// src/lib/mailint/routing.test.ts — tenant isolation, redaction and the routing decisions.
//
// Two of section 14's required tests live here and they are the two with the worst failure modes:
//
//   TENANT ISOLATION — one organisation's route firing on another organisation's event. Not
//   recoverable by apology: the message has been sent to a person who should never have heard from
//   that product.
//
//   REDACTION — a rejection reason or an assessment score reaching a third-party endpoint. Once it
//   is in somebody else's log file we cannot take it back.
import { describe, it, expect } from 'vitest';
import { planFanout, planRoutes, redactForChannel, resolveConfigPaths, validateRoute, willRedact, type EventRoute } from './routing';
import type { CanonicalEvent } from './events';

const event: CanonicalEvent & { id: string } = {
  id: 'evt_1',
  orgId: 'org_careers',
  type: 'application.stage.changed',
  source: 'careers',
  entityType: 'application',
  entityId: 'app_1',
  payload: { application_id: 'app_1', stage: 'assessment', email: 'ravi@example.com', name: 'Ravi K', note: 'strong portfolio' },
  occurredAt: '2026-08-16T10:00:00.000Z',
};

function route(over: Partial<EventRoute> = {}): EventRoute {
  return {
    id: 'r1',
    orgId: 'org_careers',
    name: 'stage mail',
    eventPattern: 'application.*',
    action: 'email',
    config: { to: '$.email', template: 'stage-change' },
    isActive: true,
    priority: 100,
    ...over,
  };
}

describe('tenant isolation', () => {
  it('refuses a route belonging to another organisation, and says so', () => {
    const plan = planRoutes(event, [route({ orgId: 'org_aquintutor' })]);
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('different organisation');
  });

  it('runs a route belonging to the event’s own organisation', () => {
    const plan = planRoutes(event, [route()]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].action).toBe('email');
  });

  it('keeps another organisation’s endpoint out of the fan-out', () => {
    const plan = planFanout(event, [
      { id: 'ep_mine', orgId: 'org_careers', url: 'https://a.example/hook', eventTypes: ['*'], status: 'active', environment: 'production' },
      { id: 'ep_theirs', orgId: 'org_other', url: 'https://b.example/hook', eventTypes: ['*'], status: 'active', environment: 'production' },
    ], 'production');
    expect(plan.targets.map((t) => t.endpointId)).toEqual(['ep_mine']);
    expect(plan.skipped[0].reason).toContain('different organisation');
  });

  it('keeps a development endpoint out of a production fan-out', () => {
    // The commonest way a sandbox stops being one: a half-built integration receiving real events.
    const plan = planFanout(event, [
      { id: 'ep_dev', orgId: 'org_careers', url: 'https://a.example/hook', eventTypes: ['*'], status: 'active', environment: 'development' },
    ], 'production');
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('different environment');
  });

  it('skips a disabled endpoint', () => {
    const plan = planFanout(event, [
      { id: 'ep', orgId: 'org_careers', url: 'https://a.example/hook', eventTypes: ['*'], status: 'disabled', environment: 'production' },
    ], 'production');
    expect(plan.targets).toHaveLength(0);
  });
});

describe('redaction', () => {
  const rejection: CanonicalEvent & { id: string } = {
    ...event,
    id: 'evt_2',
    type: 'candidate.rejected',
    payload: {
      application_id: 'app_1',
      email: 'ravi@example.com',
      name: 'Ravi K',
      reason: 'The written exercise did not meet the bar for this role.',
      decided_by: 'user_44',
    },
  };

  it('keeps the reason for the email — the message TO the person', () => {
    const payload = redactForChannel(rejection, 'email');
    expect(payload.reason).toBeTruthy();
  });

  it('keeps the reason for the workflow that decides what to say', () => {
    expect(redactForChannel(rejection, 'workflow').reason).toBeTruthy();
  });

  it('removes it before a webhook endpoint sees it', () => {
    const payload = redactForChannel(rejection, 'webhook');
    expect(payload.reason).toBeUndefined();
    expect(payload.decided_by).toBeUndefined();
    // The removal is DECLARED, so a consumer knows a field was withheld rather than absent.
    expect(payload.redacted).toContain('reason');
    // The identifying fields it needs to do its job are still there.
    expect(payload.email).toBe('ravi@example.com');
  });

  it('removes it before analytics sees it', () => {
    expect(redactForChannel(rejection, 'analytics').reason).toBeUndefined();
  });

  it('sends the full payload ONLY to an endpoint explicitly granted it', () => {
    const payload = redactForChannel(rejection, 'webhook', { grantSensitive: true });
    expect(payload.reason).toBeTruthy();
    expect(payload.redacted).toBeUndefined();
  });

  it('leaves a non-sensitive event alone', () => {
    const payload = redactForChannel(event, 'webhook');
    expect(payload.note).toBe('strong portfolio'); // application.stage.changed is not sensitive
  });

  it('reports in advance whether a channel would lose fields', () => {
    expect(willRedact(rejection, 'webhook')).toBe(true);
    expect(willRedact(rejection, 'email')).toBe(false);
  });

  it('applies the redaction through the fan-out plan, per endpoint', () => {
    const plan = planFanout(rejection, [
      { id: 'ep_plain', orgId: 'org_careers', url: 'https://a.example/h', eventTypes: ['candidate.*'], status: 'active', environment: 'production' },
      { id: 'ep_granted', orgId: 'org_careers', url: 'https://b.example/h', eventTypes: ['candidate.*'], status: 'active', environment: 'production', grantSensitive: true },
    ], 'production');
    const plain = plan.targets.find((t) => t.endpointId === 'ep_plain');
    const granted = plan.targets.find((t) => t.endpointId === 'ep_granted');
    expect(plain?.payload.reason).toBeUndefined();
    expect(granted?.payload.reason).toBeTruthy();
  });
});

describe('route planning', () => {
  it('refuses a channel the event is not allowed to drive', () => {
    // message.delivered driving an email route would mail the candidate every time a server
    // acknowledged a byte.
    const delivered: CanonicalEvent & { id: string } = {
      ...event, id: 'evt_3', type: 'message.delivered', entityType: 'message', payload: { message_id: 'm1' },
    };
    const plan = planRoutes(delivered, [route({ eventPattern: 'message.*', action: 'email' })]);
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('cannot drive the email channel');
  });

  it('holds a route back when its condition does not hold, and names the condition', () => {
    const plan = planRoutes(event, [route({ conditions: [{ path: 'stage', equals: 'interview' }] })]);
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('condition on stage');
  });

  it('runs a route whose condition holds — the stage-3 workflow', () => {
    const plan = planRoutes(event, [route({ conditions: [{ path: 'stage', equals: 'assessment' }] })]);
    expect(plan.actions).toHaveLength(1);
  });

  it('orders by priority then name, so two admins read the same list', () => {
    const plan = planRoutes(event, [
      route({ id: 'b', name: 'second', priority: 50 }),
      route({ id: 'a', name: 'first', priority: 10 }),
    ]);
    expect(plan.actions.map((a) => a.routeId)).toEqual(['a', 'b']);
  });

  it('scopes stopOnMatch to its own channel', () => {
    // An email route that stops later email routes must not also silence the webhook fan-out: the
    // two are answering different questions.
    const plan = planRoutes(event, [
      route({ id: 'a', name: 'a', action: 'email', priority: 10, stopOnMatch: true }),
      route({ id: 'b', name: 'b', action: 'email', priority: 20 }),
      route({ id: 'c', name: 'c', action: 'analytics', priority: 30, config: { metric: 'stage_changes' } }),
    ]);
    expect(plan.actions.map((a) => a.routeId)).toEqual(['a', 'c']);
    expect(plan.skipped.find((s) => s.routeId === 'b')?.reason).toContain('stopped the chain');
  });

  it('ignores an inactive route entirely', () => {
    expect(planRoutes(event, [route({ isActive: false })]).actions).toHaveLength(0);
  });
});

describe('config paths', () => {
  it('reads a payload path and passes a literal through', () => {
    const r = resolveConfigPaths({ to: '$.email', from: 'careers@edurankai.in' }, ['to', 'from'], event.payload);
    expect(r.to).toBe('ravi@example.com');
    expect(r.from).toBe('careers@edurankai.in');
  });

  it('answers null for a path that produced nothing', () => {
    expect(resolveConfigPaths({ to: '$.missing' }, ['to'], event.payload).to).toBeNull();
  });
});

describe('route validation', () => {
  it('requires an email route to say who it is for', () => {
    const errors = validateRoute({ name: 'x', eventPattern: '*', action: 'email', config: { template: 't' } });
    expect(errors.join(' ')).toContain('`to`');
  });

  it('requires a workflow route to name its workflow', () => {
    expect(validateRoute({ name: 'x', eventPattern: '*', action: 'workflow', config: {} }).join(' ')).toContain('workflowKey');
  });

  it('accepts a webhook route with no endpoint — that means every subscribed endpoint', () => {
    expect(validateRoute({ name: 'x', eventPattern: '*', action: 'webhook', config: {} })).toEqual([]);
  });

  it('rejects an unknown channel', () => {
    expect(validateRoute({ name: 'x', eventPattern: '*', action: 'sms' as any, config: {} }).join(' ')).toContain('not one of');
  });
});
