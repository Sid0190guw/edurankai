// src/lib/mail-product/automations.test.ts — the graph validator.
//
// This is the test file that earns its keep. A visual builder that lets somebody publish a graph
// with an unreachable branch, a condition with no NO edge, or a delay-free loop has not helped them
// — it has moved the failure from build time to the moment it starts mailing people. Each case below
// is one of those failures.
import { describe, it, expect } from 'vitest';
import {
  validateGraph, validateNode, coerceGraph, starterGraph, describeNode, humaniseMinutes,
  type AutomationGraph,
} from './automations';

const T = { id: 't', kind: 'trigger' as const, config: { event: 'contact_created' } };
const E = { id: 'e', kind: 'end' as const, config: {} };

function g(nodes: any[], edges: any[]): AutomationGraph {
  return { nodes, edges } as AutomationGraph;
}

describe('validateGraph — structure', () => {
  it('accepts the smallest sound graph', () => {
    const v = validateGraph(g([T, E], [{ from: 't', to: 'e' }]));
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it('refuses an empty graph with something a person can act on', () => {
    const v = validateGraph(g([], []));
    expect(v.ok).toBe(false);
    expect(v.problems[0].message).toMatch(/empty/i);
  });

  it('refuses a graph with no trigger — nothing could enter it', () => {
    const v = validateGraph(g([E], []));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /no trigger/i.test(p.message))).toBe(true);
  });

  it('refuses two triggers — that is two automations sharing a canvas', () => {
    const v = validateGraph(g(
      [T, { id: 't2', kind: 'trigger', config: { event: 'contact_created' } }, E],
      [{ from: 't', to: 'e' }, { from: 't2', to: 'e' }],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /more than one trigger/i.test(p.message))).toBe(true);
  });

  it('refuses a dead end, which would drop the run silently', () => {
    const v = validateGraph(g(
      [T, { id: 's', kind: 'send_email', config: { templateId: '11111111-1111-1111-1111-111111111111' } }],
      [{ from: 't', to: 's' }],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.nodeId === 's' && /leads nowhere/i.test(p.message))).toBe(true);
  });

  it('names an unreachable step rather than leaving it looking published', () => {
    const v = validateGraph(g(
      [T, E, { id: 'orphan', kind: 'end', config: {} }],
      [{ from: 't', to: 'e' }],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.nodeId === 'orphan' && /never run/i.test(p.message))).toBe(true);
  });

  it('refuses an End that leads somewhere', () => {
    const v = validateGraph(g([T, E, { id: 'e2', kind: 'end', config: {} }],
      [{ from: 't', to: 'e' }, { from: 'e', to: 'e2' }]));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /cannot lead anywhere/i.test(p.message))).toBe(true);
  });

  it('refuses a non-condition step with two outgoing edges — "next" would be ambiguous', () => {
    const v = validateGraph(g(
      [T, E, { id: 'e2', kind: 'end', config: {} }],
      [{ from: 't', to: 'e' }, { from: 't', to: 'e2' }],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /only lead to one place/i.test(p.message))).toBe(true);
  });
});

describe('validateGraph — conditions', () => {
  const C = { id: 'c', kind: 'condition' as const, config: { field: 'stage', op: 'is', value: '3' } };

  it('accepts a condition with both branches connected', () => {
    const v = validateGraph(g([T, C, E, { id: 'e2', kind: 'end', config: {} }], [
      { from: 't', to: 'c' },
      { from: 'c', to: 'e', branch: 'yes' },
      { from: 'c', to: 'e2', branch: 'no' },
    ]));
    expect(v.ok).toBe(true);
  });

  // The one people forget, and it drops contacts without saying so.
  it('refuses a condition with no NO branch, and says what happens to those people', () => {
    const v = validateGraph(g([T, C, E], [
      { from: 't', to: 'c' },
      { from: 'c', to: 'e', branch: 'yes' },
    ]));
    expect(v.ok).toBe(false);
    const problem = v.problems.find((p) => p.nodeId === 'c' && /no NO branch/i.test(p.message));
    expect(problem).toBeTruthy();
    expect(problem!.message).toMatch(/drops out silently/i);
  });

  it('refuses a condition with no YES branch', () => {
    const v = validateGraph(g([T, C, E], [
      { from: 't', to: 'c' },
      { from: 'c', to: 'e', branch: 'no' },
    ]));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /no YES branch/i.test(p.message))).toBe(true);
  });

  it('refuses a condition that tests nothing', () => {
    const v = validateGraph(g(
      [T, { id: 'c', kind: 'condition', config: {} }, E, { id: 'e2', kind: 'end', config: {} }],
      [{ from: 't', to: 'c' }, { from: 'c', to: 'e', branch: 'yes' }, { from: 'c', to: 'e2', branch: 'no' }],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.nodeId === 'c')).toBe(true);
  });
});

