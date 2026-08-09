// Tests for the parts of the outcome and credit engines that have no database in them — the parts
// whose answers end up printed next to somebody's name on a document an accredited partner reads.
//
// The four properties every test below is really defending:
//   1. AN OUTCOME WITH NO EVIDENCE IS UNCOVERED, NOT ZERO. Null hours, an 'uncovered' state, and a
//      sentence that says it is an absence of evidence.
//   2. NOTHING UNMEASURED IS QUIETLY COUNTED AS A FAILURE. A component nobody measured is NAMED and
//      excluded; it never drags a credit figure down as a zero.
//   3. CREDIT CAN NEVER BE CONDITIONED ON ATTENDANCE OR LOGIN TIME. The validator refuses it.
//   4. THIS PLATFORM NEVER AWARDS. `awarded` is false on every path there is.
import { describe, it, expect } from './test-shim';
import {
  summariseOutcome, summariseCoverage, ATTAINMENT_FRACTION,
  type OutcomeRow, type ActivityFact, type OutcomeAssessmentRow, type OutcomeLinkRow,
  type ActivityFactSet,
} from './eims-outcomes';
import {
  validateCreditConfig, decideCredit, defaultCreditComponents, gradeFor, roundToStep,
  summariseRubric, DEFAULT_GRADE_BANDS,
  type CreditConfig, type RubricCriterion, type RubricScoreRow,
} from './eims-credit';

/* --------------------------------------------------------------------------------- fixtures */

const outcome = (code: string, over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  id: '00000000-0000-4000-8000-0000000000' + code.slice(-2).padStart(2, '0'),
  programmeKey: 'default',
  code,
  statement: 'Statement for ' + code,
  detail: '',
  category: 'technical',
  sortOrder: 0,
  active: true,
  createdByUserId: null,
  createdAt: null,
  ...over,
});

const activity = (over: Partial<ActivityFact> = {}): ActivityFact => ({
  source: 'task',
  id: 'a1',
  label: 'A task',
  employeeId: '00000000-0000-4000-8000-000000000099',
  occurredOn: '2026-08-05',
  completed: true,
  allocatedHours: null,
  completedHours: null,
  verifiedHours: null,
  wellbeing: false,
  outcomeHints: [],
  evidence: [],
  ...over,
});

const config = (over: Partial<CreditConfig> = {}): CreditConfig => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  programmeKey: 'default',
  programmeName: 'Applied engineering internship',
  partnerInstitution: 'An accredited partner institution',
  totalCredits: 12,
  creditStep: 0.5,
  weeklyCeilingHours: 40,
  programmeWeeks: 12,
  partnerHoursPerCredit: 45,
  holisticEmbedded: true,
  components: defaultCreditComponents(),
  gradeBands: DEFAULT_GRADE_BANDS,
  ownerUserId: '00000000-0000-4000-8000-0000000000aa',
  ownerName: 'A named owner',
  state: 'active',
  version: 1,
  effectiveFrom: null,
  notes: '',
  createdAt: null,
  updatedAt: null,
  ...over,
});

/* ------------------------------------------------------------------- uncovered is not zero */

describe('an outcome with no evidence', () => {
  it('reads as uncovered, with null hours rather than zero', () => {
    const c = summariseOutcome(outcome('LO1'), [], null);
    expect(c.state).toBe('uncovered');
    expect(c.covered).toBe(false);
    expect(c.verifiedHours).toBeNull();
    expect(c.completedHours).toBeNull();
    expect(c.allocatedHours).toBeNull();
    expect(c.statement).toMatch(/not a score of zero/i);
  });

  it('stays uncovered when a mentor assessed it with nothing behind it, and raises an advisory', () => {
    const mentor: OutcomeAssessmentRow = {
      id: 'm1', employeeId: 'e1', outcomeId: 'LO1',
      attainment: 'demonstrated', comment: 'Seen in stand-up.',
      assessedByUserId: null, assessedByName: 'A mentor', assessedAt: null,
    };
    const c = summariseOutcome(outcome('LO1'), [], mentor);
    expect(c.state).toBe('uncovered');
    expect(c.mentor).not.toBeNull();
    expect(c.advisories.join(' ')).toMatch(/mentor review required/i);
  });

  it('never invents an hour from a completed task', () => {
    const c = summariseOutcome(outcome('LO1'), [activity({ completed: true })], null);
    expect(c.state).toBe('reported');
    expect(c.verifiedHours).toBeNull();
  });

  it('climbs to verified only when a person checked the evidence', () => {
    const evidenced = summariseOutcome(outcome('LO1'), [activity({
      evidence: [{ kind: 'doc', reference: 'https://drive.google.com/x', label: 'Doc', verified: false, verifiedOn: null }],
    })], null);
    expect(evidenced.state).toBe('evidenced');

    const verified = summariseOutcome(outcome('LO1'), [activity({
      verifiedHours: 4,
      evidence: [{ kind: 'doc', reference: 'https://drive.google.com/x', label: 'Doc', verified: true, verifiedOn: '2026-08-06' }],
    })], null);
    expect(verified.state).toBe('verified');
    expect(verified.verifiedHours).toBe(4);
  });
});

