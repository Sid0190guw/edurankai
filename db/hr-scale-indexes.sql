-- =================================================================================================
-- hr-scale-indexes.sql — THE INDEXES THE EMPLOYEE PORTAL NEEDS BEFORE THE HEADCOUNT IS LARGE
-- =================================================================================================
--
-- RUN THIS YOURSELF. Nothing in the application applies it, and nothing should: this repository's
-- working rules forbid the assistant from opening a connection to the production database, and
-- migrations here have always been handed over as a command rather than executed. Every statement
-- below is idempotent, so running it twice is a no-op.
--
--   psql "$DATABASE_URL" -f db/hr-scale-indexes.sql
--
-- CONCURRENTLY, AND WHY IT MATTERS ON A LIVE TABLE. A plain CREATE INDEX takes a lock that blocks
-- every write to the table for the whole build. CONCURRENTLY does not, at the cost of two table
-- scans and the possibility of leaving an INVALID index behind if it fails midway. That trade is
-- the right one on a table the whole company is reading, but it has one hard requirement:
--
--   *** CREATE INDEX CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK. ***
--
-- psql with -f runs in autocommit and is fine. A migration runner that wraps the file in BEGIN/COMMIT
-- will fail on the first statement. If yours does, either disable the wrapper or drop the
-- CONCURRENTLY keyword and accept the write lock during a quiet window.
--
-- AFTERWARDS, CHECK NONE OF THEM LANDED INVALID:
--
--   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE NOT i.indisvalid AND c.relname LIKE 'hr_%';
--
-- An invalid index is not used by the planner and is not repaired by re-running this file: DROP it
-- and create it again.
--
-- =================================================================================================
-- WHAT EACH ONE IS FOR
-- =================================================================================================
--
-- These are not speculative. Each one below is named by a specific read that the employee portal
-- performs on a page somebody opens every working morning, and each of those reads was, before this
-- file, a sequential scan of a table whose size grows with the headcount.
--
-- The application-side half of the same fix is src/lib/workforce/scale.ts. Both halves are required:
-- an index cannot be used by a predicate written `employee_id::text = $1`, which is the form this
-- codebase used in more than a hundred places, so the casts had to go before these could help.
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. THE REPORTING LINE
-- -------------------------------------------------------------------------------------------------
-- Read on EVERY render of EVERY workspace surface, by the composer, to answer "does this person
-- manage anybody". With no index that is a full scan of hr_employees per page load — the first
-- thing that falls over on a large roll, and the hardest to spot, because the query is a COUNT and
-- looks harmless in a log.
--
-- Partial on is_active: the count only ever asks about active people, and an index that excludes
-- leavers stays small forever instead of growing with everyone who has ever worked here.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_manager_active_idx
    ON hr_employees (reporting_manager_id)
 WHERE is_active = true;


-- -------------------------------------------------------------------------------------------------
-- 2. THE EMAIL FALLBACK
-- -------------------------------------------------------------------------------------------------
-- hr_employees.user_id is nullable and only backfilled opportunistically, so anybody HR created
-- before their account existed is matched by ADDRESS on every page load until the backfill runs.
-- workspace-access.ts compares lower(work_email) / lower(personal_email) / lower(email) against the
-- signed-in address; a functional index is required, because an index on the raw column cannot
-- answer a predicate on lower(column).
--
-- Three separate indexes rather than one composite: the query is an OR across three columns, which
-- the planner answers with a BitmapOr of three index scans. A composite index cannot serve an OR.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_lower_work_email_idx
    ON hr_employees (lower(work_email))
 WHERE work_email IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_lower_personal_email_idx
    ON hr_employees (lower(personal_email))
 WHERE personal_email IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_lower_email_idx
    ON hr_employees (lower(email))
 WHERE email IS NOT NULL;


-- -------------------------------------------------------------------------------------------------
-- 3. THE DEPARTMENT ROSTER, AND THE DIRECTORY'S KEYSET
-- -------------------------------------------------------------------------------------------------
-- departmentFilter() narrows every department-scoped list in the product, and the roster card sorts
-- by full_name. The composite lets one index seek satisfy the filter AND the ordering, so the
-- eight-name card reads eight rows instead of sorting a department.
--
-- `id` IS THE THIRD COLUMN, AND IT IS NOT PADDING. /portal/employee/directory pages by keyset:
--
--     WHERE department_id = $1 AND (full_name, id) > ($2, $3::uuid)
--     ORDER BY full_name ASC, id ASC
--
-- Without `id` in the index, Postgres can seek to the right department and the right name but must
-- then sort to break ties — and at this headcount there are thousands of people sharing an exact
-- name, so the tie-break is not hypothetical. With it, every page of the directory is one seek at
-- any depth. An index that stops one column short of the ORDER BY is the classic almost-right index:
-- the plan looks like it uses it, and the sort is still there.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_dept_name_id_idx
    ON hr_employees (department_id, full_name, id)
 WHERE is_active = true;

