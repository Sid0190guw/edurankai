-- ================================================================================================
-- db/talent-os-schema.sql — THE TALENT OPERATING SYSTEM (tos_*) TABLES
--
-- WHO RUNS THIS: the founder, once, before db/talent-os-backfill.sql.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase touched the database.
--
-- This file is the readable mirror of src/lib/talentos/schema.ts. The TypeScript version runs the
-- same statements automatically the first time any consumer calls into src/lib/talentos/*, so on a
-- fresh environment nobody has to run anything. This file exists because reading DDL inside a
-- TypeScript template string is miserable, and because the founder should be able to create the
-- tables deliberately and read exactly what was created.
--
-- BOTH ARE IDEMPOTENT AND THEY DO NOT CONFLICT. Running this and then letting the app bootstrap, or
-- the reverse, produces the same schema. Every statement is CREATE ... IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS.
--
-- HOW TO RUN IT (Supabase SQL editor, or psql against the transaction pooler):
--     \i db/talent-os-schema.sql
--
-- The specification these tables implement is docs/talent-os-spec.md. Section 4 of that document is
-- the normative source; this file must not drift from it.
--
-- ================================================================================================
-- WHY "CREATE TABLE IF NOT EXISTS" IS NOT ENOUGH, AND WHY EVERY COLUMN IS ASSERTED AGAIN BELOW IT.
--
-- CREATE TABLE IF NOT EXISTS is a no-op on an existing table, INCLUDING one that is missing columns.
-- That is exactly how hr_employees.work_email came to be declared in db/hr-schema.sql and absent
-- from the live table, which locked every administrator out of /admin. So every column past the
-- primary key is asserted again with ADD COLUMN IF NOT EXISTS.
--
-- ================================================================================================
-- THE DEPARTMENT ID TRAP. Read this before adding any column that references a department.
--
--   departments.id is varchar(50) — a SLUG ('hr', 'ai', 'product') — in src/lib/db/schema.ts:80
--   departments.id is UUID                                          in db/hr-schema.sql:31
--
-- Every department reference in this file is therefore TEXT and is NEVER cast to ::uuid. A ::uuid
-- cast throws "invalid input syntax for type uuid" the first time a slug arrives. The same trap is
-- documented in db/org-graph-schema.sql; this file inherits the same rule for the same reason.
--
-- ================================================================================================
-- NO CHECK CONSTRAINTS ON ENUM-LIKE COLUMNS, DELIBERATELY. This project has no migration runner —
-- only CREATE/ADD IF NOT EXISTS. A CHECK constraint would have to be dropped and recreated by hand
-- to add one new value to a vocabulary, which is precisely the operation nobody performs safely at
-- 2am. The vocabularies are enforced in TypeScript (src/lib/talentos/vocab.ts) and audited by
-- db/talent-os-validate.sql. That trade is stated rather than assumed away.
--
-- The CHECK constraints that DO appear below are structural invariants (a date range that runs
-- backwards, a slot number outside 1..7), not vocabularies. Those never need extending.
-- ================================================================================================


-- ================================================================================================
-- 1. PERSON AND ORGANIZATIONAL IDENTITY
-- ================================================================================================

-- ------------------------------------------------------------------------------------------------
-- tos_person — ONE HUMAN, durable across every application, selection and engagement they have.
--
-- WHAT THIS IS NOT, because all three mistakes are already present in this codebase's history:
--   - NOT a users row. users is an AUTHENTICATION ACCOUNT. A person may have none (an external
--     candidate who applied before creating one) or exactly one.
--   - NOT an hr_employees row. That is one ENGAGEMENT, and a person may have several over time.
--   - NOT an email address. Addresses change; people do not.
--
-- merged_into_id, not DELETE. When two rows turn out to be one human the loser keeps its row and
-- points at the winner, so every historical reference still resolves. Reads either filter
-- merged_into_id IS NULL or follow the pointer.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_person (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_code       TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  primary_email     TEXT NOT NULL,
  phone             TEXT,
  user_id           UUID,
  merged_into_id    UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS person_code    TEXT;
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS display_name   TEXT;
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS primary_email  TEXT;
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS phone          TEXT;
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS user_id        UUID;
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS merged_into_id UUID;
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_person ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- One live person per auth account. Merged-away rows are excluded so a merge does not violate it.
CREATE UNIQUE INDEX IF NOT EXISTS tos_person_user_idx
  ON tos_person (user_id) WHERE user_id IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS tos_person_email_idx ON tos_person (lower(primary_email));
CREATE INDEX IF NOT EXISTS tos_person_merged_idx ON tos_person (merged_into_id)
  WHERE merged_into_id IS NOT NULL;


-- ------------------------------------------------------------------------------------------------
-- tos_person_email — every address that has ever belonged to this person.
--
-- THIS IS THE RESOLUTION KEY (docs/talent-os-spec.md section 5.3). Resolution matches on a VERIFIED
-- address, never on name, phone or date of birth: those collide, and splitting one person into two
-- is far cheaper to fix than merging two people who were never the same.
--
-- is_official marks an @edurankai.in address. It is a DISPLAY AND AUTHENTICATION FACT AND NOTHING
-- MORE. No query may derive authorization from it — see tos_identity and section 5.7 of the spec.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_person_email (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL,
  email          TEXT NOT NULL,
  is_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  is_official    BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_person_email ADD COLUMN IF NOT EXISTS person_id   UUID;
ALTER TABLE tos_person_email ADD COLUMN IF NOT EXISTS email       TEXT;
ALTER TABLE tos_person_email ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_person_email ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_person_email ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE tos_person_email ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS tos_person_email_uq ON tos_person_email (lower(email));
CREATE INDEX IF NOT EXISTS tos_person_email_person_idx ON tos_person_email (person_id);


-- ------------------------------------------------------------------------------------------------
-- tos_identity — THE IDENTITY REGISTRY.
--
-- An organizational identity is a GRANT WITH A LIFETIME. It is not an attribute of the person and
-- it is emphatically not an attribute of an email address.
--
-- identity_type vocabulary (TypeScript-enforced, see src/lib/talentos/vocab.ts):
--   EMPLOYEE, INTERN, FELLOW, MEMBER, CAMPUS_AMBASSADOR, CONTRACTOR, CONSULTANT,
--   OTHER_AUTHORIZED_IDENTITY
--
-- EMPLOYMENT-BACKED vs NOT. EMPLOYEE and INTERN identities carry employee_id referencing an
-- hr_employees row, created through the existing completeHire() in src/lib/hire-completion.ts.
-- Every other type MUST NOT create an hr_employees row. A fellow is not payroll.
--
-- status is the authorization-bearing column: pending | active | suspended | expired | terminated.
-- Only 'active' authorises anything, anywhere.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_identity (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id            UUID NOT NULL,
  identity_code        TEXT NOT NULL UNIQUE,
  identity_type        TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  is_primary           BOOLEAN NOT NULL DEFAULT FALSE,
  employee_id          UUID,
  user_id              UUID,
  official_email       TEXT,
  department_id        TEXT,
  position_id          UUID,
  team_id              UUID,
  engagement_type      TEXT,
  started_on           DATE,
  ended_on             DATE,
  source_onboarding_id UUID,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS person_id            UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS identity_code        TEXT;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS identity_type        TEXT;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS status               TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS is_primary           BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS employee_id          UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS user_id              UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS official_email       TEXT;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS department_id        TEXT;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS position_id          UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS team_id              UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS engagement_type      TEXT;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS started_on           DATE;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS ended_on             DATE;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS source_onboarding_id UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS created_by           UUID;
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_identity ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_identity_person_idx ON tos_identity (person_id, status);
CREATE INDEX IF NOT EXISTS tos_identity_employee_idx ON tos_identity (employee_id)
  WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tos_identity_user_idx ON tos_identity (user_id, status)
  WHERE user_id IS NOT NULL;

-- "ONE PERSON ... ONE CURRENT ORGANIZATIONAL IDENTITY" enforced by the DATABASE, not by code.
-- An internal transfer closes the old identity (ended_on set, status moved off 'active') before the
-- new one becomes primary; this index makes an overlapping second primary impossible rather than
-- merely discouraged.
CREATE UNIQUE INDEX IF NOT EXISTS tos_identity_one_primary
  ON tos_identity (person_id) WHERE is_primary AND status = 'active';


-- ================================================================================================
-- 2. OPPORTUNITY CONFIGURATION
--
-- roles stays the catalogue that /careers already renders. Configuration lives in a 1:1 SIDE TABLE
-- so that no page which already reads roles has to change, and so this config can grow without
-- touching the Drizzle schema every time.
-- ================================================================================================

CREATE TABLE IF NOT EXISTS tos_opportunity (
  role_id                   UUID PRIMARY KEY,
  opportunity_code          TEXT NOT NULL UNIQUE,
  pipeline_id               UUID,
  requisition_id            UUID,

  is_public                 BOOLEAN NOT NULL DEFAULT TRUE,
  applications_open         BOOLEAN NOT NULL DEFAULT TRUE,
  opens_at                  TIMESTAMPTZ,
  closes_at                 TIMESTAMPTZ,

  external_eligible         BOOLEAN NOT NULL DEFAULT TRUE,
  internal_eligible         BOOLEAN NOT NULL DEFAULT TRUE,
  internal_identity_types   TEXT[] NOT NULL DEFAULT '{}',
  min_tenure_days           INT,
  requires_manager_consent  BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_rules         JSONB NOT NULL DEFAULT '[]'::jsonb,

  requires_seven_stage      BOOLEAN NOT NULL DEFAULT TRUE,
  waiver_policy             TEXT NOT NULL DEFAULT 'none',

  code_validity_days        INT NOT NULL DEFAULT 21,
  code_multi_use            BOOLEAN NOT NULL DEFAULT FALSE,

  onboarding_pack_key       TEXT,
  required_document_types   TEXT[] NOT NULL DEFAULT '{}',
  access_profile_id         UUID,

  hiring_manager_user_id    UUID,
  reporting_manager_user_id UUID,
  evaluator_user_ids        UUID[] NOT NULL DEFAULT '{}',

  first_application_at      TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  cancelled_reason          TEXT,
  cancelled_by_user_id      UUID,
  created_by                UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Set the first time an application arrives against this opportunity. From that moment the
-- configuration that would change the process a candidate is already inside is SEALED.
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS first_application_at      TIMESTAMPTZ;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS cancelled_at              TIMESTAMPTZ;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS cancelled_reason          TEXT;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS cancelled_by_user_id      UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS opportunity_code          TEXT;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS pipeline_id               UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS requisition_id            UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS is_public                 BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS applications_open         BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS opens_at                  TIMESTAMPTZ;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS closes_at                 TIMESTAMPTZ;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS external_eligible         BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS internal_eligible         BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS internal_identity_types   TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS min_tenure_days           INT;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS requires_manager_consent  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS eligibility_rules         JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS requires_seven_stage      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS waiver_policy             TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS code_validity_days        INT NOT NULL DEFAULT 21;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS code_multi_use            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS onboarding_pack_key       TEXT;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS required_document_types   TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS access_profile_id         UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS hiring_manager_user_id    UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS reporting_manager_user_id UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS evaluator_user_ids        UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS created_by                UUID;
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_opportunity ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_opportunity_open_idx
  ON tos_opportunity (applications_open, closes_at);


-- ------------------------------------------------------------------------------------------------
-- tos_application_link — the facts the existing applications table cannot carry.
--
-- applications is NOT restructured. It has ~60 columns, four indexes and a dozen readers across
-- /apply, /portal and /admin. One join table carries person, opportunity, pathway and applicant
-- type instead.
--
-- pathway is the whole point of this system: 'recruitment' means the person is entering the
-- seven-stage evaluation; 'direct_onboarding' means they arrived holding a valid authorization code
-- and are completing the formal onboarding record. The word "apply" means different things in the
-- two cases and the interface must say which.
--
-- pinned_pipeline_id: an application is evaluated against the pipeline that was in force WHEN IT
-- WAS CREATED. Changing an opportunity's pipeline must never retroactively rewrite the process a
-- candidate is already halfway through.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_application_link (
  application_id        UUID PRIMARY KEY,
  person_id             UUID NOT NULL,
  opportunity_role_id   UUID NOT NULL,
  pathway               TEXT NOT NULL,
  applicant_type        TEXT NOT NULL,
  applicant_identity_id UUID,
  pipeline_id           UUID,
  pipeline_revision     INT,
  pipeline_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
  pinned_at             TIMESTAMPTZ,
  source_slug           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS person_id             UUID;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS opportunity_role_id   UUID;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pathway               TEXT;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS applicant_type        TEXT;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS applicant_identity_id UUID;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pipeline_id           UUID;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pipeline_revision     INT;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pipeline_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pinned_at             TIMESTAMPTZ;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS source_slug           TEXT;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_app_link_person_idx
  ON tos_application_link (person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_app_link_opp_idx
  ON tos_application_link (opportunity_role_id);
-- An application that never got a pinned pipeline MUST NOT advance past slot 1. This is the index
-- behind the diagnostics list that finds them, so they are repaired rather than lost.
CREATE INDEX IF NOT EXISTS tos_app_link_unpinned_idx
  ON tos_application_link (opportunity_role_id) WHERE pinned_at IS NULL;


-- ================================================================================================
-- 3. THE SEVEN-STAGE EVALUATION FRAMEWORK
--
-- SEVEN FIXED SLOTS ARE THE FRAMEWORK. What occupies each slot is what an administrator configures.
-- That is how "the exact seven stages must be configurable by Admin" and "conforming to the
-- EduRankAI seven-stage evaluation framework" are both true at once: slot_no is structural, and
-- label / kind / instrument / pass rule / evaluators are data.
--
-- A slot a role does not need is 'skipped', never deleted, so the audit trail shows seven slots for
-- every candidate who ever entered the process.
-- ================================================================================================

CREATE TABLE IF NOT EXISTS tos_pipeline (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  revision     INT NOT NULL DEFAULT 1,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Bumped by any edit to any of this pipeline's stage rows. It is the cheap "is this application on
-- the current process" test for the admin list; the per-application snapshot is the authority.
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS revision    INT NOT NULL DEFAULT 1;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS key         TEXT;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS name        TEXT;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS is_default  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS is_active   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS created_by  UUID;
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_pipeline ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Exactly one default pipeline, enforced rather than assumed.
CREATE UNIQUE INDEX IF NOT EXISTS tos_pipeline_one_default
  ON tos_pipeline ((is_default)) WHERE is_default;


CREATE TABLE IF NOT EXISTS tos_pipeline_stage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id       UUID NOT NULL,
  slot_no           INT NOT NULL,
  label             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  is_required       BOOLEAN NOT NULL DEFAULT TRUE,
  weight            INT NOT NULL DEFAULT 0,
  pass_rule         JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluator_rule    JSONB NOT NULL DEFAULT '{}'::jsonb,
  sla_days          INT,
  instrument_ref    TEXT,
  candidate_blurb   TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tos_pipeline_stage_slot_range CHECK (slot_no BETWEEN 1 AND 7)
);
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS pipeline_id     UUID;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS slot_no         INT;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS label           TEXT;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS kind            TEXT;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS is_required     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS weight          INT NOT NULL DEFAULT 0;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS pass_rule       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS evaluator_rule  JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS sla_days        INT;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS instrument_ref  TEXT;
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS candidate_blurb TEXT NOT NULL DEFAULT '';
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_pipeline_stage ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS tos_pipeline_stage_slot_uq
  ON tos_pipeline_stage (pipeline_id, slot_no);


-- ------------------------------------------------------------------------------------------------
-- tos_stage_run — one application's passage through one slot.
--
-- advisory_flags holds proctoring, plagiarism and AI-authorship SIGNALS. They are shown to a human
-- and they are never a finding of misconduct. NO CODE PATH MAY SET state = 'failed' FROM A SIGNAL.
-- Automated detection here is advisory only; a person decides, and false positives cause real harm.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_stage_run (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    UUID NOT NULL,
  pipeline_stage_id UUID NOT NULL,
  slot_no           INT NOT NULL,
  kind              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'not_started',
  opened_at         TIMESTAMPTZ,
  due_at            TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  decided_by        UUID,
  outcome_note      TEXT,
  score             NUMERIC(6,2),
  external_ref      TEXT,
  advisory_flags    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tos_stage_run_slot_range CHECK (slot_no BETWEEN 1 AND 7)
);
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS application_id    UUID;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS pipeline_stage_id UUID;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS slot_no           INT;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS kind              TEXT;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS state             TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS opened_at         TIMESTAMPTZ;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS due_at            TIMESTAMPTZ;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS submitted_at      TIMESTAMPTZ;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS decided_at        TIMESTAMPTZ;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS decided_by        UUID;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS outcome_note      TEXT;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS score             NUMERIC(6,2);
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS external_ref      TEXT;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS advisory_flags    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_stage_run ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS tos_stage_run_uq ON tos_stage_run (application_id, slot_no);
CREATE INDEX IF NOT EXISTS tos_stage_run_state_idx ON tos_stage_run (state, due_at);


-- ------------------------------------------------------------------------------------------------
-- tos_evaluation — one evaluator's scored verdict on one stage run.
--
-- One row per evaluator per run, enforced. A panel is several rows, and the pass rule on the stage
-- decides what the panel's rows mean (unanimous, majority, threshold). Rewriting your own verdict
-- is an UPDATE of your row; there is no second row and no anonymous verdict.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_evaluation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_run_id      UUID NOT NULL,
  evaluator_user_id UUID NOT NULL,
  verdict           TEXT NOT NULL,
  score             NUMERIC(6,2),
  dimensions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  comments          TEXT,
  is_final          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS stage_run_id      UUID;
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS evaluator_user_id UUID;
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS verdict           TEXT;
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS score             NUMERIC(6,2);
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS dimensions        JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS comments          TEXT;
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS is_final          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_evaluation ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_evaluation_run_idx ON tos_evaluation (stage_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS tos_evaluation_one_per_evaluator
  ON tos_evaluation (stage_run_id, evaluator_user_id);


-- ================================================================================================
-- 4. SELECTION DECISION AND AUTHORIZATION CODE
-- ================================================================================================

-- ------------------------------------------------------------------------------------------------
-- tos_selection — the decision, and the organisation-controlled facts that flow into onboarding.
--
-- decision_reason IS NOT NULL IN BOTH DIRECTIONS. The published recruitment policy promises a
-- written explanation either way and that decisions are appealable; a nullable column is how that
-- promise quietly stops being kept.
--
-- is_authorised is the ONE flag the code-validation ladder reads. A selection may be 'selected' and
-- not yet authorised (awaiting a second signature), and that distinction is the difference between
-- a decision and a permission.
--
-- stipend_amount NULL MEANS UNPAID. Internships here are unpaid unless a stipend is explicitly
-- recorded, and every surface that renders this must say so in plain words rather than leaving a
-- blank that a reader fills in optimistically.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_selection (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_ref             TEXT NOT NULL UNIQUE,
  person_id                 UUID NOT NULL,
  application_id            UUID NOT NULL,
  opportunity_role_id       UUID NOT NULL,
  decision                  TEXT NOT NULL,
  decision_reason           TEXT NOT NULL,
  decided_by_user_id        UUID NOT NULL,
  decided_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by_user_id       UUID,
  approved_at               TIMESTAMPTZ,
  is_authorised             BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_at              TIMESTAMPTZ,
  suspended_reason          TEXT,

  offered_position_id       UUID,
  offered_department_id     TEXT,
  offered_title             TEXT,
  employment_type           TEXT,
  reporting_manager_user_id UUID,
  proposed_start_date       DATE,
  stipend_amount            NUMERIC(12,2),
  stipend_currency          TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS selection_ref             TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS person_id                 UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS application_id            UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS opportunity_role_id       UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS decision                  TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS decision_reason           TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS decided_by_user_id        UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS decided_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS approved_by_user_id       UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS approved_at               TIMESTAMPTZ;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS is_authorised             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS suspended_at              TIMESTAMPTZ;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS suspended_reason          TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS offered_position_id       UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS offered_department_id     TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS offered_title             TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS employment_type           TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS reporting_manager_user_id UUID;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS proposed_start_date       DATE;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS stipend_amount            NUMERIC(12,2);
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS stipend_currency          TEXT;
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_selection ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_selection_person_idx  ON tos_selection (person_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS tos_selection_app_idx     ON tos_selection (application_id);
CREATE INDEX IF NOT EXISTS tos_selection_opp_idx     ON tos_selection (opportunity_role_id, decision);

-- A person is selected for one opportunity ONCE. Re-selection supersedes (suspend the old row,
-- write a new one); it never silently duplicates, because two live selections mean two valid codes.
CREATE UNIQUE INDEX IF NOT EXISTS tos_selection_live_uq
  ON tos_selection (person_id, opportunity_role_id)
  WHERE decision = 'selected' AND suspended_at IS NULL;


-- ------------------------------------------------------------------------------------------------
-- tos_auth_code — the EduRankAI Selection / Onboarding Code.
--
-- ONLY THE HASH IS STORED. code_display_prefix and code_last4 exist so an administrator can talk
-- about a specific code ("the one ending 3HD2P") without the database ever holding the credential.
-- A code that cannot be recovered can only be REVOKED AND REISSUED, which is the correct operation
-- anyway: mutating a live credential in place leaves no trail of who held what.
--
-- WHAT THIS AUTHORISES, exactly and only: passage from recruitment to the formal onboarding record
-- for ONE opportunity. It confers no internal access of any kind. Access is decided afterwards from
-- identity, engagement status, department, position, role and approval state.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_auth_code (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash           TEXT NOT NULL UNIQUE,
  code_display_prefix TEXT NOT NULL,
  code_last4          TEXT NOT NULL,
  selection_id        UUID NOT NULL,
  person_id           UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  issued_by_user_id   UUID NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  max_uses            INT NOT NULL DEFAULT 1,
  use_count           INT NOT NULL DEFAULT 0,
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by_user_id  UUID,
  revoked_reason      TEXT,
  delivered_at        TIMESTAMPTZ,
  delivered_to_email  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- WHICH ADDRESS THE CREDENTIAL WENT TO. It answers "the code was delivered to an address the person
-- no longer controls", and it is the ONLY address an identity challenge may be sent back to --
-- sending it to an address the redeemer supplies would defeat the entire binding.
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS delivered_to_email  TEXT;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS code_hash           TEXT;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS code_display_prefix TEXT;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS code_last4          TEXT;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS selection_id        UUID;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS person_id           UUID;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS opportunity_role_id UUID;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS issued_by_user_id   UUID;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS expires_at          TIMESTAMPTZ;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS max_uses            INT NOT NULL DEFAULT 1;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS use_count           INT NOT NULL DEFAULT 0;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS consumed_at         TIMESTAMPTZ;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS revoked_at          TIMESTAMPTZ;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS revoked_by_user_id  UUID;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS revoked_reason      TEXT;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS delivered_at        TIMESTAMPTZ;
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_auth_code_selection_idx ON tos_auth_code (selection_id);
CREATE INDEX IF NOT EXISTS tos_auth_code_person_idx    ON tos_auth_code (person_id);
CREATE INDEX IF NOT EXISTS tos_auth_code_expiry_idx    ON tos_auth_code (expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;


-- ------------------------------------------------------------------------------------------------
-- tos_code_attempt — every redemption attempt, successful or not.
--
-- This is what the rate limiter counts and what the abuse board reads. code_hash is NULL when the
-- submitted text did not even parse, so a flood of malformed input is still visible as a flood.
-- The submitted code is NEVER stored in plaintext, including on a failed attempt.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_code_attempt (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash       TEXT,
  matched_code_id UUID,
  person_id       UUID,
  outcome         TEXT NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS code_hash       TEXT;
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS matched_code_id UUID;
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS person_id       UUID;
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS outcome         TEXT;
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS ip_address      TEXT;
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS user_agent      TEXT;
ALTER TABLE tos_code_attempt ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_code_attempt_ip_idx   ON tos_code_attempt (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_code_attempt_hash_idx ON tos_code_attempt (code_hash, created_at DESC);


-- ------------------------------------------------------------------------------------------------
-- tos_stage_evaluator -- WHO IS ON THE PANEL for one stage run, and why they are on it.
--
-- resolved_via records HOW an evaluator was arrived at, which is what makes a panel auditable after
-- the fact: 'reporting_manager', resolved per-row from the org graph, is a different claim from
-- 'explicit', and a reader six months later cannot tell them apart without this column.
--
-- CONFLICT OF INTEREST IS RECORDED, NOT SILENTLY DROPPED. An evaluator who is the candidate, or the
-- candidate's own reporting manager, is inserted with state='excluded' and a reason, so the panel
-- SHOWS that the exclusion happened rather than the person simply never appearing.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_stage_evaluator (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_run_id      UUID NOT NULL,
  evaluator_user_id UUID NOT NULL,
  resolved_via      TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'assigned',
  is_required       BOOLEAN NOT NULL DEFAULT TRUE,
  exclusion_reason  TEXT,
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS stage_run_id      UUID;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS evaluator_user_id UUID;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS resolved_via      TEXT;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS state             TEXT NOT NULL DEFAULT 'assigned';
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS is_required       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS exclusion_reason  TEXT;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS notified_at       TIMESTAMPTZ;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS tos_stage_evaluator_uq
  ON tos_stage_evaluator (stage_run_id, evaluator_user_id);
CREATE INDEX IF NOT EXISTS tos_stage_evaluator_user_idx
  ON tos_stage_evaluator (evaluator_user_id, state);


-- ------------------------------------------------------------------------------------------------
-- tos_code_challenge -- PROVING THE REDEEMER IS THE PERSON THE CODE IS BOUND TO.
--
-- The authorization code alone is never sufficient. Where the redeemer has no session resolving to
-- the bound person, a one-time challenge goes to the address the code was DELIVERED to -- never to
-- an address the redeemer supplies, which would defeat the entire binding.
--
-- Only the hash is stored, exactly as for the code itself. Fifteen minutes, single use.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_code_challenge (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_code_id   UUID NOT NULL,
  person_id      UUID NOT NULL,
  sent_to_email  TEXT NOT NULL,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  attempt_count  INT NOT NULL DEFAULT 0,
  ip_address     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS auth_code_id   UUID;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS person_id      UUID;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS sent_to_email  TEXT;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS challenge_hash TEXT;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS consumed_at    TIMESTAMPTZ;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS attempt_count  INT NOT NULL DEFAULT 0;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS ip_address     TEXT;
ALTER TABLE tos_code_challenge ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS tos_code_challenge_code_idx
  ON tos_code_challenge (auth_code_id, created_at DESC);


-- ================================================================================================
-- 5. ONBOARDING
-- ================================================================================================

-- ------------------------------------------------------------------------------------------------
-- tos_onboarding_grant — SERVER-SIDE ROUTE AUTHORITY.
--
-- The browser never carries "isSelected". A successful code redemption issues this row; the client
-- holds an opaque token whose HASH is stored here, and every onboarding route re-reads it.
--
-- THE GRANT IS A CONVENIENCE, NEVER THE AUTHORITY. Every request that acts on an onboarding record
-- re-verifies selection, authorisation, suspension, opportunity state and identity status from
-- their own tables. The grant only saves re-typing the code; it does not stand in for any check.
-- Two hours, single use, hashed.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_onboarding_grant (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_token_hash    TEXT NOT NULL UNIQUE,
  selection_id        UUID NOT NULL,
  person_id           UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  auth_code_id        UUID NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  ip_address          TEXT
);
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS grant_token_hash    TEXT;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS selection_id        UUID;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS person_id           UUID;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS opportunity_role_id UUID;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS auth_code_id        UUID;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS expires_at          TIMESTAMPTZ;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS consumed_at         TIMESTAMPTZ;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS revoked_at          TIMESTAMPTZ;
ALTER TABLE tos_onboarding_grant ADD COLUMN IF NOT EXISTS ip_address          TEXT;

CREATE INDEX IF NOT EXISTS tos_grant_person_idx ON tos_onboarding_grant (person_id, issued_at DESC);


-- ------------------------------------------------------------------------------------------------
-- tos_onboarding — the formal onboarding record for one selection.
--
-- locked_fields is a SNAPSHOT taken at grant time, not a live join. The reason: what the candidate
-- agreed to must be reconstructible exactly as it was shown to them, even after the opportunity, the
-- position or the manager has since changed. A live join makes a signed record retroactively
-- disagree with itself.
--
-- answers holds CANDIDATE-OWNED fields only. A POST that attempts to change a locked field is
-- REJECTED with an explanation, never silently ignored — silent ignoring is how a person comes to
-- believe they corrected something they did not.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_onboarding (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_ref      TEXT NOT NULL UNIQUE,
  selection_id        UUID NOT NULL UNIQUE,
  person_id           UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  state               TEXT NOT NULL DEFAULT 'invited',
  form_version        INT NOT NULL DEFAULT 1,
  answers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  locked_fields       JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at        TIMESTAMPTZ,
  verified_at         TIMESTAMPTZ,
  verified_by_user_id UUID,
  approved_at         TIMESTAMPTZ,
  approved_by_user_id UUID,
  rejected_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  identity_id         UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS onboarding_ref      TEXT;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS selection_id        UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS person_id           UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS opportunity_role_id UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS state               TEXT NOT NULL DEFAULT 'invited';
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS form_version        INT NOT NULL DEFAULT 1;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS answers             JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS locked_fields       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS submitted_at        TIMESTAMPTZ;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS verified_by_user_id UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS approved_by_user_id UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS rejected_at         TIMESTAMPTZ;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS rejection_reason    TEXT;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS identity_id         UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_onboarding_state_idx  ON tos_onboarding (state, updated_at DESC);
CREATE INDEX IF NOT EXISTS tos_onboarding_person_idx ON tos_onboarding (person_id, created_at DESC);


-- tos_correction_request — a candidate disputing a locked value.
CREATE TABLE IF NOT EXISTS tos_correction_request (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id      UUID NOT NULL,
  field_key          TEXT NOT NULL,
  current_value      TEXT,
  proposed_value     TEXT NOT NULL,
  candidate_note     TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'open',
  decided_by_user_id UUID,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS onboarding_id      UUID;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS field_key          TEXT;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS current_value      TEXT;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS proposed_value     TEXT;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS candidate_note     TEXT;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS state              TEXT NOT NULL DEFAULT 'open';
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS decided_by_user_id UUID;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS decided_at         TIMESTAMPTZ;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS decision_note      TEXT;
ALTER TABLE tos_correction_request ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_correction_onb_idx
  ON tos_correction_request (onboarding_id, state);


-- ================================================================================================
-- 6. ACCESS PROVISIONING
--
-- These tables hold a DERIVATION RULE and a LEDGER. They do not hold permissions: the permissions
-- themselves live in the existing engine (rbac_* tables via src/lib/rbac/store.ts, and
-- role_permissions via src/lib/auth/registry.ts). Provisioning WRITES THROUGH those modules and
-- never inserts into a permission table directly, because the engine's deny-over-allow evaluation
-- and its nine-state grant lifecycle are the things that make a grant safe.
-- ================================================================================================

CREATE TABLE IF NOT EXISTS tos_access_profile (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key        TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  department_id      TEXT,
  position_grade     TEXT,
  employment_types   TEXT[] NOT NULL DEFAULT '{}',
  identity_types     TEXT[] NOT NULL DEFAULT '{}',
  rbac_role_keys     TEXT[] NOT NULL DEFAULT '{}',
  admin_section_keys TEXT[] NOT NULL DEFAULT '{}',
  app_system_keys    TEXT[] NOT NULL DEFAULT '{}',
  abac_conditions    JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_approval  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS profile_key        TEXT;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS name               TEXT;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS department_id      TEXT;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS position_grade     TEXT;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS employment_types   TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS identity_types     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS rbac_role_keys     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS admin_section_keys TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS app_system_keys    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS abac_conditions    JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS requires_approval  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS is_active          BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_access_profile ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();


CREATE TABLE IF NOT EXISTS tos_app_system (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  provisioner TEXT NOT NULL DEFAULT 'manual',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_app_system ADD COLUMN IF NOT EXISTS key         TEXT;
ALTER TABLE tos_app_system ADD COLUMN IF NOT EXISTS name        TEXT;
ALTER TABLE tos_app_system ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tos_app_system ADD COLUMN IF NOT EXISTS provisioner TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tos_app_system ADD COLUMN IF NOT EXISTS is_active   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_app_system ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();


-- Every provisioning action, so a half-applied profile is VISIBLE and revocable rather than
-- invisible and permanent. state moves pending -> applied | failed, and failed rows carry the real
-- Postgres reason (e.cause.message), not the failed statement.
CREATE TABLE IF NOT EXISTS tos_provisioning_event (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   UUID NOT NULL,
  profile_id    UUID,
  action        TEXT NOT NULL,
  target_kind   TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending',
  error_reason  TEXT,
  actor_user_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at    TIMESTAMPTZ
);
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS identity_id   UUID;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS profile_id    UUID;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS action        TEXT;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS target_kind   TEXT;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS target_key    TEXT;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS state         TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS error_reason  TEXT;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS actor_user_id UUID;
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_provisioning_event ADD COLUMN IF NOT EXISTS applied_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tos_prov_identity_idx
  ON tos_provisioning_event (identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_prov_state_idx
  ON tos_provisioning_event (state, created_at DESC) WHERE state IN ('pending', 'failed');


CREATE TABLE IF NOT EXISTS tos_access_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id      UUID NOT NULL,
  target_kind      TEXT NOT NULL,
  target_key       TEXT NOT NULL,
  reason           TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'open',
  approver_user_id UUID,
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS identity_id      UUID;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS target_kind      TEXT;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS target_key       TEXT;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS reason           TEXT;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS state            TEXT NOT NULL DEFAULT 'open';
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS approver_user_id UUID;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS decided_at       TIMESTAMPTZ;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS decision_note    TEXT;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS expires_at       TIMESTAMPTZ;
ALTER TABLE tos_access_request ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_access_request_state_idx
  ON tos_access_request (state, created_at DESC);


-- ================================================================================================
-- 7. OVERRIDE LEDGER
--
-- NEVER IMPLEMENT A SILENT OVERRIDE. No code path may move tos_stage_run.state,
-- tos_selection.decision, tos_selection.is_authorised, tos_auth_code.revoked_at or
-- tos_onboarding.state outside its normal transition without inserting a row here in the same
-- operation. The reason is required and is free text because a dropdown of reasons is a way of
-- not writing one.
-- ================================================================================================
CREATE TABLE IF NOT EXISTS tos_override (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity           TEXT NOT NULL,
  entity_id        UUID NOT NULL,
  from_state       TEXT,
  to_state         TEXT NOT NULL,
  reason           TEXT NOT NULL,
  actor_user_id    UUID NOT NULL,
  approval_level   TEXT,
  approver_user_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS entity           TEXT;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS entity_id        UUID;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS from_state       TEXT;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS to_state         TEXT;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS reason           TEXT;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS actor_user_id    UUID;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS approval_level   TEXT;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS approver_user_id UUID;
ALTER TABLE tos_override ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_override_entity_idx
  ON tos_override (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_override_actor_idx
  ON tos_override (actor_user_id, created_at DESC);



-- ================================================================================================
-- 8. TABLES SPECIFIED IN LATER SECTIONS OF docs/talent-os-spec.md
--
-- Sections 6 through 21 of the specification introduce tables of their own. They are folded in here
-- so that a fresh environment gets the WHOLE schema from this one file, which is what section 4.9
-- of the specification promises. A table that exists in the document and in no runnable file is
-- precisely the defect that promise exists to prevent.
-- ================================================================================================


-- ------------------------------------------------------------------------------------------------
-- tos_form_definition -- One version of one configurable form. is_published + is_active is UNIQUE per form_key, so
-- exactly one version is live and a draft can be prepared without disturbing it.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_form_definition (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_key            TEXT NOT NULL,
  version             INT NOT NULL DEFAULT 1,
  name                TEXT NOT NULL,
  purpose             TEXT NOT NULL DEFAULT 'onboarding',   -- recruitment|onboarding|selection
  opportunity_role_id UUID,                                 -- roles.id; NULL = every opportunity
  sections            JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_engine_rendered  BOOLEAN NOT NULL DEFAULT TRUE,
  surface_route       TEXT,
  is_published        BOOLEAN NOT NULL DEFAULT FALSE,
  published_at        TIMESTAMPTZ,
  published_by        UUID,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS form_key            TEXT NOT NULL;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS version             INT NOT NULL DEFAULT 1;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS name                TEXT NOT NULL;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS purpose             TEXT NOT NULL DEFAULT 'onboarding';
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS opportunity_role_id UUID;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS sections            JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS is_engine_rendered  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS surface_route       TEXT;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS is_published        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS published_at        TIMESTAMPTZ;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS published_by        UUID;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS is_active           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS created_by          UUID;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS tos_form_definition_version_uq ON tos_form_definition (form_key, version);
CREATE UNIQUE INDEX IF NOT EXISTS tos_form_definition_live_uq ON tos_form_definition (form_key) WHERE is_published AND is_active;

-- ------------------------------------------------------------------------------------------------
-- tos_form_field -- One field on one form version. is_locked marks an organisation-controlled value the candidate
-- may not change; locked_source names where the real value comes from.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_form_field (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id    UUID NOT NULL,
  section_key      TEXT NOT NULL,
  field_key        TEXT NOT NULL,
  label            TEXT NOT NULL,
  help_text        TEXT NOT NULL DEFAULT '',
  field_type       TEXT NOT NULL DEFAULT 'text',
  scope            TEXT NOT NULL DEFAULT 'onboarding',
  is_required      BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked        BOOLEAN NOT NULL DEFAULT FALSE,
  locked_source    TEXT,
  options          JSONB NOT NULL DEFAULT '[]'::jsonb,
  visible_when     JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_when    JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation       JSONB NOT NULL DEFAULT '{}'::jsonb,
  doc_type_key     TEXT,
  declaration_text TEXT,
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS definition_id    UUID NOT NULL;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS section_key      TEXT NOT NULL;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS field_key        TEXT NOT NULL;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS label            TEXT NOT NULL;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS help_text        TEXT NOT NULL DEFAULT '';
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS field_type       TEXT NOT NULL DEFAULT 'text';
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS scope            TEXT NOT NULL DEFAULT 'onboarding';
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS is_required      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS is_locked        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS locked_source    TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS options          JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS visible_when     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS required_when    JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS validation       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS doc_type_key     TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS declaration_text TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS sort_order       INT NOT NULL DEFAULT 0;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS is_active        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS tos_form_field_uq ON tos_form_field (definition_id, field_key);
CREATE INDEX IF NOT EXISTS tos_form_field_section_idx ON tos_form_field (definition_id, section_key, sort_order);

-- ------------------------------------------------------------------------------------------------
-- tos_internal_consent -- An internal applicant's manager consent. manager_employee_id and manager_user_id are DIFFERENT
-- ID SPACES (hr_employees.id vs users.id) and the org graph uses the first while notification
-- uses the second -- see db/org-graph-schema.sql for the translation trap.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_internal_consent (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           UUID NOT NULL,
  identity_id         UUID NOT NULL,                  -- tos_identity.id the person is applying FROM
  opportunity_role_id UUID NOT NULL,                  -- roles.id
  application_id      UUID,                           -- applications.id, once it exists
  manager_employee_id UUID,                           -- hr_employees.id  (org graph id space)
  manager_user_id     UUID,                           -- users.id         (notification id space)
  resolved_via        TEXT NOT NULL DEFAULT 'org_graph',  -- org_graph|legacy_column|department_head|manual
  state               TEXT NOT NULL DEFAULT 'pending',    -- pending|granted|declined|expired|waived
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  decided_by_user_id  UUID,
  decision_note       TEXT,
  waiver_override_id  UUID,                           -- tos_override.id when an admin waived it
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS person_id           UUID NOT NULL;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS identity_id         UUID NOT NULL;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS opportunity_role_id UUID NOT NULL;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS application_id      UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS manager_employee_id UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS manager_user_id     UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS resolved_via        TEXT NOT NULL DEFAULT 'org_graph';
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS state               TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS expires_at          TIMESTAMPTZ;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS decided_at          TIMESTAMPTZ;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS decided_by_user_id  UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS decision_note       TEXT;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS waiver_override_id  UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS tos_internal_consent_open_uq ON tos_internal_consent (person_id, opportunity_role_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS tos_internal_consent_mgr_idx ON tos_internal_consent (manager_user_id, state, requested_at DESC);

-- ------------------------------------------------------------------------------------------------
-- tos_notification_log -- Every notification this system attempts. is_mandatory marks the ones a preference cannot
-- suppress: a code issuance and an onboarding deadline reach the person regardless.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_notification_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key           TEXT NOT NULL,
  channel             TEXT NOT NULL,                  -- email|in_app|push
  recipient_person_id UUID,
  recipient_user_id   UUID,
  recipient_email     TEXT,
  entity              TEXT,                           -- 'tos_selection', 'tos_onboarding', ...
  entity_id           UUID,
  state               TEXT NOT NULL DEFAULT 'queued', -- queued|sent|failed|suppressed
  is_mandatory        BOOLEAN NOT NULL DEFAULT FALSE,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS event_key           TEXT NOT NULL;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS channel             TEXT NOT NULL;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS recipient_person_id UUID;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS recipient_user_id   UUID;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS recipient_email     TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS entity              TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS entity_id           UUID;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS state               TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS is_mandatory        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS attempts            INT NOT NULL DEFAULT 0;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS last_error          TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS tos_notif_state_idx ON tos_notification_log (state, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_notif_event_idx ON tos_notification_log (event_key, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_notif_person_idx ON tos_notification_log (recipient_person_id, created_at DESC);

-- ------------------------------------------------------------------------------------------------
-- tos_idempotency -- Replay protection for the state-changing admin endpoints. A retried request returns the ORIGINAL
-- response rather than performing the action twice.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_idempotency (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint       TEXT NOT NULL,
  idem_key       TEXT NOT NULL,
  actor_user_id  UUID,
  request_hash   TEXT NOT NULL,          -- sha256 of the canonicalised body
  state          TEXT NOT NULL DEFAULT 'in_flight',   -- in_flight|done|failed
  status_code    INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS endpoint      TEXT NOT NULL;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS idem_key      TEXT NOT NULL;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS actor_user_id UUID;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS request_hash  TEXT NOT NULL;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS state         TEXT NOT NULL DEFAULT 'in_flight';
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS status_code   INT;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS response_body JSONB;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS tos_idempotency_uq ON tos_idempotency (endpoint, idem_key);

-- ------------------------------------------------------------------------------------------------
-- tos_rate_event -- The rate limiter's event log. Deliberately narrow and append-only; swept on a schedule.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tos_rate_event (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket     TEXT NOT NULL,       -- the endpoint name
  subject    TEXT NOT NULL,       -- 'ip:203.0.113.4' | 'person:<uuid>' | 'grant:<uuid>'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_rate_event ADD COLUMN IF NOT EXISTS bucket     TEXT NOT NULL;
ALTER TABLE tos_rate_event ADD COLUMN IF NOT EXISTS subject    TEXT NOT NULL;
ALTER TABLE tos_rate_event ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS tos_rate_event_idx ON tos_rate_event (bucket, subject, created_at DESC);


-- Columns added to the section 4 tables by later sections.
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS eligibility_decision  JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS eligibility_outcome   TEXT;
-- The eligibility decision AS IT WAS MADE, with the hash of the rules that made it. An
-- opportunity whose rules change later must not silently re-decide a past application.
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS eligibility_rule_hash TEXT;
-- A reissued code points at its replacement. Reissue is revoke-then-issue, never a mutation, so
-- the chain of who held what stays readable.
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS superseded_by_id UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_error    TEXT;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_gaps     JSONB NOT NULL DEFAULT '[]'::jsonb;
-- ACTIVATION IS NOT ATOMIC. It creates an identity, assigns a position and provisions access, and
-- any step can fail. These columns are how a half-finished activation is VISIBLE and
-- resumable rather than a record that says approved with nothing behind it -- the exact
-- failure that went unnoticed for eleven days on the existing hire path.
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_steps    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS hire_handoff_id     UUID;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS last_activation_at  TIMESTAMPTZ;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS reminders_sent      JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ================================================================================================
-- NO FOREIGN KEYS, DELIBERATELY, AND WHAT REPLACES THEM.
--
-- The hr_* and org_* tables in this codebase already work this way, for a reason that applies here
-- with more force: a person's selection history is the EVIDENCE BEHIND AN AUTHORIZATION. Deleting
-- an opportunity must not delete the record of who was authorised against it and by whom.
--
-- What replaces referential integrity is db/talent-os-validate.sql, which detects orphans, overlapping
-- primary identities, stage runs whose pipeline stage has vanished, codes whose selection has been
-- deleted, and applications linked to a person that has been merged away. Run it after any bulk
-- operation. That gap is stated rather than assumed away.
-- ================================================================================================
