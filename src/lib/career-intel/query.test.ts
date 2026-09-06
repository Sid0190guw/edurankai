import { describe, it, expect } from 'vitest';
import { compileQuery } from './query';
import { emptyProfile } from './dimensions';
import { recordAnswer, addTag } from './profile';
import { toCard } from './wire';
import type { OpportunityRow } from '@/lib/xscale/roles-ext';

const from = (text: string) => recordAnswer(emptyProfile(), { text }).profile;

describe('a sentence becomes one query, not one per signal', () => {
  it('turns named disciplines into a single any-of predicate', () => {
    const q = compileQuery(from('I want to work on artificial intelligence and quantum computing.'));
    expect(q.filters.skillCategoriesAny).toContain('ARTIFICIAL_INTELLIGENCE');
    expect(q.filters.skillCategoriesAny).toContain('QUANTUM');
  });

  it('caps how many predicates one profile can produce', () => {
    let p = emptyProfile();
    const many = ['PHYSICS', 'MATHEMATICS', 'CHEMISTRY', 'BIOLOGY', 'MATERIALS', 'QUANTUM', 'ENERGY', 'AEROSPACE'];
    many.forEach((k, i) => { p = addTag(p, 'interests', k, 'Domain ' + i); });
    const q = compileQuery(p);
    expect((q.filters.skillCategoriesAny || []).length).toBeLessThanOrEqual(6);
  });

  it('uses text terms when the pathway named has no column of its own', () => {
    const q = compileQuery(from('I want to build things and lead a team.'));
    expect(q.filters.skillCategoriesAny).toBeUndefined();
    expect((q.terms || []).length).toBeGreaterThan(0);
  });

  it('sends BOTH a discipline predicate and a term predicate, for roles-ext to OR', () => {
    // skill_categories is populated on the 179 research postings and nothing else, so disciplines
    // alone cannot see an AI-titled role in the main catalogue. Both go; roles-ext ORs them.
    const q = compileQuery(from('I want AI work and I have used Python.'));
    expect((q.filters.skillCategoriesAny || []).length).toBeGreaterThan(0);
    expect((q.filters.terms || []).length).toBeGreaterThan(0);
  });

  it('reports both to the surface, so "we looked in" names all of it', () => {
    const q = compileQuery(from('I want AI work and I have used Python.'));
    expect(q.disciplines.length).toBeGreaterThan(0);
    expect(q.terms.length).toBeGreaterThan(0);
  });
});

describe('an inference never removes a posting', () => {
  it('compiles no filter from career stage', () => {
    const q = compileQuery(from('I am a final-year undergraduate who likes AI.'));
    expect(q.filters.careerLevel).toBeUndefined();
    expect(q.filters.level).toBeUndefined();
  });

  it('compiles no filter from something they said they did not want', () => {
    const q = compileQuery(from('I want AI. I am not interested in finance.'));
    const asJson = JSON.stringify(q.filters);
    expect(asJson).not.toMatch(/FINANCE/);
  });

  it('does still honour a choice the person made explicitly', () => {
    const q = compileQuery(from('I like AI.'), { departmentId: 'research', q: 'vision' });
    expect(q.filters.departmentId).toBe('research');
    expect(q.filters.q).toBe('vision');
  });

  it('does not use an interest the person rejected', () => {
    let p = from('I like finance.');
    p = { ...p, interests: p.interests.map((t) => ({ ...t, confirmation: 'rejected' as const })) };
    const q = compileQuery(p);
    expect(q.unpersonalised).toBe(true);
  });
});

