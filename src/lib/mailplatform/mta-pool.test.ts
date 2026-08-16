// Tests for the MTA abstraction. The clock is a parameter everywhere, so "what happens when a node
// dies mid-campaign" is a deterministic assertion rather than a story told in a design document.
import { describe, it, expect } from 'vitest';
import {
  newNodeHealth, probeIfDue, recordAttempt, isSelectable, selectNode,
  newBucket, refill, take, checkThrottle, limitFor, recipientDomain,
  newPoolState, planDelivery, completeDelivery, singleNodePool, poolSummary,
  DEFAULT_BREAKER, type MtaNode, type NodeHealth,
} from './mta-pool';

const T0 = 1_700_000_000_000;

function node(id: string, over: Partial<MtaNode> = {}): MtaNode {
  return { id, label: id, host: id + '.invalid', port: 25, ipPool: 'default', weight: 1, maxConcurrent: 10, status: 'active', ...over };
}
function healthMap(...pairs: [string, NodeHealth][]): Map<string, NodeHealth> {
  return new Map(pairs);
}

describe('circuit breaker', () => {
  it('stays closed below the failure threshold', () => {
    let h = newNodeHealth('a');
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold - 1; i++) {
      h = recordAttempt(h, 'failed', { now: T0, error: 'refused' });
    }
    expect(h.circuit).toBe('closed');
    expect(h.consecutiveFailures).toBe(DEFAULT_BREAKER.failureThreshold - 1);
  });

  it('opens at the threshold and records when it may be probed', () => {
    let h = newNodeHealth('a');
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) h = recordAttempt(h, 'failed', { now: T0, error: 'refused' });
    expect(h.circuit).toBe('open');
    expect(h.openUntil).toBe(T0 + DEFAULT_BREAKER.openMs);
  });

  it('a DEFERRAL never trips the breaker', () => {
    // This is the important one. A large provider throttling a campaign returns 4xx to every
    // message; counting that as node failure would open every circuit in the pool at once and stop
    // delivery to everybody else too.
    let h = newNodeHealth('a');
    for (let i = 0; i < 50; i++) h = recordAttempt(h, 'deferred', { now: T0, error: '451 try later' });
    expect(h.circuit).toBe('closed');
    expect(h.deferred).toBe(50);
    expect(h.consecutiveFailures).toBe(0);
  });

  it('a success resets the failure streak', () => {
    let h = newNodeHealth('a');
    h = recordAttempt(h, 'failed', { now: T0 });
    h = recordAttempt(h, 'failed', { now: T0 });
    h = recordAttempt(h, 'delivered', { now: T0 });
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastError).toBeNull();
  });

  it('needs a success STREAK to close from half-open, not one lucky probe', () => {
    let h = newNodeHealth('a');
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) h = recordAttempt(h, 'failed', { now: T0 });
    h = probeIfDue(h, T0 + DEFAULT_BREAKER.openMs);
    expect(h.circuit).toBe('half_open');

    h = recordAttempt(h, 'delivered', { now: T0 });
    expect(h.circuit).toBe('half_open');   // one is not enough — that is the flap this prevents
    expect(h.probeSuccesses).toBe(1);

    h = recordAttempt(h, 'delivered', { now: T0 });
    expect(h.circuit).toBe('closed');
    expect(h.openUntil).toBeNull();
  });

  it('reopens immediately on a failed probe', () => {
    let h = newNodeHealth('a');
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) h = recordAttempt(h, 'failed', { now: T0 });
    h = probeIfDue(h, T0 + DEFAULT_BREAKER.openMs);
    h = recordAttempt(h, 'failed', { now: T0 + DEFAULT_BREAKER.openMs });
    expect(h.circuit).toBe('open');
    expect(h.openUntil).toBe(T0 + DEFAULT_BREAKER.openMs + DEFAULT_BREAKER.openMs);
  });

  it('probeIfDue does not fire early, and reading eligibility has no side effect', () => {
    let h = newNodeHealth('a');
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) h = recordAttempt(h, 'failed', { now: T0 });
    const before = { ...h };
    expect(probeIfDue(h, T0 + 1).circuit).toBe('open');
    isSelectable(node('a'), h, T0 + 1);
    expect(h).toEqual(before);   // a health screen renders this on every load; it must not mutate
  });

  it('decrements in-flight on every outcome, including failure', () => {
    let h = { ...newNodeHealth('a'), inFlight: 3 };
    h = recordAttempt(h, 'failed', { now: T0 });
    expect(h.inFlight).toBe(2);
    h = recordAttempt(h, 'deferred', { now: T0 });
    expect(h.inFlight).toBe(1);
  });
});

