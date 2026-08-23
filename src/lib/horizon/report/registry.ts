// src/lib/horizon/report/registry.ts — THE NINE REPORTS, DECLARED RATHER THAN CODED.
//
// A report is data here, not a function. Every difference between the nine — who may read it, whose
// record it is about, which sources it needs, how far back it looks, which decision it sits beside —
// is a field on a definition, and engine.ts is one code path that reads those fields. That matters
// for a reason the brief states directly: RBAC has to be strict and auditable. Nine hand-written
// generators would mean nine places to get an access check right, and the tenth report would be
// written by copying the one whose check was weakest.
//
// Adding a report is adding an entry here plus, if it needs data nothing else needs, a provider.
// Nothing in engine.ts changes.
//
// CAPABILITY KEYS, NOT TABLE NAMES. `requires` lists what a report needs to KNOW, and sources.ts
// resolves each key to whichever provider claims it. A report therefore does not break when the
// patch that owns hiring data reorganises its tables, and this patch does not have to be told.
// A key nothing answers is not an error: the report renders and says, in the coverage block, which
// part of itself could not be filled and why.
import type { Permission } from '@/lib/auth/permissions';
import { REPORT_IDS, type ReportDefinition, type ReportId } from './types';

// =================================================================================================
// CAPABILITY KEYS
// =================================================================================================
//
// The vocabulary a report uses to ask for data. Exported so a provider written by another patch can
// declare against the same strings rather than guessing them, and so a test can assert that every
// key some report requires is a key some provider claims — or is knowingly unclaimed.
export const CAPABILITIES = {
  // Hiring-side, owned by the talent patch.
  APPLICANT_PROFILE: 'applicant.profile',
  APPLICANT_PIPELINE: 'applicant.pipeline',
  APPLICANT_EVALUATIONS: 'applicant.evaluations',
  APPLICANT_INTERVIEWS: 'applicant.interviews',
  APPLICANT_SELECTION: 'applicant.selection',
  // Employment-side, owned by the HR patch.
  EMPLOYEE_PROFILE: 'employee.profile',
  EMPLOYEE_PERFORMANCE: 'employee.performance',
  EMPLOYEE_SKILLS: 'employee.skills',
  EMPLOYEE_LEARNING: 'employee.learning',
  EMPLOYEE_FEEDBACK: 'employee.feedback',
  EMPLOYEE_REPORTS: 'employee.reports',
  // Time, owned by the attendance and leave patches.
  TIME_ATTENDANCE: 'time.attendance',
  TIME_LEAVE: 'time.leave',
  TIME_LOGS: 'time.logs',
  // Organisation shape, owned by the org-graph patch.
  ORG_POSITION: 'org.position',
  ORG_MOBILITY: 'org.mobility',
  ORG_AGGREGATE: 'org.aggregate',
  /**
   * THE MASTER RECORD ITSELF — whatever every other HORIZON patch has registered with
   * src/lib/horizon/record.ts, composed and relayed in.
   *
   * This is the capability that stops this engine becoming a second, competing view of a person. The
   * adapter behind it calls composeRecord() and maps each result and signal into the section its own
   * dataClass already declares, so a patch that contributes to the master record appears in these
   * reports without registering anything here and without this patch knowing it exists.
   */
  MEIR_RECORD: 'meir.record',
} as const;

export type CapabilityKey = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * The subject id used for organisation-wide reports, which have no row of their own to point at.
 * A sentinel rather than an empty string, so an accidental blank never resolves to "the whole
 * organisation" — the most disclosive subject there is.
 */
export const ORGANISATION_SUBJECT_ID = 'organisation';

// =================================================================================================
// THE DEFINITIONS
// =================================================================================================

const C = CAPABILITIES;

/**
 * Read via `reportDefinition()`. Frozen because a definition is an access-control record: a module
 * that could mutate `requiredPermissions` at runtime is a module that can widen access at runtime.
 */
