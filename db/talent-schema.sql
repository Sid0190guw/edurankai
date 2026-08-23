-- ================================================================================================
-- db/talent-schema.sql -- THE tal_* TABLES, AS A FILE YOU CAN RUN
--
-- WHO RUNS THIS: the founder, ONCE, BEFORE the talent surfaces are deployed or opened to traffic.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase touched the database.
--
-- HOW TO RUN IT (Supabase SQL editor, or psql against the transaction pooler):
--     \i db/talent-schema.sql
--
-- ================================================================================================
-- WHY THIS FILE EXISTS, AND WHY IT MATTERS MORE THAN THE USUAL "readable mirror" ARGUMENT.
--
-- These tables are created by src/lib/talent/schema.ts at RUNTIME, on the first request that needs
-- them. That bootstrap is 99 statements, each its own network round trip. A round trip to this
-- database measures ~135ms from the Mumbai region, so a cold run costs north of eleven seconds --
-- past the gateway timeout, while holding a transaction-pooler session for the whole of it. A deploy
-- makes every serverless instance cold at the same moment, so they all attempt it together and
-- contend on the same tables.
--
-- That is not hypothetical on this project. It is the outage recorded in the commits
-- "Send each schema bootstrap as one message instead of thirty-seven" and "Stop a schema bootstrap
-- from locking a table for as long as it likes".
--
-- Running this file first means the tables already exist when the code arrives. schema.ts now checks
-- a sentinel (the last object it creates) in ONE round trip and returns immediately when it is
-- there, so the 99-statement path never runs in front of a waiting applicant.
--
-- ================================================================================================
-- IT IS IDEMPOTENT. Every statement is CREATE ... IF NOT EXISTS or ADD COLUMN IF NOT EXISTS, so
-- running it twice changes nothing, and running it on a database where the app already bootstrapped
-- is a no-op.
--
-- IT IS TRANSCRIBED, NOT REWRITTEN. Same statements, same order, from src/lib/talent/schema.ts.
-- If you change one, change both -- a table that exists in one and not the other is the defect that
-- db/hr-schema.sql:300 already documents on this codebase.
--
-- ================================================================================================
-- THE SECOND HALF TOUCHES TABLES THIS SYSTEM DOES NOT OWN.
--
-- `applications`, `roles`, `departments` and `org_positions` carry live production rows and are read
-- by pages that have nothing to do with recruitment. Every statement against them is ADD COLUMN IF
-- NOT EXISTS and nothing else: nothing drops, renames or retypes a column another module reads.
--
-- Run it in a quiet window anyway. ALTER TABLE takes its ACCESS EXCLUSIVE lock BEFORE it evaluates
-- IF NOT EXISTS, and a pending exclusive lock queues AHEAD of readers.
-- ================================================================================================


-- Give up rather than queue. Every statement below is a no-op on a database that already has these
-- objects, but a lock wait is not free, and a bootstrap that queues behind a long read is how a
-- schema change becomes an empty connection pool.
SET lock_timeout = '3s';
SET statement_timeout = '60s';


-- ================================================================================================
-- PART 1 -- THE tal_* CORE (src/lib/talent/schema.ts :: ensureTalentSchema)
-- ================================================================================================

