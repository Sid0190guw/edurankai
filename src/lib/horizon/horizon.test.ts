import { describe, it, expect, beforeEach } from 'vitest';
import * as contractsModule from './contracts';
import {
  HORIZON_SECTION_KEYS,
  SIGNAL_WEIGHT_CLASSES,
  compareSignalWeight,
  outranks,
  sortSignalsByWeight,
  screenTerminology,
  assertNeutralTerminology,
  bandOf,
  NEUTRAL_TERM,
  DATA_CLASS_LABELS,
  DATA_CLASSES,
  SECTION_STATUSES,
  SECTION_STATUS_MEANING,
  SUSTAINABILITY_REFUSALS,
  PERSONAL_SUMMARY_REFUSALS,
  type HorizonSectionProvider,
  type SectionPayload,
  type Signal,
  type SignalWeightClass,
} from './contracts';
import {
  HORIZON_SECTIONS,
  DRILL_RUNGS,
  DRILL_RUNG_LABELS,
  DRILL_RUNG_QUESTION,
  PROPOSED_CAPABILITIES,
  PROPOSED_CAPABILITY_MEANING,
  nextRung,
  reachableDepth,
  depthSentence,
  sectionDef,
  sensitiveSectionKeys,
  proposedSectionKeys,
  PEOPLE_VIEW_360,
  PERFORMANCE_MANAGE,
  EMPLOYEE_MANAGE,
  AUDIT_VIEW,
  ATTENDANCE_ROSTER_MANAGE,
} from './sections';
import { resolveHorizonAccess, grantOf, type HorizonViewer } from './access';
import {
  registerHorizonProvider,
  unregisterHorizonProvider,
  resetHorizonRegistry,
  providerFor,
  registeredSections,
  registrationConflicts,
  fetchSection,
} from './registry';

// Real-shaped uuids. Several of these functions compare ids for equality, and a fixture like
// 'emp-1' would pass an equality test while failing a shape test for the wrong reason.
const EMPLOYEE = '11111111-1111-4111-8111-111111111111';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const OTHER_LOGIN = '33333333-3333-4333-8333-333333333333';

const SUBJECT = { personKey: 'p:' + EMPLOYEE, userId: LOGIN, employeeId: EMPLOYEE, applicationIds: [] };

const viewer = (over: Partial<HorizonViewer> = {}): HorizonViewer => ({
  userId: OTHER_LOGIN,
  employeeId: null,
  role: 'super_admin',
  name: 'A Reader',
  ...over,
});

/** A holds() that answers true for exactly the keys it was given. */
const holding = (...keys: string[]) => (k: string) => keys.indexOf(k) >= 0;

const signal = (over: Partial<Signal> = {}): Signal => ({
  id: 's1',
  label: 'A signal',
  statement: 'Something was observed.',
  weightClass: 'model_inference',
  dataClass: 'ai_interpretation',
  confidence: { value: null, band: 'none', basis: 'none stated' },
  observedAt: null,
  producedBy: 'test',
  evidence: [],
  patternIds: [],
  disputed: false,
  ...over,
});

// =================================================================================================
// THE SECTION TABLE
// =================================================================================================

