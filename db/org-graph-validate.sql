-- ================================================================================================
-- db/org-graph-validate.sql — READ-ONLY. Prove the graph is right, or find out how it is wrong.
--
-- WHO RUNS THIS: the founder, after every backfill and whenever the org chart looks wrong.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in Phase 3B connected to a database.
--
-- NOT ONE STATEMENT IN THIS FILE WRITES. No INSERT, no UPDATE, no DELETE, no DDL. It is safe to run
-- against production at any time, including in the middle of a working day.
--
--     psql "$DATABASE_URL" -f db/org-graph-validate.sql
--
-- HOW TO READ THE OUTPUT
--   Section 1  counts. Compare them; they should reconcile.
--   Sections 2-7 are FAULT REPORTS. EVERY ONE OF THEM SHOULD RETURN ZERO ROWS.
--   Any row returned by sections 2-7 is a defect in the data. None of them are fatal to the
--   application — src/lib/org-graph.ts fails closed on all of them, so the visible symptom is a
--   missing relationship rather than a wrong one — but each is a person the org chart is lying
--   about, and cycles are the one that can make a request hang if the code's guards are ever
--   removed.
--
-- WHY THIS FILE HAS TO EXIST AT ALL: the overlap invariants are enforced by PARTIAL UNIQUE INDEXES
-- over the OPEN rows, which cannot see two CLOSED rows overlapping in the past. A full bitemporal
-- design with btree_gist EXCLUDE constraints would have caught those in the database — and is not
-- available on a Supabase transaction pooler with self-bootstrapping DDL. Section 5 is the honest
-- replacement for the constraint that could not be built.
-- ================================================================================================


-- ================================================================================================
-- SECTION 1 — RECONCILIATION COUNTS
--
-- WHAT SHOULD BE TRUE:
--   open_reporting_edges  =  employees_with_manager_column
--                            - managers_without_employee_row
--                            - self_referencing_rows
--                            - closed_because_employee_left        (step 3 of the backfill)
-- If it does not reconcile, sections 2 and 3 say why.
-- ================================================================================================
SELECT
  (SELECT COUNT(*) FROM hr_employees)                                       AS employees_total,
  (SELECT COUNT(*) FROM hr_employees WHERE is_active = TRUE)                AS employees_active,
  (SELECT COUNT(*) FROM hr_employees WHERE reporting_manager_id IS NOT NULL)
                                                                            AS employees_with_manager_column,
  (SELECT COUNT(*) FROM org_relationships)                                  AS graph_rows_total,
  (SELECT COUNT(*) FROM org_relationships WHERE status = 'active')          AS graph_rows_active,
  (SELECT COUNT(*) FROM org_relationships WHERE status = 'revoked')         AS graph_rows_revoked,
  (SELECT COUNT(*) FROM org_relationships
    WHERE type = 'reporting_manager' AND status = 'active' AND effective_to IS NULL)
                                                                            AS open_reporting_edges,
  (SELECT COUNT(*) FROM org_relationships
    WHERE type = 'reporting_manager' AND status = 'active' AND effective_to IS NOT NULL)
                                                                            AS closed_reporting_edges,
  (SELECT COUNT(*) FROM org_relationships
    WHERE type = 'department_head' AND status = 'active' AND effective_to IS NULL)
                                                                            AS open_department_heads,
  (SELECT COUNT(*) FROM org_employee_assignments
    WHERE is_primary = TRUE AND status = 'active' AND effective_to IS NULL)
                                                                            AS open_primary_assignments;

-- Breakdown by relationship type, so an unexpected type shows up as a name nobody recognises.
SELECT type,
       COUNT(*)                                                       AS rows_total,
       COUNT(*) FILTER (WHERE status = 'active' AND effective_to IS NULL)  AS open_now,
       COUNT(*) FILTER (WHERE status = 'active' AND effective_to IS NOT NULL) AS closed_history,
       COUNT(*) FILTER (WHERE status = 'revoked')                      AS revoked
  FROM org_relationships
 GROUP BY type
 ORDER BY rows_total DESC;

