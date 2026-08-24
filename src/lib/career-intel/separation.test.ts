// separation.test.ts — THE BOUNDARY TESTS.
//
// Everything else in this suite tests behaviour. This file tests STRUCTURE, by reading the source
// of the ranking and retrieval modules, because the promises being kept here are of the form
// "this code cannot reach that data" and behaviour tests can only ever sample that.
//
// The three promises:
//
//   1. The optional personal layer (when their day starts, their own description of their nature,
//      height and weight) never affects which opportunities somebody is shown.
//   2. Self-reported behavioural tendencies and energy rhythm are not ranking inputs.
//   3. Nothing about a person makes a posting unreachable.
//
// A behaviour test for #1 would assert that one particular profile with a height on it ranks the
// same as one without. That passes right up until somebody adds a second code path. Reading the
// imports is the only check that stays true.
//
// BOTH MODULE NAMES ARE CHECKED. This layer used to be reflection.ts and held a star sign; it is
// now personal.ts and holds height and weight, which is a MORE dangerous thing for a ranker to be
// able to read, not a less dangerous one. The old name is still asserted against so that a restored
// file or a stale import cannot reopen the door under a name nobody is watching.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELEVANCE_GROUPS, EXPLORATION_ONLY_GROUPS, DIMENSIONS, relevanceDimensions,
  explorationDimensions, emptyProfile, isRelevanceDimension,
} from './dimensions';
import { evaluate, type MatchableRole } from './rank';
import { buildPersonal } from './personal';
import { recordAnswer } from './profile';

const HERE = join(process.cwd(), 'src', 'lib', 'career-intel');
const read = (f: string) => readFileSync(join(HERE, f), 'utf8');