SELECT to_regclass(${'public.' + SENTINEL}) IS NOT NULL AS present;
CREATE TABLE IF NOT EXISTS tal_person (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_code    TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  preferred_name TEXT,
  primary_email  TEXT,
  primary_phone  TEXT,
  country        TEXT,
  merged_into_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_person_email_idx ON tal_person (lower(primary_email));
CREATE INDEX IF NOT EXISTS tal_person_merged_idx ON tal_person (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tal_person_identifier (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID NOT NULL,
  kind        TEXT NOT NULL,
  value_norm  TEXT NOT NULL,
  source_id   UUID,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_person_ident_uq
ON tal_person_identifier (kind, value_norm, person_id);
CREATE INDEX IF NOT EXISTS tal_person_ident_lookup
ON tal_person_identifier (kind, value_norm);
CREATE TABLE IF NOT EXISTS tal_person_merge (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keep_person_id  UUID NOT NULL,
  merge_person_id UUID NOT NULL,
  confidence      NUMERIC(4,3),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'proposed',
  decided_by      UUID,
  decided_at      TIMESTAMPTZ,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_person_merge_status_idx
ON tal_person_merge (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS tal_person_merge_open_uq
ON tal_person_merge (keep_person_id, merge_person_id) WHERE status = 'proposed';
CREATE TABLE IF NOT EXISTS tal_candidate_profile (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL UNIQUE,
  candidate_code TEXT NOT NULL UNIQUE,
  headline       TEXT,
  education      JSONB NOT NULL DEFAULT '[]'::jsonb,
  experience     JSONB NOT NULL DEFAULT '[]'::jsonb,
  skills         JSONB NOT NULL DEFAULT '[]'::jsonb,
  portfolio_url  TEXT,
  talent_pool    BOOLEAN NOT NULL DEFAULT FALSE,
  consent_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tal_id_series (
  series     TEXT PRIMARY KEY,
  period     TEXT NOT NULL DEFAULT '',
  next_value BIGINT NOT NULL DEFAULT 1,
  pad_width  INT NOT NULL DEFAULT 6,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tal_id_series ADD COLUMN IF NOT EXISTS period TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS tal_recruitment_source (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',
  ingest_mode TEXT NOT NULL DEFAULT 'manual',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tal_source_key (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  UUID NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  scopes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  revoked_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_source_key_prefix_uq ON tal_source_key (key_prefix);
CREATE TABLE IF NOT EXISTS tal_external_application_ref (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id               UUID NOT NULL,
  external_application_id TEXT NOT NULL,
  application_id          UUID,
  person_id               UUID,
  raw_payload             JSONB,
  ingested_by             UUID,
  ingested_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_ext_app_uq
ON tal_external_application_ref (source_id, external_application_id);
CREATE INDEX IF NOT EXISTS tal_ext_app_person_idx
ON tal_external_application_ref (person_id);
CREATE TABLE IF NOT EXISTS tal_ingest_quarantine (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID,
  reason      TEXT NOT NULL,
  raw_payload JSONB,
  replayed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tal_pipeline (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  version    INT NOT NULL DEFAULT 1,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_pipeline_slug_ver_uq ON tal_pipeline (slug, version);
CREATE TABLE IF NOT EXISTS tal_pipeline_stage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id     UUID NOT NULL,
  ordinal         INT NOT NULL,
  key             TEXT NOT NULL,
  label           TEXT NOT NULL,
  candidate_blurb TEXT NOT NULL,
  stage_type      TEXT NOT NULL,
  owner_role      TEXT,
  sla_hours       INT,
  is_terminal     BOOLEAN NOT NULL DEFAULT FALSE,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_pipeline_stage_uq ON tal_pipeline_stage (pipeline_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS tal_pipeline_stage_key_uq ON tal_pipeline_stage (pipeline_id, key);
CREATE TABLE IF NOT EXISTS tal_opportunity (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_code            TEXT NOT NULL UNIQUE,
  position_id                 UUID,
  department_id               TEXT NOT NULL,
  role_id                     UUID,
  title                       TEXT NOT NULL,
  employment_type             TEXT NOT NULL,
  level                       TEXT,
  headcount                   INT,
  eligible_identity_types     JSONB NOT NULL DEFAULT '[]'::jsonb,
  internal_visible_to_manager BOOLEAN NOT NULL DEFAULT FALSE,
  pipeline_id                 UUID NOT NULL,
  pipeline_version            INT NOT NULL DEFAULT 1,
  hiring_manager_id           UUID,
  compensation_kind           TEXT NOT NULL DEFAULT 'unpaid',
  compensation_note           TEXT,
  onboarding_pack             TEXT,
  status                      TEXT NOT NULL DEFAULT 'draft',
  deadline_at                 TIMESTAMPTZ,
  published_at                TIMESTAMPTZ,
  closed_at                   TIMESTAMPTZ,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_opp_status_idx ON tal_opportunity (status, deadline_at);
CREATE INDEX IF NOT EXISTS tal_opp_dept_idx ON tal_opportunity (department_id, status);
CREATE INDEX IF NOT EXISTS tal_opp_hm_idx ON tal_opportunity (hiring_manager_id, status);
CREATE TABLE IF NOT EXISTS tal_opportunity_evaluator (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL,
  user_id        UUID NOT NULL,
  assign_role    TEXT NOT NULL DEFAULT 'evaluator',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_opp_eval_uq
ON tal_opportunity_evaluator (opportunity_id, user_id, assign_role);
CREATE TABLE IF NOT EXISTS tal_application (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_code      TEXT NOT NULL UNIQUE,
  person_id             UUID NOT NULL,
  opportunity_id        UUID NOT NULL,
  legacy_application_id UUID,
  source_id             UUID,
  status                TEXT NOT NULL DEFAULT 'application_received',
  current_stage_key     TEXT,
  pipeline_id           UUID NOT NULL,
  pipeline_version      INT NOT NULL DEFAULT 1,
  is_internal           BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_app_person_opp_uq
ON tal_application (person_id, opportunity_id);
CREATE INDEX IF NOT EXISTS tal_app_status_idx ON tal_application (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS tal_app_opp_idx ON tal_application (opportunity_id, status);
CREATE INDEX IF NOT EXISTS tal_app_legacy_idx ON tal_application (legacy_application_id);
CREATE TABLE IF NOT EXISTS tal_application_stage (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  stage_key      TEXT NOT NULL,
  ordinal        INT NOT NULL,
  entered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at         TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  outcome        TEXT,
  owner_user_id  UUID,
  note           TEXT,
  actor_user_id  UUID
);
CREATE INDEX IF NOT EXISTS tal_app_stage_idx ON tal_application_stage (application_id, ordinal);
CREATE INDEX IF NOT EXISTS tal_app_stage_sla_idx
ON tal_application_stage (due_at) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS tal_evaluation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    UUID NOT NULL,
  stage_key         TEXT NOT NULL,
  evaluation_type   TEXT NOT NULL,
  evaluator_user_id UUID,
  rubric            JSONB NOT NULL DEFAULT '{}'::jsonb,
  scores            JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_score       NUMERIC(6,2),
  recommendation    TEXT,
  comments          TEXT,
  is_automated      BOOLEAN NOT NULL DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'pending',
  submitted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_eval_app_idx ON tal_evaluation (application_id, evaluation_type);
CREATE INDEX IF NOT EXISTS tal_eval_pending_idx ON tal_evaluation (status, evaluator_user_id);
CREATE TABLE IF NOT EXISTS tal_interview (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL,
  stage_key        TEXT NOT NULL,
  scheduled_at     TIMESTAMPTZ,
  duration_minutes INT,
  mode             TEXT,
  panel            JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome          TEXT,
  notes            TEXT,
  recorded_by      UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_interview_app_idx ON tal_interview (application_id);
CREATE INDEX IF NOT EXISTS tal_interview_pending_idx
ON tal_interview (scheduled_at) WHERE outcome IS NULL;
CREATE TABLE IF NOT EXISTS tal_selection_decision (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_code            TEXT NOT NULL UNIQUE,
  application_id            UUID NOT NULL UNIQUE,
  person_id                 UUID NOT NULL,
  opportunity_id            UUID NOT NULL,
  decision                  TEXT NOT NULL,
  reason                    TEXT NOT NULL,
  decided_by_user_id        UUID NOT NULL,
  decided_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  position_id               UUID,
  department_id             TEXT,
  employment_type           TEXT,
  level                     TEXT,
  reporting_manager_user_id UUID,
  proposed_joining_date     DATE,
  compensation_note         TEXT,
  approved_for_onboarding_at TIMESTAMPTZ,
  approved_for_onboarding_by UUID,
  withdrawn_at              TIMESTAMPTZ,
  withdrawn_reason          TEXT
);
CREATE INDEX IF NOT EXISTS tal_sel_decision_idx ON tal_selection_decision (decision, decided_at DESC);
CREATE INDEX IF NOT EXISTS tal_sel_person_idx ON tal_selection_decision (person_id);
CREATE TABLE IF NOT EXISTS tal_onboarding_code (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id             TEXT NOT NULL UNIQUE,
  code_prefix         TEXT NOT NULL,
  code_hash           TEXT NOT NULL,
  selection_id        UUID NOT NULL,
  person_id           UUID NOT NULL,
  bound_email_norm    TEXT NOT NULL,
  opportunity_id      UUID NOT NULL,
  position_id         UUID,
  department_id       TEXT,
  employment_type     TEXT,
  max_uses            INT NOT NULL DEFAULT 1,
  used_count          INT NOT NULL DEFAULT 0,
  requires_identity_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until         TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  multi_use_reason    TEXT,
  issued_by           UUID NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  delivery_channel    TEXT,
  delivery_error      TEXT,
  revoked_by          UUID,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT,
  supersedes_code_id  UUID,
  failed_attempts     INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_onbcode_active_uq
ON tal_onboarding_code (selection_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS tal_onbcode_expiry_idx ON tal_onboarding_code (status, valid_until);
CREATE INDEX IF NOT EXISTS tal_onbcode_prefix_idx ON tal_onboarding_code (code_prefix);
CREATE TABLE IF NOT EXISTS tal_onboarding_code_attempt (
  id           BIGSERIAL PRIMARY KEY,
  code_id      UUID,
  code_prefix  TEXT,
  outcome      TEXT NOT NULL,
  ip_address   TEXT,
  user_agent   TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_onbattempt_ip_idx
ON tal_onboarding_code_attempt (ip_address, attempted_at DESC);
CREATE INDEX IF NOT EXISTS tal_onbattempt_code_idx
ON tal_onboarding_code_attempt (code_id, attempted_at DESC);
CREATE TABLE IF NOT EXISTS tal_onboarding_application (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_code_id  UUID NOT NULL,
  onboarding_code_ref TEXT NOT NULL,
  selection_id        UUID NOT NULL,
  person_id           UUID NOT NULL,
  status              TEXT NOT NULL DEFAULT 'in_progress',
  form_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  sections_complete   JSONB NOT NULL DEFAULT '[]'::jsonb,
  declarations        JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at        TIMESTAMPTZ,
  reviewed_by         UUID,
  reviewed_at         TIMESTAMPTZ,
  review_note         TEXT,
  approved_at         TIMESTAMPTZ,
  identity_id         UUID,
  session_token_hash  TEXT,
  session_expires_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_onbapp_selection_uq ON tal_onboarding_application (selection_id);
CREATE INDEX IF NOT EXISTS tal_onbapp_status_idx ON tal_onboarding_application (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS tal_onbapp_session_idx
ON tal_onboarding_application (session_token_hash) WHERE session_token_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS tal_document_ref (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind TEXT NOT NULL,
  subject_id   UUID NOT NULL,
  person_id    UUID NOT NULL,
  doc_type     TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  drive_url    TEXT NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  status       TEXT NOT NULL DEFAULT 'submitted',
  version      INT NOT NULL DEFAULT 1,
  replaces_id  UUID,
  expires_on   DATE,
  review_note  TEXT,
  reviewed_by  UUID,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_docref_subject_idx
ON tal_document_ref (subject_kind, subject_id, status);
CREATE INDEX IF NOT EXISTS tal_docref_person_idx ON tal_document_ref (person_id);
CREATE INDEX IF NOT EXISTS tal_docref_expiry_idx
ON tal_document_ref (expires_on) WHERE expires_on IS NOT NULL;
CREATE TABLE IF NOT EXISTS tal_identity (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_code             TEXT NOT NULL UNIQUE,
  code_series               TEXT NOT NULL,
  code_is_legacy            BOOLEAN NOT NULL DEFAULT FALSE,
  person_id                 UUID NOT NULL,
  identity_type             TEXT NOT NULL,
  employment_type           TEXT,
  user_id                   UUID,
  hr_employee_id            UUID,
  username                  TEXT,
  work_email                TEXT,
  department_id             TEXT,
  position_id               UUID,
  status                    TEXT NOT NULL DEFAULT 'invited_for_onboarding',
  start_date                DATE,
  end_date                  DATE,
  onboarding_application_id UUID,
  selection_id              UUID,
  previous_identity_id      UUID,
  status_reason             TEXT,
  created_by                UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_identity_person_idx ON tal_identity (person_id);
CREATE INDEX IF NOT EXISTS tal_identity_status_idx ON tal_identity (status, identity_type);
CREATE INDEX IF NOT EXISTS tal_identity_dept_idx ON tal_identity (department_id, status);
CREATE INDEX IF NOT EXISTS tal_identity_hr_idx ON tal_identity (hr_employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS tal_identity_user_active_uq
ON tal_identity (user_id) WHERE status = 'active' AND user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tal_access_group (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  department_id  TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  capabilities   JSONB NOT NULL DEFAULT '[]'::jsonb,
  systems        JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tal_access_policy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    TEXT NOT NULL,
  subject_key     TEXT NOT NULL,
  access_group_id UUID NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  changed_by      UUID,
  change_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_access_policy_subj_idx
ON tal_access_policy (subject_kind, subject_key, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS tal_access_policy_uq
ON tal_access_policy (subject_kind, subject_key, access_group_id) WHERE is_active;
CREATE TABLE IF NOT EXISTS tal_identity_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id     UUID NOT NULL,
  access_group_id UUID NOT NULL,
  source          TEXT NOT NULL,
  granted_by      UUID,
  reason          TEXT,
  valid_until     TIMESTAMPTZ,
  policy_version  INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tal_identity_access_uq
ON tal_identity_access (identity_id, access_group_id, source);
CREATE INDEX IF NOT EXISTS tal_identity_access_expiry
ON tal_identity_access (valid_until) WHERE valid_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS tal_access_request (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id         UUID NOT NULL,
  access_group_id     UUID NOT NULL,
  reason              TEXT NOT NULL,
  requested_until     TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending',
  manager_decision    JSONB,
  department_decision JSONB,
  security_decision   JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tal_access_request_idx
ON tal_access_request (status, created_at DESC);
CREATE TABLE IF NOT EXISTS tal_provisioning_run (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id  UUID NOT NULL,
  trigger      TEXT NOT NULL,
  proposed     JSONB NOT NULL DEFAULT '[]'::jsonb,
  diff         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'proposed',
  reviewed_by  UUID,
  reviewed_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failures     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tal_prov_run_idx
ON tal_provisioning_run (status, created_at DESC);
CREATE INDEX IF NOT EXISTS tal_prov_identity_idx
ON tal_provisioning_run (identity_id, created_at DESC);
CREATE TABLE IF NOT EXISTS tal_event (
  id            BIGSERIAL PRIMARY KEY,
  event_name    TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  subject_id    UUID,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS tal_event_undelivered_idx
ON tal_event (delivered_at, id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS tal_event_subject_idx
ON tal_event (subject_kind, subject_id, occurred_at DESC);
SELECT EXISTS (
SELECT 1 FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'org_positions'
   AND column_name = 'onboarding_pack') AS present;


-- ================================================================================================
-- PART 2 -- THE BRIDGE (src/lib/talent/schema.ts :: ensureTalentBridge)
--
-- Additive columns on tables this system does NOT own. See the header before running.
-- ================================================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS person_id UUID;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS tal_application_id UUID;
CREATE INDEX IF NOT EXISTS applications_person_idx ON applications (person_id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS position_id UUID;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS opportunity_id UUID;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS parent_department_id VARCHAR(50);
CREATE TABLE IF NOT EXISTS org_positions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  code          TEXT,
  department_id TEXT,
  team_id       UUID,
  grade         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_positions_code_uq
ON org_positions (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_positions_dept_idx ON org_positions (department_id, is_active);
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS employment_type TEXT;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS is_sensitive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS headcount INT;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS competencies JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS default_pipeline_id UUID;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS onboarding_pack TEXT;


-- ================================================================================================
-- AFTER RUNNING THIS
--
-- 1. Confirm the sentinel exists -- src/lib/talent/schema.ts checks exactly this, and its presence
--    is what makes the runtime bootstrap a single round trip instead of ninety-nine:
--
--       SELECT to_regclass('public.tal_event_subject_idx') IS NOT NULL AS core_ready,
--              EXISTS (SELECT 1 FROM information_schema.columns
--                       WHERE table_schema='public' AND table_name='org_positions'
--                         AND column_name='onboarding_pack') AS bridge_ready;
--
--    Both columns must be true. If either is false, some statement above did not commit -- read the
--    error, fix it, and run the file again. It is idempotent.
--
-- 2. Count what was created:
--
--       SELECT count(*) FROM information_schema.tables
--        WHERE table_schema='public' AND table_name LIKE 'tal\_%';
--
-- 3. Only then deploy the talent surfaces.
-- ================================================================================================