-- THE WHOLE-DIRECTORY ORDERING, for the viewers who have it.
--
-- A holder of `employee.manage` gets scope 'full', so the directory's WHERE collapses to
-- `is_active = TRUE AND TRUE` and the department index above cannot help: there is no leading
-- equality for it to seek on. That path would then sort the entire active roll by name to render
-- twenty-five rows, on every page. This index is what makes the unscoped directory a seek as well.
--
-- The two are not redundant. A composite is only usable from its leading column, so
-- (department_id, full_name, id) cannot answer an ordering that has no department in it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_name_id_idx
    ON hr_employees (full_name, id)
 WHERE is_active = true;


-- -------------------------------------------------------------------------------------------------
-- 4. PEOPLE SEARCH
-- -------------------------------------------------------------------------------------------------
-- src/lib/search-global.ts matches names with `col ILIKE '%term%'`. An unanchored pattern cannot use
-- a btree index at all — it is a full scan with a matcher run per row. pg_trgm's GIN index is the
-- only structure that answers it, and it is the difference between a search box and an outage.
--
-- pg_trgm ships with Postgres and is available on Supabase; CREATE EXTENSION needs privileges the
-- application role may not have, so run this part as the database owner. If the extension cannot be
-- installed, the honest response is to narrow the search to a prefix match (see prefixPattern() in
-- src/lib/workforce/scale.ts) rather than to leave the scan in place and hope.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_name_trgm_idx
    ON hr_employees USING gin (full_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_designation_trgm_idx
    ON hr_employees USING gin (designation gin_trgm_ops);


-- -------------------------------------------------------------------------------------------------
-- 5. THE EMPLOYEE CODE
-- -------------------------------------------------------------------------------------------------
-- Already UNIQUE in db/hr-schema.sql, so it is indexed — but the lookups are case-insensitive in
-- several places and a person typing their code in lower case falls off the unique index. Kept
-- separate from the uniqueness constraint, which must not be weakened.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_employees_code_lower_idx
    ON hr_employees (lower(employee_code));


-- -------------------------------------------------------------------------------------------------
-- 6. THE PER-PERSON TIME TABLES
-- -------------------------------------------------------------------------------------------------
-- hr-schema.sql already indexes (employee_id, date) on hr_attendance and (employee_id, log_date) on
-- hr_time_logs and hr_task_log, and those are the right shapes. They are repeated here only so that
-- an environment provisioned before those lines existed picks them up — every one is IF NOT EXISTS.
--
-- These are the tables that grow with HEADCOUNT × DAYS rather than with headcount alone, so they are
-- the ones where a missing index stops being slow and starts being fatal.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_attendance_emp_idx
    ON hr_attendance (employee_id, date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_time_logs_emp_date_idx
    ON hr_time_logs (employee_id, log_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_task_log_emp_date_idx
    ON hr_task_log (employee_id, log_date);

-- The daily report card on the workspace home page reads one row by (employee_id, report_date) and
-- hr-schema.sql declares no index for it at all.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_daily_reports_emp_date_idx
    ON hr_daily_reports (employee_id, report_date DESC);

-- Clock events: the punch fold reads today's events for one person, and the work-mode prefill reads
-- the most recent clock_in. Partial on the event type keeps the second one cheap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_clock_events_emp_time_idx
    ON hr_clock_events (employee_id, event_time DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_clock_events_emp_clockin_idx
    ON hr_clock_events (employee_id, event_time DESC)
 WHERE event_type = 'clock_in';


-- -------------------------------------------------------------------------------------------------
-- 7. THE APPROVAL QUEUES
-- -------------------------------------------------------------------------------------------------
-- An approver's queue is "everything still pending", which on a large roll is a small slice of a
-- very large table. A partial index on the pending state is the whole trick: it holds only the rows
-- anybody is waiting on, so it stays small even as the history behind it grows without limit.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_leave_pending_idx
    ON hr_leave_request (requested_at DESC)
 WHERE status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS hr_withdrawal_pending_idx
    ON hr_withdrawal (requested_at DESC)
 WHERE status = 'pending';


-- -------------------------------------------------------------------------------------------------
-- 8. PLANNER STATISTICS
-- -------------------------------------------------------------------------------------------------
-- A new index is not used until the planner knows the table's shape. Autovacuum gets there
-- eventually; ANALYZE gets there now, and skipping it is why "I added the index and nothing got
-- faster" happens.
ANALYZE hr_employees;
ANALYZE hr_attendance;
ANALYZE hr_time_logs;
ANALYZE hr_task_log;
ANALYZE hr_daily_reports;
ANALYZE hr_clock_events;
ANALYZE hr_leave_request;
ANALYZE hr_withdrawal;
