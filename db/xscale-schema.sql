-- =================================================================================================
-- xscale-schema.sql — THE DIVISION LAYER AND THE RESEARCH COLUMNS ON `roles`
-- =================================================================================================
--
-- RUN THIS YOURSELF. Nothing in the application applies it, and nothing should: this repository's
-- working rules forbid the assistant from opening a connection to the production database, and
-- migrations here have always been handed over as a command rather than executed.
--
--     psql "$DATABASE_URL" -f db/xscale-schema.sql
--
-- Every statement is idempotent. Running it twice is a no-op.
--
-- WHY IT IS NOT APPLIED BY THE APPLICATION AT RUNTIME. src/lib/ensure-once.ts defaults
-- SCHEMA_BOOTSTRAP to OFF in production, after the outage of 2026-08-23 in which request-path
-- `ALTER TABLE roles` statements took an ACCESS EXCLUSIVE lock, queued every reader behind them, and
-- exhausted the transaction pooler. src/lib/xscale/schema.ts carries the same DDL for local
-- development and the test suite; production runs THIS file, by hand, once.
--
-- AFTERWARDS, CHECK IT LANDED. This is the query the deployment check runs, and a green message from
-- a script is not the same thing as a column existing:
--
--   SELECT to_regclass('public.divisions') IS NOT NULL AS has_divisions;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='roles' AND column_name IN
--      ('division_id','research_classification','scale_min_exp','scale_max_exp','skill_categories',
--       'career_level','job_status','valid_through','preferred_skills','tools','deliverables',
--       'evaluation_criteria','reporting_to','collaborates_with','application_instructions',
--       'integrity_note')
--    ORDER BY column_name;
--
-- Sixteen rows from the second query means the migration is complete. /admin/roles/divisions reports
-- the same thing on screen and names anything missing.
--
-- THE INDEXES ARE CREATED CONCURRENTLY. A plain CREATE INDEX takes a lock that blocks every write to
-- `roles` for the whole build, and `roles` is read by the public careers page.
--
--   *** CREATE INDEX CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK. ***
--
-- psql with -f runs in autocommit and is fine. A migration runner that wraps the file in
-- BEGIN/COMMIT will fail on the first CONCURRENTLY statement; either disable that wrapper or drop
-- the keyword and accept a brief write lock during a quiet window.
--
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. DIVISIONS — the level between a department and its roles.
-- -------------------------------------------------------------------------------------------------
--
-- department_id is VARCHAR(50) to match departments.id, which is a varchar primary key rather than a
-- uuid. The foreign key is declared with ON DELETE CASCADE for the same reason the roles table does:
-- a division cannot outlive the department it belongs to.
CREATE TABLE IF NOT EXISTS divisions (
  id                      VARCHAR(60) PRIMARY KEY,
  department_id           VARCHAR(50) NOT NULL,
  slug                    VARCHAR(120) NOT NULL,
  name                    VARCHAR(200) NOT NULL,
  code                    VARCHAR(20),
  summary                 TEXT NOT NULL DEFAULT '',
  charter                 TEXT NOT NULL DEFAULT '',
  research_classification VARCHAR(40),
  scale_min_exp           INT,
  scale_max_exp           INT,
  domains                 TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  skill_categories        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  collaborates_with       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  integrity_note          TEXT NOT NULL DEFAULT '',
  sort_order              INT NOT NULL DEFAULT 0,
  is_visible              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The foreign key is added separately and tolerantly. On a database where `departments` is missing
-- or differently typed, a hard failure here would abort the whole migration and leave the columns
-- below unapplied — and every reader in src/lib/xscale already tolerates a missing relation.
DO $$
BEGIN
  IF to_regclass('public.departments') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'divisions_department_id_fkey'
     )
  THEN
    ALTER TABLE divisions
      ADD CONSTRAINT divisions_department_id_fkey
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'divisions_department_id_fkey not added: %', SQLERRM;
END $$;


-- -------------------------------------------------------------------------------------------------
-- 2. THE RESEARCH COLUMNS ON `roles` — additive, nullable, and invisible to every existing query.
-- -------------------------------------------------------------------------------------------------
--
-- NOT A NEW POSTINGS TABLE, DELIBERATELY. A second table would mean a second careers page, a second
-- apply flow, a second admin console, and a second set of application rows that /admin/applications
-- cannot see. This repository already carries one unresolved fork of exactly that kind (tal_* against
-- tos_*); one is enough.
--
-- Every column below is NULL on the ~988 rows already in this table, and every reader treats NULL as
-- "not a research posting" — so nothing that works today changes behaviour when this runs.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS division_id              VARCHAR(60);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS research_classification  VARCHAR(40);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scale_min_exp            INT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scale_max_exp            INT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS skill_categories         TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS career_level             INT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS job_status               VARCHAR(20);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS valid_through            TIMESTAMPTZ;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS preferred_skills         TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS tools                    TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS deliverables             TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS evaluation_criteria      TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS reporting_to             VARCHAR(200);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS collaborates_with        TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS application_instructions TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS integrity_note           TEXT;


-- -------------------------------------------------------------------------------------------------
-- 3. BACKFILL job_status FROM is_open.
-- -------------------------------------------------------------------------------------------------
--
-- Every reader COALESCEs a NULL job_status to 'PUBLISHED', so the site is correct with or without
-- this. It is here so the admin console shows a status for the whole catalogue rather than a blank
-- column on 988 rows, and so a later "how many are drafts" count means something.
--
-- Deliberately only where job_status IS NULL: re-running must never overwrite a status an editor set.
UPDATE roles
   SET job_status = CASE WHEN is_open THEN 'PUBLISHED' ELSE 'CLOSED' END
 WHERE job_status IS NULL;


-- -------------------------------------------------------------------------------------------------
-- 4. INDEXES.
-- -------------------------------------------------------------------------------------------------
--
-- roles_scale_idx is a composite on (scale_min_exp, scale_max_exp) because the band filter tests both
-- in the same predicate: `scale_min_exp <= band_hi AND scale_max_exp >= band_lo`.
CREATE UNIQUE INDEX IF NOT EXISTS divisions_slug_key ON divisions (slug);
CREATE INDEX IF NOT EXISTS divisions_dept_idx ON divisions (department_id, sort_order);

CREATE INDEX CONCURRENTLY IF NOT EXISTS roles_division_idx       ON roles (division_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS roles_classification_idx ON roles (research_classification);
CREATE INDEX CONCURRENTLY IF NOT EXISTS roles_job_status_idx     ON roles (job_status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS roles_scale_idx          ON roles (scale_min_exp, scale_max_exp);
CREATE INDEX CONCURRENTLY IF NOT EXISTS roles_skillcat_gin       ON roles USING GIN (skill_categories);

-- The listing query orders by is_featured DESC, sort_order ASC, created_at DESC and filters on the
-- public visibility rule. This index serves that ordering for the common case.
CREATE INDEX CONCURRENTLY IF NOT EXISTS roles_public_listing_idx
  ON roles (is_open, job_status, is_featured DESC, sort_order ASC, created_at DESC);


-- -------------------------------------------------------------------------------------------------
-- 5. AFTER RUNNING: CHECK NO INDEX LANDED INVALID.
-- -------------------------------------------------------------------------------------------------
--
-- CREATE INDEX CONCURRENTLY can leave an INVALID index behind if it fails midway. An invalid index is
-- not used by the planner and is NOT repaired by re-running this file: DROP it and create it again.
--
--   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE NOT i.indisvalid AND (c.relname LIKE 'roles_%' OR c.relname LIKE 'divisions_%');
--
-- Nothing returned means every index is valid.