describe('selectNode', () => {
  it('normalises load by capacity so a small node is not saturated first', () => {
    // Same raw in-flight, very different capacity: the big node must win.
    const nodes = [node('small', { maxConcurrent: 2 }), node('big', { maxConcurrent: 32 })];
    const h = healthMap(
      ['small', { ...newNodeHealth('small'), inFlight: 1 }],
      ['big', { ...newNodeHealth('big'), inFlight: 1 }],
    );
    expect(selectNode(nodes, h, { now: T0 }).node?.id).toBe('big');
  });

  it('honours weight for equally sized nodes', () => {
    const nodes = [node('a', { weight: 1 }), node('b', { weight: 4 })];
    const h = healthMap(
      ['a', { ...newNodeHealth('a'), inFlight: 2 }],
      ['b', { ...newNodeHealth('b'), inFlight: 2 }],
    );
    expect(selectNode(nodes, h, { now: T0 }).node?.id).toBe('b');
  });

  it('skips a node at its concurrency limit', () => {
    const nodes = [node('a', { maxConcurrent: 1 }), node('b')];
    const h = healthMap(['a', { ...newNodeHealth('a'), inFlight: 1 }], ['b', newNodeHealth('b')]);
    const sel = selectNode(nodes, h, { now: T0 });
    expect(sel.node?.id).toBe('b');
    expect(sel.considered.find((c) => c.nodeId === 'a')?.reason).toContain('concurrency limit');
  });

  it('will NOT pick a node with an open circuit, even though it is the least loaded', () => {
    // A dead node is the idlest node on the rack. This is the whole reason the breaker exists.
    let dead = newNodeHealth('dead');
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) dead = recordAttempt(dead, 'failed', { now: T0 });
    const nodes = [node('dead'), node('live')];
    const h = healthMap(['dead', dead], ['live', { ...newNodeHealth('live'), inFlight: 5 }]);
    const sel = selectNode(nodes, h, { now: T0 + 1 });
    expect(sel.node?.id).toBe('live');
    expect(sel.considered.find((c) => c.nodeId === 'dead')?.reason).toContain('circuit open');
  });

  it('respects draining and disabled status', () => {
    const nodes = [node('a', { status: 'draining' }), node('b', { status: 'disabled' }), node('c')];
    expect(selectNode(nodes, healthMap(), { now: T0 }).node?.id).toBe('c');
  });

  it('filters by ip pool and by stream', () => {
    const nodes = [node('marketing', { ipPool: 'bulk', streams: ['marketing'] }), node('txn', { ipPool: 'txn', streams: ['transactional'] })];
    expect(selectNode(nodes, healthMap(), { now: T0, stream: 'transactional' }).node?.id).toBe('txn');
    expect(selectNode(nodes, healthMap(), { now: T0, ipPool: 'bulk' }).node?.id).toBe('marketing');
  });

  it('explains itself when nothing is eligible', () => {
    const sel = selectNode([node('a', { status: 'disabled' })], healthMap(), { now: T0 });
    expect(sel.node).toBeNull();
    expect(sel.reason).toContain('status disabled');
  });

  it('says so when no nodes are configured at all', () => {
    expect(selectNode([], healthMap(), { now: T0 }).reason).toBe('no MTA nodes configured');
  });

  it('is deterministic on a tie', () => {
    const nodes = [node('b'), node('a')];
    expect(selectNode(nodes, healthMap(), { now: T0 }).node?.id).toBe('a');
    expect(selectNode(nodes, healthMap(), { now: T0 }).node?.id).toBe('a');
  });
});

describe('token bucket', () => {
  it('starts full and drains one token per take', () => {
    let b = newBucket(5, 5, T0);
    for (let i = 0; i < 5; i++) { const r = take(b, T0); expect(r.allowed).toBe(true); b = r.bucket; }
    expect(take(b, T0).allowed).toBe(false);
  });

  it('refills from elapsed time, not from a timer', () => {
    let b = newBucket(10, 10, T0);
    for (let i = 0; i < 10; i++) b = take(b, T0).bucket;
    expect(take(b, T0).allowed).toBe(false);
    b = refill(b, T0 + 500);            // half a second at 10/s => 5 tokens
    expect(Math.floor(b.tokens)).toBe(5);
    expect(take(b, T0 + 500).allowed).toBe(true);
  });

  it('never over-fills past capacity', () => {
    const b = refill(newBucket(3, 100, T0), T0 + 60_000);
    expect(b.tokens).toBe(3);
  });

  it('reports how long to wait when it refuses', () => {
    let b = newBucket(1, 2, T0);        // 2/s
    b = take(b, T0).bucket;
    const r = take(b, T0);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(500);   // one token at 2/s
  });
});

