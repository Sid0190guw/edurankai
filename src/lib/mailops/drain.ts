// src/lib/mailops/drain.ts — stopping a mail worker without losing or duplicating mail, and the
// health-check semantics that make blue/green and rolling deploys possible later.
//
// THE FOUR STEPS THE BRIEF ASKS FOR, in the order they must happen:
//
//     stop accepting new work  ->  finish current safe jobs  ->  persist state  ->  shut down
//
// Each of them fails in a specific way if it is skipped:
//
//   Skip "stop accepting"  — the worker claims a message at the moment it is killed, and that entry
//                            sits in sending/ holding a lease until it expires. Not lost, but
//                            delayed by the full lease interval for no reason.
//   Skip "finish current"  — a delivery in flight is abandoned mid-conversation. The far end may
//                            have already accepted it, so the retry sends it twice.
//   Skip "persist"         — the outcome of a completed delivery is never written, so the message
//                            is retried and the recipient gets a duplicate.
//   Skip "shut down"       — the supervisor kills it anyway, and everything above was wasted.
//
// LIVENESS AND READINESS ARE NOT THE SAME CHECK, and conflating them is what makes graceful
// shutdown impossible. During a drain the process is HEALTHY (do not kill it) and NOT READY (do not
// send it work). One endpoint answering both means either the load balancer keeps sending work to a
// draining node, or the supervisor kills a node that was busy finishing.
//
// Everything here is pure. The process actually wiring SIGTERM to this is on the mail host; this
// module is the state machine, so the transitions can be tested and the same rules can be reused by
// any worker.

export type WorkerPhase =
  | 'starting'   // booting; not ready, not accepting
  | 'accepting'  // normal service
  | 'draining'   // no new claims; existing work finishing
  | 'finishing'  // grace period exceeded; only work past the point of no return continues
  | 'stopped';   // safe to exit

export type DrainSignal =
  | 'started'
  | 'shutdown_requested'   // SIGTERM, a deploy, an operator
  | 'grace_expired'
  | 'work_complete'
  | 'force';               // second SIGTERM, or the supervisor's patience running out

export interface WorkerState {
  phase: WorkerPhase;
  /** Units of work claimed and not yet resolved. */
  inFlight: number;
  /**
   * Of those, how many are past the point where abandoning them could duplicate a delivery — the
   * SMTP conversation has reached DATA and the far end may already have accepted.
   */
  uninterruptible: number;
  /** When the drain began. Null when not draining. */
  drainStartedAt: number | null;
}

export interface DrainPolicy {
  /** How long to let in-flight work finish before escalating. */
  graceMs: number;
  /**
   * Absolute ceiling. Past this the process exits even with work in flight, because a worker that
   * never exits blocks the deploy and the supervisor will SIGKILL it anyway — and a SIGKILL is
   * strictly worse than an orderly exit that leaves leases to expire.
   */
  hardStopMs: number;
}

export const DEFAULT_DRAIN_POLICY: DrainPolicy = {
  // One SMTP conversation to a slow server, with room for a greeting timeout. Longer than this and
  // the connection was never going to complete.
  graceMs: 90_000,
  hardStopMs: 120_000,
};

export function initialState(): WorkerState {
  return { phase: 'starting', inFlight: 0, uninterruptible: 0, drainStartedAt: null };
}

/**
 * The transition table.
 *
 * Written as an explicit function rather than a map because two of the transitions depend on the
 * work counts, not just the signal — 'draining' with nothing in flight goes straight to 'stopped',
 * and 'finishing' will not stop while an uninterruptible delivery is mid-DATA.
 */
