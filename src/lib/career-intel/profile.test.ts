import { describe, it, expect } from 'vitest';
import {
  recordAnswer, confirmDimension, confirmTag, addTag, removeResponse, rebuild,
  skipQuestion, resetProfile, parseProfile,
} from './profile';
import { emptyProfile, mergeSignal, PROFILE_VERSION, type Signal } from './dimensions';

const sig = (over: Partial<Signal> = {}): Signal => ({
  value: 0.8, confidence: 0.6, source: 'inferred', confirmation: 'unconfirmed',
  modelVersion: 'x', at: '2026-01-01T00:00:00.000Z', from: ['r1'], ...over,
});

describe('the person\'s own words are kept, separately from our reading of them', () => {
  it('stores the sentence exactly as typed', () => {
    const TEXT = "  I like MATHS, coding & 'hard' problems!!  ";
    const r = recordAnswer(emptyProfile(), { text: TEXT });
    expect(r.profile.rawResponses[0].text).toBe(TEXT);
  });

  it('stores the interpretation somewhere else entirely', () => {
    const r = recordAnswer(emptyProfile(), { text: 'I want to do research.' });
    expect(r.profile.dimensions.research_orientation).toBeDefined();
    expect(r.profile.rawResponses[0].text).toBe('I want to do research.');
  });

  it('stamps which interpreter read it, so a later one knows it has not', () => {
    const r = recordAnswer(emptyProfile(), { text: 'I want to build things.' });
    expect(r.profile.rawResponses[0].modelVersion).toBeTruthy();
  });
});

describe('a verdict from the person outranks a later guess', () => {
  it('does not let an inference overwrite something they confirmed', () => {
    const confirmed = sig({ confirmation: 'confirmed', value: 0.9, confidence: 1 });
    const guess = sig({ value: 0.1, confidence: 0.9, source: 'inferred' });
    expect(mergeSignal(confirmed, guess).value).toBe(0.9);
  });

  it('does not let an inference revive something they rejected', () => {
    const rejected = sig({ confirmation: 'rejected', value: 0.9, confidence: 1 });
    expect(mergeSignal(rejected, sig({ source: 'inferred' })).confirmation).toBe('rejected');
  });

  it('keeps a rejection rather than deleting it, so it cannot be re-inferred', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I want to do research.' }).profile;
    p = confirmDimension(p, 'research_orientation', 'reject');
    p = recordAnswer(p, { text: 'Research is interesting to me.' }).profile;
    expect(p.dimensions.research_orientation.confirmation).toBe('rejected');
  });

  it('excludes a rejected signal from everything downstream', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I like AI.' }).profile;
    expect(p.interests.map((t) => t.key)).toContain('ARTIFICIAL_INTELLIGENCE');
    p = confirmTag(p, 'interests', 'ARTIFICIAL_INTELLIGENCE', 'reject');
    expect(p.interests.find((t) => t.key === 'ARTIFICIAL_INTELLIGENCE')!.confirmation).toBe('rejected');
  });

  it('lets somebody adjust a value we got wrong', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I prefer quiet.' }).profile;
    p = confirmDimension(p, 'deep_focus', 'adjust', 0.3);
    expect(p.dimensions.deep_focus.value).toBe(0.3);
    expect(p.dimensions.deep_focus.confirmation).toBe('adjusted');
  });
});

describe('two sentences pointing the same way, and two pointing opposite ways', () => {
  it('grows more confident on agreement', () => {
    const a = sig({ value: 0.8, confidence: 0.5 });
    const b = sig({ value: 0.82, confidence: 0.5 });
    expect(mergeSignal(a, b).confidence).toBeGreaterThan(0.5);
  });

  it('grows LESS confident on contradiction, rather than more', () => {
    const a = sig({ value: 0.9, confidence: 0.6 });
    const b = sig({ value: 0.1, confidence: 0.6 });
    expect(mergeSignal(a, b).confidence).toBeLessThan(0.6);
  });
});

describe('removing something really removes it', () => {
  it('drops the sentence and the conclusion drawn only from it', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I want to do research.' }).profile;
    const id = p.rawResponses[0].id;
    p = recordAnswer(p, { text: 'I have used Python.' }).profile;
    expect(p.dimensions.research_orientation).toBeDefined();

    p = removeResponse(p, id);
    expect(p.rawResponses.map((r) => r.id)).not.toContain(id);
    expect(p.dimensions.research_orientation).toBeUndefined();
    // What came from the OTHER sentence survives.
    expect(p.skills.map((s) => s.key)).toContain('python');
  });

  it('is a no-op for an id that is not there', () => {
    const p = recordAnswer(emptyProfile(), { text: 'I like AI.' }).profile;
    expect(removeResponse(p, 'nope')).toBe(p);
  });

  it('leaves nothing behind on a reset', () => {
    const p = resetProfile();
    expect(p.rawResponses).toEqual([]);
    expect(p.dimensions).toEqual({});
    expect(p.interests).toEqual([]);
    expect(p.personal).toBeNull();
  });
});

