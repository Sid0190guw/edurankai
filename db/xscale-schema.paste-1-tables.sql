-- db/xscale-schema.paste-1-tables.sql
-- ================================================================================================
-- PASTE 1 OF 2 — SAFE TO RUN IN A SQL EDITOR.
-- ================================================================================================
--
-- This is db/xscale-schema.sql split so it can be run from a web SQL console (Supabase and the rest),
-- which wraps whatever you paste in a SINGLE implicit transaction. The original file ends with
-- `CREATE INDEX CONCURRENTLY`, and
--
--     *** CREATE INDEX CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK. ***
--
-- so pasting the whole thing fails on the first index and rolls back every ALTER above it — the
-- console reports one error and the migration silently did nothing at all. That is why the indexes
-- are in paste 2 and not here.
--
-- If you have psql, ignore both split files and run the original instead; it executes in autocommit,
-- so CONCURRENTLY works and no write lock is taken:
--
--     psql "$DATABASE_URL" -f db/xscale-schema.sql
--
-- WHAT THIS UNBLOCKS. The Extreme-Scale, Nano & Fundamental Engineering department — 15 divisions
-- and 179 postings, of which 15 are Nano Engineering & Nanotechnology. None of it can exist until
-- this runs: the `divisions` table lives only here and in ensureXscaleSchema(), and that ensure is a
-- no-op in production (SCHEMA_BOOTSTRAP is off — see the header of src/lib/ensure-once.ts).
--
-- RUNNING THIS IS STEP 1 OF 3. It creates the shape and nothing else. Afterwards:
--
--   2. /admin/roles/divisions -> "Import"           creates the department, the 15 divisions and the
--                                                   179 postings. Time-boxed and idempotent: click
--                                                   again until it says nothing remaining.
--   3. /admin/roles/divisions -> "Publish division" per division. The import inserts every posting
--                                                   as is_open=false, job_status='DRAFT' on purpose;
--                                                   an import must not publish anything. Nothing is
--                                                   public until you publish it.
--
-- That page also reports, on screen, which tables and columns are still missing — so open it after
-- this paste and confirm it says nothing is.
--
-- Idempotent. Running it twice changes nothing.

-- ── 1. DIVISIONS — the level between a department and its roles ─────────────────────────────────
--
-- department_id is VARCHAR(50) to match departments.id, which is a varchar primary key rather than a
-- uuid. The foreign key cascades for the same reason roles does: a division cannot outlive its
-- department.

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
-- or differently typed, a hard failure here would abort the whole paste and leave the columns below
-- unapplied — and every reader in src/lib/xscale already tolerates a missing relation.
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

-- These two are ordinary CREATE INDEX on a brand-new, empty table, so they take no meaningful lock
-- and belong here rather than in paste 2.
CREATE UNIQUE INDEX IF NOT EXISTS divisions_slug_key ON divisions (slug);
CREATE INDEX        IF NOT EXISTS divisions_dept_idx ON divisions (department_id, sort_order);

-- ── 2. THE RESEARCH COLUMNS ON `roles` — additive, nullable, invisible to every existing query ──
--
-- NOT a second postings table, deliberately: that would mean a second careers page, a second apply
-- flow, a second admin console and a second set of application rows /admin/applications cannot see.
-- Every column is NULL on the rows already in this table and every reader treats NULL as "not a
-- research posting", so nothing that works today changes behaviour when this runs.

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

-- ── 3. BACKFILL job_status FROM is_open ─────────────────────────────────────────────────────────
--
-- Every reader COALESCEs a NULL job_status to 'PUBLISHED', so the site is correct with or without
-- this. It is here so the admin console shows a status for the whole catalogue rather than a blank
-- column, and so a later "how many are drafts" count means something.
--
-- Only where job_status IS NULL: re-running must never overwrite a status an editor set.

UPDATE roles
   SET job_status = CASE WHEN is_open THEN 'PUBLISHED' ELSE 'CLOSED' END
 WHERE job_status IS NULL;

-- ── 4. VERIFICATION — read these, do not just look for a green tick ─────────────────────────────

-- 4a. The divisions table exists.
SELECT to_regclass('public.divisions') AS divisions_table;
-- EXPECT: divisions   (NULL means it was not created — read the error above, do not run paste 2.)

-- 4b. All sixteen columns landed.
SELECT COUNT(*)::int AS columns_present
  FROM information_schema.columns
 WHERE table_name = 'roles'
   AND column_name IN ('division_id','research_classification','scale_min_exp','scale_max_exp',
                       'skill_categories','career_level','job_status','valid_through',
                       'preferred_skills','tools','deliverables','evaluation_criteria',
                       'reporting_to','collaborates_with','application_instructions',
                       'integrity_note');
-- EXPECT: 16. Anything less and paste 1 was partially rolled back — re-run it.

-- Only when both of the above are right, run db/xscale-schema.paste-2-indexes.sql.
