// Tests for the WIRING between the engagement packs and a person's actual checklist.
//
// src/lib/onboarding-packs.test.ts defends the packs themselves: that a step which is wrong for an
// engagement is not in that engagement's arrays at all. This file defends the other half, which is
// where the packs meet the live template — the two places a correct pack can still produce a wrong
// checklist:
//
//   1. THE LEGACY ROWS. Eight steps from the old flat starter list are sitting on live templates
//      right now, tagged with no engagement and no control. If an untagged row defaulted to "applies
//      to everybody", "Issue equipment" and "Read and acknowledge the required policies" would land
//      on a contractor's checklist, which is the precise record a misclassification claim is built
//      from. selectStepsFor() must withhold them, and must say why.
//
//   2. THE ENGAGEMENT NOT BEING RECORDED. hr_employees.classification was created by an ALTER with
//      DEFAULT 'permanent', so every row nobody has reviewed reads "permanent employee". Building
//      the employee pack from that default is the generous-direction failure the whole change
//      exists to prevent, and it is worst for exactly the population it matters most for.
//
// ASSERTED BY NAME, NEVER BY COUNT. A count passes the day somebody swaps one withheld step for
// another. Every assertion below names the step or the control it is about, so a failure says what
// was reintroduced and to whom.
//
// The shim runner, not vitest: everything here is synchronous and pure. src/lib/test-shim.ts's it()
// does not await, so an async test written against it would pass while asserting nothing — and
// selectStepsFor() is deliberately synchronous so that it can be tested without a database.
import { describe, it, expect, report } from './test-shim';
import { selectStepsFor, type TemplateStep } from './onboarding-journey';
import { CONTROL_LABELS } from './onboarding-packs';

// ------------------------------------------------------------------------------------- fixtures

/** A template row, with the fields nothing under test reads left at harmless defaults. */
function step(over: Partial<TemplateStep> & { id: string; title: string }): TemplateStep {
  return {
    description: null,
    category: 'other',
    ownerVia: 'onboarding_owner',
    dueDay: 0,
    readingUrl: null,
    requiresAcknowledgement: false,
    employmentType: null,
    engagementKey: null,
    packStepKey: null,
    assertsControl: null,
    isActive: true,
    sortOrder: 100,
    ...over,
  } as TemplateStep;
}

/**
 * The eight steps the old flat starter button wrote, exactly as they sit on a live template today:
 * no engagement, no control, nothing saying what they assert about the relationship.
 */
const LEGACY_EIGHT: TemplateStep[] = [
  step({ id: 'l1', title: 'Submit joining documents', category: 'documents', ownerVia: 'the_joiner' }),
  step({ id: 'l2', title: 'Verify the joining documents', category: 'documents' }),
  step({ id: 'l3', title: 'Issue equipment', category: 'equipment' }),
  step({ id: 'l4', title: 'Create work accounts and access', category: 'accounts' }),
  step({ id: 'l5', title: 'Introduce the joiner to the team', category: 'introductions', ownerVia: 'reporting_manager' }),
  step({ id: 'l6', title: 'First-week reading', category: 'reading', ownerVia: 'the_joiner' }),
  step({ id: 'l7', title: 'Read and acknowledge the required policies', category: 'policy', ownerVia: 'the_joiner' }),
  step({ id: 'l8', title: 'First-week check-in', ownerVia: 'reporting_manager' }),
];

/** The joiner facts selectStepsFor() reads. Structural, so the test needs no database. */
function joiner(over: any = {}): any {
  return {
    employeeId: '11111111-1111-1111-1111-111111111111',
    userId: null,
    fullName: 'A Joiner',
    employeeCode: 'E1',
    departmentId: null,
    joiningDate: '2026-09-01',
    employmentType: null,
    designation: null,
    classification: null,
    classificationReviewedAt: null,
    classificationReadable: true,
    ...over,
  };
}

const titles = (list: Array<{ step: TemplateStep }>) => list.map((s) => s.step.title);
const withheldTitles = (list: Array<{ title: string }>) => list.map((w) => w.title);

// ------------------------------------------------------------------------------------- the tests

describe('legacy untagged rows against a contractor', () => {
  const sel = selectStepsFor(LEGACY_EIGHT, 'contractor', joiner({ classification: 'contractor' }));

  it('withholds every one of them, because none can be shown to be safe', () => {
    expect(titles(sel.included)).toEqual([]);
    expect(sel.withheld).toHaveLength(8);
  });

  // THE FOUR THAT MATTER MOST, named individually so a failure says which one came back.
  it('does not issue company equipment to a contractor', () => {
    expect(withheldTitles(sel.withheld)).toContain('Issue equipment');
  });

  it('does not take a policy acknowledgement from a contractor', () => {
    expect(withheldTitles(sel.withheld)).toContain('Read and acknowledge the required policies');
  });

  it('does not set a contractor a first week of reading we chose', () => {
    expect(withheldTitles(sel.withheld)).toContain('First-week reading');
  });

  it('does not put a reporting manager on a contractor introduction', () => {
    expect(withheldTitles(sel.withheld)).toContain('Introduce the joiner to the team');
  });

  it('gives every withheld step a reason long enough to be read as an explanation', () => {
    for (const w of sel.withheld) {
      expect(w.why.length > 60).toBe(true);
    }
  });

  it('marks them as untagged rather than pretending to know what they assert', () => {
    for (const w of sel.withheld) expect(w.kind).toBe('untagged');
  });
});

