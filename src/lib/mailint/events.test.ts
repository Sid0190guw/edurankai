// src/lib/mailint/events.test.ts — the event vocabulary and the duplicate promise.
//
// Section 14 of the brief asks for tests of duplicate events and event transformation. The duplicate
// half lives here, at its root: two callers describing the SAME fact must derive the SAME key, and
// two callers describing different facts must not. Everything downstream — the unique index, the
// "nothing ran twice" guarantee, the candidate who does not get two rejection emails — rests on that
// one function agreeing with itself.
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_EVENTS,
  allEventTypes,
  canonicalEventType,
  deriveIdempotencyKey,
  eventDescriptor,
  matchesAnyPattern,
  matchesPattern,
  sampleEvent,
  stableStringify,
  suggestEventType,
  validateEvent,
  validatePattern,
  webhookBody,
} from './events';

describe('the catalogue', () => {
  it('has no duplicate types', () => {
    const seen = new Set<string>();
    for (const e of CANONICAL_EVENTS) {
      expect(seen.has(e.type), e.type + ' appears twice').toBe(false);
      seen.add(e.type);
    }
  });

  it('names every type as lowercase dot-separated segments', () => {
    for (const t of allEventTypes()) expect(t).toMatch(/^[a-z0-9]+(\.[a-z0-9_]+)+$/);
  });

  it('gives every event at least one channel it may drive', () => {
    for (const e of CANONICAL_EVENTS) expect(e.channels.length).toBeGreaterThan(0);
  });

  it('marks the events that carry a judgement about a person as sensitive', () => {
    // Not a style preference: routing.ts redacts on this flag, so an unmarked rejection reason would
    // reach third-party endpoints.
    expect(eventDescriptor('candidate.rejected')?.sensitive).toBe(true);
    expect(eventDescriptor('assessment.completed')?.sensitive).toBe(true);
    expect(eventDescriptor('application.created')?.sensitive).toBeFalsy();
  });

  it('resolves a deprecated alias instead of breaking stored filters', () => {
    expect(canonicalEventType('application.stage_changed')).toBe('application.stage.changed');
    expect(canonicalEventType('candidate.hired')).toBe('candidate.selected');
    expect(eventDescriptor('application.stage_changed')?.type).toBe('application.stage.changed');
  });

  it('suggests the near miss for a typo', () => {
    expect(suggestEventType('application.stage.change')).toBe('application.stage.changed');
    expect(suggestEventType('completely.unrelated.nonsense')).toBeNull();
  });
});

describe('pattern matching', () => {
  it('matches exactly', () => {
    expect(matchesPattern('application.created', 'application.created')).toBe(true);
    expect(matchesPattern('application.created', 'application.updated')).toBe(false);
  });

  it('lets a trailing star cover any depth — the rule everybody assumes', () => {
    // The deviation from strict glob semantics, asserted because it is the whole reason the rule
    // exists: `application.*` typed in a filter box must include application.stage.changed.
    expect(matchesPattern('application.stage.changed', 'application.*')).toBe(true);
    expect(matchesPattern('application.created', 'application.*')).toBe(true);
    expect(matchesPattern('candidate.selected', 'application.*')).toBe(false);
  });

  it('treats an interior star as exactly one segment', () => {
    expect(matchesPattern('application.stage.changed', 'application.*.changed')).toBe(true);
    expect(matchesPattern('application.created', 'application.*.changed')).toBe(false);
  });

  it('matches everything with *', () => {
    for (const t of allEventTypes()) expect(matchesPattern(t, '*')).toBe(true);
  });

  it('treats an empty subscription as NOTHING, never as everything', () => {
    // The opposite default would mean adding an event type to the catalogue silently starts sending
    // it to every endpoint that ever left the field blank.
    expect(matchesAnyPattern('application.created', [])).toBe(false);
    expect(matchesAnyPattern('application.created', null)).toBe(false);
    expect(matchesAnyPattern('application.created', ['application.*'])).toBe(true);
  });

  it('refuses to store a filter that can never match', () => {
    expect(validatePattern('application.*').ok).toBe(true);
    expect(validatePattern('*').ok).toBe(true);
    expect(validatePattern('applicaton.*').ok).toBe(false);       // typo: matches nothing
    expect(validatePattern('').ok).toBe(false);
    expect(validatePattern('application; drop table').ok).toBe(false);
  });
});

