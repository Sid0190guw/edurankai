// src/lib/events.ts — the platform event bus (Layer 4).
//
// WHY. Today a domain action reaches its side effects by calling them directly: creating an offer
// calls sendPushToUser, then sendPushToAdmins, then logAudit, each wrapped in its own try/catch at
// the call site. That coupling has already cost real bugs in this codebase — a shared try block in
// the catalog import meant one failing write silently skipped two others, and a notification send
// that threw would have reported failure for an offer that had already committed.
//
// With a bus, a domain module states WHAT happened and stops caring who listens:
//
//     await emit('offer.extended', { applicationId, candidateUserId, roleTitle });
//
// Notifications, audit, search indexing, analytics and sync subscribe independently. Adding a new
// consumer never touches the producer.
//
// DESIGN RULES, learned from the bugs above:
//  1. A failing handler NEVER breaks the emitter and never blocks its siblings. Each runs isolated.
//  2. Failures are recorded, not swallowed. `catch (_) {}` is how the AICTE bug hid for months.
//  3. Handlers are awaited by default so a serverless function does not exit before they finish —
//     fire-and-forget on Vercel means the work is simply killed. Use `background: true` only for
//     work you can genuinely afford to lose.
//
// This is deliberately in-process. A durable cross-process queue is a separate concern; when one
// exists, a single handler can forward events to it without any producer changing.

export type EventName = string;

export interface EventMeta {
  /** Who caused it, when a user did. */
  actorId?: string | null;
  /** Correlates every effect of one action, for tracing. */
  correlationId?: string | null;
  emittedAt: string;
}

export type Handler<P = any> = (payload: P, meta: EventMeta) => void | Promise<void>;

interface Registration {
  name: string;          // handler name, so a failure can be attributed
  fn: Handler;
  background: boolean;
}

const registry = new Map<EventName, Registration[]>();

/** Failures kept in memory for the ops view. Bounded so a broken handler cannot exhaust memory. */
const failures: { event: string; handler: string; error: string; at: string }[] = [];
const MAX_FAILURES = 100;

export interface SubscribeOptions {
  /** Identifies this handler in logs and failure records. Required — "anonymous" is useless at 3am. */
  name: string;
  /**
   * Do not await this handler. Only for work that is genuinely safe to lose: on a serverless
   * platform the function may be frozen the moment the response is sent, so background work is
   * killed mid-flight with no error anywhere.
   */
  background?: boolean;
}

export function on<P = any>(event: EventName, opts: SubscribeOptions, fn: Handler<P>): () => void {
  const list = registry.get(event) || [];
  const reg: Registration = { name: opts.name, fn: fn as Handler, background: !!opts.background };
  list.push(reg);
  registry.set(event, list);
  // Unsubscribe, mainly so tests do not leak handlers between cases.
  return () => {
    const cur = registry.get(event) || [];
    const i = cur.indexOf(reg);
    if (i >= 0) cur.splice(i, 1);
  };
}

export interface EmitResult {
  event: string;
  handled: number;
  failed: { handler: string; error: string }[];
}

/**
 * Publish an event. Resolves once every awaited handler has settled.
 *
 * NEVER throws. A domain action must not fail because something downstream of it did — the offer
 * was still extended even if the notification could not be delivered.
 */
export async function emit<P = any>(
  event: EventName,
  payload: P,
  meta: Partial<EventMeta> = {},
): Promise<EmitResult> {
  const full: EventMeta = {
    actorId: meta.actorId ?? null,
    correlationId: meta.correlationId ?? null,
    emittedAt: new Date().toISOString(),
  };

  const handlers = registry.get(event) || [];
  const result: EmitResult = { event, handled: 0, failed: [] };

  const record = (handlerName: string, e: any) => {
    // Drizzle/postgres surface the real reason in e.cause.message; e.message is just the failed SQL.
    const error = e?.cause?.message || e?.message || String(e);
    result.failed.push({ handler: handlerName, error });
    failures.push({ event, handler: handlerName, error, at: full.emittedAt });
    if (failures.length > MAX_FAILURES) failures.shift();
    console.error(`[events] ${event} -> ${handlerName} failed:`, error);
  };

  await Promise.all(handlers.map(async (h) => {
    // Isolated per handler: one throwing must not prevent its siblings running. This is exactly the
    // failure mode that made a shared try block skip two writes in the catalog import.
    try {
      const r = h.fn(payload, full);
      if (h.background) { Promise.resolve(r).catch((e) => record(h.name, e)); }
      else { await r; }
      result.handled++;
    } catch (e) {
      record(h.name, e);
    }
  }));

  return result;
}

/** Recent handler failures, for an ops screen. Newest last. */
export function recentEventFailures() {
  return [...failures];
}

/** Registered handlers per event — lets an ops view show what is actually wired up. */
export function eventRegistry(): { event: string; handlers: string[] }[] {
  return [...registry.entries()]
    .map(([event, list]) => ({ event, handlers: list.map((h) => h.name) }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

/**
 * The event vocabulary. Kept as a const object rather than loose strings so a typo is a build error
 * instead of an event nobody ever receives — the same class of bug as the 22 unregistered
 * notification types, where a string that looked right silently did nothing.
 */
export const EVENTS = {
  APPLICATION_STARTED: 'application.started',
  APPLICATION_SUBMITTED: 'application.submitted',
  APPLICATION_STATUS_CHANGED: 'application.status_changed',
  OFFER_EXTENDED: 'offer.extended',
  OFFER_SIGNED: 'offer.signed',
  OFFER_DECLINED: 'offer.declined',
  INTERVIEW_SCHEDULED: 'interview.scheduled',
  PAYROLL_PAID: 'payroll.paid',
  ROLE_PUBLISHED: 'role.published',
  KNOWLEDGE_UPDATED: 'knowledge.updated',
  LOCATION_RECORDED: 'location.recorded',
  // Added by HORIZON Patch 01 (src/lib/horizon/intake). Purely additive: nothing that already reads
  // this object changes. Published when something has changed that a derived profile should be
  // rebuilt from — a REQUEST, never an instruction and never a result. The payload carries
  // identifiers only; no personal values travel on the bus.
  PROFILE_RECOMPUTE_REQUESTED: 'profile.recompute_requested',
} as const;

export type KnownEvent = (typeof EVENTS)[keyof typeof EVENTS];
