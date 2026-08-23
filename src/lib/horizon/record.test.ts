// src/lib/horizon/record.test.ts — the Master Employee Intelligence Record, asserted.
//
// The two tests that matter most here are the isolation ones. A record composed from eight patches
// has eight ways to fail, and the difference between a good composition and a bad one is entirely
// what happens on failure: a section that reads "could not be read" is honest, and a section that
// silently vanishes is a statement about a human being made by a failed query.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider, listProviders, clearProviders, providerFor, composeRecord, planRecord,
  PROVIDER_TIMEOUT_MS, type MeirProvider,
} from './record';
import { employeeSubject, DEFAULT_ORGANISATION_ID } from './ids';
import { DIMENSION_FAMILIES, type IntelligenceResult } from './types';

const EMP = '11111111-1111-4111-8111-111111111111';
const subject = employeeSubject(EMP);

function stubResult(key: string): IntelligenceResult {
  return {
    id: 'res-' + key,
    subject,
    dimension: { family: 'capability', key, label: 'Dimension ' + key },
    scoreOrLevel: { kind: 'level', level: 'Independent', ladder: ['Assisted', 'Independent'] },
    confidence: { band: 'moderate', value: 0.5, basis: 'stub' },
    status: 'active',
    summary: 'Stub result for ' + key,
    evidence: [],
    sourceBreakdown: [{ sourceType: 'task', weight: 1, evidenceIds: [], strongestClass: 'demonstrated' }],
    computedAt: '2026-08-23T10:00:00.000Z',
    validFor: { staleAt: '2026-09-23T10:00:00.000Z', recomputeAfterDays: 30 },
    modelOrEngineVersion: {
      engineId: 'stub', engineClass: 'deterministic', version: '1', computationId: 'c-' + key,
    },
    humanReviewStatus: 'not_required',
    layer: 'computed',
    decisionUse: 'supporting_only',
    scientificStatus: 'platform_record',
    organisationId: DEFAULT_ORGANISATION_ID,
  };
}

function provider(over: Partial<MeirProvider> & { patchId: string }): MeirProvider {
  return {
    label: over.patchId,
    dimensions: [{ family: 'capability', key: over.patchId, label: over.patchId }],
    historicalSupport: true,
    async read() { return [stubResult(over.patchId)]; },
    ...over,
  };
}

beforeEach(() => { clearProviders(); });

describe('the provider registry', () => {
  it('registers and unregisters cleanly', () => {
    const off = registerProvider(provider({ patchId: 'alpha' }));
    expect(listProviders().map((p) => p.patchId)).toEqual(['alpha']);
    off();
    expect(listProviders()).toEqual([]);
  });

  it('refuses a second provider for the same patch rather than silently replacing it', () => {
    registerProvider(provider({ patchId: 'alpha' }));
    // Rule 6: never overwrite another agent's implementation. A silent overwrite here would remove
    // one patch's whole contribution from every record with nothing anywhere saying so.
    expect(() => registerProvider(provider({ patchId: 'alpha' }))).toThrow(/already registered/i);
  });

  it('refuses a provider that declares an unknown dimension family', () => {
    expect(() => registerProvider(provider({
      patchId: 'weird',
      dimensions: [{ family: 'vibes' as any, key: 'k', label: 'Vibes' }],
    }))).toThrow(/unknown dimension family/i);
  });

  it('refuses a provider with no patch id', () => {
    expect(() => registerProvider(provider({ patchId: '  ' }))).toThrow(/patchId/);
  });

  it('answers which patch owns a dimension', () => {
    registerProvider(provider({ patchId: 'alpha' }));
    expect(providerFor('alpha')?.patchId).toBe('alpha');
    expect(providerFor('nobody')).toBeNull();
  });
});

