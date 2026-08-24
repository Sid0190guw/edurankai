-- db/capability-spine-schema.sql
-- THE SKILL CATALOGUE AND THE PERSON SPINE. Eight tables that have never existed in production.
--
-- SAFE TO RUN ON PRODUCTION. Every statement is CREATE TABLE IF NOT EXISTS or CREATE INDEX
-- IF NOT EXISTS. There is not one ALTER TABLE in this file, deliberately: an ALTER needs
-- ACCESS EXCLUSIVE and queues every reader of that table behind it, which is the mechanism that
-- took the site down on 2026-08-23. Nothing here touches a table that already exists.
--
-- RUN IT YOURSELF, and run db/hiring-decision-schema.sql beside it. This repository's convention is
-- that migrations are handed to the operator; nothing in the build opens a production connection.
--
-- ============================================================================================
-- WHY THIS FILE EXISTS, WITH THE EVIDENCE
-- ============================================================================================
--
-- /admin/applications/[id]/decision reported three failures at once on 2026-08-24: it could not
-- record a decision, it could not resolve the person, and it could not read the role requirements.
-- Three sentences, one cause — the tables are not there.
--
-- The proof is a full table enumeration of the live database taken the same evening. Of everything
-- src/lib/capability-coverage.ts reads, only `manual_interviews` exists. hr_skills,
-- hr_employee_skills, hr_persons, hr_person_identities, hr_skill_relations, hr_role_requirements
-- hr_match_decisions and match_evaluations are all absent — and absent from the OLD database too,
-- so this is not something the Supabase migration dropped. They were never created anywhere.
--
-- HOW EIGHT TABLES WENT MISSING WITHOUT A SINGLE ERROR BEING SEEN. Their only creators are
-- ensurePerformanceSchema() (src/lib/performance-schema.ts), ensureSpineSchema()
-- (src/lib/person-spine.ts) and ensureMatchSchema() (src/lib/match.ts). All three run their statements as ONE SEQUENCE that stops at the first
-- failure, and both sit inside ensureOnce(), which ends in a catch that swallows. So a statement
-- part-way down the list throws, every statement after it is skipped, and the caller is told
-- nothing. The live database shows exactly that shape: hr_goal_key_results (second statement in
-- the performance batch) exists, and everything from hr_feedback onward — including hr_skills —
-- does not. The sequence stopped in the middle and no one was told.
--
-- Since 2026-08-23 production does not run request-path DDL at all, so neither ensure can finish
-- what it started even now. That is why this is a file rather than a page load.
--
-- ORDER IS FOREIGN KEYS. hr_skill_relations and hr_role_requirements both REFERENCE hr_skills, so
-- the catalogue is created first. Run out of order and the spine's CREATEs fail exactly the way
-- they have been failing.
--
-- WHAT THIS DOES NOT DO. It creates no rows. An empty catalogue is the honest starting state: the
-- decision screen will stop saying it could not READ the requirements and start saying this job has
-- none expressed in the skill catalogue yet, which is true and is a different sentence. Somebody
-- maps them at /admin/roles, per src/lib/capability-coverage.ts proposeRequirements().

-- --------------------------------------------------------------------------------------------
-- 1. THE SKILL CATALOGUE. Owned by src/lib/performance-schema.ts (PERFORMANCE_DDL), reproduced
--    here verbatim because that batch cannot reach it in production.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_skills (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR(120) NOT NULL,
  category           VARCHAR(60) NOT NULL DEFAULT 'general',
  description        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness: "TypeScript" and "typescript" are one skill, and letting them be
-- two silently halves every count on the department matrix.
CREATE UNIQUE INDEX IF NOT EXISTS hr_skills_name_key ON hr_skills (lower(name));

-- WHAT A PERSON HAS EVIDENCED, in the same vocabulary a job asks in.
CREATE TABLE IF NOT EXISTS hr_employee_skills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  skill_id            UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
  level               INT NOT NULL DEFAULT 1,
  evidence            TEXT,
  evidence_url        TEXT,
  source              VARCHAR(20) NOT NULL DEFAULT 'self',
  assessed_by_user_id UUID,
  assessed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_employee_skills_key UNIQUE (employee_id, skill_id)
);

CREATE INDEX IF NOT EXISTS hr_employee_skills_skill_idx ON hr_employee_skills (skill_id, level);

