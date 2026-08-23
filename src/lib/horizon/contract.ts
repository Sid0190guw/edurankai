// src/lib/horizon/contract.ts — PATCH 19. WHAT IS ACTUALLY JOINED TO WHAT, AND WHERE IT IS NOT.
//
// =================================================================================================
// WHAT THIS MODULE IS
// =================================================================================================
//
// Patch 19 owns no business module. It owns the QUESTION "does the chain hold end to end", and this
// file is the machine-readable answer: fifteen flows, each naming the module that produces it, the
// module that consumes it, the repository paths that prove the seam, where the HUMAN decides, and
// what is audited. The suites in this directory assert against these declarations; the ops surface
// renders them.
//
// NOTHING HERE MAY BE EDITED TO MAKE A TEST PASS. A `failures` entry is a finding. Deleting one
// without moving the code is falsifying a report, and this report is the only place several of these
// findings are written down at all.
//
// PATCH 20 (src/lib/horizon/integration/map.ts) maps MODULES: twenty-one patches, what each owns,
// and where two of them own the same thing. This file maps FLOWS. Those are different questions;
// neither file re-implements the other, and Patch 20 imports this patch's probe rather than
// rewriting it.
//
// =================================================================================================
// THE HONEST STATUS VOCABULARY, AND WHY IT IS NOT A BOOLEAN
// =================================================================================================
//
//   wired               producer and consumer both exist AND a real import/call edge joins them,
//                       reachable from a surface a person can open.
//   partial             the seam exists and works, but a link in the chain is advisory, best-effort,
//                       fail-closed by design, or only half-connected. Named in `failures`, always.
//   unreachable         implemented, correct, and imported by NOTHING. The code runs in a test and
//                       nowhere else. This is a failure of integration, not of the module.
//   by_design_absent    deliberately not built. The reason is the point: "fusion does not write to
//                       the profile" is a designed property of this system, not a gap to fill.
//
// A boolean would have collapsed the last two into each other, and they need opposite actions:
// `unreachable` is wiring somebody must do, `by_design_absent` is a line nobody may cross.
//
// =================================================================================================
// WHY THE FLOW NAMES DO NOT MATCH THE MODULE NAMES
// =================================================================================================
//
// The brief names fifteen flows in the vocabulary of an intelligence system (fusion, signal
// generation, temporal analysis). This repository implements them under its own names, and it
// implements some of them TWICE — once in the HORIZON tree and once in the older person layer
// (evidence-graph, person-spine, digital-twin) that HORIZON was built beside. The mapping is
// recorded per flow in `producer`/`consumer` so nobody has to guess which module is meant, and both
// implementations are named in `evidence` where both exist, because a reader who only knows one of
// them will otherwise conclude the other is dead.

export type FlowStatus = 'wired' | 'partial' | 'unreachable' | 'by_design_absent';

export interface SeamRef {
  /** Repository path, without a leading slash. */
  module: string;
  /** The exported symbol that carries the seam, where one function carries it. */
  symbol?: string;
}

export interface FlowSpec {
  /** 1..15, in the order the brief lists them. Stable: tests and the ops page index on it. */
  id: number;
  key: string;
  title: string;
  /** What goes in, in the words of the record that carries it. */
  inputs: readonly string[];
  /** What comes out, and what a screen is allowed to say about it. */
  outputs: readonly string[];
  producer: SeamRef;
  consumer: SeamRef;
  /** Paths that prove the seam. Every one is checked to exist by wiring.test.ts. */
  evidence: readonly string[];
  /** WHERE THE HUMAN DECIDES. Rule 14: no computed output may decide alone. */
  humanDecision: string;
  /** The module that records the decision or the access, or null where nothing is decided. */
  auditedBy: string | null;
  status: FlowStatus;
  /** Every reason this is not `wired`. Empty for a wired flow, never empty otherwise. */
  failures: readonly string[];
}

