import { describe, it, expect } from 'vitest';
import { evaluate, rankAll, groupByTier, tierFor, TIERS, type MatchableRole } from './rank';
import { explain, NOT_PERSONALISED, COULD_STRENGTHEN_NOTE } from './explain';
import { emptyProfile, type CareerProfile } from './dimensions';
import { recordAnswer } from './profile';

/* ------------------------------------------------------------------------------------ fixtures */

const ROLE = (over: Partial<MatchableRole> = {}): MatchableRole => ({
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'research-engineer',
  title: 'Research Engineer, Learning Systems',
  level: 'Mid',
  functionText: 'Build and evaluate learning systems.',
  engagementType: 'Full-Time',
  departmentName: 'Research',
  divisionName: null,
  researchClassification: 'APPLIED_ENGINEERING',
  skills: ['Python', 'PyTorch', 'Distributed systems'],
  skillCategories: ['ARTIFICIAL_INTELLIGENCE'],
  careerLevel: 4,
  ...over,
});

function profileFrom(text: string): CareerProfile {
  return recordAnswer(emptyProfile(), { text }).profile;
}

/* --------------------------------------------------------------------------------------- tests */

describe('the score IS the explanation', () => {
  it('sums exactly to the contributions and nothing else', () => {
    const p = profileFrom('I want to work on AI, I have used Python and PyTorch, and I have 5 years of experience.');
    const m = evaluate(p, ROLE());
    const sum = m.contributions.reduce((n, c) => n + c.weight, 0);
    expect(m.total).toBeCloseTo(sum, 10);
  });

  it('never produces a reason that did not move the ranking', () => {
    const p = profileFrom('I want to work on AI with Python.');
    const m = evaluate(p, ROLE());
    const e = explain(m);
    const signals = new Set(m.contributions.filter((c) => c.weight > 0).map((c) => c.signal));
    for (const a of e.aligned) expect(signals.has(a.signal)).toBe(true);
  });

  it('says nothing rather than something generic when nothing lined up', () => {
    const p = profileFrom('I want to work in classical archaeology.');
    const m = evaluate(p, ROLE());
    const e = explain(m);
    expect(e.nothingMatched).toBe(true);
    expect(e.headline).toBe('');
    expect(e.aligned).toEqual([]);
  });

  it('has a stated sentence for a result set that was never personalised', () => {
    expect(NOT_PERSONALISED).toMatch(/not personalised/i);
  });
});

describe('tiers, not percentages', () => {
  it('offers four groups, each with a written meaning', () => {
    expect(TIERS.map((t) => t.key)).toEqual(['strong', 'potential', 'adjacent', 'explore']);
    for (const t of TIERS) expect(t.meaning.length).toBeGreaterThan(20);
  });

  it('refuses the top tier to a high score built on one kind of evidence', () => {
    const oneKind = [
      { kind: 'skill' as const, signal: 'a', matched: 'x', weight: 1.2 },
      { kind: 'skill' as const, signal: 'b', matched: 'y', weight: 1.2 },
    ];
    expect(tierFor(2.4, oneKind)).toBe('potential');
  });

  it('gives the top tier when several different kinds line up', () => {
    const many = [
      { kind: 'discipline' as const, signal: 'a', matched: 'x', weight: 1.0 },
      { kind: 'skill' as const, signal: 'b', matched: 'y', weight: 0.8 },
      { kind: 'stage' as const, signal: 'c', matched: 'z', weight: 0.5 },
    ];
    expect(tierFor(2.3, many)).toBe('strong');
  });

  it('returns no numeric score on the way to a surface', () => {
    const p = profileFrom('AI and Python.');
    const e = explain(evaluate(p, ROLE()));
    expect(JSON.stringify(e)).not.toMatch(/\d+%/);
  });
});

