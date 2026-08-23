// src/lib/horizon/integration/map.ts — PATCH 20's OWNED CONTRACT: THE INTEGRATION MAP.
//
// =================================================================================================
// WHAT THIS FILE IS, AND WHY IT IS DATA RATHER THAN PROSE
// =================================================================================================
//
// Patch 20's brief opens with a mandatory first step: produce an integration map of
//
//     MODULE -> OWNER -> INPUTS -> OUTPUTS -> DATABASE TABLES -> API CONTRACTS -> EVENTS
//            -> DEPENDENCIES -> CURRENT STATUS
//
// before changing anything. A map written as a document is out of date the day after it is written,
// and on this project that is not hyperbole: twenty-one agents wrote into this tree simultaneously
// and the file count under src/lib/horizon went from 3 to 63 inside the hour this map was compiled.
//
// So the map is DATA. Everything in it that a machine can check is checked — assess.ts reads the
// repository through Patch 19's probe and computes CURRENT STATUS rather than trusting the value
// declared here. The only fields taken on trust are the ones no probe can establish: what a module
// is FOR, and who OWES it.
//
// =================================================================================================
// WHAT PATCH 20 DOES NOT DO
// =================================================================================================
//
// It owns no business logic, no dimension, no score and no screen belonging to another patch. It
// owns the QUESTION "is this one system yet", and the honest answer to it.
//
// It also does not duplicate Patch 19. Patch 19 (src/lib/horizon/contract.ts, probe.ts) maps FLOWS:
// fifteen chains, producer to consumer, with the seams that prove them. This file maps MODULES:
// twenty-one patches, what each owns, and where two of them own the same thing. Those are different
// questions and the second one is the one that finds duplicate tables. Patch 19's probe primitives
// are IMPORTED here and not re-implemented — a second copy of "which specifiers reach this file" is
// exactly the drift both patches exist to catch.

// -------------------------------------------------------------------------------------------------
// STATUS VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * The five states a module can be in, and they are deliberately not a boolean.
 *
 * `contract_only` is the state this system is overwhelmingly in and it is the one a boolean would
 * hide. A 400-line file of types, unions and pure functions with a careful header is real work and
 * it is not a working feature; calling it "done" because the file exists is how a project reports
 * itself complete while nobody can open anything.
 */
export const MODULE_STATES = [
  'absent',
  'contract_only',
  'implemented',
  'reachable',
  'unreadable',
] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export const MODULE_STATE_LABELS: Record<ModuleState, string> = {
  absent: 'Not started',
  contract_only: 'Contract only',
  implemented: 'Implemented, no surface',
  reachable: 'Reachable',
  unreadable: 'Could not be read',
};

export const MODULE_STATE_MEANING: Record<ModuleState, string> = {
  absent:
    'No file for this patch exists in the tree. Nothing is wrong with it; it has not been written.',
  contract_only:
    'Types, unions, labels and pure functions exist. No table is declared and no runtime path writes '
    + 'or reads anything. This is a specification in TypeScript, not a working module.',
  implemented:
    'Runtime code exists — schema, queries, or functions that do work — but nothing under src/pages '
    + 'imports it, so no person can reach it. An unreachable module is a failure of integration, '
    + 'not of the module.',
  reachable:
    'A page or an API route imports it directly, so there is a URL a person can open that runs this '
    + 'code. This is the only state that means a feature exists.',
  unreadable:
    'The source tree could not be read in this environment, so the state is unknown. This is NOT the '
    + 'same as absent, and it is never reported as absent.',
};

// -------------------------------------------------------------------------------------------------
// THE SHAPE OF ONE ENTRY
// -------------------------------------------------------------------------------------------------

