// src/lib/horizon/concurrency.test.ts — PATCH 19. WHAT HAPPENS WHEN TWO PATCHES TOUCH ONE PERSON.
//
// =================================================================================================
// THE FAILURE THIS SUITE IS LOOKING FOR
// =================================================================================================
//
// HORIZON is a fan-in: an application lands, a task is submitted, an interview finishes, feedback
// arrives, a schedule changes — and every one of those wants to update the SAME employee's record.
// The brief calls for event/idempotency protection and conflict-safe updates, and this is where that
// is checked at the seam rather than inside any one patch.
//
// Three properties, and they are the ones that actually go wrong in a fan-in:
//
//   1. AT-LEAST-ONCE DELIVERY MUST NOT BECOME AT-LEAST-TWICE EFFECT. The envelope carries a stable
//      eventId; a subscriber deduplicates on it. If the id were regenerated on redelivery, every
//      idempotent subscriber in the system would silently stop being idempotent.
//   2. A FAILED OUTBOX WRITE MUST NOT ROLL BACK A COMMITTED FACT. A hire that happened, happened.
//      The honest outcome is a tracked delivery gap, not an exception thrown into the hire.
//   3. A POISON EVENT MUST STOP. Without a ceiling, one malformed payload occupies the drain forever
//      and every other person's updates queue behind it.
//
// EVERYTHING HERE RUNS AGAINST memoryEventSink(). No database, no clock dependency, no ordering
// assumption that a real queue would not honour.
import { describe, it, expect } from 'vitest';

import {
  buildEvent,
  validateEnvelope,
  emitHorizonEvent,
  memoryEventSink,
  horizonTopic,
  isHorizonEventName,
  HORIZON_EVENTS,
  HORIZON_EVENT_NAMES,
  HORIZON_EVENT_VERSION,
  HORIZON_TOPIC_PREFIX,
  MAX_DELIVERY_ATTEMPTS,
  type HorizonEventSink,
} from '@/lib/horizon/events';

import { employeeSubject, SYSTEM_ACTOR, DEFAULT_ORGANISATION_ID } from '@/lib/horizon/ids';
import { ensureOnce } from '@/lib/ensure-once';

// -------------------------------------------------------------------------------------------------
// FIXTURES
// -------------------------------------------------------------------------------------------------

// The subject and the actor are built through the OWNING module's constructors rather than typed
// out here. A hand-written SubjectRef missing `idScheme` is refused by validateEnvelope, and a test
// fixture that quietly diverges from the real shape tests nothing at all.
const inputFor = (over: Record<string, any> = {}) =>
  ({
    type: HORIZON_EVENTS.PROFILE_RECOMPUTE_REQUESTED,
    organisationId: DEFAULT_ORGANISATION_ID,
    subject: employeeSubject('11111111-1111-4111-8111-111111111111'),
    actor: SYSTEM_ACTOR,
    payload: { reason: 'test' },
    ...over,
  }) as any;

/** A sink that refuses every write, to drive the "committed fact, failed outbox" path. */
const failingSink = (): HorizonEventSink => ({
  async record() { return { ok: false, error: 'outbox unavailable' }; },
  async claim() { return []; },
  async markDelivered() { return { ok: true }; },
  async markFailed() { return { ok: true }; },
});

// -------------------------------------------------------------------------------------------------
// THE ENVELOPE IS THE CONTRACT BETWEEN EVERY PATCH
// -------------------------------------------------------------------------------------------------

describe('the event envelope carries what a subscriber needs to be idempotent', () => {
  it('builds an envelope that validates', () => {
    const built = buildEvent(inputFor());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateEnvelope(built.envelope).ok).toBe(true);
  });

  it('gives every event a distinct id, so two facts are never collapsed into one', () => {
    // Two recompute requests for the SAME employee are two facts. If they shared an id, a
    // deduplicating subscriber would drop the second — which is the update that gets lost.
    const a = buildEvent(inputFor());
    const b = buildEvent(inputFor());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.envelope.eventId).not.toBe(b.envelope.eventId);
  });

  it('refuses an envelope with no id, and says the id is the deduplication key', () => {
    const built = buildEvent(inputFor());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const broken = { ...built.envelope, eventId: '' };
    const v = validateEnvelope(broken);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ').toLowerCase()).toContain('deduplication');
  });

  it('stamps a version, so a subscriber can refuse a shape it does not know', () => {
    const built = buildEvent(inputFor());
    if (!built.ok) return;
    expect(built.envelope.version).toBe(HORIZON_EVENT_VERSION);
  });

  it('namespaces every topic, so a HORIZON event cannot be mistaken for another bus event', () => {
    for (const name of HORIZON_EVENT_NAMES) {
      expect(horizonTopic(name).startsWith(HORIZON_TOPIC_PREFIX)).toBe(true);
      expect(isHorizonEventName(name)).toBe(true);
    }
    expect(isHorizonEventName('horizon.not.a.real.event')).toBe(false);
    expect(isHorizonEventName(null)).toBe(false);
  });

  it('never repeats one event name under two keys', () => {
    // Two keys for one name means two patches think they own it, and one of them is wrong.
    expect(new Set(HORIZON_EVENT_NAMES).size).toBe(HORIZON_EVENT_NAMES.length);
  });
});