const DEFINITIONS: Record<ReportId, ReportDefinition> = {
  // 1 ----------------------------------------------------------------------------------------
  applicant_intelligence_summary: {
    id: 'applicant_intelligence_summary',
    title: 'Applicant intelligence summary',
    purpose:
      'What the organisation has recorded about one application, in one place, before anybody spends '
      + 'an hour on it. Written for recruitment.',
    subjectKind: 'applicant',
    audience: 'recruiter',
    requiredPermissions: ['applications.view'] as Permission[],
    allowSelf: false,
    requires: [C.APPLICANT_PROFILE, C.APPLICANT_PIPELINE, C.APPLICANT_EVALUATIONS, C.MEIR_RECORD],
    windowDays: null,
    sensitivity: 'standard',
    decisionContext: 'hiring',
  },

  // 2 ----------------------------------------------------------------------------------------
  interview_decision_support: {
    id: 'interview_decision_support',
    title: 'Interview decision support',
    purpose:
      'What the panel has already been told and what they scored, gathered so an interviewer is not '
      + 'reading a candidate cold and is not re-asking a question a colleague already asked.',
    subjectKind: 'applicant',
    audience: 'interviewer',
    // Either scoring an application or authoring interviews is enough. Both are held by people who
    // are already inside the hiring process for this candidate.
    requiredPermissions: ['applications.score', 'interviews.author'] as Permission[],
    allowSelf: false,
    requires: [C.APPLICANT_PROFILE, C.APPLICANT_PIPELINE, C.APPLICANT_EVALUATIONS, C.APPLICANT_INTERVIEWS, C.APPLICANT_SELECTION, C.MEIR_RECORD],
    windowDays: null,
    // Elevated: it exposes how colleagues scored the same person, which is exactly the thing that
    // should not leak sideways out of a hiring process.
    sensitivity: 'elevated',
    decisionContext: 'hiring',
  },

  // 3 ----------------------------------------------------------------------------------------
  employee_professional_intelligence: {
    id: 'employee_professional_intelligence',
    title: 'Employee professional intelligence',
    purpose:
      'The professional record of one person: what they have done, what has been measured, what has been '
      + 'said, and what the system reads into it. Written so the person themselves can read it.',
    subjectKind: 'employee',
    audience: 'employee_self',
    requiredPermissions: ['employee.manage'] as Permission[],
    // THE ONE REPORT AN EMPLOYEE MAY OPEN ABOUT THEMSELVES WITH NO ADMIN PERMISSION AT ALL. A system
    // that reasons about somebody and will not show them the reasoning is not auditable by the only
    // person with a real interest in auditing it.
    allowSelf: true,
    requires: [C.EMPLOYEE_PROFILE, C.EMPLOYEE_PERFORMANCE, C.EMPLOYEE_SKILLS, C.EMPLOYEE_LEARNING, C.EMPLOYEE_FEEDBACK, C.MEIR_RECORD],
    windowDays: null,
    sensitivity: 'standard',
    decisionContext: null,
  },

  // 4 ----------------------------------------------------------------------------------------
  manager_development: {
    id: 'manager_development',
    title: 'Manager development report',
    purpose:
      'How the team under one manager is doing and what those people say, framed as development for '
      + 'the manager rather than as a scoreboard of the people under them.',
    subjectKind: 'manager',
    audience: 'manager',
    requiredPermissions: ['employee.manage'] as Permission[],
    allowSelf: true,
    requires: [C.EMPLOYEE_PROFILE, C.EMPLOYEE_REPORTS, C.EMPLOYEE_FEEDBACK, C.EMPLOYEE_PERFORMANCE, C.MEIR_RECORD],
    windowDays: 365,
    sensitivity: 'elevated',
    decisionContext: null,
  },

  // 5 ----------------------------------------------------------------------------------------
  hr_talent_development: {
    id: 'hr_talent_development',
    title: 'Talent development report',
    purpose:
      'Where the demonstrated skills of one person sit against what their role asks for, and which of '
      + 'the gaps already have learning assigned against them.',
    subjectKind: 'employee',
    audience: 'hr',
    requiredPermissions: ['employee.manage'] as Permission[],
    allowSelf: false,
    requires: [C.EMPLOYEE_PROFILE, C.EMPLOYEE_SKILLS, C.EMPLOYEE_LEARNING, C.EMPLOYEE_PERFORMANCE, C.ORG_POSITION, C.MEIR_RECORD],
    windowDays: 730,
    sensitivity: 'elevated',
    // Sits beside promotion, so boundary recommendations and decisions of that kind are surfaced.
    decisionContext: 'promotion',
  },

  // 6 ----------------------------------------------------------------------------------------
  founder_360_intelligence: {
    id: 'founder_360_intelligence',
    title: 'Founder 360 intelligence',
    purpose:
      'The organisation at a glance: headcount shape, review coverage, feedback volume, and where the '
      + 'record is too thin to conclude anything. Aggregate only.',
    subjectKind: 'organisation',
    audience: 'founder',
    // profiles.manage is granted to super_admin and to nobody else in PERMS_BY_ROLE — the narrowest
    // gate available without adding a permission name to a union several patches read.
    requiredPermissions: ['profiles.manage'] as Permission[],
    allowSelf: false,
    requires: [C.ORG_AGGREGATE],
    windowDays: 365,
    sensitivity: 'elevated',
    decisionContext: null,
  },

  // 7 ----------------------------------------------------------------------------------------
  longitudinal_behaviour: {
    id: 'longitudinal_behaviour',
    title: 'Longitudinal behaviour report',
    purpose:
      'How the recorded measures for one person have moved over two years, with the direction stated '
      + 'separately from any reading of why.',
    subjectKind: 'employee',
    audience: 'hr',
    requiredPermissions: ['employee.manage'] as Permission[],
    allowSelf: true,
    requires: [C.EMPLOYEE_PROFILE, C.EMPLOYEE_PERFORMANCE, C.EMPLOYEE_FEEDBACK, C.TIME_ATTENDANCE, C.MEIR_RECORD],
    windowDays: 730,
    sensitivity: 'elevated',
    decisionContext: null,
  },

  // 8 ----------------------------------------------------------------------------------------
  time_intelligence: {
    id: 'time_intelligence',
    title: 'Time intelligence report',
    purpose:
      'Attendance, leave and logged hours over a quarter, with the gaps in the record shown as gaps '
      + 'rather than as zeroes.',
    subjectKind: 'employee',
    audience: 'manager',
    requiredPermissions: ['employee.manage'] as Permission[],
    allowSelf: true,
    requires: [C.EMPLOYEE_PROFILE, C.TIME_ATTENDANCE, C.TIME_LEAVE, C.TIME_LOGS, C.MEIR_RECORD],
    windowDays: 90,
    sensitivity: 'standard',
    // Deliberately null. Attendance data sits near disciplinary action, and tagging this report with
    // that decision kind would pull disciplinary recommendations onto a routine time screen and
    // teach managers to read the two together. If a disciplinary matter exists it belongs on the
    // surface that owns it, with the boundary's explanation attached.
    decisionContext: null,
  },

  // 9 ----------------------------------------------------------------------------------------
  role_mobility: {
    id: 'role_mobility',
    title: 'Role mobility report',
    purpose:
      'Where one person could move next inside the organisation, on the evidence of what they have '
      + 'demonstrated rather than on what they applied for.',
    subjectKind: 'employee',
    audience: 'hr',
    requiredPermissions: ['employee.manage'] as Permission[],
    allowSelf: true,
    requires: [C.EMPLOYEE_PROFILE, C.EMPLOYEE_SKILLS, C.EMPLOYEE_PERFORMANCE, C.ORG_POSITION, C.ORG_MOBILITY, C.MEIR_RECORD],
    windowDays: 730,
    sensitivity: 'elevated',
    decisionContext: 'promotion',
  },
};

for (const id of REPORT_IDS) Object.freeze(DEFINITIONS[id]);
Object.freeze(DEFINITIONS);

export function reportDefinition(id: string): ReportDefinition | null {
  if (!id) return null;
  return (DEFINITIONS as Record<string, ReportDefinition>)[id] || null;
}

export function allReportDefinitions(): ReportDefinition[] {
  return REPORT_IDS.map((id) => DEFINITIONS[id]);
}

export function isReportId(v: unknown): v is ReportId {
  return typeof v === 'string' && (REPORT_IDS as readonly string[]).indexOf(v) >= 0;
}

/** Every capability any report asks for. Used by the console to show what is and is not wired. */
export function allRequiredCapabilities(): string[] {
  const seen = new Set<string>();
  for (const def of allReportDefinitions()) for (const c of def.requires) seen.add(c);
  return Array.from(seen).sort();
}
