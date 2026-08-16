// src/lib/mailplatform/mta-pool.ts — the MTA abstraction (Patch 8 §8).
//
// THE POINT IS THE INDIRECTION, NOT THE ALGORITHM. Today this repository sends through exactly one
// transport (src/lib/mail-transport.ts: one nodemailer SMTP connection, or nothing). "MTA-01…MTA-N"
// does not exist and will not exist until there are servers to run it on. What CAN be built now, and
// what the brief actually asks for, is the seam: application code hands a message to a pool and
// never names a node, so adding MTA-02 later is a row in a table rather than an edit to every send
// path. `singleNodePool()` wraps today's one transport in exactly that shape, so the seam is load
// bearing from the first day instead of being a design document.
//
// EVERYTHING HERE IS PURE AND CLOCK-INJECTED. Selection, throttling and circuit state are decided by
// functions that take the current state and return the next one. That is what makes "what happens
// when MTA-02 dies mid-campaign" a unit test rather than an outage — and per §10, it has one.
//
// WHY A CIRCUIT BREAKER AND NOT JUST RETRIES. A node whose relay is refusing connections will accept
// every message the pool hands it and fail every one, fast. Fast failure is worse than slow failure
// here: the pool would preferentially select it, because least-loaded selection sees an idle node.
// A dead node is the LEAST loaded node on the rack. The breaker exists to stop that.

import type { Labels } from './metrics';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeStatus = 'active' | 'draining' | 'disabled';

/**
 * A delivery node.
 *
 * `ipPool` is a NAME, not an address: reputation is per-IP and the standard practice is to separate
 * streams so a marketing send cannot damage the reputation that carries password resets. The pool
 * name is what a send site asks for; which addresses are behind it is the MTA's business.
 */
