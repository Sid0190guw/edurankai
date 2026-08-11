// src/lib/onboarding-packs.ts -- WHAT A NEW JOINER IS ACTUALLY ASKED TO DO, BY ENGAGEMENT.
//
// =================================================================================================
// WHY THIS FILE EXISTS: AN ONBOARDING CHECKLIST IS EVIDENCE OF THE EMPLOYMENT RELATIONSHIP.
// =================================================================================================
// src/lib/onboarding-journey.ts had ONE flat suggested checklist (STARTER_STEPS) applied to
// everybody. An unpaid intern, a freelancer and a permanent employee were onboarded identically.
//
// That is not untidiness. src/lib/hr-classification.ts opens by saying that misclassification is
// the single biggest compliance risk this company carries, and it rates `contractor` HIGH. A
// genuine independent contractor controls their own hours and their own tools and is paid for
// outcomes. If this platform issues that person company equipment, enrols them in payroll, sets
// their working hours, puts them through an employee induction and records their acknowledgement of
// the employee handbook, it has produced a dated, named, durable record of exactly the control that
// makes somebody an employee in fact, whatever the contract says. The checklist becomes the
// company's own exhibit against itself.
//
// So the generous direction is the dangerous one. Giving everybody the full employee pack because
// it is easier does not over-serve anybody -- it manufactures liability.
//
// =================================================================================================
// THE EXCLUSIONS ARE THE POINT, AND THEY ARE ABSENT BY CONSTRUCTION.
// =================================================================================================
// A step that is legally wrong for a contractor does not exist in any array a contractor's journey
// can read. It is not present-and-filtered, because a filter is one `if` away from being deleted by
// somebody who does not know what it was for. This is the same shape src/lib/offer-templates.ts
// settled on for offer letters ("there is no shared branch that can emit them for anybody else,
// because there is no shared branch at all"), and it is settled here for the same reason.
//
// Every exclusion carries a `why` in plain English, because the person most likely to undo one is
// an HR user adding a step back on a Tuesday afternoon with a good local reason. They should be
// able to read what they are undoing before they undo it.
//
// =================================================================================================
// NO FOURTH VOCABULARY. THE SPINE DECIDES.
// =================================================================================================
// Packs are keyed off CLASSIFICATIONS in src/lib/hr-classification.ts -- the legally meaningful
// column, single-writer, validated on save, with a risk rating per key. NOT off
// hr_employees.employment_type, which is free text written by five different screens in five
// different vocabularies with no constraint, no enum and no normaliser: a pack keyed off that
// column would hand the everybody-pack to every person the auto-hire path created (it writes the
// literal 'full_time'), to everybody whose offer left the field blank (it writes ''), and to every
// row written before whichever spelling you standardised on. employment_type is a HINT that seeds a
// classification review -- resolveEngagementKey() below is the honest bridge -- never a selector.
//
// `Record<EngagementKey, EngagementPack>` is load-bearing: EngagementKey is `keyof typeof
// CLASSIFICATIONS`, so adding an engagement to the spine without adding a pack for it fails the
// TYPE CHECK, and the build gate on this project is real. A new engagement cannot arrive without a
// pack, which is the property the suite would otherwise have to remember to check.
//
// NO DATABASE, NO I/O. Pure data and pure functions, like engagement-policy.ts and
// offer-templates.ts, so it is safe to import from .astro frontmatter, from an API route and from a
// synchronous test.
import { CLASSIFICATIONS } from '@/lib/hr-classification';
import { DOC_TYPES, MAX_DOCS, type DocTypeKey } from '@/lib/hr-onboarding';
// TYPE-ONLY, and deliberately so: it gives the compiler the journey module's own vocabulary of
// categories and owner relationships (so a pack cannot invent a category the checklist is unable to
// render, or an owner the org graph cannot resolve) while importing nothing at runtime, which keeps
// this module clear of the journey module's database, notifier and org-graph imports.
import type { StepCategory, OwnerVia } from '@/lib/onboarding-journey';

// Everything below is declared BEFORE whatever reads it. `const` is not hoisted, and reaching a
// later declaration has taken pages down on this project.

/** A key of the classification spine. The only thing that selects a pack. */
export type EngagementKey = keyof typeof CLASSIFICATIONS;

/**
 * THE CONTROLS. Each names one thing a step can assert about the relationship.
 *
 * These are the limbs of the control and economic-reality tests that decide, in a dispute, whether
 * somebody was an employee in fact. A step tagged with one is a written record that the company
 * exercised that control. Entirely correct for an employee; entirely wrong for an independent
 * contractor. That is why a pack states which of them it EXCLUDES.
 */
export type ControlSignal =
  | 'working_hours'          // the company decides when they work
  | 'shift'                  // the company rosters them for coverage
  | 'payroll'                // the company pays them as staff rather than against an invoice
  | 'statutory'              // the company enrols them in employee statutory schemes
  | 'equipment'              // the company supplies the tools
  | 'induction'              // the company puts them through its employee induction
  | 'policy_acknowledgement' // the company binds them to its employee policies, on the record
  | 'reporting_line'         // the company gives them a manager
  | 'probation'              // the company tests them for permanence
  | 'leave'                  // the company administers their time off
  | 'training';              // the company directs how they learn to do the work

export const CONTROL_LABELS: Record<ControlSignal, string> = {
  working_hours: 'Set working hours',
  shift: 'A shift or roster',
  payroll: 'Payroll enrolment',
  statutory: 'Statutory contributions',
  equipment: 'Company equipment',
  induction: 'Employee induction',
  policy_acknowledgement: 'Employee policy acknowledgement',
  reporting_line: 'A reporting manager',
  probation: 'A probation period',
  leave: 'Company leave administration',
  training: 'Company-directed training',
};

export function controlLabel(control: string): string {
  return (CONTROL_LABELS as Record<string, string>)[control] || String(control);
}

/** One step in a pack: the shape a row in hr_onboarding_journey_steps would be written from. */
export interface PackStep {
  /** Stable, unique within the pack. The tests assert on these BY NAME, never by counting. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly category: StepCategory;
  readonly ownerVia: OwnerVia;
  /** Days from the joining date, matching hr_onboarding_journey_steps.due_day. */
  readonly dueDay: number;
  readonly requiresAcknowledgement?: boolean;
  /**
   * The control this step evidences, if any. A step carrying a control may never appear in a pack
   * that excludes it -- packProblems() proves that and the suite fails if it is ever untrue.
   */
  readonly asserts?: ControlSignal;
}

/** Something this engagement must NOT be asked to do, and the reason, in words HR can act on. */
export interface PackExclusion {
  readonly control: ControlSignal;
  /** What is being left out, named the way an HR user would look for it. */
  readonly label: string;
  /** Why. Shown to whoever is about to add it back. Never empty. */
  readonly why: string;
}