describe('the coverage report', () => {
  const outcomes = [outcome('LO1'), outcome('LO2'), outcome('LO3')];
  const links: OutcomeLinkRow[] = [{
    id: 'l1', outcomeId: outcomes[0].id, source: 'task', activityId: 'a1',
    activityLabel: 'A task', employeeId: null, createdByUserId: null, createdAt: null, derived: false,
  }];
  const facts: ActivityFactSet = {
    activities: [activity({ id: 'a1', verifiedHours: 6, evidence: [
      { kind: 'doc', reference: 'https://drive.google.com/x', label: 'Doc', verified: true, verifiedOn: '2026-08-06' },
    ] })],
    assessments: [],
    unread: [],
    sources: [],
  };

  it('counts uncovered outcomes rather than scoring them zero', () => {
    const byOutcome = new Map([[outcomes[0].id, links]]);
    const r = summariseCoverage('e1', 'default', outcomes, byOutcome, facts, new Map());
    expect(r.total).toBe(3);
    expect(r.covered).toBe(1);
    expect(r.uncovered).toBe(2);
    expect(r.verified).toBe(1);
    expect(r.coverageFraction).toBeCloseTo(1 / 3, 5);
  });

  it('leaves attainment null when nobody assessed anything', () => {
    const r = summariseCoverage('e1', 'default', outcomes, new Map(), facts, new Map());
    expect(r.attainmentFraction).toBeNull();
    expect(r.assessedCount).toBe(0);
  });

  it('says out loud that it is incomplete when a source could not be read', () => {
    const broken: ActivityFactSet = { ...facts, unread: ['the activity ledger'] };
    const r = summariseCoverage('e1', 'default', outcomes, new Map(), broken, new Map());
    expect(r.complete).toBe(false);
    expect(r.advisories.join(' ')).toMatch(/incomplete/i);
  });

  it('averages mentor attainment over assessed outcomes only', () => {
    const mentor: OutcomeAssessmentRow = {
      id: 'm1', employeeId: 'e1', outcomeId: outcomes[0].id,
      attainment: 'demonstrated', comment: 'Reviewed the deliverable.',
      assessedByUserId: null, assessedByName: 'A mentor', assessedAt: null,
    };
    const r = summariseCoverage('e1', 'default', outcomes,
      new Map([[outcomes[0].id, links]]), facts, new Map([[outcomes[0].id, mentor]]));
    expect(r.assessedCount).toBe(1);
    expect(r.attainmentFraction).toBe(ATTAINMENT_FRACTION.demonstrated);
  });
});

/* ------------------------------------------------------------------ the credit configuration */

describe('validateCreditConfig', () => {
  const base = {
    programmeName: 'Applied engineering internship',
    totalCredits: 12,
    creditStep: 0.5,
    weeklyCeilingHours: 40,
    programmeWeeks: 12,
    holisticEmbedded: true,
    components: defaultCreditComponents(),
    gradeBands: DEFAULT_GRADE_BANDS,
    ownerUserId: '00000000-0000-4000-8000-0000000000aa',
    ownerName: 'A named owner',
  };

  it('accepts the seeded twelve-credit configuration', () => {
    expect(validateCreditConfig(base)).toEqual([]);
  });

  it('refuses a component conditioned on attendance', () => {
    const errs = validateCreditConfig({
      ...base,
      components: defaultCreditComponents().map((c) => (
        c.key === 'documentation' ? { ...c, label: 'Attendance and punctuality' } : c
      )),
    });
    expect(errs.join(' ')).toMatch(/may not be conditioned on attendance/i);
  });

  it('refuses a component conditioned on login time even when the label looks innocent', () => {
    const errs = validateCreditConfig({
      ...base,
      components: defaultCreditComponents().map((c) => (
        c.key === 'documentation' ? { ...c, note: 'Derived from hours logged in the portal.' } : c
      )),
    });
    expect(errs.join(' ')).toMatch(/attendance, presence, login time or clock time/i);
  });

  it('refuses to make holistic development a separate course', () => {
    const errs = validateCreditConfig({ ...base, holisticEmbedded: false });
    expect(errs.join(' ')).toMatch(/embedded in the credits/i);
  });

  it('requires a named owner, because a conversion is a record and not a setting', () => {
    expect(validateCreditConfig({ ...base, ownerName: '' }).join(' ')).toMatch(/named owner/i);
    expect(validateCreditConfig({ ...base, ownerUserId: null }).join(' ')).toMatch(/named owner/i);
  });

  it('requires the weights to add up to 100', () => {
    const errs = validateCreditConfig({
      ...base,
      components: defaultCreditComponents().map((c) => ({ ...c, weightPct: 5 })),
    });
    expect(errs.join(' ')).toMatch(/add up to 100/i);
  });

  it('refuses a weekly ceiling above the statutory limit', () => {
    expect(validateCreditConfig({ ...base, weeklyCeilingHours: 60 }).join(' ')).toMatch(/48 hours/);
  });
});