export interface ModuleEntry {
  /** 0..20. The brief's own numbering, which is the only numbering every agent shares. */
  patch: number;
  title: string;
  /**
   * The directory or file this patch owns. Repo-relative, forward-slashed.
   *
   * Empty ONLY for a patch with no module in the tree, which is a fact the assessment reports rather
   * than a hole in this file.
   */
  owns: readonly string[];
  /**
   * The one file whose existence proves the patch has started, and whose absence proves it has not.
   * Chosen as the contract file wherever there is one, because that is what lands first.
   */
  provesWith: string | null;
  /** What it reads. Named in the vocabulary of the module that owns the input, never invented. */
  inputs: readonly string[];
  /** What it produces for other patches to consume. */
  outputs: readonly string[];
  /** Tables this patch DECLARES DDL for. Not tables it reads — those belong to their owner. */
  tables: readonly string[];
  /** HORIZON event names (src/lib/horizon/events.ts) it emits. */
  emits: readonly string[];
  /** HORIZON event names it consumes. */
  consumes: readonly string[];
  /** Patch numbers whose contracts it imports or must import. */
  dependsOn: readonly number[];
  /**
   * The route that renders this patch, if the brief calls for one. `null` where the patch is a
   * library layer with no screen of its own by design.
   */
  surface: string | null;
  /** What the reader most needs to know that the probe cannot tell them. */
  note: string;
}

// -------------------------------------------------------------------------------------------------
// THE MAP
// -------------------------------------------------------------------------------------------------
//
// `owns` paths were established by reading the tree on 2026-08-23, not from the brief. Where a patch
// placed its module OUTSIDE src/lib/horizon/ that is recorded as written rather than corrected: five
// patches did, and moving another agent's directory mid-build is precisely the overwrite rule 6
// forbids. It is reported by assess.ts as a placement finding instead.

