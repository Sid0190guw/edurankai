// src/lib/founder-intel/founder-access.ts — PATCH 12. THE FOUNDER VIEW, AND ITS EIGHTEEN SECTIONS.
//
// =================================================================================================
// THIS PATCH OWNS A VIEW. IT OWNS NO DATA, NO SIGNAL AND NO GRANT.
// =================================================================================================
//
// Patch 11 already built the assembled record: src/lib/horizon/contracts.ts holds the Signal,
// Evidence and Section types, src/lib/horizon/access.ts resolves grants and writes the access log,
// src/lib/horizon/profile.ts composes twelve sections through a provider registry, and
// src/lib/horizon/{feedback,temporal,behaviour,interpretation,governance} own their own domains.
//
// Patch 12 is the FOUNDER reading of that same record: the maximum-detail authorised drill-down,
// arranged as the eighteen sections the founder brief names, with every figure openable down to the
// smallest authorised evidence point. It therefore:
//
//   - resolves NO capability of its own. `holds` is passed in, exactly as Patch 11 requires.
//   - writes NO audit row of its own. horizon/access.ts owns the entity and the action names.
//   - defines NO second Signal type. contracts.ts owns it and this file imports it.
//   - registers NO provider for a section another patch owes. An unregistered section renders the
//     sentence saying which patch owes it, which is a more useful answer than a panel this patch
//     filled in from somewhere else.
//
// WHAT IT ADDS, and what nothing else in the tree does:
//
//   1. The founder gate, which is NARROWER than Patch 11's. `people.view_360` opens the super admin
//      profile for a role; this view opens for one named person and no role at all.
//   2. The eighteen-section founder structure, mapped onto Patch 11's twelve section keys, so the
//      brief's structure is delivered without a thirteenth key being invented in a contract this
//      patch does not own.
//   3. The seven questions (questions.ts), which are a different thing from Patch 11's five-rung
//      depth ladder: the ladder says HOW FAR a reader may walk, the questions are WHAT they may ask
//      at any rung.
//
// =================================================================================================
// THE FOUNDER IS NOT "AN ADMIN WITH MORE BOXES TICKED"
// =================================================================================================
//
// `isFounder()` is the check three founder screens already make inline, and legal-hold.ts makes
// through FOUNDER_EMAIL: role is super_admin AND the email is the founder's. It is deliberately not
// a capability, because a capability can be granted to a second person by anybody who can edit a
// role, and the value of this gate is that the audit trail has exactly one possible subject.
//
// AND IT DOES NOT OVERRIDE RATIFICATION. Patch 11 marks three capabilities as proposed — they exist
// in no Permission union, so `can()` answers false for everybody including super_admin, and those
// tabs render as awaiting ratification. The founder view does NOT bypass that. A view that quietly
// granted itself what the organisation has not ratified would be the exact failure the ratification
// gate exists to prevent, and the founder is the last person who should be exempt from it.

import type { HorizonSectionKey } from '@/lib/horizon/contracts';
import type { HorizonViewer } from '@/lib/horizon/access';

export interface Viewer {
  id?: string | null;
  role?: string | null;
  email?: string | null;
  name?: string | null;
}

/** Mirrors src/lib/legal-hold.ts, including the FOUNDER_EMAIL override. */
export function founderEmail(): string {
  return (process.env.FOUNDER_EMAIL || 'siddharth@edurankai.in').toLowerCase();
}

export function isFounder(user: Viewer | null | undefined): boolean {
  if (!user) return false;
  if (user.role !== 'super_admin') return false;
  return (user.email || '').toLowerCase() === founderEmail();
}

/** The shape Patch 11's composer wants, built from the session user. */
export function horizonViewerOf(user: Viewer): HorizonViewer {
  return {
    userId: String(user.id || ''),
    employeeId: null,
    role: String(user.role || ''),
    name: user.name ? String(user.name) : null,
  };
}

// =================================================================================================
// THE EIGHTEEN SECTIONS
// =================================================================================================

export const FOUNDER_SECTION_KEYS = [
  'identity',
  'executive',
  'work_record',
  'task_detail',
  'behaviour',
  'performance',
  'feedback_records',
  'feedback_consensus',
  'personal_intelligence',
  'foundational_computation',
  'professional_interpretation',
  'sustainability',
  'role_suitability',
  'internal_mobility',
  'time_intelligence',
  'signal_history',
  'decisions',
  'access_history',
] as const;

export type FounderSectionKey = (typeof FOUNDER_SECTION_KEYS)[number];

