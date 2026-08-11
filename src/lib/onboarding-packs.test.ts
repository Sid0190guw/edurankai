// Tests for the engagement step packs.
//
// THE PROPERTY EVERY TEST BELOW IS REALLY DEFENDING: an onboarding checklist is evidence of the
// employment relationship, so a step that is wrong for an engagement must not merely be filtered out
// of that engagement's checklist -- it must not be in the arrays at all.
//
// ASSERTED BY NAME, NEVER BY COUNT. A count test passes the day somebody swaps one control step for
// another, and passes again the day somebody adds two and removes two. Every forbidden step below is
// named, so the failure message says which control was reintroduced and to whom.
//
// The shim runner, not vitest: everything here is synchronous and pure. src/lib/test-shim.ts's it()
// does not await, so an async test written against it would pass while asserting nothing.
import { describe, it, expect, report } from './test-shim';
import {
  ENGAGEMENT_PACKS,
  BASE_STEPS,
  CONTROL_LABELS,
  allPackProblems,
  documentsForEngagement,
  engagementKeys,
  engagementRiskFor,
  excludesControl,
  isEngagementKey,
  packFor,
  packProblems,
  requiredDocumentsForEngagement,
  resolveEngagementKey,
  stepsForEngagement,
  type ControlSignal,
  type EngagementKey,
} from './onboarding-packs';
import { CLASSIFICATIONS, INTERNSHIP_CLASSIFICATIONS } from './hr-classification';
import { ENGAGEMENT_TYPES } from './hr-requisition';
import { MAX_DOCS, DOC_TYPES } from './hr-onboarding';
import { resolveIsIntern } from './auth/intern-signals';
import { inferEngagement } from './offer-templates';

const keysOf = (key: EngagementKey): string[] => stepsForEngagement(key).map((s) => s.key);
const titlesOf = (key: EngagementKey): string => stepsForEngagement(key).map((s) => s.title).join(' || ').toLowerCase();

/**
 * The steps a person who is NOT our employee must never be given. Named individually, and every one
 * of them exists in some other pack, so this list cannot rot into a list of names nothing uses.
 */
const CONTROL_STEP_KEYS = [
  'payroll_enrolment',
  'statutory_setup',
  'equipment_issue',
  'induction_reading',
  'policy_acknowledgement',
  'manager_intro',
  'probation_terms',
  'first_week_checkin',
  'working_week_stated',
  'leave_balance',
  'leave_prorata',
  'agreed_hours_stated',
];

describe('the spine and the packs cannot drift apart', () => {
  it('every engagement in the classification map has a pack', () => {
    for (const key of Object.keys(CLASSIFICATIONS)) {
      expect(packFor(key) !== null).toBe(true);
    }
  });

  it('every pack names an engagement that exists on the spine', () => {
    for (const key of engagementKeys()) {
      expect(Object.prototype.hasOwnProperty.call(CLASSIFICATIONS, key)).toBe(true);
      expect(ENGAGEMENT_PACKS[key].key).toBe(key);
    }
  });

  it('the three missing engagements now exist, with a pack each', () => {
    for (const key of ['part_time', 'intern_unpaid', 'apprentice']) {
      expect(Object.prototype.hasOwnProperty.call(CLASSIFICATIONS, key)).toBe(true);
      expect(packFor(key) !== null).toBe(true);
    }
  });

  it('an unpaid intern is not recorded as a volunteer: they are separate keys with separate packs', () => {
    expect(isEngagementKey('intern_unpaid')).toBe(true);
    expect(isEngagementKey('volunteer')).toBe(true);
    expect(keysOf('intern_unpaid')).toContain('learning_agreement');
    expect(keysOf('volunteer')).not.toContain('learning_agreement');
    expect(keysOf('volunteer')).toContain('no_pay_stated');
  });

  it('a requisition can be raised for every engagement it offers, and each has a pack', () => {
    for (const key of Object.keys(ENGAGEMENT_TYPES)) {
      expect(Object.prototype.hasOwnProperty.call(CLASSIFICATIONS, key)).toBe(true);
      expect(packFor(key) !== null).toBe(true);
    }
  });

  it('every pack is internally coherent', () => {
    expect(allPackProblems()).toEqual([]);
  });
});

