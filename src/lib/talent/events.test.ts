// Tests for the talent outbox — spec section 29.
//
// NO DATABASE IS TOUCHED HERE, and that is a property of the module rather than of the test: the
// connection and ensureTalent() are both resolved with a dynamic import inside the functions that
// need them, so importing this file reaches no driver. What is exercised is everything that decides
// WHAT gets written: the event vocabulary, the payload scrubber that keeps personal data out of a
// JSONB column, and the lease arithmetic the concurrent claim depends on.
//
// The claim statement itself cannot be asserted without a connection. What CAN be asserted, and is,
// is that the marker claimLease() writes still matches the pattern the SQL matches on — the one way
// those two halves silently drift apart and leave every claimed row permanently unclaimable.

import { describe, it, expect } from 'vitest';
import {
  TALENT_EVENTS,
  TALENT_EVENT_NAMES,
  isTalentEventName,
  isUuidLike,
  truncateError,
  claimLease,
  readLease,
  shouldRetryEvent,
  isPiiKey,
  scrubEventPayload,
  MAX_DELIVERY_ATTEMPTS,
  MAX_ERROR_CHARS,
  MAX_PAYLOAD_CHARS,
} from './events';

// A literal copy of LEASE_SQL_PATTERN in src/lib/talent/events.ts. Deliberately not imported — the
// point of the assertion is to fail if the two are edited apart.
const LEASE_SQL_PATTERN = /^lease:[0-9]+:/;

describe('TALENT_EVENTS catalogue', () => {
  // Every name the module brief names explicitly. A rename or a deletion here is a subscriber that
  // stops firing, so the list is spelled out rather than derived from the object under test.
  const REQUIRED = [
    'candidate.created', 'application.received', 'application.imported', 'candidate.shortlisted',
    'assessment.completed', 'interview.completed', 'candidate.selected',
    'onboarding.code.generated', 'onboarding.code.used', 'onboarding.started',
    'onboarding.completed', 'identity.created', 'department.assigned', 'role.assigned',
    'access.provisioned', 'account.activated', 'account.suspended', 'account.terminated',
  ];

  it('publishes every event the brief requires', () => {
    for (const name of REQUIRED) {
      expect(TALENT_EVENT_NAMES.includes(name as any)).toBe(true);
    }
  });

  it('publishes the rest of the spec 29 catalogue too', () => {
    for (const name of [
      'assignment.submitted', 'interview.scheduled', 'evaluation.submitted',
      'candidate.rejected', 'candidate.waitlisted', 'selection.approved_for_onboarding',
      'onboarding.code.delivered', 'onboarding.code.failed_attempt', 'onboarding.code.revoked',
      'onboarding.submitted', 'onboarding.approved',
      'identity.transferred', 'identity.converted', 'access.revoked',
      'document.submitted', 'document.verified',
    ]) {
      expect(TALENT_EVENT_NAMES.includes(name as any)).toBe(true);
    }
  });

  it('never repeats a name under two keys', () => {
    // Two keys for one wire name means a rename fixes one call site and silently leaves the other.
    expect(new Set(TALENT_EVENT_NAMES).size).toBe(TALENT_EVENT_NAMES.length);
  });

  it('keeps every name in the dotted lower-case shape subscribers match on', () => {
    for (const name of TALENT_EVENT_NAMES) {
      expect(/^[a-z]+(\.[a-z_]+)+$/.test(name)).toBe(true);
    }
  });

  it('keeps onboarding.approved and onboarding.completed as separate facts', () => {
    // Approved is the reviewer's decision on the form; completed is the end of the journey. Merging
    // them makes "approved but not yet provisioned" unanswerable, which is the People Ops queue.
    expect(TALENT_EVENTS.ONBOARDING_APPROVED).not.toBe(TALENT_EVENTS.ONBOARDING_COMPLETED);
  });
});

describe('isTalentEventName()', () => {
  it('accepts a catalogue name', () => {
    expect(isTalentEventName(TALENT_EVENTS.IDENTITY_CREATED)).toBe(true);
    expect(isTalentEventName('access.provisioned')).toBe(true);
  });

  it('refuses a near miss, which is the typo the const object exists to catch', () => {
    expect(isTalentEventName('identity.create')).toBe(false);
    expect(isTalentEventName('Identity.Created')).toBe(false);
    expect(isTalentEventName('candidate.hired')).toBe(false);
  });

  it('refuses what is not a string at all', () => {
    expect(isTalentEventName(null)).toBe(false);
    expect(isTalentEventName(undefined)).toBe(false);
    expect(isTalentEventName(42)).toBe(false);
    expect(isTalentEventName({ toString: () => 'identity.created' })).toBe(false);
  });
});

