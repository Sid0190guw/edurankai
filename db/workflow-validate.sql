-- ================================================================================================
-- db/workflow-validate.sql — READ-ONLY. Prove the workflow engine's data is right, or find out how
-- it is wrong.
--
-- WHO RUNS THIS: the founder, after the backfill and whenever an approval looks stuck.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase connected to a database.
--
-- NOT ONE STATEMENT IN THIS FILE WRITES. No INSERT, no UPDATE, no DELETE, no DDL. It is safe to run
-- against production at any time, including in the middle of a working day.
--
--     psql "$DATABASE_URL" -f db/workflow-validate.sql
--
-- HOW TO READ THE OUTPUT
--   Section 1  counts. Compare them; they should reconcile.
--   Section 2  the halted queue. Rows here are EXPECTED and are not defects — they are requests the
--              organization graph could not route, each carrying the sentence that says why. This is
--              the section that turns "the system quietly did nothing" into a work list.
--   Sections 3-9 are FAULT REPORTS. EVERY ONE OF THEM SHOULD RETURN ZERO ROWS.
--
-- Any row from sections 3-9 is a defect in the data. None of them are fatal to the application —
-- every read in src/lib/workflow.ts fails closed, so the visible symptom is a missing approval
-- rather than a wrong one — but each is a request that is either stuck or waiting on the wrong
-- person, and section 6 is the one that would mean a real approval bypassed the org graph.
-- ================================================================================================


-- ================================================================================================
-- SECTION 1 — RECONCILIATION COUNTS
--
-- WHAT SHOULD BE TRUE:
--   instances_pending  =  instances that have at least one pending step
--   instances_halted   =  instances with a halt_reason and NO pending steps
--   Every settled instance (approved/rejected/cancelled) has settled_at set.
-- ================================================================================================
SELECT
  (SELECT COUNT(*) FROM workflow_instances)                                     AS instances_total,
  (SELECT COUNT(*) FROM workflow_instances WHERE state = 'draft')               AS instances_draft,
  (SELECT COUNT(*) FROM workflow_instances WHERE state = 'pending')             AS instances_pending,
  (SELECT COUNT(*) FROM workflow_instances WHERE state = 'halted')              AS instances_halted,
  (SELECT COUNT(*) FROM workflow_instances WHERE state = 'approved')            AS instances_approved,
  (SELECT COUNT(*) FROM workflow_instances WHERE state = 'rejected')            AS instances_rejected,
  (SELECT COUNT(*) FROM workflow_instances WHERE state = 'cancelled')           AS instances_cancelled,
  (SELECT COUNT(*) FROM workflow_steps)                                         AS steps_total,
  (SELECT COUNT(*) FROM workflow_steps WHERE decision = 'pending')              AS steps_pending,
  (SELECT COUNT(*) FROM workflow_steps WHERE decision = 'approved')             AS steps_approved,
  (SELECT COUNT(*) FROM workflow_steps WHERE decision = 'rejected')             AS steps_rejected,
  (SELECT COUNT(*) FROM workflow_steps WHERE decision = 'skipped')              AS steps_skipped,
  (SELECT COUNT(*) FROM workflow_steps WHERE escalated_from_step_id IS NOT NULL) AS steps_from_escalation,
  (SELECT COUNT(*) FROM hr_leave_request WHERE status = 'pending')              AS leave_still_pending;

-- Breakdown by domain and state, so an unexpected value shows up as a name nobody recognises.
SELECT domain, state, COUNT(*) AS n
  FROM workflow_instances
 GROUP BY domain, state
 ORDER BY domain, state;

-- How approvals are actually being authorised. `capability` rows are people acting on STANDING
-- authority rather than because the graph routed to them; a queue where most decisions are
-- 'capability' means the org graph is not carrying the organisation and the routing is decorative.
SELECT COALESCE(acted_via, '(undecided)') AS acted_via, COUNT(*) AS n
  FROM workflow_steps
 GROUP BY 1
 ORDER BY n DESC;


