// src/lib/horizon/integration/concepts.ts — ONE CONCEPT, ONE CANONICAL SOURCE OF TRUTH.
//
// =================================================================================================
// THE FAILURE THIS FILE EXISTS TO CATCH, WHICH HAS ALREADY HAPPENED HERE SEVERAL TIMES OVER
// =================================================================================================
//
// The brief names it directly: "Do not allow duplicate tables or duplicate state stores representing
// the same concept unless there is a clearly defined replication reason." It lists the concepts that
// matter — Employee, Applicant, Feedback, Evidence, Computation, Signal, Decision, Consent, Audit
// Log, Report — and requires exactly one owner for each.
//
// Twenty-one agents, each correctly told to own their subdirectory and never edit another patch's
// contract, each hit the same wall: the module they needed did not exist yet. Rule 8 says publish a
// typed boundary rather than build somebody else's module. Several patches did that. Several
// declared a table instead, and a table is not a boundary — it is a second copy of the truth.
//
// =================================================================================================
// WHY THIS IS A REGISTRY AND NOT A LIST OF FINDINGS
// =================================================================================================
//
// A hand-written list of duplicates was stale within the hour it was written: the tree went from 22
// declared tables to 46 while this file was being drafted, and `horizon_consent` — a duplicate named
// in the first draft — was rewritten out of existence by its own author mid-session.
//
// So the findings are DERIVED. TABLE_CONCEPT says which concept each table belongs to and whether it
// has a stated reason to exist beside the canonical one; `duplicateFindings()` reads the tables the
// repository ACTUALLY declares (collect.ts scans for them) and computes the rest. A table nobody has
// classified is not silently ignored — it is reported as unclassified, which is the state a
// forty-seventh table appears in tomorrow.
//
// NOTHING IN THIS FILE TOUCHES THE DATABASE. It reasons over declarations, so it is unit-testable
// with no connection — which matters, because on this project a survey that opened a connection read
// staff data it had no business reading.

// -------------------------------------------------------------------------------------------------
// THE CONCEPTS
// -------------------------------------------------------------------------------------------------

export interface CanonicalConcept {
  key: string;
  label: string;
  /** The module that owns the truth. A path, so a reader can open it. */
  ownerModule: string;
  /** The table that IS the concept. */
  ownerTable: string;
  /** The patch that owns it; null where a pre-HORIZON module does. */
  ownerPatch: number | null;
  /** True when the canonical table is named in a contract but no DDL declares it anywhere. */
  reservedOnly: boolean;
  note: string;
}