-- --------------------------------------------------------------------------------------------
-- 2. THE PERSON SPINE. Owned by src/lib/person-spine.ts, reproduced verbatim for the same reason.
--
--    One human is named three different ways across three forms — an application, an employee
--    record, a user account. The spine is the record that those three are one person, asserted by
--    somebody rather than guessed by a matcher.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_persons (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       TEXT NOT NULL,
  note               TEXT,
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE IDENTITY ASSERTION. `ref_id` is TEXT rather than UUID on purpose: every id space here is a
-- uuid today, and casting would be tidier, but a spine that cannot record an identity in a space
-- that keys differently is a spine that gets forked the first time one appears.
CREATE TABLE IF NOT EXISTS hr_person_identities (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          UUID NOT NULL REFERENCES hr_persons(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,
  ref_id             TEXT NOT NULL,
  assertion_type     TEXT NOT NULL DEFAULT 'explicitly_provided',
  basis              TEXT NOT NULL,
  linked_by_user_id  UUID,
  linked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unlinked_at        TIMESTAMPTZ,
  unlinked_by_user_id UUID,
  unlink_reason      TEXT
);

-- One LIVE link per (kind, ref_id): one employee record belongs to one person. A withdrawn link
-- keeps its row, so the partial index covers the live ones only and the history survives.
CREATE UNIQUE INDEX IF NOT EXISTS hr_person_identities_live_key
  ON hr_person_identities (kind, ref_id) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS hr_person_identities_person_idx
  ON hr_person_identities (person_id, kind);

-- THE SKILL GRAPH. Edges beside hr_skills, never a second catalogue.
CREATE TABLE IF NOT EXISTS hr_skill_relations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_skill_id      UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
  to_skill_id        UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL,
  note               TEXT,
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_skill_relations_key UNIQUE (from_skill_id, to_skill_id, relation)
);

CREATE INDEX IF NOT EXISTS hr_skill_relations_from_idx ON hr_skill_relations (from_skill_id, relation);
CREATE INDEX IF NOT EXISTS hr_skill_relations_to_idx   ON hr_skill_relations (to_skill_id, relation);

-- WHAT A JOB ASKS FOR, IN THE SAME VOCABULARY AS WHAT A PERSON HAS EVIDENCED.
-- roles.skills is a jsonb array of free strings and hr_skills is a uuid catalogue; they have never
-- been joined, which is why no honest comparison between a person and a job has been possible.
-- This is that join, and it is authored by a human rather than guessed.
CREATE TABLE IF NOT EXISTS hr_role_requirements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id            UUID NOT NULL,
  skill_id           UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
  necessity          TEXT NOT NULL DEFAULT 'important',
  min_level          INT,
  source_text        TEXT,
  assertion_type     TEXT NOT NULL DEFAULT 'explicitly_provided',
  basis              TEXT NOT NULL,
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_role_requirements_key UNIQUE (role_id, skill_id)
);

CREATE INDEX IF NOT EXISTS hr_role_requirements_role_idx ON hr_role_requirements (role_id);

-- A JUDGEMENT ABOUT A COVERAGE VIEW. Append-only. This is NOT the hiring decision — that is
-- hiring_decisions, in db/hiring-decision-schema.sql, and nothing converts one into the other.
CREATE TABLE IF NOT EXISTS hr_match_decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id            UUID NOT NULL,
  person_id          UUID,
  subject_kind       TEXT NOT NULL,
  subject_id         TEXT NOT NULL,
  decision           TEXT NOT NULL,
  reason             TEXT NOT NULL,
  coverage_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_by_user_id UUID,
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hr_match_decisions_role_idx
  ON hr_match_decisions (role_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS hr_match_decisions_subject_idx
  ON hr_match_decisions (subject_kind, subject_id, decided_at DESC);

-- --------------------------------------------------------------------------------------------
-- 3. THE STORED CAPABILITY READING. Owned by src/lib/match.ts, and absent for the same reason:
--    its only creator is ensureMatchSchema(). The decision report's "prior readings" panel reads
--    it, so without this the screen has a third unreadable section.
--
--    It is a READING plus what a human did about it (agreed / disagreed / set aside), which is why
--    the human_decision columns sit beside the explanation rather than in another table.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_evaluations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_person_key       VARCHAR(120) NOT NULL,
  subject_employee_id      UUID,
  subject_user_id          UUID,
  subject_application_id   UUID,
  job_kind                 VARCHAR(20) NOT NULL,
  job_id                   UUID NOT NULL,
  weight_profile_key       VARCHAR(60),
  weights_snapshot         JSONB NOT NULL DEFAULT '{}'::jsonb,
  explanation              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id       UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  human_decision           VARCHAR(24),
  human_decision_note      TEXT,
  human_decision_by_user_id UUID,
  human_decided_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS match_eval_job_idx
  ON match_evaluations (job_kind, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS match_eval_subject_idx
  ON match_evaluations (subject_person_key, created_at DESC);

-- ============================================================================================
-- VERIFY (safe, read-only). Run after the statements above. Expect eight rows.
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN ('hr_skills','hr_employee_skills','hr_persons','hr_person_identities',
--                         'hr_skill_relations','hr_role_requirements','hr_match_decisions',
--                         'match_evaluations')
--    ORDER BY table_name;
--
-- Then reload /admin/applications/<id>/decision. The two "could not be read" lines should be gone.
-- The role-fit panel will say the job has no requirements mapped yet, which is a true statement
-- about the data rather than a failed read, and is fixed by mapping them, not by more SQL.
--
-- STILL MISSING AFTER THIS, AND DELIBERATELY LEFT ALONE. The same aborted performance batch also
-- never created hr_feedback, hr_learning_assignments, hr_training_events and hr_training_signups.
-- They belong to continuous feedback and assigned learning, not to hiring, and they carry ALTER
-- statements in their part of the batch that this file will not run blind. They are a separate
-- piece of work with its own file.
