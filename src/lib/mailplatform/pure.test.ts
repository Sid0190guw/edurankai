// src/lib/mailplatform/pure.test.ts — the condition evaluator, the delay arithmetic, the failure
// classifier, the webhook signature, and the adapter that maps the canvas's graph onto them.
// No database, no clock, no network.
import { describe, expect, it } from 'vitest';
import { validateGraph } from '@/lib/mail-product/automations';
import { checkAgainstPlatform, conditionFromNode, delayFromNode, describeForBuilder, nextNodeAfter, triggerNode } from './graph';
import { compareValues, describeCondition, evaluateCondition, isLeaf, resolveField } from './conditions';
import type { ConditionLeaf, ConditionNode } from './conditions';
import { describeDelay, resolveDelay, MAX_DELAY_MS } from './delay';
import { BusinessRuleFailure, PermanentFailure, TemporaryFailure, classifyError, decideRetry, retryDelayMs } from './errors';
import { canonicalEventType, eventMatchesTrigger, factsFor, isUsableEventType } from './triggers';
import { assertSafeOutboundUrl, signWebhookBody, verifyWebhook } from './security';
import { AUTOMATION_EXAMPLES } from './examples';
import { isIrreversible } from './actions';

/** ConditionNode is a union of a leaf and the and/or/not groups. A test that reads `.field` off it
 *  is asserting it is a LEAF, so it says so rather than reaching through the union with `!`. */
function leaf(n: ConditionNode | null): ConditionLeaf {
  expect(n).toBeTruthy();
  expect(isLeaf(n as ConditionNode)).toBe(true);
  return n as ConditionLeaf;
}

describe('the graph adapter', () => {
  const graph = AUTOMATION_EXAMPLES[0].graph;

  it('finds the single trigger and follows each branch', () => {
    expect(triggerNode(graph)!.id).toBe('trigger_1');
    expect(nextNodeAfter(graph, 'condition_1', 'yes')).toBe('send_1');
    expect(nextNodeAfter(graph, 'condition_1', 'no')).toBe('end_1');
    expect(nextNodeAfter(graph, 'send_1')).toBe('delay_1');
  });

  it('maps every canvas condition field onto a real path into the run facts', () => {
    // `stage` is virtual: the event's value when the event carries one, the contact's otherwise.
    expect(conditionFromNode({ id: 'c', kind: 'condition', config: { field: 'stage', value: '3' } }))
      .toEqual({ field: 'stage', operator: 'equals', value: '3' });
    expect(leaf(conditionFromNode({ id: 'c', kind: 'condition', config: { field: 'status', value: 'subscribed' } })).field).toBe('contact.status');
    expect(leaf(conditionFromNode({ id: 'c', kind: 'condition', config: { field: 'field', key: 'cohort', value: 'a' } })).field).toBe('contact.fields.cohort');
    // A tag test is MEMBERSHIP whatever operator is chosen — equality against the whole list would
    // fail every contact the moment they had a second tag.
    expect(leaf(conditionFromNode({ id: 'c', kind: 'condition', config: { field: 'tag', operator: 'equals', value: 'x' } })).operator).toBe('contains');
    expect(conditionFromNode({ id: 'c', kind: 'condition', config: {} })).toBe(null);
  });

  it('carries an operator through, and takes a whole and/or/not tree as-is', () => {
    expect(leaf(conditionFromNode({ id: 'c', kind: 'condition', config: { field: 'stage', operator: 'greater_than', value: '2' } })).operator).toBe('greater_than');
    const tree = { and: [{ field: 'contact.status', operator: 'equals', value: 'subscribed' }] };
    expect(conditionFromNode({ id: 'c', kind: 'condition', config: { condition: tree } })).toEqual(tree);
  });

  it('maps all three delay forms', () => {
    expect(delayFromNode({ id: 'd', kind: 'delay', config: { minutes: 1440 } })).toEqual({ kind: 'minutes', amount: 1440 });
    expect(delayFromNode({ id: 'd', kind: 'delay', config: { until: '2026-08-20T09:00:00Z' } })).toEqual({ kind: 'until', at: '2026-08-20T09:00:00Z' });
    expect(delayFromNode({ id: 'd', kind: 'delay', config: { untilField: 'event.deadline_at', offsetMinutes: -1440 } }))
      .toEqual({ kind: 'until_field', field: 'event.deadline_at', offsetMinutes: -1440 });
    expect(delayFromNode({ id: 'd', kind: 'delay', config: {} })).toBe(null);
  });

  it('reports a step this platform cannot run', () => {
    const bad = { nodes: [{ id: 'x', kind: 'teleport' as any, config: {} }], edges: [] };
    expect(checkAgainstPlatform(bad as any).length).toBeGreaterThan(0);
  });

  it('describes a graph for a builder, with both validations', () => {
    const d = describeForBuilder(graph);
    const cond = d.nodes.find((n: any) => n.id === 'condition_2');
    expect(cond).toBeTruthy();
    expect(cond!.outgoing.map((o: any) => o.branch).sort()).toEqual(['no', 'yes']);
  });

  it('knows which steps cannot be undone', () => {
    expect(isIrreversible('send_email')).toBe(true);
    expect(isIrreversible('webhook')).toBe(true);
    expect(isIrreversible('add_tag')).toBe(false);
    expect(isIrreversible('update_contact')).toBe(false);
  });
});