export const CANONICAL_CONCEPTS: readonly CanonicalConcept[] = Object.freeze([
  {
    key: 'employee',
    label: 'Employee',
    ownerModule: 'db/hr-schema.sql + src/lib/hr',
    ownerTable: 'hr_employees',
    ownerPatch: null,
    reservedOnly: false,
    note:
      'hr_employees.id, never hr_employees.user_id and never users.id. src/lib/horizon/ids.ts states '
      + 'this and every HORIZON patch follows it. NO PATCH CREATED A SECOND EMPLOYEE TABLE, which is '
      + 'the single most important thing this build got right.',
  },
  {
    key: 'applicant',
    label: 'Applicant',
    ownerModule: 'src/lib/talent (tal_person), applications as fallback',
    ownerTable: 'tal_person',
    ownerPatch: null,
    reservedOnly: false,
    note:
      'A PRE-EXISTING FORK, not caused by HORIZON: two parallel recruitment stacks (tal_* and tos_*) '
      + 'were already in the tree. SubjectRef.idScheme records which anchor a subject uses rather than '
      + 'leaving a reader to guess, which is the correct handling of a fork nobody has resolved.',
  },
  {
    key: 'master_record',
    label: 'Master employee intelligence record',
    ownerModule: 'src/lib/digital-twin.ts + src/lib/evidence-graph.ts',
    ownerTable: 'hzn_profile',
    ownerPatch: 0,
    reservedOnly: false,
    note:
      'THE MASTER RECORD ALREADY EXISTED BEFORE HORIZON. digital-twin.ts resolvePerson() bridges the '
      + 'four id spaces a human occupies, carries seven provenance types, and gates fifteen aspects '
      + 'through twinAccess() before a byte is read. hzn_profile is deliberately almost empty — a '
      + 'HEADER whose content is composed at read time. Patch 15 is the only view patch that named '
      + 'the existing record. Every role view must compose it, never copy it.',
  },
  {
    key: 'consent',
    label: 'Consent',
    ownerModule: 'src/lib/horizon/governance',
    ownerTable: 'hgov_consent',
    ownerPatch: 17,
    reservedOnly: false,
    note:
      'Canonical because it alone carries the withdrawal event log, the retention policy and the '
      + 'erasure request — the three things that make a consent record mean anything after the grant. '
      + 'A withdrawal recorded in one ledger is invisible to the others, and for consent specifically '
      + 'a stale `true` is the exact failure the record exists to prevent.',
  },
  {
    key: 'access_log',
    label: 'Access log',
    ownerModule: 'src/lib/horizon/governance',
    ownerTable: 'hgov_access_log',
    ownerPatch: 17,
    reservedOnly: false,
    note:
      'Who READ an intelligence record, which the platform audit_log does not answer. Rule 17 of the '
      + 'brief requires every sensitive read to be logged; three separate logs mean an access review '
      + 'has three places to look and no guarantee it found them all.',
  },
  {
    key: 'decision',
    label: 'Human decision',
    ownerModule: 'src/lib/horizon/governance',
    ownerTable: 'hgov_decision_log',
    ownerPatch: 17,
    reservedOnly: false,
    note:
      'Rule 14 lives here. Every hire, reject, hold or promotion outcome must be a row naming the '
      + 'human who chose it, when, on what evidence, at which version. Patch 10 produces the support '
      + 'report; it must never write the outcome itself.',
  },
  {
    key: 'human_action',
    label: 'Recorded human action',
    ownerModule: 'src/lib/hr-intelligence',
    ownerTable: 'hri_interventions',
    ownerPatch: 13,
    reservedOnly: false,
    note:
      'AN ACTION IS NOT A DECISION, and an earlier version of this register conflated them — which '
      + 'reported four false duplicates against hgov_decision_log. An HR intervention, a manager '
      + 'check-in and a development action change no one\'s employment status; they are things a '
      + 'named human DID, recorded so a later reader can see what followed a signal. hgov_decision_log '
      + 'stays reserved for the outcomes rule 14 governs: hire, reject, hold, promote, terminate.',
  },
  {
    key: 'feedback',
    label: 'Feedback',
    ownerModule: 'src/lib/performance-schema.ts',
    ownerTable: 'hr_feedback',
    ownerPatch: null,
    reservedOnly: false,
    note:
      'The model the whole build should have followed: patch 5 extends the existing owner additively, '
      + 'declares only child tables holding structure the parent never had, and states in its header '
      + 'what it does not own.',
  },
  {
    key: 'evidence',
    label: 'Evidence',
    ownerModule: 'src/lib/evidence-graph.ts',
    ownerTable: 'capability_evidence',
    ownerPatch: null,
    reservedOnly: false,
    note:
      'The pre-HORIZON evidence graph already implements seven evidence levels and full claim-to-'
      + 'source chains. hzn_evidence is a legitimate second thing, not a fork: capability_evidence '
      + 'answers "why does the system believe this person has this SKILL", hzn_evidence answers "what '
      + 'did this intelligence OUTPUT rest on" and may cite a capability_evidence row by reference.',
  },
  {
    key: 'computation',
    label: 'Computation run',
    ownerModule: 'src/lib/horizon/schema.ts',
    ownerTable: 'hzn_computation',
    ownerPatch: 0,
    reservedOnly: false,
    note:
      'One row per RUN of one engine. This is what makes INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE '
      + '-> CONFIDENCE -> TIMESTAMP reconstructable months later, and every IntelligenceResult must '
      + 'cite exactly one. Two competing run logs means that chain can be reconstructed two ways that '
      + 'disagree.',
  },
  {
    key: 'signal',
    label: 'Signal',
    ownerModule: 'src/lib/horizon/schema.ts',
    ownerTable: 'hzn_signal',
    ownerPatch: 0,
    reservedOnly: false,
    note:
      'The brief requires deduplication, storm suppression, staleness and unresolved-signal tracking, '
      + 'and every one of those is a property of ONE durable store. Two stores cannot deduplicate '
      + 'against each other, so a signal raised in one is raised again by the other.',
  },
  {
    key: 'intelligence_result',
    label: 'Intelligence result',
    ownerModule: 'src/lib/horizon/schema.ts',
    ownerTable: 'hzn_intelligence_result',
    ownerPatch: 0,
    reservedOnly: false,
    note:
      'Superseded, never updated in place. "What did this say in March" is exactly the question an '
      + 'appeal asks, and a row that changed under the decision taken on it cannot answer it.',
  },
  {
    key: 'report',
    label: 'Report',
    ownerModule: 'src/lib/horizon/report',
    ownerTable: 'hzn_report',
    ownerPatch: 18,
    reservedOnly: false,
    note: 'The header of a role-scoped rendering: who it was for, which computations it cites, when.',
  },
  {
    key: 'event',
    label: 'Event outbox',
    ownerModule: 'src/lib/horizon/events.ts',
    ownerTable: 'hzn_event',
    ownerPatch: 0,
    reservedOnly: false,
    note:
      'The brief requires idempotency, retry safety, ordering safety and dead-lettering. The platform '
      + 'already runs a Postgres-backed job queue (edu_jobs) with retries and idempotency keys; an '
      + 'outbox that ignores it inherits the same crashed-worker reclaim gap a second time.',
  },
  {
    key: 'personal_foundation',
    label: 'Personal foundation record',
    ownerModule: 'src/lib/horizon/intake',
    ownerTable: 'hzn_personal_foundation',
    ownerPatch: 1,
    reservedOnly: false,
    note:
      'The most sensitive table in the system. Rule 17: consent-controlled, purpose-limited, '
      + 'protected, access-logged. Rule 21: never presented as proven scientific fact. Rule 22: never '
      + 'outweighs demonstrated job-related evidence.',
  },
]);

