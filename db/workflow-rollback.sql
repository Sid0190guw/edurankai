-- ================================================================================================
-- db/workflow-rollback.sql — UNDO PHASE 4, IN THREE STAGES OF INCREASING FINALITY.
--
-- WHO RUNS THIS: the founder, deliberately, choosing ONE stage.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase connected to a database.
--
-- NOTHING IN THIS FILE RUNS BY ACCIDENT. Every stage is wrapped in a `DO $$ ... $$` block guarded by
-- a boolean that is FALSE. To run a stage, change its `confirm boolean := FALSE;` to TRUE and
-- execute that block alone. Copy-pasting the whole file executes nothing.
--
-- WHY THAT GUARD IS HERE AND NOT JUST A COMMENT: a rollback file is opened during an incident, by
-- somebody in a hurry, and the natural thing to do with a .sql file in a hurry is run all of it.
-- Stage 3 drops the tables holding the only record of who approved what. It must not be one
-- keystroke away from stage 1.
--
-- WHICH STAGE DO YOU WANT?
--
--   STAGE 1  Remove the workflow instances that are still OPEN (draft / pending / halted), and
--            their steps. Settled approvals are KEPT.
--            Use when: routing was wrong and you want to fix the org graph and start the requests
--            over. Reversible: re-run db/workflow-backfill-leave.sql, or press the button again.
--
--   STAGE 2  Empty both tables completely, keeping the tables and indexes.
--            Use when: you want the engine's data to start from nothing.
--            DESTRUCTIVE: the record of who approved what is gone. audit_log still holds the
--            'workflow.*' entries, so the DECISIONS remain evidenced even after this — see the note
--            in stage 2 — but the chains they belonged to do not.
--
--   STAGE 3  Drop both tables entirely.
--            Use when: Phase 4 is being abandoned.
--            MOST DESTRUCTIVE. Read the warning above stage 3 before you go near it.
--
-- ================================================================================================
-- WHAT ROLLBACK DOES NOT BREAK, which is what makes all three stages safe to consider:
--
-- NO EXISTING SERVICE DEPENDS ON THESE TABLES. src/lib/hr-leave.ts is untouched by Phase 4:
-- decideLeave() still enforces through approverRole(), its reporting-manager arm still works, and
-- /admin/hr/leave still approves leave exactly as it did before. The only surface that reads the
-- workflow tables is /admin/hr/leave/workflow, and every read in src/lib/workflow.ts fails closed —
-- a missing table is caught, logged and answered as an empty list, never as an approval.
--
-- hr_leave_request IS NEVER TOUCHED BY ANY STAGE HERE. Not one statement below names it. A leave
-- request that the workflow already settled KEEPS its decision — dropping the approval chain does
-- not un-approve somebody's time off, and it must not, because they have already booked the flights.
--
-- THE ORG GRAPH IS NEVER TOUCHED EITHER. org_relationships belongs to Phase 3B and has its own
-- rollback file (db/org-graph-rollback.sql). Rolling back the workflow does not roll back the graph,
-- and it should not: the graph is useful on its own.
-- ================================================================================================


-- ================================================================================================
-- STAGE 1 — REMOVE THE OPEN WORKFLOWS ONLY. SETTLED ONES ARE KEPT.
--
-- Deletes instances in state 'draft', 'pending' or 'halted', and the steps belonging to them.
-- Anything already approved, rejected or cancelled is left exactly as it is, because that is
-- evidence of a decision a person made and this stage is for clearing a wrong ROUTE, not a wrong
-- decision.
-- ================================================================================================
DO $$
DECLARE
  -- ------------------------------------------------------------------------------------------
  -- CHANGE THIS ONE LINE TO TRUE TO RUN STAGE 1.
  -- ------------------------------------------------------------------------------------------
  confirm boolean := FALSE;

  n_steps     int := 0;
  n_instances int := 0;
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE 'STAGE 1: NOT RUN. Nothing was deleted. Set confirm := TRUE in this block to run it.';
    RETURN;
  END IF;

  DELETE FROM workflow_steps s
   USING workflow_instances i
   WHERE s.instance_id = i.id
     AND i.state IN ('draft', 'pending', 'halted');
  GET DIAGNOSTICS n_steps = ROW_COUNT;

  DELETE FROM workflow_instances
   WHERE state IN ('draft', 'pending', 'halted');
  GET DIAGNOSTICS n_instances = ROW_COUNT;

  RAISE NOTICE '--------------------------------------------------------------------------';
  RAISE NOTICE 'STAGE 1 DONE. Open workflows removed.';
  RAISE NOTICE '  steps deleted     : %', n_steps;
  RAISE NOTICE '  instances deleted : %', n_instances;
  RAISE NOTICE '  settled instances : % (kept)',
    (SELECT COUNT(*) FROM workflow_instances WHERE state IN ('approved','rejected','cancelled'));
  RAISE NOTICE '  hr_leave_request  : untouched, as always.';
  RAISE NOTICE '--------------------------------------------------------------------------';
