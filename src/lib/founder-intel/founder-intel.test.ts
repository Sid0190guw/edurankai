// src/lib/founder-intel/founder-intel.test.ts — PATCH 12'S GUARANTEES, CHECKED RATHER THAN PROMISED.
//
// These are the pure parts: the founder gate, the eighteen-section structure and the seven questions.
// The composer itself reads eleven modules and is exercised through its inputs, not mocked into a
// shape that would pass whatever it did.
//
// The assertions that matter most are the ones about ABSENCE. Half the failures this view could
// cause are a sentence that says "nothing on record" when the truth is "the read failed" or "no
// patch has built this yet" — the same shape on screen, opposite facts about a person.

import { describe, it, expect } from 'vitest';

import {
  isFounder, founderEmail, horizonViewerOf, horizonKeysRead,
  FOUNDER_SECTIONS, FOUNDER_SECTION_KEYS, founderSectionDef, NEVER_ON_THIS_SCREEN,
} from './founder-access';
import {
  ask, askAll, findSignal, isQuestion, dayLabel, QUESTIONS, QUESTION_LABELS,
} from './questions';
import type { LinkedActions } from './questions';
import { isUuid } from './founder-profile';
import {
  HORIZON_SECTION_KEYS, SECTION_STATUS_MEANING, NO_CONFIDENCE, screenTerminology,
} from '@/lib/horizon/contracts';
import type { DecisionRecord, EvidenceRef, InterventionRecord, Signal } from '@/lib/horizon/contracts';

// -------------------------------------------------------------------------------------------------
// FIXTURES — shaped exactly like Patch 11's contract, never a convenient simplification of it.
// -------------------------------------------------------------------------------------------------

const ev = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  ownerModule: 'eims-evidence.ts',
  sourceTable: 'eims_evidence',
  sourceId: 'e1',
  locator: 'week 32',
  documentUrl: null,
  occurredAt: '2026-08-01T09:00:00.000Z',
  verificationStatus: 'accepted by a named verifier',
  sentence: 'Submitted work accepted, 6 hours verified',
  href: '/portal/evidence',
  ...over,
});

const sig = (over: Partial<Signal> = {}): Signal => ({
  id: 'evidence.accepted',
  label: 'Work verified by a named human',
  statement: 'Four submissions were accepted by a named verifier in the last quarter.',
  weightClass: 'demonstrated_work',
  dataClass: 'derived',
  confidence: { value: 0.8, band: 'high', basis: 'Four accepted records from two verifiers.' },
  observedAt: '2026-08-10T09:00:00.000Z',
  producedBy: 'PATCH-11 horizon/adapters',
  evidence: [ev()],
  patternIds: [],
  disputed: false,
  ...over,
});

const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'd1',
  decision: 'Confirmed at the end of probation',
  decidedByUserId: 'u9',
  decidedByName: 'A Manager',
  decidedByRole: 'Reporting manager',
  decidedAt: '2026-08-12T09:00:00.000Z',
  reason: 'Consistently accepted work through the probation period.',
  consideredSignalIds: ['evidence.accepted'],
  subjectInformed: true,
  evidence: [ev({ ownerModule: 'performance.ts', sourceTable: 'hr_performance_reviews', href: '/admin/hr/performance' })],
  producedBy: 'the decisions patch',
  ...over,
});

const intervention = (over: Partial<InterventionRecord> = {}): InterventionRecord => ({
  id: 'i1',
  kind: 'Support plan',
  summary: 'Weekly check-in for one quarter',
  openedAt: '2026-06-01T09:00:00.000Z',
  closedAt: null,
  ownerUserId: 'u9',
  ownerName: 'A Manager',
  status: 'open',
  evidence: [],
  producedBy: 'the decisions patch',
  ...over,
});

const NONE: LinkedActions = { decisions: [], interventions: [] };

// =================================================================================================
// THE GATE
// =================================================================================================