/** A document this engagement owes. A Google Drive LINK -- nothing is ever uploaded to us. */
export interface PackDocument {
  readonly docType: DocTypeKey;
  readonly label: string;
  readonly why: string;
  readonly required: boolean;
}

export interface EngagementPack {
  readonly key: EngagementKey;
  /** One line an HR user reads before starting somebody's checklist. */
  readonly summary: string;
  /** Steps ON TOP of BASE_STEPS. Never contains anything this pack excludes. */
  readonly steps: readonly PackStep[];
  readonly excludes: readonly PackExclusion[];
  readonly documents: readonly PackDocument[];
}

// -------------------------------------------------------------------------------------------------
// THE BASE. What every human joiner needs, whoever they are.
// -------------------------------------------------------------------------------------------------
// NOT ONE OF THESE ASSERTS A CONTROL, and that is the test the base has to pass to be a base. Each
// is either something only the person can do (confirm who they are, confirm the agreement they
// signed) or the minimum owed to anybody the company has engaged (access to the systems the agreed
// work needs, one named human to ask). An employee induction is not in here. Neither is equipment.
//
// The point of contact is owned by the ONBOARDING OWNER, not by 'reporting_manager'. Resolving a
// reporting manager writes owner_employee_id and owner_name onto the item -- a stored record naming
// a supervisor -- so the base cannot use it. Employee packs add the manager introduction themselves.
export const BASE_STEPS: readonly PackStep[] = [
  {
    key: 'identity_confirmed',
    title: 'Confirm who you are',
    description: 'Share your government ID as a Google Drive link on the joining documents screen. Nothing is uploaded to us; the file stays in your own Drive and we only open the link.',
    category: 'documents',
    ownerVia: 'the_joiner',
    dueDay: 0,
  },
  {
    key: 'contact_confirmed',
    title: 'Confirm how we reach you',
    description: 'The email address and phone number to use for anything about this engagement.',
    category: 'other',
    ownerVia: 'the_joiner',
    dueDay: 0,
  },
  {
    key: 'agreement_confirmed',
    title: 'Confirm the agreement that governs this engagement',
    description: 'Share the signed document, whatever it is called for you: appointment letter, contract and statement of work, learning agreement, or contract of apprenticeship. It is the document that says what was actually agreed, and the one that settles a disagreement later.',
    category: 'documents',
    ownerVia: 'the_joiner',
    dueDay: 0,
  },
  {
    key: 'access_granted',
    title: 'Give access to what this engagement needs',
    description: 'Only the systems the agreed work actually needs, and nothing broader. Access wider than the work is a problem for everybody, including the person receiving it.',
    category: 'accounts',
    ownerVia: 'onboarding_owner',
    dueDay: 0,
  },
  {
    key: 'point_of_contact',
    title: 'Name the point of contact for this engagement',
    description: 'One named human this person can ask. For an employee that is their reporting manager; for a contractor it is whoever owns the contract on our side.',
    category: 'introductions',
    ownerVia: 'onboarding_owner',
    dueDay: 1,
  },
];

// -------------------------------------------------------------------------------------------------
// SHARED STEPS AND SHARED EXCLUSIONS. Declared before the packs that read them.
// -------------------------------------------------------------------------------------------------

const EMPLOYEE_PAYROLL: PackStep = {
  key: 'payroll_enrolment',
  title: 'Enrol on payroll',
  description: 'Salary account, tax declarations and the payroll record. They are paid as staff, on a payroll cycle.',
  category: 'accounts',
  ownerVia: 'onboarding_owner',
  dueDay: 3,
  asserts: 'payroll',
};

const EMPLOYEE_STATUTORY: PackStep = {
  key: 'statutory_setup',
  title: 'Set up statutory contributions',
  description: 'Provident fund, state insurance and any other statutory scheme this person is covered by in their country of work.',
  category: 'other',
  ownerVia: 'onboarding_owner',
  dueDay: 5,
  asserts: 'statutory',
};

const EMPLOYEE_EQUIPMENT: PackStep = {
  key: 'equipment_issue',
  title: 'Issue equipment',
  description: 'Whatever this person needs to do the work. Record it on the asset register so it is on their exit checklist too.',
  category: 'equipment',
  ownerVia: 'onboarding_owner',
  dueDay: 0,
  asserts: 'equipment',
};

const EMPLOYEE_INDUCTION: PackStep = {
  key: 'induction_reading',
  title: 'First-week reading',
  description: 'Add the Drive link to what this person should read in their first week to understand how the work is done here.',
  category: 'reading',
  ownerVia: 'the_joiner',
  dueDay: 5,
  asserts: 'induction',
};

const EMPLOYEE_POLICY_ACK: PackStep = {
  key: 'policy_acknowledgement',
  title: 'Read and acknowledge the required policies',
  description: 'Add the Drive link to the policy document. The joiner acknowledges it here and the acknowledgement is recorded against their record.',
  category: 'policy',
  ownerVia: 'the_joiner',
  dueDay: 7,
  requiresAcknowledgement: true,
  asserts: 'policy_acknowledgement',
};

const EMPLOYEE_MANAGER_INTRO: PackStep = {
  key: 'manager_intro',
  title: 'Introduce the joiner to their manager and the team',
  description: 'The people they will work with day to day, and who to ask when they are stuck.',
  category: 'introductions',
  ownerVia: 'reporting_manager',
  dueDay: 2,
  asserts: 'reporting_line',
};

const EMPLOYEE_PROBATION: PackStep = {
  key: 'probation_terms',
  title: 'Confirm the probation period and what is reviewed at the end of it',
  description: 'How long it runs, what will be assessed, and who assesses it. A probation nobody described is a probation nobody can pass.',
  category: 'other',
  ownerVia: 'reporting_manager',
  dueDay: 7,
  asserts: 'probation',
};

const EMPLOYEE_CHECKIN: PackStep = {
  key: 'first_week_checkin',
  title: 'First-week check-in',
  description: 'A conversation about how the first week actually went, before problems become habits.',
  category: 'other',
  ownerVia: 'reporting_manager',
  dueDay: 7,
  asserts: 'reporting_line',
};

const EMPLOYEE_WORKING_WEEK: PackStep = {
  key: 'working_week_stated',
  title: 'State the working week',
  description: 'The days and the hours, in writing, within the statutory ceiling. Hours are recorded for compliance, never as a performance score.',
  category: 'other',
  ownerVia: 'onboarding_owner',
  dueDay: 1,
  asserts: 'working_hours',
};

const INTERN_MENTOR: PackStep = {
  key: 'mentor_assigned',
  title: 'Assign a mentor',
  description: 'One named person responsible for what this intern learns. An internship without a mentor is unsupervised work, which is a different thing with different obligations.',
  category: 'introductions',
  ownerVia: 'onboarding_owner',
  dueDay: 1,
};