export const FLOWS: readonly FlowSpec[] = Object.freeze([
  {
    id: 1,
    key: 'application-to-computation',
    title: 'Application to computation trigger',
    inputs: ['applications row', 'intake submission', 'recorded consent'],
    outputs: ['application.submitted event', 'a stored, hashed foundational computation'],
    producer: { module: 'src/lib/horizon/intake/submit.ts', symbol: 'announceApplicationSubmitted' },
    consumer: { module: 'src/lib/foundational/engine.ts', symbol: 'computeFromInput' },
    evidence: [
      'src/lib/horizon/intake/submit.ts',
      'src/lib/horizon/intake/birth-input.ts',
      'src/lib/horizon/intake/consent.ts',
      'src/lib/foundational/engine.ts',
      'src/lib/horizon/events.ts',
    ],
    humanDecision:
      'applyFoundationDecision() records what a named person chose about the optional input, and storeBirthInput() refuses without a recorded consent. Nothing computes from an input nobody agreed to give.',
    auditedBy: 'src/lib/horizon/governance/ledger.ts',
    status: 'partial',
    failures: [
      'INDIAN APPLICANTS ARE REFUSED AT INTAKE. isValidTimezone() at src/lib/horizon/intake/birth-input.ts:290 uses Intl.supportedValuesOf("timeZone") as an allow-list and returns FALSE on line 294 for anything absent from it, never reaching the formatter probe three lines below. That list holds CANONICAL ids only: on this runtime it is 418 zones containing Asia/Calcutta and NOT Asia/Kolkata — which is exactly what a browser reports for an Indian user. The probe on line 297 accepts Asia/Kolkata. Four tests in intake/birth-input.test.ts fail on this today. The fix is one line and belongs to the intake patch: fall through to the probe instead of returning false.',
    ],
  },
  {
    id: 2,
    key: 'computation-to-interpretation',
    title: 'Computation to interpretation',
    inputs: ['foundational factors and cycle periods', 'input hash, output hash, method manifest'],
    outputs: ['interpreted dimensions with confidence, evidence and a not-for-decisions notice'],
    producer: { module: 'src/lib/foundational/engine.ts', symbol: 'computeFromInput' },
    consumer: { module: 'src/lib/horizon/interpretation/engine.ts', symbol: 'ENGINE_VERSION' },
    evidence: [
      'src/lib/foundational/engine.ts',
      'src/lib/foundational/vocabulary.ts',
      'src/lib/horizon/interpretation/engine.ts',
      'src/lib/horizon/interpretation/foundational-adapter.ts',
      'src/lib/horizon/interpretation/language-guard.ts',
    ],
    humanDecision:
      'NOT_FOR_DECISIONS_NOTICE travels with every interpretation and INFERRED_CONFIDENCE_CEILING caps what an inferred dimension may ever claim. The interpretation is shown to a person; it is never an input to a write.',
    auditedBy: 'src/lib/horizon/governance/ledger.ts',
    status: 'wired',
    failures: [],
  },
  {
    id: 3,
    key: 'work-record-to-behavioural-update',
    title: 'Work record to behavioural update',
    inputs: ['task assignment and submission events', 'attendance and roster records', 'work windows'],
    outputs: ['behaviour metrics with a trend, a confidence and a recompute-after date'],
    producer: { module: 'src/lib/horizon/behaviour/sources.ts' },
    consumer: { module: 'src/lib/horizon/behaviour/provider.ts', symbol: 'behaviourProvider' },
    evidence: [
      'src/lib/horizon/behaviour/sources.ts',
      'src/lib/horizon/behaviour/metrics.ts',
      'src/lib/horizon/behaviour/trend.ts',
      'src/lib/horizon/behaviour/provider.ts',
      'src/lib/horizon/behaviour/windows.ts',
    ],
    humanDecision:
      'The behaviour section is gated behind horizon.behaviour.view, which is not in the permission registry, so the tab is closed to every role including the founder until a human ratifies it.',
    auditedBy: 'src/lib/horizon/access.ts logSensitiveSectionAccess',
    status: 'partial',
    failures: [
      'THE OUTPUT EXISTS AND NOBODY MAY OPEN IT. behaviour_intelligence is one of the three sections whose capability is deliberately unratified, so a complete, working engine produces a tab that answers awaiting_ratification for every viewer. That is the correct fail-closed default AND it means flow 3 is not observable end to end today. Ratifying the capability is a policy decision, not a code change.',
    ],
  },
  {
    id: 4,
    key: 'feedback-to-aggregation',
    title: 'Feedback to aggregation',
    inputs: ['individual feedback contributions', 'source type', 'evidence quality', 'observation date'],
    outputs: ['a weighted aggregate with a confidence band, a contributor count, and visible disagreement'],
    producer: { module: 'src/lib/horizon/feedback/capture.ts' },
    consumer: { module: 'src/lib/horizon/feedback/aggregate.ts' },
    evidence: [
      'src/lib/horizon/feedback/capture.ts',
      'src/lib/horizon/feedback/aggregate.ts',
      'src/lib/horizon/feedback/visibility-rules.ts',
      'src/lib/talent/evaluations.ts',
    ],
    humanDecision:
      'MIN_SOURCES_FOR_SCORE refuses to score a single voice, TWO_SOURCE_BAND_CEILING caps a two-source aggregate at low confidence, and MAX_AUTHOR_SHARE stops one author dominating. Rule 24 is arithmetic here rather than a promise.',
    auditedBy: 'src/lib/audit.ts logAudit',
    status: 'wired',
    failures: [],
  },
  {
    id: 5,
    key: 'multiple-sources-to-fusion',
    title: 'Multiple sources to fusion',
    inputs: ['HORIZON signals by weight class', 'talent, HR, org and time providers'],
    outputs: ['one fused reading per source class, with the mapping recorded and printable'],
    producer: { module: 'src/lib/horizon/signal-contract.ts' },
    consumer: { module: 'src/lib/fusion/horizon-bridge.ts', symbol: 'fusionSignalsFromHorizon' },
    evidence: [
      'src/lib/fusion/horizon-bridge.ts',
      'src/lib/fusion/fuse.ts',
      'src/lib/fusion/weights.ts',
      'src/lib/horizon/signal-contract.ts',
      'src/lib/horizon/report/sources.ts',
      'src/lib/person-spine.ts',
    ],
    humanDecision:
      'WEIGHT_CLASS_TO_SOURCE maps every HORIZON weight class onto a fusion source class, and maps some to null rather than inventing a home for them. describeMapping() prints the table a human checks.',
    auditedBy: null,
    status: 'wired',
    failures: [],
  },
  {
    id: 6,
    key: 'fusion-to-profile-update',
    title: 'Fusion to profile update',
    inputs: ['fused readings', 'registered MEIR providers'],
    outputs: ['section payloads on one master record. No write back into any source module.'],
    producer: { module: 'src/lib/fusion/fuse.ts' },
    consumer: { module: 'src/lib/horizon/record.ts', symbol: 'registerProvider' },
    evidence: [
      'src/lib/horizon/record.ts',
      'src/lib/horizon/profile.ts',
      'src/lib/fusion/horizon-bridge.ts',
      'src/lib/digital-twin.ts',
    ],
    humanDecision:
      'Every write stays in the module that owns the fact. The record COMPOSES; it never updates payroll, skills or the employee register.',
    auditedBy: null,
    status: 'by_design_absent',
    failures: [
      'THIS IS NOT A GAP. record.ts calls registered providers under a timeout and a concurrency cap and assembles what they return; it writes nothing back. The older composer src/lib/digital-twin.ts holds the same line structurally — screenColumns() refuses a protected or sensitive column name before it can reach SQL. A future patch that adds a write here is changing the design, not filling it in.',
    ],
  },
  {
    id: 7,
    key: 'profile-update-to-temporal',
    title: 'Profile update to temporal analysis',
    inputs: ['a series of dated observations', 'cycle periods', 'org_relationships effective_from and effective_to'],
    outputs: ['a trend with an explicit insufficient-data state', 'a confidence that collapses on a short record'],
    producer: { module: 'src/lib/horizon/temporal/store.ts' },
    consumer: { module: 'src/lib/horizon/temporal/engine.ts', symbol: 'trendOf' },
    evidence: [
      'src/lib/horizon/temporal/engine.ts',
      'src/lib/horizon/temporal/time.ts',
      'src/lib/horizon/temporal/cycles.ts',
      'src/lib/org-graph-schema.ts',
    ],
    humanDecision:
      'INSUFFICIENT_TREND is a value, not an exception: a series too short to read reports that it is too short, rather than returning a flat line that reads as stability.',
    auditedBy: 'src/lib/horizon/governance/ledger.ts',
    status: 'partial',
    failures: [
      'ONLY HALF THE ESTATE IS TEMPORAL. org_relationships carries effective_from/effective_to and a CHECK that the interval is sane; hr_employee_skills, capability_claims and the profile tables carry only an updated_at. So "what did this record say in March" is answerable for reporting lines and not for capability.',
    ],
  },
  {
    id: 8,
    key: 'evidence-to-signal',
    title: 'Evidence to signal generation',
    inputs: ['evidence rows with a class and a date', 'detector thresholds'],
    outputs: ['a stored signal with an explanation, a lifecycle history, and recorded reviewer disagreement'],
    producer: { module: 'src/lib/horizon/signal-detectors.ts' },
    consumer: { module: 'src/lib/horizon/signal-engine.ts', symbol: 'explainStored' },
    evidence: [
      'src/lib/horizon/signal-detectors.ts',
      'src/lib/horizon/signal-engine.ts',
      'src/lib/horizon/signal-visibility.ts',
      'src/lib/evidence-graph.ts',
    ],
    humanDecision:
      'reviewDisagreement() over the lifecycle history keeps two reviewers who disagreed visible as two reviewers, rather than resolving them into one verdict.',
    auditedBy: 'src/lib/audit.ts logAudit',
    status: 'wired',
    failures: [],
  },
  {
    id: 9,
    key: 'interview-to-decision-support',
    title: 'Interview to decision support',
    inputs: ['panel scorecards and recommendations', 'application fields', 'foundational fields'],
    outputs: ['a support state, and the fields it rests on. Never a decision.'],
    producer: { module: 'src/lib/interview-feedback.ts', symbol: 'getFeedbackBundle' },
    consumer: { module: 'src/lib/hiring-decision.ts', symbol: 'SUPPORT_STATES' },
    evidence: [
      'src/lib/hiring-decision.ts',
      'src/lib/interview-feedback.ts',
      'src/lib/talent/evaluations.ts',
      'src/pages/admin/recruitment/feedback/[id].astro',
    ],
    humanDecision:
      'FINAL_DECISIONS is a separate vocabulary from SUPPORT_STATES and only a named human writes one. APPLICATION_FIELDS and FOUNDATIONAL_FIELDS are kept apart so a reader can see which kind of input a support state rested on — rule 22, made checkable.',
    auditedBy: 'src/lib/audit.ts logAudit',
    status: 'wired',
    failures: [],
  },
  {
    id: 10,
    key: 'decision-to-audit',
    title: 'Decision to audit log',
    inputs: ['actor', 'action', 'entity and entity id', 'a stated purpose'],
    outputs: ['an access-log row written BEFORE the section renders'],
    producer: { module: 'src/lib/horizon/visibility.ts', symbol: 'requireAccessLog' },
    consumer: { module: 'src/lib/horizon/access.ts', symbol: 'logSensitiveSectionAccess' },
    evidence: [
      'src/lib/horizon/visibility.ts',
      'src/lib/horizon/access.ts',
      'src/lib/horizon/governance/ledger.ts',
      'src/lib/audit.ts',
      'src/lib/legal-hold.ts',
    ],
    humanDecision: 'Not applicable — this is the record OF a human decision.',
    auditedBy: 'src/lib/horizon/visibility.ts requireAccessLog',
    status: 'partial',
    failures: [
      'TWO HOUSE RULES FOR ONE QUESTION, AND THE NEXT SURFACE WILL PICK ONE BY ACCIDENT. requireAccessLog() refuses to render when the log write fails, and legal-hold.ts takes the same position. recordEvaluation() in src/lib/talent/evaluations.ts does the opposite: it logs the failure and returns `audited: false` beside a successful write, so an evaluation can exist with no audit row. Both are defensible on their own surface; neither is written down as the rule.',
    ],
  },
  {
    id: 11,
    key: 'profile-to-role-based-views',
    title: 'Employee profile to role-based views',
    inputs: ['one subject', 'the viewer', 'the viewer capabilities', 'a stated purpose'],
    outputs: ['a per-section grant decided BEFORE any read, each carrying the sentence that explains it'],
    producer: { module: 'src/lib/horizon/access.ts', symbol: 'resolveHorizonAccess' },
    consumer: { module: 'src/pages/admin/horizon/employee/[id].astro' },
    evidence: [
      'src/lib/horizon/access.ts',
      'src/lib/horizon/sections.ts',
      'src/lib/horizon/visibility.ts',
      'src/lib/horizon/profile.ts',
      'src/pages/admin/horizon/employee/[id].astro',
    ],
    humanDecision:
      'A withheld section is a query that never ran, and it says so. Nothing renders an empty panel that could be read as "this person has no record".',
    auditedBy: 'src/lib/horizon/access.ts logProfileOpen',
    status: 'wired',
    failures: [],
  },
  {
    id: 12,
    key: 'founder-drilldown',
    title: 'Founder to maximum-detail drill-down',
    inputs: ['super_admin role', 'founder identity', 'administer capability'],
    outputs: ['the widest read in the system, and three sections it still cannot open'],
    producer: { module: 'src/lib/auth/permissions.ts', symbol: 'can' },
    consumer: { module: 'src/lib/horizon/profile.ts', symbol: 'buildSuperAdminProfile' },
    evidence: [
      'src/lib/horizon/profile.ts',
      'src/lib/horizon/access.ts',
      'src/lib/rbac/engine.ts',
      'src/pages/admin/horizon/index.astro',
    ],
    humanDecision: 'Not applicable — this is a standing grant, not a decision.',
    auditedBy: 'src/lib/horizon/access.ts logDrill',
    status: 'partial',
    failures: [
      'MAXIMUM DETAIL IS NOT UNLIMITED, AND THAT IS ENFORCED IN THREE PLACES. The founder does not hold department.lead (a scope, not a rank); is refused the three unratified sections exactly like everybody else; and an explicit DENY grant overrides `administer` at Tier 1 of the rbac engine. A drill-down surface that assumed super_admin means everything would contradict three modules at once.',
      'THE FOUNDER-IDENTITY MODULE WAS DELETED UNDER THIS PATCH WHILE IT WAS BEING WRITTEN. src/lib/founder-intel/founder-access.ts existed on 2026-08-23 and exported isFounder(), horizonViewerOf() and FOUNDER_SECTIONS; the whole directory is now gone and no module exports isFounder() anywhere in the tree. The drill-down is served today by /admin/horizon/index.astro through can() and resolveHorizonAccess() alone, which means the founder is identified BY ROLE and not by identity — a different and wider population than the deleted module implemented. Whoever owned founder-intel should confirm this was intended.',
    ],
  },
  {
    id: 13,
    key: 'hr-restricted-view',
    title: 'HR to correct restricted view',
    inputs: ['hr role', 'PERMS_BY_ROLE grants', 'section capability requirements'],
    outputs: ['the people sections; not the audit trail, and not the unratified three'],
    producer: { module: 'src/lib/auth/permissions.ts', symbol: 'PERMS_BY_ROLE' },
    consumer: { module: 'src/lib/horizon/access.ts', symbol: 'resolveHorizonAccess' },
    evidence: [
      'src/lib/auth/permissions.ts',
      'src/lib/horizon/sections.ts',
      'src/lib/horizon/access.ts',
      'src/lib/auth/workspace-access.ts',
    ],
    humanDecision: 'Not applicable.',
    auditedBy: 'src/lib/horizon/access.ts logProfileOpen',
    status: 'wired',
    failures: [],
  },
  {
    id: 14,
    key: 'manager-own-team-only',
    title: 'Manager to own-team-only access',
    inputs: ['the viewer employee id', 'org_relationships edges', 'the performance.manage capability'],
    outputs: ['an explicit id list, or null for an org-wide holder'],
    producer: { module: 'src/lib/performance-scope.ts', symbol: 'resolvePerfViewer' },
    consumer: { module: 'src/lib/manager-intelligence/read.ts' },
    evidence: [
      'src/lib/performance-scope.ts',
      'src/lib/manager-intelligence/read.ts',
      'src/lib/manager-intelligence/signals.ts',
      'src/lib/employee-tasks.ts',
      'src/lib/org-graph.ts',
    ],
    humanDecision:
      'src/lib/manager-intelligence/recommend.ts produces a recommendation for a manager to act on. The act is the manager’s.',
    auditedBy: null,
    status: 'partial',
    failures: [
      'ONE LEAD TEST DIVERGES, AND ITS OWN SOURCE SAYS SO. isLeadSql() in src/lib/employee-tasks.ts applies no internship refusal, while requireTeamLead() and the workspace composer both do — so an INTERN holding department_head reads and can move every task in their department. Reported by the owning module, left in place under the mechanism-not-policy rule, and pinned by a test here so it cannot widen unnoticed.',
    ],
  },
  {
    id: 15,
    key: 'employee-self-only',
    title: 'Employee to self-only access',
    inputs: ['the viewer user id and employee id', 'the subject'],
    outputs: ['isSelf, printed — and a grant set identical to any other viewer of the same role'],
    producer: { module: 'src/lib/auth/workspace-access.ts', symbol: 'requireEmployee' },
    consumer: { module: 'src/lib/horizon/access.ts', symbol: 'resolveHorizonAccess' },
    evidence: [
      'src/lib/auth/workspace-access.ts',
      'src/lib/horizon/access.ts',
      'src/lib/workforce/identity.ts',
      'src/lib/performance-scope.ts',
    ],
    humanDecision: 'Not applicable.',
    auditedBy: 'src/lib/horizon/access.ts logProfileOpen',
    status: 'wired',
    failures: [],
  },
]);