export interface MtaNode {
  id: string;
  label: string;
  host: string;
  port: number;
  ipPool: string;
  /** Relative share of traffic among equally-loaded nodes. A bigger box gets a bigger weight. */
  weight: number;
  /** Hard ceiling on messages in flight. The node's own limit, not a policy. */
  maxConcurrent: number;
  status: NodeStatus;
  /** Streams this node may carry. Empty means any. */
  streams?: string[];
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface NodeHealth {
  nodeId: string;
  circuit: CircuitState;
  consecutiveFailures: number;
  /** Epoch ms when an open circuit may next be probed. */
  openUntil: number | null;
  /**
   * Successful probes since the circuit went half-open. Its OWN field rather than a reuse of
   * `consecutiveFailures`: closing the circuit needs a success streak, failing it needs a failure
   * streak, and one counter cannot hold both without one of them being wrong.
   */
  probeSuccesses: number;
  inFlight: number;
  /** Cumulative since the pool state was created. Rates are derived by the caller over a window. */
  delivered: number;
  failed: number;
  deferred: number;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastResultAt: number | null;
}

export function newNodeHealth(nodeId: string): NodeHealth {
  return { nodeId, circuit: 'closed', consecutiveFailures: 0, openUntil: null, probeSuccesses: 0, inFlight: 0, delivered: 0, failed: 0, deferred: 0, lastLatencyMs: null, lastError: null, lastResultAt: null };
}

export interface BreakerPolicy {
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** How long the circuit stays open before one probe is allowed through. */
  openMs: number;
  /** Successes required in half-open before the circuit closes. */
  halfOpenSuccesses: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = { failureThreshold: 5, openMs: 60_000, halfOpenSuccesses: 2 };

/** A node is selectable when it is active, has capacity, and its breaker is not holding it out. */
export function isSelectable(node: MtaNode, health: NodeHealth, now: number): boolean {
  if (node.status !== 'active') return false;
  if (health.inFlight >= node.maxConcurrent) return false;
  if (health.circuit === 'closed') return true;
  if (health.circuit === 'half_open') return true;
  // Open: one probe is allowed once the cool-down has elapsed. The caller transitions it to
  // half_open by calling probeIfDue() — reading must not mutate.
  return health.openUntil !== null && now >= health.openUntil;
}

/**
 * Move a due open circuit to half-open. Separate from isSelectable() so that asking "can this node
 * take work" never has a side effect — a health SCREEN calls isSelectable for every node on every
 * render, and if that closed circuits the display would be changing what it displays.
 */
export function probeIfDue(health: NodeHealth, now: number): NodeHealth {
  if (health.circuit === 'open' && health.openUntil !== null && now >= health.openUntil) {
    return { ...health, circuit: 'half_open', consecutiveFailures: 0, probeSuccesses: 0 };
  }
  return health;
}

export type AttemptOutcome = 'delivered' | 'deferred' | 'failed';

/**
 * Fold one delivery result into node health.
 *
 * A DEFERRAL IS NOT A NODE FAILURE. `4xx` from a remote means the RECIPIENT'S server asked us to
 * come back later — greylisting, rate limiting, a full mailbox. Counting that against the sending
 * node would trip every breaker in the pool the first time a large provider throttled a campaign,
 * taking down delivery to everyone else at the same time. Deferrals are counted and reported; only
 * failures of the node itself (connection refused, TLS failure, auth rejected, timeout) move the
 * breaker.
 */
export function recordAttempt(health: NodeHealth, outcome: AttemptOutcome, opts: { latencyMs?: number; error?: string; now: number; policy?: BreakerPolicy }): NodeHealth {
  const policy = opts.policy ?? DEFAULT_BREAKER;
  const next: NodeHealth = { ...health, inFlight: Math.max(0, health.inFlight - 1), lastResultAt: opts.now, lastLatencyMs: opts.latencyMs ?? health.lastLatencyMs };

  if (outcome === 'delivered') {
    next.delivered = health.delivered + 1;
    next.consecutiveFailures = 0;
    next.lastError = null;
    if (health.circuit === 'half_open') {
      // A probe streak, not a single success. One delivery proving a relay is back is exactly the
      // flap this policy exists to damp: the breaker reopens on the next message and the node
      // oscillates, taking a share of traffic each time it is briefly closed.
      next.probeSuccesses = health.probeSuccesses + 1;
      if (next.probeSuccesses >= policy.halfOpenSuccesses) {
        next.circuit = 'closed';
        next.openUntil = null;
        next.probeSuccesses = 0;
      }
    }
    return next;
  }
  if (outcome === 'deferred') {
    next.deferred = health.deferred + 1;
    next.lastError = opts.error ?? health.lastError;
    return next; // deliberately does not touch the breaker
  }

  next.failed = health.failed + 1;
  next.consecutiveFailures = health.consecutiveFailures + 1;
  next.lastError = opts.error ?? 'delivery failed';
  // A failed PROBE reopens immediately — half-open exists to ask one question, and this is the answer.
  if (health.circuit === 'half_open' || next.consecutiveFailures >= policy.failureThreshold) {
    next.circuit = 'open';
    next.openUntil = opts.now + policy.openMs;
    next.probeSuccesses = 0;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectOptions {
  /** Reputation stream: `transactional`, `marketing`, … Selects the IP pool. */
  stream?: string;
  /** Restrict to one named IP pool, overriding stream mapping. */
  ipPool?: string;
  now: number;
}

export interface Selection {
  node: MtaNode | null;
  /** Why nothing was selected. Never null when `node` is null — an unexplained "no node" is unactionable. */
  reason: string | null;
  /** Every candidate considered and why it was or was not eligible. Rendered on the node health panel. */
  considered: { nodeId: string; eligible: boolean; reason: string; load: number }[];
}

/**
 * Weighted least-loaded selection among eligible nodes.
 *
 * LOAD IS `inFlight / (maxConcurrent * weight)`, not raw inFlight. Raw in-flight sends equal traffic
 * to a 2-core VM and a 32-core box, so the small node saturates while the big one idles and the pool
 * throughput is set by the weakest member. Normalising by capacity is what makes a heterogeneous
 * rack behave like one MTA — the whole point of §8.
 *
 * Ties break by node id, so selection is DETERMINISTIC and therefore testable. Random tie-breaking
 * would spread load marginally better and would make every test flaky; at the point where tie
 * frequency matters, the pool is uniformly loaded and the choice does not.
 */
export function selectNode(nodes: readonly MtaNode[], health: Map<string, NodeHealth>, opts: SelectOptions): Selection {
  const considered: Selection['considered'] = [];
  const eligible: { node: MtaNode; load: number }[] = [];

  for (const node of nodes) {
    const h = health.get(node.id) ?? newNodeHealth(node.id);
    const load = node.maxConcurrent > 0 && node.weight > 0 ? h.inFlight / (node.maxConcurrent * node.weight) : Number.POSITIVE_INFINITY;

    if (opts.ipPool && node.ipPool !== opts.ipPool) { considered.push({ nodeId: node.id, eligible: false, reason: 'ip pool ' + node.ipPool + ' != requested ' + opts.ipPool, load }); continue; }
    if (opts.stream && node.streams && node.streams.length > 0 && !node.streams.includes(opts.stream)) { considered.push({ nodeId: node.id, eligible: false, reason: 'does not carry stream ' + opts.stream, load }); continue; }
    if (node.status !== 'active') { considered.push({ nodeId: node.id, eligible: false, reason: 'status ' + node.status, load }); continue; }
    if (h.inFlight >= node.maxConcurrent) { considered.push({ nodeId: node.id, eligible: false, reason: 'at concurrency limit (' + h.inFlight + '/' + node.maxConcurrent + ')', load }); continue; }
    if (h.circuit === 'open' && !(h.openUntil !== null && opts.now >= h.openUntil)) {
      considered.push({ nodeId: node.id, eligible: false, reason: 'circuit open until ' + new Date(h.openUntil ?? opts.now).toISOString(), load });
      continue;
    }
    considered.push({ nodeId: node.id, eligible: true, reason: h.circuit === 'closed' ? 'healthy' : 'probing (half-open)', load });
    eligible.push({ node, load });
  }

  if (eligible.length === 0) {
    const anyConfigured = nodes.length > 0;
    return {
      node: null,
      reason: anyConfigured ? 'no eligible node: ' + considered.map((c) => c.nodeId + ' (' + c.reason + ')').join(', ') : 'no MTA nodes configured',
      considered,
    };
  }

  eligible.sort((a, b) => (a.load - b.load) || a.node.id.localeCompare(b.node.id));
  return { node: eligible[0].node, reason: null, considered };
}

// ---------------------------------------------------------------------------
// Domain throttling
// ---------------------------------------------------------------------------

/**
 * A token bucket, as a value.
 *
 * Value-typed rather than a class with a timer because a timer cannot survive a serverless freeze
 * and because the state has to be shareable across nodes eventually — a per-process bucket does not
 * throttle anything once there are two processes. `refill()` derives tokens from ELAPSED TIME, so
 * the same struct works whether it lives in memory, in Postgres or in Redis later.
 */
export interface TokenBucket {
  capacity: number;
  tokens: number;
  refillPerSec: number;
  lastRefillAt: number;
}

export function newBucket(capacity: number, refillPerSec: number, now: number): TokenBucket {
  return { capacity, tokens: capacity, refillPerSec, lastRefillAt: now };
}

export function refill(b: TokenBucket, now: number): TokenBucket {
  const elapsed = Math.max(0, now - b.lastRefillAt) / 1000;
  if (elapsed === 0) return b;
  return { ...b, tokens: Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec), lastRefillAt: now };
}

export interface TakeResult { bucket: TokenBucket; allowed: boolean; retryAfterMs: number }

export function take(bucket: TokenBucket, now: number, count = 1): TakeResult {
  const b = refill(bucket, now);
  if (b.tokens >= count) return { bucket: { ...b, tokens: b.tokens - count }, allowed: true, retryAfterMs: 0 };
  const shortfall = count - b.tokens;
  const waitMs = b.refillPerSec > 0 ? Math.ceil((shortfall / b.refillPerSec) * 1000) : Number.POSITIVE_INFINITY;
  return { bucket: b, allowed: false, retryAfterMs: Number.isFinite(waitMs) ? waitMs : 3_600_000 };
}

export interface DomainLimit {
  /** Lower-cased recipient domain, or `*` for the default. */
  domain: string;
  maxPerSecond: number;
  /** Burst allowance. Defaults to one second of rate when omitted. */
  burst?: number;
}

/**
 * Starting limits.
 *
 * THESE ARE POLICY GUESSES, NOT MEASUREMENTS, and they are conservative on purpose: the cost of
 * being too slow is a longer campaign, and the cost of being too fast is a block that takes weeks of
 * reputation work to undo. Large providers publish nothing binding and adjust per-sender by
 * reputation, so the only honest source of a real number is the deferral rate on this deployment's
 * own traffic — which deliverability panels read from `mp_delivery_events`/`email_logs` once there
 * is volume. Until then: slow.
 */
export const DEFAULT_DOMAIN_LIMITS: readonly DomainLimit[] = [
  { domain: '*', maxPerSecond: 10, burst: 20 },
];

export function limitFor(domain: string, limits: readonly DomainLimit[] = DEFAULT_DOMAIN_LIMITS): DomainLimit {
  const d = String(domain || '').toLowerCase();
  return limits.find((l) => l.domain.toLowerCase() === d) ?? limits.find((l) => l.domain === '*') ?? { domain: '*', maxPerSecond: 10, burst: 20 };
}

/** Throttle state keyed by `nodeId|domain`: the limit is per node, because the IP is per node. */
export type ThrottleState = Map<string, TokenBucket>;

export function throttleKey(nodeId: string, domain: string): string {
  return nodeId + '|' + String(domain || '').toLowerCase();
}

export function checkThrottle(state: ThrottleState, nodeId: string, domain: string, now: number, limits: readonly DomainLimit[] = DEFAULT_DOMAIN_LIMITS): { allowed: boolean; retryAfterMs: number; state: ThrottleState } {
  const key = throttleKey(nodeId, domain);
  const limit = limitFor(domain, limits);
  const existing = state.get(key) ?? newBucket(limit.burst ?? limit.maxPerSecond, limit.maxPerSecond, now);
  const r = take(existing, now, 1);
  const next = new Map(state);
  next.set(key, r.bucket);
  return { allowed: r.allowed, retryAfterMs: r.retryAfterMs, state: next };
}

/** Recipient domain, lower-cased. Returns null for an address with no `@`. */
export function recipientDomain(address: string): string | null {
  const at = String(address || '').lastIndexOf('@');
  if (at < 0) return null;
  const d = String(address).slice(at + 1).trim().toLowerCase();
  return d || null;
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

export interface DeliveryRequest {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  stream?: string;
  headers?: Record<string, string>;
}

export interface DeliveryOutcome {
  outcome: AttemptOutcome;
  nodeId: string | null;
  smtpCode?: number | null;
  response?: string | null;
  latencyMs: number;
  error?: string | null;
  /** Set when the pool declined to send now: throttled or no node available. */
  retryAfterMs?: number;
}

/**
 * What a node must be able to do. ONE method, because that is all the application needs to know —
 * everything else (which IP, which relay, how many connections) is behind it.
 *
 * The existing src/lib/mail-transport.ts `sendExternal()` already fits this shape, which is why
 * singleNodePool() below can adapt it without touching it.
 */
export interface NodeTransport {
  nodeId: string;
  send(req: DeliveryRequest): Promise<{ ok: boolean; code?: number | null; response?: string | null; error?: string | null; deferred?: boolean }>;
}

export interface PoolState {
  nodes: MtaNode[];
  health: Map<string, NodeHealth>;
  throttles: ThrottleState;
  limits: readonly DomainLimit[];
  breaker: BreakerPolicy;
}

export function newPoolState(nodes: MtaNode[], limits: readonly DomainLimit[] = DEFAULT_DOMAIN_LIMITS, breaker: BreakerPolicy = DEFAULT_BREAKER): PoolState {
  return { nodes, health: new Map(nodes.map((n) => [n.id, newNodeHealth(n.id)])), throttles: new Map(), limits, breaker };
}

/**
 * Decide WHERE a message goes, without sending it.
 *
 * Split from the send so the decision is testable on its own and so a dry-run mode (the load
 * generator uses one) can exercise selection and throttling at full rate without opening a socket.
 */
export function planDelivery(state: PoolState, to: string, opts: { stream?: string; ipPool?: string; now: number }): { node: MtaNode | null; throttled: boolean; retryAfterMs: number; reason: string | null; state: PoolState } {
  const promoted: PoolState = { ...state, health: new Map(state.health) };
  for (const [id, h] of promoted.health) promoted.health.set(id, probeIfDue(h, opts.now));

  const sel = selectNode(promoted.nodes, promoted.health, { stream: opts.stream, ipPool: opts.ipPool, now: opts.now });
  if (!sel.node) return { node: null, throttled: false, retryAfterMs: 0, reason: sel.reason, state: promoted };

  const domain = recipientDomain(to);
  if (!domain) return { node: null, throttled: false, retryAfterMs: 0, reason: 'recipient address has no domain', state: promoted };

  const t = checkThrottle(promoted.throttles, sel.node.id, domain, opts.now, promoted.limits);
  if (!t.allowed) {
    return { node: null, throttled: true, retryAfterMs: t.retryAfterMs, reason: 'per-domain rate limit for ' + domain + ' on ' + sel.node.id, state: { ...promoted, throttles: t.state } };
  }

  const h = promoted.health.get(sel.node.id) ?? newNodeHealth(sel.node.id);
  const nextHealth = new Map(promoted.health);
  nextHealth.set(sel.node.id, { ...h, inFlight: h.inFlight + 1 });
  return { node: sel.node, throttled: false, retryAfterMs: 0, reason: null, state: { ...promoted, health: nextHealth, throttles: t.state } };
}

/** Fold a completed attempt back into pool state. Pairs with planDelivery, which reserved the slot. */
export function completeDelivery(state: PoolState, nodeId: string, outcome: AttemptOutcome, opts: { latencyMs?: number; error?: string; now: number }): PoolState {
  const h = state.health.get(nodeId);
  if (!h) return state;
  const next = new Map(state.health);
  next.set(nodeId, recordAttempt(h, outcome, { ...opts, policy: state.breaker }));
  return { ...state, health: next };
}

/**
 * Wrap the ONE transport this deployment has today as a one-node pool.
 *
 * This is the honest current state of §8: MTA-01 exists, MTA-02…MTA-N do not. Code written against
 * the pool works unchanged when they do.
 */
export function singleNodePool(opts: { host: string; port: number; label?: string; maxConcurrent?: number } ): PoolState {
  return newPoolState([{
    id: 'mta-01',
    label: opts.label ?? 'Primary relay',
    host: opts.host,
    port: opts.port,
    ipPool: 'default',
    weight: 1,
    // One connection at a time is what nodemailer does here without a pool configured. Claiming more
    // would make the capacity model overstate throughput, which is the one thing it must not do.
    maxConcurrent: opts.maxConcurrent ?? 1,
    status: 'active',
  }]);
}

/** Metric labels for a node. Bounded cardinality: node count, pool count, stream count. */
export function nodeLabels(node: MtaNode, stream?: string): Labels {
  return { node: node.id, ip_pool: node.ipPool, stream };
}

/** Rollup for the node-health panel and for `mta_nodes_healthy`. */
export function poolSummary(state: PoolState, now: number): { total: number; healthy: number; open: number; draining: number; disabled: number; inFlight: number; delivered: number; failed: number; deferred: number } {
  let healthy = 0, open = 0, draining = 0, disabled = 0, inFlight = 0, delivered = 0, failed = 0, deferred = 0;
  for (const node of state.nodes) {
    const h = state.health.get(node.id) ?? newNodeHealth(node.id);
    inFlight += h.inFlight; delivered += h.delivered; failed += h.failed; deferred += h.deferred;
    if (node.status === 'disabled') { disabled++; continue; }
    if (node.status === 'draining') { draining++; continue; }
    if (h.circuit === 'open' && !(h.openUntil !== null && now >= h.openUntil)) open++;
    else healthy++;
  }
  return { total: state.nodes.length, healthy, open, draining, disabled, inFlight, delivered, failed, deferred };
}