describe('a contractor pack contains no step that asserts control', () => {
  it('none of the named control steps appears, for a contractor', () => {
    const steps = keysOf('contractor');
    for (const forbidden of CONTROL_STEP_KEYS) {
      expect(steps).not.toContain(forbidden);
    }
  });

  it('none of the named control steps appears, for a consultant', () => {
    const steps = keysOf('consultant');
    for (const forbidden of CONTROL_STEP_KEYS) {
      expect(steps).not.toContain(forbidden);
    }
  });

  it('the words themselves are absent from what a contractor is asked to do', () => {
    const text = titlesOf('contractor');
    expect(/payroll/.test(text)).toBe(false);
    expect(/shift|roster/.test(text)).toBe(false);
    expect(/probation/.test(text)).toBe(false);
    expect(/induction/.test(text)).toBe(false);
    expect(/leave balance/.test(text)).toBe(false);
  });

  it('no contractor step is owned by a supervision relationship', () => {
    for (const s of stepsForEngagement('contractor')) {
      expect(s.ownerVia === 'reporting_manager').toBe(false);
      expect(s.ownerVia === 'department_head').toBe(false);
    }
    for (const s of stepsForEngagement('consultant')) {
      expect(s.ownerVia === 'reporting_manager').toBe(false);
      expect(s.ownerVia === 'department_head').toBe(false);
    }
  });

  it('no contractor step records an acknowledgement, which is the exhibit a claim is built on', () => {
    for (const s of stepsForEngagement('contractor')) {
      expect(s.requiresAcknowledgement === true).toBe(false);
    }
  });

  it('the contractor pack does have the steps a contractor genuinely needs', () => {
    const steps = keysOf('contractor');
    expect(steps).toContain('contract_and_sow');
    expect(steps).toContain('scope_agreed');
    expect(steps).toContain('invoicing_details');
    expect(steps).toContain('tax_registration_recorded');
    expect(steps).toContain('own_equipment_confirmed');
  });

  it('every control this codebase knows about is excluded for a contractor, with a reason', () => {
    for (const control of Object.keys(CONTROL_LABELS) as ControlSignal[]) {
      expect(excludesControl('contractor', control)).toBe(true);
    }
  });
});

describe('an unpaid intern is not paid, and is not an employee either', () => {
  it('no stipend step and no payroll step, by name', () => {
    const steps = keysOf('intern_unpaid');
    expect(steps).not.toContain('stipend_recorded');
    expect(steps).not.toContain('payroll_enrolment');
    expect(steps).not.toContain('statutory_setup');
  });

  it('the word stipend appears nowhere in what they are asked to do, except to say there is none', () => {
    for (const s of stepsForEngagement('intern_unpaid')) {
      if (s.key === 'unpaid_stated_in_writing') continue;
      expect(/stipend/i.test(s.title)).toBe(false);
    }
  });

  it('the paid intern pack DOES record a stipend, so the two are genuinely different', () => {
    expect(keysOf('intern')).toContain('stipend_recorded');
  });

  it('the unpaid basis is stated in writing before the first day', () => {
    const step = stepsForEngagement('intern_unpaid').find((s) => s.key === 'unpaid_stated_in_writing');
    expect(step !== undefined).toBe(true);
    expect(step ? step.dueDay : -1).toBe(0);
  });

  it('the credit-hours path still applies to an unpaid intern', () => {
    expect(keysOf('intern_unpaid')).toContain('credit_hours_explained');
    expect(keysOf('intern_unpaid')).toContain('mentor_assigned');
    expect(keysOf('intern_unpaid')).toContain('end_date_recorded');
  });
});

describe('every exclusion explains itself', () => {
  it('carries a control, a label and a why', () => {
    for (const key of engagementKeys()) {
      for (const x of ENGAGEMENT_PACKS[key].excludes) {
        expect(Object.prototype.hasOwnProperty.call(CONTROL_LABELS, x.control)).toBe(true);
        expect(x.label.trim().length > 0).toBe(true);
        expect(x.why.trim().length >= 40).toBe(true);
      }
    }
  });

  it('the engagements that need exclusions have them', () => {
    for (const key of ['contractor', 'consultant', 'intern_unpaid', 'eor', 'volunteer'] as EngagementKey[]) {
      expect(ENGAGEMENT_PACKS[key].excludes.length > 0).toBe(true);
    }
  });

  it('no step in any pack asserts a control that same pack excludes', () => {
    for (const key of engagementKeys()) {
      const excluded = new Set(ENGAGEMENT_PACKS[key].excludes.map((x) => x.control));
      for (const s of stepsForEngagement(key)) {
        if (!s.asserts) continue;
        expect(excluded.has(s.asserts)).toBe(false);
      }
    }
  });

  it('the base asserts no control at all, which is what makes it a base', () => {
    for (const s of BASE_STEPS) {
      expect(s.asserts === undefined).toBe(true);
    }
  });

  it('every base step reaches every engagement, including the highest-risk ones', () => {
    for (const key of engagementKeys()) {
      const steps = keysOf(key);
      for (const b of BASE_STEPS) {
        expect(steps).toContain(b.key);
      }
    }
  });
});