describe('composing the record', () => {
  it('assembles every registered section', async () => {
    registerProvider(provider({ patchId: 'alpha' }));
    registerProvider(provider({ patchId: 'beta' }));
    const rec = await composeRecord(subject, { requestId: 'r1' });
    expect(rec.sections.map((s) => s.patchId).sort()).toEqual(['alpha', 'beta']);
    expect(rec.complete).toBe(true);
    expect(rec.degraded).toEqual([]);
    expect(rec.sections[0].results).toHaveLength(1);
  });

  it('keeps a failing provider as an UNREADABLE section, never as an absent one', async () => {
    registerProvider(provider({ patchId: 'alpha' }));
    registerProvider(provider({
      patchId: 'broken',
      async read(): Promise<never> {
        const e: any = new Error('select * from something ...');
        e.cause = { message: 'permission denied for table hr_attendance' };
        throw e;
      },
    }));
    const rec = await composeRecord(subject, { requestId: 'r1' });

    // The whole record still arrives.
    expect(rec.sections).toHaveLength(2);
    const broken = rec.sections.find((s) => s.patchId === 'broken');
    expect(broken).toBeTruthy();
    expect(broken!.results).toEqual([]);
    // And it says WHY, with the real Postgres reason from e.cause rather than the failed statement.
    expect(broken!.unreadable).toMatch(/permission denied/);
    expect(broken!.unreadable).not.toMatch(/select \*/);

    // The healthy section is untouched — one failure does not skip its siblings.
    const alpha = rec.sections.find((s) => s.patchId === 'alpha');
    expect(alpha!.results).toHaveLength(1);
    expect(alpha!.unreadable).toBeFalsy();

    expect(rec.complete).toBe(false);
    expect(rec.degraded).toEqual(['broken']);
  });

  it('keeps a provider’s results when only its signals fail', async () => {
    registerProvider(provider({
      patchId: 'half',
      async readSignals(): Promise<never> { throw new Error('signals table missing'); },
    }));
    const rec = await composeRecord(subject, { requestId: 'r1' });
    const half = rec.sections[0];
    expect(half.results).toHaveLength(1);
    expect(half.signals).toEqual([]);
    expect(half.unreadable).toMatch(/signals could not be read/i);
  });

  it('bounds a hanging provider instead of holding the whole record', async () => {
    registerProvider(provider({ patchId: 'fast' }));
    registerProvider(provider({
      patchId: 'hangs',
      async read() { return new Promise(() => {}); },
    }));
    const started = Date.now();
    const rec = await composeRecord(subject, { requestId: 'r1' });
    const elapsed = Date.now() - started;
    expect(rec.sections.find((s) => s.patchId === 'fast')!.results).toHaveLength(1);
    expect(rec.sections.find((s) => s.patchId === 'hangs')!.unreadable).toMatch(/did not answer/);
    expect(elapsed).toBeLessThan(PROVIDER_TIMEOUT_MS * 2);
  }, PROVIDER_TIMEOUT_MS * 3);

  it('never throws, even with no providers at all', async () => {
    const rec = await composeRecord(subject, { requestId: 'r1' });
    expect(rec.sections).toEqual([]);
    expect(rec.complete).toBe(true);
    expect(rec.subject).toEqual(subject);
  });

  it('filters by family and by patch', async () => {
    registerProvider(provider({ patchId: 'cap' }));
    registerProvider(provider({
      patchId: 'risk',
      dimensions: [{ family: 'risk', key: 'risk', label: 'Attention areas' }],
    }));
    const capOnly = await composeRecord(subject, { requestId: 'r1', families: ['capability'] });
    expect(capOnly.sections.map((s) => s.patchId)).toEqual(['cap']);
    const onePatch = await composeRecord(subject, { requestId: 'r1', patchIds: ['risk'] });
    expect(onePatch.sections.map((s) => s.patchId)).toEqual(['risk']);
  });

  it('flags a provider that cannot answer historically instead of dating today’s answer', async () => {
    registerProvider(provider({ patchId: 'nohistory', historicalSupport: false }));
    const asOf = '2026-03-01T00:00:00.000Z';
    const rec = await composeRecord(subject, { requestId: 'r1', asOf });
    expect(rec.asOf).toBe(asOf);
    expect(rec.sections[0].asOfUnsupported).toBe(true);

    const current = await composeRecord(subject, { requestId: 'r1' });
    expect(current.sections[0].asOfUnsupported).toBe(false);
  });
});

describe('planning a record without reading one', () => {
  it('reports which families nothing serves', () => {
    registerProvider(provider({ patchId: 'cap' }));
    const plan = planRecord(subject);
    expect(plan.dimensions.map((d) => d.patchId)).toEqual(['cap']);
    // A dimension nobody serves is a gap in the SYSTEM, surfaced as such, rather than a heading with
    // nothing under it that reads as an absence in the person.
    expect(plan.unservedFamilies).toContain('risk');
    expect(plan.unservedFamilies).not.toContain('capability');
    expect(plan.unservedFamilies.length).toBe(DIMENSION_FAMILIES.length - 1);
  });

  it('lists the providers that cannot answer historically', () => {
    registerProvider(provider({ patchId: 'a', historicalSupport: false }));
    registerProvider(provider({ patchId: 'b' }));
    expect(planRecord(subject).withoutHistory).toEqual(['a']);
  });
});
