// src/lib/horizon/meir-bridge.test.ts — PATCH 11's translation from the shared contract, asserted.
//
// This suite exists because the bridge is where a claim could quietly get STRONGER. Every test below
// is about a claim staying as weak as it arrived: an inference staying an inference, a
// non-evidential input staying at the floor, an uncomputed result staying uncomputed rather than
// becoming a zero, and a withheld tab never causing a provider to be asked.

import { describe, it, expect, beforeEach } from 'vitest';
import { registerProvider, clearProviders, type MeirProvider, type ProviderContext } from './record';
import { employeeSubject, DEFAULT_ORGANISATION_ID } from './ids';
import type { DimensionFamily, IntelligenceResult, Signal as HznSignal } from './types';
import {
  bridgeMeirSections,
  familiesForSections,
  sectionForResult,
  scoreText,
  toConfidence,
  toDataClass,
  toEvidenceRef,
  toWeightClass,
  FAMILY_TO_SECTION,
  PATCH_TO_SECTION,
  BRIDGED_SECTIONS,
} from './meir-bridge';
import { compareSignalWeight, HORIZON_SECTION_KEYS, type HorizonSectionKey } from './contracts';
import { DIMENSION_FAMILIES } from './types';

const EMPLOYEE = '11111111-1111-4111-8111-111111111111';
const SUBJECT = { personKey: 'p', userId: null, employeeId: EMPLOYEE, applicationIds: [] };

const result = (over: Partial<IntelligenceResult> = {}): IntelligenceResult => ({
  id: 'res-1' as any,
  subject: employeeSubject(EMPLOYEE),
  dimension: { family: 'collaboration', key: 'responsiveness', label: 'Responsiveness' },
  scoreOrLevel: { kind: 'level', level: 'steady', ladder: ['low', 'steady', 'high'] },
  confidence: { band: 'moderate', value: 0.5, basis: 'Six months of records.' },
  status: 'active',
  summary: 'Replies land within a working day in most weeks observed.',
  evidence: [],
  sourceBreakdown: [],
  computedAt: '2026-08-01T00:00:00.000Z',
  validFor: { staleAt: '2026-12-01T00:00:00.000Z', recomputeAfterDays: 30 },
  modelOrEngineVersion: {
    engineId: 'behaviour', engineClass: 'deterministic', version: '1.2.0', computationId: 'run-1' as any,
  },
  humanReviewStatus: 'not_required',
  layer: 'ai_interpretation',
  decisionUse: 'advisory_only',
  scientificStatus: 'established_method',
  organisationId: DEFAULT_ORGANISATION_ID,
  ...over,
} as IntelligenceResult);

const provider = (over: Partial<MeirProvider> = {}): MeirProvider => ({
  patchId: 'horizon-behaviour',
  label: 'Behaviour Intelligence',
  dimensions: [{ family: 'collaboration', key: 'responsiveness', label: 'Responsiveness' }],
  historicalSupport: false,
  async read() { return [result()]; },
  ...over,
} as MeirProvider);

const run = (granted: HorizonSectionKey[]) =>
  bridgeMeirSections(SUBJECT, { granted, requestId: 'req-1' });

beforeEach(() => clearProviders());

// =================================================================================================
// ROUTING
// =================================================================================================

describe('routing a result to a tab', () => {
  it('sends every dimension family somewhere real', () => {
    const keys = new Set<string>(HORIZON_SECTION_KEYS as readonly string[]);
    for (const fam of DIMENSION_FAMILIES) {
      const target = (FAMILY_TO_SECTION as any)[fam];
      expect(target, fam).toBeTruthy();
      expect(keys.has(target), fam + ' -> ' + target).toBe(true);
    }
  });

  it('puts the traditional-computation family on the interpretive tab, NOT on Time Intelligence', () => {
    // types.ts states that `temporal_pattern` is the neutral name for the traditional-computation
    // family. Routing it to `time_intelligence` on the strength of the word "temporal" would put a
    // birth-based reading behind an attendance capability.
    expect(FAMILY_TO_SECTION.temporal_pattern).toBe('personal_intelligence_summary');
    expect(FAMILY_TO_SECTION.temporal_pattern).not.toBe('time_intelligence');
  });

  it('keeps wellbeing on the sustainability tab and nowhere else', () => {
    expect(FAMILY_TO_SECTION.wellbeing_aggregate).toBe('work_sustainability');
    const elsewhere = Object.keys(FAMILY_TO_SECTION)
      .filter((f) => f !== 'wellbeing_aggregate')
      .map((f) => (FAMILY_TO_SECTION as any)[f]);
    expect(elsewhere).not.toContain('work_sustainability');
  });

  it('lets a patch id override the family map', () => {
    expect(sectionForResult('horizon-temporal', 'collaboration')).toBe('time_intelligence');
    expect(sectionForResult('unknown-patch', 'collaboration')).toBe('behaviour_intelligence');
  });

  it('sends an unrecognised family to the roll-up rather than dropping it', () => {
    expect(sectionForResult('unknown-patch', 'not_a_family')).toBe('signals');
    expect(sectionForResult('unknown-patch', null)).toBe('signals');
  });

  it('routes every declared patch override to a bridged tab', () => {
    for (const patchId of Object.keys(PATCH_TO_SECTION)) {
      expect(BRIDGED_SECTIONS.indexOf((PATCH_TO_SECTION as any)[patchId]), patchId).toBeGreaterThan(-1);
    }
  });

  it('turns a grant list into the families it is allowed to ask for', () => {
    expect(familiesForSections(['work_sustainability'])).toEqual(['wellbeing_aggregate']);
    expect(familiesForSections(['behaviour_intelligence']).sort())
      .toEqual(['collaboration', 'reliability', 'risk']);
    expect(familiesForSections([])).toEqual([]);
  });
});