-- IS THE GRAPH INITIALISED AT ALL? This is the same question src/lib/org-graph.ts isInitialized()
-- asks. FALSE means every consumer is still rendering "Organization Graph not yet initialized" and
-- the compatibility layer is still reading the legacy column.
SELECT EXISTS (SELECT 1 FROM org_relationships WHERE status = 'active') AS graph_is_initialized;


-- ================================================================================================
-- SECTION 2 — WHAT THE BACKFILL COULD NOT REPRESENT. Expect zero rows.
--
-- These are not corruption. They are people the graph cannot describe yet, and until they are fixed
-- the compatibility layer in src/lib/org-graph.ts is still answering for them from the legacy
-- column. THE COMPATIBILITY LAYER CANNOT BE DELETED WHILE THIS SECTION RETURNS ROWS.
-- ================================================================================================

-- 2a. The manager named in reporting_manager_id is a USER with no hr_employees row, so there is no
--     employee id to point an edge at. Fix: give them an employee record, then re-run the backfill.
SELECT e.id          AS employee_id,
       e.full_name   AS employee_name,
       e.reporting_manager_id AS manager_user_id,
       u.email       AS manager_email,
       'manager user has no hr_employees row' AS problem
  FROM hr_employees e
  LEFT JOIN users u ON u.id = e.reporting_manager_id
 WHERE e.reporting_manager_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM hr_employees m WHERE m.user_id = e.reporting_manager_id);

-- 2b. reporting_manager_id points at a users row that does not exist at all. A dangling id; the
--     column has no foreign key.
SELECT e.id        AS employee_id,
       e.full_name AS employee_name,
       e.reporting_manager_id AS manager_user_id,
       'reporting_manager_id matches no users row' AS problem
  FROM hr_employees e
 WHERE e.reporting_manager_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.reporting_manager_id);

-- 2c. Somebody is recorded as their own manager. Filtered out by the backfill (the table's CHECK
--     would reject it), so it exists only in the legacy column.
SELECT e.id        AS employee_id,
       e.full_name AS employee_name,
       'employee is their own reporting manager' AS problem
  FROM hr_employees e
 WHERE e.reporting_manager_id IS NOT NULL
   AND e.reporting_manager_id = e.user_id;

-- 2d. Has a manager in the column but no open edge in the graph. If 2a-2c are empty and this is
--     not, the backfill did not finish — re-run db/org-graph-backfill.sql.
SELECT e.id        AS employee_id,
       e.full_name AS employee_name,
       'has legacy manager but no open graph edge' AS problem
  FROM hr_employees e
 WHERE e.reporting_manager_id IS NOT NULL
   AND e.is_active = TRUE
   AND EXISTS (SELECT 1 FROM hr_employees m WHERE m.user_id = e.reporting_manager_id)
   AND NOT EXISTS (
     SELECT 1 FROM org_relationships r
      WHERE r.type = 'reporting_manager'
        AND r.object_employee_id = e.id
        AND r.status = 'active'
        AND r.effective_to IS NULL
   );


-- ================================================================================================
-- SECTION 3 — ORPHANS. Expect zero rows.
--
-- There is no foreign key to hr_employees, deliberately: history must outlive a deleted row. The
-- price of that decision is that orphans have to be looked for, which is what this section is.
-- An orphaned edge is not dangerous — the resolvers INNER JOIN hr_employees, so an edge pointing at
-- nobody simply returns nobody — but it is dead weight and it makes the counts in section 1 fail to
-- reconcile.
-- ================================================================================================
SELECT r.id, r.type, r.subject_employee_id, r.object_employee_id, r.status,
       'subject_employee_id matches no hr_employees row' AS problem
  FROM org_relationships r
 WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id = r.subject_employee_id);

SELECT r.id, r.type, r.subject_employee_id, r.object_employee_id, r.status,
       'object_employee_id matches no hr_employees row' AS problem
  FROM org_relationships r
 WHERE r.object_employee_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id = r.object_employee_id);

SELECT a.id, a.employee_id, a.status,
       'assignment employee_id matches no hr_employees row' AS problem
  FROM org_employee_assignments a
 WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id = a.employee_id);