// -------------------------------------------------------------------------------------------------
// THE OUTBOX UNDER CONCURRENCY
// -------------------------------------------------------------------------------------------------

describe('many patches emitting about one person at once', () => {
  it('records every concurrent emit, losing none', () => {
    const sink = memoryEventSink();
    const N = 25;
    return Promise.all(
      Array.from({ length: N }, (_, i) => emitHorizonEvent(inputFor({ payload: { reason: 'r' + i } }), sink)),
    ).then((outcomes) => {
      expect(outcomes.every((o) => o.ok)).toBe(true);
      expect(sink.all().length).toBe(N);
      // Every one of them is separately addressable.
      expect(new Set(sink.all().map((e) => e.eventId)).size).toBe(N);
    });
  });

  it('claims each undelivered event exactly once per claim call, up to the limit', () => {
    const sink = memoryEventSink();
    return Promise.all([
      emitHorizonEvent(inputFor(), sink),
      emitHorizonEvent(inputFor(), sink),
      emitHorizonEvent(inputFor(), sink),
    ]).then(async () => {
      const first = await sink.claim(2);
      expect(first.length).toBe(2);
      // Nothing has been marked delivered yet, so a second claim sees the same work plus the rest.
      // THIS IS THE HONEST BEHAVIOUR OF AN IN-MEMORY SINK and is asserted rather than assumed: the
      // postgres sink uses FOR UPDATE SKIP LOCKED so two drains take disjoint sets, and the memory
      // sink does NOT — a test that relied on disjointness here would be testing a fiction.
      const second = await sink.claim(3);
      expect(second.length).toBe(3);
    });
  });

  it('stops claiming an event once it is delivered, so redelivery is bounded', () => {
    const sink = memoryEventSink();
    return emitHorizonEvent(inputFor(), sink).then(async (out) => {
      expect(out.eventId).toBeTruthy();
      const claimed = await sink.claim(10);
      expect(claimed.length).toBe(1);
      await sink.markDelivered(out.eventId as string);
      expect((await sink.claim(10)).length).toBe(0);
    });
  });

  it('stops claiming a poison event at the delivery ceiling', () => {
    // Without this, one malformed payload occupies the drain forever and every other person's
    // updates queue behind it.
    const sink = memoryEventSink();
    return emitHorizonEvent(inputFor(), sink).then(async (out) => {
      const id = out.eventId as string;
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
        const claimed = await sink.claim(10);
        if (!claimed.length) break;
        await sink.markFailed(id, 'handler exploded');
      }
      expect((await sink.claim(10)).length).toBe(0);
      expect(MAX_DELIVERY_ATTEMPTS > 0).toBe(true);
    });
  });
});

describe('a failed outbox write is a tracked gap, never a rolled-back fact', () => {
  it('returns ok:false and recorded:false instead of throwing into the caller', async () => {
    const out = await emitHorizonEvent(inputFor(), failingSink());
    expect(out.ok).toBe(false);
    expect(out.recorded).toBe(false);
    // The id still comes back, so the caller can record WHICH fact lost its event.
    expect(out.eventId).toBeTruthy();
    expect(out.errors.length > 0).toBe(true);
  });

  it('refuses an invalid envelope WITHOUT recording it, and says so differently', () => {
    // A rejected envelope is a programming error in the caller. A failed write is infrastructure.
    // Collapsing the two would send somebody to the wrong system at the wrong hour.
    const sink = memoryEventSink();
    return emitHorizonEvent(inputFor({ type: 'not.a.horizon.event' }), sink).then((out) => {
      expect(out.ok).toBe(false);
      expect(out.recorded).toBe(false);
      expect(out.eventId).toBeNull();
      expect(sink.all().length).toBe(0);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// THE OTHER SHARED CONCURRENCY PRIMITIVE: ONE BOOTSTRAP PER PROCESS
// -------------------------------------------------------------------------------------------------

describe('schema bootstrap runs once per key however many callers race for it', () => {
  it('runs the work once for concurrent callers on a cold key', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const key = 'horizon-patch19-concurrency-' + Math.floor(performance.now()) + '-a';

    const work = async () => { runs++; await gate; };
    const all = Promise.all([ensureOnce(key, work), ensureOnce(key, work), ensureOnce(key, work)]);
    release();
    await all;
    expect(runs).toBe(1);
  });

  it('does NOT cache a failure, so a transient fault cannot poison the process', async () => {
    let runs = 0;
    const key = 'horizon-patch19-concurrency-' + Math.floor(performance.now()) + '-b';
    const failing = async () => { runs++; throw new Error('transient'); };

    await ensureOnce(key, failing);
    await ensureOnce(key, failing);
    expect(runs).toBe(2);
  });

  it('swallows the failure rather than throwing into a caller that tolerates a missing table', async () => {
    const key = 'horizon-patch19-concurrency-' + Math.floor(performance.now()) + '-c';
    await expect(ensureOnce(key, async () => { throw new Error('boom'); })).resolves.toBeUndefined();
  });
});
