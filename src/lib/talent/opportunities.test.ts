// src/lib/talent/opportunities.test.ts — the opportunity rules, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. opportunities.ts resolves its database handle lazily,
// so importing decideTransition() must not require DATABASE_URL. If that ever regresses — somebody
// adds a module-scope `import { db }` — this file fails at COLLECTION rather than on an assertion,
// which is exactly the signal wanted: a whole suite going dark reads as a broken file rather than
// a broken rule.
//
// ONLY THE RULES ARE TESTED. Nothing here exercises a query. The two things worth testing are the
// status lattice and the validator, because they are the two places where a wrong answer is
// invisible: an illegal move that succeeds looks like a working button, and a missing validation
// looks like a published advertisement.
import { describe, it, expect } from 'vitest';
import {
  OPPORTUNITY_STATUSES, OPPORTUNITY_STATUS_LABELS,
  EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS, TRAINING_EMPLOYMENT_TYPES, PAID_COMPENSATION_KINDS,
  ASSIGN_ROLES,
  isOpportunityStatus, isEmploymentType, isCompensationKind, isAssignRole, isTrainingEngagement,
  legalTransitionsFrom, canTransition, decideTransition, opportunityProblems,
  normaliseDeadlineInput,
  type OpportunityInput,
} from '@/lib/talent/opportunities';
import {
  COMPENSATION_KINDS, IDENTITY_TYPES,
  type Opportunity, type OpportunityStatus,
} from '@/lib/talent/types';

// A valid draft, so that each test below changes exactly one thing and the failure names it.
const OK: OpportunityInput = {
  title: 'Research Engineer, Evaluation',
  departmentId: 'engineering',
  employmentType: 'full_time',
  headcount: 2,
  eligibleIdentityTypes: ['employee'],
  compensationKind: 'salary',
  compensationNote: 'Band 3, reviewed annually',
  hiringManagerId: '11111111-2222-3333-4444-555555555555',
  deadlineAt: '2099-01-01T00:00:00Z',
};

const NOW = new Date('2026-08-24T00:00:00Z');

describe('the vocabulary is complete and internally consistent', () => {
  it('labels every status, and recognises exactly those five', () => {
    expect(OPPORTUNITY_STATUSES).toHaveLength(5);
    for (const s of OPPORTUNITY_STATUSES) expect(OPPORTUNITY_STATUS_LABELS[s]).toBeTruthy();
    expect(isOpportunityStatus('draft')).toBe(true);
    expect(isOpportunityStatus('duplicated')).toBe(false);   // spec 5A: an action, never a state
    expect(isOpportunityStatus('')).toBe(false);
    expect(isOpportunityStatus(null)).toBe(false);
  });

  it('labels every employment type it will accept', () => {
    for (const t of EMPLOYMENT_TYPES) expect(EMPLOYMENT_TYPE_LABELS[t]).toBeTruthy();
    expect(isEmploymentType('full_time')).toBe(true);
    expect(isEmploymentType('Full-Time')).toBe(false);        // the stored form is the snake_case key
    expect(isEmploymentType('gig')).toBe(false);
  });

  it('treats internships and apprenticeships as the training engagements', () => {
    expect(TRAINING_EMPLOYMENT_TYPES.slice().sort()).toEqual(['apprenticeship', 'internship']);
    expect(isTrainingEngagement('internship')).toBe(true);
    expect(isTrainingEngagement('  Apprenticeship ')).toBe(true);
    expect(isTrainingEngagement('full_time')).toBe(false);
    expect(isTrainingEngagement(null)).toBe(false);
  });

  it('counts unpaid as the only kind that does not imply money', () => {
    expect(PAID_COMPENSATION_KINDS).not.toContain('unpaid');
    for (const k of COMPENSATION_KINDS) {
      if (k !== 'unpaid') expect(PAID_COMPENSATION_KINDS).toContain(k);
    }
    expect(isCompensationKind('stipend')).toBe(true);
    expect(isCompensationKind('competitive')).toBe(false);
  });

  it('knows the three ways somebody can be attached to an opportunity', () => {
    expect(ASSIGN_ROLES).toEqual(['evaluator', 'interviewer', 'panel']);
    expect(isAssignRole('panel')).toBe(true);
    expect(isAssignRole('observer')).toBe(false);
  });

  /**
   * THE CROSS-CHECK THAT KEEPS TWO VOCABULARIES HONEST. identityTypeFromEmployment() resolves an
   * employment type it does not recognise to 'employee', which asks a candidate for a PAN and bank
   * details. So every employment type this desk can record must map to the identity it is actually
   * meant to produce — a fellowship that silently onboarded as an employee would be invisible until
   * a fellow was asked for their bank IFSC.
   *
   * Imported dynamically: onboarding.ts reaches the database through its own import chain, and a
   * failure to load it should read as this one assertion failing, not as the whole file going dark.
   */
  it('maps every employment type it accepts to the identity that engagement produces', async () => {
    const { identityTypeFromEmployment } = await import('@/lib/talent/onboarding');
    const expected: Array<[string, string]> = [
      ['full_time', 'employee'],
      ['part_time', 'employee'],
      ['contract', 'employee'],
      ['internship', 'intern'],
      ['apprenticeship', 'intern'],
      ['fellowship', 'fellow'],
      ['membership', 'member'],
    ];
    expect(expected.map((p) => p[0]).sort()).toEqual(EMPLOYMENT_TYPES.slice().sort());
    for (const [employment, identity] of expected) {
      expect(identityTypeFromEmployment(employment)).toBe(identity);
      expect(IDENTITY_TYPES).toContain(identity as any);
    }
  });
});

