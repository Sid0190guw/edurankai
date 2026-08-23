// src/lib/horizon/governance/schema.ts — the FOUR tables PATCH 17 owns, created in ONE round trip.
//
// =================================================================================================
// WHY ONLY FOUR, AND WHAT WAS DELETED FROM THIS FILE TO GET THERE
// =================================================================================================
//
// This file first declared eleven tables. Seven of them were duplicates of concepts other HORIZON
// patches already own, and they were written before this patch had read what was in the tree:
//
//   hgov_consent, hgov_consent_events  ->  hzn_consent_event      (src/lib/horizon/intake/consent.ts)
//   hgov_access_log                    ->  hzn_access_log         (src/lib/horizon/schema.ts, written
//                                                                  through visibility.requireAccessLog)
//   hgov_generation_log                ->  hzn_computation        — already the INPUTS -> PROCESSING ->
//                                                                  OUTPUT -> EVIDENCE -> CONFIDENCE ->
//                                                                  TIMESTAMP record, by name
//   hgov_recompute_log                 ->  hzn_recompute_request
//   hgov_feedback_revisions            ->  hzn_feedback_contribution (src/lib/horizon/feedback/*)
//   hgov_recommendation_log            ->  no table: a recommendation is referenced by an opaque
//                                          string, so this patch does not become its owner
//
// A second table for a concept that has one is not a smaller problem than a missing table. It is a
// bigger one: two access logs means the question "who read this record" has two answers and neither
// is complete, and the screen that reads the wrong one is honestly reporting nothing.
//
// WHAT IS LEFT IS WHAT GENUINELY HAS NO OWNER:
//
//   hgov_decision_log      what a NAMED HUMAN decided, and whether they agreed with the system.
//                          hzn_intelligence_result carries a human_review_status; nothing anywhere
//                          carries who decided, why, and whether they departed from the machine.
//   hgov_engine_version    the registry a version string resolves against. report/version.ts pins
//                          one engine's tag in code; nothing records the set, or retires one.
//   hgov_retention_policy  how long each class is kept, what happens then, and the stated basis.
//   hgov_erasure_request   the request, its second approver, its blockers and its report.
//
// EVERY TABLE HERE IS NEW AND PREFIXED `hgov_`. There are no foreign keys out of this namespace, for
// the reason src/lib/horizon/schema.ts already gives: a constraint against a table another patch may
// reshape is a failure in their deploy caused by mine.
//
// APPEND-ONLY WHERE IT MATTERS. hgov_decision_log has no UPDATE and no DELETE path in this module.
// A decision about somebody's employment that can be edited afterwards is not evidence of anything.
import { ensureBatch } from '@/lib/ensure-once';

/**
 * Bump when the DDL changes materially. ensureOnce() memoises on this key for the life of the
 * process, so a new key is how a running deployment picks up a change without a restart.
 *
 * v2 is the four-table shape. v1 declared eleven and was never deployed anywhere.
 */
export const GOVERNANCE_SCHEMA_KEY = 'horizon_governance_v2';

const DDL = `
-- ============================================================================================
-- hgov_decision_log — WHAT HUMAN ACTION FOLLOWED.
--
-- decided_by is NOT NULL and has no default, and recordHumanDecision() checks it against the users
-- table. (Written without backticks on purpose: this comment lives inside a JS template literal, and
-- a backtick here closes the DDL string early and breaks the build for everything that imports it.)
-- There is no service account, no scheduled writer and no path that writes this row on a timer, so
-- brief rule 14 is enforced by the absence of a caller that could rather than by a policy somebody
-- has to remember.
--
-- subject_ref and recommendation_ref are OPAQUE TEXT. This patch records that a decision was taken
-- about something; it does not own the thing, does not join to it, and cannot be broken by the
-- owning patch reshaping it.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS hgov_decision_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id TEXT NOT NULL DEFAULT 'org_edurankai',
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_scheme TEXT NOT NULL DEFAULT 'employee',
  recommendation_ref TEXT,
  result_id UUID,
  decided_by UUID NOT NULL,
  decided_by_name TEXT,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  agreed_with_system BOOLEAN NOT NULL,
  impact TEXT NOT NULL DEFAULT 'advisory',
  action_taken TEXT,
  engine_version TEXT,
  ip_address TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hgov_decision_subject_idx
  ON hgov_decision_log (organisation_id, subject_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS hgov_decision_ref_idx
  ON hgov_decision_log (recommendation_ref);
CREATE INDEX IF NOT EXISTS hgov_decision_result_idx
  ON hgov_decision_log (result_id);
-- THE DISAGREEMENT READ. How often the humans depart from the machine is the only honest measure of
-- whether the machine is any good, and it is a tiny minority of rows, so it gets a partial index.
CREATE INDEX IF NOT EXISTS hgov_decision_departed_idx
  ON hgov_decision_log (organisation_id, decided_at DESC) WHERE agreed_with_system = FALSE;

-- ============================================================================================
-- hgov_engine_version — WHICH INTELLIGENCE VERSION WAS USED, RESOLVED AGAINST SOMETHING.
--
-- A version string on a computation row is a label until it resolves to a row saying what that
-- version WAS. Registered once and never edited: two runs claiming one version and producing
-- different answers is precisely what this exists to make impossible.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS hgov_engine_version (
  version TEXT PRIMARY KEY,
  engine_id TEXT NOT NULL,
  engine_class TEXT NOT NULL,
  method TEXT NOT NULL,
  params_digest TEXT,
  notes TEXT,
  registered_by UUID,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hgov_engine_version_engine_idx
  ON hgov_engine_version (engine_id, activated_at DESC);

-- ============================================================================================
-- hgov_retention_policy — HOW LONG, AND WHAT HAPPENS THEN.
--
-- owner_module is recorded on every row. A class this layer does not own is REPORTED and never
-- swept: the due count is shown so somebody can see it, and the removal is the owning patch's to do.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS hgov_retention_policy (
  record_class TEXT PRIMARY KEY,
  owner_module TEXT NOT NULL,
  data_class TEXT NOT NULL,
  retain_days INT NOT NULL,
  action TEXT NOT NULL,
  basis TEXT NOT NULL,
  overridden_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================================
-- hgov_erasure_request — THE DELETION / ANONYMISATION WORKFLOW.
--
-- Two named humans, never one: requested_by and approved_by, and approveErasure() refuses them
-- being the same person with no setting that turns that off.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS hgov_erasure_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id TEXT NOT NULL DEFAULT 'org_edurankai',
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_scheme TEXT NOT NULL DEFAULT 'employee',
  action TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_by UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hgov_erasure_subject_idx
  ON hgov_erasure_request (organisation_id, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hgov_erasure_status_idx
  ON hgov_erasure_request (status, created_at DESC)
`;

/**
 * Create the four tables this layer owns. Idempotent, memoised per process, and it swallows its own
 * failure the way every other bootstrap here does — a missing table costs a screen that reports
 * nothing, never a page that will not load. ensureOnce logs the real Postgres reason (e.cause).
 *
 * Honours SCHEMA_BOOTSTRAP, which now defaults to OFF in production. On the live database these
 * tables appear only when somebody runs db/horizon-governance-schema.sql by hand.
 */
export function ensureGovernanceSchema(): Promise<void> {
  return ensureBatch(GOVERNANCE_SCHEMA_KEY, DDL);
}

/** The tables this module owns. Nothing else in this layer may create or drop a table. */
export const GOVERNANCE_TABLES: readonly string[] = Object.freeze([
  'hgov_decision_log',
  'hgov_engine_version',
  'hgov_retention_policy',
  'hgov_erasure_request',
]);