describe('validation', () => {
  const now = Date.parse('2026-08-16T10:00:00.000Z');

  it('refuses an unknown type and suggests the near miss', () => {
    const r = validateEvent({ orgId: 'o1', type: 'application.stage.change', source: 'careers', payload: {} }, now);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('application.stage.changed');
  });

  it('names the missing field rather than failing vaguely', () => {
    const r = validateEvent({ orgId: 'o1', type: 'application.stage.changed', source: 'careers', payload: { application_id: 'a1' } }, now);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('payload.stage is required');
  });

  it('requires an organisation', () => {
    const r = validateEvent({ type: 'application.created', source: 'careers', payload: { application_id: 'a', email: 'x@y.com' } }, now);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('orgId');
  });

  it('refuses a timestamp from the future rather than clamping it', () => {
    const r = validateEvent({
      orgId: 'o1', type: 'application.created', source: 'careers',
      payload: { application_id: 'a', email: 'x@y.com' },
      occurredAt: new Date(now + 5 * 24 * 3600 * 1000).toISOString(),
    }, now);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('future');
  });

  it('fills the entity id from the payload so callers need not repeat it', () => {
    const r = validateEvent({
      orgId: 'o1', type: 'application.stage.changed', source: 'careers',
      payload: { application_id: 'app_7', stage: 'assessment' },
    }, now);
    expect(r.ok).toBe(true);
    expect(r.normalized?.entityId).toBe('app_7');
    expect(r.normalized?.entityType).toBe('application');
  });
});

describe('idempotency — the duplicate promise', () => {
  const base = {
    type: 'application.stage.changed',
    source: 'careers',
    entityId: 'app_1',
    occurredAt: '2026-08-16T10:00:00.000Z',
    payload: { application_id: 'app_1', stage: 'assessment' },
    externalEventId: null,
  };

  it('gives the same key to the same fact stated twice', () => {
    expect(deriveIdempotencyKey(base)).toBe(deriveIdempotencyKey({ ...base }));
  });

  it('gives a different key to a different stage', () => {
    expect(deriveIdempotencyKey(base)).not.toBe(
      deriveIdempotencyKey({ ...base, payload: { application_id: 'app_1', stage: 'interview' } , entityId: 'app_1' }),
    );
  });

  it('gives a different key to a different application', () => {
    expect(deriveIdempotencyKey(base)).not.toBe(deriveIdempotencyKey({ ...base, entityId: 'app_2' }));
  });

  it('IGNORES the timestamp when the sender supplied its own event id', () => {
    // The important one. A sender retrying after a timeout re-sends the same event with a fresh
    // timestamp; mixing the timestamp in would make the retry look new and mail the candidate twice.
    const a = deriveIdempotencyKey({ ...base, externalEventId: 'evt_99' });
    const b = deriveIdempotencyKey({ ...base, externalEventId: 'evt_99', occurredAt: '2026-08-16T10:04:31.000Z' });
    expect(a).toBe(b);
  });

  it('separates two different senders using the same event id', () => {
    const a = deriveIdempotencyKey({ ...base, source: 'careers', externalEventId: 'evt_1' });
    const b = deriveIdempotencyKey({ ...base, source: 'talent', externalEventId: 'evt_1' });
    expect(a).not.toBe(b);
  });

  it('is stable across key order in the payload', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe('the webhook body', () => {
  it('is the shape the console previews and the dispatcher sends', () => {
    const body = webhookBody({
      id: 'evt_abc', orgId: 'o1', type: 'application.created', source: 'careers',
      entityType: 'application', entityId: 'app_1',
      payload: { application_id: 'app_1', email: 'x@y.com' },
      occurredAt: '2026-08-16T10:00:00.000Z', idempotencyKey: 'idem_1',
    });
    expect(body.id).toBe('evt_abc');
    expect(body.type).toBe('application.created');
    expect((body.entity as any).id).toBe('app_1');
    expect((body.data as any).email).toBe('x@y.com');
    expect(body.version).toBeTruthy();
  });

  it('produces a sample for every catalogued event, and every sample validates', () => {
    for (const e of CANONICAL_EVENTS) {
      const sample = sampleEvent(e.type, 'org_test');
      expect(sample, e.type + ' has no sample').toBeTruthy();
      const r = validateEvent(sample as any);
      expect(r.ok, e.type + ' sample was refused: ' + r.errors.join(' ')).toBe(true);
    }
  });

  it('makes every sample obviously synthetic', () => {
    // A test event that looks like real candidate data is a test event somebody downstream acts on.
    const s = sampleEvent('candidate.rejected', 'org_test');
    expect(String(s?.payload.email)).toContain('example.com');
  });
});
