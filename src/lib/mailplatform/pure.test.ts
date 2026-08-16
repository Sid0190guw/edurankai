// src/lib/mailplatform/pure.test.ts — the graph validator, the condition evaluator, the delay
// arithmetic and the failure classifier. No database, no clock, no network.
import { describe, expect, it } from 'vitest';
import { describeForBuilder, findCycle, nextNodeAfter, nextNodeId, validateWorkflow, type WorkflowDefinition } from './graph';
import { compareValues, describeCondition, evaluateCondition, resolveField } from './conditions';
import { describeDelay, resolveDelay, MAX_DELAY_MS } from './delay';
import { BusinessRuleFailure, PermanentFailure, TemporaryFailure, classifyError, decideRetry, retryDelayMs } from './errors';
import { eventMatchesTrigger, factsFor, isUsableEventType } from './triggers';
import { assertSafeOutboundUrl, signWebhookBody, verifyWebhook } from './security';
import { WORKFLOW_EXAMPLES } from './examples';
import { checkAgainstPlatform } from './service';

const line = (nodes: any[], edges: any[]): WorkflowDefinition => ({ version: 1, nodes, edges });

describe('graph validation', () => {
  it('accepts a straight trigger -> action workflow', () => {
    const v = validateWorkflow(line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'contact.created' } }, { id: 'action_1', kind: 'action', action: { type: 'add_tag', params: { tag: 'x' } } }],
      [{ id: 'e1', from: 'trigger_1', to: 'action_1' }],
    ));
    expect(v.ok).toBe(true);
    expect(v.triggerNodeId).toBe('trigger_1');
  });

  it('refuses a workflow with no trigger, and one with two', () => {
    expect(validateWorkflow(line([{ id: 'action_1', kind: 'action', action: { type: 'add_tag' } }], [])).ok).toBe(false);
    const two = validateWorkflow(line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'a.b' } }, { id: 'trigger_2', kind: 'trigger', trigger: { event: 'c.d' } }],
      [],
    ));
    expect(two.ok).toBe(false);
    expect(two.triggerNodeId).toBe(null);
  });

  it('refuses duplicate node ids — a run resumes by node id', () => {
    const v = validateWorkflow(line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'a.b' } }, { id: 'n', kind: 'action', action: { type: 'add_tag' } }, { id: 'n', kind: 'end' }],
      [],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /share the id/.test(p.message))).toBe(true);
  });

  it('refuses a cycle, and finds it', () => {
    const def = line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'a.b' } }, { id: 'a', kind: 'action', action: { type: 'add_tag' } }, { id: 'b', kind: 'action', action: { type: 'add_tag' } }],
      [{ id: 'e1', from: 'trigger_1', to: 'a' }, { id: 'e2', from: 'a', to: 'b' }, { id: 'e3', from: 'b', to: 'a' }],
    );
    expect(findCycle(def)).not.toBe(null);
    expect(validateWorkflow(def).ok).toBe(false);
  });

  it('refuses two edges for the same branch, and an unlabelled edge out of a condition', () => {
    const dup = validateWorkflow(line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'a.b' } }, { id: 'c', kind: 'condition', condition: { field: 'x', operator: 'exists' } }, { id: 'x', kind: 'end' }, { id: 'y', kind: 'end' }],
      [{ id: 'e0', from: 'trigger_1', to: 'c' }, { id: 'e1', from: 'c', to: 'x', branch: 'true' }, { id: 'e2', from: 'c', to: 'y', branch: 'true' }],
    ));
    expect(dup.ok).toBe(false);
    const unlabelled = validateWorkflow(line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'a.b' } }, { id: 'c', kind: 'condition', condition: { field: 'x', operator: 'exists' } }, { id: 'x', kind: 'end' }],
      [{ id: 'e0', from: 'trigger_1', to: 'c' }, { id: 'e1', from: 'c', to: 'x' }],
    ));
    expect(unlabelled.ok).toBe(false);
  });

  it('warns about an unreachable node but still allows the save', () => {
    const v = validateWorkflow(line(
      [{ id: 'trigger_1', kind: 'trigger', trigger: { event: 'a.b' } }, { id: 'orphan', kind: 'action', action: { type: 'add_tag', params: { tag: 'x' } } }],
      [],
    ));
    expect(v.ok).toBe(true);
    expect(v.problems.some((p) => p.level === 'warning' && /cannot be reached/.test(p.message))).toBe(true);
  });

  it('follows the right edge for each branch, and reports the end of a path as null', () => {
    const def = line(
      [{ id: 'c', kind: 'condition', condition: { field: 'x', operator: 'exists' } }],
      [{ id: 'e1', from: 'c', to: 'yes', branch: 'true' }],
    );
    expect(nextNodeAfter(def, 'c', 'true')).toBe('yes');
    expect(nextNodeAfter(def, 'c', 'false')).toBe(null);
  });

  it('generates node ids that do not collide', () => {
    expect(nextNodeId('action', ['action_1', 'action_2'])).toBe('action_3');
  });

  it('describeForBuilder resolves every node with its outgoing edges', () => {
    const d = describeForBuilder(WORKFLOW_EXAMPLES[0].definition);
    expect(d.valid).toBe(true);
    const cond = d.nodes.find((n: any) => n.id === 'condition_2');
    expect(cond).toBeTruthy();
    expect(cond!.outgoing.map((o: any) => o.branch).sort()).toEqual(['false', 'true']);
  });
});