describe('legacy untagged rows against a permanent employee', () => {
  const sel = selectStepsFor(LEGACY_EIGHT, 'permanent', joiner({ classification: 'permanent' }));

  it('withholds nothing, because an employee pack excludes nothing', () => {
    expect(sel.withheld).toEqual([]);
    expect(sel.included).toHaveLength(8);
  });

  it('still issues equipment to the person it is correct for', () => {
    expect(titles(sel.included)).toContain('Issue equipment');
  });
});

describe('a hand-written step tagged with the control it asserts', () => {
  const tagged = [
    step({ id: 't1', title: 'Hand over the laptop', category: 'other', assertsControl: 'equipment' }),
    step({ id: 't2', title: 'Book the welcome coffee', category: 'other', assertsControl: null }),
  ];

  it('is judged on the control and not on its wording', () => {
    const sel = selectStepsFor(tagged, 'contractor', joiner({ classification: 'contractor' }));
    expect(withheldTitles(sel.withheld)).toContain('Hand over the laptop');
    // Category and title say "other" and "coffee"; only the tag decided.
    const equipmentRule = sel.withheld.find((w) => w.title === 'Hand over the laptop');
    expect(equipmentRule ? equipmentRule.kind : '').toBe('control');
    expect(equipmentRule ? equipmentRule.controlLabel : '').toBe(CONTROL_LABELS.equipment);
  });

  it('reaches an engagement whose pack does not exclude that control', () => {
    const sel = selectStepsFor(tagged, 'permanent', joiner({ classification: 'permanent' }));
    expect(titles(sel.included)).toContain('Hand over the laptop');
  });
});

describe('a row seeded for one engagement never reaches another', () => {
  const seeded = [
    step({ id: 'p1', title: 'Open their leave balance', engagementKey: 'permanent', packStepKey: 'leave_balance', assertsControl: 'leave' }),
    step({ id: 'p2', title: 'Record the signed contract and statement of work', engagementKey: 'contractor', packStepKey: 'contract_and_sow' }),
  ];

  it('gives the contractor only the contractor row', () => {
    const sel = selectStepsFor(seeded, 'contractor', joiner({ classification: 'contractor' }));
    expect(titles(sel.included)).toEqual(['Record the signed contract and statement of work']);
    // Somebody else's pack is not a decision about this person, so it is not reported as withheld.
    expect(sel.withheld).toEqual([]);
    expect(sel.otherEngagement).toBe(1);
  });

  it('gives the employee only the employee row', () => {
    const sel = selectStepsFor(seeded, 'permanent', joiner({ classification: 'permanent' }));
    expect(titles(sel.included)).toEqual(['Open their leave balance']);
    expect(sel.otherEngagement).toBe(1);
  });
});

describe('the legacy employment-type restriction', () => {
  const restricted = [step({ id: 'r1', title: 'Collect the college bonafide', employmentType: 'intern' })];

  // THE BUG THIS FIXES: the box was compared as an exact string after stripping spacing, so a step
  // restricted to 'intern' never matched the 'Internship' the HR form and the offer form actually
  // write, and the step silently reached nobody at all.
  //
  // `restricted` is what these assert on, and it is the precise question. A step that survives the
  // restriction may still be WITHHELD afterwards for being untagged, which is a different decision
  // made for a different reason and reported separately — asserting on `included` here would conflate
  // the two and would fail for a reason that has nothing to do with the restriction.
  it('matches Internship against a restriction typed as intern', () => {
    const sel = selectStepsFor(restricted, 'intern_unpaid', joiner({
      classification: 'intern_unpaid', employmentType: 'Internship',
    }));
    expect(sel.restricted).toBe(0);
    expect(titles(sel.included).concat(withheldTitles(sel.withheld))).toContain('Collect the college bonafide');
  });

  it('matches a restriction that names a spine key against the reviewed classification', () => {
    const sel = selectStepsFor(
      [step({ id: 'r2', title: 'Register the apprenticeship', employmentType: 'apprentice' })],
      'apprentice',
      joiner({ classification: 'apprentice', classificationReviewedAt: '2026-08-01T00:00:00.000Z' }),
    );
    expect(sel.restricted).toBe(0);
    expect(titles(sel.included).concat(withheldTitles(sel.withheld))).toContain('Register the apprenticeship');
  });

  it('still keeps a restricted step away from somebody else', () => {
    const sel = selectStepsFor(restricted, 'permanent', joiner({
      classification: 'permanent', employmentType: 'Full-Time',
    }));
    expect(titles(sel.included)).toEqual([]);
    expect(sel.restricted).toBe(1);
  });

  it('does not count a restriction refusal as a withholding, because it is a different fact', () => {
    const sel = selectStepsFor(restricted, 'permanent', joiner({
      classification: 'permanent', employmentType: 'Full-Time',
    }));
    expect(sel.withheld).toEqual([]);
  });
});

describe('an empty restriction still means everybody', () => {
  it('does not turn a blank box into a refusal', () => {
    const sel = selectStepsFor(
      [step({ id: 'e1', title: 'Say hello', employmentType: '' })],
      'permanent',
      joiner({ classification: 'permanent' }),
    );
    expect(titles(sel.included)).toEqual(['Say hello']);
  });
});

report();