const PERSONAL_IMPORT = /from\s+['"]\.\/(personal|reflection)['"]/;

describe('the optional personal layer is unreachable from matching', () => {
  it('is not imported by the ranker', () => {
    expect(read('rank.ts')).not.toMatch(PERSONAL_IMPORT);
  });

  it('is not imported by retrieval either', () => {
    expect(read('retrieve.ts')).not.toMatch(PERSONAL_IMPORT);
  });

  it('is not imported by the explanation builder', () => {
    expect(read('explain.ts')).not.toMatch(PERSONAL_IMPORT);
  });

  it('is not imported by the career map either', () => {
    // The map is the newest thing that reads a profile and puts domains in front of somebody. It is
    // exactly the kind of surface an optional personal layer drifts into, so it is named here.
    expect(read('map.ts')).not.toMatch(PERSONAL_IMPORT);
  });

  it('never lets a body measurement reach the ranking code at all', () => {
    // The named check, because this is the field that would do real harm. A ranker that can read a
    // weight is one line away from preferring a body over a person.
    for (const f of ['rank.ts', 'retrieve.ts', 'explain.ts', 'map.ts']) {
      expect(read(f), f).not.toMatch(/heightCm|weightKg|profile\.personal/);
    }
  });

  it('produces an identical ranking with and without the personal block', () => {
    const role: MatchableRole = {
      id: 'r1', slug: 'r1', title: 'Research Engineer', level: 'Mid',
      functionText: 'AI research systems', engagementType: 'Full-Time',
      skillCategories: ['ARTIFICIAL_INTELLIGENCE'], skills: ['Python'],
      researchClassification: 'APPLIED_ENGINEERING', careerLevel: 4,
    };
    const base = recordAnswer(emptyProfile(), { text: 'I want AI work with Python.' }).profile;
    const personal = buildPersonal({ wake: 'before5', nature: ['calm'], heightCm: 175, weightKg: 68 });
    const withPersonal = { ...base, personal };
    expect(withPersonal.personal).not.toBeNull();
    expect(evaluate(withPersonal, role).total).toBe(evaluate(base, role).total);
  });

  it('marks itself excluded from matching in the stored document', () => {
    expect(buildPersonal({ heightCm: 175 })!.excludedFromMatching).toBe(true);
  });

  it('stores nothing at all when the form was left empty', () => {
    // An empty block would render as a heading with nothing under it, and would also read as
    // "we hold something about you" when we hold nothing.
    expect(buildPersonal({ wake: '', nature: [], heightCm: '', weightKg: '', note: '  ' })).toBeNull();
  });

  it('refuses a measurement that is not one', () => {
    expect(buildPersonal({ heightCm: 9000 })).toBeNull();
    expect(buildPersonal({ weightKg: 'tall' })).toBeNull();
  });

  it('holds no birth date, and no star sign, anywhere in the layer', () => {
    // What this layer replaced. A careers page has no use for a date of birth, and the answer it
    // gave back was decided by the calendar rather than by anything the person said.
    const src = read('personal.ts');
    expect(src).not.toMatch(/birthDate/);
    expect(src).not.toMatch(/capricorn|aquarius|scorpio|zodiac/i);
  });
});

describe('the exploration-only groups are not ranking inputs', () => {
  it('names exactly the two groups that may rank', () => {
    // This assertion is the point of the constant. Widening it is a decision somebody has to make
    // here, in a diff, rather than by adding a group to a list somewhere else.
    expect([...RELEVANCE_GROUPS]).toEqual(['workstyle', 'cognitive']);
    expect([...EXPLORATION_ONLY_GROUPS]).toEqual(['rhythm', 'behavioural']);
  });

  it('accounts for every dimension in exactly one of the two lists', () => {
    for (const d of DIMENSIONS) {
      const inRelevance = RELEVANCE_GROUPS.includes(d.group);
      const inExploration = EXPLORATION_ONLY_GROUPS.includes(d.group);
      expect(inRelevance !== inExploration, d.key).toBe(true);
    }
  });

  it('hides rhythm and behavioural signals from the ranker\'s only door', () => {
    let p = recordAnswer(emptyProfile(), { text: 'I am a night owl and I always start things without being asked.' }).profile;
    expect(Object.keys(p.dimensions)).toContain('evening_energy');
    expect(Object.keys(p.dimensions)).toContain('initiative');
    expect(Object.keys(relevanceDimensions(p))).not.toContain('evening_energy');
    expect(Object.keys(relevanceDimensions(p))).not.toContain('initiative');
    expect(Object.keys(explorationDimensions(p))).toContain('evening_energy');
  });

  it('ranks a posting identically whether or not a rhythm was stated', () => {
    const role: MatchableRole = {
      id: 'r1', slug: 'r1', title: 'Research Engineer', level: 'Mid',
      functionText: 'AI research systems', engagementType: 'Full-Time',
      skillCategories: ['ARTIFICIAL_INTELLIGENCE'], skills: ['Python'],
      researchClassification: 'APPLIED_ENGINEERING', careerLevel: 4,
    };
    const plain = recordAnswer(emptyProfile(), { text: 'I want AI work with Python.' }).profile;
    const owl = recordAnswer(plain, { text: 'I am a night owl who works in bursts.' }).profile;
    expect(evaluate(owl, role).total).toBeCloseTo(evaluate(plain, role).total, 10);
  });

  it('does not classify a behavioural dimension as relevant', () => {
    expect(isRelevanceDimension('persistence')).toBe(false);
    expect(isRelevanceDimension('detail_orientation')).toBe(false);
    expect(isRelevanceDimension('analytical')).toBe(true);
  });
});

describe('the ranker reads dimensions through one door only', () => {
  it('never touches profile.dimensions directly', () => {
    const src = read('rank.ts');
    // relevanceDimensions() is the door; a direct read is how the exploration groups get in.
    expect(src).not.toMatch(/profile\.dimensions/);
    expect(src).toMatch(/relevanceDimensions\(profile\)/);
  });

  it('does not import the exploration accessor at all', () => {
    expect(read('rank.ts')).not.toMatch(/explorationDimensions/);
  });

  it('holds the career map to the same door', () => {
    const src = read('map.ts');
    expect(src).not.toMatch(/profile\.dimensions/);
    expect(src).toMatch(/relevanceDimensions\(profile\)/);
    expect(src).not.toMatch(/explorationDimensions/);
  });
});

describe('nothing about a person removes a posting', () => {
  it('compiles no filter from career stage or from an avoidance', () => {
    const src = read('retrieve.ts');
    // Both are ranking inputs. A grep for the filter names they would have to set if they were not.
    expect(src).not.toMatch(/careerLevel:\s*(?!undefined)/);
    expect(src).not.toMatch(/\bavoid\b\s*\.[a-z]*\s*=>[^)]*filters/);
  });

  it('still returns a result for a posting the person said they did not want', () => {
    const role: MatchableRole = {
      id: 'r1', slug: 'r1', title: 'Finance Analyst', level: 'Mid',
      functionText: 'Financial modelling and reporting', engagementType: 'Full-Time',
      skillCategories: [], skills: ['Excel'], researchClassification: null, careerLevel: 4,
    };
    const p = recordAnswer(emptyProfile(), { text: 'I am not interested in finance.' }).profile;
    const m = evaluate(p, role);
    expect(m.role.id).toBe('r1');
    expect(m.contributions.some((c) => c.kind === 'avoid')).toBe(true);
  });
});

describe('the model refuses to hold a personality label', () => {
  it('has no dimension whose name is a type or a category of person', () => {
    const banned = /(introvert|extrovert|type|personality|profile_type|mbti|big.?five|disc)/i;
    for (const d of DIMENSIONS) expect(banned.test(d.key), d.key).toBe(false);
  });

  it('states every dimension as something the person does, not something they are', () => {
    for (const d of DIMENSIONS) {
      // Addressed to the person, in their own second person — not a third-person classification.
      expect(/\byou(r)?\b/i.test(d.affirm), d.key).toBe(true);
      // "You are a systems thinker" is a label. "You like seeing how the parts fit together" is a
      // description of a preference, which is the only thing this model is entitled to hold.
      expect(/\byou are (an?|the) \w+/i.test(d.affirm), d.key).toBe(false);
    }
  });
});