describe('conditions', () => {
  const facts = { 'contact.email': 'a@b.test', 'contact.first_name': 'Ananya', 'event.stage': '3', 'event.score': 72, 'event.payload': { nested: { deep: 'yes' } } };

  it('handles every operator', () => {
    const t = (c: any) => evaluateCondition(c, facts).result;
    expect(t({ field: 'event.stage', operator: 'equals', value: '3' })).toBe(true);
    expect(t({ field: 'event.stage', operator: 'not_equals', value: '3' })).toBe(false);
    expect(t({ field: 'contact.email', operator: 'contains', value: '@b.' })).toBe(true);
    expect(t({ field: 'contact.email', operator: 'starts_with', value: 'a@' })).toBe(true);
    expect(t({ field: 'contact.email', operator: 'ends_with', value: '.test' })).toBe(true);
    expect(t({ field: 'event.score', operator: 'greater_than', value: 50 })).toBe(true);
    expect(t({ field: 'event.score', operator: 'less_than', value: 50 })).toBe(false);
    expect(t({ field: 'contact.first_name', operator: 'exists' })).toBe(true);
    expect(t({ field: 'contact.nothing', operator: 'does_not_exist' })).toBe(true);
  });

  it('compares numbers as numbers, not as text — 9 is not greater than 10', () => {
    expect(compareValues('9', '10')).toBe(-1);
    expect(compareValues('2026-08-20', '2026-08-16')).toBe(1);
    expect(compareValues('abc', '')).toBe(null);
  });

  it('is case-insensitive by default and exact when asked', () => {
    expect(evaluateCondition({ field: 'contact.first_name', operator: 'equals', value: 'ANANYA' }, facts).result).toBe(true);
    expect(evaluateCondition({ field: 'contact.first_name', operator: 'equals', value: 'ANANYA', caseSensitive: true }, facts).result).toBe(false);
  });

  it('a missing field is false for equals and TRUE for not_equals', () => {
    expect(evaluateCondition({ field: 'nope', operator: 'equals', value: 'x' }, facts).result).toBe(false);
    expect(evaluateCondition({ field: 'nope', operator: 'not_equals', value: 'x' }, facts).result).toBe(true);
  });

  it('combines with and/or/not', () => {
    expect(evaluateCondition({ and: [{ field: 'event.stage', operator: 'equals', value: '3' }, { field: 'event.score', operator: 'greater_than', value: 50 }] }, facts).result).toBe(true);
    expect(evaluateCondition({ or: [{ field: 'event.stage', operator: 'equals', value: '9' }, { field: 'event.score', operator: 'greater_than', value: 50 }] }, facts).result).toBe(true);
    expect(evaluateCondition({ not: { field: 'event.stage', operator: 'equals', value: '3' } }, facts).result).toBe(false);
  });

  it('an empty AND is true and an empty OR is false', () => {
    expect(evaluateCondition({ and: [] }, facts).result).toBe(true);
    expect(evaluateCondition({ or: [] }, facts).result).toBe(false);
  });

  it('never throws on rubbish, and answers false', () => {
    expect(evaluateCondition({ nonsense: true } as any, facts).result).toBe(false);
    expect(evaluateCondition({ field: 'x', operator: 'wat' } as any, facts).result).toBe(false);
  });

  it('walks a dotted path into a nested payload', () => {
    expect(resolveField(facts, 'event.payload.nested.deep')).toBe('yes');
  });

  it('records a trace covering every rule, not only the first failure', () => {
    const r = evaluateCondition({ and: [{ field: 'event.stage', operator: 'equals', value: '9' }, { field: 'event.score', operator: 'greater_than', value: 50 }] }, facts);
    expect(r.result).toBe(false);
    expect(r.trace.length).toBe(3);   // both leaves plus the group
  });

  it('describes itself for a builder', () => {
    expect(describeCondition({ field: 'event.stage', operator: 'equals', value: '3' })).toBe('event.stage equals "3"');
  });
});