const INTERN_END_DATE: PackStep = {
  key: 'end_date_recorded',
  title: 'Record the end date',
  description: 'An internship is time-bounded by definition. Record the last day and what is issued at it.',
  category: 'documents',
  ownerVia: 'onboarding_owner',
  dueDay: 0,
};

const INTERN_CREDIT_HOURS: PackStep = {
  key: 'credit_hours_explained',
  title: 'Explain how credit hours are counted',
  description: 'Hours are the certified output of this programme, so how they are measured and reported is something the intern must understand on day one rather than discover at the end.',
  category: 'reading',
  ownerVia: 'onboarding_owner',
  dueDay: 5,
};

const INTERN_CHECKIN: PackStep = {
  key: 'mentor_checkin',
  title: 'First-week check-in with the mentor',
  description: 'Whether the plan is the right plan, before eleven more weeks are spent on the wrong one.',
  category: 'other',
  ownerVia: 'onboarding_owner',
  dueDay: 7,
};

const NON_EMPLOYEE_INVOICING: PackStep = {
  key: 'invoicing_details',
  title: 'Record how they invoice us',
  description: 'Entity name, invoicing address, payment terms and bank details. They are paid against an invoice they raise, on the terms in the agreement.',
  category: 'documents',
  ownerVia: 'the_joiner',
  dueDay: 0,
};

const NON_EMPLOYEE_TAX: PackStep = {
  key: 'tax_registration_recorded',
  title: 'Record their tax registration',
  description: 'PAN and GST, or the local equivalent, in their own or their entity name. Somebody invoicing us with no tax registration of their own is usually not operating as a business.',
  category: 'documents',
  ownerVia: 'the_joiner',
  dueDay: 3,
};

/**
 * THE EXCLUSIONS THAT MAKE A CONTRACTOR PACK A CONTRACTOR PACK.
 *
 * Shared by `contractor` and `consultant` because the legal question is identical for both: neither
 * is our employee, and every one of these is a limb of the test that decides whether they were one
 * in fact. The whys are written for the HR user who is about to add one back.
 */
const NON_EMPLOYEE_EXCLUSIONS: readonly PackExclusion[] = [
  {
    control: 'working_hours',
    label: 'Setting their working hours',
    why: 'A genuine contractor decides when they work. Recording hours we set for them is a written record that we controlled their time, which is among the first things looked at when somebody claims they were really an employee. Agree delivery dates instead.',
  },
  {
    control: 'shift',
    label: 'Putting them on a shift or roster',
    why: 'A roster is coverage: it says we needed a body present at a time we chose, which is employment. If the work genuinely has to happen in a window, put the window in the statement of work as a delivery condition.',
  },
  {
    control: 'payroll',
    label: 'Enrolling them on payroll',
    why: 'They invoice us and we pay the invoice. A payroll record for a contractor is the clearest single document that we treated them as staff, and it gets created by a screen rather than by a decision anybody remembers making.',
  },
  {
    control: 'statutory',
    label: 'Setting up statutory contributions',
    why: 'Employee statutory schemes follow employment. Making contributions for a contractor asserts the very relationship those schemes exist for. If contributions genuinely should be made for this person, then they are an employee: change the classification rather than adding the step.',
  },
  {
    control: 'equipment',
    label: 'Issuing company equipment',
    why: 'The classification register defines a contractor as somebody who controls their own hours AND TOOLS. Issuing a laptop and putting it on the employee asset register, and therefore onto an employee exit checklist, contradicts that in writing. If the contract genuinely requires our hardware, record it as supplied under that clause, not on the staff register.',
  },
  {
    control: 'induction',
    label: 'The employee induction and first-week reading',
    why: 'An induction directs how somebody spends their first week, on material we chose. We engaged this person for an outcome and do not get to set their curriculum. Anything they genuinely need in order to deliver belongs in the statement of work as context.',
  },
  {
    control: 'policy_acknowledgement',
    label: 'Acknowledging the employee policies',
    why: 'This is the most damaging one. Acknowledging a step writes a timestamped, audited record that the person agreed to be bound by employee policies, which is exactly the exhibit a misclassification claim is built on. A contractor is bound by their contract: if confidentiality, data protection or site conduct genuinely apply, they are contract terms, not a handbook acknowledgement.',
  },
  {
    control: 'reporting_line',
    label: 'Giving them a reporting manager',
    why: 'Resolving a reporting manager stores a supervisor by name against this person. A contractor has a contract counterpart, not a manager. Use the point of contact step in the base pack, which records the same human without asserting supervision.',
  },
  {
    control: 'probation',
    label: 'A probation period',
    why: 'Probation tests somebody for permanence, and there is no permanence to test for: the engagement ends when the scope is delivered or the term runs out. If the concern is quality, that is what acceptance criteria in the statement of work are for.',
  },
  {
    control: 'leave',
    label: 'Leave balances and leave approval',
    why: 'Administering somebody time off means administering their working time. A contractor does not take leave from us; they deliver or they do not. Agreeing they are unavailable in August is a scheduling conversation, not an approval.',
  },
  {
    control: 'training',
    label: 'Company-directed training',
    why: 'Training somebody to do the work our way says the work is ours to define and theirs to perform, which is the economic-reality test almost verbatim. We engaged this person for expertise they already have.',
  },
];