export interface FounderSectionDef {
  key: FounderSectionKey;
  title: string;
  /** What this section is, and what it is not. Printed under the heading. */
  blurb: string;
  /**
   * The Patch 11 section this reads. Null where the content comes from a module outside the twelve
   * (the temporal engine, the role comparison), and the def says which.
   */
  from: HorizonSectionKey | null;
  /** Named whatever the state, so an absent section still has an owner a reader can go and ask. */
  owedBy: string;
  /** Open on first paint. Everything else is progressive disclosure. */
  openByDefault: boolean;
}

/**
 * Eighteen founder sections over twelve Patch 11 keys.
 *
 * SEVERAL SECTIONS READ THE SAME KEY, AND THAT IS THE POINT. The brief asks for feedback records AND
 * their consensus as separate readings, and for role suitability AND internal mobility as separate
 * questions, because a founder asks them at different moments and acts on them differently. They are
 * two READINGS of one payload, not two copies of it: the payload is fetched once by Patch 11's
 * composer and this file arranges it.
 */
export const FOUNDER_SECTIONS: readonly FounderSectionDef[] = Object.freeze([
  {
    key: 'identity',
    title: 'Identity and employment',
    blurb: 'The employment record and the identifiers it is joined on. Protected and sensitive columns are never composed into it.',
    from: 'overview',
    owedBy: 'Patch 11 (horizon/adapters.overviewSection)',
    openByDefault: true,
  },
  {
    key: 'executive',
    title: 'Live executive intelligence',
    blurb: 'The strongest current signals across every granted section, ordered so demonstrated work sits above anything derived.',
    from: 'signals',
    owedBy: 'Patch 11 (horizon/profile.rollUpSignals)',
    openByDefault: true,
  },
  {
    key: 'work_record',
    title: 'Complete work record timeline',
    blurb: 'Everything this platform recorded as work, through the module that owns each record.',
    from: 'performance_work_records',
    owedBy: 'the performance and work-records patch',
    openByDefault: false,
  },
  {
    key: 'task_detail',
    title: 'Task and submission detail',
    blurb: 'Individual submissions, their verdicts and the named human who recorded each one. Links, never uploads.',
    from: 'evidence_records',
    owedBy: 'Patch 11 (horizon/adapters.evidenceSection, over the evidence graph)',
    openByDefault: false,
  },
  {
    key: 'behaviour',
    title: 'Behaviour timeline',
    blurb: 'Recorded organisational actions. No monitoring feed, no sampling, no message content.',
    from: 'behaviour_intelligence',
    owedBy: 'the behaviour patch (horizon/behaviour)',
    openByDefault: false,
  },
  {
    key: 'performance',
    title: 'Performance history',
    blurb: 'Review cycles, outcomes and calibration as the performance module stored them. Self, manager and calibrated ratings are never averaged together.',
    from: 'performance_work_records',
    owedBy: 'the performance and work-records patch',
    openByDefault: false,
  },
  {
    key: 'feedback_records',
    title: 'Every feedback record',
    blurb: 'Each contribution on record, unaggregated, with its source named as far as the grant allows.',
    from: 'feedback_intelligence',
    owedBy: 'the feedback patch (horizon/feedback)',
    openByDefault: false,
  },
  {
    key: 'feedback_consensus',
    title: 'Feedback consensus and contradictions',
    blurb: 'Where the feedback agrees, where it disagrees, which sources are outliers, and the shapes that make a consensus untrustworthy whatever it says.',
    from: 'feedback_intelligence',
    owedBy: 'the feedback patch (horizon/feedback/aggregate)',
    openByDefault: false,
  },
  {
    key: 'personal_intelligence',
    title: 'Detailed personal intelligence',
    blurb: 'Work-relevant characteristics under recorded consent. Not a personality test, not a health inference, and not a decision input.',
    from: 'personal_intelligence_summary',
    owedBy: 'the personal-summary patch, behind a proposed capability and a consent record',
    openByDefault: false,
  },
  {
    key: 'foundational_computation',
    title: 'Foundational computation detail',
    blurb: 'Traditional computational input, kept separate from any interpretation of it, shown only from a registered provider under consent, and never presented as established science.',
    from: 'personal_intelligence_summary',
    owedBy: 'the interpretation patch (horizon/interpretation, registerFoundationalProvider)',
    openByDefault: false,
  },
  {
    key: 'professional_interpretation',
    title: 'Professional interpretation',
    blurb: 'The professional reading, in a separate object from the computation it read, and outranked by demonstrated work by construction.',
    from: 'personal_intelligence_summary',
    owedBy: 'the interpretation patch (horizon/interpretation/engine)',
    openByDefault: false,
  },
  {
    key: 'sustainability',
    title: 'Work sustainability',
    blurb: 'Workload and recovery, read from work records. No health, wellness or absence-reason data reaches this screen, and it describes a workload rather than a person.',
    from: 'work_sustainability',
    owedBy: 'the sustainability patch, behind a proposed capability',
    openByDefault: false,
  },
  {
    key: 'role_suitability',
    title: 'Role suitability analysis',
    blurb: 'Requirement by requirement against the role, with no overall score and no ranking of people.',
    from: null,
    owedBy: 'the role comparison module (horizon/role-compare)',
    openByDefault: false,
  },
  {
    key: 'internal_mobility',
    title: 'Internal mobility analysis',
    blurb: 'Which other open roles the evidence already on record would cover. A move is a conversation between named humans, so nothing here recommends one.',
    from: null,
    owedBy: 'the role comparison module (horizon/role-compare)',
    openByDefault: false,
  },
  {
    key: 'time_intelligence',
    title: 'Time intelligence',
    blurb: 'The same record read over seven horizons: recent, week, month, year, five, ten and twenty. Long windows over a short history are printed as a short history.',
    from: 'time_intelligence',
    owedBy: 'the temporal patch (horizon/temporal)',
    openByDefault: false,
  },
  {
    key: 'signal_history',
    title: 'Complete signal history',
    blurb: 'Every signal on this profile in one list, each with what it was computed from and which patch produced it.',
    from: 'signals',
    owedBy: 'Patch 11 (horizon/profile.rollUpSignals)',
    openByDefault: false,
  },
  {
    key: 'decisions',
    title: 'Decisions and interventions',
    blurb: 'Human decisions and interventions on record, and what followed each one. Nothing on this page made any of them, and nothing on it can.',
    from: 'decisions_interventions',
    owedBy: 'the decisions patch',
    openByDefault: false,
  },
  {
    key: 'access_history',
    title: 'Audit and access history',
    blurb: 'Who opened this record, when, and what they were shown. Opening a sensitive section is recorded as its own event.',
    from: 'audit_trail',
    owedBy: 'Patch 11 (horizon/adapters.auditTrailSection)',
    openByDefault: false,
  },
]);