describe('the document set is part of the pack', () => {
  it('every pack asks for at least one document, and at least one is required', () => {
    for (const key of engagementKeys()) {
      expect(documentsForEngagement(key).length > 0).toBe(true);
      expect(requiredDocumentsForEngagement(key).length > 0).toBe(true);
    }
  });

  it('no pack asks for more documents than a joiner may submit', () => {
    for (const key of engagementKeys()) {
      expect(documentsForEngagement(key).length <= MAX_DOCS).toBe(true);
    }
  });

  it('every document type is one the joining documents screen actually offers', () => {
    const offered = new Set(DOC_TYPES.map((d) => String(d.key)));
    for (const key of engagementKeys()) {
      for (const d of documentsForEngagement(key)) {
        expect(offered.has(String(d.docType))).toBe(true);
      }
    }
  });

  it('a contractor is asked for their contract and tax registration, not a relieving letter', () => {
    const types = documentsForEngagement('contractor').map((d) => String(d.docType));
    expect(types).toContain('agreement');
    expect(types).toContain('tax_registration');
    expect(types).not.toContain('experience');
  });

  it('an employee IS asked for a relieving letter, so the contractor case is a real difference', () => {
    expect(documentsForEngagement('permanent').map((d) => String(d.docType))).toContain('experience');
  });

  it('every document says why it is wanted', () => {
    for (const key of engagementKeys()) {
      for (const d of documentsForEngagement(key)) {
        expect(d.why.trim().length > 0).toBe(true);
      }
    }
  });
});

describe('the employee packs are still the full employee packs', () => {
  it('a permanent employee gets payroll, statutory, equipment, induction and probation', () => {
    const steps = keysOf('permanent');
    expect(steps).toContain('payroll_enrolment');
    expect(steps).toContain('statutory_setup');
    expect(steps).toContain('equipment_issue');
    expect(steps).toContain('induction_reading');
    expect(steps).toContain('probation_terms');
  });

  it('a part-time employee gets the employee pack, with hours stated and leave pro-rata', () => {
    const steps = keysOf('part_time');
    expect(steps).toContain('payroll_enrolment');
    expect(steps).toContain('statutory_setup');
    expect(steps).toContain('agreed_hours_stated');
    expect(steps).toContain('leave_prorata');
  });

  it('a fixed-term employee is an employee: payroll and statutory, plus the end date', () => {
    const steps = keysOf('fixed_term');
    expect(steps).toContain('payroll_enrolment');
    expect(steps).toContain('statutory_setup');
    expect(steps).toContain('term_end_recorded');
  });

  it('an apprentice gets a training agreement, a supervisor, a programme and assessment points', () => {
    const steps = keysOf('apprentice');
    expect(steps).toContain('training_agreement_registered');
    expect(steps).toContain('supervisor_assigned');
    expect(steps).toContain('programme_schedule');
    expect(steps).toContain('assessment_points');
  });

  it('an EOR worker gets scope and access from us, and payroll from nobody here', () => {
    const steps = keysOf('eor');
    expect(steps).toContain('eor_partner_recorded');
    expect(steps).toContain('local_terms_confirmed');
    expect(steps).not.toContain('payroll_enrolment');
    expect(steps).not.toContain('statutory_setup');
  });

  it('a volunteer is paid nothing, is not rostered and is not inducted', () => {
    const steps = keysOf('volunteer');
    expect(steps).toContain('no_pay_stated');
    expect(steps).toContain('local_law_check');
    expect(steps).not.toContain('payroll_enrolment');
    expect(steps).not.toContain('induction_reading');
  });

  it('the risk rating travels with the pack, from the spine', () => {
    expect(engagementRiskFor('contractor')).toBe('high');
    expect(engagementRiskFor('volunteer')).toBe('high');
    expect(engagementRiskFor('intern_unpaid')).toBe('medium');
    expect(engagementRiskFor('permanent')).toBe('low');
  });

  it('steps come back in due-day order, so a checklist reads as a sequence', () => {
    for (const key of engagementKeys()) {
      const days = stepsForEngagement(key).map((s) => s.dueDay);
      for (let i = 1; i < days.length; i++) {
        expect(days[i] >= days[i - 1]).toBe(true);
      }
    }
  });

  it('a pack has no duplicate step keys once the base is merged in', () => {
    for (const key of engagementKeys()) {
      const steps = keysOf(key);
      expect(new Set(steps).size).toBe(steps.length);
    }
  });

  it('packProblems reports a contradiction rather than hiding it', () => {
    const broken = {
      key: 'contractor' as EngagementKey,
      summary: 'deliberately broken',
      steps: [{ key: 'payroll_enrolment', title: 'Enrol on payroll', description: 'x', category: 'accounts', ownerVia: 'onboarding_owner', dueDay: 0, asserts: 'payroll' }],
      excludes: [{ control: 'payroll' as ControlSignal, label: 'Payroll', why: 'They invoice us and we pay the invoice, so a payroll record contradicts the engagement.' }],
      documents: [{ docType: 'agreement' as const, label: 'Contract', why: 'It governs the engagement.', required: true }],
    } as any;
    expect(packProblems(broken).length > 0).toBe(true);
  });
});

