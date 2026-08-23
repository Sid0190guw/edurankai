// src/lib/horizon/sections.ts — THE TWELVE TABS, AND WHAT EACH ONE COSTS TO OPEN.
//
// =================================================================================================
// ONE TABLE, READ BY EVERYTHING
// =================================================================================================
//
// The tab order, the label, the capability that opens it, whether opening it must be written to the
// audit log before anything renders, and which patch owes the data — all of it is here, once. The
// page renders from this list; the access resolver gates from this list; the tests assert against
// this list. A tab that exists in one of those three places and not the others is the failure mode
// this file exists to remove.
//
// =================================================================================================
// WHY FOUR OF THESE KEYS DO NOT EXIST YET, AND WHY THAT IS THE CORRECT STATE TO SHIP
// =================================================================================================
//
// `can()` in src/lib/auth/permissions.ts answers `PERMS_BY_ROLE[role].includes(perm)`. There is no
// wildcard: an invented key answers FALSE for every role, super_admin included. That is not an
// obstacle here, it is the mechanism.
//
// Three of these tabs make a NEW KIND OF STATEMENT about a person — an interpretation of their
// behaviour, an interpretive personal summary, a reading of whether their working pattern is
// sustainable. None of those is a re-presentation of a row somebody already holds the right to read.
// `people.view_360` cannot carry them: the ratified description of that capability in
// src/lib/auth/registry.ts says in as many words that there is "no score, rating or prediction about
// a person anywhere behind it", and quietly hanging three interpretive tabs off it would make that
// published sentence false for everyone who was granted it on those terms.
//
// Widening who may interpret a colleague is a POLICY change, and policy changes on this project are
// referred to a human rather than shipped as a side effect of a build. So the keys are named here,
// the tabs render a panel that states exactly which key is missing and what ratifying it would
// permit, and nothing is read. The ratification step is one line in PERMS_BY_ROLE plus one entry in
// the permission registry, and it is written out in docs/horizon/PATCH-11-SUPER-ADMIN-PROFILE.md.
//
// A screen that says "this is switched off, here is the switch, here is what it turns on" is more
// useful to a super admin than a screen that has silently granted itself something.
// =================================================================================================

import type { HorizonSectionKey } from './contracts';

// -------------------------------------------------------------------------------------------------
// CAPABILITY KEYS, NAMED ONCE.
//
// The first block already exists in src/lib/auth/permissions.ts and is held by real roles today.
// The second block does not exist yet and answers false for everybody until a human ratifies it.
// Both are declared here so that a reader can see, in one screen, which is which.
// -------------------------------------------------------------------------------------------------

/** Existing, ratified keys. Verified present in the Permission union at src/lib/auth/permissions.ts. */
export const PEOPLE_VIEW_360 = 'people.view_360';
export const EMPLOYEE_MANAGE = 'employee.manage';
export const PERFORMANCE_MANAGE = 'performance.manage';
export const ATTENDANCE_ROSTER_MANAGE = 'attendance.roster.manage';
export const AUDIT_VIEW = 'audit.view';

/**
 * Proposed keys. NOT in the Permission union, so `can()` answers false for every role including
 * super_admin, and every tab behind one of them renders as awaiting ratification.
 */
export const HORIZON_BEHAVIOUR_VIEW = 'horizon.behaviour.view';
export const HORIZON_PERSONAL_SUMMARY_VIEW = 'horizon.personal_summary.view';
export const HORIZON_SUSTAINABILITY_VIEW = 'horizon.sustainability.view';

/** The proposed set, so the page can list what is pending without hunting through the table. */
export const PROPOSED_CAPABILITIES: readonly string[] = Object.freeze([
  HORIZON_BEHAVIOUR_VIEW,
  HORIZON_PERSONAL_SUMMARY_VIEW,
  HORIZON_SUSTAINABILITY_VIEW,
]);

/** What ratifying each proposed key would actually permit. Printed on the withheld panel. */
export const PROPOSED_CAPABILITY_MEANING: Record<string, string> = {
  [HORIZON_BEHAVIOUR_VIEW]:
    'Read a system reading of how one named colleague works — collaboration, responsiveness, follow-through — assembled from records this organisation already holds. It shows patterns and the signals under them, never a rank against other people, and it decides nothing.',
  [HORIZON_PERSONAL_SUMMARY_VIEW]:
    'Read an interpretive summary about one named colleague, including any traditional computational input, clearly labelled as interpretive and ranked below every record of demonstrated work. It is the most sensitive surface in this system and it may not be the reason for any decision.',
  [HORIZON_SUSTAINABILITY_VIEW]:
    'Read a reading of one named colleague’s working pattern — hours, load, leave taken and not taken — as a prompt to have a conversation. It is not a health assessment, it reads no health record, and it diagnoses nothing.',
};

// -------------------------------------------------------------------------------------------------
// THE TABLE
// -------------------------------------------------------------------------------------------------