export function transition(state: WorkerState, signal: DrainSignal, nowMs: number): WorkerState {
  switch (signal) {
    case 'started':
      return { ...state, phase: 'accepting' };

    case 'shutdown_requested': {
      if (state.phase === 'stopped') return state;
      if (state.inFlight === 0) return { ...state, phase: 'stopped', drainStartedAt: nowMs };
      return { ...state, phase: 'draining', drainStartedAt: state.drainStartedAt ?? nowMs };
    }

    case 'work_complete': {
      const inFlight = Math.max(0, state.inFlight - 1);
      const uninterruptible = Math.min(state.uninterruptible, inFlight);
      const next = { ...state, inFlight, uninterruptible };
      if ((state.phase === 'draining' || state.phase === 'finishing') && inFlight === 0) {
        return { ...next, phase: 'stopped' };
      }
      return next;
    }

    case 'grace_expired': {
      if (state.phase !== 'draining') return state;
      // Anything interruptible is given up here: it has NOT reached the point where the far end may
      // have accepted, so releasing it costs a lease interval and duplicates nothing.
      const remaining = state.uninterruptible;
      if (remaining === 0) return { ...state, phase: 'stopped', inFlight: 0 };
      return { ...state, phase: 'finishing', inFlight: remaining };
    }

    case 'force':
      return { ...state, phase: 'stopped' };

    default:
      return state;
  }
}

/** May the worker claim new work. */
export function acceptsNewWork(state: WorkerState): boolean {
  return state.phase === 'accepting';
}

/**
 * READINESS — should a load balancer send this node traffic, or a scheduler give it work.
 *
 * False the moment a drain begins. This is what makes a rolling deploy safe: the node stops being
 * offered work before it stops being able to do it.
 */
export function ready(state: WorkerState): boolean {
  return state.phase === 'accepting';
}

/**
 * LIVENESS — is the process healthy, or should the supervisor restart it.
 *
 * TRUE DURING A DRAIN, deliberately. A draining worker is doing exactly what it was asked to do,
 * and a liveness probe that returns false during a drain gets it killed mid-delivery — which is the
 * precise failure graceful shutdown exists to prevent.
 */
export function live(state: WorkerState): boolean {
  return state.phase !== 'stopped';
}

export interface DrainTick {
  /** The signal to feed back into transition(), or null when nothing needs to change. */
  signal: DrainSignal | null;
  /** Whether the process may now call exit(). */
  mayExit: boolean;
  /** One line for the log and for the ops screen. */
  status: string;
}

/**
 * Call on a timer while draining. Returns what the process should do next.
 *
 * Two clocks, not one: the grace period releases interruptible work, and the hard stop overrides
 * everything. A single timeout cannot express "give up the safe ones now, keep the risky ones for a
 * little longer".
 */
export function drainTick(state: WorkerState, policy: DrainPolicy, nowMs: number): DrainTick {
  if (state.phase === 'stopped') return { signal: null, mayExit: true, status: 'stopped' };
  if (state.drainStartedAt == null) {
    return { signal: null, mayExit: false, status: `${state.phase}, ${state.inFlight} in flight` };
  }

  const elapsed = nowMs - state.drainStartedAt;

  if (elapsed >= policy.hardStopMs) {
    return {
      signal: 'force',
      mayExit: true,
      status:
        state.inFlight > 0
          ? `hard stop after ${Math.round(elapsed / 1000)}s with ${state.inFlight} still in flight — their leases will expire and another worker will retry them, so expect up to ${state.inFlight} duplicate deliveries`
          : `hard stop after ${Math.round(elapsed / 1000)}s, nothing in flight`,
    };
  }

  if (state.phase === 'draining' && elapsed >= policy.graceMs) {
    return {
      signal: 'grace_expired',
      mayExit: false,
      status: `grace period elapsed; releasing ${state.inFlight - state.uninterruptible} interruptible, holding ${state.uninterruptible} mid-delivery`,
    };
  }

  return {
    signal: null,
    mayExit: false,
    status: `${state.phase} for ${Math.round(elapsed / 1000)}s, ${state.inFlight} in flight (${state.uninterruptible} past the point of no return)`,
  };
}

// ---------------------------------------------------------------------------
// Blue/green and rolling deployment
// ---------------------------------------------------------------------------

export interface NodeHealth {
  id: string;
  /** Readiness as reported by the node. */
  ready: boolean;
  live: boolean;
  /** Consecutive successful readiness probes. One success is noise. */
  consecutiveReady: number;
  /** Version or build id the node is serving. */
  version: string;
  /** Work the node currently holds. */
  inFlight: number;
}