describe('an avoidance demotes and never hides', () => {
  it('still returns the posting, with the demotion stated', () => {
    const p = profileFrom('I am not interested in artificial intelligence at all.');
    const m = evaluate(p, ROLE());
    expect(m).toBeTruthy();
    const e = explain(m);
    expect(e.demotedBecause.length).toBeGreaterThan(0);
    expect(e.demotedBecause[0]).toMatch(/ranked lower/i);
  });

  it('ranks it below one with no objection against it', () => {
    const p = profileFrom('I want education work. I am not interested in artificial intelligence.');
    const ai = evaluate(p, ROLE());
    const edu = evaluate(p, ROLE({
      id: '00000000-0000-4000-8000-000000000002',
      title: 'Curriculum Designer',
      functionText: 'Design curriculum and assessment for learners.',
      skillCategories: [],
      skills: ['Curriculum', 'Assessment'],
    }));
    expect(edu.total).toBeGreaterThan(ai.total);
  });
});

describe('career stage orders, it does not exclude', () => {
  it('demotes a distant rung rather than dropping the posting', () => {
    const p = profileFrom('I am a final-year undergraduate.');
    const senior = evaluate(p, ROLE({ careerLevel: 8, level: 'Lead' }));
    expect(senior.contributions.some((c) => c.kind === 'stage' && c.weight < 0)).toBe(true);
    expect(senior.role).toBeTruthy();
  });

  it('rewards a posting at the matching rung', () => {
    const p = profileFrom('I am a final-year undergraduate.');
    const intern = evaluate(p, ROLE({ careerLevel: 1, level: 'Intern' }));
    expect(intern.contributions.some((c) => c.kind === 'stage' && c.weight > 0)).toBe(true);
  });

  it('says what it could not check rather than assuming', () => {
    const p = profileFrom('I like AI.');
    const m = evaluate(p, ROLE({ careerLevel: null }));
    expect(m.unknowns.join(' ')).toMatch(/career/i);
  });
});

describe('gaps are honest and never a promise', () => {
  it('lists what the posting names that we have no evidence of', () => {
    const p = profileFrom('I have used Python.');
    const m = evaluate(p, ROLE());
    expect(m.gaps).toContain('PyTorch');
    expect(m.gaps).not.toContain('Python');
  });

  it('never says doing them leads to being hired', () => {
    expect(COULD_STRENGTHEN_NOTE).toMatch(/not a route to an offer/i);
    expect(COULD_STRENGTHEN_NOTE).not.toMatch(/will be hired|guarantee/i);
  });

  it('carries the caveat ON the explanation, so a renderer cannot show the list without it', () => {
    const p = profileFrom('I have used Python.');
    const e = explain(evaluate(p, ROLE()));
    expect(e.couldDevelop.length).toBeGreaterThan(0);
    expect(e.couldDevelopNote).toBe(COULD_STRENGTHEN_NOTE);
  });
});

describe('ranking a page', () => {
  const roles = [
    ROLE(),
    ROLE({ id: '00000000-0000-4000-8000-000000000003', title: 'Legal Counsel', functionText: 'Contracts and compliance.', skillCategories: [], skills: ['Contracts'], researchClassification: null, careerLevel: 6 }),
    ROLE({ id: '00000000-0000-4000-8000-000000000004', title: 'Quantum Hardware Engineer', functionText: 'Build cryogenic control hardware.', skillCategories: ['QUANTUM'], skills: ['Cryogenics'], researchClassification: 'EXPERIMENTAL', careerLevel: 5 }),
  ];

  it('puts the relevant one first without removing the others', () => {
    const p = profileFrom('I want AI work with Python and PyTorch.');
    const ranked = rankAll(p, roles);
    expect(ranked.length).toBe(3);
    expect(ranked[0].role.title).toMatch(/Research Engineer/);
  });

  it('is stable and total for an empty profile', () => {
    const ranked = rankAll(emptyProfile(), roles);
    expect(ranked.length).toBe(3);
    for (const m of ranked) expect(m.tier).toBe('explore');
  });

  it('drops empty groups instead of rendering a heading with nothing under it', () => {
    const groups = groupByTier(rankAll(emptyProfile(), roles));
    for (const g of groups) expect(g.matches.length).toBeGreaterThan(0);
  });
});

describe('it does not throw on anything a database can hand it', () => {
  it('survives a posting with every optional field missing', () => {
    const bare = {
      id: 'x', slug: 'x', title: '', level: '', functionText: '', engagementType: '',
    } as MatchableRole;
    const p = profileFrom('I like AI and Python.');
    expect(() => evaluate(p, bare)).not.toThrow();
    expect(evaluate(p, bare).tier).toBe('explore');
  });
});
