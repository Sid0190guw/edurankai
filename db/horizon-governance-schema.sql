-- db/horizon-governance-schema.sql
-- PATCH 17 — HORIZON governance, security and audit. The four tables this layer owns.
--
-- IT OWNS FOUR AND NO MORE. Consent, the access log, computations, feedback and recomputation all
-- already have owners in db/ and in src/lib/horizon/schema.ts (the hzn_* tables). This layer reads
-- those and writes none of them.
--
-- WHY THIS FILE EXISTS AS WELL AS THE BOOTSTRAP IN CODE.
--
-- src/lib/horizon/governance/schema.ts creates all of this through ensureBatch(), the same way every
-- other table on this project is created. But SCHEMA_BOOTSTRAP now defaults to OFF in production --
-- see the note at the top of src/lib/ensure-once.ts, written after request-time DDL took the site
-- down on 2026-08-23. So on the live database the bootstrap is a no-op and these tables will not
-- appear on their own.
--
-- RUN THIS ONCE, BY HAND, AGAINST PRODUCTION. That is the established pattern here for anything that
-- touches the live database. Nothing in the application does it for you, and nothing breaks while it
-- is missing: every read in the layer tolerates an absent table and reports no rows, and every gate
-- fails closed, so the governance console says "not installed" rather than serving a broken page.
--
-- It is idempotent. Running it twice does nothing the second time.
--
-- Kept byte-for-byte in step with the DDL in schema.ts by
-- src/lib/horizon/governance/schema-sync.test.ts. Edit schema.ts and regenerate; never edit the
-- generated block below on its own, or the live database and the bootstrap drift apart with nothing
-- to say so.
-- >>> BEGIN GENERATED DDL <<<
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
  ON hgov_erasure_request (status, created_at DESC);
