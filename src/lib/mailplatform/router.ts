// src/lib/mailplatform/router.ts — EVENTS IN, RUNS OUT. The only way anything starts.
//
// Every door — the admin API, platform code announcing a stage change, a signed webhook, the
// scheduler, and an action inside another automation — comes through ingestEvent(). One path means
// one place where idempotency, tenant scoping and the chain-depth limit are enforced, instead of
// four places where three of them are.
//
// THE ORDER IS DELIBERATE AND IT IS THE IDEMPOTENCY GUARANTEE:
//
//   1. Record the event, keyed on its id. A second delivery of the same id returns stored:false and
//      this function stops. Nothing after this line runs twice for one event.
//   2. Find the ACTIVE automations and match each one's trigger node.
//   3. Create a run — idempotent on (automation, event), so even if step 1's guard were somehow
//      bypassed, one event still cannot start two runs of one automation.
//
// The event id is therefore the single most important field an integration sends. A sender that
// generates a fresh id per RETRY has no idempotency, and the honest place to say so is the
// documentation and the webhook error message, not a comment nobody reads.
import type { AutomationStore, RunRecord } from './store';
import { normalizeEmail } from './store';
import type { IncomingEvent } from './triggers';
import { canonicalEventType, eventMatchesTrigger, factsFor, isUsableEventType } from './triggers';
import { triggerNode } from './graph';
import { advanceRun, contactFacts, type AdvanceReport, type EngineDeps } from './engine';
import { newEventId, newRunId } from './security';
import { reasonOf } from './errors';

/**
 * How many times an event may cause an event may cause an event.
 *
 * Automation A tags a contact; the tag starts automation B; B updates the contact; the update starts
 * A again. Cycles BETWEEN automations are not detectable at authoring time the way a cycle inside
 * one graph is (validateGraph refuses those), so the chain is bounded at runtime. Five is deep
 * enough for any real design and short enough that a mistake costs five events rather than a mailbox.
 */
export const MAX_CHAIN_DEPTH = 5;

export interface IngestOptions extends EngineDeps {
  /** Advance the runs this event started, in this call. Off for a bulk import, where the worker
   *  should do the work rather than the request holding somebody's browser open. */
  advance?: boolean;
  depth?: number;
}

export interface IngestReport {
  eventId: string;
  accepted: boolean;
  /** True when this exact event had already been recorded. Nothing was done, and that is correct. */
  duplicate: boolean;
  startedRuns: string[];
  /** One line per candidate automation saying why it did or did not start. This is what makes "my
   *  automation did not fire" answerable without reading the code. */
  decisions: Array<{ automationId: string; name: string; started: boolean; reason: string }>;
  advanced: AdvanceReport[];
  error: string | null;
}

/** Build an IncomingEvent, filling in the parts a caller should not have to. */
export function makeEvent(input: {
  type: string;
  orgId: string;
  contactId?: string | null;
  payload?: Record<string, unknown>;
  source?: IncomingEvent['source'];
  eventId?: string | null;
  occurredAt?: Date;
}): IncomingEvent {
  return {
    eventId: String(input.eventId || newEventId()).slice(0, 128),
    // Stored canonically, so the six underscored keys the canvas already wrote and the dotted names
    // everything else uses are ONE type in the log and one thing to query for.
    type: canonicalEventType(input.type),
    orgId: input.orgId,
    contactId: input.contactId || null,
    payload: input.payload || {},
    source: input.source || 'internal',
    occurredAt: input.occurredAt || new Date(),
  };
}