END $$;


-- ================================================================================================
-- STAGE 2 — EMPTY BOTH TABLES.
--
-- DESTRUCTIVE. Every approval chain this engine has ever recorded is gone, including settled ones.
--
-- WHAT SURVIVES, AND WHY THAT MATTERS BEFORE YOU DECIDE: `audit_log` holds a 'workflow.*' row for
-- every start, halt, step approval, step rejection, advance, escalation, resume, cancellation and
-- settlement, each carrying the domain, the record id and the step. So after this stage you can
-- still answer "was this leave request approved, by whom, and when" from the audit log. What you
-- cannot reconstruct is the SHAPE of the chain — who else was in it and what they were waiting for.
--
-- WHAT DOES NOT SURVIVE ANYWHERE ELSE: nothing. There is no second copy of these tables.
-- ================================================================================================
DO $$
DECLARE
  -- ------------------------------------------------------------------------------------------
  -- CHANGE THIS ONE LINE TO TRUE TO RUN STAGE 2.
  -- ------------------------------------------------------------------------------------------
  confirm boolean := FALSE;

  n_steps     int := 0;
  n_instances int := 0;
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE 'STAGE 2: NOT RUN. Nothing was deleted. Set confirm := TRUE in this block to run it.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO n_steps     FROM workflow_steps;
  SELECT COUNT(*) INTO n_instances FROM workflow_instances;

  DELETE FROM workflow_steps;
  DELETE FROM workflow_instances;

  RAISE NOTICE '--------------------------------------------------------------------------';
  RAISE NOTICE 'STAGE 2 DONE. Both workflow tables are empty.';
  RAISE NOTICE '  steps deleted     : %', n_steps;
  RAISE NOTICE '  instances deleted : %', n_instances;
  RAISE NOTICE '  audit_log         : untouched. The workflow.* rows are still there.';
  RAISE NOTICE '  hr_leave_request  : untouched. Approved leave is still approved.';
  RAISE NOTICE '--------------------------------------------------------------------------';
END $$;


-- ================================================================================================
-- STAGE 3 — DROP THE TABLES.
--
-- !!  READ THIS BEFORE YOU CHANGE THE BOOLEAN  !!
--
-- This destroys the only record of every approval chain: who a request was routed to, who decided
-- it, when, on what authority, what was escalated and what was halted and why. It is not
-- recoverable without a database restore.
--
-- YOU ALMOST CERTAINLY WANT STAGE 1 OR STAGE 2. Stage 3 is for one situation only: Phase 4 is being
-- abandoned and the tables are being removed from the database for good.
--
-- YOU DO NOT NEED THIS STAGE TO TURN THE FEATURE OFF. The engine is inactive by default — nothing
-- starts a workflow by itself, and /admin/hr/leave/workflow is the only surface that reads it.
-- Removing that page turns the feature off completely while leaving the evidence intact.
--
-- THE TABLES COME BACK BY THEMSELVES. src/lib/workflow-schema.ts recreates them, EMPTY, on the next
-- call to any workflow function. Dropping them deletes the data; it does not uninstall anything.
-- ================================================================================================
DO $$
DECLARE
  -- ------------------------------------------------------------------------------------------
  -- CHANGE THIS ONE LINE TO TRUE TO RUN STAGE 3. Read the block above first.
  -- ------------------------------------------------------------------------------------------
  confirm boolean := FALSE;
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE 'STAGE 3: NOT RUN. Nothing was dropped. Set confirm := TRUE in this block to run it.';
    RETURN;
  END IF;

  RAISE NOTICE 'Dropping workflow_steps (% rows) and workflow_instances (% rows).',
    (SELECT COUNT(*) FROM workflow_steps), (SELECT COUNT(*) FROM workflow_instances);

  DROP TABLE IF EXISTS workflow_steps;
  DROP TABLE IF EXISTS workflow_instances;

  RAISE NOTICE '--------------------------------------------------------------------------';
  RAISE NOTICE 'STAGE 3 DONE. Both tables dropped.';
  RAISE NOTICE '  They will be recreated EMPTY the next time any workflow function runs.';
  RAISE NOTICE '  audit_log and hr_leave_request are untouched.';
  RAISE NOTICE '--------------------------------------------------------------------------';
END $$;