describe('the twelve sections', () => {
  it('is exactly the twelve tabs the patch specifies, in order', () => {
    expect(HORIZON_SECTIONS.map((s) => s.key)).toEqual([
      'overview',
      'professional_profile',
      'behaviour_intelligence',
      'performance_work_records',
      'personal_intelligence_summary',
      'work_sustainability',
      'time_intelligence',
      'feedback_intelligence',
      'evidence_records',
      'signals',
      'decisions_interventions',
      'audit_trail',
    ]);
  });

  it('agrees with the key list in contracts.ts', () => {
    expect(HORIZON_SECTIONS.map((s) => s.key)).toEqual(Array.from(HORIZON_SECTION_KEYS));
  });

  it('gives every section an owner, so an absent panel is still somebody’s to answer for', () => {
    for (const s of HORIZON_SECTIONS) {
      expect(s.owedBy, s.key).toBeTruthy();
      expect(s.blurb.length, s.key).toBeGreaterThan(20);
    }
  });

  it('claims a section key at most once', () => {
    const keys = HORIZON_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks exactly the three interpretive tabs as proposed, and all three as sensitive', () => {
    expect(proposedSectionKeys()).toEqual([
      'behaviour_intelligence',
      'personal_intelligence_summary',
      'work_sustainability',
    ]);
    for (const k of proposedSectionKeys()) {
      expect(sectionDef(k).sensitive, k).toBe(true);
    }
  });

  it('names every proposed capability and says what ratifying it would permit', () => {
    for (const cap of PROPOSED_CAPABILITIES) {
      expect(PROPOSED_CAPABILITY_MEANING[cap], cap).toBeTruthy();
      expect(PROPOSED_CAPABILITY_MEANING[cap].length, cap).toBeGreaterThan(60);
    }
  });

  it('uses only ratified capability keys for the sections that are not proposed', () => {
    const ratified = new Set([
      PEOPLE_VIEW_360, EMPLOYEE_MANAGE, PERFORMANCE_MANAGE, ATTENDANCE_ROSTER_MANAGE, AUDIT_VIEW,
    ]);
    for (const s of HORIZON_SECTIONS) {
      if (s.proposed || s.capability === null) continue;
      expect(ratified.has(s.capability), s.key + ' uses ' + s.capability).toBe(true);
    }
  });

  it('gates every sensitive section on some capability — none is open by default', () => {
    for (const k of sensitiveSectionKeys()) {
      expect(sectionDef(k).capability, k).toBeTruthy();
    }
  });
});

// =================================================================================================
// RULE 22 — DEMONSTRATED WORK OUTRANKS INFERENCE, AND NOTHING CAN REORDER IT
// =================================================================================================

