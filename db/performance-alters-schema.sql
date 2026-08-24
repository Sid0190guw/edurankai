-- db/performance-alters-schema.sql
-- THE 27 COLUMNS THE APPRAISAL SCREENS WRITE, AND THE ONLY FILE THAT RECORDS THEM.
--
-- READ THIS HEADER BEFORE RUNNING ANY OF IT. This is the one file in db/ that is NOT safe to paste
-- in one go, and the reason is mechanical rather than cautious.
--
-- ============================================================================================
-- WHY THIS IS DIFFERENT FROM EVERY OTHER FILE HERE
-- ============================================================================================
--
-- Every other db/*.sql on this project is CREATE TABLE / CREATE INDEX IF NOT EXISTS. Those take
-- locks nobody is waiting on: the object does not exist yet, so no reader can be queued behind it.
--
-- ALTER TABLE takes ACCESS EXCLUSIVE on a table that IS being read. It waits for the queries already
-- in flight — and while it waits, every NEW read of that table queues behind it, because a pending
-- exclusive lock is granted ahead of shared locks requested after it. That is not a theory here: on
-- 2026-08-23 eighteen ALTERs against `roles` on the /careers request path took the site down, four
-- of twenty concurrent requests answered and sixteen returned nothing. It is why production stopped
-- running request-path DDL at all, and why src/lib/ensure-once.ts defaults to off.
--
-- On these three tables the ALTER itself is instant — hr_performance_reviews and hr_review_cycles
-- are near-empty. ALL of the risk is in waiting for a lock, and all of the mitigation is in bounding
-- that wait and choosing the moment.
--
-- ============================================================================================
-- WHY THE COLUMNS ARE MISSING AT ALL
-- ============================================================================================
--
-- src/lib/performance-schema.ts holds PERFORMANCE_DDL, one array run in order by ensureBatch(). It
-- stops at the first failure and ensureOnce() swallows the error. The live database, enumerated
-- 2026-08-24, shows exactly where it stopped: hr_goal_key_results (statement 2) exists, and
-- hr_feedback — the first statement AFTER the ALTER block below — did not, along with everything
-- under it. The batch died somewhere in these 27 statements and nobody was told, which is how a
-- module ends up half created.
--
-- db/performance-remainder-schema.sql already recovered the tables. This file is the other half:
-- the columns. Nothing has ever recorded them outside the TypeScript array, so a database rebuilt
-- from db/*.sql — which is what the 2026-08-24 migration was — would not have them, and no
-- table-presence check can see the gap. BOOTSTRAP_MODULES queries information_schema.tables; a
-- parent table that exists while its written columns do not passes every check this project has.

-- ============================================================================================
-- STEP 1. FIND OUT WHICH ARE ACTUALLY MISSING. Read-only, safe, takes no lock. Run this first.
--
-- It returns one row per column that the code writes and the database does not have. If it returns
-- nothing, stop — the batch got further than expected and there is no work to do.
-- ============================================================================================

WITH expected(tbl, col) AS (VALUES
  ('hr_employee_goals','period_label'), ('hr_employee_goals','period_start'),
  ('hr_employee_goals','period_end'), ('hr_employee_goals','progress_pct'),
  ('hr_employee_goals','owner_user_id'), ('hr_employee_goals','visibility'),
  ('hr_employee_goals','last_progress_at'),
  ('hr_review_cycles','stage'), ('hr_review_cycles','self_due_on'),
  ('hr_review_cycles','manager_due_on'), ('hr_review_cycles','calibration_due_on'),
  ('hr_performance_reviews','self_assessment'), ('hr_performance_reviews','self_rating'),
  ('hr_performance_reviews','self_submitted_at'), ('hr_performance_reviews','manager_employee_id'),
  ('hr_performance_reviews','manager_submitted_at'), ('hr_performance_reviews','calibrated_rating'),
  ('hr_performance_reviews','calibration_note'), ('hr_performance_reviews','calibrated_by_user_id'),
  ('hr_performance_reviews','calibrated_at'), ('hr_performance_reviews','outcome'),
  ('hr_performance_reviews','outcome_note'), ('hr_performance_reviews','shared_with_employee_at'),
  ('hr_performance_reviews','workflow_instance_id'), ('hr_performance_reviews','proposed_designation'),
  ('hr_performance_reviews','promotion_justification'), ('hr_performance_reviews','promotion_workflow_id')
)
SELECT e.tbl AS missing_from_table, e.col AS missing_column
  FROM expected e
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
 WHERE c.column_name IS NULL
 ORDER BY e.tbl, e.col;

-- ============================================================================================
-- STEP 2. ADD THEM. Run ONLY the lines Step 1 named, ONE AT A TIME, when /admin/hr is idle.
--
-- SET THE BOUND FIRST, in the same session, before any ALTER below:
--
--     SET lock_timeout = '3s';
--
-- With that set, an ALTER that cannot get its lock inside three seconds FAILS instead of building a
-- queue behind it. Failing is the good outcome — run it again in a quieter moment. Without it the
-- statement waits indefinitely and takes the table's readers down with it.
--
-- DO NOT PASTE THIS WHOLE SECTION INTO A SQL EDITOR. A pasted block is one implicit transaction:
-- every ACCESS EXCLUSIVE lock it takes is held until the LAST statement commits, so 27 instant
-- ALTERs become one long lock on three tables at once. Use psql, one statement per line, watching
-- each return — or paste one line at a time.
--
-- Every statement is ADD COLUMN IF NOT EXISTS. Re-running is a no-op, nothing is dropped, no
-- existing column is retyped, and no row is rewritten.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- GOALS. The period a goal belongs to, who owns it, who may see it, and how far along it is.
-- `visibility` defaults to 'manager' rather than to open: a goal is between a person and their
-- manager unless somebody widens it.
-- --------------------------------------------------------------------------------------------
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS period_label VARCHAR(40);
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS period_end DATE;
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS progress_pct INT NOT NULL DEFAULT 0;
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'manager';
ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ;

-- --------------------------------------------------------------------------------------------
-- REVIEW CYCLES. The stage a cycle is IN, which the original `status` (draft|active|closed)
-- cannot say — a cycle that is 'active' tells nobody whether self-assessments are still open.
--
-- `stage` is the one statement in this file with a NOT NULL and a DEFAULT together. On Postgres 11
-- and later that still does not rewrite the table, so it is as fast as the rest; it is called out
-- only so nobody assumes otherwise and skips the lock_timeout.
-- --------------------------------------------------------------------------------------------
ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS stage VARCHAR(24) NOT NULL DEFAULT 'self_assessment';
ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS self_due_on DATE;
ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS manager_due_on DATE;
ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS calibration_due_on DATE;

-- --------------------------------------------------------------------------------------------
-- THE EMPLOYEE'S OWN HALF OF THE REVIEW. It did not exist: the original table carries only the
-- reviewer's fields, so "self-assessment" had nowhere to go.
-- --------------------------------------------------------------------------------------------
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS self_assessment TEXT;
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS self_rating NUMERIC(5,2);
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS self_submitted_at TIMESTAMPTZ;

-- WHO the manager was WHEN the review was written, captured from the org graph at the moment they
-- submitted. Not a live lookup: the point of writing it down is that a reorganisation six months
-- later must not change who is recorded as having reviewed somebody.
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS manager_employee_id UUID;
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS manager_submitted_at TIMESTAMPTZ;

-- CALIBRATION IS A SEPARATE NUMBER from the manager's rating, kept beside it rather than
-- overwriting it. Overwriting would erase what the manager actually said, which is the one thing
-- an employee disputing an outcome needs to be able to see.
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibrated_rating NUMERIC(5,2);
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibration_note TEXT;
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibrated_by_user_id UUID;
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibrated_at TIMESTAMPTZ;
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS outcome VARCHAR(24);
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS outcome_note TEXT;

-- When the outcome was shared WITH THE PERSON. NULL means they have not been told, and that
-- distinction is the difference between a decided review and a delivered one.
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS shared_with_employee_at TIMESTAMPTZ;

-- The workflow_instances row carrying the sign-off. NULL until somebody sends it.
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS workflow_instance_id UUID;

-- THE PROMOTION RECOMMENDATION, three columns rather than a table on purpose. The employee
-- lifecycle console owns promotions and its own record; this records only that an appraisal
-- RECOMMENDED one, routed through the SAME `promotion` workflow chain with a namespaced record id.
-- Nothing here writes hr_employees.designation — a recommendation is not a promotion.
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS proposed_designation VARCHAR(200);
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS promotion_justification TEXT;
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS promotion_workflow_id UUID;

-- ============================================================================================
-- STEP 3. VERIFY. Re-run the Step 1 query. It should return zero rows.
--
-- If a statement failed with "canceling statement due to lock timeout", that is the bound doing its
-- job — nothing was changed by it and nothing was queued behind it. Run that one line again later.
-- ============================================================================================