describe('the founder gate is narrower than the admin one', () => {
  it('admits the founder and refuses everyone else, including super admins', () => {
    expect(isFounder({ role: 'super_admin', email: founderEmail() })).toBe(true);
    expect(isFounder({ role: 'super_admin', email: founderEmail().toUpperCase() })).toBe(true);
    expect(isFounder({ role: 'super_admin', email: 'someone.else@edurankai.in' })).toBe(false);
    expect(isFounder({ role: 'admin', email: founderEmail() })).toBe(false);
    expect(isFounder({ email: founderEmail() })).toBe(false);
    expect(isFounder(null)).toBe(false);
    expect(isFounder(undefined)).toBe(false);
  });

  it('builds the viewer shape Patch 11 asks for, and claims no employee identity of its own', () => {
    const v = horizonViewerOf({ id: 'u1', role: 'super_admin', email: founderEmail(), name: 'Founder' });
    expect(v.userId).toBe('u1');
    expect(v.role).toBe('super_admin');
    // Null rather than a guess: this view resolves no org identity and must not invent one.
    expect(v.employeeId).toBeNull();
  });

  it('accepts only a real uuid as a person reference', () => {
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

// =================================================================================================
// THE EIGHTEEN SECTIONS
// =================================================================================================

describe('eighteen founder sections over twelve assembled-record sections', () => {
  it('are exactly eighteen, in the order the brief lists them', () => {
    expect(FOUNDER_SECTION_KEYS.length).toBe(18);
    expect(FOUNDER_SECTION_KEYS[0]).toBe('identity');
    expect(FOUNDER_SECTION_KEYS[1]).toBe('executive');
    expect(FOUNDER_SECTION_KEYS[17]).toBe('access_history');
    expect(FOUNDER_SECTIONS.length).toBe(18);
  });

  it('every section names what it is, and who owes it when it is empty', () => {
    for (const s of FOUNDER_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.blurb.length).toBeGreaterThan(20);
      expect(s.owedBy.length).toBeGreaterThan(3);
    }
  });

  it('reads only keys that exist in the contract this patch does not own', () => {
    for (const s of FOUNDER_SECTIONS) {
      if (s.from === null) continue;
      expect(HORIZON_SECTION_KEYS).toContain(s.from);
    }
    // Two sections come from outside the twelve and say so by carrying no key.
    const outside = FOUNDER_SECTIONS.filter((s) => s.from === null).map((s) => s.key);
    expect(outside).toEqual(['role_suitability', 'internal_mobility']);
  });

  it('deduplicates the keys it declares reading, so the access record is honest about scope', () => {
    const keys = horizonKeysRead();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('overview');
    expect(keys).toContain('audit_trail');
  });

  it('opens only two sections on first paint, so the densest page still opens fast', () => {
    const open = FOUNDER_SECTIONS.filter((s) => s.openByDefault).map((s) => s.key);
    expect(open).toEqual(['identity', 'executive']);
  });

  it('throws on an unknown section rather than returning a blank one', () => {
    expect(() => founderSectionDef('nonsense' as any)).toThrow();
    expect(founderSectionDef('sustainability').from).toBe('work_sustainability');
  });

  it('uses neutral terminology everywhere a founder can read it', () => {
    const strings = FOUNDER_SECTIONS.flatMap((s) => [s.title, s.blurb, s.owedBy]);
    for (const s of strings) {
      expect(screenTerminology(s).clean).toBe(true);
    }
    for (const n of NEVER_ON_THIS_SCREEN) {
      expect(screenTerminology(n.what + ' ' + n.because).clean).toBe(true);
    }
  });

  it('separates the computation from its interpretation, as two sections and not one', () => {
    const foundational = founderSectionDef('foundational_computation');
    const interpretation = founderSectionDef('professional_interpretation');
    expect(foundational.key).not.toBe(interpretation.key);
    expect(foundational.blurb).toContain('never presented as established science');
    expect(interpretation.blurb).toContain('separate object');
    expect(interpretation.blurb).toContain('outranked by demonstrated work');
  });

  it('says on the sustainability section that no health data reaches it', () => {
    const s = founderSectionDef('sustainability');
    expect(s.blurb).toContain('No health, wellness or absence-reason data');
    expect(s.blurb).toContain('describes a workload rather than a person');
  });
});

describe('what the founder view will never show', () => {
  it('names individual health data as beyond the founder, not merely beyond admins', () => {
    const health = NEVER_ON_THIS_SCREEN.find((n) => /health/i.test(n.what));
    expect(health).toBeTruthy();
    expect(health!.because).toContain('beyond the founder');
  });

  it('names legal hold, pay, protected attributes, monitoring and scores', () => {
    const all = NEVER_ON_THIS_SCREEN.map((n) => n.what).join(' | ');
    expect(all).toMatch(/legal-hold/i);
    expect(all).toMatch(/salary|payslip/i);
    expect(all).toMatch(/date of birth/i);
    expect(all).toMatch(/monitoring/i);
    expect(all).toMatch(/ranking/i);
  });

  it('gives every exclusion a reason and somewhere else to go', () => {
    for (const n of NEVER_ON_THIS_SCREEN) {
      expect(n.because.length).toBeGreaterThan(30);
      expect(n.where.length).toBeGreaterThan(3);
    }
  });
});

// =================================================================================================
// THE SEVEN QUESTIONS
// =================================================================================================

describe('the seven questions', () => {
  it('are seven, named, and recognised', () => {
    expect(QUESTIONS.length).toBe(7);
    expect(QUESTIONS).toEqual(['why', 'sources', 'records', 'who', 'when', 'action', 'outcome']);
    for (const q of QUESTIONS) expect(QUESTION_LABELS[q].length).toBeGreaterThan(3);
    expect(isQuestion('why')).toBe(true);
    expect(isQuestion('vibes')).toBe(false);
  });

  it('answers all seven from the signal itself, with no second read', () => {
    const answers = askAll(sig(), NONE);
    expect(answers.length).toBe(7);
    expect(answers.map((a) => a.question)).toEqual([...QUESTIONS]);
    for (const a of answers) expect(a.headline.length).toBeGreaterThan(15);
  });

  it('names the owning module when asked which sources', () => {
    const a = ask(sig(), 'sources');
    expect(a.lines[0].text).toBe('eims-evidence.ts');
    expect(a.lines[0].note).toContain('eims_evidence');
  });

  it('opens each record where it lives', () => {
    const a = ask(sig(), 'records');
    expect(a.lines.length).toBe(1);
    expect(a.lines[0].href).toBe('/portal/evidence');
    expect(a.lines[0].note).toContain('eims_evidence:e1');
  });

  it('never merges a confirmed record with a submitted one when asked who provided it', () => {
    const a = ask(sig({
      evidence: [
        ev({ sourceId: 'a', verificationStatus: 'accepted by a named verifier' }),
        ev({ sourceId: 'b', verificationStatus: 'accepted by a named verifier' }),
        ev({ sourceId: 'c', verificationStatus: 'as submitted, not yet reviewed' }),
      ],
    }), 'who');
    expect(a.lines.length).toBe(2);
    expect(a.lines[0].note).toContain('2 record(s)');
    expect(a.headline).toContain('never counted together');
  });

  it('reports undated records rather than placing them in the newest window', () => {
    const a = ask(sig({ evidence: [ev(), ev({ sourceId: 'b', occurredAt: null })] }), 'when');
    expect(a.lines[0].text).toContain('1 record(s) carry no usable date');
    expect(a.lines[0].text).toContain('rather than placed in the most recent window');
  });

  it('explains an absent action instead of rendering an empty panel', () => {
    const a = ask(sig(), 'action', NONE);
    expect(a.lines.length).toBe(0);
    expect(a.headline).toContain('No human decision names this signal');
    expect(a.headline).toContain('a decision is a human act');
  });

  it('explains an absent outcome as absent, never as "no outcome happened"', () => {
    const a = ask(sig(), 'outcome', NONE);
    expect(a.headline).toContain('no decision or intervention has been recorded');
  });

  it('links only the decisions that actually name this signal', () => {
    const linked: LinkedActions = {
      decisions: [decision(), decision({ id: 'd2', consideredSignalIds: ['some.other.signal'] })],
      interventions: [intervention()],
    };
    const a = ask(sig(), 'action', linked);
    expect(a.headline).toContain('1 recorded decision(s)');
    expect(a.headline).toContain('attribution, not causation');
    expect(a.lines.some((l) => l.text === 'Confirmed at the end of probation')).toBe(true);
  });

  it('says when a decision has not been communicated to the person it is about', () => {
    const linked: LinkedActions = {
      decisions: [decision({ subjectInformed: false })],
      interventions: [],
    };
    const a = ask(sig(), 'outcome', linked);
    expect(a.headline).toContain('NOT yet communicated');
    expect(a.lines[0].note).toBe('the person has NOT been told');
  });

  it('flags a decision recorded without a written reason', () => {
    const linked: LinkedActions = { decisions: [decision({ reason: null })], interventions: [] };
    const a = ask(sig(), 'action', linked);
    expect(a.lines[0].note).toContain('no written reason on record');
  });

  it('shows a disputed signal rather than withdrawing it', () => {
    const a = ask(sig({ disputed: true }), 'why');
    expect(a.lines.some((l) => /DISPUTED/.test(l.text))).toBe(true);
    expect(a.lines.some((l) => /kept on record and shown, not withdrawn/.test(l.text))).toBe(true);
  });

  it('says plainly that a signal with no evidence is the weakest thing here', () => {
    const bare = sig({ evidence: [], confidence: NO_CONFIDENCE });
    expect(ask(bare, 'sources').headline).toContain('weakest thing this system will show');
    expect(ask(bare, 'records').headline).toContain('cannot carry more weight than it does');
    expect(ask(bare, 'who').headline).toContain('no record is attached');
    expect(ask(bare, 'when').headline).toContain('cannot be checked against its evidence');
  });

  it('prints an unexplained confidence as unexplained rather than as reassurance', () => {
    const a = ask(sig({ confidence: { value: null, band: 'none', basis: '' } }), 'why');
    expect(a.lines.some((l) => /No working was recorded/.test(l.text))).toBe(true);
  });

  it('finds a signal by id and refuses a near match', () => {
    const s = sig();
    expect(findSignal([s], 'evidence.accepted')).toBe(s);
    expect(findSignal([s], 'evidence.accept')).toBeNull();
    expect(findSignal([], 'anything')).toBeNull();
  });

  it('prints dates that do not age behind a cache', () => {
    expect(dayLabel('2026-08-23T12:00:00.000Z')).toBe('23 Aug 2026');
    expect(dayLabel(null)).toBe('no date on record');
    expect(dayLabel('not a date')).toBe('no usable date on record');
  });
});

// =================================================================================================
// THE FIVE STATUSES STAY FIVE
// =================================================================================================

describe('an empty section and a failed read never share a sentence', () => {
  it('keeps the contract meanings distinct', () => {
    const empty = SECTION_STATUS_MEANING.empty;
    const unreadable = SECTION_STATUS_MEANING.unreadable;
    const notSupplied = SECTION_STATUS_MEANING.not_supplied;
    expect(empty).not.toBe(unreadable);
    expect(empty).not.toBe(notSupplied);
    expect(unreadable).toContain('INCOMPLETE');
    expect(notSupplied).toContain('has not registered a provider');
  });
});
