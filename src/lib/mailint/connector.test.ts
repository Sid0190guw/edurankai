// src/lib/mailint/connector.test.ts — health, signature failure, connector failure, retry.
//
// The remaining items from section 14. Each one is a state that, handled wrongly, is INVISIBLE:
//
//   expired credentials   an integration that has quietly stopped working while the console says
//                         "connected"
//   signature failure     a forged event accepted, or a correct sender refused with no clue why
//   connector failure     a thrown exception becoming a 500 that the sender retries forever
//   duplicate publish     the same fact published twice causing two emails
//   retry / dead letter   a step that gives up silently, or one that never gives up
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  BaseConnector,
  PlannedConnector,
  computeHealth,
  credentialStatesOf,
  runConnectorPipeline,
  type ConnectorContext,
  type ConnectorMeta,
  type ExternalEvent,
  type InboundRequest,
  type StepResult,
} from './connector';
import { EXTERNAL_WEBHOOK_CONNECTOR, defaultMappingsFor, getConnector, isConnectable, listConnectorMeta } from './connectors';
import { credentialState, sameEnvironment, sameTenant, stepOutcome } from './policy';
import type { CanonicalEvent } from './events';

const NOW = Date.parse('2026-08-16T10:00:00.000Z');

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    orgId: 'org_1',
    integrationId: 'int_1',
    environment: 'production',
    mappings: defaultMappingsFor('careers'),
    now: NOW,
    credential: async () => null,
    publish: async () => ({ ok: true, eventId: 'evt_' + Math.random().toString(36).slice(2, 8) }),
    ...over,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): InboundRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return { headers, rawBody, json: typeof body === 'string' ? undefined : body, method: 'POST' };
}

// ---------------------------------------------------------------------------------------------
// Health (section 12)
// ---------------------------------------------------------------------------------------------

describe('health states', () => {
  it('reports connected when credentials are in place and nothing has failed', () => {
    const r = computeHealth({ credentialStates: { api_key: 'active' }, required: ['api_key'], consecutiveFailures: 0, lastEventAt: new Date(NOW - 60_000).toISOString(), now: NOW });
    expect(r.status).toBe('connected');
    expect(r.detail).toContain('Last event');
  });

  it('distinguishes "connected, nothing yet" from "connected, event a minute ago"', () => {
    const quiet = computeHealth({ credentialStates: { api_key: 'active' }, required: ['api_key'], now: NOW });
    expect(quiet.status).toBe('connected');
    expect(quiet.detail).toContain('No event has been received yet');
  });

  it('puts disabled above everything — a switched-off integration is not failing', () => {
    const r = computeHealth({ disabled: true, credentialStates: { api_key: 'expired' }, required: ['api_key'], consecutiveFailures: 99, now: NOW });
    expect(r.status).toBe('disabled');
  });

  it('puts expired above failed, because the expiry EXPLAINS the failures', () => {
    const r = computeHealth({ credentialStates: { oauth_token: 'expired' }, required: ['oauth_token'], consecutiveFailures: 40, now: NOW });
    expect(r.status).toBe('expired');
    expect(r.detail).toContain('Re-authorise');
  });

  it('is failed when a required credential was never stored, and says which', () => {
    const r = computeHealth({ credentialStates: {}, required: ['webhook_secret'], now: NOW });
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('webhook secret');
  });

  it('is failed after the consecutive-failure threshold', () => {
    const r = computeHealth({ credentialStates: { api_key: 'active' }, required: ['api_key'], consecutiveFailures: 5, lastFailureAt: new Date(NOW - 120_000).toISOString(), now: NOW });
    expect(r.status).toBe('failed');
  });

  it('is degraded — not failed — for one recent failure', () => {
    const r = computeHealth({ credentialStates: { api_key: 'active' }, required: ['api_key'], consecutiveFailures: 1, lastFailureAt: new Date(NOW - 60_000).toISOString(), now: NOW });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('Still delivering');
  });

  it('is degraded for a credential that expires within the week', () => {
    const r = computeHealth({ credentialStates: { oauth_token: 'expiring' }, required: ['oauth_token'], now: NOW });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('Renew it');
  });

  it('is degraded when a heartbeat integration has gone quiet', () => {
    // Silence is not proof of a quiet week: an integration expected hourly and silent for a day is
    // the state that otherwise renders identically to "no news is good news".
    const r = computeHealth({
      credentialStates: { api_key: 'active' }, required: ['api_key'],
      lastEventAt: new Date(NOW - 24 * 3600_000).toISOString(), expectedIntervalMs: 3600_000, now: NOW,
    });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('not proof');
  });
});

