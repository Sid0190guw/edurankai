-- ================================================================================================
-- db/org-graph-backfill-department-heads.sql — OPTIONAL, DELIBERATE, ONE-TIME.
--
-- WHO RUNS THIS: the founder, once, and only after reading the whole of the next section.
-- WHO DOES NOT RUN THIS: the agent that wrote it.
--
-- THIS FILE IS SEPARATE FROM db/org-graph-backfill.sql ON PURPOSE. Everything in that file
-- translates an existing DATA column. This one translates a ROLE NAME, once, into data — and the
-- difference between doing that as a migration and doing it as a fallback is the entire subject of
-- Phase 1. Keeping them in one file would have made running it look automatic.
-- ================================================================================================
--
-- THE SITUATION
--
-- EduRankAI has no department-head data anywhere. `departments` carries no head column: in
-- src/lib/db/schema.ts:80-90 it is (id, name, icon, description, is_flagship, sort_order,
-- is_visible, ...) and in db/hr-schema.sql:31-38 it is (id, name, code, description, is_active,
-- created_at). Neither has one.
--
-- The ONLY signal that exists is the PAIR written together by /admin/users:
--     users.role = 'department_head'  +  users.assigned_department_id
-- The first half is a role name. The second half is genuinely per-row scoping data.
--
-- WHY TRANSLATING IT IS ACCEPTABLE — AND WHY READING IT AT RUNTIME IS NOT
--
--   A MIGRATION is a deliberate act, performed once, by a person, whose output is ordinary data:
--   rows in org_relationships that can be inspected, corrected, superseded and audited. After it
--   runs, the role name is no longer consulted by anything. If the founder later changes somebody's
--   role, the graph does not silently follow — which is correct, because heading a department is a
--   fact about an organisation, not a property of a login.
--
--   A FALLBACK is code that re-derives authority from a label on every request. It cannot be
--   inspected, cannot be corrected without changing the person's login role, and it looks like it
--   works. src/lib/org-graph.ts contains none and must never contain one: when the graph has no
--   data the honest answer is isInitialized() === false, rendered as "Organization Graph not yet
--   initialized".
--
-- THIS WIDENS NOTHING. The set of (user, department) pairs it inserts is exactly the set that
-- /admin/users has already recorded. Nobody gains a department they did not already have assigned,
-- and nobody loses one. That property is the reason it is safe to run at all — verify it with
-- section A below BEFORE running section B.
--
-- WHAT IT CANNOT DO: a head who has no hr_employees row cannot become an edge, because the graph is
-- keyed on employee ids. Section A counts them. Give them employee records, or record their
-- headship by hand through the admin surface, and re-run — this file is idempotent.
--
-- HOW TO RUN
--   1. psql "$DATABASE_URL" -f db/org-graph-schema.sql      (if not already done)
--   2. Run SECTION A alone and READ IT. It changes nothing.
--   3. Only if section A looks right, run SECTION B.
--   4. psql "$DATABASE_URL" -f db/org-graph-validate.sql
-- ================================================================================================


-- ================================================================================================
-- SECTION A — DRY RUN. Read-only. Shows exactly what section B would insert, and what it cannot.
-- ================================================================================================

-- A1. The pairs that WILL become department_head edges.
SELECT u.id            AS user_id,
       u.email         AS email,
       emp.id          AS employee_id,
       emp.full_name   AS full_name,
       u.assigned_department_id::text AS department_id,
       'WILL INSERT'   AS outcome
  FROM users u
  CROSS JOIN LATERAL (
    SELECT m.id, m.full_name
      FROM hr_employees m
     WHERE m.user_id = u.id
     ORDER BY m.is_active DESC, m.created_at ASC
     LIMIT 1
  ) emp
 WHERE u.role::text = 'department_head'
   AND u.assigned_department_id IS NOT NULL
   AND u.is_active = TRUE
 ORDER BY u.assigned_department_id::text;

-- A2. The pairs that CANNOT be represented: an assigned department but no employee record. These
-- are silently lost by section B, which is why they are listed here instead.
SELECT u.id    AS user_id,
       u.email AS email,
       u.assigned_department_id::text AS department_id,
       'NO hr_employees ROW - CANNOT INSERT' AS outcome
  FROM users u
 WHERE u.role::text = 'department_head'
   AND u.assigned_department_id IS NOT NULL
   AND u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM hr_employees m WHERE m.user_id = u.id);

-- A3. Departments that would end up with MORE THAN ONE head. The one-open-head-per-department
-- partial unique index will reject the second, aborting section B. Resolve these first.
SELECT u.assigned_department_id::text AS department_id,
       COUNT(*) AS heads,
       'MORE THAN ONE HEAD - SECTION B WILL FAIL' AS outcome
  FROM users u
 WHERE u.role::text = 'department_head'
   AND u.assigned_department_id IS NOT NULL
   AND u.is_active = TRUE
   AND EXISTS (SELECT 1 FROM hr_employees m WHERE m.user_id = u.id)
 GROUP BY u.assigned_department_id::text
HAVING COUNT(*) > 1;


-- ================================================================================================
-- SECTION B — THE WRITE. Idempotent: the NOT EXISTS guard means a second run inserts nothing.
--
-- DO NOT RUN THIS UNTIL SECTION A3 RETURNS NO ROWS.
-- ================================================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.org_relationships') IS NULL THEN
    RAISE EXCEPTION
      'org_relationships does not exist. Run db/org-graph-schema.sql first.';
  END IF;
END $$;

INSERT INTO org_relationships
  (type, subject_employee_id, object_employee_id, scope_type, scope_id,
   effective_from, effective_to, status, created_by, note)
SELECT 'department_head',
       emp.id,
       NULL,                                   -- a head heads a DEPARTMENT, not one named person
       'department',
       u.assigned_department_id::text,         -- TEXT. departments.id is a slug in one schema file
                                               -- and a uuid in the other; never cast it to ::uuid.
       COALESCE(emp.joining_date::timestamptz, u.created_at, NOW()),
       NULL,
       'active',
       NULL,
       'backfill:users.assigned_department_id (one-time migration, see file header)'
  FROM users u
  CROSS JOIN LATERAL (
    SELECT m.id, m.joining_date
      FROM hr_employees m
     WHERE m.user_id = u.id
     ORDER BY m.is_active DESC, m.created_at ASC
     LIMIT 1
  ) emp
 WHERE u.role::text = 'department_head'
   AND u.assigned_department_id IS NOT NULL
   AND u.is_active = TRUE
   AND NOT EXISTS (
     SELECT 1
       FROM org_relationships r
      WHERE r.type = 'department_head'
        AND r.scope_type = 'department'
        AND r.scope_id = u.assigned_department_id::text
        AND r.status = 'active'
        AND r.effective_to IS NULL
   );

COMMIT;

-- ================================================================================================
-- AFTER THIS RUNS
--
-- The graph, not users.role, is the answer to "who heads this department". src/lib/org-graph.ts
-- getDepartmentHead() / isDepartmentHead() read it and read nothing else.
--
-- The `department.lead` capability in src/lib/auth/permissions.ts can now be retired, because the
-- reason it survived — "THE ORGANISATIONAL DATA DOES NOT EXIST", stated in that file — has stopped
-- being true. That is a separate change in a separate phase, and it must keep the population
-- identical at every step: point requireTeamLead() at isDepartmentHead() FIRST, verify on the live
-- site that the same people can still open the same screens, and only then delete the key.
-- ================================================================================================