-- ================================================================================================
-- SECTION 2 — THE HALTED QUEUE. NOT A DEFECT. A WORK LIST.
--
-- Every row is a request the graph could not route, with the reason. Fix the relationship named in
-- the reason, then press Resume on /admin/hr/leave/workflow (or call resumeWorkflow) — the request
-- carries on from where it stopped.
--
-- IF EVERY ROW SAYS "organization graph not yet initialized", nothing is broken: run
-- db/org-graph-backfill.sql. That sentence means the graph has no rows AT ALL, which is a different
-- fact from "this person has no manager" and is deliberately worded so the two cannot be confused.
-- ================================================================================================
SELECT i.id,
       i.domain,
       i.record_id,
       e.full_name  AS subject,
       i.halt_reason,
       i.created_at
  FROM workflow_instances i
  LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
 WHERE i.state = 'halted'
 ORDER BY i.created_at DESC
 LIMIT 200;


-- ================================================================================================
-- SECTION 3 — DUPLICATE INSTANCES FOR ONE RECORD.  EXPECT ZERO ROWS.
--
-- Two live approvals of one request, routed to two different people, is the failure the unique index
-- workflow_instances_record_uq exists to prevent. Rows here mean that index is NOT on this database
-- (it has its own try/catch and is allowed to fail) — create it, after removing the duplicates.
-- ================================================================================================
SELECT domain, record_id, COUNT(*) AS instances, array_agg(id) AS instance_ids
  FROM workflow_instances
 GROUP BY domain, record_id
HAVING COUNT(*) > 1
 ORDER BY instances DESC;


-- ================================================================================================
-- SECTION 4 — A PENDING REQUEST WAITING ON NOBODY.  EXPECT ZERO ROWS.
--
-- THE WORST ROW IN THIS FILE AFTER SECTION 6. An instance in state 'pending' with no pending step is
-- indistinguishable on screen from one waiting on somebody slow: it shows as "waiting for approval"
-- and it waits forever, because nothing will ever move it.
--
-- The engine cannot produce this — advanceInstance() settles an instance the moment its last pending
-- step is decided, and a route that resolves nobody produces 'halted', never 'pending'. A row here
-- means a hand-edit, a partial restore, or an interrupted backfill.
-- ================================================================================================
SELECT i.id, i.domain, i.record_id, i.state, i.current_step, i.created_at
  FROM workflow_instances i
 WHERE i.state = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM workflow_steps s WHERE s.instance_id = i.id AND s.decision = 'pending'
   )
 ORDER BY i.created_at;


-- ================================================================================================
-- SECTION 5 — current_step DISAGREES WITH THE STEP ROWS.  EXPECT ZERO ROWS.
--
-- current_step must always equal the LOWEST step_no that still owes a decision. advanceInstance()
-- re-derives it from the rows rather than incrementing it, exactly so this cannot drift; a row here
-- means somebody wrote the column directly.
--
-- Symptom if it drifts: approvers at the real current step are refused with "this is waiting on an
-- earlier approval", and the request cannot move at all.
-- ================================================================================================
SELECT i.id,
       i.domain,
       i.current_step                        AS instance_says,
       MIN(s.step_no)                        AS rows_say,
       COUNT(*) FILTER (WHERE s.decision = 'pending') AS pending_steps
  FROM workflow_instances i
  JOIN workflow_steps s ON s.instance_id = i.id AND s.decision = 'pending'
 WHERE i.state = 'pending'
 GROUP BY i.id, i.domain, i.current_step
HAVING i.current_step <> MIN(s.step_no);