describe('conditions', () => {
  const facts = { 'contact.email': 'a@b.test', 'contact.first_name': 'Ananya', 'event.stage': '3', 'event.score': 72, 'event.payload': { nested: { deep: 'yes' } }, 'contact.tags': ['shortlisted', 'india'] };

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

  it('finds a tag by membership', () => {
    expect(evaluateCondition({ field: 'contact.tags', operator: 'contains', value: 'shortlisted' }, facts).result).toBe(true);
    expect(evaluateCondition({ field: 'contact.tags', operator: 'contains', value: 'rejected' }, facts).result).toBe(false);
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
    // This is what makes "assessment_completed is not true" match the candidate who never started.
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

  it('records a trace covering every rule, not only up to the first failure', () => {
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
    const r = resolveDelay({ kind: 'minutes', amount: 1440 }, now);
    expect(r.ok && r.at.toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('resolves an absolute date, and fires immediately when it has already passed', () => {
    expect(resolveDelay({ kind: 'until', at: '2026-08-20T09:00:00.000Z' }, now).ok).toBe(true);
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
    expect(resolveDelay({ kind: 'minutes', amount: -1 }, now).ok).toBe(false);
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

  it('resolves the six canvas keys to their canonical dotted names', () => {
    expect(canonicalEventType('application_stage_changed')).toBe('application.stage.changed');
    expect(canonicalEventType('tag_added')).toBe('contact.tag.added');
    expect(canonicalEventType('campaign_clicked')).toBe('email.clicked');
    expect(canonicalEventType('assessment.completed')).toBe('assessment.completed');
  });

  it('accepts declared and well-formed custom types, refuses free text', () => {
    expect(isUsableEventType('contact.created')).toBe(true);
    expect(isUsableEventType('internship.selected')).toBe(true);
    expect(isUsableEventType('application_stage_changed')).toBe(true);   // via the alias
    expect(isUsableEventType('Stage Changed!!')).toBe(false);
    expect(isUsableEventType('nodots')).toBe(false);
  });

  it('exposes the payload under event.* and under the bare name', () => {
    const f = factsFor(event, { email: 'a@b.test' });
    expect(f['event.stage']).toBe('3');
    expect(f['stage']).toBe('3');
    expect(f['contact.email']).toBe('a@b.test');
  });

  it('matches its own event type in either spelling, then applies the filter', () => {
    const f = factsFor(event, null);
    expect(eventMatchesTrigger(event, { event: 'contact_created' }, f).matches).toBe(false);
    expect(eventMatchesTrigger(event, { event: 'application_stage_changed' }, f).matches).toBe(true);
    expect(eventMatchesTrigger(event, { event: 'application.stage.changed' }, f).matches).toBe(true);
    expect(eventMatchesTrigger(event, { event: 'application_stage_changed', filter: { field: 'event.stage', operator: 'equals', value: '9' } }, f).matches).toBe(false);
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
  it('both pass the canvas validator, so an operator could publish them', () => {
    for (const ex of AUTOMATION_EXAMPLES) {
      // The send steps deliberately name no template, which the canvas flags as "choose a template".
      // Everything else must be sound, so the graph itself is what the validator is asked about.
      const withTemplates = {
        nodes: ex.graph.nodes.map((n) => (n.kind === 'send_email' ? { ...n, config: { ...n.config, templateId: '33333333-3333-4333-8333-333333333333' } } : n)),
        edges: ex.graph.edges,
      };
      const v = validateGraph(withTemplates);
      expect(v.ok, ex.key + ': ' + v.problems.map((p) => p.nodeId + ': ' + p.message).join('; ')).toBe(true);
      expect(checkAgainstPlatform(withTemplates), ex.key).toEqual([]);
    }
  });

  it('the send steps ship WITHOUT a template, on purpose', () => {
    for (const ex of AUTOMATION_EXAMPLES) {
      for (const n of ex.graph.nodes) {
        if (n.kind === 'send_email') expect(String((n.config || {}).templateId || '')).toBe('');
      }
    }
  });

  it('the deadline example waits on a date carried by the event', () => {
    const ex = AUTOMATION_EXAMPLES[1];
    expect(delayFromNode(ex.graph.nodes.find((n) => n.kind === 'delay')!)).toEqual({ kind: 'until_field', field: 'event.deadline_at', offsetMinutes: -1440 });
  });
});