describe('domain throttling', () => {
  it('falls back to the wildcard limit', () => {
    expect(limitFor('anything.invalid').domain).toBe('*');
  });

  it('applies a per-domain limit and returns a retry delay', () => {
    let state = new Map();
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      const r = checkThrottle(state, 'mta-01', 'busy.invalid', T0, [{ domain: '*', maxPerSecond: 10, burst: 20 }]);
      state = r.state;
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(20);           // the burst, then refused until time advances
  });

  it('keeps separate budgets per node, because the IP is per node', () => {
    let state = new Map();
    for (let i = 0; i < 20; i++) state = checkThrottle(state, 'mta-01', 'd.invalid', T0, [{ domain: '*', maxPerSecond: 1, burst: 1 }]).state;
    const other = checkThrottle(state, 'mta-02', 'd.invalid', T0, [{ domain: '*', maxPerSecond: 1, burst: 1 }]);
    expect(other.allowed).toBe(true);
  });

  it('extracts the recipient domain, lower-cased', () => {
    expect(recipientDomain('A.B@Example.INVALID')).toBe('example.invalid');
    expect(recipientDomain('nope')).toBeNull();
  });
});

describe('planDelivery / completeDelivery', () => {
  it('reserves a slot on the chosen node and releases it on completion', () => {
    let state = newPoolState([node('a')]);
    const plan = planDelivery(state, 'x@t.invalid', { now: T0 });
    expect(plan.node?.id).toBe('a');
    expect(plan.state.health.get('a')!.inFlight).toBe(1);

    state = completeDelivery(plan.state, 'a', 'delivered', { now: T0, latencyMs: 42 });
    expect(state.health.get('a')!.inFlight).toBe(0);
    expect(state.health.get('a')!.delivered).toBe(1);
    expect(state.health.get('a')!.lastLatencyMs).toBe(42);
  });

  it('reports a throttle with a retry delay instead of silently dropping', () => {
    let state = newPoolState([node('a')], [{ domain: '*', maxPerSecond: 1, burst: 1 }]);
    state = planDelivery(state, 'x@t.invalid', { now: T0 }).state;
    const second = planDelivery(state, 'y@t.invalid', { now: T0 });
    expect(second.node).toBeNull();
    expect(second.throttled).toBe(true);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.reason).toContain('rate limit');
  });

  it('refuses an address with no domain rather than guessing', () => {
    const plan = planDelivery(newPoolState([node('a')]), 'not-an-address', { now: T0 });
    expect(plan.node).toBeNull();
    expect(plan.reason).toContain('no domain');
  });

  it('promotes a due circuit to half-open as part of planning', () => {
    let state = newPoolState([node('a')]);
    let h = state.health.get('a')!;
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) h = recordAttempt(h, 'failed', { now: T0 });
    state.health.set('a', h);
    const plan = planDelivery(state, 'x@t.invalid', { now: T0 + DEFAULT_BREAKER.openMs + 1 });
    expect(plan.node?.id).toBe('a');    // the probe is allowed through
  });

  it('survives a node dying mid-campaign: traffic moves and nothing is lost silently', () => {
    let state = newPoolState([node('a'), node('b')], [{ domain: '*', maxPerSecond: 1000, burst: 1000 }]);
    let onA = 0, onB = 0, refused = 0;
    for (let i = 0; i < 40; i++) {
      const plan = planDelivery(state, 'r' + i + '@t.invalid', { now: T0 + i });
      state = plan.state;
      if (!plan.node) { refused++; continue; }
      if (plan.node.id === 'a') { onA++; state = completeDelivery(state, 'a', 'failed', { now: T0 + i, error: 'connection refused' }); }
      else { onB++; state = completeDelivery(state, 'b', 'delivered', { now: T0 + i }); }
    }
    expect(state.health.get('a')!.circuit).toBe('open');
    expect(onB).toBeGreaterThan(0);
    expect(refused).toBe(0);            // b absorbed everything after a was taken out
    expect(onA).toBeLessThanOrEqual(DEFAULT_BREAKER.failureThreshold + 1);
  });
});

describe('singleNodePool', () => {
  it('models today honestly: one node, concurrency 1', () => {
    // Overstating concurrency here would make the capacity model overstate throughput, which is the
    // one thing it must never do.
    const p = singleNodePool({ host: 'relay.invalid', port: 587 });
    expect(p.nodes).toHaveLength(1);
    expect(p.nodes[0].maxConcurrent).toBe(1);
    expect(poolSummary(p, T0).healthy).toBe(1);
  });

  it('counts an open circuit as not healthy in the rollup', () => {
    const p = singleNodePool({ host: 'relay.invalid', port: 587 });
    let h = p.health.get('mta-01')!;
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) h = recordAttempt(h, 'failed', { now: T0 });
    p.health.set('mta-01', h);
    const s = poolSummary(p, T0);
    expect(s.healthy).toBe(0);
    expect(s.open).toBe(1);
  });
});