describe('delays', () => {
  const now = new Date('2026-08-16T09:00:00.000Z');

  it('resolves relative delays to an absolute instant', () => {
    const r = resolveDelay({ kind: 'hours', amount: 24 }, now);
    expect(r.ok && r.at.toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('resolves an absolute date, and fires immediately when it has already passed', () => {
    const future = resolveDelay({ kind: 'until', at: '2026-08-20T09:00:00.000Z' }, now);
    expect(future.ok && future.immediate).toBe(false);
    const past = resolveDelay({ kind: 'until', at: '2026-08-01T09:00:00.000Z' }, now);
    expect(past.ok && past.immediate).toBe(true);
  });

  it('resolves deadline minus 24 hours from a run field', () => {
    const r = resolveDelay({ kind: 'until_field', field: 'event.deadline_at', offsetMinutes: -1440 }, now, () => '2026-08-20T17:00:00.000Z');
    expect(r.ok && r.at.toISOString()).toBe('2026-08-19T17:00:00.000Z');
  });

  it('refuses a missing deadline rather than inventing one', () => {
    const r = resolveDelay({ kind: 'until_field', field: 'event.deadline_at' }, now, () => undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no value for/);
  });

  it('refuses a negative delay and anything over a year', () => {
    expect(resolveDelay({ kind: 'hours', amount: -1 }, now).ok).toBe(false);
    expect(resolveDelay({ kind: 'days', amount: 400 }, now).ok).toBe(false);
    expect(MAX_DELAY_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('describes itself for a builder', () => {
    expect(describeDelay({ kind: 'hours', amount: 24 })).toBe('wait 24 hours');
    expect(describeDelay({ kind: 'until_field', field: 'event.deadline_at', offsetMinutes: -1440 })).toBe('wait until event.deadline_at minus 24 hours');
  });
});

describe('failure classification and retries', () => {
  it('honours a typed failure over any pattern match', () => {
    expect(classifyError(new BusinessRuleFailure('unsubscribed'))).toBe('business');
    expect(classifyError(new PermanentFailure('nope'))).toBe('permanent');
    expect(classifyError(new TemporaryFailure('later'))).toBe('temporary');
  });

  it('reads SMTP 4.x.x as temporary and 5.x.x as permanent', () => {
    expect(classifyError(new Error('421 4.7.0 try again later'))).toBe('temporary');
    expect(classifyError(new Error('550 5.1.1 no such user'))).toBe('permanent');
  });

  it('defaults an unknown error to temporary', () => {
    expect(classifyError(new Error('something odd'))).toBe('temporary');
  });

  it('backs off exponentially and caps at an hour', () => {
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(1)).toBe(120_000);
    expect(retryDelayMs(30)).toBe(3_600_000);
  });

  it('retries a temporary failure until the cap, then dead-letters', () => {
    expect(decideRetry('temporary', 0, 5).action).toBe('retry');
    expect(decideRetry('temporary', 5, 5).action).toBe('dead_letter');
    expect(decideRetry('permanent', 0, 5).action).toBe('dead_letter');
    expect(decideRetry('business', 0, 5).action).toBe('end_run');
  });
});

describe('triggers and event types', () => {
  const event = { eventId: 'e1', type: 'application.stage.changed', orgId: 'edurankai', contactId: 'c1', payload: { stage: '3' }, source: 'internal' as const, occurredAt: new Date('2026-08-16T09:00:00Z') };

  it('accepts declared and well-formed custom types, refuses free text', () => {
    expect(isUsableEventType('contact.created')).toBe(true);
    expect(isUsableEventType('internship.selected')).toBe(true);
    expect(isUsableEventType('Stage Changed!!')).toBe(false);
    expect(isUsableEventType('nodots')).toBe(false);
  });

  it('exposes the payload under event.* and under the bare name', () => {
    const f = factsFor(event, { email: 'a@b.test' });
    expect(f['event.stage']).toBe('3');
    expect(f['stage']).toBe('3');
    expect(f['contact.email']).toBe('a@b.test');
  });

  it('matches only its own event type, then applies the filter', () => {
    const f = factsFor(event, null);
    expect(eventMatchesTrigger(event, { event: 'contact.created' }, f).matches).toBe(false);
    expect(eventMatchesTrigger(event, { event: 'application.stage.changed' }, f).matches).toBe(true);
    expect(eventMatchesTrigger(event, { event: 'application.stage.changed', filter: { field: 'event.stage', operator: 'equals', value: '9' } }, f).matches).toBe(false);
  });
});

describe('security', () => {
  it('refuses an outbound URL pointing back inside', () => {
    expect(assertSafeOutboundUrl('https://example.test/hook').ok).toBe(true);
    expect(assertSafeOutboundUrl('http://example.test/hook').ok).toBe(false);       // not https
    expect(assertSafeOutboundUrl('https://localhost/hook').ok).toBe(false);
    expect(assertSafeOutboundUrl('https://10.0.0.5/hook').ok).toBe(false);
    expect(assertSafeOutboundUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(assertSafeOutboundUrl('https://user:pw@example.test/hook').ok).toBe(false);
  });

  it('accepts a correctly signed webhook and refuses everything else', () => {
    const now = new Date('2026-08-16T09:00:00Z');
    const ts = String(Math.floor(now.getTime() / 1000));
    const body = JSON.stringify({ event_id: 'x', type: 'assessment.completed' });
    const sig = signWebhookBody('sekret', ts, body);

    expect(verifyWebhook({ secret: 'sekret', body, signature: sig, timestamp: ts, now }).ok).toBe(true);
    expect(verifyWebhook({ secret: 'sekret', body, signature: 'deadbeef', timestamp: ts, now }).ok).toBe(false);
    expect(verifyWebhook({ secret: 'sekret', body: body + ' ', signature: sig, timestamp: ts, now }).ok).toBe(false);   // tampered body
    expect(verifyWebhook({ secret: '', body, signature: sig, timestamp: ts, now }).ok).toBe(false);                     // no secret = closed
    expect(verifyWebhook({ secret: 'sekret', body, signature: sig, timestamp: ts, now: new Date(now.getTime() + 10 * 60_000) }).ok).toBe(false);   // replay
  });
});

describe('the shipped examples', () => {
  it('both validate, structurally and against this platform', () => {
    for (const ex of WORKFLOW_EXAMPLES) {
      const v = validateWorkflow(ex.definition);
      expect(v.ok, ex.key + ': ' + v.problems.map((p) => p.message).join('; ')).toBe(true);
      const platform = checkAgainstPlatform(ex.definition);
      expect(platform.filter((p) => p.level === 'error'), ex.key).toEqual([]);
    }
  });

  it('the stage-3 example branches both ways after the 24-hour wait', () => {
    const def = WORKFLOW_EXAMPLES[0].definition;
    expect(nextNodeAfter(def, 'condition_2', 'true')).toBe('action_2');
    expect(nextNodeAfter(def, 'condition_2', 'false')).toBe('action_3');
  });
});