export interface HorizonSectionDef {
  key: HorizonSectionKey;
  /** Tab label. Neutral terminology; screened in the tests. */
  label: string;
  /** One line under the tab heading, saying what this tab is and is not. */
  blurb: string;
  /**
   * The capability that opens it, or null when the tab is a roll-up of sections the viewer was
   * already granted and therefore exposes nothing new. `signals` is the only such tab.
   */
  capability: string | null;
  /** True when the key does not exist yet and the tab is awaiting ratification. */
  proposed: boolean;
  /**
   * Sensitive sections must have their access WRITTEN to the audit log before anything renders. A
   * failed write means the tab renders withheld — the same rule src/lib/legal-hold.ts already
   * applies, applied here for the same reason.
   */
  sensitive: boolean;
  /** The patch that owes the data. Printed even when the section is absent, so it has an owner. */
  owedBy: string;
  /**
   * The adapter inside Patch 11 that fills this section from records that already exist, when there
   * is one. Named so nobody mistakes a Patch 11 adapter for another patch's provider.
   */
  localAdapter: string | null;
}

/**
 * Order is the tab order in the brief, unchanged. `overview` is first because the navigation
 * principle starts at SUMMARY.
 */
export const HORIZON_SECTIONS: readonly HorizonSectionDef[] = Object.freeze([
  {
    key: 'overview',
    label: 'Overview',
    blurb: 'Who this is, how the records that make them up are linked, and what the rest of this profile can and cannot show you today.',
    capability: PEOPLE_VIEW_360,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-11 (this patch, from the identity spine)',
    localAdapter: 'src/lib/horizon/adapters.ts overviewSection()',
  },
  {
    key: 'professional_profile',
    label: 'Professional Profile',
    blurb: 'Employment on the record, the reporting line resolved from the Organization Graph, education, skills and certificates — each value carrying who asserted it.',
    capability: PEOPLE_VIEW_360,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-11 (this patch, from the digital twin)',
    localAdapter: 'src/lib/horizon/adapters.ts professionalProfileSection()',
  },
  {
    key: 'behaviour_intelligence',
    label: 'Behaviour Intelligence',
    blurb: 'A system reading of how this person works, assembled from organisational records. Advisory. It ranks nobody against anybody and it decides nothing.',
    capability: HORIZON_BEHAVIOUR_VIEW,
    proposed: true,
    sensitive: true,
    owedBy: 'PATCH-03 Behaviour Intelligence',
    localAdapter: null,
  },
  {
    key: 'performance_work_records',
    label: 'Performance & Work Records',
    blurb: 'Review cycles, goals, submitted work and learning, as the owning modules stored them.',
    capability: PERFORMANCE_MANAGE,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-11 (this patch, from the performance modules)',
    localAdapter: 'src/lib/horizon/adapters.ts performanceSection()',
  },
  {
    key: 'personal_intelligence_summary',
    label: 'Personal Intelligence Summary',
    blurb: 'An interpretive summary. Not a measurement, not scientific fact, and never the reason for a decision about anybody.',
    capability: HORIZON_PERSONAL_SUMMARY_VIEW,
    proposed: true,
    sensitive: true,
    owedBy: 'PATCH-05 Personal Intelligence',
    localAdapter: null,
  },
  {
    key: 'work_sustainability',
    label: 'Work Sustainability',
    blurb: 'A reading of working pattern from organisational records, offered as a prompt to talk to the person. It is not a health assessment and it reads no health record.',
    capability: HORIZON_SUSTAINABILITY_VIEW,
    proposed: true,
    sensitive: true,
    owedBy: 'PATCH-06 Work Sustainability',
    localAdapter: null,
  },
  {
    key: 'time_intelligence',
    label: 'Time Intelligence',
    blurb: 'Attendance, leave and time records over a window, with the source of each figure named.',
    capability: ATTENDANCE_ROSTER_MANAGE,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-07 Time Intelligence',
    localAdapter: null,
  },
  {
    key: 'feedback_intelligence',
    label: 'Feedback Intelligence',
    blurb: 'What colleagues said, kept attributed and weighted, with disagreement and outliers shown rather than averaged away. One person’s feedback is not organisational truth.',
    capability: PERFORMANCE_MANAGE,
    proposed: false,
    sensitive: true,
    owedBy: 'PATCH-08 Feedback Intelligence',
    localAdapter: null,
  },
  {
    key: 'evidence_records',
    label: 'Evidence & Records',
    blurb: 'Why the system believes what it believes about this person: claim, evidence, source, document, locator, timestamp, verification status.',
    capability: PEOPLE_VIEW_360,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-11 (this patch, from the evidence graph)',
    localAdapter: 'src/lib/horizon/adapters.ts evidenceSection()',
  },
  {
    key: 'signals',
    label: 'Signals',
    blurb: 'Every signal the sections you were granted surfaced, in one list, ordered so that demonstrated work sits above anything inferred.',
    capability: null,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-11 (this patch — a roll-up, it reads nothing of its own)',
    localAdapter: 'src/lib/horizon/profile.ts rollUpSignals()',
  },
  {
    key: 'decisions_interventions',
    label: 'Decisions & Interventions',
    blurb: 'What a named human decided about this person, when, on what written reason, and whether the person was told.',
    capability: EMPLOYEE_MANAGE,
    proposed: false,
    sensitive: true,
    owedBy: 'PATCH-09 Decisions & Interventions',
    localAdapter: null,
  },
  {
    key: 'audit_trail',
    label: 'Audit Trail',
    blurb: 'Who opened this record, which sections they opened, and what was changed. Your own opening of this page is in here.',
    capability: AUDIT_VIEW,
    proposed: false,
    sensitive: false,
    owedBy: 'PATCH-11 (this patch, from audit_log)',
    localAdapter: 'src/lib/horizon/adapters.ts auditTrailSection()',
  },
]);

