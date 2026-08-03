-- ================================================================================================
-- db/org-graph-backfill.sql — SEED THE ORGANIZATION GRAPH FROM THE COLUMN IT REPLACES
--
-- WHO RUNS THIS: the founder, once, against production, after db/org-graph-schema.sql.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in Phase 3B connected to a database.
--
-- WHAT IT READS: hr_employees.reporting_manager_id — an existing DATA column, holding an id that an
-- administrator typed into the Employment tab of /admin/hr/employees/[id]. It is a per-ROW fact
-- ("this employee's manager is that person"), which is the same shape as a graph edge.
--
-- WHAT IT DOES NOT READ: users.role. A role name is a per-USER label; treating one as a
-- relationship is what makes every manager a manager of everyone, and it is exactly what Phase 1
-- removed. Reading the data column is a migration. Reading the role would be the regression.
-- (Department heads have no data column at all — see the note at the bottom of this file.)
--
-- IDEMPOTENT. Every INSERT carries a NOT EXISTS guard, so running it twice inserts nothing the
-- second time. It is safe to run again after fixing data and safe to run on a half-populated graph.
--
-- HOW TO RUN IT
--   1. Take a backup or a Supabase point-in-time restore marker. This writes rows.
--   2. psql "$DATABASE_URL" -f db/org-graph-schema.sql
--   3. psql "$DATABASE_URL" -f db/org-graph-backfill.sql
--   4. psql "$DATABASE_URL" -f db/org-graph-validate.sql      <- READ THE OUTPUT. Do not skip.
--   If step 4 shows cycles, orphans or unmapped managers, fix them and re-run 3 and 4.
--   To undo: db/org-graph-rollback.sql.
--
-- WHAT "DONE" LOOKS LIKE: validate.sql section 1 shows backfilled_edges equal to
-- employees_with_a_manager_column minus unmappable_manager_users, and sections 3-6 are all zero.
-- ================================================================================================

BEGIN;

-- ------------------------------------------------------------------------------------------------
-- STEP 0 — REFUSE TO RUN AGAINST A SCHEMA THAT IS NOT THERE.
--
-- Without this the whole file would "succeed" against a database that has no org_relationships
-- table, because every statement below would error out — and on this project a green message from a
-- script has been mistaken for work having happened more than once. Fail loudly instead.
-- ------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.org_relationships') IS NULL THEN
    RAISE EXCEPTION
      'org_relationships does not exist. Run db/org-graph-schema.sql first, then re-run this file.';
  END IF;
  IF to_regclass('public.hr_employees') IS NULL THEN
    RAISE EXCEPTION 'hr_employees does not exist. This is not the EduRankAI database.';
  END IF;
END $$;

-- Two admin pages ALTER this column in at page load, so on a database where neither has ever been
-- opened it can genuinely be absent — and the SELECT below NAMES it, which throws rather than
-- returning nothing. Assert it, harmlessly, before naming it.
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS reporting_manager_id UUID;


-- ------------------------------------------------------------------------------------------------
-- STEP 1 — THE REPORTING LINES.
--
-- THE ID-SPACE TRANSLATION, which is the whole difficulty of this file:
--   hr_employees.reporting_manager_id holds a USERS id (db/hr-schema.sql:114-118 says so, and
--   hr-wallet.ts approverRole() compares it to the signed-in user's id).
--   org_relationships.subject_employee_id holds an hr_employees id.
-- So every value has to be mapped users.id -> hr_employees.user_id -> hr_employees.id. A manager
-- who is a user WITHOUT an employee record cannot be represented as a graph edge at all; those rows
-- are skipped here and COUNTED by db/org-graph-validate.sql section 2, so they are visible rather
-- than silently lost. Until they are given employee records, the compatibility layer in
-- src/lib/org-graph.ts still answers for them.
--
-- LATERAL ... LIMIT 1 rather than a plain JOIN: one user CAN have more than one hr_employees row
-- (rehires, duplicates), and a plain join would emit one edge per duplicate and collide with the
-- one-open-manager unique index. Prefer the active, earliest row and take exactly one.
--
-- effective_from is the person's joining date where we know it, because that is when the reporting
-- line actually began. Falling back to created_at, then to now(). This is a REASONABLE
-- RECONSTRUCTION, not a recovered fact: the old column was mutated in place, so the true history is
-- gone and cannot be recovered by anything. Every row is stamped so that is never mistaken later.
-- ------------------------------------------------------------------------------------------------
INSERT INTO org_relationships
  (type, subject_employee_id, object_employee_id, scope_type, scope_id,
   effective_from, effective_to, status, created_by, note)
SELECT 'reporting_manager',
       mgr.id,
       e.id,
       NULL,
       NULL,
       COALESCE(e.joining_date::timestamptz, e.created_at, NOW()),
       NULL,
       'active',
       NULL,
       'backfill:reporting_manager_id'
  FROM hr_employees e
  CROSS JOIN LATERAL (
    SELECT m.id
      FROM hr_employees m
     WHERE m.user_id = e.reporting_manager_id
     ORDER BY m.is_active DESC, m.created_at ASC
     LIMIT 1
  ) mgr
 WHERE e.reporting_manager_id IS NOT NULL
   -- A row that says somebody manages themselves is corrupt data, not a relationship. The table's
   -- CHECK constraint would reject it and abort the whole backfill, so filter it out here and let
   -- validate.sql section 2 report it.
   AND mgr.id <> e.id
   AND NOT EXISTS (
     SELECT 1
       FROM org_relationships r
      WHERE r.type = 'reporting_manager'
        AND r.object_employee_id = e.id
        AND r.status = 'active'
        AND r.effective_to IS NULL
   );


-- ------------------------------------------------------------------------------------------------
-- STEP 2 — THE PRIMARY DEPARTMENT ASSIGNMENTS.
--
-- hr_employees.department_id is read as ::text and written to a TEXT column. Never ::uuid:
-- departments.id is varchar(50) — a slug — in src/lib/db/schema.ts:80 and UUID in
-- db/hr-schema.sql:31, so the same logical value has two types in this product and a cast would
-- throw on half of them.
--
-- This gives org_employee_assignments its starting state so that "which department was she in when
-- this was approved" becomes answerable from the day the graph goes live, rather than from whenever
-- somebody first edits a record.
-- ------------------------------------------------------------------------------------------------
INSERT INTO org_employee_assignments
  (employee_id, position_id, team_id, department_id, allocation_pct, is_primary,
   effective_from, effective_to, status, created_by)
SELECT e.id,
       NULL,
       NULL,
       e.department_id::text,
       100,
       TRUE,
       COALESCE(e.joining_date::timestamptz, e.created_at, NOW()),
       NULL,
       'active',
       NULL
  FROM hr_employees e
 WHERE e.department_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM org_employee_assignments a
      WHERE a.employee_id = e.id
        AND a.is_primary = TRUE
        AND a.status = 'active'
        AND a.effective_to IS NULL
   );