-- ================================================================================================
-- SECTION 4 — CYCLES IN THE REPORTING LINE. Expect zero rows.
--
-- THE ONE THAT MATTERS MOST. A -> B -> A makes "walk up the reporting line" a walk that never ends.
-- src/lib/org-graph.ts guards against it three separate ways (a visited-path array in the recursive
-- query, a hard depth cap, and a de-duplicating loop in TypeScript), so a cycle in production will
-- NOT hang a request today — it truncates the chain instead. It will still show a person as their
-- own manager's manager, which is nonsense on a screen and wrong in an approval route.
--
-- The walk below carries the path it has taken and REPORTS the hop that re-enters it, rather than
-- refusing it, which is how the offending edge gets named. Depth is capped at 20 so this query is
-- itself safe to run against corrupt data.
-- ================================================================================================
WITH RECURSIVE walk AS (
  SELECT r.object_employee_id  AS start_id,
         r.subject_employee_id AS node_id,
         1                     AS depth,
         ARRAY[r.object_employee_id, r.subject_employee_id] AS path
    FROM org_relationships r
   WHERE r.type = 'reporting_manager'
     AND r.status = 'active'
     AND r.effective_to IS NULL
     AND r.object_employee_id IS NOT NULL
  UNION ALL
  SELECT w.start_id,
         r.subject_employee_id,
         w.depth + 1,
         w.path || r.subject_employee_id
    FROM walk w
    JOIN org_relationships r ON r.object_employee_id = w.node_id
   WHERE r.type = 'reporting_manager'
     AND r.status = 'active'
     AND r.effective_to IS NULL
     AND w.depth < 20
     AND NOT (r.subject_employee_id = ANY(w.path))
)
SELECT DISTINCT
       w.start_id                AS chain_started_at_employee,
       w.node_id                 AS reached_employee,
       r.subject_employee_id     AS loops_back_to_employee,
       w.depth                   AS depth_when_detected,
       'CYCLE in the reporting line' AS problem
  FROM walk w
  JOIN org_relationships r ON r.object_employee_id = w.node_id
 WHERE r.type = 'reporting_manager'
   AND r.status = 'active'
   AND r.effective_to IS NULL
   AND r.subject_employee_id = ANY(w.path);

-- Chains that hit the code's depth cap. Not necessarily a fault — a genuinely deep organisation is
-- possible — but if MAX_CHAIN_DEPTH (12, in src/lib/org-graph.ts) is ever exceeded, getReportingChain()
-- silently returns a TRUNCATED line, and a truncated line looks exactly like a complete one on a
-- screen. Anything listed here needs either a data fix or a considered raise of that constant.
WITH RECURSIVE walk AS (
  SELECT r.object_employee_id  AS start_id,
         r.subject_employee_id AS node_id,
         1                     AS depth,
         ARRAY[r.object_employee_id, r.subject_employee_id] AS path
    FROM org_relationships r
   WHERE r.type = 'reporting_manager'
     AND r.status = 'active'
     AND r.effective_to IS NULL
     AND r.object_employee_id IS NOT NULL
  UNION ALL
  SELECT w.start_id, r.subject_employee_id, w.depth + 1, w.path || r.subject_employee_id
    FROM walk w
    JOIN org_relationships r ON r.object_employee_id = w.node_id
   WHERE r.type = 'reporting_manager'
     AND r.status = 'active'
     AND r.effective_to IS NULL
     AND w.depth < 20
     AND NOT (r.subject_employee_id = ANY(w.path))
)
SELECT start_id AS employee_id,
       MAX(depth) AS chain_depth,
       'chain deeper than MAX_CHAIN_DEPTH (12) - getReportingChain will truncate' AS problem
  FROM walk
 GROUP BY start_id
HAVING MAX(depth) > 12;