describe('isUuidLike()', () => {
  it('accepts a row id in either case, with surrounding space', () => {
    expect(isUuidLike('7c9e6679-7425-40de-944b-e07fc1f90ae7')).toBe(true);
    expect(isUuidLike('  7C9E6679-7425-40DE-944B-E07FC1F90AE7 ')).toBe(true);
  });

  it('refuses an EduRankAI code, which is what a caller will actually pass by mistake', () => {
    // subject_id is a UUID column. A code here would make the INSERT throw, and emitTalentEvent()
    // does not throw — so the event would vanish. It is kept in the payload as _subjectRef instead.
    expect(isUuidLike('ERAI-APP-2026-000123')).toBe(false);
    expect(isUuidLike('ERAI-EMP-002184')).toBe(false);
  });

  it('refuses the shapes that are almost a uuid', () => {
    expect(isUuidLike('7c9e6679742540de944be07fc1f90ae7')).toBe(false);   // no dashes
    expect(isUuidLike('7c9e6679-7425-40de-944b-e07fc1f90ae')).toBe(false); // one short
    expect(isUuidLike('')).toBe(false);
    expect(isUuidLike(null)).toBe(false);
  });
});

describe('truncateError()', () => {
  it('never returns an empty string, because an empty last_error reads as no error at all', () => {
    expect(truncateError('')).toBe('unknown error');
    expect(truncateError('   ')).toBe('unknown error');
    expect(truncateError(null)).toBe('unknown error');
  });

  it('collapses a multi-line Postgres message onto one line', () => {
    expect(truncateError('relation "tal_event"\n  does not exist')).toBe('relation "tal_event" does not exist');
  });

  it('caps the column rather than letting a handler size it', () => {
    const out = truncateError('x'.repeat(5000));
    expect(out.length).toBe(MAX_ERROR_CHARS);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('lease markers', () => {
  it('round-trips the claim time and the token', () => {
    const marker = claimLease(1_724_000_000_000, 'abc123');
    const parsed = readLease(marker);
    expect(parsed).not.toBeNull();
    expect(parsed!.atMs).toBe(1_724_000_000_000);
    expect(parsed!.token).toBe('abc123');
  });

  it('writes a marker the claim SQL will still match', () => {
    // The claim predicate uses the Postgres equivalent of this pattern. If they drift, a claimed row
    // is never reclaimable and the outbox stalls with no error anywhere.
    expect(LEASE_SQL_PATTERN.test(claimLease(Date.now(), 'tok'))).toBe(true);
    expect(LEASE_SQL_PATTERN.test(claimLease(0, ''))).toBe(true);
  });

  it('puts the timestamp in the second colon-delimited field, where split_part reads it', () => {
    // The SQL says split_part(last_error, ':', 2)::bigint. Anything else here is a cast error.
    const parts = claimLease(1_724_000_000_000, 'tok').split(':');
    expect(parts[0]).toBe('lease');
    expect(/^\d+$/.test(parts[1])).toBe(true);
  });

  it('strips punctuation out of the token so it cannot add a colon of its own', () => {
    const marker = claimLease(1000, 'a:b:c');
    expect(marker.split(':').length).toBe(3);
    expect(readLease(marker)!.atMs).toBe(1000);
  });

  it('reads a real error as an error, not as a claim', () => {
    expect(readLease('deadlock detected')).toBeNull();
    expect(readLease('lease terminated by the landlord')).toBeNull();   // starts with the word, not the marker
    expect(readLease('notify: lease:123:abc')).toBeNull();              // must anchor at the start
    expect(readLease(null)).toBeNull();
  });
});

describe('shouldRetryEvent()', () => {
  it('keeps retrying while attempts remain', () => {
    expect(shouldRetryEvent(1)).toBe(true);
    expect(shouldRetryEvent(MAX_DELIVERY_ATTEMPTS - 1)).toBe(true);
  });

  it('stops at the ceiling so a poison event cannot loop forever', () => {
    expect(shouldRetryEvent(MAX_DELIVERY_ATTEMPTS)).toBe(false);
    expect(shouldRetryEvent(MAX_DELIVERY_ATTEMPTS + 10)).toBe(false);
  });
});

describe('isPiiKey()', () => {
  it('catches the personal fields that must never reach a payload', () => {
    for (const k of [
      'email', 'primaryEmail', 'boundEmailNorm', 'phone', 'primaryPhone', 'address',
      'dateOfBirth', 'bankAccount', 'ifsc', 'salary', 'compensationNote',
      'aadhaarNumber', 'passportNo', 'driveUrl', 'documentLink', 'resumeText',
      'displayName', 'fullName', 'gender', 'maritalStatus',
    ]) {
      expect(isPiiKey(k)).toBe(true);
    }
  });

  it('catches a secret before it can be written to permanent storage', () => {
    // The onboarding code secret exists in plaintext for one response (spec 16.1). An event payload
    // is the most plausible place for it to be copied somewhere permanent by accident.
    expect(isPiiKey('secret')).toBe(true);
    expect(isPiiKey('codeSecret')).toBe(true);
    expect(isPiiKey('sessionToken')).toBe(true);
    expect(isPiiKey('password')).toBe(true);
  });

  it('leaves identifiers alone, which is what a payload is FOR', () => {
    for (const k of [
      'personId', 'applicationId', 'identityCode', 'opportunityCode', 'departmentId',
      'stageKey', 'eventName', 'decision', 'status', 'attempt', 'sourceId',
    ]) {
      expect(isPiiKey(k)).toBe(false);
    }
  });

  it('does not mistake a panel size for a PAN number', () => {
    // `pan` is matched as a whole word only. As a fragment it would eat `panel`, and the size of an
    // interview panel is a legitimate, non-personal fact (spec 30 says the size, never the names).
    expect(isPiiKey('panelSize')).toBe(false);
    expect(isPiiKey('panel')).toBe(false);
    expect(isPiiKey('pan')).toBe(true);
  });

  it('does not mistake every "name" key for a person name', () => {
    expect(isPiiKey('eventName')).toBe(false);
    expect(isPiiKey('groupName')).toBe(false);
    expect(isPiiKey('name')).toBe(true);
  });
});

describe('scrubEventPayload()', () => {
  it('keeps identifiers and drops personal data', () => {
    const { payload, removed } = scrubEventPayload({
      personId: 'p-1', applicationId: 'a-1', email: 'someone@example.in', displayName: 'A Person',
    });
    expect(payload.personId).toBe('p-1');
    expect(payload.applicationId).toBe('a-1');
    expect('email' in payload).toBe(false);
    expect('displayName' in payload).toBe(false);
    expect(removed.sort()).toEqual(['displayName', 'email']);
  });

  it('reports what it removed instead of dropping it silently', () => {
    // A silent drop hides the mistake and leaves a subscriber reading undefined with no idea why.
    const { removed } = scrubEventPayload({ candidate: { email: 'x@y.in', personId: 'p-1' } });
    expect(removed).toEqual(['candidate.email']);
  });

  it('reaches personal data nested inside objects and arrays', () => {
    const { payload, removed } = scrubEventPayload({
      stage: 'interview',
      panel: [{ userId: 'u-1', email: 'a@b.in' }, { userId: 'u-2', phone: '+911234567890' }],
    });
    expect(payload.panel[0].userId).toBe('u-1');
    expect('email' in payload.panel[0]).toBe(false);
    expect('phone' in payload.panel[1]).toBe(false);
    expect(removed.sort()).toEqual(['panel.0.email', 'panel.1.phone']);
  });

  it('stops descending rather than following an arbitrarily deep object', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    const { payload } = scrubEventPayload(deep);
    expect(JSON.stringify(payload)).toContain('[depth]');
  });

  it('records a non-object payload rather than refusing the event over it', () => {
    expect(scrubEventPayload('just a string').payload).toEqual({ value: 'just a string' });
    expect(scrubEventPayload(null).payload).toEqual({ value: null });
    expect(scrubEventPayload(7).payload).toEqual({ value: 7 });
  });

  it('survives a payload that cannot be serialised', () => {
    const cyclic: any = { personId: 'p-1' };
    cyclic.self = cyclic;
    // The cycle sits below the depth cap, so it terminates rather than throwing.
    expect(() => scrubEventPayload(cyclic)).not.toThrow();
    expect(scrubEventPayload(cyclic).payload.personId).toBe('p-1');
  });

  it('drops a function or an undefined instead of writing "undefined" into JSONB', () => {
    const { payload } = scrubEventPayload({ personId: 'p-1', fn: () => 1, nothing: undefined });
    expect(payload.personId).toBe('p-1');
    expect(payload.fn).toBe(null);
    expect(payload.nothing).toBe(null);
  });

  it('summarises an oversize payload and says so, keeping the identifiers', () => {
    // The realistic case is a raw ingest body reaching an emit by accident. Note that no SINGLE
    // string can trip this — those are capped on the way past — so the bulk has to come from many
    // fields, which is exactly what a raw body looks like.
    const { payload } = scrubEventPayload({
      applicationId: 'a-1',
      rawBody: { fields: Array.from({ length: 50 }, () => 'x'.repeat(500)) },
    });
    expect(payload._oversize).toBe(true);
    expect(payload.applicationId).toBe('a-1');
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
  });

  it('caps a single long string so one field cannot fill the column', () => {
    const { payload } = scrubEventPayload({ note: 'y'.repeat(5000) });
    expect(String(payload.note).length).toBeLessThanOrEqual(1003);
  });

  it('keeps a Date as an ISO string rather than an empty object', () => {
    const { payload } = scrubEventPayload({ at: new Date('2026-08-23T00:00:00.000Z') });
    expect(payload.at).toBe('2026-08-23T00:00:00.000Z');
  });
});