const BY_KEY: Record<string, HorizonSectionDef> = Object.freeze(
  HORIZON_SECTIONS.reduce((acc, s) => {
    acc[s.key] = s;
    return acc;
  }, {} as Record<string, HorizonSectionDef>),
);

export function sectionDef(key: HorizonSectionKey): HorizonSectionDef {
  return BY_KEY[key];
}

/** Sections whose access must be logged before render. */
export function sensitiveSectionKeys(): HorizonSectionKey[] {
  return HORIZON_SECTIONS.filter((s) => s.sensitive).map((s) => s.key);
}

/** Sections whose capability does not exist yet. */
export function proposedSectionKeys(): HorizonSectionKey[] {
  return HORIZON_SECTIONS.filter((s) => s.proposed).map((s) => s.key);
}

// -------------------------------------------------------------------------------------------------
// THE NAVIGATION PRINCIPLE, AS A LADDER
// -------------------------------------------------------------------------------------------------

/**
 * SUMMARY -> SIGNAL -> PATTERN -> EVIDENCE -> ORIGINAL AUTHORISED RECORD.
 *
 * Five rungs, in order, and the order is the point: a reader always arrives at a number through the
 * signals that produced it, and can always keep going down to the row somebody actually wrote. A
 * summary that cannot be walked down to a record is a claim with nothing under it, and this view
 * marks it as exactly that rather than rendering it the same as one that can.
 */
export const DRILL_RUNGS = ['summary', 'signal', 'pattern', 'evidence', 'record'] as const;
export type DrillRung = (typeof DRILL_RUNGS)[number];

export const DRILL_RUNG_LABELS: Record<DrillRung, string> = {
  summary: 'Summary',
  signal: 'Signal',
  pattern: 'Pattern',
  evidence: 'Evidence',
  record: 'Original authorised record',
};

export const DRILL_RUNG_QUESTION: Record<DrillRung, string> = {
  summary: 'What does this section say?',
  signal: 'Which observations is it built from?',
  pattern: 'What repeats across those observations, and what points the other way?',
  evidence: 'What supports each observation, and how strongly?',
  record: 'Which row did somebody actually write, and where is it?',
};

/** The next rung down, or null at the bottom. */
export function nextRung(rung: DrillRung): DrillRung | null {
  const i = DRILL_RUNGS.indexOf(rung);
  return i < 0 || i >= DRILL_RUNGS.length - 1 ? null : DRILL_RUNGS[i + 1];
}

/** How far down a reader can actually go from here, given what a section handed over. */
export function reachableDepth(input: {
  hasSignals: boolean;
  hasPatterns: boolean;
  hasEvidence: boolean;
  hasRecordLink: boolean;
}): DrillRung {
  if (input.hasRecordLink) return 'record';
  if (input.hasEvidence) return 'evidence';
  if (input.hasPatterns) return 'pattern';
  if (input.hasSignals) return 'signal';
  return 'summary';
}

/**
 * The sentence printed under a section that cannot be walked all the way down. Naming the rung it
 * stops at is the whole value: "stops at signal" tells a reader that nothing on record supports it
 * yet, which is a different problem from "stops at evidence".
 */
export function depthSentence(depth: DrillRung): string {
  switch (depth) {
    case 'record':
      return 'Every step is open: summary, the signals under it, the patterns they form, the evidence, and the original record.';
    case 'evidence':
      return 'You can walk down to the evidence. No original record was linked, so the last step opens nothing.';
    case 'pattern':
      return 'You can walk down to the patterns. Nothing on record was attached to them, so this is a reading with no evidence under it.';
    case 'signal':
      return 'You can see the signals. They form no pattern and carry no evidence, so each one stands alone and unsupported.';
    default:
      return 'This is a summary with nothing under it. No signal, no pattern, no evidence, no record — treat it as a statement nobody has backed yet.';
  }
}