-- ================================================================================================
-- SECTION 5 — OVERLAPPING HISTORY. Expect zero rows.
--
-- THIS IS THE CHECK THAT REPLACES A CONSTRAINT WE COULD NOT BUILD. A full bitemporal design would
-- have an EXCLUDE constraint over tstzrange preventing two edges of the same kind from being in
-- force at the same time — including in the past. That needs btree_gist, which a Supabase
-- transaction-pooler connection with self-bootstrapping DDL cannot create. The partial unique
-- indexes that were built instead only constrain the OPEN rows.
--
-- So retroactive overlaps are possible, and this is where they surface. An overlap means "who was
-- the manager on 12 March" has two answers, and getManager() picks the most recently started one —
-- an arbitrary answer presented as a definite one, on an audit screen. That is the failure mode
-- worth catching by hand.
-- ================================================================================================
SELECT a.object_employee_id AS employee_id,
       a.id                 AS edge_a,
       b.id                 AS edge_b,
       a.subject_employee_id AS manager_a,
       b.subject_employee_id AS manager_b,
       a.effective_from      AS a_from,
       a.effective_to        AS a_to,
       b.effective_from      AS b_from,
       b.effective_to        AS b_to,
       'two reporting managers in force at the same time' AS problem
  FROM org_relationships a
  JOIN org_relationships b
    ON b.object_employee_id = a.object_employee_id
   AND b.id > a.id
 WHERE a.type = 'reporting_manager' AND b.type = 'reporting_manager'
   AND a.status = 'active' AND b.status = 'active'
   AND a.effective_from < COALESCE(b.effective_to, 'infinity'::timestamptz)
   AND b.effective_from < COALESCE(a.effective_to, 'infinity'::timestamptz);

SELECT a.scope_id AS department_id,
       a.id AS edge_a, b.id AS edge_b,
       a.subject_employee_id AS head_a, b.subject_employee_id AS head_b,
       a.effective_from AS a_from, a.effective_to AS a_to,
       b.effective_from AS b_from, b.effective_to AS b_to,
       'two department heads in force at the same time' AS problem
  FROM org_relationships a
  JOIN org_relationships b
    ON b.scope_id = a.scope_id
   AND b.id > a.id
 WHERE a.type = 'department_head' AND b.type = 'department_head'
   AND a.scope_type = 'department' AND b.scope_type = 'department'
   AND a.status = 'active' AND b.status = 'active'
   AND a.effective_from < COALESCE(b.effective_to, 'infinity'::timestamptz)
   AND b.effective_from < COALESCE(a.effective_to, 'infinity'::timestamptz);

SELECT a.employee_id,
       a.id AS assignment_a, b.id AS assignment_b,
       a.department_id AS dept_a, b.department_id AS dept_b,
       'two primary assignments in force at the same time' AS problem
  FROM org_employee_assignments a
  JOIN org_employee_assignments b
    ON b.employee_id = a.employee_id
   AND b.id > a.id
 WHERE a.is_primary = TRUE AND b.is_primary = TRUE
   AND a.status = 'active' AND b.status = 'active'
   AND a.effective_from < COALESCE(b.effective_to, 'infinity'::timestamptz)
   AND b.effective_from < COALESCE(a.effective_to, 'infinity'::timestamptz);


-- ================================================================================================
-- SECTION 6 — VOCABULARY DRIFT. Expect zero rows.
--
-- `type`, `status` and `scope_type` have no CHECK constraints, deliberately: a CHECK cannot be
-- altered by CREATE/ADD IF NOT EXISTS, and this project has no migration runner, so adding a
-- relationship type later would be impossible. The vocabulary is enforced in TypeScript and audited
-- here. Anything this returns was written by something that bypassed src/lib/org-graph.ts.
--
-- 'superseded' APPEARING AS A STATUS IS THE ONE TO WORRY ABOUT. It would mean somebody closed an
-- edge by changing its status instead of setting effective_to — which removes it from every
-- historical query and destroys exactly the audit trail this table exists to keep. Superseding sets
-- effective_to and LEAVES status = 'active'.
-- ================================================================================================
SELECT DISTINCT type, COUNT(*) OVER (PARTITION BY type) AS rows_affected,
       'relationship type outside ORG_RELATIONSHIP_TYPES' AS problem
  FROM org_relationships
 WHERE type NOT IN (
   'reporting_manager', 'department_head', 'team_lead', 'functional_manager', 'project_manager',
   'mentor', 'reviewer', 'executive_sponsor', 'temporary_delegate', 'approval_owner'
 );

