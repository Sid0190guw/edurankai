// src/lib/mailint/mapping.test.ts — event transformation (section 14).
//
// The worked example from section 8 of the brief is the first test in this file, verbatim:
//
//     external:  candidate.stage = 3
//     becomes:   application.stage.changed { stage: "assessment" }
//     which triggers: the stage-3 email workflow
//
// The rest are the failure modes that make an integration quietly wrong rather than loudly broken:
// a path that does not exist, a value the lookup table has never heard of, a transform that cannot
// do its job, and a payload no mapping claims.
import { describe, it, expect } from 'vitest';
import {
  applyMapping,
  dryRun,
  getPath,
  mappingMatches,
  matchRuleHolds,
  selectMapping,
  validateMapping,
  validPath,
  applyTransform,
  type EventMapping,
} from './mapping';
import { validateEvent } from './events';
import { STAGE_BY_NUMBER, defaultMappingsFor } from './connectors';

const ATS_PAYLOAD = {
  event_id: 'ats_evt_5512',
  occurred_at: '2026-08-16T09:30:00Z',
  event: 'candidate.moved',
  candidate: { id: 'c_9', stage: 3, previous_stage: 2, email: 'Ravi.K@Example.com', name: 'Ravi K' },
  job: { title: 'Research Engineer' },
};

describe('the worked example from the brief', () => {
  const mapping = defaultMappingsFor('careers')[0];

  it('turns an external numeric stage into the canonical stage key', () => {
    const r = applyMapping(mapping, ATS_PAYLOAD);
    expect(r.ok, r.errors.join(' ')).toBe(true);
    expect(r.event?.type).toBe('application.stage.changed');
    expect(r.event?.payload?.application_id).toBe('c_9');
    expect(r.event?.payload?.stage).toBe('assessment');       // 3 -> assessment
    expect(r.event?.payload?.previous_stage).toBe('review');   // 2 -> review
  });

  it('normalises the address on the way through', () => {
    const r = applyMapping(mapping, ATS_PAYLOAD);
    expect(r.event?.payload?.email).toBe('ravi.k@example.com');
  });

  it('carries the sender’s own event id so their retry is our duplicate', () => {
    const r = applyMapping(mapping, ATS_PAYLOAD);
    expect(r.event?.externalEventId).toBe('ats_evt_5512');
  });

  it('produces an event the catalogue accepts', () => {
    const r = applyMapping(mapping, ATS_PAYLOAD);
    const v = validateEvent({ ...r.event, orgId: 'org_1' } as any);
    expect(v.ok, v.errors.join(' ')).toBe(true);
  });

  it('maps every funnel position the platform has', () => {
    for (const [num, key] of Object.entries(STAGE_BY_NUMBER)) {
      const r = applyMapping(mapping, { ...ATS_PAYLOAD, candidate: { ...ATS_PAYLOAD.candidate, stage: Number(num) } });
      expect(r.event?.payload?.stage, 'stage ' + num).toBe(key);
    }
  });
});

describe('path extraction', () => {
  it('reads dotted paths with or without the $ prefix', () => {
    expect(getPath(ATS_PAYLOAD, '$.candidate.email')).toBe('Ravi.K@Example.com');
    expect(getPath(ATS_PAYLOAD, 'candidate.stage')).toBe(3);
  });

  it('reads array indices', () => {
    expect(getPath({ items: [{ email: 'a@b.com' }] }, '$.items[0].email')).toBe('a@b.com');
  });

  it('returns undefined rather than throwing on a missing path', () => {
    expect(getPath(ATS_PAYLOAD, '$.nothing.here.at.all')).toBeUndefined();
    expect(getPath(null, '$.a')).toBeUndefined();
  });

  it('recognises a storable path', () => {
    expect(validPath('$.a.b[0]')).toBe(true);
    expect(validPath('a b')).toBe(false);
  });
});

describe('transforms', () => {
  it('refuses an address it cannot use rather than guessing', () => {
    expect(applyTransform('email', 'not-an-address').ok).toBe(false);
    expect(applyTransform('email', ' A@B.CO ').value).toBe('a@b.co');
  });

  it('parses the boolean spellings systems actually send', () => {
    expect(applyTransform('boolean', 'yes').value).toBe(true);
    expect(applyTransform('boolean', '0').value).toBe(false);
    expect(applyTransform('boolean', 'maybe').ok).toBe(false);
  });

  it('converts epoch timestamps', () => {
    expect(applyTransform('epoch_seconds', 1755331200).value).toBe(new Date(1755331200000).toISOString());
  });
});