describe('validateGraph — loops', () => {
  it('refuses a loop with no Delay in it, which would send at machine speed', () => {
    const v = validateGraph(g(
      [T, { id: 'a', kind: 'add_tag', config: { tag: 'x' } }, { id: 'b', kind: 'add_tag', config: { tag: 'y' } }],
      [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    ));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /loops back/i.test(p.message))).toBe(true);
  });

  it('allows a loop that passes through a Delay', () => {
    const v = validateGraph(g(
      [T,
        { id: 'd', kind: 'delay', config: { minutes: 1440 } },
        { id: 'c', kind: 'condition', config: { field: 'stage', op: 'is', value: '3' } },
        E,
      ],
      [
        { from: 't', to: 'd' },
        { from: 'd', to: 'c' },
        { from: 'c', to: 'd', branch: 'no' },
        { from: 'c', to: 'e', branch: 'yes' },
      ],
    ));
    expect(v.ok).toBe(true);
  });
});

describe('validateNode', () => {
  it('refuses a delay of zero — that is not a delay', () => {
    expect(validateNode({ id: 'd', kind: 'delay', config: { minutes: 0 } }).length).toBe(1);
    expect(validateNode({ id: 'd', kind: 'delay', config: { minutes: -5 } }).length).toBe(1);
    expect(validateNode({ id: 'd', kind: 'delay', config: {} }).length).toBe(1);
  });

  it('flags a delay longer than a year as almost certainly a typo', () => {
    const p = validateNode({ id: 'd', kind: 'delay', config: { minutes: 60 * 24 * 400 } });
    expect(p.length).toBe(1);
    expect(p[0].message).toMatch(/typo/i);
  });

  it('accepts an ordinary delay', () => {
    expect(validateNode({ id: 'd', kind: 'delay', config: { minutes: 1440 } })).toEqual([]);
  });

  it('requires a real uuid for the template on a send step', () => {
    expect(validateNode({ id: 's', kind: 'send_email', config: { templateId: 'not-a-uuid' } }).length).toBe(1);
    expect(validateNode({ id: 's', kind: 'send_email', config: { templateId: '11111111-1111-1111-1111-111111111111' } })).toEqual([]);
  });

  it('requires https on a webhook, because it carries a contact', () => {
    expect(validateNode({ id: 'w', kind: 'webhook', config: { url: 'http://x.com' } }).length).toBe(1);
    expect(validateNode({ id: 'w', kind: 'webhook', config: { url: 'https://x.com' } })).toEqual([]);
  });

  it('requires a tag name on a tag step', () => {
    expect(validateNode({ id: 'a', kind: 'add_tag', config: { tag: '' } }).length).toBe(1);
    expect(validateNode({ id: 'a', kind: 'add_tag', config: { tag: 'stage-3' } })).toEqual([]);
  });
});

describe('coerceGraph', () => {
  it('turns junk into an empty graph rather than throwing', () => {
    expect(coerceGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(coerceGraph('nope')).toEqual({ nodes: [], edges: [] });
    expect(coerceGraph({ nodes: 'x', edges: 3 })).toEqual({ nodes: [], edges: [] });
  });

  it('drops a node of an unknown kind', () => {
    const out = coerceGraph({ nodes: [{ id: 'a', kind: 'teleport' }, { id: 'b', kind: 'end' }], edges: [] });
    expect(out.nodes.length).toBe(1);
    expect(out.nodes[0].kind).toBe('end');
  });

  it('drops an edge pointing at a node that does not exist', () => {
    const out = coerceGraph({
      nodes: [{ id: 'a', kind: 'trigger' }],
      edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }],
    });
    expect(out.edges.length).toBe(1);
  });

  it('normalises a branch value it does not recognise to undefined', () => {
    const out = coerceGraph({
      nodes: [{ id: 'a', kind: 'trigger' }, { id: 'b', kind: 'end' }],
      edges: [{ from: 'a', to: 'b', branch: 'maybe' }],
    });
    expect(out.edges[0].branch).toBeUndefined();
  });
});

describe('starterGraph', () => {
  // The example in the brief, and it must be sound — an example that refuses to publish is worse
  // than no example.
  it('is a graph that would actually validate once its templates are chosen', () => {
    const v = validateGraph(starterGraph());
    const structural = v.problems.filter((p) => !/template/i.test(p.message));
    expect(structural).toEqual([]);
  });

  it('has exactly one trigger and both condition branches connected', () => {
    const g0 = starterGraph();
    expect(g0.nodes.filter((n) => n.kind === 'trigger').length).toBe(1);
    for (const c of g0.nodes.filter((n) => n.kind === 'condition')) {
      const out = g0.edges.filter((e) => e.from === c.id);
      expect(out.some((e) => e.branch === 'yes')).toBe(true);
      expect(out.some((e) => e.branch === 'no')).toBe(true);
    }
  });
});

describe('humaniseMinutes', () => {
  it('reads as a person would say it', () => {
    expect(humaniseMinutes(1)).toBe('Wait 1 minute');
    expect(humaniseMinutes(30)).toBe('Wait 30 minutes');
    expect(humaniseMinutes(60)).toBe('Wait 1 hour');
    expect(humaniseMinutes(1440)).toBe('Wait 1 day');
    expect(humaniseMinutes(10080)).toBe('Wait 7 days');
    expect(humaniseMinutes(0)).toBe('No wait');
  });
});

describe('describeNode', () => {
  it('says what is missing rather than showing a blank', () => {
    expect(describeNode({ id: 't', kind: 'trigger', config: {} })).toMatch(/not set/i);
    expect(describeNode({ id: 's', kind: 'send_email', config: {} })).toMatch(/not chosen/i);
  });
});
