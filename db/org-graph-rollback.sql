-- ================================================================================================
-- db/org-graph-rollback.sql — UNDO PHASE 3B, IN THREE STAGES OF INCREASING FINALITY.
--
-- WHO RUNS THIS: the founder, deliberately, choosing ONE stage.
-- WHO DOES NOT RUN THIS: the agent that wrote it.
--
-- NOTHING IN THIS FILE RUNS BY ACCIDENT. Every stage is wrapped in a `DO $$ ... $$` block guarded by
-- a boolean that is FALSE. To run a stage, change its `confirm boolean := FALSE;` to TRUE and
-- execute that block alone. Copy-pasting the whole file executes nothing.
--
-- WHY THAT GUARD IS HERE AND NOT JUST A COMMENT: a rollback file is opened during an incident, by
-- somebody in a hurry, and the natural thing to do with a .sql file in a hurry is run all of it.
-- Stage 3 drops tables containing the only record of who reported to whom. It must not be one
-- keystroke away from stage 1.
--
-- WHICH STAGE DO YOU WANT?
--
--   STAGE 1  Remove ONLY the rows the backfill created, leaving anything entered by hand.
--            Use when: the backfill produced wrong edges and you want to fix the source data and
--            run it again. Reversible: re-run db/org-graph-backfill.sql.
--
--   STAGE 2  Empty the graph completely, keeping the tables and indexes.
--            Use when: you want to start the graph over from nothing.
--            DESTRUCTIVE: hand-entered relationships are gone. Not recoverable without a restore.
--
--   STAGE 3  Drop the tables entirely.
--            Use when: Phase 3B is being abandoned.
--            MOST DESTRUCTIVE. See the warning above stage 3 before you read any further.
--
-- ================================================================================================
-- WHAT ROLLBACK DOES NOT BREAK, which is what makes all three stages safe to consider:
--
-- NOTHING IN THE APPLICATION READS THESE TABLES YET. Phase 3B ships src/lib/org-graph.ts inactive —
-- no page, API route or service imports it. And every resolver in it FAILS CLOSED: a missing table
-- is caught, logged and answered as "no relationship", never as "yes". So an empty or absent graph
-- degrades to exactly the behaviour the product has today.
--
-- hr_employees.reporting_manager_id IS NEVER TOUCHED BY ANY OF THIS. The backfill only READ it. The
-- legacy column is still there, still written by the Employment tab of /admin/hr/employees/[id],
-- and the compatibility layer in src/lib/org-graph.ts still reads it whenever the graph is empty.
-- That is the property that makes the whole phase reversible: the old system was never switched off.
-- ================================================================================================


-- ================================================================================================
-- STAGE 1 — REMOVE ONLY WHAT THE BACKFILL INSERTED
--
-- Identified by the `note` stamp the backfill writes. Rows created through the admin surface or by
-- src/lib/org-graph.ts carry a different note (or none) and are left alone.
--
-- Assignments are matched by shape rather than by note, because org-graph-backfill.sql step 2 does
-- not stamp them: allocation 100, primary, open, with no position and no team is precisely what that
-- step creates and is not a shape anything else produces.
-- ================================================================================================
DO $$
DECLARE
  confirm boolean := FALSE;   -- <<< change to TRUE to run STAGE 1
  removed_edges  integer := 0;
  removed_assign integer := 0;
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE 'STAGE 1 skipped (confirm = FALSE). Nothing was changed.';
    RETURN;
  END IF;

  IF to_regclass('public.org_relationships') IS NULL THEN
    RAISE NOTICE 'org_relationships does not exist. Nothing to roll back.';
    RETURN;
  END IF;

  DELETE FROM org_relationships
   WHERE note IN (
     'backfill:reporting_manager_id',
     'backfill:users.assigned_department_id (one-time migration, see file header)'
   );
  GET DIAGNOSTICS removed_edges = ROW_COUNT;

  IF to_regclass('public.org_employee_assignments') IS NOT NULL THEN
    DELETE FROM org_employee_assignments
     WHERE is_primary = TRUE
       AND status = 'active'
       AND effective_to IS NULL
       AND position_id IS NULL
       AND team_id IS NULL
       AND allocation_pct = 100
       AND created_by IS NULL;
    GET DIAGNOSTICS removed_assign = ROW_COUNT;
  END IF;

  RAISE NOTICE 'STAGE 1 done. Removed % relationship rows and % assignment rows.',
    removed_edges, removed_assign;
