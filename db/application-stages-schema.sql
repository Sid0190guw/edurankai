-- db/application-stages-schema.sql
-- THE HIRING FUNNEL'S OWN HISTORY. Owned by src/lib/application-stages.ts, which had no file.
--
-- SAFE TO RUN ON PRODUCTION, but READ THE NOTE ON THE TWO ALTERs BEFORE YOU DO.
--
-- ============================================================================================
-- THESE OBJECTS ALREADY EXIST IN PRODUCTION. THIS FILE IS NOT A REPAIR.
-- ============================================================================================
--
-- Verified 2026-08-24: application_stage_events carries 42 rows, and applications.stage is what
-- renders "Funnel stage: Decision" on /admin/applications/[id]/decision. Running this file changes
-- nothing on the current database — every statement is IF NOT EXISTS and finds its object present.
--
-- SO WHY WRITE IT. Because /api/health reports these four statements as `ddl.suppressed` on every
-- cold serverless instance:
--
--   ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage ...
--   ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage_updated_at ...
--   CREATE TABLE IF NOT EXISTS application_stage_events ...
--   CREATE INDEX IF NOT EXISTS ase_app_idx ...
--
-- The module runs its own DDL on the request path, the guard refuses it, and until now no committed
-- file recorded what those statements are. That is survivable only while the objects happen to
-- exist. A database rebuilt from db/*.sql — which is what the 2026-08-24 migration was — would not
-- have had them, and the failure would not be quiet: getStageEvents() feeds the hiring decision
-- report and moveStage() writes here inside the same request that records a decision.
--
-- A COLUMN CANNOT BE MONITORED BY BOOTSTRAP_MODULES. That list checks information_schema.tables, so
-- `applications.stage` is invisible to it however carefully the table is registered. A parent table
-- that exists while a written column does not is the shape that hides this class of fault — the
-- same one that hid seven columns on hr_clock_events. The file is the only record.

-- --------------------------------------------------------------------------------------------
-- THE STAGE HISTORY. Append-only: one row per transition, with the actor named.
--
-- No FOREIGN KEY on application_id, matching this project's convention for self-bootstrapping
-- tables — the bootstrap runs over a transaction pooler that cannot be relied on for ordering, and
-- a recorded transition must not vanish because somebody archived an application row.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_stage_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  from_stage     VARCHAR(40),
  to_stage       VARCHAR(40) NOT NULL,
  actor_user_id  UUID,
  actor_name     VARCHAR(200),
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ASCENDING, not descending. This index serves the report's "how did this application get here"
-- read, which is a story told forwards.
CREATE INDEX IF NOT EXISTS ase_app_idx ON application_stage_events (application_id, created_at ASC);

-- ============================================================================================
-- THE TWO COLUMNS. RUN THESE ONLY IF THE VERIFY BELOW SAYS THEY ARE MISSING.
-- ============================================================================================
--
-- They are commented out deliberately. ALTER TABLE takes ACCESS EXCLUSIVE on `applications`, and a
-- pending exclusive lock is granted ahead of every shared lock requested after it — so while it
-- waits for the reads already in flight, every NEW read of `applications` queues behind it. That is
-- the exact mechanism that made sixteen of twenty concurrent requests return nothing on 2026-08-23.
--
-- On a table with 174 rows the ALTER itself is instant; the risk is entirely in waiting for a lock
-- under traffic. If you need them, run them one at a time when the admin is idle, and set a bound
-- first so a wait fails fast instead of building a queue:
--
--   SET lock_timeout = '3s';
--   ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage VARCHAR(40) NOT NULL DEFAULT 'submitted';
--   ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ DEFAULT NOW();
--
-- VERIFY (safe, read-only). Expect one table row and two column rows.
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'application_stage_events';
--
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'applications'
--      AND column_name IN ('stage', 'stage_updated_at')
--    ORDER BY column_name;