export const INTEGRATION_MAP: readonly ModuleEntry[] = Object.freeze([
  {
    patch: 0,
    title: 'Core architecture and shared contracts',
    owns: [
      'src/lib/horizon/ids.ts',
      'src/lib/horizon/types.ts',
      'src/lib/horizon/time.ts',
      'src/lib/horizon/events.ts',
      'src/lib/horizon/api.ts',
      'src/lib/horizon/pg.ts',
      'src/lib/horizon/evidence.ts',
      'src/lib/horizon/schema.ts',
      'src/lib/horizon/index.ts',
      'src/lib/horizon/record.ts',
      'src/lib/horizon/profile.ts',
      'src/lib/horizon/access.ts',
      'src/lib/horizon/adapters.ts',
      'src/lib/horizon/visibility.ts',
    ],
    provesWith: 'src/lib/horizon/ids.ts',
    inputs: ['nothing — the contract half of this layer is pure'],
    outputs: [
      'HorizonId brands and ID_OWNERSHIP (the registry that prevents duplicate tables)',
      'SubjectRef / ActorRef',
      'the seven data layers and mayCite()',
      'HORIZON_EVENTS names and payload shapes',
    ],
    tables: [
      'hzn_profile', 'hzn_computation', 'hzn_intelligence_result', 'hzn_evidence',
      'hzn_signal', 'hzn_report', 'hzn_event', 'hzn_access_log', 'hzn_feedback_contribution',
    ],
    emits: [],
    consumes: [],
    dependsOn: [],
    surface: null,
    note:
      'ids.ts cites docs/horizon/HORIZON_CONTRACTS.md sections 2, 3, 6, 7, 8 and 9. That document does '
      + 'not exist in this repository. Every patch that read the citation had to infer the contract '
      + 'from the code, which is the most likely single cause of the divergences below.',
  },
  {
    patch: 1,
    title: 'Application and personal foundation data intake',
    owns: ['src/lib/horizon/intake/'],
    provesWith: 'src/lib/horizon/intake/types.ts',
    inputs: ['applications', 'the applicant-supplied birth co-ordinates', 'a recorded consent'],
    outputs: ['PersonalFoundationRecord', 'a recompute request'],
    tables: ['hzn_consent_event', 'hzn_personal_foundation', 'hzn_recompute_request'],
    emits: ['application.submitted', 'profile.recompute_requested'],
    consumes: [],
    dependsOn: [0],
    surface: '/apply (intake) — not built',
    note:
      'Declares hzn_consent_event as an append-only consent ledger. Three other patches declare their '
      + 'own consent store. See concepts.ts CANONICAL_CONCEPTS.consent.',
  },
  {
    patch: 2,
    title: 'Foundational personal computation engine',
    owns: ['src/lib/foundational/', 'src/lib/horizon/foundational/'],
    provesWith: 'src/lib/foundational/types.ts',
    inputs: ['PersonalFoundationRecord from patch 1'],
    outputs: ['versioned neutral factors, with inputs attached and no opinion about employment'],
    tables: ['fpc_subject_input', 'fpc_computation', 'fpc_factor', 'fpc_period', 'fpc_consent'],
    emits: ['intelligence.computation_completed'],
    consumes: ['profile.recompute_requested'],
    dependsOn: [0, 1],
    surface: null,
    note:
      'Placed outside src/lib/horizon/. Correctly refuses to conclude anything: the header states there '
      + 'is no recommendation, fit, risk or score_for_role in the module and none may be added.',
  },
  {
    patch: 3,
    title: 'Professional interpretation layer',
    owns: ['src/lib/horizon/interpretation/'],
    provesWith: 'src/lib/horizon/interpretation/dimensions.ts',
    inputs: ['patch 2 factors'],
    outputs: ['twelve neutral professional dimensions, with limitations attached'],
    tables: ['horizon_interpretations', 'horizon_dimension_results', 'horizon_dimension_factors'],
    emits: [],
    consumes: [],
    dependsOn: [0, 2],
    surface: null,
    note:
      'language-guard.ts enforces the brief\'s rules 19-22 at emit time: no deterministic prediction, '
      + 'no health language, no employment decision. This is the strongest single piece of rule '
      + 'enforcement in the system.',
  },
  {
    patch: 4,
    title: 'Psycho-behavioural intelligence',
    owns: ['src/lib/horizon/behaviour/', 'src/lib/behaviour/'],
    provesWith: 'src/lib/horizon/behaviour/types.ts',
    inputs: ['audit_log task transitions', 'task rows', 'assessment attempts'],
    outputs: ['BehaviouralProfile — observed working behaviour over a named window, rows attached'],
    tables: [],
    emits: [],
    consumes: ['task.assigned', 'task.submitted', 'task.updated'],
    dependsOn: [0],
    surface: null,
    note: 'Placed outside src/lib/horizon/. Reads only records the organisation already keeps.',
  },
  {
    patch: 5,
    title: '360 feedback intelligence',
    owns: ['src/lib/horizon/feedback/'],
    provesWith: 'src/lib/horizon/feedback/types.ts',
    inputs: ['hr_feedback (owned by src/lib/performance-schema.ts)', 'org-graph relationships'],
    outputs: ['weighted multi-source aggregate with disagreement, outlier and bias flags'],
    tables: ['hr_feedback_dimensions', 'hr_feedback_examples'],
    emits: ['feedback.submitted', 'feedback.updated'],
    consumes: [],
    dependsOn: [0],
    surface: '/admin/hr/performance (existing) — structured capture not wired',
    note:
      'Extends hr_feedback ADDITIVELY and does not redefine it, which is the correct pattern and the '
      + 'only patch in the system that demonstrates it against a pre-existing table.',
  },
  {
    patch: 6,
    title: 'Dynamic human intelligence fusion',
    owns: ['src/lib/fusion/'],
    provesWith: 'src/lib/fusion/types.ts',
    inputs: ['patches 3, 4, 5, 7 and the existing evidence graph'],
    outputs: ['per-dimension CONFIRMED / PARTIALLY CONFIRMED / CONTRADICTED / INSUFFICIENT'],
    tables: ['hif_readings', 'hif_snapshots', 'hif_weight_profiles', 'hif_notes'],
    emits: [],
    consumes: ['feedback.submitted', 'intelligence.computation_completed'],
    dependsOn: [0, 3, 4, 5],
    surface: null,
    note:
      'Placed outside src/lib/horizon/. Establishes nothing itself, which is the correct posture for '
      + 'a fusion layer: it reads what other modules established and reports agreement.',
  },
  {
    patch: 7,
    title: 'Temporal and longitudinal intelligence',
    owns: ['src/lib/horizon/cycles.ts', 'src/lib/horizon/temporal/'],
    provesWith: 'src/lib/horizon/cycles.ts',
    inputs: ['hr_employees.joining_date', 'hr_review_cycles', 'the fused dimensions'],
    outputs: ['windowed readings: recent, week, month, quarter, year, employment history'],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [0, 6],
    surface: null,
    note:
      'Declares horizon_consent for its own optional cycle provider. That is a fourth consent store. '
      + 'The file itself flags this as a seam to be replaced, which is the right instinct recorded in '
      + 'the wrong place — the register belongs to patch 17.',
  },
  {
    patch: 8,
    title: 'Signal and notification engine',
    owns: [
      'src/lib/horizon/signal-contract.ts',
      'src/lib/horizon/signal-detectors.ts',
      'src/lib/horizon/signal-visibility.ts',
      'src/lib/horizon/signal-engine.ts',
    ],
    provesWith: 'src/lib/horizon/signal-contract.ts',
    inputs: ['fused dimensions', 'temporal readings'],
    outputs: ['Opportunity / Growth / Watch / Attention signals with evidence and confidence'],
    tables: ['horizon_signals', 'horizon_signal_events'],
    emits: ['signal.created', 'signal.resolved'],
    consumes: [],
    dependsOn: [0, 6, 7],
    surface: null,
    note:
      'The brief requires deduplication, storm suppression, staleness and unresolved-signal tracking. '
      + 'Those need a durable signal table; no patch declares one.',
  },
  {
    patch: 9,
    title: 'Interview intelligence',
    owns: ['src/lib/interview-intelligence.ts'],
    provesWith: 'src/lib/interview-intelligence.ts',
    inputs: ['application', 'assessments', 'evidence graph', 'role requirements'],
    outputs: ['interview probes, recorded evidence, and a signed recommendation grade'],
    tables: ['interview_intel_observations', 'interview_intel_assessments', 'interview_intel_snapshots'],
    emits: ['interview.completed'],
    consumes: [],
    dependsOn: [0],
    surface: '/admin/hiring (interview console) — not built',
    note:
      'Placed at the top level of src/lib rather than under a HORIZON directory. Demonstrated '
      + 'interview evidence must be able to contradict inferred assumptions; that ordering lives in '
      + 'patch 10.',
  },
  {
    patch: 10,
    title: 'Hiring and rejection decision support',
    owns: ['src/lib/hiring-decision.ts'],
    provesWith: 'src/lib/hiring-decision.ts',
    inputs: ['patches 1, 2, 3, 9 and the assessment record'],
    outputs: ['a decision-support report that separates fact, derived metric, feedback and reading'],
    tables: ['hiring_decisions'],
    emits: [],
    consumes: ['interview.completed', 'assessment.completed'],
    dependsOn: [0, 9],
    surface: '/admin/hiring/decision — not built',
    note:
      'Rule 14: no automated module may make the final employment decision. The named human decision '
      + 'must be a recorded row with a decision maker, a timestamp, a reason and a version.',
  },
  {
    patch: 11,
    title: 'Super admin employee intelligence view',
    owns: [
      'src/lib/horizon/contracts.ts',
      'src/lib/horizon/registry.ts',
      'src/lib/horizon/sections.ts',
    ],
    provesWith: 'src/lib/horizon/contracts.ts',
    inputs: ['every patch, through registerHorizonProvider()'],
    outputs: ['twelve tabs of one Master Employee Intelligence Record'],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [0],
    surface: '/admin/horizon/[employeeId] — not built',
    note:
      'The provider registry is the best integration decision in the system: patch 11 imports nothing '
      + 'from another patch, refuses a duplicate section claim, and renders an unregistered section as '
      + 'a stated absence. It is also the reason nothing renders — no patch calls it.',
  },
  {
    patch: 12,
    title: 'Founder complete 360 employee intelligence view',
    owns: ['src/lib/founder-intel/'],
    provesWith: 'src/lib/founder-intel/types.ts',
    inputs: ['every authorised record about one person'],
    outputs: ['the deepest authorised drill-down: signal -> evidence -> source record -> timestamp'],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [0, 11],
    surface: '/founder/horizon/[employeeId] — not built',
    note:
      'Placed outside src/lib/horizon/. Renders no bare value: every number carries the six '
      + 'explainability fields. Should register through patch 11 rather than reading modules directly.',
  },
  {
    patch: 13,
    title: 'HR intelligence and talent development view',
    owns: ['src/lib/hr-intelligence/'],
    provesWith: 'src/lib/hr-intelligence/types.ts',
    inputs: ['fusion, signals, skills, learning'],
    outputs: ['talent, development need, mobility and intervention actions'],
    tables: [
      'hri_development_plans', 'hri_plan_items', 'hri_interventions', 'hri_mobility_reviews',
      'hri_feedback_requests', 'hri_access_log',
    ],
    emits: [],
    consumes: [],
    dependsOn: [0, 6, 8],
    surface: '/admin/hr/horizon — not built',
    note: 'Contract only at the time of this map.',
  },
  {
    patch: 14,
    title: 'Manager and team lead intelligence view',
    owns: ['src/lib/manager-intelligence/'],
    provesWith: 'src/lib/manager-intelligence/types.ts',
    inputs: ['org-graph reportees only', 'delivery records', 'signals'],
    outputs: ['team delivery view plus feedback, acknowledgement and intervention controls'],
    tables: ['mti_manager_actions', 'mti_development_actions', 'mti_record_outbox'],
    emits: ['feedback.submitted'],
    consumes: ['signal.created'],
    dependsOn: [0, 5, 8],
    surface: '/portal/manager/horizon — not built',
    note:
      'Placed outside src/lib/horizon/. Owns no source data, which is correct. Scope must come from '
      + 'src/lib/performance-scope.ts rather than a second reportee resolver.',
  },
  {
    patch: 15,
    title: 'Employee personal intelligence portal',
    owns: ['src/lib/intelligence/'],
    provesWith: 'src/lib/intelligence/contract.ts',
    inputs: ['digital-twin, evidence-graph, job-twin, performance — all existing modules'],
    outputs: ['the employee\'s own authorised view, their reflection, consent and corrections'],
    tables: ['emp_intel_reflection', 'emp_intel_consent', 'emp_intel_correction'],
    emits: [],
    consumes: [],
    dependsOn: [0],
    surface: '/portal/employee/intelligence — not built',
    note:
      'Placed outside src/lib/horizon/. The only patch that correctly identifies the EXISTING master '
      + 'record (digital-twin.ts + evidence-graph.ts) instead of assuming a new one. emp_intel_consent '
      + 'is a third consent store.',
  },
  {
    patch: 16,
    title: 'Profession, role suitability and internal mobility',
    owns: ['src/lib/horizon/role-compare.ts'],
    provesWith: 'src/lib/horizon/role-compare.ts',
    inputs: ['fusion dimensions', 'role requirements from src/lib/job-twin.ts', 'skills'],
    outputs: ['employee x current role, x alternative role, x future role, each explained'],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [0, 6],
    surface: '/admin/hr/horizon/mobility — not built',
    note:
      'NO MODULE EXISTS. src/lib/match.ts and src/lib/job-twin.ts already answer part of this question '
      + 'for the pre-HORIZON system; a patch 16 that ignores them would be the sixth duplicate concept '
      + 'in this build.',
  },
  {
    patch: 17,
    title: 'Governance, security, consent, audit and access control',
    owns: ['src/lib/horizon/governance/'],
    provesWith: 'src/lib/horizon/governance/types.ts',
    inputs: ['every read of a HORIZON record'],
    outputs: ['the consent register, the access log, the decision log, retention and erasure'],
    tables: [
      'hgov_consent',
      'hgov_consent_events',
      'hgov_access_log',
      'hgov_decision_log',
      'hgov_recommendation_log',
      'hgov_recompute_log',
      'hgov_generation_log',
      'hgov_intelligence_versions',
      'hgov_feedback_revisions',
      'hgov_retention_policies',
      'hgov_erasure_requests',
    ],
    emits: ['access.logged'],
    consumes: [],
    dependsOn: [0],
    surface: '/admin/horizon/governance — not built',
    note:
      'THIS IS THE CANONICAL CONSENT AND AUDIT OWNER. Eleven tables, the widest declaration in the '
      + 'system. Patches 1, 7 and 15 each declared their own consent store instead of depending on it.',
  },
  {
    patch: 18,
    title: 'Explainable intelligence reports',
    owns: ['src/lib/horizon/report/'],
    provesWith: 'src/lib/horizon/report/types.ts',
    inputs: ['any intelligence result plus its computation row'],
    outputs: ['a role-scoped rendering that cites its computations and version'],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [0, 17],
    surface: '/admin/horizon/report — not built',
    note: 'ids.ts reserves hzn_report as the header table. No patch declares DDL for it.',
  },
  {
    patch: 19,
    title: 'Integration and regression testing',
    owns: ['src/lib/horizon/contract.ts', 'src/lib/horizon/probe.ts'],
    provesWith: 'src/lib/horizon/contract.ts',
    inputs: ['the repository source tree'],
    outputs: ['fifteen flow declarations with seams, and the static probe that checks them'],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [0],
    surface: '/admin/horizon/flows — not built',
    note:
      'Patch 20 CONSUMES this rather than reimplementing it. probe.ts is the only file in the system '
      + 'that reads the tree, and it correctly states what a static probe cannot prove.',
  },
  {
    patch: 20,
    title: 'Final master integration, completion and production readiness',
    owns: ['src/lib/horizon/integration/'],
    provesWith: 'src/lib/horizon/integration/map.ts',
    inputs: ['this map', 'patch 19 probe', 'the source tree'],
    outputs: [
      'the module status assessment',
      'canonical-concept duplicate detection',
      'the definition-of-done evaluation, computed rather than declared',
    ],
    tables: [],
    emits: [],
    consumes: [],
    dependsOn: [19],
    surface: '/admin/horizon',
    note:
      'Owns no business logic by design. If this patch ever declares a table or a dimension it has '
      + 'stopped being an integrator and become a twenty-second patch.',
  },
]);

export function entryFor(patch: number): ModuleEntry | null {
  return INTEGRATION_MAP.find((m) => m.patch === patch) || null;
}

/** Every table any HORIZON patch declares DDL for, with the patch that declares it. */
export function declaredTables(): { table: string; patch: number }[] {
  const out: { table: string; patch: number }[] = [];
  for (const m of INTEGRATION_MAP) for (const t of m.tables) out.push({ table: t, patch: m.patch });
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Patches whose module sits outside src/lib/horizon/.
 *
 * Reported, not corrected. Moving another agent's directory mid-build is the overwrite this project's
 * multi-agent rules forbid, and the placement costs nothing at runtime — it costs a reader the
 * ability to find the system by listing one directory, which is a documentation problem with a
 * documentation fix.
 */
export function misplacedModules(): { patch: number; path: string }[] {
  const out: { patch: number; path: string }[] = [];
  for (const m of INTEGRATION_MAP) {
    for (const p of m.owns) {
      if (!p.startsWith('src/lib/horizon/')) out.push({ patch: m.patch, path: p });
    }
  }
  return out;
}