export interface CutoverGate {
  /** How many consecutive ready probes a new node needs before it may take traffic. */
  requiredConsecutiveReady: number;
  /** Nodes that must remain serving throughout. Below this, the deploy pauses. */
  minHealthyNodes: number;
}

export const DEFAULT_CUTOVER_GATE: CutoverGate = { requiredConsecutiveReady: 3, minHealthyNodes: 1 };

export type DeployAction = 'promote' | 'wait' | 'rollback' | 'hold';

export interface DeployDecision {
  action: DeployAction;
  reason: string;
}

/**
 * Should the new version take over.
 *
 * Deliberately conservative in one direction: it will say 'wait' forever rather than promote a node
 * whose readiness is flapping. A deploy that takes an extra ten minutes is an inconvenience; a
 * deploy that promotes a half-ready mail node drops inbound connections, and the sender's retry is
 * the only thing standing between that and lost mail.
 */
export function deployDecision(
  current: readonly NodeHealth[],
  incoming: readonly NodeHealth[],
  gate: CutoverGate = DEFAULT_CUTOVER_GATE,
): DeployDecision {
  const healthyCurrent = current.filter((n) => n.ready && n.live);
  const readyIncoming = incoming.filter((n) => n.ready && n.live && n.consecutiveReady >= gate.requiredConsecutiveReady);

  if (!incoming.length) return { action: 'hold', reason: 'No incoming nodes. Nothing to promote.' };

  const deadIncoming = incoming.filter((n) => !n.live);
  if (deadIncoming.length === incoming.length) {
    return { action: 'rollback', reason: `Every incoming node failed its liveness probe (${deadIncoming.map((n) => n.id).join(', ')}). The new build does not start.` };
  }

  if (readyIncoming.length === incoming.length) {
    if (healthyCurrent.length < gate.minHealthyNodes && current.length > 0) {
      return { action: 'hold', reason: `Only ${healthyCurrent.length} healthy nodes on the current version; promoting now would drop below the minimum of ${gate.minHealthyNodes}. Fix the current version first.` };
    }
    return { action: 'promote', reason: `All ${incoming.length} incoming nodes have passed ${gate.requiredConsecutiveReady} consecutive readiness probes.` };
  }

  const flapping = incoming.filter((n) => n.live && !n.ready);
  if (flapping.length) {
    return { action: 'wait', reason: `${flapping.length} incoming node(s) alive but not ready: ${flapping.map((n) => n.id).join(', ')}. Waiting rather than promoting a node that cannot yet take work.` };
  }

  return { action: 'wait', reason: `${readyIncoming.length}/${incoming.length} incoming nodes have enough consecutive ready probes.` };
}

/**
 * The order to drain nodes in a rolling deploy.
 *
 * Least in-flight work first, so the longest-running deliveries get the most time to finish before
 * their node's turn comes. Ties broken by id, so the sequence is deterministic and a half-finished
 * rollout can be resumed from where it stopped.
 */
export function rollingOrder(nodes: readonly NodeHealth[]): NodeHealth[] {
  return [...nodes].sort((a, b) => a.inFlight - b.inFlight || a.id.localeCompare(b.id));
}

/** The checklist a shutdown handler must satisfy. Rendered on the ops surface, not just in a doc. */
export const SHUTDOWN_CONTRACT: { step: string; rule: string }[] = [
  { step: 'Stop accepting', rule: 'Readiness goes false on the FIRST signal, before anything else happens. Liveness stays true.' },
  { step: 'Finish current work', rule: 'Deliveries already past DATA run to completion. Deliveries not yet started are released, not attempted.' },
  { step: 'Persist state', rule: 'Every completed delivery has its outcome written to the spool BEFORE exit. An unwritten success becomes a duplicate send.' },
  { step: 'Release the rest', rule: 'Anything still held is left in sending/ with its lease. Another worker reclaims it once the lease expires — delayed, never lost.' },
  { step: 'Exit', rule: 'Exit code 0 on a clean drain, non-zero on a hard stop, so the supervisor log distinguishes the two.' },
];