describe('the status lattice', () => {
  it('is total: every status has an answer, and every answer is a status', () => {
    for (const from of OPPORTUNITY_STATUSES) {
      const targets = legalTransitionsFrom(from);
      expect(Array.isArray(targets)).toBe(true);
      for (const t of targets) {
        expect(OPPORTUNITY_STATUSES).toContain(t);
        expect(t).not.toBe(from);
      }
    }
  });

  it('answers nothing for a status it does not recognise, rather than guessing', () => {
    expect(legalTransitionsFrom('duplicated')).toEqual([]);
    expect(legalTransitionsFrom(undefined)).toEqual([]);
    expect(canTransition('duplicated', 'published')).toBe(false);
  });

  it('opens a draft and lets a draft be tidied away, and nothing else', () => {
    expect(legalTransitionsFrom('draft').slice().sort()).toEqual(['archived', 'published']);
    expect(canTransition('draft', 'published')).toBe(true);
    expect(canTransition('draft', 'closed')).toBe(false);
    expect(canTransition('draft', 'unpublished')).toBe(false);
  });

  it('withdraws or closes a published opportunity, and never archives one straight from public', () => {
    expect(legalTransitionsFrom('published').slice().sort()).toEqual(['closed', 'unpublished']);
    expect(canTransition('published', 'archived')).toBe(false);
  });

  it('re-publishes something that was withdrawn: that is routine, not a resurrection', () => {
    expect(canTransition('unpublished', 'published')).toBe(true);
    expect(decideTransition('unpublished', 'published').ok).toBe(true);
  });

  it('refuses to re-open a closed opportunity, and says to publish a successor', () => {
    const d = decideTransition('closed', 'published');
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/successor/i);
    expect(canTransition('closed', 'archived')).toBe(true);
  });

  it('never brings an archived opportunity back, by any route', () => {
    expect(legalTransitionsFrom('archived')).toEqual([]);
    for (const to of OPPORTUNITY_STATUSES) {
      expect(canTransition('archived', to)).toBe(false);
    }
    expect(decideTransition('archived', 'published').reason).toMatch(/archived/i);
  });

  it('refuses a move to the state it is already in, and says so plainly', () => {
    for (const s of OPPORTUNITY_STATUSES) {
      const d = decideTransition(s, s);
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/already/i);
    }
  });

  it('refuses a target that is not a state at all', () => {
    const d = decideTransition('draft', 'deleted');
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/not a state/i);
  });

  it('refuses to judge a move out of a state it does not recognise', () => {
    const d = decideTransition('live', 'closed');
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/does not recognise/i);
  });

  it('never disagrees with canTransition, on any pair, including nonsense', () => {
    // TWO OPINIONS ABOUT ONE MOVE IS THE BUG THE LATTICE EXISTS TO PREVENT, and the page asks the
    // cheap one (legalTransitionsFrom, to decide which buttons to draw) while the write path asks
    // the expensive one (decideTransition). If they ever part company, the desk renders a button
    // that is always refused, or hides one that would have worked.
    const candidates: unknown[] = [
      ...OPPORTUNITY_STATUSES, 'duplicated', 'deleted', '', null, undefined, 0, {},
    ];
    for (const from of candidates) {
      for (const to of candidates) {
        expect(decideTransition(from, to).ok).toBe(canTransition(from, to));
      }
    }
  });

  it('agrees with legalTransitionsFrom on exactly which moves succeed', () => {
    for (const from of OPPORTUNITY_STATUSES) {
      const legal = legalTransitionsFrom(from);
      for (const to of OPPORTUNITY_STATUSES) {
        expect(decideTransition(from, to).ok).toBe(legal.includes(to));
      }
    }
  });

  it('always gives a reason, including when it agrees', () => {
    for (const from of OPPORTUNITY_STATUSES) {
      for (const to of OPPORTUNITY_STATUSES) {
        expect(decideTransition(from, to).reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('publication and closing stamp a date, and nothing ever clears one', () => {
  it('stamps published_at on a first publication', () => {
    const d = decideTransition('draft', 'published');
    expect(d.ok).toBe(true);
    expect(d.stampPublishedAt).toBe(true);
    expect(d.stampClosedAt).toBe(false);
  });

  it('keeps the ORIGINAL publication date when something withdrawn goes back up', () => {
    const d = decideTransition('unpublished', 'published', { hasPublishedAt: true });
    expect(d.ok).toBe(true);
    expect(d.stampPublishedAt).toBe(false);
  });

  it('stamps closed_at on closing, once', () => {
    expect(decideTransition('published', 'closed').stampClosedAt).toBe(true);
    expect(decideTransition('unpublished', 'closed', { hasClosedAt: true }).stampClosedAt).toBe(false);
  });

  it('never asks for a stamp to be cleared: the decision has no way to express it', () => {
    // The guarantee is structural. If a `clearPublishedAt` ever appears on this shape, an archived
    // opportunity can stop being able to say when it was published — so the shape itself is asserted.
    const keys = Object.keys(decideTransition('draft', 'published')).sort();
    expect(keys).toEqual(['ok', 'reason', 'stampClosedAt', 'stampPublishedAt']);
  });

  it('decides the stamp from the RECORD, not from the state it is moving out of', () => {
    // The re-publish case tests the normal path, where an unpublished row already carries a date.
    // This is the abnormal one: a row that reached `unpublished` with published_at somehow NULL
    // must have it written on the way back up, or that opportunity can never say when it opened.
    // Reading the flag off the from-state instead of off the record is the plausible regression.
    expect(decideTransition('unpublished', 'published', { hasPublishedAt: false }).stampPublishedAt).toBe(true);
    expect(decideTransition('unpublished', 'published', {}).stampPublishedAt).toBe(true);
    expect(decideTransition('unpublished', 'closed', { hasClosedAt: false }).stampClosedAt).toBe(true);
  });

  it('never asks for a stamp on a move it refused', () => {
    for (const from of OPPORTUNITY_STATUSES) {
      for (const to of OPPORTUNITY_STATUSES) {
        const d = decideTransition(from, to);
        if (d.ok) continue;
        expect(d.stampPublishedAt).toBe(false);
        expect(d.stampClosedAt).toBe(false);
      }
    }
  });

  it('archiving a closed opportunity leaves both stamps alone', () => {
    const d = decideTransition('closed', 'archived', { hasPublishedAt: true, hasClosedAt: true });
    expect(d.ok).toBe(true);
    expect(d.stampPublishedAt).toBe(false);
    expect(d.stampClosedAt).toBe(false);
  });

  it('withdrawing from public does not stamp anything', () => {
    const d = decideTransition('published', 'unpublished', { hasPublishedAt: true });
    expect(d.ok).toBe(true);
    expect(d.stampPublishedAt).toBe(false);
    expect(d.stampClosedAt).toBe(false);
  });
});

describe('validation refuses what an operator can act on', () => {
  it('passes a complete draft with nothing to say', () => {
    expect(opportunityProblems(OK)).toEqual([]);
  });

  it('refuses a missing title, and whitespace is missing', () => {
    expect(opportunityProblems({ ...OK, title: '' })).toHaveLength(1);
    expect(opportunityProblems({ ...OK, title: '   ' })[0]).toMatch(/title/i);
    expect(opportunityProblems({ ...OK, title: undefined })).toHaveLength(1);
  });

  it('refuses a missing department', () => {
    const p = opportunityProblems({ ...OK, departmentId: '' });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/department/i);
  });

  it('refuses an employment type outside the vocabulary, and names the alternatives', () => {
    const p = opportunityProblems({ ...OK, employmentType: 'gig_work' });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('gig_work');
    expect(p[0]).toContain('internship');
    expect(opportunityProblems({ ...OK, employmentType: '' })[0]).toMatch(/required/i);
  });

  it('refuses a compensation kind outside the vocabulary', () => {
    const p = opportunityProblems({ ...OK, compensationKind: 'competitive' });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('competitive');
  });

  it('refuses a headcount below one, and accepts one', () => {
    expect(opportunityProblems({ ...OK, headcount: 0 })[0]).toMatch(/at least one/i);
    expect(opportunityProblems({ ...OK, headcount: -3 })[0]).toMatch(/at least one/i);
    expect(opportunityProblems({ ...OK, headcount: 1 })).toEqual([]);
  });

  it('refuses a headcount that is not a whole number of seats', () => {
    expect(opportunityProblems({ ...OK, headcount: 1.5 })[0]).toMatch(/whole number/i);
    expect(opportunityProblems({ ...OK, headcount: 'many' })[0]).toMatch(/whole number/i);
  });

  it('leaves headcount optional: empty means the number of seats is not decided', () => {
    expect(opportunityProblems({ ...OK, headcount: null })).toEqual([]);
    expect(opportunityProblems({ ...OK, headcount: '' })).toEqual([]);
    expect(opportunityProblems({ ...OK, headcount: undefined })).toEqual([]);
  });

  it('accepts an empty eligibility list, which means external applicants only', () => {
    expect(opportunityProblems({ ...OK, eligibleIdentityTypes: [] })).toEqual([]);
  });

  it('refuses an identity type the rest of the system does not know', () => {
    const p = opportunityProblems({ ...OK, eligibleIdentityTypes: ['employee', 'alumnus'] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('alumnus');
    expect(opportunityProblems({ ...OK, eligibleIdentityTypes: 'employee' })[0]).toMatch(/must be a list/i);
  });

  it('accepts every identity type the contract publishes', () => {
    expect(opportunityProblems({ ...OK, eligibleIdentityTypes: IDENTITY_TYPES.slice() })).toEqual([]);
  });

  it('checks the onboarding package only when it is told which packages exist', () => {
    expect(opportunityProblems({ ...OK, onboardingPack: 'anything' })).toEqual([]);
    const p = opportunityProblems({ ...OK, onboardingPack: 'anything' }, { knownPacks: ['permanent', 'intern'] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('anything');
    expect(opportunityProblems({ ...OK, onboardingPack: 'intern' }, { knownPacks: ['permanent', 'intern'] })).toEqual([]);
  });
});

describe('unpaid is the default, and a training engagement may not imply pay without recording it', () => {
  const intern: OpportunityInput = {
    ...OK, employmentType: 'internship', compensationKind: 'unpaid', compensationNote: null,
  };

  it('accepts an unpaid internship with nothing written down: that is the default', () => {
    expect(opportunityProblems(intern)).toEqual([]);
  });

  it('refuses an internship recorded as paying with no stipend written down', () => {
    for (const kind of PAID_COMPENSATION_KINDS) {
      const p = opportunityProblems({ ...intern, compensationKind: kind });
      expect(p).toHaveLength(1);
      expect(p[0]).toMatch(/unpaid unless the stipend is written down/i);
    }
  });

  it('accepts an internship that pays once the stipend is actually recorded', () => {
    expect(opportunityProblems({
      ...intern, compensationKind: 'stipend', compensationNote: 'INR 25,000 per month',
    })).toEqual([]);
  });

  it('treats a whitespace-only note as nothing written down', () => {
    expect(opportunityProblems({
      ...intern, compensationKind: 'stipend', compensationNote: '   ',
    })).toHaveLength(1);
  });

  it('applies the same rule to an apprenticeship', () => {
    expect(opportunityProblems({
      ...intern, employmentType: 'apprenticeship', compensationKind: 'stipend',
    })).toHaveLength(1);
  });

  it('bites in a draft, not only at publish: a draft is what the next person edits from', () => {
    const p = opportunityProblems({ ...intern, compensationKind: 'stipend' }, { forPublish: false });
    expect(p).toHaveLength(1);
  });

  it('does not fire for a salaried permanent role with no note, which is a different judgement', () => {
    expect(opportunityProblems({
      ...OK, employmentType: 'full_time', compensationKind: 'salary', compensationNote: null,
    })).toEqual([]);
  });

  it('still bites at publish, which is the moment it exists to stop', () => {
    // The rule is checked at every stage, so the draft test above already covers the logic. This
    // asserts the case that actually causes harm: an unpaid-by-default engagement carrying a paid
    // kind with nothing written down, going out as an advertisement. If somebody ever moves the
    // rule inside the `if (opts.forPublish)` block, the draft test keeps passing on its own.
    const p = opportunityProblems({ ...intern, compensationKind: 'stipend' },
      { forPublish: true, now: NOW });
    expect(p.some((line) => /unpaid unless the stipend is written down/i.test(line))).toBe(true);
  });

  it('names the two ways out, so the refusal is actionable rather than a verdict', () => {
    const p = opportunityProblems({ ...intern, compensationKind: 'salary' });
    expect(p[0]).toMatch(/compensation note/i);
    expect(p[0]).toMatch(/unpaid/i);
  });
});

/**
 * THE SHAPE CONTRACT BETWEEN THE STORED ROW AND THE VALIDATOR.
 *
 * transitionOpportunity() re-runs the publish preconditions against the row it just READ, by
 * passing an `Opportunity` straight into opportunityProblems() as an `OpportunityInput`. The two
 * shapes are declared in different files and nothing links them: if types.ts renames a field, every
 * check below silently reads `undefined` — and `undefined` on an optional field is "no problem
 * found", so publish would start accepting rows it is meant to refuse. The object is annotated
 * `Opportunity` on purpose, so a rename fails to compile as well as failing here.
 */
describe('a stored opportunity can be validated as it comes out of the database', () => {
  const stored: Opportunity = {
    id: '99999999-8888-7777-6666-555555555555',
    opportunityCode: 'OPP-2026-0001',
    positionId: null,
    departmentId: 'engineering',
    roleId: null,
    title: 'Research Engineer, Evaluation',
    employmentType: 'full_time',
    level: null,
    headcount: 2,
    eligibleIdentityTypes: ['employee'],
    internalVisibleToManager: false,
    pipelineId: '11111111-1111-1111-1111-111111111111',
    pipelineVersion: 1,
    hiringManagerId: '11111111-2222-3333-4444-555555555555',
    compensationKind: 'salary',
    compensationNote: 'Band 3, reviewed annually',
    onboardingPack: null,
    status: 'draft',
    deadlineAt: '2099-01-01T00:00:00.000Z',
    publishedAt: null,
    closedAt: null,
  };

  it('passes a stored row that is ready, at publish', () => {
    expect(opportunityProblems(stored, { forPublish: true, now: NOW })).toEqual([]);
  });

  it('still refuses a stored row missing its hiring manager, at publish', () => {
    const p = opportunityProblems({ ...stored, hiringManagerId: null }, { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/hiring manager/i);
  });

  it('still refuses a stored row whose deadline has gone, at publish', () => {
    const p = opportunityProblems({ ...stored, deadlineAt: '2020-01-01T00:00:00.000Z' },
      { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/deadline has already passed/i);
  });

  it('still refuses a stored paid internship with no stipend recorded, at publish', () => {
    const p = opportunityProblems(
      { ...stored, employmentType: 'internship', compensationKind: 'stipend', compensationNote: null },
      { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/unpaid unless the stipend is written down/i);
  });

  it('reads a null level and a null headcount out of the row without inventing a problem', () => {
    expect(opportunityProblems({ ...stored, level: null, headcount: null },
      { forPublish: true, now: NOW })).toEqual([]);
  });
});

describe('the preconditions that only bite when the advertisement becomes public', () => {
  it('lets a draft carry a deadline that has already passed', () => {
    const p = opportunityProblems({ ...OK, deadlineAt: '2020-01-01T00:00:00Z' }, { now: NOW });
    expect(p).toEqual([]);
  });

  it('refuses to publish with a deadline already past', () => {
    const p = opportunityProblems({ ...OK, deadlineAt: '2020-01-01T00:00:00Z' },
      { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/deadline has already passed/i);
  });

  it('refuses a deadline exactly now: a closed window is a closed window', () => {
    const p = opportunityProblems({ ...OK, deadlineAt: NOW.toISOString() },
      { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
  });

  it('publishes happily with a future deadline, or with none at all', () => {
    expect(opportunityProblems(OK, { forPublish: true, now: NOW })).toEqual([]);
    expect(opportunityProblems({ ...OK, deadlineAt: null }, { forPublish: true, now: NOW })).toEqual([]);
  });

  it('refuses an unreadable deadline rather than silently treating it as none', () => {
    const p = opportunityProblems({ ...OK, deadlineAt: 'next Tuesday' }, { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/not a date/i);
  });

  it('refuses to publish without a named hiring manager', () => {
    const p = opportunityProblems({ ...OK, hiringManagerId: null }, { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/hiring manager/i);
    // A draft may sit without one.
    expect(opportunityProblems({ ...OK, hiringManagerId: null })).toEqual([]);
  });

  it('does not accept a hiring manager reference that is not an id', () => {
    const p = opportunityProblems({ ...OK, hiringManagerId: 'someone@example.com' },
      { forPublish: true, now: NOW });
    expect(p).toHaveLength(1);
  });
});

/**
 * THE ZONE RULE. A `datetime-local` box posts a wall clock with no zone, and two different things
 * used to resolve it two different ways: `new Date(s)` in this validator picked the NODE process
 * zone, `s::timestamptz` in Postgres picked the DATABASE SESSION zone. They agreed on the deployed
 * estate by coincidence — both UTC — and disagreed by five and a half hours on a developer machine
 * in IST, which is enough for the validator to refuse a publish the database would have accepted,
 * and for a saved deadline to move every time it was saved.
 *
 * These assert the RULE and not the regular expression: what matters is that the same string always
 * means the same instant, that the meaning does not depend on which machine ran it, and that a
 * string which is not a datetime is left alone so the validator can still refuse it.
 */
describe('a deadline with no zone means UTC, on every machine', () => {
  it('pins a bare datetime-local value to UTC', () => {
    expect(normaliseDeadlineInput('2026-09-01T17:00')).toBe('2026-09-01T17:00Z');
    expect(normaliseDeadlineInput('2026-09-01T17:00:30')).toBe('2026-09-01T17:00:30Z');
  });

  it('resolves that value to the same instant no matter what the host zone is', () => {
    // The whole point: an explicit instant, not a wall clock somebody else re-reads.
    expect(new Date(normaliseDeadlineInput('2026-09-01T17:00') as string).toISOString())
      .toBe('2026-09-01T17:00:00.000Z');
  });

  it('leaves a value that already carries a zone exactly as it was', () => {
    expect(normaliseDeadlineInput('2026-09-01T17:00:00Z')).toBe('2026-09-01T17:00:00Z');
    expect(normaliseDeadlineInput('2026-09-01T17:00:00+05:30')).toBe('2026-09-01T17:00:00+05:30');
  });

  it('does not repair something that is not a datetime into a date nobody typed', () => {
    // An unreadable deadline has to STAY unreadable, or the validator loses its only chance to
    // refuse it and the database receives whatever this function guessed.
    expect(normaliseDeadlineInput('next Tuesday')).toBe('next Tuesday');
    expect(Number.isNaN(new Date(normaliseDeadlineInput('next Tuesday') as string).getTime())).toBe(true);
  });

  it('reads an empty deadline as no deadline rather than as a bad one', () => {
    expect(normaliseDeadlineInput('')).toBeNull();
    expect(normaliseDeadlineInput('   ')).toBeNull();
    expect(normaliseDeadlineInput(null)).toBeNull();
    expect(normaliseDeadlineInput(undefined)).toBeNull();
  });

  it('is what the publish check actually reads, so the check is host-independent too', () => {
    // 2026-08-24T00:00:01 is one second AFTER `now` when read as UTC. Were it read in any zone west
    // of UTC it would be in the past and this publish would be refused; east of UTC and a genuinely
    // expired deadline would pass. The assertion is that neither happens.
    expect(opportunityProblems({ ...OK, deadlineAt: '2026-08-24T00:01' },
      { forPublish: true, now: NOW })).toEqual([]);
    expect(opportunityProblems({ ...OK, deadlineAt: '2026-08-23T23:59' },
      { forPublish: true, now: NOW })).toHaveLength(1);
  });
});

describe('every failing precondition is reported at once', () => {
  // Spec 5A: "A publish that fails validation lists every failing precondition at once, not the
  // first one. Iterative single-error publishing is how a deadline gets missed."
  it('reports the title, the department, the employment type, the headcount and the deadline together', () => {
    const p = opportunityProblems({
      title: '',
      departmentId: '',
      employmentType: 'gig_work',
      compensationKind: 'salary',
      headcount: 0,
      eligibleIdentityTypes: ['alumnus'],
      hiringManagerId: null,
      deadlineAt: '2020-01-01T00:00:00Z',
    }, { forPublish: true, now: NOW });
    expect(p.length).toBeGreaterThanOrEqual(7);
    expect(p.join(' ')).toMatch(/title/i);
    expect(p.join(' ')).toMatch(/department/i);
    expect(p.join(' ')).toMatch(/gig_work/);
    expect(p.join(' ')).toMatch(/at least one/i);
    expect(p.join(' ')).toMatch(/alumnus/);
    expect(p.join(' ')).toMatch(/hiring manager/i);
    expect(p.join(' ')).toMatch(/deadline/i);
  });

  it('writes every problem as a sentence an operator can act on', () => {
    const p = opportunityProblems({}, { forPublish: true, now: NOW });
    expect(p.length).toBeGreaterThan(0);
    for (const line of p) {
      expect(line.trim().endsWith('.')).toBe(true);
      expect(line.length).toBeGreaterThan(20);
    }
  });
});

describe('a status the lattice knows is never silently widened', () => {
  // A guard against the cheapest possible regression: somebody adding a state to types.ts and
  // wiring it into the lattice as reachable from everywhere.
  const reachable = new Set<OpportunityStatus>();
  for (const from of OPPORTUNITY_STATUSES) for (const to of legalTransitionsFrom(from)) reachable.add(to);

  it('leaves draft unreachable: an opportunity is never un-drafted back into a draft', () => {
    expect(reachable.has('draft')).toBe(false);
  });

  it('makes archived reachable, and terminal', () => {
    expect(reachable.has('archived')).toBe(true);
    expect(legalTransitionsFrom('archived')).toEqual([]);
  });
});