// =================================================================================================
// TRANSLATION NEVER STRENGTHENS A CLAIM
// =================================================================================================

describe('vocabulary translation', () => {
  it('keeps an inference an inference', () => {
    expect(toDataClass('ai_interpretation')).toBe('ai_interpretation');
    expect(toWeightClass('inferred')).toBe('model_inference');
  });

  it('puts a non-evidential input at the floor, below everything', () => {
    const floor = toWeightClass('non_evidential');
    expect(floor).toBe('birth_based_inference');
    for (const stronger of ['inferred', 'stated', 'attested', 'observed', 'demonstrated']) {
      expect(compareSignalWeight(toWeightClass(stronger), floor), stronger).toBeGreaterThan(0);
    }
  });

  it('keeps demonstrated work above every other class', () => {
    const top = toWeightClass('demonstrated');
    for (const weaker of ['observed', 'attested', 'stated', 'inferred', 'non_evidential']) {
      expect(compareSignalWeight(top, toWeightClass(weaker)), weaker).toBeGreaterThan(0);
    }
  });

  it('never promotes an unknown layer or class to something load-bearing', () => {
    expect(toDataClass('something_new')).toBe('ai_interpretation');
    expect(toWeightClass('something_new')).toBe('model_inference');
    expect(toDataClass(null)).toBe('ai_interpretation');
  });

  it('does not invent a confidence number where the patch stated none', () => {
    expect(toConfidence(null).value).toBeNull();
    expect(toConfidence(null).band).toBe('none');
    expect(toConfidence({ band: 'high', basis: 'stated without a number' } as any).value).toBeNull();
    expect(toConfidence({ band: 'high', basis: 'stated without a number' } as any).band).toBe('high');
    expect(toConfidence({ band: 'low', value: 0.8, basis: 'x' } as any).band).toBe('high');
  });

  it('renders an uncomputed result as its reason, never as a number', () => {
    const text = scoreText({ kind: 'not_computed', reason: 'Fewer than four weeks of records.' });
    expect(text).toContain('Not computed');
    expect(text).toContain('Fewer than four weeks');
    expect(text).not.toMatch(/\b0\b/);
  });

  it('renders a numeric value with the scale it was measured on', () => {
    expect(scoreText({ kind: 'numeric', value: 7, scaleMin: 0, scaleMax: 10 })).toContain('0 to 10');
  });

  it('carries an unreadable piece of evidence through as unreadable', () => {
    const ref = toEvidenceRef({
      id: 'e1', sourceType: 'attendance_record', sourceId: 'a1', timestamp: '2026-01-01T00:00:00.000Z',
      relevance: { band: 'high', value: 0.9 }, reliability: { band: 'high', value: 0.9 },
      summary: 'Should not be shown as the sentence',
      rawReference: { ownerModule: 'src/lib/attendance.ts', table: 'hr_attendance', recordId: 'r1' },
      evidenceClass: 'observed', layer: 'raw', collectedUnder: 'employment_record',
      organisationId: DEFAULT_ORGANISATION_ID, unreadable: 'the row could not be read',
    } as any);
    expect(ref.sentence).toContain('could not be read');
    expect(ref.sourceTable).toBe('hr_attendance');
  });

  it('never fabricates a route into another patch’s screens', () => {
    const ref = toEvidenceRef({
      id: 'e1', sourceType: 'attendance_record', sourceId: 'a1', timestamp: null,
      relevance: { band: 'low', value: 0.1 }, reliability: { band: 'low', value: 0.1 },
      summary: 'A row', rawReference: { ownerModule: 'm', table: 't', recordId: 'r' },
      evidenceClass: 'observed', layer: 'raw', collectedUnder: 'employment_record',
      organisationId: DEFAULT_ORGANISATION_ID,
    } as any);
    expect(ref.href).toBeNull();
  });
});