export function flowById(id: number): FlowSpec | null {
  return FLOWS.find((f) => f.id === id) || null;
}

export interface MatrixSummary {
  total: number;
  wired: number;
  partial: number;
  unreachable: number;
  byDesignAbsent: number;
  /** Every failure in the contract, flattened, for a screen that leads with what is wrong. */
  failures: { id: number; title: string; status: FlowStatus; failure: string }[];
}

export function matrixSummary(flows: readonly FlowSpec[] = FLOWS): MatrixSummary {
  const failures: MatrixSummary['failures'] = [];
  for (const f of flows) {
    for (const failure of f.failures) failures.push({ id: f.id, title: f.title, status: f.status, failure });
  }
  return {
    total: flows.length,
    wired: flows.filter((f) => f.status === 'wired').length,
    partial: flows.filter((f) => f.status === 'partial').length,
    unreachable: flows.filter((f) => f.status === 'unreachable').length,
    byDesignAbsent: flows.filter((f) => f.status === 'by_design_absent').length,
    failures,
  };
}

export const STATUS_LABELS: Record<FlowStatus, string> = {
  wired: 'Wired',
  partial: 'Partial',
  unreachable: 'Unreachable',
  by_design_absent: 'Absent by design',
};

// =================================================================================================
// THE VIEWER CLASSES THE LEAKAGE MATRIX IS BUILT FROM
// =================================================================================================
//
// Five classes, because those are the five the brief names (12-15, plus the anonymous caller every
// gate has to refuse). The role strings are the ones in PERMS_BY_ROLE — an invented role answers
// false for every capability, which would make this matrix pass by testing nothing.