// -------------------------------------------------------------------------------------------------
// THE PACKS
// -------------------------------------------------------------------------------------------------
// Record<EngagementKey, ...>: adding a key to CLASSIFICATIONS without a pack here is a compile
// error, so an engagement can never exist without an answer to "what do we ask this person to do".
export const ENGAGEMENT_PACKS: Record<EngagementKey, EngagementPack> = {
  permanent: {
    key: 'permanent',
    summary: 'The full employee pack. Payroll, statutory contributions, equipment, induction, probation -- all of it correct here, because this person IS an employee.',
    steps: [
      EMPLOYEE_PAYROLL,
      EMPLOYEE_STATUTORY,
      EMPLOYEE_EQUIPMENT,
      EMPLOYEE_WORKING_WEEK,
      {
        key: 'leave_balance',
        title: 'Open their leave balance',
        description: 'Annual leave, sick leave and public holidays for their country of work, credited from the joining date.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
        asserts: 'leave',
      },
      EMPLOYEE_MANAGER_INTRO,
      EMPLOYEE_INDUCTION,
      EMPLOYEE_POLICY_ACK,
      EMPLOYEE_PROBATION,
      EMPLOYEE_CHECKIN,
    ],
    excludes: [],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the tax record.', required: true },
      { docType: 'agreement', label: 'Signed appointment letter', why: 'The terms actually agreed, signed by both sides.', required: true },
      { docType: 'degree', label: 'Degree certificate', why: 'The qualification the role was offered against.', required: true },
      { docType: 'marksheet', label: 'Mark sheets', why: 'Verification of the degree.', required: false },
      { docType: 'experience', label: 'Relieving letter from the previous employer', why: 'Confirms they are free to join and closes the gap in the employment history. Only where they had a previous employer.', required: false },
    ],
  },

  part_time: {
    key: 'part_time',
    summary: 'An employee on agreed reduced days or hours. Everything an employee gets, pro-rata -- and the agreed hours stated in writing, because a part-time worker whose hours were never stated is a full-time worker in fact.',
    steps: [
      EMPLOYEE_PAYROLL,
      EMPLOYEE_STATUTORY,
      EMPLOYEE_EQUIPMENT,
      {
        key: 'agreed_hours_stated',
        title: 'State the agreed days and hours, in writing',
        description: 'Exactly which days and how many hours were agreed. This is the step that makes part-time real: an employee described as part-time who is in fact available all week is a full-time employee being paid for part of one.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
        asserts: 'working_hours',
      },
      {
        key: 'leave_prorata',
        title: 'Open their leave balance, pro-rata',
        description: 'The same leave, statutory contributions and gratuity accrual as any employee, in proportion to the agreed hours. Pro-rata means reduced, never withheld.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
        asserts: 'leave',
      },
      EMPLOYEE_MANAGER_INTRO,
      EMPLOYEE_INDUCTION,
      EMPLOYEE_POLICY_ACK,
      EMPLOYEE_PROBATION,
      EMPLOYEE_CHECKIN,
    ],
    excludes: [
      {
        control: 'shift',
        label: 'Rostering them outside the agreed days',
        why: 'Their agreed days are the engagement. Rostering beyond them, without agreeing and paying for the change, makes the stated hours a fiction -- which defeats the reason this classification exists at all.',
      },
    ],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the tax record.', required: true },
      { docType: 'agreement', label: 'Signed appointment letter stating the agreed days and hours', why: 'The hours have to be in the signed document, not only in a recollection of the conversation.', required: true },
      { docType: 'degree', label: 'Degree certificate', why: 'The qualification the role was offered against.', required: false },
      { docType: 'experience', label: 'Relieving letter from the previous employer', why: 'Only where they had one. A part-time joiner often holds another engagement, which is their business and not a gap to explain.', required: false },
    ],
  },

  fixed_term: {
    key: 'fixed_term',
    summary: 'An employee with an end date. The same pack as a permanent employee plus the end date and what happens at it. This is NOT the contractor pack: a fixed-term employee is an employee.',
    steps: [
      EMPLOYEE_PAYROLL,
      EMPLOYEE_STATUTORY,
      EMPLOYEE_EQUIPMENT,
      {
        key: 'term_end_recorded',
        title: 'Record the end date and what happens at it',
        description: 'The agreed last working day, whether it may be extended, and who decides. An employee who reaches an end date nobody wrote down is an employee being let go without notice.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      EMPLOYEE_WORKING_WEEK,
      {
        key: 'leave_balance',
        title: 'Open their leave balance for the term',
        description: 'Leave credited across the fixed term, so it is usable before the end date rather than lost at it.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
        asserts: 'leave',
      },
      EMPLOYEE_MANAGER_INTRO,
      EMPLOYEE_INDUCTION,
      EMPLOYEE_POLICY_ACK,
      EMPLOYEE_CHECKIN,
    ],
    excludes: [
      {
        control: 'probation',
        label: 'A probation period',
        why: 'The term is already defined and already ends. A probation on top of a fixed term tests for a permanence that was never offered, and it usually means the engagement should have been permanent with a probation, or fixed-term without one.',
      },
    ],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the tax record.', required: true },
      { docType: 'agreement', label: 'Signed appointment letter carrying the end date', why: 'The end date has to be in the signed document. A term nobody signed is not a term.', required: true },
      { docType: 'degree', label: 'Degree certificate', why: 'The qualification the role was offered against.', required: false },
      { docType: 'experience', label: 'Relieving letter from the previous employer', why: 'Only where they had a previous employer.', required: false },
    ],
  },

  intern: {
    key: 'intern',
    summary: 'A paid intern on a learning programme with a stipend explicitly recorded. Hours are the deliverable here: counted toward credits, not rostered for coverage.',
    steps: [
      {
        key: 'stipend_recorded',
        title: 'Record the stipend',
        description: 'The amount, the cycle it is paid on, and where it was agreed. If no stipend has actually been agreed then this person is an UNPAID intern and the classification must say so -- the two are different engagements with different obligations, not two amounts of the same one.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
        asserts: 'payroll',
      },
      INTERN_MENTOR,
      {
        key: 'learning_plan',
        title: 'Agree the learning plan',
        description: 'What this person will have learned by the end, and how they will be shown to have learned it. This is the document that makes it an internship rather than cheap staffing.',
        category: 'reading',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
      INTERN_END_DATE,
      INTERN_CREDIT_HOURS,
      EMPLOYEE_EQUIPMENT,
      EMPLOYEE_INDUCTION,
      EMPLOYEE_POLICY_ACK,
      INTERN_CHECKIN,
    ],
    excludes: [
      {
        control: 'probation',
        label: 'A probation period',
        why: 'The internship is already time-bounded and already assessed against the learning plan. A probation on top of it describes an employment being tested for permanence, which is not what was offered.',
      },
      {
        control: 'statutory',
        label: 'Employee statutory contributions',
        why: 'A stipend is not a salary, and an intern on a learning programme is not normally enrolled in the employee schemes. If contributions ARE being made for this person then they are being treated as an employee: change the classification to fixed-term rather than adding the step.',
      },
      {
        control: 'shift',
        label: 'Putting them on a shift or roster',
        why: 'Their hours are counted as learning, against credits. Rostering them for coverage turns the programme into staffing, which is precisely the thing an internship must not be.',
      },
    ],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the record the certificate is issued against.', required: true },
      { docType: 'agreement', label: 'Signed internship letter with the stipend and the end date', why: 'The stipend and the term have to be in the signed document.', required: true },
      { docType: 'marksheet', label: 'Current enrolment or latest mark sheet', why: 'Credit hours are reported against a programme somebody is actually enrolled on.', required: true },
      { docType: 'degree', label: 'Degree certificate', why: 'Only where the degree has already been awarded.', required: false },
    ],
  },

  intern_unpaid: {
    key: 'intern_unpaid',
    summary: 'An intern with NO stipend recorded, which is the default here. Everything the paid pack has EXCEPT anything that pays them -- and the fact that it is unpaid stated plainly, in writing, before the first day.',
    steps: [
      {
        key: 'unpaid_stated_in_writing',
        title: 'State plainly, in writing, that this internship is unpaid',
        description: 'Before the first day, in the letter, in words the person actually reads: no stipend is being paid. The default here is unpaid unless a stipend is explicitly recorded, and a default nobody was told about is not something anybody agreed to. If a stipend HAS been agreed, this is the wrong pack -- record them as a paid intern.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'learning_agreement',
        title: 'Sign the learning agreement',
        description: 'What is being taught, by whom, over what period, and what is issued at the end. This document is what makes an unpaid internship a learning relationship rather than unpaid labour, and it is the reason this person is an intern and not a volunteer.',
        category: 'documents',
        ownerVia: 'the_joiner',
        dueDay: 0,
      },
      INTERN_MENTOR,
      {
        key: 'learning_plan',
        title: 'Agree the learning plan',
        description: 'What this person will have learned by the end, and how they will be shown to have learned it. When nothing is being paid, this plan IS the consideration on our side, so it has to be real.',
        category: 'reading',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
      INTERN_END_DATE,
      INTERN_CREDIT_HOURS,
      EMPLOYEE_INDUCTION,
      EMPLOYEE_POLICY_ACK,
      INTERN_CHECKIN,
    ],
    excludes: [
      {
        control: 'payroll',
        label: 'Payroll enrolment, and any stipend step',
        why: 'There is nothing to enrol, because no stipend has been recorded. If money is in fact being paid to this person then the record here is wrong and the classification must change to paid intern: an unpaid engagement that quietly pays somebody is the worst of both records to have written down.',
      },
      {
        control: 'statutory',
        label: 'Employee statutory contributions',
        why: 'Nothing is being paid, so there is nothing to contribute against. Contributions appearing for an unpaid person mean the engagement is not what the record says it is.',
      },
      {
        control: 'shift',
        label: 'Putting them on a shift or roster',
        why: 'Rostering an unpaid person for coverage is asking somebody to work for nothing. Their hours are counted as learning against credits, and that is the only reason we count them at all.',
      },
      {
        control: 'probation',
        label: 'A probation period',
        why: 'There is no employment here to test. The programme has an end date and a learning plan, and those are the terms of it.',
      },
      {
        control: 'equipment',
        label: 'Issuing company equipment on the staff asset register',
        why: 'Lending an unpaid learner a laptop is often the right thing to do, but putting it on the employee asset register puts them onto an employee exit checklist. Record it as lent for the programme, with a return date, under the learning agreement.',
      },
    ],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the record the certificate is issued against.', required: true },
      { docType: 'agreement', label: 'Signed learning agreement stating that the internship is unpaid', why: 'The unpaid basis, the end date and what is issued at the end all have to be in the document the person signed.', required: true },
      { docType: 'marksheet', label: 'Current enrolment or latest mark sheet', why: 'Credit hours are reported against a programme somebody is actually enrolled on.', required: true },
      { docType: 'degree', label: 'Degree certificate', why: 'Only where the degree has already been awarded.', required: false },
    ],
  },

  apprentice: {
    key: 'apprentice',
    summary: 'A trainee under a registered contract of apprenticeship: a structured programme with a supervising practitioner, assessment points and a prescribed stipend. An apprentice is not a worker for most purposes, which changes what may be asked of them.',
    steps: [
      {
        key: 'training_agreement_registered',
        title: 'Register the contract of apprenticeship',
        description: 'An apprenticeship is a registered training contract, not a job offer with training attached. Record the contract, the programme it is registered against, and its term.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'stipend_recorded',
        title: 'Record the prescribed stipend',
        description: 'The rate, the cycle, and the rule that sets it. An apprentice stipend is prescribed rather than negotiated, so record which rate applies.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
        asserts: 'payroll',
      },
      {
        key: 'supervisor_assigned',
        title: 'Assign the supervising practitioner',
        description: 'The named person qualified to supervise this trade or discipline, who signs off the assessments. Not simply whoever has capacity.',
        category: 'introductions',
        ownerVia: 'onboarding_owner',
        dueDay: 1,
      },
      {
        key: 'programme_schedule',
        title: 'Give them the programme schedule',
        description: 'The modules, the order, and how much of the term is on-the-job against off-the-job training. An apprenticeship is a syllabus with dates.',
        category: 'reading',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
      {
        key: 'assessment_points',
        title: 'Agree the assessment points',
        description: 'When they are assessed, against what standard, and by whom. Assessment is how an apprenticeship progresses; it is not a performance review.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 5,
      },
      {
        key: 'training_hours_explained',
        title: 'Explain how training hours are counted',
        description: 'The on-the-job hours are part of the registered programme and are reported against it.',
        category: 'reading',
        ownerVia: 'onboarding_owner',
        dueDay: 5,
      },
      EMPLOYEE_EQUIPMENT,
      EMPLOYEE_INDUCTION,
      EMPLOYEE_POLICY_ACK,
    ],
    excludes: [
      {
        control: 'probation',
        label: 'A probation period',
        why: 'The apprenticeship already has a term and assessment points, and that IS the mechanism for deciding whether it is going well. A probation describes an employment being tested, and an apprentice is not an employee.',
      },
      {
        control: 'statutory',
        label: 'Employee statutory contributions',
        why: 'An apprentice under a registered contract is expressly not a worker for most purposes, so the employee schemes do not follow automatically. Check what the registered programme actually requires instead of applying the employee defaults.',
      },
      {
        control: 'shift',
        label: 'Putting them on a shift or roster',
        why: 'Their time belongs to the training programme, split between on-the-job and off-the-job learning. Rostering them for coverage takes the off-the-job half, which is the half that makes it an apprenticeship.',
      },
    ],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the registration record.', required: true },
      { docType: 'agreement', label: 'Registered contract of apprenticeship', why: 'The registration is what makes this an apprenticeship in law rather than a description of a junior job.', required: true },
      { docType: 'marksheet', label: 'Latest mark sheet or training record', why: 'The entry standard the programme was registered against.', required: true },
      { docType: 'certification', label: 'Trade or discipline certification', why: 'Only where the programme requires an entry certification.', required: false },
    ],
  },

  contractor: {
    key: 'contractor',
    summary: 'An independent contractor. Contract, scope and invoicing -- and NO step that asserts control over how, when or with what they work. This is the highest-risk classification in the register, and this pack is deliberately short.',
    steps: [
      {
        key: 'contract_and_sow',
        title: 'Record the signed contract and statement of work',
        description: 'The contract and the SOW together: deliverables, milestones, acceptance criteria, and how a change of scope is agreed. This is what the engagement IS, and it is the only document that governs it.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'scope_agreed',
        title: 'Confirm the scope is agreed on both sides',
        description: 'Both parties agree what is in and what is out. Scope creep is how a contractor becomes an employee in fact: it starts with one small thing outside the SOW that nobody wrote down.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      NON_EMPLOYEE_INVOICING,
      NON_EMPLOYEE_TAX,
      {
        key: 'delivery_dates_agreed',
        title: 'Agree the delivery dates',
        description: 'The dates the deliverables are due. These are OUTCOME dates agreed between two parties, not a schedule of attendance we set. That difference is the whole classification.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
      {
        key: 'own_equipment_confirmed',
        title: 'Confirm they are working on their own equipment',
        description: 'A contractor supplies their own tools. If the contract genuinely requires our hardware -- a licensed environment, a security requirement -- record it as supplied under that clause with a return date, never on the employee asset register, which would place them on an employee exit checklist.',
        category: 'equipment',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'confidentiality_in_contract',
        title: 'Check confidentiality and data protection are IN THE CONTRACT',
        description: 'They almost certainly need to apply. For a contractor they are contract terms, agreed and signed, and not an employee handbook acknowledged on a checklist. If they are missing from the contract, fix the contract.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
    ],
    excludes: NON_EMPLOYEE_EXCLUSIONS,
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the tax record. Nothing beyond it.', required: true },
      { docType: 'agreement', label: 'Signed contract and statement of work', why: 'The only document that governs this engagement.', required: true },
      { docType: 'tax_registration', label: 'Tax registration', why: 'They invoice us, and this is what they invoice from.', required: true },
      { docType: 'certification', label: 'Professional licence or certification', why: 'Only where the work legally requires one.', required: false },
    ],
  },

  consultant: {
    key: 'consultant',
    summary: 'A short advisory engagement under a separate consulting agreement. Not our employee, so the contractor exclusions apply in full.',
    steps: [
      {
        key: 'consulting_agreement',
        title: 'Record the signed consulting agreement',
        description: 'The separate consulting agreement, with the advisory scope, the term and the fee basis.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'scope_agreed',
        title: 'Confirm the advisory scope is agreed on both sides',
        description: 'What they are advising on and what they are not. An advisor who drifts into running something has stopped being an advisor.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      NON_EMPLOYEE_INVOICING,
      NON_EMPLOYEE_TAX,
      {
        key: 'engagement_end_agreed',
        title: 'Agree when the engagement ends',
        description: 'A consulting engagement is short by definition. An advisory relationship with no end date that runs for years is an employment nobody wrote down.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
      {
        key: 'confidentiality_in_contract',
        title: 'Check confidentiality and data protection are IN THE AGREEMENT',
        description: 'An advisor usually sees more than most employees do. Those obligations belong in the signed agreement, not in a handbook acknowledgement.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 3,
      },
    ],
    excludes: NON_EMPLOYEE_EXCLUSIONS,
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Identity, and the tax record.', required: true },
      { docType: 'agreement', label: 'Signed consulting agreement', why: 'The document that governs the advice, the term and the fee.', required: true },
      { docType: 'tax_registration', label: 'Tax registration', why: 'They invoice us, and this is what they invoice from.', required: true },
      { docType: 'certification', label: 'Professional licence or certification', why: 'Only where the advice legally requires one.', required: false },
    ],
  },

  eor: {
    key: 'eor',
    summary: 'Employed by an Employer-of-Record partner in their own country. THE PARTNER is their employer and runs local payroll, contributions and leave. Our steps are scope and access, and nothing that only an employer may do.',
    steps: [
      {
        key: 'eor_partner_recorded',
        title: 'Record which partner employs them, and where',
        description: 'The Employer-of-Record partner and the country of employment. Everything about this person legally routes through that partner, so the record has to name it.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'eor_assignment_recorded',
        title: 'Record the assignment under the partner agreement',
        description: 'The assignment letter or schedule under our agreement with the partner, showing what this person is engaged to do and for how long.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'scope_agreed',
        title: 'Confirm the scope of work',
        description: 'What this person actually does for us, agreed with them and with the partner.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'local_terms_confirmed',
        title: 'Confirm with the partner that local terms are in place',
        description: 'Local payroll, statutory contributions and leave are running in their country, under their employment. Confirm it; do not set it up. Setting any of it up ourselves is the act that would make us their employer in fact.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 5,
      },
      EMPLOYEE_INDUCTION,
    ],
    excludes: [
      {
        control: 'payroll',
        label: 'Enrolling them on our payroll',
        why: 'Their employer pays them. Paying this person directly, from our entity, is the single act that makes us their employer in fact and defeats the entire reason for engaging through a partner.',
      },
      {
        control: 'statutory',
        label: 'Setting up statutory contributions',
        why: 'Contributions are made in their country, by their employer, under the rules of that country. Ours would be both wrong and evidence of an employment relationship we do not have.',
      },
      {
        control: 'leave',
        label: 'Administering their leave',
        why: 'Their leave entitlement comes from their local employment terms and is administered by their employer. We agree availability with them; we do not approve their time off.',
      },
      {
        control: 'probation',
        label: 'A probation period',
        why: 'Any probation belongs to their employment with the partner, under the rules of that country. What we can do is end the assignment under the partner agreement.',
      },
      {
        control: 'policy_acknowledgement',
        label: 'Acknowledging OUR employee policies',
        why: 'Policy obligations reach this person through their own employment contract with the partner. Taking a direct acknowledgement from them asserts that we are their employer, which is precisely what this arrangement exists to avoid.',
      },
    ],
    documents: [
      { docType: 'agreement', label: 'Assignment under the partner agreement', why: 'What they are engaged to do, and under whose employment.', required: true },
      { docType: 'identity', label: 'Government ID', why: 'Only if the partner does not already hold it: they are the employer, and the identity check is theirs to run.', required: false },
    ],
  },

  volunteer: {
    key: 'volunteer',
    summary: 'An unpaid contributor who offered their labour. No pay of any kind, a clear and narrow scope, and the local-law check the classification register already warns about. NOT a substitute for an unpaid intern: a volunteer gets no learning plan, no credits and no certificate.',
    steps: [
      {
        key: 'no_pay_stated',
        title: 'State in writing that nothing is paid',
        description: 'No stipend, no fee, no expenses dressed up as wages, no benefit in kind. If ANYTHING is being paid then this person is not a volunteer and the classification is wrong.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'volunteer_scope',
        title: 'Write down exactly what they volunteered to do, and for how long',
        description: 'Narrow and specific. A vague scope is how a volunteer ends up doing a job somebody should have been paid for, which is the risk this classification carries.',
        category: 'documents',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'local_law_check',
        title: 'Check local labour law before they start',
        description: 'The register rates this classification HIGH risk and says to use it sparingly. Unpaid work is regulated differently in different places, and the check belongs before the first day rather than after a complaint.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 0,
      },
      {
        key: 'safety_briefing',
        title: 'Brief them on staying safe doing it',
        description: 'A briefing on the specific activity they volunteered for. This is a duty of care, and it is deliberately not an employee induction.',
        category: 'other',
        ownerVia: 'onboarding_owner',
        dueDay: 1,
      },
    ],
    excludes: [
      {
        control: 'payroll',
        label: 'Any payment at all',
        why: 'Paying a volunteer makes them a worker. There is no small amount that is safe: a regular payment, however it is described, is the fact a claim gets built on.',
      },
      {
        control: 'statutory',
        label: 'Statutory contributions',
        why: 'Nothing is paid, so there is nothing to contribute against. Their appearance would mean the engagement is not what the record says it is.',
      },
      {
        control: 'working_hours',
        label: 'Setting their hours',
        why: 'A volunteer offers time and we do not set it. Hours we require are hours somebody is owed for.',
      },
      {
        control: 'shift',
        label: 'Putting them on a roster',
        why: 'Rostering an unpaid person for coverage is unpaid labour with a schedule attached. If the work needs covering reliably, it needs paying for.',
      },
      {
        control: 'induction',
        label: 'The employee induction',
        why: 'An induction inducts somebody into a job. A volunteer needs a briefing on the specific thing they offered to do and how to stay safe doing it, which is the safety briefing step in this pack.',
      },
      {
        control: 'equipment',
        label: 'Issuing company equipment on the staff asset register',
        why: 'Anything lent should be recorded as lent, with a return date, under the volunteer arrangement. The staff asset register puts them on an employee exit checklist and makes the relationship look like employment on paper.',
      },
      {
        control: 'probation',
        label: 'A probation period',
        why: 'There is no engagement here to confirm. Either the help is useful and welcome, or the arrangement ends -- and neither of those needs a probation.',
      },
      {
        control: 'leave',
        label: 'Leave balances',
        why: 'They are not working for us in a sense that accrues leave. Asking a volunteer to book time off asserts an obligation to be present that nobody agreed to.',
      },
    ],
    documents: [
      { docType: 'identity', label: 'Government ID', why: 'Who is on our premises and in our systems.', required: true },
      { docType: 'agreement', label: 'Signed volunteer arrangement', why: 'It states the scope and states that nothing is paid. Both matter, and both have to be written down.', required: true },
    ],
  },
};

// -------------------------------------------------------------------------------------------------
// READING A PACK
// -------------------------------------------------------------------------------------------------

const PACK_KEYS: readonly string[] = Object.keys(ENGAGEMENT_PACKS);
const DOC_TYPE_KEYS: ReadonlySet<string> = new Set(DOC_TYPES.map((d) => String(d.key)));

/** Every engagement that has a pack, in spine order. */
export function engagementKeys(): readonly EngagementKey[] {
  return PACK_KEYS as readonly EngagementKey[];
}

/** Is this string one of the engagements the spine knows about? */
export function isEngagementKey(raw: unknown): raw is EngagementKey {
  return typeof raw === 'string' && PACK_KEYS.includes(raw);
}

/** The pack for one engagement, or null when the string is not a spine key. Never guesses. */
export function packFor(key: unknown): EngagementPack | null {
  return isEngagementKey(key) ? ENGAGEMENT_PACKS[key] : null;
}

/** The classification label, read from the spine rather than restated here. */
export function engagementLabelFor(key: EngagementKey): string {
  return CLASSIFICATIONS[key].label;
}

/** The risk rating the spine attaches to this engagement. The 'high' packs are the ones to read twice. */
export function engagementRiskFor(key: EngagementKey): string {
  return String(CLASSIFICATIONS[key].risk);
}

/**
 * THE WHOLE CHECKLIST for one engagement: the base every joiner needs, then this engagement's own
 * steps, ordered by when they fall due.
 *
 * The base is filtered against the pack's exclusions as a belt-and-braces measure, but no base step
 * carries a control today and a test asserts that this stays true. The real guarantee is that an
 * excluded step is never written into the pack in the first place.
 */
export function stepsForEngagement(key: EngagementKey): readonly PackStep[] {
  const pack = ENGAGEMENT_PACKS[key];
  const excluded = new Set<string>(pack.excludes.map((x) => x.control));
  const base = BASE_STEPS.filter((s) => !s.asserts || !excluded.has(s.asserts));
  return [...base, ...pack.steps].sort((a, b) => a.dueDay - b.dueDay);
}

/** The document set this engagement owes. Every one is a Google Drive link; nothing is uploaded. */
export function documentsForEngagement(key: EngagementKey): readonly PackDocument[] {
  return ENGAGEMENT_PACKS[key].documents;
}

/**
 * The documents that are REQUIRED. This is what a "0 of N verified" counter should be counting:
 * today the portal shows however many links the person happened to add, which tells a joiner
 * nothing about whether they are finished.
 */
export function requiredDocumentsForEngagement(key: EngagementKey): readonly PackDocument[] {
  return ENGAGEMENT_PACKS[key].documents.filter((d) => d.required);
}

/** The exclusion for one control on one engagement, or null. Used to explain a refusal in words. */
export function exclusionFor(key: EngagementKey, control: ControlSignal): PackExclusion | null {
  return ENGAGEMENT_PACKS[key].excludes.find((x) => x.control === control) || null;
}

/** Does this engagement forbid this control? */
export function excludesControl(key: EngagementKey, control: ControlSignal): boolean {
  return exclusionFor(key, control) !== null;
}

/**
 * EVERYTHING WRONG WITH ONE PACK, in sentences. Empty means the pack is coherent.
 *
 * This is the machine check behind the promise at the top of the file. A step that asserts a control
 * its own pack excludes is a contradiction, and it is caught here rather than being discovered by
 * somebody in a dispute. The suite runs it across every pack.
 */
export function packProblems(pack: EngagementPack): string[] {
  const problems: string[] = [];
  const excluded = new Set<string>();

  for (const x of pack.excludes) {
    if (excluded.has(x.control)) problems.push(pack.key + ': the control "' + x.control + '" is excluded twice.');
    excluded.add(x.control);
    if (!String(x.label || '').trim()) problems.push(pack.key + ': an exclusion of "' + x.control + '" has no label.');
    if (String(x.why || '').trim().length < 40) {
      problems.push(pack.key + ': the exclusion of "' + x.control + '" has no usable reason. Somebody adding it back has to be able to read what they are undoing.');
    }
  }

  const seen = new Set<string>();
  for (const s of [...BASE_STEPS, ...pack.steps]) {
    if (seen.has(s.key)) problems.push(pack.key + ': two steps share the key "' + s.key + '".');
    seen.add(s.key);
    if (s.asserts && excluded.has(s.asserts)) {
      problems.push(pack.key + ': the step "' + s.key + '" asserts "' + s.asserts + '", which this engagement excludes.');
    }
    if (s.dueDay < 0) problems.push(pack.key + ': the step "' + s.key + '" falls due before the joining date.');
    if (s.requiresAcknowledgement && s.category !== 'policy') {
      problems.push(pack.key + ': the step "' + s.key + '" records an acknowledgement but is not a policy step.');
    }
  }

  if (pack.documents.length === 0) {
    problems.push(pack.key + ': no document set. Every engagement owes at least the document that governs it.');
  }
  if (pack.documents.length > MAX_DOCS) {
    problems.push(pack.key + ': asks for ' + pack.documents.length + ' documents, but a joiner may submit at most ' + MAX_DOCS + '.');
  }
  if (!pack.documents.some((d) => d.required)) {
    problems.push(pack.key + ': no document is required, so the set asks for nothing.');
  }
  for (const d of pack.documents) {
    if (!DOC_TYPE_KEYS.has(String(d.docType))) {
      problems.push(pack.key + ': the document type "' + d.docType + '" is not one the joining documents screen offers.');
    }
    if (!String(d.why || '').trim()) problems.push(pack.key + ': the document "' + d.label + '" does not say why it is needed.');
  }

  return problems;
}

/** Every problem across every pack. The suite asserts this is empty; a screen may show it. */
export function allPackProblems(): string[] {
  const out: string[] = [];
  for (const key of engagementKeys()) {
    out.push(...packProblems(ENGAGEMENT_PACKS[key]));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// THE BRIDGE FROM THE FREE-TEXT COLUMN
// -------------------------------------------------------------------------------------------------

export interface EngagementResolution {
  /** The spine key, or null when the recorded value does not settle the question. */
  readonly key: EngagementKey | null;
  /** Why, in a sentence an HR user can act on. Never empty. */
  readonly reason: string;
}

/**
 * READ hr_employees.employment_type AND SAY WHICH ENGAGEMENT IT MEANS -- OR REFUSE.
 *
 * This is a HINT resolver that seeds a classification review. It is not a selector: nothing should
 * start somebody's checklist from its output without a human having confirmed the classification,
 * because the column it reads is free text written by five screens in five vocabularies with no
 * constraint on it.
 *
 * IT REFUSES ON THE WORD "CONTRACT", AND THAT REFUSAL IS THE MOST IMPORTANT LINE IN THE FILE.
 * "Contract" is offered on the employee form AND on the offer form, and it means either a
 * fixed-term EMPLOYEE (risk low, the full employee pack correct) or an independent CONTRACTOR (risk
 * high, that same pack actively harmful). One word, two classifications, opposite risk ratings,
 * opposite packs. A resolver that picked one would be wrong roughly half the time, in the direction
 * that manufactures liability -- so it picks neither and says why.
 *
 * `stipendRecorded` decides between the two internships, because the company default is that an
 * internship is unpaid unless a stipend is explicitly recorded. Pass true only when a stipend
 * actually is on the record.
 */
export function resolveEngagementKey(
  raw: string | null | undefined,
  opts?: { stipendRecorded?: boolean },
): EngagementResolution {
  const original = String(raw ?? '').trim();
  if (!original) {
    return { key: null, reason: 'No engagement type is recorded for this person, so there is nothing to read. Classify them on the worker classification register.' };
  }

  // A spine key stored verbatim is already the answer; no inference needed.
  if (isEngagementKey(original)) {
    return { key: original, reason: 'Recorded as "' + engagementLabelFor(original) + '" on the classification register.' };
  }

  // Underscores, hyphens and spaces all collapse to one space, so 'full_time', 'Full-Time' and
  // 'full time' read alike. An underscore is a word character, which is why it cannot be left to \b.
  const s = original.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

  // \bintern(?!a) is the expression the admin door, the intern guard and the workspace gate all
  // already use. A bare includes('intern') demoted an "Internal Auditor" once and must not again.
  if (/\bapprentice/.test(s)) {
    return { key: 'apprentice', reason: 'Reads as an apprenticeship. Confirm a registered contract of apprenticeship exists before onboarding them as one.' };
  }
  if (/\bintern(?!a)/.test(s)) {
    if (opts && opts.stipendRecorded === true) {
      return { key: 'intern', reason: 'An internship with a stipend on the record, so it is the paid intern pack.' };
    }
    return { key: 'intern_unpaid', reason: 'An internship with no stipend recorded. The default here is unpaid unless a stipend is explicitly recorded, so this resolves to the unpaid intern pack. If a stipend was agreed, record it and this becomes a paid internship.' };
  }
  if (/\bvolunteer|\bvoluntary\b/.test(s)) {
    return { key: 'volunteer', reason: 'Reads as a volunteer. Check this is not actually an unpaid intern: an unpaid intern has a learning plan, a mentor and a certificate, and a volunteer has none of those.' };
  }
  if (/\bfreelanc/.test(s)) {
    return { key: 'contractor', reason: 'Freelance is not a separate legal category, it is independent contracting reached by a different route. Record the route on "engaged via" -- direct, or through a marketplace.' };
  }
  if (/\bconsultant\b|\bconsulting\b|\badvisor\b|\badviser\b/.test(s)) {
    return { key: 'consultant', reason: 'Reads as an advisory engagement, which needs a separate consulting agreement.' };
  }
  if (/\bcontractor\b|\bretainer\b|\bsow\b|\bvendor\b/.test(s)) {
    return { key: 'contractor', reason: 'Reads as an independent contractor, the highest-risk classification on the register. Confirm they invoice us and control their own hours and tools before using this pack.' };
  }
  if (/\bfixed term\b/.test(s)) {
    return { key: 'fixed_term', reason: 'Reads as a fixed-term EMPLOYEE, which is an employee with an end date and not a contractor.' };
  }
  if (/\beor\b|employer of record/.test(s)) {
    return { key: 'eor', reason: 'Employed through an Employer-of-Record partner. Record which partner, and which country.' };
  }
  if (/\bpart time\b|\bparttime\b/.test(s)) {
    return { key: 'part_time', reason: 'Reads as a part-time EMPLOYEE. The agreed days and hours have to be stated in writing.' };
  }
  if (/\bfull time\b|\bfulltime\b|\bpermanent\b/.test(s)) {
    return { key: 'permanent', reason: 'Reads as a permanent employee.' };
  }

  // THE REFUSALS. Both of these are values a screen in this product actually writes today.
  if (/\bcontract\b/.test(s)) {
    return {
      key: null,
      reason: 'The word "contract" does not say which engagement this is. It means either a fixed-term EMPLOYEE (low risk, where the full employee pack is correct) or an independent CONTRACTOR (high risk, where that same pack is evidence against us). Somebody has to decide which, on the classification register, before a checklist is started.',
    };
  }
  if (/\bfellowship\b|\bfellow\b/.test(s)) {
    return {
      key: null,
      reason: 'A fellowship is not a classification. Decide what it is in substance -- usually a paid intern, an unpaid intern or a consultant -- and record that.',
    };
  }

  return {
    key: null,
    reason: 'The recorded engagement "' + original + '" does not match anything on the classification register. Classify this person before starting their checklist.',
  };
}