export function founderSectionDef(key: FounderSectionKey): FounderSectionDef {
  const d = FOUNDER_SECTIONS.find((s) => s.key === key);
  if (!d) throw new Error('Unknown founder section: ' + key);
  return d;
}

/** Patch 11 keys this view reads, deduplicated. Used to declare the read in the access log. */
export function horizonKeysRead(): HorizonSectionKey[] {
  const out: HorizonSectionKey[] = [];
  for (const s of FOUNDER_SECTIONS) {
    if (s.from && out.indexOf(s.from) < 0) out.push(s.from);
  }
  return out;
}

// =================================================================================================
// WHAT IS NEVER ON THIS SCREEN
// =================================================================================================

/**
 * Printed at the foot of the profile, every time.
 *
 * The founder view is the deepest authorised read in this system, which makes the boundary worth
 * stating rather than assuming. Absence is the mechanism in every case below: no query on this path
 * names those columns, so there is no panel here that would fill if the data existed.
 */
export const NEVER_ON_THIS_SCREEN: readonly { what: string; because: string; where: string }[] =
  Object.freeze([
    {
      what: 'Individual health, wellness, cycle, symptom or consult data',
      because:
        'It is beyond every admin AND beyond the founder. Oversight of that system is aggregate only and suppresses small groups, and no per-person row exists on any oversight surface.',
      where: 'Nowhere per person. Aggregate oversight only.',
    },
    {
      what: 'Legal-hold records and held messages',
      because:
        'They require an open numbered matter and a written reason from whoever reads them, recorded before anything renders. A profile page is not a matter, so it does not ask.',
      where: '/founder/admin/legal-hold',
    },
    {
      what: 'Salary, payslips, bank details and government identifiers',
      because:
        'Payroll owns pay and identity documents. An intelligence view that also opened them would be a second door into them with a different audit trail.',
      where: 'The payroll screens and the employee record',
    },
    {
      what: 'Date of birth, age, gender, nationality, religion, caste, marital status, disability',
      because:
        'Protected attributes are never decision variables and are never inferred. They are not modelled on this path, so there is no seam to fill.',
      where: 'The people desk holds them for statutory purposes only.',
    },
    {
      what: 'Message content, communication volume and any monitoring signal',
      because:
        'No inference about a person is drawn from surveillance here. Only legitimately collected organisational records reach this view.',
      where: 'Nowhere. It is not collected for this purpose.',
    },
    {
      what: 'A score, a total, an average or a ranking of one person against another',
      because:
        'Every module behind this view refuses to produce one, for reasons written down in each of them, and this view does not add the number they declined to give.',
      where: 'Nowhere, by construction.',
    },
  ]);