export function conceptFor(key: string): CanonicalConcept | null {
  return CANONICAL_CONCEPTS.find((c) => c.key === key) || null;
}

// -------------------------------------------------------------------------------------------------
// TABLE -> CONCEPT
// -------------------------------------------------------------------------------------------------

export interface TableClassification {
  concept: string;
  patch: number | null;
  module: string;
  /**
   * WHY this table may exist beside the canonical one.
   *
   * `null` is the finding. A second store with a stated reason is a design decision somebody made on
   * purpose; a second store with no reason is a place where the truth forked, and this field is the
   * only thing that separates them.
   */
  reason: string | null;
}

/**
 * Every table any HORIZON patch declares, classified.
 *
 * Add a row here when a patch adds a table. An unclassified table is REPORTED, not ignored — see
 * unclassifiedTables().
 */
export const TABLE_CONCEPT: Readonly<Record<string, TableClassification>> = Object.freeze({
  // ---- Patch 00, the core -----------------------------------------------------------------------
  hzn_profile: { concept: 'master_record', patch: 0, module: 'src/lib/horizon/schema.ts', reason: 'canonical' },
  hzn_computation: { concept: 'computation', patch: 0, module: 'src/lib/horizon/schema.ts', reason: 'canonical' },
  hzn_intelligence_result: { concept: 'intelligence_result', patch: 0, module: 'src/lib/horizon/schema.ts', reason: 'canonical' },
  hzn_evidence: {
    concept: 'evidence', patch: 0, module: 'src/lib/horizon/schema.ts',
    reason:
      'Deliberate and documented in ids.ts: this holds what an intelligence OUTPUT rested on, and '
      + 'cites capability_evidence rows by reference rather than copying them.',
  },
  hzn_signal: { concept: 'signal', patch: 0, module: 'src/lib/horizon/schema.ts', reason: 'canonical' },
  hzn_report: { concept: 'report', patch: 0, module: 'src/lib/horizon/schema.ts', reason: 'canonical' },
  hzn_event: { concept: 'event', patch: 0, module: 'src/lib/horizon/schema.ts', reason: 'canonical' },
  hzn_access_log: { concept: 'access_log', patch: 0, module: 'src/lib/horizon/schema.ts', reason: null },
  hzn_feedback_contribution: {
    concept: 'feedback', patch: 0, module: 'src/lib/horizon/schema.ts',
    reason:
      'Deliberate: an AGGREGATION LEDGER pointing at a feedback row owned elsewhere. ids.ts states '
      + 'that HORIZON stores no feedback body, and this table holds none.',
  },

  // ---- Patch 01, intake -------------------------------------------------------------------------
  hzn_personal_foundation: { concept: 'personal_foundation', patch: 1, module: 'src/lib/horizon/intake/schema.ts', reason: 'canonical' },
  hzn_recompute_request: {
    concept: 'event', patch: 1, module: 'src/lib/horizon/intake/schema.ts',
    reason:
      'Deliberate, and the file says so: the durable half of profile.recompute_requested, written '
      + 'because no outbox existed when patch 1 landed. It is a candidate for deletion the day '
      + 'hzn_event is published to.',
  },
  hzn_consent_event: { concept: 'consent', patch: 1, module: 'src/lib/horizon/intake/schema.ts', reason: null },

  // ---- Patch 02, foundational computation -------------------------------------------------------
  fpc_subject_input: { concept: 'personal_foundation', patch: 2, module: 'src/lib/foundational/schema.ts', reason: null },
  fpc_consent: { concept: 'consent', patch: 2, module: 'src/lib/foundational/schema.ts', reason: null },
  fpc_computation: { concept: 'computation', patch: 2, module: 'src/lib/foundational/schema.ts', reason: null },
  fpc_factor: {
    concept: 'intelligence_result', patch: 2, module: 'src/lib/foundational/schema.ts',
    reason:
      'Deliberate: a neutral FACTOR is not an IntelligenceResult. It carries no opinion about '
      + 'employment and is the input the interpretation layer translates, which is the separation '
      + 'rules 20 and 21 of the brief require.',
  },
  fpc_period: {
    concept: 'computation', patch: 2, module: 'src/lib/foundational/schema.ts',
    reason: 'Deliberate: computed time-cycle periods, which are arithmetic rather than a run record.',
  },

  // ---- Patch 03, interpretation -----------------------------------------------------------------
  horizon_interpretations: {
    concept: 'intelligence_result', patch: 3, module: 'src/lib/horizon/interpretation/store.ts', reason: null,
  },
  horizon_dimension_results: {
    concept: 'intelligence_result', patch: 3, module: 'src/lib/horizon/interpretation/store.ts', reason: null,
  },
  horizon_dimension_factors: {
    concept: 'computation', patch: 3, module: 'src/lib/horizon/interpretation/store.ts', reason: null,
  },

  // ---- Patch 05, feedback -----------------------------------------------------------------------
  hr_feedback_dimensions: {
    concept: 'feedback', patch: 5, module: 'src/lib/horizon/feedback/schema.ts',
    reason:
      'Deliberate and correct: a child table of hr_feedback holding one rating per dimension, which '
      + 'the parent never had. The body stays in hr_feedback and every existing reader is unaffected.',
  },
  hr_feedback_examples: {
    concept: 'feedback', patch: 5, module: 'src/lib/horizon/feedback/schema.ts',
    reason: 'Deliberate: the cited incidents behind a rating. Child of hr_feedback, same reasoning.',
  },

  // ---- Patch 06, fusion -------------------------------------------------------------------------
  hif_readings: { concept: 'intelligence_result', patch: 6, module: 'src/lib/fusion/schema.ts', reason: null },
  hif_snapshots: { concept: 'intelligence_result', patch: 6, module: 'src/lib/fusion/schema.ts', reason: null },
  hif_weight_profiles: {
    concept: 'computation', patch: 6, module: 'src/lib/fusion/schema.ts',
    reason:
      'Deliberate: the weighting configuration a fusion run used, which must be versioned separately '
      + 'from the run so an old result stays reconstructable after the weights change.',
  },
  hif_notes: {
    concept: 'feedback', patch: 6, module: 'src/lib/fusion/schema.ts',
    reason: 'Deliberate: a human note ON a fused reading, which is not feedback about a person.',
  },

  // ---- Patch 08, signals ------------------------------------------------------------------------
  horizon_signals: { concept: 'signal', patch: 8, module: 'src/lib/horizon/signal-engine.ts', reason: null },
  horizon_signal_events: { concept: 'signal', patch: 8, module: 'src/lib/horizon/signal-engine.ts', reason: null },

  // ---- Patch 09, interview intelligence ---------------------------------------------------------
  interview_intel_observations: {
    concept: 'feedback', patch: 9, module: 'src/lib/interview-intelligence.ts',
    reason:
      'Deliberate: evidence an interviewer recorded about a CANDIDATE during an interview. '
      + 'hr_feedback is about employees and has no interview, no panel and no recommendation grade.',
  },
  interview_intel_assessments: {
    concept: 'feedback', patch: 9, module: 'src/lib/interview-intelligence.ts',
    reason: 'Deliberate: the interviewer\'s signed recommendation grade and its stated reasons.',
  },
  interview_intel_snapshots: {
    concept: 'intelligence_result', patch: 9, module: 'src/lib/interview-intelligence.ts',
    reason:
      'Deliberate: a point-in-time capture of exactly what the interviewer was SHOWN. The audit '
      + 'requirement is answerable only if the briefing is frozen at the moment it was read.',
  },

  // ---- Patch 10, hiring decision support --------------------------------------------------------
  hiring_decisions: { concept: 'decision', patch: 10, module: 'src/lib/hiring-decision.ts', reason: null },

  // ---- Patch 13, HR view ------------------------------------------------------------------------
  hri_development_plans: {
    concept: 'human_action', patch: 13, module: 'src/lib/hr-intelligence/schema.ts',
    reason: 'Deliberate: a PLAN is not an action taken; it is the intent an action is recorded against.',
  },
  hri_plan_items: {
    concept: 'human_action', patch: 13, module: 'src/lib/hr-intelligence/schema.ts',
    reason: 'Deliberate: line items of a development plan.',
  },
  hri_interventions: { concept: 'human_action', patch: 13, module: 'src/lib/hr-intelligence/schema.ts', reason: 'canonical' },
  hri_mobility_reviews: {
    concept: 'human_action', patch: 13, module: 'src/lib/hr-intelligence/schema.ts',
    reason:
      'Deliberate: a mobility review is a considered comparison recorded by HR, and it must NOT sit '
      + 'in the same table as an intervention — one is deliberation, the other is something done.',
  },
  hri_feedback_requests: {
    concept: 'feedback', patch: 13, module: 'src/lib/hr-intelligence/schema.ts',
    reason: 'Deliberate: a REQUEST for feedback is not a feedback record.',
  },
  hri_access_log: { concept: 'access_log', patch: 13, module: 'src/lib/hr-intelligence/schema.ts', reason: null },

  // ---- Patch 14, manager view -------------------------------------------------------------------
  mti_manager_actions: { concept: 'human_action', patch: 14, module: 'src/lib/manager-intelligence/schema.ts', reason: null },
  mti_development_actions: {
    concept: 'human_action', patch: 14, module: 'src/lib/manager-intelligence/schema.ts',
    reason:
      'Deliberate: a development action a MANAGER commits to for their own reportee, which is a '
      + 'different authority from an HR development plan and is visible to different people.',
  },
  mti_record_outbox: { concept: 'event', patch: 14, module: 'src/lib/manager-intelligence/schema.ts', reason: null },

  // ---- Patch 15, employee portal ----------------------------------------------------------------
  emp_intel_reflection: {
    concept: 'feedback', patch: 15, module: 'src/lib/intelligence/schema.ts',
    reason:
      'Deliberate: the employee\'s own words about their own work. Self-reflection is held apart from '
      + 'the feedback others give, by design, in both patch 5 and patch 15.',
  },
  emp_intel_consent: { concept: 'consent', patch: 15, module: 'src/lib/intelligence/schema.ts', reason: null },
  emp_intel_correction: {
    concept: 'master_record', patch: 15, module: 'src/lib/intelligence/schema.ts',
    reason:
      'Deliberate: a person\'s statement that a record about them is wrong. Nothing else in the system '
      + 'holds a contestation, and the right to make one is the point.',
  },

  // ---- Patch 17, governance ---------------------------------------------------------------------
  hgov_consent: { concept: 'consent', patch: 17, module: 'src/lib/horizon/governance/schema.ts', reason: 'canonical' },
  hgov_consent_events: {
    concept: 'consent', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason: 'Deliberate: the append-only grant/withdrawal log behind hgov_consent.',
  },
  hgov_access_log: { concept: 'access_log', patch: 17, module: 'src/lib/horizon/governance/schema.ts', reason: 'canonical' },
  hgov_decision_log: { concept: 'decision', patch: 17, module: 'src/lib/horizon/governance/schema.ts', reason: 'canonical' },
  hgov_recommendation_log: {
    concept: 'intelligence_result', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason: 'Deliberate: what was RECOMMENDED to a human, which is audited separately from what was computed.',
  },
  hgov_recompute_log: {
    concept: 'computation', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason: 'Deliberate: the audit of recompute requests, not the run itself.',
  },
  hgov_generation_log: { concept: 'computation', patch: 17, module: 'src/lib/horizon/governance/schema.ts', reason: null },
  hgov_intelligence_versions: {
    concept: 'computation', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason: 'Deliberate: the engine version register every result cites. Versions are not runs.',
  },
  hgov_feedback_revisions: {
    concept: 'feedback', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason:
      'Deliberate: revision history for a feedback row, which hr_feedback cannot answer because it is '
      + 'overwritten in place.',
  },
  hgov_retention_policies: {
    concept: 'consent', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason: 'Deliberate: how long a purpose may hold data, which is part of the consent contract.',
  },
  hgov_erasure_requests: {
    concept: 'consent', patch: 17, module: 'src/lib/horizon/governance/schema.ts',
    reason: 'Deliberate: a withdrawal that requires deletion, which is a different act from withdrawing.',
  },
});