END $$;


-- ================================================================================================
-- STAGE 2 — EMPTY THE GRAPH, KEEP THE SCHEMA
--
-- DESTRUCTIVE. Every relationship anyone has entered by hand is deleted along with the backfilled
-- ones, and append-only history is exactly the thing that cannot be reconstructed afterwards: the
-- legacy column holds only the CURRENT manager, so re-running the backfill restores today's org
-- chart and none of its past.
--
-- TRUNCATE rather than DELETE: no triggers, no bloat, and it resets nothing else because these
-- tables use gen_random_uuid() rather than sequences.
-- ================================================================================================
DO $$
DECLARE
  confirm boolean := FALSE;   -- <<< change to TRUE to run STAGE 2
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE 'STAGE 2 skipped (confirm = FALSE). Nothing was changed.';
    RETURN;
  END IF;

  IF to_regclass('public.org_relationships') IS NOT NULL THEN
    TRUNCATE TABLE org_relationships;
  END IF;
  IF to_regclass('public.org_employee_assignments') IS NOT NULL THEN
    TRUNCATE TABLE org_employee_assignments;
  END IF;

  RAISE NOTICE 'STAGE 2 done. The graph is empty. isInitialized() now returns false, so every '
               'consumer shows "Organization Graph not yet initialized" and the compatibility '
               'layer reads hr_employees.reporting_manager_id again.';
END $$;


-- ================================================================================================
-- STAGE 3 — DROP THE TABLES
--
-- ------------------------------------------------------------------------------------------------
-- READ THIS BEFORE CHANGING THE FLAG.
--
-- These tables hold the ONLY record of who reported to whom over time. hr_employees.reporting_manager_id
-- is a single mutable column: it knows today's manager and has never known yesterday's. Once these
-- tables are gone, "who was the manager on the day this was approved" becomes unanswerable again,
-- permanently, for every date — including dates that were answerable while the graph existed.
--
-- If there is any chance this is temporary, use STAGE 2. If there is any chance the history matters
-- later, take a dump of these four tables first:
--
--   pg_dump "$DATABASE_URL" --data-only \
--     -t org_relationships -t org_employee_assignments -t org_teams -t org_positions \
--     > org-graph-backup.sql
--
-- The tables are self-bootstrapping, so dropping them is not permanent in the schema sense — the
-- next call into src/lib/org-graph.ts recreates them, empty. It is the DATA that does not come back.
-- ------------------------------------------------------------------------------------------------
--
-- Order matters only for readability; there are no foreign keys between these tables, deliberately
-- (history must outlive a deleted employee row).
-- ================================================================================================
DO $$
DECLARE
  confirm boolean := FALSE;   -- <<< change to TRUE to run STAGE 3. Read the block above first.
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE 'STAGE 3 skipped (confirm = FALSE). Nothing was changed.';
    RETURN;
  END IF;

  DROP TABLE IF EXISTS org_employee_assignments;
  DROP TABLE IF EXISTS org_relationships;
  DROP TABLE IF EXISTS org_positions;
  DROP TABLE IF EXISTS org_teams;

  RAISE NOTICE 'STAGE 3 done. The Organization Graph tables are gone. The application still works: '
               'every resolver in src/lib/org-graph.ts fails closed on a missing table, and '
               'hr_employees.reporting_manager_id was never modified.';
END $$;


-- ================================================================================================
-- AFTER ANY STAGE — CONFIRM IT ON THE SYSTEM ITSELF, NOT FROM THE NOTICE ABOVE.
--
-- A RAISE NOTICE proves the block ran. It does not prove the database is in the state you wanted.
-- Those two have diverged on this project often enough to be a standing rule.
-- ================================================================================================
SELECT to_regclass('public.org_relationships')      AS org_relationships_exists,
       to_regclass('public.org_employee_assignments') AS org_assignments_exists,
       to_regclass('public.org_teams')              AS org_teams_exists,
       to_regclass('public.org_positions')          AS org_positions_exists;

-- Zero rows here after stage 2 or 3; the backfilled count after stage 1.
-- (Errors if the table was dropped by stage 3 — which is itself the confirmation.)
SELECT COUNT(*) AS org_relationship_rows FROM org_relationships;