-- ------------------------------------------------------------------------------------------------
-- STEP 3 — OPTIONAL. CLOSE THE LINES OF PEOPLE WHO HAVE LEFT.
--
-- Leaving a departed employee's reporting edge open is not dangerous — their hr_employees row is
-- inactive and no screen routes work to them — but it makes the org chart wrong, and "who did she
-- report to when she left" is a real question during an exit audit.
--
-- THE GUARD MATTERS: the table's CHECK requires effective_to > effective_from, and exit dates
-- earlier than joining dates DO occur in hand-entered HR data. Without the comparison in the WHERE
-- clause, one bad row aborts the whole statement. Rows that fail it keep an open edge and are
-- reported by validate.sql rather than silently skipped.
--
-- This step is separated so it can be skipped. Everything above is a faithful translation of
-- existing data; this one makes a judgement about what an exit date means.
-- ------------------------------------------------------------------------------------------------
UPDATE org_relationships r
   SET effective_to = x.ended_at
  FROM (
    SELECT e.id AS employee_id,
           COALESCE(e.last_working_day::timestamptz, e.exit_date::timestamptz) AS ended_at
      FROM hr_employees e
     WHERE e.is_active = FALSE
       AND COALESCE(e.last_working_day, e.exit_date) IS NOT NULL
  ) x
 WHERE r.type = 'reporting_manager'
   AND r.object_employee_id = x.employee_id
   AND r.status = 'active'
   AND r.effective_to IS NULL
   AND x.ended_at > r.effective_from;

COMMIT;


-- ================================================================================================
-- WHAT THIS FILE DELIBERATELY DOES NOT BACKFILL
--
-- DEPARTMENT HEADS. There is no data column for them anywhere: `departments` carries no head in
-- src/lib/db/schema.ts:80-90 (id, name, icon, description, ...) and none in db/hr-schema.sql:31-38
-- (id, name, code, description, is_active, created_at). The only signal in the product is the PAIR
-- users.role = 'department_head' + users.assigned_department_id — and the leadership half of that
-- pair is a ROLE NAME.
--
-- Translating that pair into department_head edges is a defensible ONE-TIME MIGRATION (it is the
-- sequence src/lib/auth/permissions.ts recommends, and it preserves the existing population
-- exactly, widening nothing). It is NOT a runtime fallback, and the difference is the whole point:
-- a migration is a deliberate act by the founder, once, whose result is then visible and editable
-- as data; a fallback is code that silently re-derives authority from a label on every request.
--
-- Because that distinction is easy to lose, it is NOT in this file. It ships as
-- db/org-graph-backfill-department-heads.sql, so running it is a separate, deliberate decision with
-- its own reasoning attached.
--
-- MENTORS, REVIEWERS, PROJECT AND FUNCTIONAL MANAGERS, DELEGATES, SPONSORS. There is no data for
-- these anywhere in the product — not a column, not a table, not a role. They start empty and get
-- entered through the admin surface a later phase will build. An org graph that invented them would
-- be worse than one that admits it does not know.
-- ================================================================================================
