// src/lib/hr-intelligence/types.test.ts — THE RULES THAT ARE SUPPOSED TO BE UNBREAKABLE, BROKEN AT.
//
// Every test here tries to do the thing the module claims cannot be done. A rule that is only a
// comment survives exactly one refactor; these are the ones that have to survive the next one.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  hrSignal,
  confidenceFrom,
  strengthFrom,
  sortByWeight,
  isRenderable,
  weightOf,
  decisionWeight,
  outranks,
  strengthOfAssertion,
  refuseSource,
  isAdmissibleSource,
  ADMISSIBLE_SOURCES,
  SECTION_KEYS,
  HR_ACTION_KINDS,
  sectionLabel,
  sectionSubtitle,
  actionLabel,
  actionEffect,
  registerFoundationalProvider,
  foundationalProvider,
  clearFoundationalProvider,
  toPortableSignal,
  type EvidenceRef,
  type SignalInput,
} from './types';

const input = (over: Partial<SignalInput> = {}): SignalInput => ({
  ownerModule: 'src/lib/performance.ts',
  table: 'hr_feedback',
  rowsRead: 3,
  ...over,
});

const ev = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  recordId: 'hr_feedback:1',
  table: 'hr_feedback',
  ownerModule: 'the feedback module',
  summary: 'A note.',
  providedBy: 'Asha',
  providedByUserId: 'u1',
  assertion: 'provided',
  occurredAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// =================================================================================================
// THE CLOSED SOURCE LIST
// =================================================================================================

describe('admissible sources', () => {
  it('refuses a signal built on a table nobody decided HR may read', () => {
    expect(() => hrSignal({
      id: 's', section: 'behaviour_trends', label: 'x',
      value: { kind: 'count', number: 1, unit: 'x', display: '1' },
      processing: 'p',
      inputs: [input({ table: 'hr_clock_events' })],
    })).toThrow(/not on the admissible list/i);
  });

  it('refuses it via an evidence row too, not only via an input', () => {
    expect(() => hrSignal({
      id: 's', section: 'behaviour_trends', label: 'x',
      value: { kind: 'count', number: 1, unit: 'x', display: '1' },
      processing: 'p',
      inputs: [input()],
      evidence: [ev({ table: 'wellness_cycles' as any })],
    })).toThrow(/not on the admissible list/i);
  });

  it('keeps surveillance and sensitive tables off the list', () => {
    const banned = [
      'hr_clock_events',
      'wellness_cycles',
      'wellness_consults',
      'chat_messages',
      'sessions',
      'user_sessions',
      'hr_leave_request',
    ];
    for (const t of banned) {
      expect(isAdmissibleSource(t)).toBe(false);
      expect(refuseSource(t)).toBeTruthy();
    }
  });

  it('names what it refused, so a developer is told rather than puzzled', () => {
    const message = refuseSource('hr_clock_events') || '';
    expect(message).toContain('hr_clock_events');
    expect(message).toContain('policy decision');
  });

  it('holds no duplicate entries', () => {
    expect(new Set(ADMISSIBLE_SOURCES).size).toBe(ADMISSIBLE_SOURCES.length);
  });
});

// =================================================================================================
// THE FIGURE THAT CANNOT BE BUILT
// =================================================================================================

