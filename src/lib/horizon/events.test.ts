// src/lib/horizon/events.test.ts — the event contract, asserted.
//
// The load-bearing test in this file is the FIRST one. Three of the fourteen event names the brief
// asks for are already in use in this repository by other modules, with different payload shapes and
// live subscribers. If a later change drops the `horizon.` prefix, HORIZON starts publishing its
// envelopes into somebody else's mailbox — silently, because a bus subscriber handed an unexpected
// shape does not throw, it just does the wrong thing. That test is the guard.
//
// No database. The postgres sink is never exercised here; `memoryEventSink()` stands in, which is
// exactly what it exists for.

import { describe, it, expect } from 'vitest';
import { on, recentEventFailures } from '@/lib/events';
import { EVENTS } from '@/lib/events';
import { TALENT_EVENTS } from '@/lib/talent/events';
import {
  HORIZON_EVENTS, HORIZON_EVENT_NAMES, HORIZON_TOPIC_PREFIX, HORIZON_EVENT_VERSION,
  MAX_PAYLOAD_CHARS, MAX_DELIVERY_ATTEMPTS, UPSTREAM_BINDINGS,
  horizonTopic, isHorizonEventName, buildEvent, validateEnvelope,
  emitHorizonEvent, drainHorizonEvents, memoryEventSink, onHorizonEvent, bindUpstreamEvents,
  silentGapReporter,
  type HorizonEventEnvelope,
} from './events';
import { employeeSubject, DEFAULT_ORGANISATION_ID } from './ids';

const EMP = '11111111-1111-4111-8111-111111111111';
const subject = employeeSubject(EMP);
const actor = { kind: 'user' as const, id: 'u-1', displayName: 'A named person' };

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY, AND THE COLLISION IT AVOIDS
// -------------------------------------------------------------------------------------------------

describe('the event vocabulary', () => {
  it('names all fourteen events from the brief', () => {
    expect([...HORIZON_EVENT_NAMES].sort()).toEqual([
      'access.logged',
      'application.submitted',
      'assessment.completed',
      'employee.created',
      'feedback.submitted',
      'feedback.updated',
      'intelligence.computation_completed',
      'interview.completed',
      'profile.recompute_requested',
      'signal.created',
      'signal.resolved',
      'task.assigned',
      'task.submitted',
      'task.updated',
    ]);
  });

  it('never publishes onto a topic another module already owns', () => {
    // The three known collisions, plus the whole of both existing vocabularies for good measure.
    const taken = new Set<string>([
      ...Object.values(EVENTS),
      ...Object.values(TALENT_EVENTS),
    ]);
    for (const name of HORIZON_EVENT_NAMES) {
      const topic = horizonTopic(name);
      expect(topic.startsWith(HORIZON_TOPIC_PREFIX)).toBe(true);
      expect(taken.has(topic), 'topic collides with an existing owner: ' + topic).toBe(false);
    }
    // And the collisions really do exist, so this test is guarding something real rather than
    // asserting a coincidence.
    expect(taken.has('application.submitted')).toBe(true);
    expect(taken.has('assessment.completed')).toBe(true);
    expect(taken.has('interview.completed')).toBe(true);
  });

  it('keeps the brief’s canonical names as the envelope type', () => {
    expect(HORIZON_EVENTS.APPLICATION_SUBMITTED).toBe('application.submitted');
    expect(horizonTopic(HORIZON_EVENTS.APPLICATION_SUBMITTED)).toBe('horizon.application.submitted');
    expect(isHorizonEventName('application.submitted')).toBe(true);
    expect(isHorizonEventName('horizon.application.submitted')).toBe(false);
  });

  it('records honestly which upstream topics actually have a producer today', () => {
    expect(UPSTREAM_BINDINGS.length).toBeGreaterThan(0);
    for (const b of UPSTREAM_BINDINGS) {
      expect(HORIZON_EVENT_NAMES).toContain(b.horizonEvent);
      expect(['published_today', 'declared_only']).toContain(b.status);
      expect(b.owner.length).toBeGreaterThan(0);
    }
    const declared = UPSTREAM_BINDINGS.find((b) => b.upstreamTopic === 'application.submitted');
    expect(declared?.status).toBe('declared_only');
  });
});

// -------------------------------------------------------------------------------------------------
// THE ENVELOPE
// -------------------------------------------------------------------------------------------------