-- ================================================================================================
-- SECTION 6 — AN APPROVAL WHOSE APPROVER THE GRAPH NEVER NAMED.  EXPECT ZERO ROWS.
--
-- THE ONE THAT MATTERS MOST. Every step row should have been created by resolving a relationship in
-- org_relationships. This re-checks each PENDING step against the graph as it stands now, using the
-- same in-force predicate src/lib/org-graph.ts uses:
--
--     status = 'active' AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
--
-- READ THE RESULT CAREFULLY BEFORE TREATING IT AS A DEFECT. A step is FROZEN at the moment it is
-- created, on purpose: a reorganisation must not silently move a pending approval to somebody else,
-- and the record of who it was actually waiting on must survive the reorganisation. So a row here is
-- one of TWO things:
--
--   (a) the relationship legitimately ENDED after the step was created — ordinary, and the right
--       response is usually to escalate the step rather than to "fix" anything; or
--   (b) a step that was never resolved from the graph at all — which would mean an approval routed
--       to somebody outside the org chart. That is the defect this section is looking for.
--
-- Tell them apart with getRelationshipHistory / db/org-graph-validate.sql: (a) leaves a CLOSED edge
-- behind, (b) leaves no edge at all, ever.
-- ================================================================================================
SELECT s.id           AS step_id,
       i.domain,
       i.record_id,
       subj.full_name AS subject,
       appr.full_name AS approver,
       s.via,
       s.created_at
  FROM workflow_steps s
  JOIN workflow_instances i ON i.id = s.instance_id
  LEFT JOIN hr_employees subj ON subj.id = i.subject_employee_id
  LEFT JOIN hr_employees appr ON appr.id = s.approver_employee_id
 WHERE s.decision = 'pending'
   AND i.state = 'pending'
   AND s.escalated_from_step_id IS NULL          -- escalations are resolved from the chain, not a rung
   AND NOT EXISTS (
     SELECT 1
       FROM org_relationships r
      WHERE r.subject_employee_id = s.approver_employee_id
        AND r.status = 'active'
        AND r.effective_from <= NOW()
        AND (r.effective_to IS NULL OR r.effective_to > NOW())
        AND (
          -- the manager rung
          (s.via = 'reporting_manager'
             AND r.type = 'reporting_manager'
             AND r.object_employee_id = i.subject_employee_id)
          -- the department-head rung. scope_id is TEXT and department_id is read ::text — NEVER
          -- ::uuid: departments.id is varchar(50) in one schema file and UUID in the other.
          OR (s.via = 'department_head'
             AND r.type = 'department_head'
             AND r.scope_type = 'department'
             AND r.scope_id = (SELECT e.department_id::text FROM hr_employees e WHERE e.id = i.subject_employee_id))
          -- the approval-owner and executive rungs. The executive rung is an approval_owner edge
          -- scoped to '<domain>.executive' — see the DOMAINS note in src/lib/workflow.ts.
          OR (s.via IN ('approval_owner', 'executive_sponsor')
             AND r.type = 'approval_owner'
             AND r.scope_type = 'approval_domain'
             AND r.scope_id IN (i.domain, i.domain || '.executive')
             AND (r.object_employee_id IS NULL OR r.object_employee_id = i.subject_employee_id))
        )
   )
 ORDER BY s.created_at DESC
 LIMIT 200;


-- ================================================================================================
-- SECTION 7 — SELF-APPROVAL.  EXPECT ZERO ROWS.
--
-- Nobody approves their own request. resolveRoute() drops the subject from every rung, and
-- escalateStep() refuses to escalate to them. A row here is an approval somebody could grant
-- themselves, which makes every manager's own leave self-approving.
-- ================================================================================================
SELECT s.id AS step_id, i.domain, i.record_id, e.full_name AS person, s.decision
  FROM workflow_steps s
  JOIN workflow_instances i ON i.id = s.instance_id
  LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
 WHERE s.approver_employee_id = i.subject_employee_id;

-- The harder version of the same question: a step DECIDED by the person the request is about,
-- whichever id space it happened in.
SELECT s.id AS step_id, i.domain, i.record_id, e.full_name AS person, s.decided_at, s.acted_via
  FROM workflow_steps s
  JOIN workflow_instances i ON i.id = s.instance_id
  JOIN hr_employees e ON e.id = i.subject_employee_id
 WHERE s.decided_by_user_id IS NOT NULL
   AND s.decided_by_user_id = e.user_id;


-- ================================================================================================
-- SECTION 8 — ORPHANS, STRAY VOCABULARY AND UNSETTLED TERMINAL ROWS.  EXPECT ZERO ROWS.
--
-- There is deliberately no foreign key from workflow_steps to workflow_instances (deleting an
-- instance must not be able to happen silently, and the hr_* tables already work this way), so
-- orphan detection is this file's job rather than the planner's.
-- ================================================================================================