describe('match rules', () => {
  it('compares as strings, because webhooks send 3 and "3" interchangeably', () => {
    expect(matchRuleHolds({ path: '$.candidate.stage', equals: 3 }, ATS_PAYLOAD)).toBe(true);
    expect(matchRuleHolds({ path: '$.candidate.stage', equals: '3' }, ATS_PAYLOAD)).toBe(true);
  });

  it('supports exists, in and an anchored pattern', () => {
    expect(matchRuleHolds({ path: '$.candidate.id', exists: true }, ATS_PAYLOAD)).toBe(true);
    expect(matchRuleHolds({ path: '$.event', in: ['candidate.moved', 'candidate.created'] }, ATS_PAYLOAD)).toBe(true);
    expect(matchRuleHolds({ path: '$.event', matches: 'candidate\\..+' }, ATS_PAYLOAD)).toBe(true);
    // Anchored: a partial match must not pass, or a filter for "created" would catch "uncreated".
    expect(matchRuleHolds({ path: '$.event', matches: 'moved' }, ATS_PAYLOAD)).toBe(false);
  });

  it('does not throw on an invalid pattern', () => {
    expect(matchRuleHolds({ path: '$.event', matches: '([' }, ATS_PAYLOAD)).toBe(false);
  });

  it('skips an inactive mapping', () => {
    const m = { ...defaultMappingsFor('careers')[0], isActive: false };
    expect(mappingMatches(m, ATS_PAYLOAD)).toBe(false);
  });
});

describe('failure modes', () => {
  const strict: EventMapping = {
    name: 'strict',
    source: 'external',
    match: [],
    canonicalType: 'application.stage.changed',
    valueMaps: { stage: STAGE_BY_NUMBER },
    fields: [
      { to: 'application_id', from: '$.id', transforms: ['string'], required: true },
      { to: 'stage', from: '$.stage', transforms: ['string'], valueMap: 'stage', required: true },
      { to: 'email', from: '$.email', transforms: ['email'] },
    ],
  };

  it('fails a required field whose path produced nothing, and names it', () => {
    const r = applyMapping(strict, { stage: 3 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('application_id');
  });

  it('fails a required value the lookup table has never heard of', () => {
    const r = applyMapping(strict, { id: 'x', stage: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('value map');
  });

  it('DROPS an optional field whose transform failed rather than failing the event', () => {
    // The event still matters. A malformed address costs the address, not the fact.
    const r = applyMapping(strict, { id: 'x', stage: 3, email: 'nonsense' });
    expect(r.ok).toBe(true);
    expect(r.event?.payload?.email).toBeUndefined();
    expect((r.trace || []).some((t) => t.note && t.note.includes('email failed'))).toBe(true);
  });

  it('skips — never errors — when no mapping claims the payload', () => {
    // An external system posts its whole stream. Refusing the unmapped part would make it retry our
    // 4xx forever and fill its own dead-letter queue with our errors.
    const chosen = selectMapping(defaultMappingsFor('careers'), { something: 'entirely unrelated' });
    expect(chosen).toBeNull();
  });

  it('falls back to receipt time for an unparseable timestamp, and records that it did', () => {
    const m: EventMapping = { ...strict, occurredAtPath: '$.when' };
    const r = applyMapping(m, { id: 'x', stage: 3, when: 'the day before yesterday' });
    expect(r.ok).toBe(true);
    expect((r.trace || []).some((t) => t.note && t.note.includes('receipt time'))).toBe(true);
  });
});

describe('validation at save time', () => {
  it('catches a target event that does not exist', () => {
    const errors = validateMapping({ name: 'x', source: 'external', match: [], canonicalType: 'application.moved', fields: [] });
    expect(errors.join(' ')).toContain('not an event');
  });

  it('catches a required payload field no rule produces', () => {
    const errors = validateMapping({
      name: 'x', source: 'external', match: [], canonicalType: 'application.stage.changed',
      fields: [{ to: 'application_id', from: '$.id' }],
    });
    expect(errors.join(' ')).toContain('payload.stage');
  });

  it('catches a value map that is referenced but not defined', () => {
    const errors = validateMapping({
      name: 'x', source: 'external', match: [], canonicalType: 'application.stage.changed',
      fields: [
        { to: 'application_id', from: '$.id' },
        { to: 'stage', from: '$.stage', valueMap: 'nope' },
      ],
    });
    expect(errors.join(' ')).toContain('value map "nope"');
  });

  it('catches a field written twice, where the later rule would win silently', () => {
    const errors = validateMapping({
      name: 'x', source: 'external', match: [], canonicalType: 'application.stage.changed',
      fields: [
        { to: 'application_id', from: '$.id' },
        { to: 'stage', from: '$.a' },
        { to: 'stage', from: '$.b' },
      ],
    });
    expect(errors.join(' ')).toContain('twice');
  });

  it('accepts every mapping the connectors ship', () => {
    for (const key of ['careers', 'external-webhook']) {
      for (const m of defaultMappingsFor(key)) {
        expect(validateMapping(m), key + '/' + m.name).toEqual([]);
      }
    }
  });
});

describe('dry run', () => {
  it('produces the same result as the real path, and publishes nothing', () => {
    const mapping = defaultMappingsFor('careers')[0];
    const preview = dryRun(mapping, ATS_PAYLOAD);
    const real = applyMapping(mapping, ATS_PAYLOAD, { receivedAt: preview.event?.occurredAt });
    expect(preview.event?.payload).toEqual(real.event?.payload);
  });
});