export interface ViewerClass {
  key: 'founder' | 'hr' | 'manager' | 'employee' | 'anonymous';
  label: string;
  /** users.role, or null for a caller with no session. */
  role: string | null;
  /** What this class must be able to reach. */
  mustHold: readonly string[];
  /** What this class must NEVER hold. A single true here is a leak. */
  mustNotHold: readonly string[];
}

export const VIEWER_CLASSES: readonly ViewerClass[] = Object.freeze([
  {
    key: 'founder',
    label: 'Founder (super_admin)',
    role: 'super_admin',
    mustHold: ['admin.access', 'audit.view', 'employee.manage', 'users.edit', 'resumes.view'],
    // department.lead is a SCOPE, not a rank. super_admin deliberately does not hold it and
    // requireTeamLead() refuses the founder today; granting it would change who leads a department.
    // The three horizon.* section capabilities are unratified and must answer false for everybody.
    mustNotHold: [
      'department.lead',
      'horizon.behaviour.view',
      'horizon.personal_summary.view',
      'horizon.sustainability.view',
    ],
  },
  {
    key: 'hr',
    label: 'HR',
    role: 'hr',
    mustHold: ['admin.access', 'employee.manage'],
    mustNotHold: [
      'credits.grant',
      'payments.retry',
      'profiles.manage',
      'department.lead',
      'audit.view',
      'horizon.behaviour.view',
    ],
  },
  {
    key: 'manager',
    label: 'Manager (department_head)',
    role: 'department_head',
    mustHold: ['department.lead'],
    mustNotHold: [
      'users.edit',
      'settings.edit',
      'audit.view',
      'payouts.pay',
      'resumes.view',
      'performance.manage',
      'employee.manage',
      'horizon.behaviour.view',
    ],
  },
  {
    key: 'employee',
    label: 'Employee (non-admin account)',
    role: 'applicant',
    mustHold: [],
    mustNotHold: [
      'admin.access',
      'employee.manage',
      'applications.view',
      'users.view',
      'audit.view',
      'performance.manage',
      'horizon.behaviour.view',
    ],
  },
  {
    key: 'anonymous',
    label: 'No session',
    role: null,
    mustHold: [],
    mustNotHold: ['admin.access', 'employee.manage', 'applications.view', 'users.view', 'audit.view'],
  },
]);
