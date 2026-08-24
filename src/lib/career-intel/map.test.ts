import { describe, it, expect } from 'vitest';
import { buildCareerMap, MAP_BANDS, MAP_CAPTION } from './map';
import { emptyProfile } from './dimensions';
import { recordAnswer, addTag, confirmTag } from './profile';

const from = (text: string) => recordAnswer(emptyProfile(), { text }).profile;

describe('a map needs something to map', () => {
  it('is not meaningful for somebody who has said nothing', () => {
    const m = buildCareerMap(emptyProfile());
    expect(m.meaningful).toBe(false);
    expect(m.caption).not.toBe(MAP_CAPTION);
  });

  it('is not meaningful on a single mention', () => {
    expect(buildCareerMap(from('I like AI.')).meaningful).toBe(false);
  });

  it('becomes meaningful once there is more than one direction', () => {
    const p = from('I like artificial intelligence, mathematics and research.');
    const m = buildCareerMap(p);
    expect(m.meaningful).toBe(true);
    expect(m.caption).toBe(MAP_CAPTION);
  });
});

describe('what goes on it, and why', () => {
  it('puts a confirmed interest in the band for things they keep returning to', () => {
    let p = from('I like artificial intelligence and mathematics.');
    p = confirmTag(p, 'interests', 'ARTIFICIAL_INTELLIGENCE', 'confirm');
    const node = buildCareerMap(p).nodes.find((n) => n.key === 'ARTIFICIAL_INTELLIGENCE');
    expect(node!.band).toBe('strong');
  });

  it('gives every node a stated reason for being there', () => {
    const m = buildCareerMap(from('I like artificial intelligence, mathematics and research.'));
    for (const n of m.nodes) expect(n.because.length).toBeGreaterThan(10);
  });

  it('gives every node a real destination, so it works with no script', () => {
    const m = buildCareerMap(from('I like artificial intelligence, mathematics and research.'));
    for (const n of m.nodes) expect(n.href.startsWith('/careers/opportunities?')).toBe(true);
  });

  it('explains an adjacent domain as a fact about the field, not a claim about the person', () => {
    const p = from('I like reasoning problems through carefully and working with abstract ideas. I enjoy research and mathematics.');
    const adjacent = buildCareerMap(p).nodes.filter((n) => n.band === 'adjacent');
    expect(adjacent.length).toBeGreaterThan(0);
    for (const n of adjacent) {
      expect(n.because).toMatch(/you have not mentioned this|close to what you described/i);
      // A claim about the domain's demands, never a verdict like "you are an analytical person".
      expect(n.because).not.toMatch(/you are (an?|the) /i);
    }
  });

  it('never suggests something they said they did not want', () => {
    const p = from('I like coding and building systems. I am not interested in finance.');
    const keys = buildCareerMap(p).nodes.map((n) => n.key);
    expect(keys).not.toContain('FINANCE');
  });

  it('never repeats a domain they already named as an adjacent suggestion', () => {
    const p = from('I like artificial intelligence, mathematics and research.');
    const nodes = buildCareerMap(p).nodes;
    const named = nodes.filter((n) => n.band !== 'adjacent').map((n) => n.key);
    const adjacent = nodes.filter((n) => n.band === 'adjacent').map((n) => n.key);
    for (const k of adjacent) expect(named).not.toContain(k);
  });
});

describe('it stays small', () => {
  it('does not turn into a list of every domain we know about', () => {
    let p = from('I like physics, chemistry, biology, materials, quantum and aerospace.');
    ['ENERGY', 'ENVIRONMENT', 'COSMOLOGY', 'ASTROPHYSICS'].forEach((k, i) => {
      p = addTag(p, 'interests', k, 'Extra ' + i);
    });
    expect(buildCareerMap(p).nodes.length).toBeLessThanOrEqual(11);
  });

  it('names its bands in reading order', () => {
    expect(MAP_BANDS.map((b) => b.key)).toEqual(['strong', 'emerging', 'adjacent']);
  });
});

describe('the map cannot become the back door for the exploration-only layers', () => {
  it('does not put a domain on the map because of an energy rhythm', () => {
    const withRhythm = from('I am a night owl who works in intense bursts.');
    const withoutRhythm = emptyProfile();
    expect(buildCareerMap(withRhythm).nodes.length).toBe(buildCareerMap(withoutRhythm).nodes.length);
  });

  it('ignores the optional personal block entirely', () => {
    const base = from('I like artificial intelligence, mathematics and research.');
    const withPersonal = {
      ...base,
      personal: {
        wake: 'before5', nature: ['calm'], heightCm: 175, weightKg: 68, note: 'anything',
        excludedFromMatching: true as const, at: base.updatedAt,
      },
    };
    expect(JSON.stringify(buildCareerMap(withPersonal))).toBe(JSON.stringify(buildCareerMap(base)));
  });
});