export async function ingestEvent(deps: IngestOptions, event: IncomingEvent): Promise<IngestReport> {
  const store = deps.store;
  const now = deps.now || (() => new Date());
  const depth = deps.depth || 0;
  const report: IngestReport = { eventId: event.eventId, accepted: false, duplicate: false, startedRuns: [], decisions: [], advanced: [], error: null };

  if (!event.orgId) { report.error = 'The event names no organisation.'; return report; }
  if (!isUsableEventType(event.type)) {
    report.error = '"' + String(event.type).slice(0, 80) + '" is not a usable event type. Use a dotted lower-case name, e.g. application.stage.changed.';
    return report;
  }

  // 1. THE IDEMPOTENCY GATE.
  const recorded = await store.recordEvent(event);
  report.accepted = true;
  if (!recorded.stored) {
    report.duplicate = true;
    return report;   // Already handled. Not an error, and nothing further happens.
  }

  if (depth >= MAX_CHAIN_DEPTH) {
    const msg = 'This event was ' + depth + ' links deep in a chain of automations triggering one another, which is the limit. It was recorded but started nothing — check for two automations that trigger each other.';
    console.error('[mailplatform/router] chain depth limit reached for ' + event.type + ' (' + event.eventId + ')');
    await store.markEventProcessed(event.eventId, 0, msg);
    report.error = msg;
    return report;
  }

  try {
    const contact = event.contactId ? await store.getContact(event.contactId) : null;
    const facts = factsFor(event, contact ? contactFacts(contact) : null);

    // EVERY ACTIVE AUTOMATION, MATCHED IN CODE. Not an indexed lookup on a denormalised trigger
    // column: the canvas writes `graph` through its own saveAutomation() and would not know to keep
    // such a column in step, so it would go stale and the router would silently stop starting runs.
    const candidates = await store.activeAutomations(event.orgId);

    for (const a of candidates) {
      const trigger = triggerNode(a.graph);
      if (!trigger) {
        report.decisions.push({ automationId: a.id, name: a.name, started: false, reason: 'it has no trigger step' });
        continue;
      }
      const spec = { event: String((trigger.config || {}).event || ''), filter: (trigger.config || {}).filter as any };
      const match = eventMatchesTrigger(event, spec, facts);
      if (!match.matches) {
        report.decisions.push({ automationId: a.id, name: a.name, started: false, reason: match.reason });
        continue;
      }

      const run: RunRecord = {
        runId: newRunId(),
        automationId: a.id,
        graphVersion: a.version,
        orgId: event.orgId,
        contactId: event.contactId,
        currentNode: trigger.id,
        state: 'running',
        waitUntil: null,
        // The event is FROZEN here. Conditions asking about it get the same answer in a week.
        context: { event: { id: event.eventId, type: event.type, source: event.source, occurred_at: event.occurredAt.toISOString(), ...event.payload }, facts },
        startedAt: now(),
        updatedAt: now(),
        completedAt: null,
        error: null,
        errorKind: null,
        retryCount: 0,
        deadLetter: false,
        triggerEventId: event.eventId,
      };
      const created = await store.createRun(run);
      if (!created.created) {
        report.decisions.push({ automationId: a.id, name: a.name, started: false, reason: 'this event had already started run ' + created.run.runId });
        continue;
      }
      report.startedRuns.push(created.run.runId);
      report.decisions.push({ automationId: a.id, name: a.name, started: true, reason: 'started run ' + created.run.runId });
    }

    await store.markEventProcessed(event.eventId, report.startedRuns.length, null);

    if (deps.advance !== false) {
      for (const runId of report.startedRuns) {
        const fresh = await store.getRun(event.orgId, runId);
        if (fresh) report.advanced.push(await advanceRun(withPublisher(deps, depth), fresh));
      }
    }
  } catch (e: any) {
    report.error = reasonOf(e);
    console.error('[mailplatform/router] ' + event.type + ' (' + event.eventId + ') failed:', report.error);
    await store.markEventProcessed(event.eventId, report.startedRuns.length, report.error).catch(() => {});
  }
  return report;
}

/**
 * Wire the engine's follow-on events back into this router, one link deeper.
 *
 * This is the whole of "generic event support": an action emitting internship.selected is
 * indistinguishable, from here down, from an outside system posting it. Same idempotency, same
 * tenant scoping, same depth counter.
 */
export function withPublisher(deps: EngineDeps, depth = 0): EngineDeps {
  return {
    ...deps,
    publish: async (e) => {
      await ingestEvent(
        { ...deps, depth: depth + 1, advance: true },
        makeEvent({ type: e.type, orgId: e.orgId, contactId: e.contactId, payload: { ...e.payload, caused_by_run: e.causedByRunId }, source: 'internal' }),
      );
    },
  };
}

/**
 * Announce something that happened, from anywhere in the platform.
 *
 *   await emit(pgStore, { type: 'application.stage.changed', orgId: ORG_ID,
 *                         contactEmail: 'x@y.z', payload: { stage: '3' } })
 *
 * Takes an EMAIL rather than a contact id, because the code that knows an application moved to
 * stage 3 knows the applicant's address and has no reason to know about a mail contact row. The
 * contact is created on first sight, which is also how "Contact added" gets its trigger.
 */
export async function emit(
  store: AutomationStore,
  input: {
    type: string;
    orgId: string;
    contactEmail?: string | null;
    contactId?: string | null;
    contact?: { firstName?: string; lastName?: string; organization?: string; phone?: string; roleTitle?: string; fields?: Record<string, unknown> };
    payload?: Record<string, unknown>;
    eventId?: string | null;
    source?: IncomingEvent['source'];
  },
  deps: Partial<IngestOptions> = {},
): Promise<IngestReport> {
  let contactId = input.contactId || null;
  const created: string[] = [];
  if (!contactId && input.contactEmail) {
    const email = normalizeEmail(input.contactEmail);
    const existing = await store.findContactByEmail(email);
    const c = await store.upsertContact({ email, ...(input.contact || {}) });
    contactId = c.id;
    if (!existing) created.push(c.id);
  }

  // A brand new contact announces itself FIRST, so a "contact added" automation starts before the
  // event that produced them. Both events are recorded either way; only the order is chosen.
  for (const id of created) {
    await ingestEvent({ store, ...deps, advance: deps.advance !== false } as IngestOptions,
      makeEvent({ type: 'contact.created', orgId: input.orgId, contactId: id, source: input.source || 'internal' }));
  }

  return ingestEvent(
    { store, ...deps, advance: deps.advance !== false } as IngestOptions,
    makeEvent({ type: input.type, orgId: input.orgId, contactId, payload: input.payload, eventId: input.eventId, source: input.source || 'internal' }),
  );
}