// -------------------------------------------------------------------------------------------------
// DETECTION
// -------------------------------------------------------------------------------------------------

export type DuplicateSeverity = 'defect' | 'by_design';

export interface DuplicateFinding {
  conceptKey: string;
  conceptLabel: string;
  severity: DuplicateSeverity;
  canonicalTable: string;
  canonicalModule: string;
  duplicateTable: string;
  duplicateModule: string;
  duplicatePatch: number | null;
  sentence: string;
}

/**
 * Every second store of a canonical concept, split into the two kinds that need opposite actions.
 *
 * `observedTables` is what the repository ACTUALLY declares — passed in by collect.ts rather than
 * assumed here, so a table that disappears when its author rewrites the file stops being reported as
 * a duplicate on the next run instead of haunting a hard-coded list.
 *
 * A `by_design` row is a line somebody must not cross later; a `defect` row is work somebody owes.
 * Collapsing them into one list is how a real defect gets closed as "already justified".
 */
export function duplicateFindings(observedTables: readonly string[]): DuplicateFinding[] {
  const present = new Set(observedTables);
  const out: DuplicateFinding[] = [];
  for (const [table, cls] of Object.entries(TABLE_CONCEPT)) {
    if (!present.has(table)) continue;
    if (cls.reason === 'canonical') continue;
    const c = conceptFor(cls.concept);
    if (!c) continue;
    if (table === c.ownerTable) continue;
    out.push({
      conceptKey: c.key,
      conceptLabel: c.label,
      severity: cls.reason ? 'by_design' : 'defect',
      canonicalTable: c.ownerTable,
      canonicalModule: c.ownerModule,
      duplicateTable: table,
      duplicateModule: cls.module,
      duplicatePatch: cls.patch,
      sentence: cls.reason
        || (table + ' holds ' + c.label.toLowerCase() + ' alongside ' + c.ownerTable
          + ', with no stated replication reason. One of the two is not the truth, and nothing in the '
          + 'code says which.'),
    });
  }
  return out.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'defect' ? -1 : 1)
    || a.conceptLabel.localeCompare(b.conceptLabel)
    || a.duplicateTable.localeCompare(b.duplicateTable));
}