describe('signal weighting', () => {
  it('puts a birth-based interpretive input at the very bottom', () => {
    expect(SIGNAL_WEIGHT_CLASSES[0]).toBe('birth_based_inference');
    for (const other of SIGNAL_WEIGHT_CLASSES.slice(1)) {
      expect(outranks(other, 'birth_based_inference'), other).toBe(true);
    }
  });

  it('puts demonstrated work at the very top', () => {
    expect(SIGNAL_WEIGHT_CLASSES[SIGNAL_WEIGHT_CLASSES.length - 1]).toBe('demonstrated_work');
    for (const other of SIGNAL_WEIGHT_CLASSES.slice(0, -1)) {
      expect(outranks('demonstrated_work', other), other).toBe(true);
    }
  });

  it('ranks a system inference below every human account of the work', () => {
    for (const human of ['self_reported', 'peer_report', 'manager_report', 'organisational_record', 'demonstrated_work'] as SignalWeightClass[]) {
      expect(outranks(human, 'model_inference'), human).toBe(true);
    }
  });

  it('sorts strongest first, then most recent, and never mutates the input', () => {
    const input = [
      signal({ id: 'guess', weightClass: 'birth_based_inference' }),
      signal({ id: 'old-work', weightClass: 'demonstrated_work', observedAt: '2024-01-01T00:00:00.000Z' }),
      signal({ id: 'new-work', weightClass: 'demonstrated_work', observedAt: '2026-01-01T00:00:00.000Z' }),
      signal({ id: 'manager', weightClass: 'manager_report' }),
    ];
    const copy = input.slice();
    const sorted = sortSignalsByWeight(input);
    expect(sorted.map((s) => s.id)).toEqual(['new-work', 'old-work', 'manager', 'guess']);
    expect(input).toEqual(copy);
  });

  it('survives an unparseable observation date rather than sorting into nonsense', () => {
    const sorted = sortSignalsByWeight([
      signal({ id: 'a', weightClass: 'demonstrated_work', observedAt: 'not a date' }),
      signal({ id: 'b', weightClass: 'demonstrated_work', observedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('offers no way to total signals — ordering is the only operation', () => {
    // A guard against a future edit adding a sum(). If this ever fails, somebody has added a
    // scoring function to the module whose entire purpose is to refuse one.
    const mod = contractsModule as any;
    const names = Object.keys(mod).filter((n) => typeof mod[n] === 'function');
    for (const n of names) {
      expect(/score|total|average|composite|aggregate/i.test(n), n).toBe(false);
    }
  });
});

// =================================================================================================
// RULE 19 / 21 — TERMINOLOGY
// =================================================================================================

describe('terminology', () => {
  const offending = String.fromCharCode(122, 111, 100, 105, 97, 99); // zodiac
  const offending2 = String.fromCharCode(97, 115, 116, 114, 111, 108, 111, 103, 121); // astrology

  it('replaces a birth-based method name with the neutral term', () => {
    const r = screenTerminology('Personality read from ' + offending + ' sign');
    expect(r.clean).toBe(false);
    expect(r.text).toBe(NEUTRAL_TERM);
    expect(r.found.length).toBeGreaterThan(0);
  });

  it('catches it whatever the case', () => {
    expect(screenTerminology(offending2.toUpperCase()).clean).toBe(false);
    expect(screenTerminology('Advanced ' + offending2 + 'ical profile').clean).toBe(false);
  });

  it('leaves clean copy exactly as it was', () => {
    const s = 'Traditional computational input, ranked below demonstrated work.';
    const r = screenTerminology(s);
    expect(r.clean).toBe(true);
    expect(r.text).toBe(s);
  });

  it('treats a non-string as empty rather than throwing', () => {
    expect(screenTerminology(null).clean).toBe(true);
    expect(screenTerminology(undefined).text).toBe('');
    expect(screenTerminology(42 as any).clean).toBe(true);
  });

  it('holds every string this patch ships to a screen', () => {
    const copy: string[] = [];
    for (const s of HORIZON_SECTIONS) {
      copy.push(s.label, s.blurb, s.owedBy);
    }
    for (const cap of PROPOSED_CAPABILITIES) copy.push(PROPOSED_CAPABILITY_MEANING[cap]);
    for (const r of SUSTAINABILITY_REFUSALS) copy.push(r);
    for (const r of PERSONAL_SUMMARY_REFUSALS) copy.push(r);
    for (const k of Object.keys(SECTION_STATUS_MEANING)) copy.push((SECTION_STATUS_MEANING as any)[k]);
    for (const k of Object.keys(DATA_CLASS_LABELS)) copy.push((DATA_CLASS_LABELS as any)[k]);
    for (const r of DRILL_RUNGS) copy.push(DRILL_RUNG_LABELS[r], DRILL_RUNG_QUESTION[r]);
    expect(() => assertNeutralTerminology(copy)).not.toThrow();
  });

  it('has no emoji in any string it ships', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const s of HORIZON_SECTIONS) {
      expect(emoji.test(s.label + s.blurb + s.owedBy), s.key).toBe(false);
    }
    for (const r of SUSTAINABILITY_REFUSALS.concat(PERSONAL_SUMMARY_REFUSALS as any)) {
      expect(emoji.test(r), r.slice(0, 30)).toBe(false);
    }
  });
});

// =================================================================================================
// RULE 27 / 20-22 — WHAT THE SENSITIVE TABS SAY ABOUT THEMSELVES
// =================================================================================================

describe('the refusals printed above the sensitive tabs', () => {
  it('says the sustainability tab is not a health assessment and diagnoses nothing', () => {
    const all = SUSTAINABILITY_REFUSALS.join(' ').toLowerCase();
    expect(all).toContain('not a health assessment');
    expect(all).toContain('diagnos');
    expect(all).toContain('no individual health record');
  });

  it('says the personal summary is interpretive and cannot carry a decision', () => {
    const all = PERSONAL_SUMMARY_REFUSALS.join(' ').toLowerCase();
    expect(all).toContain('interpretive');
    expect(all).toContain('not presented as scientific fact');
    expect(all).toContain('demonstrated evidence decides');
  });
});

// =================================================================================================
// THE FIVE KINDS OF STATEMENT, AND THE FIVE STATUSES
// =================================================================================================

describe('vocabularies', () => {
  it('keeps raw source, derived, interpretation, feedback and decision apart', () => {
    expect(Array.from(DATA_CLASSES)).toEqual([
      'raw_source', 'derived', 'ai_interpretation', 'human_feedback', 'human_decision',
    ]);
    for (const c of DATA_CLASSES) expect((DATA_CLASS_LABELS as any)[c], c).toBeTruthy();
  });

  it('gives each of the five section statuses a distinct meaning', () => {
    const meanings = SECTION_STATUSES.map((s) => (SECTION_STATUS_MEANING as any)[s]);
    expect(new Set(meanings).size).toBe(SECTION_STATUSES.length);
    expect(SECTION_STATUS_MEANING.empty).not.toBe(SECTION_STATUS_MEANING.unreadable);
    expect(SECTION_STATUS_MEANING.not_supplied).toContain('has not registered');
  });

  it('bands a confidence value without inventing one for a null', () => {
    expect(bandOf(null)).toBe('none');
    expect(bandOf(undefined)).toBe('none');
    expect(bandOf(0)).toBe('none');
    expect(bandOf(0.2)).toBe('low');
    expect(bandOf(0.5)).toBe('moderate');
    expect(bandOf(0.9)).toBe('high');
    expect(bandOf(NaN)).toBe('none');
  });
});

// =================================================================================================
// THE LADDER
// =================================================================================================

describe('the drill ladder', () => {
  it('is summary, signal, pattern, evidence, record — in that order', () => {
    expect(Array.from(DRILL_RUNGS)).toEqual(['summary', 'signal', 'pattern', 'evidence', 'record']);
  });

  it('walks down one rung at a time and stops at the record', () => {
    expect(nextRung('summary')).toBe('signal');
    expect(nextRung('evidence')).toBe('record');
    expect(nextRung('record')).toBeNull();
  });

  it('reports how far a section can actually be walked', () => {
    expect(reachableDepth({ hasSignals: false, hasPatterns: false, hasEvidence: false, hasRecordLink: false })).toBe('summary');
    expect(reachableDepth({ hasSignals: true, hasPatterns: false, hasEvidence: false, hasRecordLink: false })).toBe('signal');
    expect(reachableDepth({ hasSignals: true, hasPatterns: true, hasEvidence: false, hasRecordLink: false })).toBe('pattern');
    expect(reachableDepth({ hasSignals: true, hasPatterns: true, hasEvidence: true, hasRecordLink: false })).toBe('evidence');
    expect(reachableDepth({ hasSignals: true, hasPatterns: true, hasEvidence: true, hasRecordLink: true })).toBe('record');
  });

  it('says out loud when a summary has nothing under it', () => {
    expect(depthSentence('summary').toLowerCase()).toContain('nothing under it');
    expect(depthSentence('record').toLowerCase()).toContain('every step is open');
  });
});

// =================================================================================================
// ACCESS — DECIDED BEFORE ANYTHING IS READ
// =================================================================================================

describe('resolveHorizonAccess', () => {
  it('grants nothing to a viewer holding nothing, and says so', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, () => false);
    expect(a.anyGranted).toBe(false);
    expect(a.granted).toEqual([]);
    expect(a.sentence).toContain('may not open any part');
  });

  it('opens exactly the tabs a capability reaches, and no more', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holding(PEOPLE_VIEW_360));
    expect(a.granted).toContain('overview');
    expect(a.granted).toContain('professional_profile');
    expect(a.granted).toContain('evidence_records');
    expect(a.granted).not.toContain('performance_work_records');
    expect(a.granted).not.toContain('audit_trail');
  });

  it('leaves the three interpretive tabs shut even for a viewer who holds everything ratified', () => {
    const a = resolveHorizonAccess(
      viewer(),
      SUBJECT,
      holding(PEOPLE_VIEW_360, EMPLOYEE_MANAGE, PERFORMANCE_MANAGE, ATTENDANCE_ROSTER_MANAGE, AUDIT_VIEW),
    );
    expect(a.awaitingRatification.sort()).toEqual([
      'behaviour_intelligence', 'personal_intelligence_summary', 'work_sustainability',
    ]);
    for (const k of a.awaitingRatification) {
      expect(grantOf(a, k).granted, k).toBe(false);
      expect(grantOf(a, k).because, k).toContain('does not exist in the permission registry');
    }
  });

  it('opens the interpretive tabs the moment their key is ratified — nothing else has to change', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holding(...PROPOSED_CAPABILITIES));
    expect(a.granted).toContain('behaviour_intelligence');
    expect(a.granted).toContain('personal_intelligence_summary');
    expect(a.granted).toContain('work_sustainability');
    expect(a.awaitingRatification).toEqual([]);
  });

  it('fails closed when the capability test throws', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, () => { throw new Error('registry down'); });
    expect(a.anyGranted).toBe(false);
  });

  it('opens the roll-up only when some other tab was granted', () => {
    const none = resolveHorizonAccess(viewer(), SUBJECT, () => false);
    expect(grantOf(none, 'signals').granted).toBe(false);
    expect(grantOf(none, 'signals').because).toContain('no signals to roll up');

    const some = resolveHorizonAccess(viewer(), SUBJECT, holding(PEOPLE_VIEW_360));
    expect(grantOf(some, 'signals').granted).toBe(true);
    expect(grantOf(some, 'signals').because).toContain('reads nothing of its own');
  });

  it('marks a self-view without widening a single grant', () => {
    const self = resolveHorizonAccess(
      viewer({ userId: LOGIN, employeeId: EMPLOYEE }),
      SUBJECT,
      () => false,
    );
    expect(self.isSelf).toBe(true);
    expect(self.anyGranted).toBe(false);
    expect(self.sentence).toContain('your own record');
  });

  it('gives every decision a sentence a person could act on', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holding(PEOPLE_VIEW_360));
    for (const g of a.grants) {
      expect(g.because.length, g.section).toBeGreaterThan(20);
    }
  });

  it('names the missing capability on every withheld tab', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holding(PEOPLE_VIEW_360));
    for (const key of a.withheld) {
      const g = grantOf(a, key);
      if (!g.capability) continue;
      expect(g.because, key).toContain(g.capability);
    }
  });

  it('treats a section it was never asked about as withheld rather than open', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holding(PEOPLE_VIEW_360));
    const g = grantOf({ ...a, grants: [] }, 'personal_intelligence_summary');
    expect(g.granted).toBe(false);
  });
});