describe('credential lifetime', () => {
  it('walks active to expiring to expired', () => {
    expect(credentialState({ expiresAt: null }, NOW)).toBe('active');
    expect(credentialState({ expiresAt: new Date(NOW + 30 * 24 * 3600_000).toISOString() }, NOW)).toBe('active');
    expect(credentialState({ expiresAt: new Date(NOW + 2 * 24 * 3600_000).toISOString() }, NOW)).toBe('expiring');
    expect(credentialState({ expiresAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe('expired');
  });

  it('lets revoked beat everything', () => {
    expect(credentialState({ expiresAt: new Date(NOW + 99 * 24 * 3600_000).toISOString(), revokedAt: new Date(NOW).toISOString() }, NOW)).toBe('revoked');
  });

  it('takes the WORST state when a kind has several credentials', () => {
    // Two API keys where one has expired is not a healthy integration: we cannot tell from here
    // which one is in use.
    const states = credentialStatesOf([
      { kind: 'api_key', expiresAt: null },
      { kind: 'api_key', expiresAt: new Date(NOW - 1000).toISOString() },
    ], NOW);
    expect(states.api_key).toBe('expired');
  });
});

// ---------------------------------------------------------------------------------------------
// Signatures (section 14: invalid webhooks, signature failure)
// ---------------------------------------------------------------------------------------------

describe('the generic signed webhook connector', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ event: 'candidate.moved', data: { id: 'c_1', stage: 3, email: 'a@b.com' } });
  const id = 'del_1';

  function sign(s: string, t: number, b: string): string {
    return 'v1,' + createHmac('sha256', s).update(id + '.' + t + '.' + b, 'utf8').digest('base64');
  }

  const withSecret = () => ctx({ credential: async () => secret, mappings: [] });

  it('accepts a correctly signed request', async () => {
    const t = Math.floor(NOW / 1000);
    const r = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(
      request(body, { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign(secret, t, body) }),
      withSecret(),
    );
    expect(r.ok, r.error).toBe(true);
  });

  it('refuses a body that was altered after signing', async () => {
    const t = Math.floor(NOW / 1000);
    const r = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(
      request(body.replace('c_1', 'c_2'), { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign(secret, t, body) }),
      withSecret(),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_signature');
  });

  it('refuses a signature made with the wrong secret', async () => {
    const t = Math.floor(NOW / 1000);
    const r = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(
      request(body, { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign('whsec_wrong', t, body) }),
      withSecret(),
    );
    expect(r.ok).toBe(false);
  });

  it('refuses a replayed request whose timestamp has aged out', async () => {
    const t = Math.floor(NOW / 1000) - 3600;
    const r = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(
      request(body, { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign(secret, t, body) }),
      withSecret(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('stale');
  });

  it('accepts EITHER secret during a rotation window', async () => {
    // The vault returns current and previous joined by a newline; both must verify, or "rotate
    // secret" is a button that schedules an outage.
    const t = Math.floor(NOW / 1000);
    const rotating = ctx({ credential: async () => 'whsec_new\n' + secret, mappings: [] });
    const withOld = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(
      request(body, { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign(secret, t, body) }),
      rotating,
    );
    const withNew = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(
      request(body, { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign('whsec_new', t, body) }),
      rotating,
    );
    expect(withOld.ok).toBe(true);
    expect(withNew.ok).toBe(true);
  });

  it('refuses when no secret is stored, and says what to do', async () => {
    const r = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(request(body, { 'webhook-id': id, 'webhook-timestamp': '1', 'webhook-signature': 'v1,x' }), ctx({ mappings: [] }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('integration console');
  });

  it('names the missing headers rather than answering a bare 401', async () => {
    const r = await EXTERNAL_WEBHOOK_CONNECTOR.authenticate(request(body), withSecret());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Webhook-Signature');
  });
});

// ---------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------

class TestConnector extends BaseConnector {
  meta: ConnectorMeta = {
    key: 'test', name: 'Test', description: 'For the tests.', direction: 'inbound',
    availability: 'available', family: 'edurankai', produces: [], requires: [],
  };
}

class ThrowingConnector extends TestConnector {
  async receive(): Promise<StepResult<ExternalEvent[]>> {
    throw new Error('the connector exploded');
  }
}

describe('the connector pipeline', () => {
  it('runs authenticate, validate, receive, normalize, emit in order', async () => {
    const published: Partial<CanonicalEvent>[] = [];
    const result = await runConnectorPipeline(
      new TestConnector(),
      request({ event_id: 'e1', candidate: { id: 'c_1', stage: 3, email: 'a@b.com' } }),
      ctx({ publish: async (e) => { published.push(e); return { ok: true, eventId: 'evt_1' }; } }),
    );
    expect(result.ok, result.error).toBe(true);
    expect(result.trace.map((t) => t.step)).toEqual(['authenticate', 'validate', 'receive', 'normalize', 'emit']);
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('application.stage.changed');
    expect(published[0].payload?.stage).toBe('assessment');
  });

  it('turns a connector that THROWS into a clean failed step, not a 500', async () => {
    const result = await runConnectorPipeline(new ThrowingConnector(), request({ a: 1 }), ctx());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('internal');
    expect(result.error).toContain('exploded');
    // The trace still shows where it died, which is what the sender needs.
    expect(result.trace[result.trace.length - 1].step).toBe('receive');
  });

  it('acknowledges an unmapped payload instead of refusing it', async () => {
    // Refusing would make the sender retry forever and fill its own dead-letter queue with our 4xx.
    const result = await runConnectorPipeline(new TestConnector(), request({ totally: 'unrelated' }), ctx());
    expect(result.ok).toBe(true);
    expect(result.received).toBe(1);
    expect(result.normalized).toBe(0);
    expect(result.published).toBe(0);
  });

  it('refuses a body that is not JSON, and says so', async () => {
    const result = await runConnectorPipeline(new TestConnector(), { headers: {}, rawBody: 'not json', method: 'POST' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_payload');
  });

  it('refuses a batch larger than the ceiling whole, rather than half-publishing it', async () => {
    const events = Array.from({ length: 600 }, (_, i) => ({ candidate: { id: 'c_' + i, stage: 3 } }));
    const result = await runConnectorPipeline(new TestConnector(), request({ events }), ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('at most');
  });

  it('counts a duplicate as a duplicate, not as a failure', async () => {
    // Section 9: the second delivery of the same fact must be a quiet success. Anything else teaches
    // a well-behaved sender that its retry was a mistake.
    const result = await runConnectorPipeline(
      new TestConnector(),
      request({ event_id: 'e1', candidate: { id: 'c_1', stage: 3, email: 'a@b.com' } }),
      ctx({ publish: async () => ({ ok: true, duplicate: true, eventId: 'evt_existing' }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.duplicates).toBe(1);
    expect(result.published).toBe(0);
  });

  it('reports a partial publish failure WITH the successes', async () => {
    let n = 0;
    const result = await runConnectorPipeline(
      new TestConnector(),
      request({ events: [
        { candidate: { id: 'c_1', stage: 3, email: 'a@b.com' } },
        { candidate: { id: 'c_2', stage: 4, email: 'b@b.com' } },
      ] }),
      ctx({ publish: async () => (++n === 1 ? { ok: true, eventId: 'evt_1' } : { ok: false, error: 'the bus refused it' }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Planned connectors and the registry (section 13)
// ---------------------------------------------------------------------------------------------

describe('the registry', () => {
  it('registers the five EduRankAI products plus the generic inbound connector', () => {
    for (const key of ['careers', 'aquintutor', 'talent', 'recruitment', 'university', 'external-webhook']) {
      expect(getConnector(key), key).toBeTruthy();
      expect(isConnectable(key), key).toBe(true);
    }
  });

  it('registers the planned connectors and refuses to connect any of them', () => {
    for (const key of ['slack', 'microsoft-teams', 'google-workspace', 'crm-generic', 'ats-generic', 'university-sis', 'government-portal', 'erp-generic']) {
      const c = getConnector(key);
      expect(c, key).toBeTruthy();
      expect(c!.meta.availability).toBe('planned');
      expect(isConnectable(key), key).toBe(false);
    }
  });

  it('gives every planned connector a sentence naming the ACTUAL blocker', () => {
    for (const m of listConnectorMeta().filter((x) => x.availability === 'planned')) {
      expect(m.blockedOn, m.key).toBeTruthy();
      // "Coming soon" is the thing this field exists to prevent.
      expect(String(m.blockedOn).toLowerCase()).not.toContain('coming soon');
      expect(String(m.blockedOn).length).toBeGreaterThan(40);
    }
  });

  it('makes a planned connector refuse every step rather than pretend', async () => {
    const slack = getConnector('slack') as PlannedConnector;
    const r = await slack.authenticate(request({}), ctx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_implemented');
    const h = await slack.health(ctx());
    expect(h.status).toBe('disabled');
    expect(h.detail).toContain('not implemented');
  });
});

// ---------------------------------------------------------------------------------------------
// Retry policy and tenancy helpers
// ---------------------------------------------------------------------------------------------

describe('retry and dead-letter for delayed steps', () => {
  it('retries on the shared webhook curve', () => {
    const first = stepOutcome(1, 4);
    const second = stepOutcome(2, 4);
    expect(first.outcome).toBe('retry');
    expect(second.retryInMs).toBeGreaterThan(first.retryInMs);
  });

  it('dead-letters once the attempts are spent, rather than retrying forever', () => {
    expect(stepOutcome(4, 4).outcome).toBe('dead_letter');
    expect(stepOutcome(9, 4).outcome).toBe('dead_letter');
  });
});

describe('tenancy helpers', () => {
  it('answers false for a missing side rather than treating null as a match', () => {
    expect(sameTenant('org_1', 'org_1')).toBe(true);
    expect(sameTenant('org_1', 'org_2')).toBe(false);
    expect(sameTenant(null, null)).toBe(false);
    expect(sameTenant('org_1', undefined)).toBe(false);
  });

  it('checks the environment separately from the tenant', () => {
    expect(sameEnvironment('production', 'production')).toBe(true);
    expect(sameEnvironment('development', 'production')).toBe(false);
    expect(sameEnvironment(null, 'production')).toBe(false);
  });
});