describe('a figure nothing supports', () => {
  it('will not render a count with no evidence and no input that looked', () => {
    const s = hrSignal({
      id: 's', section: 'feedback', label: 'Notes',
      value: { kind: 'count', number: 12, unit: 'notes', display: '12 notes' },
      processing: 'p',
      inputs: [],
      evidence: [],
    });
    expect(s.value.kind).toBe('absent');
    expect(s.value.number).toBeNull();
    expect(s.value.display).toMatch(/nothing on record supports this figure/i);
  });

  it('KEEPS a zero that was actually looked for — the absence is a finding', () => {
    const s = hrSignal({
      id: 's', section: 'feedback', label: 'Notes',
      value: { kind: 'count', number: 0, unit: 'notes', display: 'No feedback on record.' },
      processing: 'p',
      inputs: [input({ rowsRead: 0 })],
      evidence: [],
    });
    expect(s.value.kind).toBe('count');
    expect(s.value.number).toBe(0);
  });

  it('replaces a figure from a failed read with the reason, never with an empty answer', () => {
    const s = hrSignal({
      id: 's', section: 'feedback', label: 'Notes',
      value: { kind: 'count', number: 0, unit: 'notes', display: 'No feedback on record.' },
      processing: 'p',
      inputs: [input({ unreadable: 'relation "hr_feedback" does not exist' })],
      evidence: [],
    });
    expect(s.value.kind).toBe('absent');
    expect(s.unreadable).toContain('does not exist');
    expect(s.value.display).toMatch(/would be a lie about this person/i);
    expect(s.confidence.level).toBe('none');
  });

  it('lets a text value through without evidence, because a sentence is not a measurement', () => {
    const s = hrSignal({
      id: 's', section: 'role_status', label: 'Role',
      value: { kind: 'text', number: null, unit: null, display: 'Engineer' },
      processing: 'p',
      inputs: [input({ table: 'hr_employees', rowsRead: 1 })],
    });
    expect(s.value.kind).toBe('text');
  });

  it('renders the refusal even though it will not render the figure', () => {
    const s = hrSignal({
      id: 's', section: 'feedback', label: 'Notes',
      value: { kind: 'count', number: 5, unit: 'notes', display: '5' },
      processing: 'p',
    });
    expect(isRenderable(s)).toBe(true);
    expect(s.value.kind).toBe('absent');
  });
});

// =================================================================================================
// ONE PERSON IS NOT AGREEMENT
// =================================================================================================

describe('confidence', () => {
  it('caps a single stated source at low, however many notes it wrote', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev({ recordId: 'hr_feedback:' + i }));
    const c = confidenceFrom(many, [input({ rowsRead: 20 })]);
    expect(c.level).toBe('low');
    expect(c.why).toMatch(/one person stating something is not agreement/i);
  });

  it('does not reach high on stated evidence alone, even from many authors', () => {
    const authors = Array.from({ length: 6 }, (_, i) =>
      ev({ recordId: 'hr_feedback:' + i, providedByUserId: 'u' + i, providedBy: 'Author ' + i }));
    expect(confidenceFrom(authors, [input()]).level).toBe('low');
  });

  it('reaches high only with two verifications, or one plus two platform records', () => {
    const twoVerified = [ev({ assertion: 'verified', providedByUserId: 'a' }), ev({ assertion: 'verified', providedByUserId: 'b' })];
    expect(confidenceFrom(twoVerified, [input()]).level).toBe('high');

    const onePlusTwo = [
      ev({ assertion: 'verified', providedByUserId: 'a' }),
      ev({ assertion: 'factual', providedByUserId: 'b' }),
      ev({ assertion: 'factual', providedByUserId: 'c' }),
    ];
    expect(confidenceFrom(onePlusTwo, [input()]).level).toBe('high');
  });

  it('is none when a source failed, never low', () => {
    expect(confidenceFrom([ev()], [input({ unreadable: 'boom' })]).level).toBe('none');
  });

  it('treats an empty-but-read source as a finding, with a sentence saying so', () => {
    const c = confidenceFrom([], [input({ rowsRead: 0 })]);
    expect(c.level).toBe('low');
    expect(c.why).toMatch(/the absence is the finding/i);
  });
});

// =================================================================================================
// DEMONSTRATED WORK OUTRANKS EVERYTHING DERIVED
// =================================================================================================