// =================================================================================================
// THE READ — WITHHELD MEANS NOT ASKED
// =================================================================================================

describe('bridging the master record', () => {
  it('refuses without an employee record, and says it is about the linkage', async () => {
    const out = await bridgeMeirSections(
      { personKey: 'p', userId: null, employeeId: null, applicationIds: [] },
      { granted: ['behaviour_intelligence'], requestId: 'r' },
    );
    expect(out.refusal).toContain('linkage');
    expect(out.payloads.size).toBe(0);
  });

  it('asks no provider at all when nothing bridged was granted', async () => {
    let asked = false;
    registerProvider(provider({ async read() { asked = true; return [result()]; } }));
    const out = await run(['overview', 'audit_trail']);
    expect(asked).toBe(false);
    expect(out.payloads.size).toBe(0);
  });

  it('does not ask a provider whose families belong to a withheld tab', async () => {
    let asked = false;
    registerProvider(provider({
      patchId: 'horizon-wellbeing',
      dimensions: [{ family: 'wellbeing_aggregate', key: 'load', label: 'Load' }],
      async read() { asked = true; return []; },
    }));
    await run(['behaviour_intelligence']);
    expect(asked).toBe(false);
  });

  it('fills the granted tab from the registered patch', async () => {
    registerProvider(provider());
    const out = await run(['behaviour_intelligence']);
    const p = out.payloads.get('behaviour_intelligence')!;
    expect(p.status).toBe('ok');
    const data = p.data as any;
    expect(data.findings.length).toBe(1);
    expect(data.findings[0].dimensionLabel).toBe('Responsiveness');
    expect(data.findings[0].valueText).toContain('steady');
    expect(data.contributingPatches).toEqual(['Behaviour Intelligence']);
  });

  it('says a tab is not supplied — naming what IS registered — rather than saying it is empty', async () => {
    registerProvider(provider());
    const out = await run(['behaviour_intelligence', 'feedback_intelligence']);
    const p = out.payloads.get('feedback_intelligence')!;
    expect(p.status).toBe('not_supplied');
    expect(p.sentence).toContain('horizon-behaviour');
    expect(p.sentence).toContain('does not mean an empty record');
  });

  it('marks a tab incomplete rather than empty when its patch failed', async () => {
    registerProvider(provider({ async read() { throw new Error('boom'); } }));
    const out = await run(['behaviour_intelligence']);
    const p = out.payloads.get('behaviour_intelligence')!;
    expect(p.status).toBe('unreadable');
    expect(p.sentence).toContain('INCOMPLETE');
  });

  it('says out loud when a reading may not carry a decision', async () => {
    registerProvider(provider());
    const out = await run(['behaviour_intelligence']);
    expect(out.payloads.get('behaviour_intelligence')!.sentence)
      .toContain('none of them may carry a decision');
  });

  it('counts the readings that could not be computed instead of hiding them', async () => {
    registerProvider(provider({
      async read() {
        return [result({ scoreOrLevel: { kind: 'not_computed', reason: 'Too few records.' } })];
      },
    }));
    const out = await run(['behaviour_intelligence']);
    const p = out.payloads.get('behaviour_intelligence')!;
    expect(p.sentence).toContain('could not be computed');
    expect((p.data as any).findings[0].computed).toBe(false);
    expect((p.data as any).findings[0].unreadable).toContain('Too few records');
  });

  it('translates signals and marks a dismissed one as disputed rather than dropping it', async () => {
    const sig: HznSignal = {
      id: 'sig-1' as any,
      subject: employeeSubject(EMPLOYEE),
      category: 'workload',
      severity: 'medium',
      title: 'Sustained out-of-hours activity',
      explanation: 'Work records show activity outside scheduled hours in six of eight weeks.',
      evidenceIds: ['ev-1' as any],
      sourceTypes: [],
      confidence: { band: 'moderate', value: 0.5, basis: 'Eight weeks of records.' },
      generatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
      status: 'dismissed',
      recommendedActions: [],
      humanReviewRequired: true,
      layer: 'ai_interpretation',
      decisionUse: 'advisory_only',
      organisationId: DEFAULT_ORGANISATION_ID,
    } as any;
    registerProvider(provider({ async readSignals() { return [sig]; } }));
    const out = await run(['behaviour_intelligence']);
    expect(out.signals.length).toBe(1);
    expect(out.signals[0].disputed).toBe(true);
    expect(out.signals[0].producedBy).toBe('horizon-behaviour');
    expect(out.signals[0].evidence[0].sentence).toContain('carries the reference, not the row');
  });

  it('reports which patches are registered whatever it was asked for', async () => {
    registerProvider(provider());
    const out = await run(['overview']);
    expect(out.registeredPatches).toEqual(['horizon-behaviour']);
  });
});