// =================================================================================================
// THE REGISTRY — THE INTEGRATION BOUNDARY WITH THE OTHER PATCHES
// =================================================================================================

const payload = (key: any): SectionPayload<unknown> => ({
  key,
  status: 'ok',
  sentence: 'Answered by a test provider.',
  owedBy: 'PATCH-TEST',
  signals: [],
  patterns: [],
  requiredCapability: null,
  accessLogged: false,
  accessLogNote: null,
});

const provider = (patch: string, sections: any[], impl?: any): HorizonSectionProvider => ({
  identity: { patch, module: 'test/' + patch, version: '1.0.0' },
  sections,
  fetch: impl || (async (key: any) => payload(key)),
});

describe('the provider registry', () => {
  beforeEach(() => resetHorizonRegistry());

  it('starts empty, so an unwired section is a stated absence rather than an empty result', async () => {
    expect(registeredSections()).toEqual([]);
    expect(providerFor('behaviour_intelligence')).toBeNull();
    const r = await fetchSection(
      'behaviour_intelligence',
      SUBJECT,
      { viewerUserId: OTHER_LOGIN, viewerEmployeeId: null, grantedOn: null, asOf: '2026-08-23T00:00:00.000Z' },
      'PATCH-03',
    );
    expect(r).toBeNull();
  });

  it('lets a producing patch claim the sections it owns', () => {
    const r = registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence']));
    expect(r.ok).toBe(true);
    expect(r.claimed).toEqual(['behaviour_intelligence']);
    expect(providerFor('behaviour_intelligence')).not.toBeNull();
  });

  it('refuses a second claim on the same section rather than overwriting the first', () => {
    registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence']));
    const second = registerHorizonProvider(provider('PATCH-99', ['behaviour_intelligence']));
    expect(second.ok).toBe(false);
    expect(second.claimed).toEqual([]);
    expect(second.refused[0].heldBy).toContain('PATCH-03');
    expect(registrationConflicts().length).toBe(1);
    expect(providerFor('behaviour_intelligence')!.identity.patch).toBe('PATCH-03');
  });

  it('keeps the sections a colliding provider did win', () => {
    registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence']));
    const r = registerHorizonProvider(provider('PATCH-05', ['behaviour_intelligence', 'personal_intelligence_summary']));
    expect(r.claimed).toEqual(['personal_intelligence_summary']);
    expect(r.refused.length).toBe(1);
  });

  it('reports a section key that is not part of this view at all', () => {
    const r = registerHorizonProvider(provider('PATCH-X', ['not_a_real_section']));
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(['not_a_real_section']);
    expect(r.claimed).toEqual([]);
  });

  it('can be withdrawn, so a patch being replaced does not need a restart', () => {
    const p = provider('PATCH-03', ['behaviour_intelligence']);
    registerHorizonProvider(p);
    unregisterHorizonProvider(p);
    expect(providerFor('behaviour_intelligence')).toBeNull();
  });

  it('never lets a throwing provider take the page down, and keeps the real reason', async () => {
    const boom = new Error('SELECT * FROM behaviour');
    (boom as any).cause = { message: 'relation "behaviour" does not exist' };
    registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence'], async () => { throw boom; }));
    const r = await fetchSection(
      'behaviour_intelligence',
      SUBJECT,
      { viewerUserId: OTHER_LOGIN, viewerEmployeeId: null, grantedOn: null, asOf: '2026-08-23T00:00:00.000Z' },
      'PATCH-03',
    );
    expect(r!.status).toBe('unreadable');
    // The reason must be the cause, not the failed SQL — postgres-js puts the real one there.
    expect(r!.sentence).toContain('does not exist');
    expect(r!.sentence).toContain('missing rather than empty');
  });

  it('treats a malformed answer as unreadable rather than rendering half an object', async () => {
    registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence'], async () => ({ nonsense: true })));
    const r = await fetchSection(
      'behaviour_intelligence',
      SUBJECT,
      { viewerUserId: OTHER_LOGIN, viewerEmployeeId: null, grantedOn: null, asOf: '2026-08-23T00:00:00.000Z' },
      'PATCH-03',
    );
    expect(r!.status).toBe('unreadable');
    expect(r!.sentence).toContain('wiring fault');
  });

  it('normalises missing arrays so no consumer has to guard', async () => {
    registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence'], async (key: any) => ({
      ...payload(key), signals: undefined, patterns: undefined, owedBy: '',
    })));
    const r = await fetchSection(
      'behaviour_intelligence',
      SUBJECT,
      { viewerUserId: OTHER_LOGIN, viewerEmployeeId: null, grantedOn: null, asOf: '2026-08-23T00:00:00.000Z' },
      'PATCH-03',
    );
    expect(r!.signals).toEqual([]);
    expect(r!.patterns).toEqual([]);
    expect(r!.owedBy).toBe('PATCH-03');
  });

  it('refuses an answer for a different section than the one asked for', async () => {
    registerHorizonProvider(provider('PATCH-03', ['behaviour_intelligence'], async () => payload('signals')));
    const r = await fetchSection(
      'behaviour_intelligence',
      SUBJECT,
      { viewerUserId: OTHER_LOGIN, viewerEmployeeId: null, grantedOn: null, asOf: '2026-08-23T00:00:00.000Z' },
      'PATCH-03',
    );
    expect(r!.status).toBe('unreadable');
  });
});