SELECT DISTINCT status, COUNT(*) OVER (PARTITION BY status) AS rows_affected,
       'status is neither active nor revoked' AS problem
  FROM org_relationships
 WHERE status NOT IN ('active', 'revoked');

SELECT DISTINCT scope_type, COUNT(*) OVER (PARTITION BY scope_type) AS rows_affected,
       'scope_type outside ORG_SCOPE_TYPES' AS problem
  FROM org_relationships
 WHERE scope_type IS NOT NULL
   AND scope_type NOT IN ('global', 'department', 'team', 'project', 'position', 'approval_domain');


-- ================================================================================================
-- SECTION 7 — SHAPE FAULTS. Expect zero rows.
--
-- Rows that are internally inconsistent: a relationship pointing at nothing, or a scoped
-- relationship with no scope. These resolve to nobody rather than to the wrong person, so they are
-- clutter rather than danger — but each one is a relationship somebody meant to record and did not.
-- ================================================================================================
SELECT id, type, subject_employee_id, scope_type, scope_id,
       'relationship has neither an object nor a scope - it points at nothing' AS problem
  FROM org_relationships
 WHERE object_employee_id IS NULL
   AND (scope_id IS NULL OR scope_id = '');

SELECT id, type, scope_type, scope_id,
       'department_head with no department in scope_id' AS problem
  FROM org_relationships
 WHERE type = 'department_head'
   AND (scope_type IS DISTINCT FROM 'department' OR scope_id IS NULL OR scope_id = '');

SELECT id, type, scope_type, scope_id,
       'approval_owner with no domain in scope_id' AS problem
  FROM org_relationships
 WHERE type = 'approval_owner'
   AND (scope_type IS DISTINCT FROM 'approval_domain' OR scope_id IS NULL OR scope_id = '');

SELECT id, type, effective_from, effective_to,
       'effective_to is not after effective_from' AS problem
  FROM org_relationships
 WHERE effective_to IS NOT NULL
   AND effective_to <= effective_from;

-- A department scope_id that matches no department in EITHER schema. departments.id is varchar(50)
-- in src/lib/db/schema.ts and UUID in db/hr-schema.sql; whichever this database has, the comparison
-- is ::text. Never ::uuid — a cast throws on a slug.
SELECT r.id, r.scope_id,
       'department_head scoped to a department id that does not exist' AS problem
  FROM org_relationships r
 WHERE r.type = 'department_head'
   AND r.scope_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id::text = r.scope_id);


-- ================================================================================================
-- SECTION 8 — DRIFT BETWEEN THE GRAPH AND THE COLUMN IT REPLACES.
--
-- Once both exist they can disagree, because the admin Employment tab still writes the column and
-- nothing yet writes the graph. Rows here are not errors — they are the measure of how stale the
-- legacy column has become, and the list of records to reconcile before the column is dropped.
--
-- THE COMPARISON IS user id TO user id. hr_employees.reporting_manager_id holds a USERS id, so it is
-- compared against the graph manager's user_id and NOT against their employee id. Getting that
-- backwards would report every single row as drift and look like a catastrophe.
-- ================================================================================================
SELECT e.id                      AS employee_id,
       e.full_name               AS employee_name,
       e.reporting_manager_id    AS column_says_user_id,
       mgr.user_id               AS graph_says_user_id,
       mgr.full_name             AS graph_says_name,
       'graph and legacy column disagree' AS note
  FROM hr_employees e
  JOIN org_relationships r
    ON r.type = 'reporting_manager'
   AND r.object_employee_id = e.id
   AND r.status = 'active'
   AND r.effective_to IS NULL
  JOIN hr_employees mgr ON mgr.id = r.subject_employee_id
 WHERE e.reporting_manager_id IS DISTINCT FROM mgr.user_id;