describe('evidence strength is arithmetic, not a label', () => {
  it('ranks demonstrated above stated above derived', () => {
    expect(decisionWeight('demonstrated')).toBeGreaterThan(decisionWeight('stated'));
    expect(decisionWeight('stated')).toBeGreaterThan(decisionWeight('derived'));
    expect(outranks('demonstrated', 'derived')).toBe(true);
    expect(outranks('derived', 'stated')).toBe(false);
  });

  it('maps each assertion onto exactly one strength', () => {
    expect(strengthOfAssertion('verified')).toBe('demonstrated');
    expect(strengthOfAssertion('factual')).toBe('demonstrated');
    expect(strengthOfAssertion('provided')).toBe('stated');
    expect(strengthOfAssertion('calculated')).toBe('derived');
    expect(strengthOfAssertion('inferred')).toBe('derived');
  });

  it('takes a signal\'s strength from its strongest evidence, and a caller cannot pass one in', () => {
    expect(strengthFrom([ev({ assertion: 'inferred' }), ev({ assertion: 'verified' })])).toBe('demonstrated');
    expect(strengthFrom([])).toBe('derived');

    const s = hrSignal({
      id: 's', section: 'skill_gaps', label: 'x',
      value: { kind: 'text', number: null, unit: null, display: 'x' },
      processing: 'p',
      inputs: [input({ table: 'hr_employee_skills' })],
      evidence: [ev({ table: 'hr_employee_skills', assertion: 'factual' })],
      // There is no `strength` field on SignalDraft to pass, which is the point of this test.
    } as any);
    expect(s.strength).toBe('demonstrated');
  });

  it('never sorts a derived figure above demonstrated work', () => {
    const derived = hrSignal({
      id: 'derived', section: 'feedback', label: 'derived',
      value: { kind: 'count', number: 1, unit: 'x', display: '1' },
      processing: 'p', inputs: [input()], evidence: [ev({ assertion: 'inferred' })],
    });
    const demonstrated = hrSignal({
      id: 'demonstrated', section: 'feedback', label: 'demonstrated',
      value: { kind: 'count', number: 1, unit: 'x', display: '1' },
      processing: 'p', inputs: [input()], evidence: [ev({ assertion: 'verified' })],
    });
    const sorted = sortByWeight([derived, demonstrated]);
    expect(sorted[0].id).toBe('demonstrated');
    expect(weightOf(demonstrated)).toBeGreaterThan(weightOf(derived));
  });

  it('sorts an absent value last, because a refusal is not a finding to lead with', () => {
    const absent = hrSignal({
      id: 'absent', section: 'feedback', label: 'absent',
      value: { kind: 'count', number: 3, unit: 'x', display: '3' },
      processing: 'p',
    });
    const real = hrSignal({
      id: 'real', section: 'feedback', label: 'real',
      value: { kind: 'count', number: 1, unit: 'x', display: '1' },
      processing: 'p', inputs: [input()], evidence: [ev()],
    });
    expect(sortByWeight([absent, real])[0].id).toBe('real');
  });
});

// =================================================================================================
// EVERY SIGNAL CARRIES THE WHOLE ENVELOPE
// =================================================================================================

describe('the envelope', () => {
  it('fills inputs, processing, evidence, confidence and a timestamp on every signal', () => {
    const s = hrSignal({
      id: 's', section: 'feedback', label: 'x',
      value: { kind: 'count', number: 2, unit: 'notes', display: '2' },
      processing: 'Counted hr_feedback rows.',
      inputs: [input()],
      evidence: [ev(), ev({ recordId: 'hr_feedback:2', providedByUserId: 'u2' })],
    });
    expect(s.inputs.length).toBeGreaterThan(0);
    expect(s.processing).toBeTruthy();
    expect(s.evidence.length).toBe(2);
    expect(s.confidence.why).toBeTruthy();
    expect(Date.parse(s.computedAt)).not.toBeNaN();
    expect(s.decisionUse).toBe('advisory');
  });

  it('defaults decisionUse to advisory and never to anything decisive', () => {
    const s = hrSignal({
      id: 's', section: 'promotion_readiness', label: 'x',
      value: { kind: 'text', number: null, unit: null, display: 'x' },
      processing: 'p', inputs: [input()],
    });
    expect(['not_a_decision_input', 'advisory', 'supporting']).toContain(s.decisionUse);
  });

  it('exposes the same six fields the sibling views carry', () => {
    const s = hrSignal({
      id: 's', section: 'feedback', label: 'x',
      value: { kind: 'text', number: null, unit: null, display: 'x' },
      processing: 'p', inputs: [input()],
    });
    const p = toPortableSignal(s);
    for (const k of ['id', 'label', 'value', 'processing', 'inputs', 'evidence', 'confidence', 'computedAt']) {
      expect(Object.prototype.hasOwnProperty.call(p, k)).toBe(true);
    }
  });
});