describe('re-reading stored words with a newer interpreter', () => {
  it('rebuilds the interpretation from the raw responses', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I want to build distributed systems.' }).profile;
    const before = p.dimensions.implementation.value;
    p = { ...p, dimensions: { ...p.dimensions, implementation: { ...p.dimensions.implementation, value: 0.01 } } };
    p = rebuild(p);
    expect(p.dimensions.implementation.value).toBeCloseTo(before, 6);
  });

  it('does not overrule a decision the person made', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I want to do research.' }).profile;
    p = confirmDimension(p, 'research_orientation', 'reject');
    p = rebuild(p);
    expect(p.dimensions.research_orientation.confirmation).toBe('rejected');
  });

  it('keeps a tag the person added by hand', () => {
    let p = addTag(emptyProfile(), 'interests', 'ORIGAMI', 'Origami');
    p = recordAnswer(p, { text: 'I like AI.' }).profile;
    p = rebuild(p);
    expect(p.interests.map((t) => t.key)).toContain('ORIGAMI');
  });
});

describe('an avoidance and an interest for the same thing cannot both stand', () => {
  it('drops the interest when they say they do not want it', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I like finance.' }).profile;
    expect(p.interests.map((t) => t.key)).toContain('FINANCE');
    p = recordAnswer(p, { text: 'Actually I am not interested in finance.' }).profile;
    expect(p.interests.map((t) => t.key)).not.toContain('FINANCE');
    expect(p.avoid.map((t) => t.key)).toContain('FINANCE');
  });
});

describe('skipping', () => {
  it('records the skip and marks the question asked, so it never returns', () => {
    const p = skipQuestion(emptyProfile(), 'direction.kind');
    expect(p.skipped).toContain('direction.kind');
    expect(p.asked).toContain('direction.kind');
  });
});

describe('parseProfile treats an incoming document as hostile', () => {
  it('turns rubbish into an empty profile instead of throwing', () => {
    for (const junk of [null, undefined, 0, '', 'x', [], true, { dimensions: 'no' }]) {
      expect(() => parseProfile(junk)).not.toThrow();
    }
    expect(parseProfile(null).profileVersion).toBe(PROFILE_VERSION);
  });

  it('caps every list so a public endpoint cannot be handed unbounded work', () => {
    const huge = {
      rawResponses: Array.from({ length: 500 }, (_, i) => ({ id: 'r' + i, text: 'x'.repeat(9000), at: '2026-01-01', selected: [] })),
      interests: Array.from({ length: 500 }, (_, i) => ({ key: 'k' + i, label: 'l' })),
      dimensions: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['d' + i, { value: 1 }])),
      asked: Array.from({ length: 500 }, (_, i) => 'q' + i),
    };
    const p = parseProfile(huge);
    expect(p.rawResponses.length).toBeLessThanOrEqual(40);
    expect(p.rawResponses[0].text.length).toBeLessThanOrEqual(2000);
    expect(p.interests.length).toBeLessThanOrEqual(30);
    expect(Object.keys(p.dimensions).length).toBeLessThanOrEqual(60);
    expect(p.asked.length).toBeLessThanOrEqual(40);
  });

  it('refuses a dimension key that is not a plain identifier', () => {
    const p = parseProfile({ dimensions: { "drop table': 1": { value: 1, confidence: 1 } } });
    expect(Object.keys(p.dimensions)).toEqual([]);
  });

  it('clamps values that arrive outside their range', () => {
    const p = parseProfile({ dimensions: { autonomy: { value: 99, confidence: -4 } } });
    expect(p.dimensions.autonomy.value).toBe(1);
    expect(p.dimensions.autonomy.confidence).toBe(0);
  });

  it('cannot be handed a confirmation or a source it does not know', () => {
    const p = parseProfile({ dimensions: { autonomy: { value: 0.5, confidence: 0.5, confirmation: 'divine', source: 'oracle' } } });
    expect(p.dimensions.autonomy.confirmation).toBe('unconfirmed');
    expect(p.dimensions.autonomy.source).toBe('inferred');
  });

  it('always marks the personal block excluded from matching, whatever arrives', () => {
    const p = parseProfile({ personal: { wake: 'before5', heightCm: 175, excludedFromMatching: false } });
    expect(p.personal!.excludedFromMatching).toBe(true);
  });

  it('bounds a measurement that arrived out of range rather than storing it', () => {
    // It comes off a public endpoint carrying whatever a browser sent. A number outside human
    // range is not a value to correct towards — it is a value to refuse.
    const p = parseProfile({ personal: { heightCm: 9000, weightKg: -4, note: 'x' } });
    expect(p.personal!.heightCm).toBeNull();
    expect(p.personal!.weightKg).toBeNull();
  });

  it('drops the birth date and star sign an older build stored', () => {
    // THE MIGRATION, AND IT IS A DELETION. A profile written before the astrology layer was
    // removed carries `reflection: { birthDate, sign }`. parseProfile does not read that key, so
    // the first load after this change forgets it rather than carrying a birth date forward into
    // a field nothing reads.
    const p = parseProfile({ reflection: { birthDate: '1999-07-14', sign: 'cancer', excludedFromMatching: true } });
    expect(p.personal).toBeNull();
    expect(JSON.stringify(p)).not.toContain('1999-07-14');
    expect(JSON.stringify(p)).not.toContain('cancer');
  });

  it('round-trips a real profile through JSON without losing a verdict', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I want AI research with Python.' }).profile;
    p = confirmDimension(p, 'research_orientation', 'confirm');
    const back = parseProfile(JSON.parse(JSON.stringify(p)));
    expect(back.dimensions.research_orientation.confirmation).toBe('confirmed');
    expect(back.rawResponses[0].text).toBe('I want AI research with Python.');
    expect(back.skills.map((s) => s.key)).toContain('python');
  });
});
