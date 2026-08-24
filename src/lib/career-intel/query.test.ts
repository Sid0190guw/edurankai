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

  it('never sends both a discipline predicate and a term predicate at once', () => {
    // listOpportunities ANDs its filters, and the intersection of "in the AI discipline" and
    // "mentions Python" is frequently empty — which would read as "we have nothing for you".
    const q = compileQuery(from('I want AI work and I have used Python.'));
    const both = !!q.filters.skillCategoriesAny && !!q.filters.terms;
    expect(both).toBe(false);
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