describe('a profile with nothing in it says so', () => {
  it('reports unpersonalised rather than pretending', () => {
    expect(compileQuery(emptyProfile()).unpersonalised).toBe(true);
  });

  it('is not unpersonalised once the person typed a search term', () => {
    expect(compileQuery(emptyProfile(), { q: 'robotics' }).unpersonalised).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------- wire */

const ROW = (over: Partial<OpportunityRow> = {}): OpportunityRow => ({
  id: 'r1', slug: 'r1', title: 'Research Intern', level: 'Intern',
  functionText: 'Work on one scoped problem.', engagementType: 'Internship',
  location: 'Remote / Hybrid (India)', departmentId: 'd1', departmentName: 'Research',
  divisionId: null, divisionName: null, divisionSlug: null,
  researchClassification: null, scaleMinExp: null, scaleMaxExp: null,
  skills: [], skillCategories: [], careerLevel: null, jobStatus: 'PUBLISHED',
  isFeatured: false, isOpen: true, applicationDeadline: null, createdAt: null, openings: null,
  ...over,
});

describe('a card cannot advertise remote work', () => {
  it('rewrites a legacy remote row on a trainee posting to hybrid', () => {
    const c = toCard(ROW());
    expect(c.location).not.toMatch(/remote/i);
    expect(c.workMode).toBe('On-site / Hybrid');
  });

  it('clamps a legacy remote row on a permanent posting to on-site', () => {
    const c = toCard(ROW({ engagementType: 'Full-Time', level: 'Senior' }));
    expect(c.location).not.toMatch(/remote/i);
    expect(c.workMode).toBe('On-site');
  });

  it('does not carry the raw stored location onto the card at all', () => {
    // An absent field cannot be rendered by accident. This is the mechanism, not the manners.
    const c = toCard(ROW()) as any;
    expect(JSON.stringify(c)).not.toMatch(/Remote \/ Hybrid/);
  });

  it('keeps a genuine bespoke site rather than overwriting it', () => {
    const c = toCard(ROW({ location: 'On-site — your own campus', engagementType: 'Internship' }));
    expect(c.location).toBe('On-site — your own campus');
  });
});

// -------------------------------------------------------------------------------------------
// A LITERAL KEYWORD THE LEXICON DOES NOT KNOW.
//
// Reported from the live site: typing "QA junior" into the explore box on /careers returned no QA
// roles, while browsing the catalogue showed them. Two separate causes, both here:
//
//   1. compileQuery built `terms` ONLY from CONFIRMED interests and skills — tags the interpreter
//      had matched against its own lexicon. "QA" matches no tag, so nothing reached the query and
//      the search silently became the generic unpersonalised catalogue: "we did not look for it",
//      rendered as "there is nothing like that here".
//   2. extractQueryTerms dropped any word of three characters or fewer, so even the fallback that
//      DID exist could never have carried "QA", "AI", "ML" or "UX".
describe('a literal keyword still searches, even when no tag matched it', () => {
  it('carries a two-letter abbreviation nobody has a lexicon entry for', () => {
    const q = compileQuery(from('QA junior'));
    const terms = (q.filters.terms || []).map((t) => t.toLowerCase());
    expect(terms).toContain('qa');
    expect(q.unpersonalised).toBe(false);
  });

  it('carries the longer words of the same query too', () => {
    const q = compileQuery(from('QA junior'));
    const terms = (q.filters.terms || []).map((t) => t.toLowerCase());
    expect(terms).toContain('junior');
  });

  it('still reports what it looked for, so the search is not a black box', () => {
    const q = compileQuery(from('QA junior'));
    expect(q.terms.length).toBeGreaterThan(0);
  });

  it('does not resurrect a keyword the person rejected, even though the sentence still holds it', () => {
    // The raw text is kept verbatim forever; a correction made after the fact has to win over it.
    let p = from('I like finance.');
    p = { ...p, interests: p.interests.map((t) => ({ ...t, confirmation: 'rejected' as const })) };
    const q = compileQuery(p);
    expect(JSON.stringify(q.filters.terms || []).toLowerCase()).not.toContain('finance');
  });

  it('does not turn a stated avoidance into something to search FOR', () => {
    const q = compileQuery(from('I want AI. I am not interested in finance.'));
    expect(JSON.stringify(q.filters.terms || []).toLowerCase()).not.toContain('finance');
  });
});