/**
 * Tables the repository declares that nothing in TABLE_CONCEPT accounts for.
 *
 * This is the drift guard, and it is the reason this file does not go stale. When a forty-seventh
 * table appears in somebody's schema.ts, this is what notices before it becomes a fourth consent
 * ledger — an unclassified table is a question nobody has answered, not a table that is fine.
 */
export function unclassifiedTables(observedTables: readonly string[]): string[] {
  return observedTables.filter((t) => !TABLE_CONCEPT[t]).sort();
}

/** Concepts whose canonical table is not declared by any DDL in the tree. */
export function conceptsWithNoStore(observedTables: readonly string[]): CanonicalConcept[] {
  const present = new Set(observedTables);
  return CANONICAL_CONCEPTS.filter(
    (c) => c.ownerPatch !== null && !present.has(c.ownerTable),
  );
}

/** Patch numbers that declared an unjustified duplicate, for the handoff list. */
export function patchesOwingMigration(observedTables: readonly string[]): number[] {
  const out = new Set<number>();
  for (const f of duplicateFindings(observedTables)) {
    if (f.severity === 'defect' && f.duplicatePatch !== null) out.add(f.duplicatePatch);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** The one-line summary a console header prints. */
export function conceptHealthSentence(observedTables: readonly string[]): string {
  const defects = duplicateFindings(observedTables).filter((f) => f.severity === 'defect');
  if (defects.length === 0) {
    return 'Every canonical concept has one owner, and every second store states why it exists.';
  }
  const concepts = Array.from(new Set(defects.map((d) => d.conceptLabel)));
  return defects.length + ' unjustified duplicate store'
    + (defects.length === 1 ? '' : 's') + ' across ' + concepts.length + ' concept'
    + (concepts.length === 1 ? '' : 's') + ': ' + concepts.join(', ') + '.';
}
