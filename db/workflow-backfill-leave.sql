-- ================================================================================================
-- db/workflow-backfill-leave.sql — PUT THE LEAVE REQUESTS THAT ARE ALREADY WAITING INTO THE ENGINE.
--
-- WHO RUNS THIS: the founder, deliberately, AFTER db/org-graph-backfill.sql.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase connected to a database.
--
-- NOTHING IN THIS FILE RUNS BY ACCIDENT. The whole backfill is inside a `DO $$ ... $$` block guarded
-- by `confirm boolean := FALSE`. To run it, change that ONE line to TRUE and execute the block.
-- Copy-pasting the file as-is executes nothing. A backfill file gets opened by somebody in a hurry,
-- and the natural thing to do with a .sql file in a hurry is run all of it.
--
--     psql "$DATABASE_URL" -f db/workflow-backfill-leave.sql     -- does nothing until you edit it
--
-- RUN THESE FIRST, IN THIS ORDER:
--     1. db/org-graph-schema.sql       (or let the app create the tables)
--     2. db/org-graph-backfill.sql     -- WITHOUT THIS THE GRAPH IS EMPTY and every instance this
--                                         file creates will be halted. That is CORRECT behaviour,
--                                         not a failure, but you will have made work for yourself.
--     3. db/workflow-schema.sql        (or let the app create the tables)
--     4. this file
--     5. db/workflow-validate.sql      -- and read it.
--
-- ================================================================================================
-- WHAT THIS DOES, AND THE ONE THING IT REFUSES TO DO
--
-- For every hr_leave_request still in status 'pending', it creates ONE workflow instance:
--
--   - if the organization graph names a reporting manager for that employee -> state 'pending',
--     with that manager as step 1, and the leave approval owner (if one is recorded) as step 2;
--   - if it does not -> state 'halted', carrying the same sentence src/lib/workflow.ts would have
--     written, so the halted queue reads identically whether a row got there through the engine or
--     through this file.
--
-- IT NEVER CREATES AN INSTANCE IN STATE 'approved'. There is no branch in this file that can. A
-- backfill that "cleared the backlog" by approving everything it could not route would approve
-- real time off that nobody agreed to, and it would look exactly like the migration working.
--
-- IT NEVER TOUCHES hr_leave_request. Not one UPDATE. The leave rows keep their own status, the
-- ordinary /admin/hr/leave path keeps deciding them through decideLeave() exactly as it does today,
-- and src/lib/workflow.ts only ever writes back to a leave row that is STILL 'pending' at the moment
-- its own chain settles. So running this changes no leave decision, and it is reversible by
-- db/workflow-rollback.sql stage 1.
--
-- IT IS SAFE TO RUN TWICE. Every insert is guarded by NOT EXISTS on (domain, record_id), which is
-- the same key the unique index enforces. A second run inserts nothing and reports 0.
--
-- ================================================================================================
-- WHY THE ROUTING IS REPEATED IN SQL HERE, AND WHAT THAT COSTS
--
-- src/lib/workflow.ts resolves routing through src/lib/org-graph.ts. This file cannot call
-- TypeScript, so the two in-force predicates below are a HAND COPY of that logic:
--
--     status = 'active' AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
--
-- That is the same half-open boundary as inForce() in src/lib/org-graph.ts. A copy is a thing that
-- can drift, and this is where it would drift, so: this file only resolves the TWO rungs the leave
-- chain has, and db/workflow-validate.sql section 5 re-checks every step row it created against the
-- graph. If the two ever disagree, validation says so rather than the disagreement being invisible.
--
-- THE ALTERNATIVE, if you would rather not carry the copy at all: skip this file entirely and press
-- "Send for approval" per request on /admin/hr/leave/workflow, which routes through the engine
-- itself. This file exists to save that click on a backlog, not because the click is worse.
-- ================================================================================================