/* ------------------------------------------------------------------------- the credit decision */

describe('decideCredit', () => {
  const measured = (v: number) => ({ attainment: v, basis: 'measured' });
  const all = {
    'verified-workload': measured(1),
    'learning-outcomes': measured(1),
    'project-completion': measured(1),
    assessments: measured(1),
    'mentor-evaluation': measured(1),
    'professional-holistic': measured(1),
    documentation: measured(1),
    'final-evaluation': measured(1),
  } as const;

  it('computes the whole twelve when every component is fully attained', () => {
    const d = decideCredit({ ...all }, config());
    expect(d.state).toBe('computed');
    expect(d.attainmentPct).toBe(100);
    expect(d.creditsRecommended).toBe(12);
    expect(d.awarded).toBe(false);
  });

  it('computes nothing at all when no configuration has been recorded', () => {
    const d = decideCredit({ ...all }, null);
    expect(d.state).toBe('unconfigured');
    expect(d.creditsRecommended).toBeNull();
    expect(d.totalCredits).toBeNull();
    expect(d.statements.join(' ')).toMatch(/never a default/i);
  });

  it('names an unmeasured component instead of counting it as a zero', () => {
    const partial = { ...all } as Record<string, { attainment: number | null; basis: string }>;
    delete partial['assessments'];
    const d = decideCredit(partial as any, config());
    expect(d.state).toBe('incomplete');
    expect(d.unmeasured).toContain('Assessments');
    // 100% of what WAS measured, not 90% because one component was missing.
    expect(d.attainmentPct).toBe(100);
    expect(d.statements.join(' ')).toMatch(/partial computation/i);
  });

  it('reports a component below its configured minimum without refusing anything', () => {
    const d = decideCredit({ ...all, 'mentor-evaluation': measured(0.2) }, config());
    expect(d.belowMinimum).toContain('Mentor evaluation');
    expect(d.creditsRecommended).not.toBeNull();
    expect(d.statements.join(' ')).toMatch(/a person decides/i);
  });

  it('never records this platform as the awarding body', () => {
    for (const d of [decideCredit({}, null), decideCredit({ ...all }, config())]) {
      expect(d.awarded).toBe(false);
      expect(d.awardedBy).toBeNull();
      expect(d.statements.join(' ')).toMatch(/accredited partner institution awards/i);
    }
  });

  it('rounds to the configured credit step', () => {
    const d = decideCredit({ ...all, documentation: measured(0) }, config());
    expect(d.creditsRecommended).toBe(roundToStep((d.attainmentPct! / 100) * 12, 0.5));
  });
});

/* --------------------------------------------------------------------------------- the rubric */

describe('the grading rubric', () => {
  const criterion = (code: string, weight: number): RubricCriterion => ({
    id: 'c-' + code, programmeKey: 'default', code, label: 'Criterion ' + code,
    descriptor: '', weightPct: weight, maxScore: 5, sortOrder: 0, active: true,
  });
  const score = (criterionId: string, value: number): RubricScoreRow => ({
    id: 's-' + criterionId, employeeId: 'e1', criterionId, score: value,
    comment: 'Because of the work I read.', assessedByUserId: null,
    assessedByName: 'A mentor', assessedAt: null,
  });

  it('weights only the criteria somebody actually scored', () => {
    const criteria = [criterion('R1', 50), criterion('R2', 50)];
    const r = summariseRubric(criteria, [score('c-R1', 5)]);
    expect(r.percent).toBe(100);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['Criterion R2']);
  });

  it('has no grade at all when nothing was scored', () => {
    const r = summariseRubric([criterion('R1', 100)], []);
    expect(r.percent).toBeNull();
    expect(r.grade).toBeNull();
  });

  it('grades a fully scored rubric against the configured bands', () => {
    const criteria = [criterion('R1', 50), criterion('R2', 50)];
    const r = summariseRubric(criteria, [score('c-R1', 5), score('c-R2', 4)]);
    expect(r.complete).toBe(true);
    expect(r.percent).toBe(90);
    expect(r.grade?.code).toBe('A+');
    expect(r.assessors).toEqual(['A mentor']);
  });
});

describe('gradeFor', () => {
  it('answers nothing for a missing percentage rather than the bottom band', () => {
    expect(gradeFor(null)).toBeNull();
  });
  it('picks the highest band the percentage reaches', () => {
    expect(gradeFor(80)?.code).toBe('A');
    expect(gradeFor(79.9)?.code).toBe('B');
    expect(gradeFor(0)?.code).toBe('E');
  });
});