describe('reading the free-text column, and refusing when it does not settle the question', () => {
  it('the word "contract" selects nothing at all', () => {
    const r = resolveEngagementKey('Contract');
    expect(r.key).toBeNull();
    expect(r.reason).toMatch(/fixed-term/i);
    expect(r.reason).toMatch(/contractor/i);
  });

  it('freelance is an independent contractor, not a category of its own', () => {
    expect(resolveEngagementKey('Freelance').key).toBe('contractor');
  });

  it('an internship with no stipend on the record is an UNPAID internship', () => {
    expect(resolveEngagementKey('Internship').key).toBe('intern_unpaid');
    expect(resolveEngagementKey('Internship', { stipendRecorded: true }).key).toBe('intern');
  });

  it('the machine-written values the auto-hire path produces are read correctly', () => {
    expect(resolveEngagementKey('full_time').key).toBe('permanent');
    expect(resolveEngagementKey('Full-Time').key).toBe('permanent');
    expect(resolveEngagementKey('Part-Time').key).toBe('part_time');
    expect(resolveEngagementKey('part_time').key).toBe('part_time');
  });

  it('an empty employment_type refuses rather than defaulting to the employee pack', () => {
    expect(resolveEngagementKey('').key).toBeNull();
    expect(resolveEngagementKey(null).key).toBeNull();
    expect(resolveEngagementKey(undefined).key).toBeNull();
  });

  it('"Internal Auditor" is not an intern', () => {
    expect(resolveEngagementKey('Internal Auditor').key).not.toBe('intern');
    expect(resolveEngagementKey('Internal Auditor').key).not.toBe('intern_unpaid');
  });

  it('Fellowship refuses, because it is not a classification', () => {
    expect(resolveEngagementKey('Fellowship').key).toBeNull();
  });

  it('every refusal still says something a person can act on', () => {
    for (const raw of ['', 'Contract', 'Fellowship', 'Something nobody has heard of']) {
      expect(resolveEngagementKey(raw).reason.trim().length > 20).toBe(true);
    }
  });

  it('every spine key resolves to itself', () => {
    for (const key of engagementKeys()) {
      expect(resolveEngagementKey(key).key).toBe(key);
    }
  });
});

describe('adding the new engagements did not break what already read the spine', () => {
  it('a reviewed unpaid intern is still an intern', () => {
    expect(resolveIsIntern({ classification: 'intern_unpaid', classificationReviewedAt: '2026-08-01' })).toBe(true);
    expect(resolveIsIntern({ classification: 'apprentice', classificationReviewedAt: '2026-08-01' })).toBe(true);
    expect(resolveIsIntern({ classification: 'intern', classificationReviewedAt: '2026-08-01' })).toBe(true);
  });

  it('a reviewed permanent employee is still not an intern', () => {
    expect(resolveIsIntern({ classification: 'permanent', classificationReviewedAt: '2026-08-01', employmentType: 'Full-Time', designation: 'Engineer' })).toBe(false);
    expect(resolveIsIntern({ classification: 'part_time', classificationReviewedAt: '2026-08-01', employmentType: 'Part-Time', designation: 'Engineer' })).toBe(false);
  });

  it('every internship classification is a real key on the spine', () => {
    for (const key of Array.from(INTERNSHIP_CLASSIFICATIONS)) {
      expect(Object.prototype.hasOwnProperty.call(CLASSIFICATIONS, key)).toBe(true);
    }
  });

  it('the offer templates can now infer an engagement from the values machines write', () => {
    expect(inferEngagement('full_time')).toBe('full-time');
    expect(inferEngagement('part_time')).toBe('part-time');
    expect(inferEngagement('Part-Time')).toBe('part-time');
    expect(inferEngagement('intern_unpaid')).toBe('internship');
    expect(inferEngagement('apprentice')).toBe('apprenticeship');
  });
});

report();