DO $$
DECLARE
  -- ------------------------------------------------------------------------------------------
  -- CHANGE THIS ONE LINE TO TRUE TO RUN THE BACKFILL.
  -- ------------------------------------------------------------------------------------------
  confirm boolean := FALSE;

  graph_initialized boolean;
  n_pending      int := 0;
  n_created      int := 0;
  n_halted       int := 0;
  n_steps        int := 0;
  halt_sentence  text;
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE '--------------------------------------------------------------------------';
    RAISE NOTICE 'workflow-backfill-leave: NOT RUN. Nothing was written.';
    RAISE NOTICE 'Set `confirm boolean := TRUE;` in this block and run it again.';
    RAISE NOTICE '--------------------------------------------------------------------------';
    RETURN;
  END IF;

  -- IS THE GRAPH INITIALIZED AT ALL? Asked first and separately, exactly as the engine asks it.
  -- "The graph has no rows" and "this person has no manager" are DIFFERENT FACTS and they get
  -- different sentences. Telling the founder that nobody in the company has a reporting manager,
  -- when the truth is that the backfill has not been run, sends them hunting for a data problem
  -- that does not exist.
  SELECT EXISTS (SELECT 1 FROM org_relationships WHERE status = 'active') INTO graph_initialized;

  IF NOT graph_initialized THEN
    RAISE NOTICE 'Organization graph is EMPTY. Every instance created here will be halted.';
    RAISE NOTICE 'Run db/org-graph-backfill.sql first if that is not what you want.';
  END IF;

  SELECT COUNT(*) INTO n_pending FROM hr_leave_request WHERE status = 'pending';
  RAISE NOTICE 'Pending leave requests to consider: %', n_pending;

  -- ------------------------------------------------------------------------------------------
  -- STEP 1 — CREATE ONE INSTANCE PER PENDING LEAVE REQUEST.
  --
  -- The state and the halt_reason are decided in the SELECT, per row, from whether the graph can
  -- name a reporting manager for that employee. There is no third branch and no 'approved' branch.
  --
  -- `l.id::text` — record_id is TEXT. See the header of db/workflow-schema.sql for why.
  -- ------------------------------------------------------------------------------------------
  halt_sentence := 'no approver could be resolved: organization graph not yet initialized';

  WITH candidate AS (
    SELECT
      l.id                AS leave_id,
      l.employee_id       AS employee_id,
      e.full_name         AS full_name,
      l.leave_type        AS leave_type,
      l.days              AS days,
      -- The manager, resolved exactly as src/lib/org-graph.ts getManager() resolves them:
      -- subject is the manager, object is the report, and the edge must be in force NOW.
      (SELECT r.subject_employee_id
         FROM org_relationships r
        WHERE r.type = 'reporting_manager'
          AND r.object_employee_id = l.employee_id
          AND r.status = 'active'
          AND r.effective_from <= NOW()
          AND (r.effective_to IS NULL OR r.effective_to > NOW())
        ORDER BY r.effective_from DESC
        LIMIT 1)          AS manager_employee_id
      FROM hr_leave_request l
      JOIN hr_employees e ON e.id = l.employee_id
     WHERE l.status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM workflow_instances w
          WHERE w.domain = 'leave' AND w.record_id = l.id::text
       )
  )
  INSERT INTO workflow_instances
    (domain, record_id, subject_employee_id, requested_by_user_id, state, current_step,
     halt_reason, summary, created_by, created_at, updated_at)
  SELECT
    'leave',
    c.leave_id::text,
    c.employee_id,
    NULL,                                    -- the leave table records no raising user id
    CASE WHEN c.manager_employee_id IS NULL THEN 'halted' ELSE 'pending' END,
    1,
    CASE
      WHEN c.manager_employee_id IS NOT NULL THEN NULL
      WHEN NOT graph_initialized THEN halt_sentence
      ELSE 'no approver could be resolved: no reporting manager is recorded for '
           || COALESCE(c.full_name, 'this person')
    END,
    COALESCE(c.days::text, '?') || ' day(s) ' || COALESCE(c.leave_type, 'leave'),
    NULL,
    NOW(),
    NOW()
  FROM candidate c;

  GET DIAGNOSTICS n_created = ROW_COUNT;

  SELECT COUNT(*) INTO n_halted
    FROM workflow_instances WHERE domain = 'leave' AND state = 'halted';

  -- ------------------------------------------------------------------------------------------
  -- STEP 2 — STEP 1 OF EACH CHAIN: THE REPORTING MANAGER.
  --
  -- Only for instances that are 'pending' — a halted instance has no approver by definition, and
  -- writing it one would be inventing the routing this file just failed to resolve.
  --
  -- approver_user_id is the manager's users.id, LEFT-joined: a manager who has an hr_employees row
  -- but no linked user account still gets the step (the approval is theirs), they simply cannot be
  -- notified. Dropping the step instead would silently route the request to nobody.
  -- ------------------------------------------------------------------------------------------
  INSERT INTO workflow_steps
    (instance_id, step_no, mode, via, approver_employee_id, approver_user_id, decision, due_at, created_at)
  SELECT
    w.id, 1, 'sequential', 'reporting_manager',
    m.id, m.user_id, 'pending',
    NOW() + INTERVAL '48 hours',            -- DOMAINS.leave.escalateAfterHours in src/lib/workflow.ts
    NOW()
    FROM workflow_instances w
    JOIN LATERAL (
      SELECT r.subject_employee_id AS mid
        FROM org_relationships r
       WHERE r.type = 'reporting_manager'
         AND r.object_employee_id = w.subject_employee_id
         AND r.status = 'active'
         AND r.effective_from <= NOW()
         AND (r.effective_to IS NULL OR r.effective_to > NOW())
       ORDER BY r.effective_from DESC
       LIMIT 1
    ) mgr ON TRUE
    JOIN hr_employees m ON m.id = mgr.mid
   WHERE w.domain = 'leave'
     AND w.state = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_steps s
        WHERE s.instance_id = w.id AND s.step_no = 1
     );

  GET DIAGNOSTICS n_steps = ROW_COUNT;
  RAISE NOTICE 'Step 1 (reporting manager) rows created: %', n_steps;

  -- ------------------------------------------------------------------------------------------
  -- STEP 3 — STEP 2 OF EACH CHAIN: THE LEAVE APPROVAL OWNER, IF ONE IS RECORDED.
  --
  -- OPTIONAL RUNG. src/lib/workflow.ts marks it `optional: true`, so an organisation that has not
  -- named a leave approval owner has a one-rung chain and that is a complete, valid chain. Nothing
  -- is halted for the absence of this row.
  --
  -- `scope_id = 'leave'` is the DOMAIN string, held in scope_id as getApprovalOwner() documents.
  -- The specific-employee row wins over the organization-wide one, which is the ORDER BY.
  --
  -- THE SAME PERSON IS NOT ADDED TWICE. If the leave approval owner IS this employee's reporting
  -- manager, they are already step 1 and the NOT EXISTS below leaves them there — asking one human
  -- to approve the same request twice is not two approvals, it is one approval and a confused
  -- person. The subject is excluded for a harder reason: nobody approves their own leave.
  -- ------------------------------------------------------------------------------------------
  INSERT INTO workflow_steps
    (instance_id, step_no, mode, via, approver_employee_id, approver_user_id, decision, due_at, created_at)
  SELECT
    w.id, 2, 'sequential', 'approval_owner',
    o.id, o.user_id, 'pending',
    NOW() + INTERVAL '48 hours',
    NOW()
    FROM workflow_instances w
    JOIN LATERAL (
      SELECT r.subject_employee_id AS oid
        FROM org_relationships r
       WHERE r.type = 'approval_owner'
         AND r.scope_type = 'approval_domain'
         AND r.scope_id = 'leave'
         AND (r.object_employee_id IS NULL OR r.object_employee_id = w.subject_employee_id)
         AND r.status = 'active'
         AND r.effective_from <= NOW()
         AND (r.effective_to IS NULL OR r.effective_to > NOW())
       ORDER BY (r.object_employee_id IS NULL) ASC, r.effective_from DESC
       LIMIT 1
    ) own ON TRUE
    JOIN hr_employees o ON o.id = own.oid
   WHERE w.domain = 'leave'
     AND w.state = 'pending'
     AND o.id <> w.subject_employee_id
     AND NOT EXISTS (
       SELECT 1 FROM workflow_steps s
        WHERE s.instance_id = w.id AND s.approver_employee_id = o.id
     );

  GET DIAGNOSTICS n_steps = ROW_COUNT;
  RAISE NOTICE 'Step 2 (leave approval owner) rows created: %', n_steps;

  -- ------------------------------------------------------------------------------------------
  -- STEP 4 — A LAST SAFETY SWEEP.
  --
  -- Any instance that came out 'pending' but ended up with NO step rows would be a request waiting
  -- on NOBODY — indistinguishable on screen from one waiting on somebody who is simply slow, and it
  -- would sit there forever. It should be unreachable (step 2 above inserts a step for exactly the
  -- instances that got here), and it is corrected anyway rather than trusted: a pending instance
  -- with no approver becomes halted, with the sentence saying so.
  -- ------------------------------------------------------------------------------------------
  UPDATE workflow_instances w
     SET state = 'halted',
         halt_reason = 'no approver could be resolved: the routing pass produced no approver for this request',
         updated_at = NOW()
   WHERE w.domain = 'leave'
     AND w.state = 'pending'
     AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.instance_id = w.id);

  GET DIAGNOSTICS n_steps = ROW_COUNT;
  IF n_steps > 0 THEN
    RAISE WARNING 'Corrected % pending instance(s) that had no approver. Read validation section 4.', n_steps;
  END IF;

  SELECT COUNT(*) INTO n_halted
    FROM workflow_instances WHERE domain = 'leave' AND state = 'halted';

  RAISE NOTICE '--------------------------------------------------------------------------';
  RAISE NOTICE 'workflow-backfill-leave DONE.';
  RAISE NOTICE '  instances created      : %', n_created;
  RAISE NOTICE '  leave instances halted : %  (each carries a readable reason)', n_halted;
  RAISE NOTICE '  NOT ONE leave request was approved, rejected or modified by this file.';
  RAISE NOTICE 'Next: psql "$DATABASE_URL" -f db/workflow-validate.sql';
  RAISE NOTICE 'Halted rows are resumable from /admin/hr/leave/workflow once the missing';
  RAISE NOTICE 'relationship is recorded — halting is a pause with a cause, not a dead end.';
  RAISE NOTICE '--------------------------------------------------------------------------';
END $$;