// =================================================================================================
// THE FOUNDATIONAL BOUNDARY
// =================================================================================================

describe('the foundational computation provider', () => {
  beforeEach(() => clearFoundationalProvider());

  it('ships with no provider registered', () => {
    expect(foundationalProvider()).toBeNull();
  });

  it('refuses a provider whose label uses the vocabulary of divination', () => {
    for (const label of ['Vedic Astrology Engine', 'Natal chart reader', 'Kundli service', 'Zodiac insights']) {
      const r = registerFoundationalProvider({ id: 'p', label, read: async () => ({ state: 'no_provider', sentence: '' }) });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/neutral term is "foundational computation"/i);
      expect(foundationalProvider()).toBeNull();
    }
  });

  it('accepts one in neutral terminology', () => {
    const r = registerFoundationalProvider({
      id: 'p1',
      label: 'Foundational computation provider',
      read: async () => ({ state: 'no_provider', sentence: 'none' }),
    });
    expect(r.ok).toBe(true);
    expect(foundationalProvider()?.id).toBe('p1');
  });

  it('refuses a provider with no read()', () => {
    const r = registerFoundationalProvider({ id: 'p2', label: 'Fine name' } as any);
    expect(r.ok).toBe(false);
  });
});

// =================================================================================================
// COPY RULES
// =================================================================================================

describe('the words on the screen', () => {
  it('gives every section a label and a subtitle, from functions and not typed maps', () => {
    for (const k of SECTION_KEYS) {
      expect(sectionLabel(k)).not.toBe('Section');
      expect(sectionSubtitle(k).length).toBeGreaterThan(10);
    }
  });

  it('gives every action a label and says what pressing it does', () => {
    for (const k of HR_ACTION_KINDS) {
      expect(actionLabel(k)).not.toBe('Action');
      expect(actionEffect(k).length).toBeGreaterThan(20);
    }
  });

  it('uses no emoji anywhere in the module\'s copy', () => {
    const text = [
      ...SECTION_KEYS.map(sectionLabel),
      ...SECTION_KEYS.map(sectionSubtitle),
      ...HR_ACTION_KINDS.map(actionLabel),
      ...HR_ACTION_KINDS.map(actionEffect),
    ].join(' ');
    // Emoji live above the BMP or in the symbol blocks; neither belongs in this product's copy.
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).toBe(false);
  });

  it('names no competitor or outside company in its copy', () => {
    const text = [
      ...SECTION_KEYS.map(sectionSubtitle),
      ...HR_ACTION_KINDS.map(actionEffect),
    ].join(' ').toLowerCase();
    for (const name of ['coursera', 'udemy', 'edx', 'linkedin', 'workday', 'sap', 'oracle', 'google']) {
      expect(text).not.toContain(name);
    }
  });

  it('uses no divination vocabulary in any user-facing string', () => {
    const text = [
      ...SECTION_KEYS.map(sectionLabel),
      ...SECTION_KEYS.map(sectionSubtitle),
      ...HR_ACTION_KINDS.map(actionLabel),
      ...HR_ACTION_KINDS.map(actionEffect),
    ].join(' ').toLowerCase();
    for (const word of ['astrolog', 'horoscope', 'zodiac', 'natal', 'kundli', 'jyotish']) {
      expect(text).not.toContain(word);
    }
  });
});