-- 8a. Steps whose instance no longer exists.
SELECT s.id AS orphan_step_id, s.instance_id, s.created_at
  FROM workflow_steps s
 WHERE NOT EXISTS (SELECT 1 FROM workflow_instances i WHERE i.id = s.instance_id)
 ORDER BY s.created_at DESC
 LIMIT 100;

-- 8b. A state or a domain outside the TypeScript vocabulary. There is no CHECK constraint on either
--     column (this project has no migration runner and cannot alter a CHECK), so this is the audit
--     that replaces it.
SELECT id, domain, state, created_at
  FROM workflow_instances
 WHERE state NOT IN ('draft', 'pending', 'approved', 'rejected', 'cancelled', 'halted')
    OR domain NOT IN ('leave', 'attendance', 'expenses', 'procurement', 'recruitment', 'travel');

-- 8c. A step decision outside the vocabulary, or a `via` that is not a relationship type.
SELECT id, instance_id, decision, via, acted_via
  FROM workflow_steps
 WHERE decision NOT IN ('pending', 'approved', 'rejected', 'skipped')
    OR (via IS NOT NULL AND via NOT IN
         ('reporting_manager', 'department_head', 'approval_owner', 'executive_sponsor'))
    OR (acted_via IS NOT NULL AND acted_via NOT IN ('routed', 'delegate', 'capability'));

-- 8d. Settled instances with no settled_at, and unsettled instances that have one. Both mean the
--     timeline lies about when a decision happened.
SELECT id, domain, state, settled_at
  FROM workflow_instances
 WHERE (state IN ('approved', 'rejected', 'cancelled') AND settled_at IS NULL)
    OR (state IN ('draft', 'pending', 'halted') AND settled_at IS NOT NULL);

-- 8e. A decided step with no decider, or an undecided step that has one.
SELECT id, instance_id, decision, decided_by_user_id, decided_at
  FROM workflow_steps
 WHERE (decision IN ('approved', 'rejected') AND (decided_by_user_id IS NULL OR decided_at IS NULL))
    OR (decision = 'pending' AND (decided_by_user_id IS NOT NULL OR decided_at IS NOT NULL));


-- ================================================================================================
-- SECTION 9 — THE LEAVE DOMAIN AGREES WITH ITSELF.  EXPECT ZERO ROWS.
--
-- Two paths can settle a leave request: the ordinary one (/admin/hr/leave -> decideLeave, enforced
-- by approverRole) and the workflow one. Both are guarded to touch only a leave row that is still
-- 'pending', so they cannot overwrite each other — this proves that held.
-- ================================================================================================

-- 9a. An APPROVED workflow whose leave request is still pending. Means the settlement write did not
--     land: read the log for '[workflow] settleDomainRecord'.
SELECT i.id AS instance_id, i.record_id, i.state AS workflow_state, l.status AS leave_status
  FROM workflow_instances i
  JOIN hr_leave_request l ON l.id::text = i.record_id
 WHERE i.domain = 'leave'
   AND i.state IN ('approved', 'rejected')
   AND l.status = 'pending';

-- 9b. A workflow still waiting on somebody for a leave request that has already been decided the
--     ordinary way. Harmless — the approvers should simply be told to stop waiting — but it is why
--     an approver would see a request in their queue that no longer needs them.
SELECT i.id AS instance_id, i.record_id, i.state AS workflow_state,
       l.status AS leave_status, l.decided_by_role
  FROM workflow_instances i
  JOIN hr_leave_request l ON l.id::text = i.record_id
 WHERE i.domain = 'leave'
   AND i.state = 'pending'
   AND l.status <> 'pending';

-- 9c. An instance pointing at a leave request that no longer exists.
SELECT i.id AS instance_id, i.record_id, i.state
  FROM workflow_instances i
 WHERE i.domain = 'leave'
   AND NOT EXISTS (SELECT 1 FROM hr_leave_request l WHERE l.id::text = i.record_id);