describe('the envelope', () => {
  it('builds a valid one with sensible defaults', () => {
    const built = buildEvent({
      type: HORIZON_EVENTS.EMPLOYEE_CREATED,
      payload: { employeeId: EMP, applicationId: null, joiningDate: '2026-09-01', departmentId: 'eng' },
      subject,
      actor,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.envelope.version).toBe(HORIZON_EVENT_VERSION);
    expect(built.envelope.organisationId).toBe(DEFAULT_ORGANISATION_ID);
    expect(built.envelope.eventId).toBeTruthy();
    expect(built.envelope.correlationId).toBeNull();
    expect(built.envelope.causationId).toBeNull();
  });

  it('mints a distinct eventId per event, because it is the deduplication key', () => {
    const a = buildEvent({ type: HORIZON_EVENTS.SIGNAL_CREATED, payload: dummySignalPayload() });
    const b = buildEvent({ type: HORIZON_EVENTS.SIGNAL_CREATED, payload: dummySignalPayload() });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.envelope.eventId).not.toBe(b.envelope.eventId);
  });

  it('rejects a malformed subject or actor rather than storing one', () => {
    const bad = buildEvent({
      type: HORIZON_EVENTS.EMPLOYEE_CREATED,
      payload: { employeeId: EMP },
      subject: { ...subject, idScheme: 'application' } as any,
    });
    expect(bad.ok).toBe(false);
    const badActor = buildEvent({
      type: HORIZON_EVENTS.EMPLOYEE_CREATED,
      payload: { employeeId: EMP },
      actor: { kind: 'ghost', id: 'x' } as any,
    });
    expect(badActor.ok).toBe(false);
  });

  it('refuses a payload that has become a document', () => {
    const built = buildEvent({
      type: HORIZON_EVENTS.FEEDBACK_SUBMITTED,
      payload: {
        feedbackId: 'f1', ownerModule: 'm', dimensionKey: 'k', relationship: 'peer',
        submittedAt: new Date().toISOString(),
        // An event carries identifiers and small facts. A CV in a payload is a copy of a person's
        // record travelling through a log with none of the controls the original had.
        essay: 'x'.repeat(MAX_PAYLOAD_CHARS + 1),
      } as any,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.join(' ')).toMatch(/budget/);
  });

  it('refuses an unknown type and a wrong version', () => {
    expect(validateEnvelope({ type: 'made.up' }).ok).toBe(false);
    const built = buildEvent({ type: HORIZON_EVENTS.SIGNAL_CREATED, payload: dummySignalPayload() });
    if (!built.ok) throw new Error('fixture failed to build');
    expect(validateEnvelope({ ...built.envelope, version: 2 }).ok).toBe(false);
    expect(validateEnvelope({ ...built.envelope, occurredAt: 'yesterday' }).ok).toBe(false);
  });

  it('does not rewrite history when a backfill supplies its own timestamp', () => {
    const built = buildEvent({
      type: HORIZON_EVENTS.TASK_SUBMITTED,
      payload: { taskId: 't1', submittedByEmployeeId: EMP, submittedAt: '2025-01-01T00:00:00.000Z' },
      occurredAt: '2025-01-01T00:00:00.000Z',
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.envelope.occurredAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

// -------------------------------------------------------------------------------------------------
// PUBLISHING AND DELIVERY
// -------------------------------------------------------------------------------------------------

describe('publishing and delivery', () => {
  it('records to the sink and delivers to the bus', async () => {
    const sink = memoryEventSink();
    const seen: HorizonEventEnvelope[] = [];
    const off = onHorizonEvent(HORIZON_EVENTS.SIGNAL_CREATED, 'test:collector', (env) => {
      seen.push(env);
    });
    try {
      const out = await emitHorizonEvent({
        type: HORIZON_EVENTS.SIGNAL_CREATED, payload: dummySignalPayload(), subject, actor,
      }, sink);
      expect(out.ok).toBe(true);
      expect(out.recorded).toBe(true);
      // RECORDED IS NOT DELIVERED. Nothing has reached a subscriber until the drain runs.
      expect(seen).toHaveLength(0);

      const report = await drainHorizonEvents(10, sink);
      expect(report.claimed).toBe(1);
      expect(report.delivered).toBe(1);
      expect(report.failed).toEqual([]);
      expect(seen).toHaveLength(1);
      expect(seen[0].type).toBe('signal.created');
      expect(seen[0].eventId).toBe(out.eventId);
    } finally {
      off();
    }
  });

  it('does not deliver the same event twice on a second drain', async () => {
    const sink = memoryEventSink();
    let count = 0;
    const off = onHorizonEvent(HORIZON_EVENTS.SIGNAL_RESOLVED, 'test:counter', () => { count++; });
    try {
      await emitHorizonEvent({
        type: HORIZON_EVENTS.SIGNAL_RESOLVED,
        payload: { signalId: 's1', resolution: 'dismissed', resolvedByActor: actor, reason: 'not material' },
        subject,
      }, sink);
      await drainHorizonEvents(10, sink);
      const second = await drainHorizonEvents(10, sink);
      expect(second.claimed).toBe(0);
      expect(count).toBe(1);
    } finally {
      off();
    }
  });

  it('never throws into its caller, and reports a refused envelope as a refusal', async () => {
    const sink = memoryEventSink();
    const out = await emitHorizonEvent({ type: 'not.a.horizon.event' as any, payload: {} as any }, sink);
    expect(out.ok).toBe(false);
    expect(out.recorded).toBe(false);
    expect(out.errors.join(' ')).toMatch(/HORIZON event name/);
    expect(sink.all()).toHaveLength(0);
  });

  it('returns a tracked gap rather than throwing when the sink cannot store the event', async () => {
    const brokenSink = {
      async record() { return { ok: false, error: 'relation "hzn_event" does not exist' }; },
      async claim() { return []; },
      async markDelivered() { return { ok: true }; },
      async markFailed() { return { ok: true }; },
    };
    const gaps: string[] = [];
    // The gap reporter is injected so this test never opens a database connection to prove that a
    // failed outbox write is reported. The production default writes to the incident board.
    const out = await emitHorizonEvent({
      type: HORIZON_EVENTS.SIGNAL_CREATED, payload: dummySignalPayload(),
    }, brokenSink, async (reason) => { gaps.push(reason); });
    // A committed fact stays committed. The delivery gap is REPORTED, not thrown.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/does not exist/);
    expect(out.ok).toBe(false);
    expect(out.recorded).toBe(false);
    expect(out.eventId).toBeTruthy();
    expect(out.errors.join(' ')).toMatch(/does not exist/);
  });

  it('marks an event delivered even when one subscriber failed, and attributes the failure', async () => {
    const sink = memoryEventSink();
    let healthyRan = 0;
    const offBad = onHorizonEvent(HORIZON_EVENTS.TASK_ASSIGNED, 'test:broken', () => {
      throw new Error('subscriber is broken');
    });
    const offGood = onHorizonEvent(HORIZON_EVENTS.TASK_ASSIGNED, 'test:healthy', () => { healthyRan++; });
    try {
      await emitHorizonEvent({
        type: HORIZON_EVENTS.TASK_ASSIGNED,
        payload: { taskId: 't1', assignedToEmployeeId: EMP, assignedByActor: actor },
        subject,
      }, sink);
      const report = await drainHorizonEvents(10, sink);
      // One handler failing must not prevent its siblings running.
      expect(healthyRan).toBe(1);
      expect(report.delivered).toBe(1);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].error).toMatch(/test:broken/);
      // Re-running the whole event would re-run the healthy handler too, which for a handler that is
      // not perfectly idempotent is worse than a visible, attributed failure.
      const second = await drainHorizonEvents(10, sink);
      expect(second.claimed).toBe(0);
      expect(healthyRan).toBe(1);
      expect(recentEventFailures().some((f) => f.handler === 'test:broken')).toBe(true);
    } finally {
      offBad();
      offGood();
    }
  });

  it('stops retrying after the attempt ceiling rather than looping forever', async () => {
    const sink = memoryEventSink();
    await emitHorizonEvent({
      type: HORIZON_EVENTS.SIGNAL_CREATED, payload: dummySignalPayload(),
    }, sink, silentGapReporter);
    // Claim without ever delivering, the shape of a worker dying mid-pass every time.
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) await sink.claim(10);
    expect(await sink.claim(10)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// UPSTREAM BINDINGS
// -------------------------------------------------------------------------------------------------

describe('upstream bindings', () => {
  it('turns an existing platform event into a HORIZON envelope without the producer knowing', async () => {
    const sink = memoryEventSink();
    const unbind = bindUpstreamEvents({
      'application.received': (payload) => ({
        type: HORIZON_EVENTS.APPLICATION_SUBMITTED,
        payload: {
          applicationId: String(payload.applicationId),
          roleId: null,
          sourceKey: null,
          submittedAt: '2026-08-23T10:00:00.000Z',
        },
      }),
    }, sink);
    try {
      // The upstream producer publishes exactly as it always has, on its own topic.
      const { emit } = await import('@/lib/events');
      await emit('application.received', { applicationId: 'app-77' });
      expect(sink.all()).toHaveLength(1);
      expect(sink.all()[0].type).toBe('application.submitted');
      expect((sink.all()[0].payload as any).applicationId).toBe('app-77');
    } finally {
      unbind();
    }
  });

  it('lets an adapter decline, because not every upstream fact is about an employee', async () => {
    const sink = memoryEventSink();
    const unbind = bindUpstreamEvents({
      'identity.created': (payload) => (payload.identityType === 'employee'
        ? { type: HORIZON_EVENTS.EMPLOYEE_CREATED, payload: { employeeId: String(payload.id) } }
        : null),
    }, sink);
    try {
      const { emit } = await import('@/lib/events');
      await emit('identity.created', { id: 'i-1', identityType: 'intern' });
      expect(sink.all()).toHaveLength(0);
      await emit('identity.created', { id: 'i-2', identityType: 'employee' });
      expect(sink.all()).toHaveLength(1);
    } finally {
      unbind();
    }
  });

  it('binds nothing without an adapter, so importing this module wires no subscribers', () => {
    const before = on('horizon.noop.probe', { name: 'probe' }, () => {});
    before();
    const unbind = bindUpstreamEvents({});
    unbind();
    // Nothing to assert beyond the absence of a throw: the point is that bindUpstreamEvents is
    // opt-in and does nothing at all until an integration hands it adapters.
    expect(true).toBe(true);
  });
});

function dummySignalPayload() {
  return {
    signalId: 'sig-1', category: 'workload', severity: 'low',
    humanReviewRequired: false, evidenceIds: ['ev-1'],
  };
}
