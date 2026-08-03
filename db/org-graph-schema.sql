-- ================================================================================================
-- db/org-graph-schema.sql — LAYER 1 (ORGANIZATION) TABLES
--
-- WHO RUNS THIS: the founder, once, before db/org-graph-backfill.sql.
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase touched the database.
--
-- This file is the readable mirror of src/lib/org-graph-schema.ts. The TypeScript version runs the
-- same statements automatically the first time any consumer calls into src/lib/org-graph.ts, so on
-- a fresh environment nobody has to run anything. This file exists because (a) reading DDL inside a
-- TypeScript template string is miserable, and (b) the founder should be able to create the tables
-- deliberately, before any application code touches them, and read exactly what was created.
--
-- BOTH ARE IDEMPOTENT AND THEY DO NOT CONFLICT. Running this and then letting the app bootstrap, or
-- the reverse, produces the same schema. Every statement is CREATE ... IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS.
--
-- HOW TO RUN IT (Supabase SQL editor, or psql against the pooler):
--     \i db/org-graph-schema.sql
--
-- ================================================================================================
-- THE THREE LAYERS. These tables are Layer 1 and only Layer 1.
--
--   Layer 1  ORGANIZATION   who is responsible for whom   <- THIS FILE
--   Layer 2  AUTHORIZATION  what a user may do            <- src/lib/auth/permissions.ts. Not here.
--   Layer 3  WORKFLOW       how work moves                <- elsewhere.
--
-- Nothing in these tables is a capability and nothing in them is a role name. `type` holds
-- relationship names ('reporting_manager', 'department_head', ...) which are never compared against
-- users.role. Collapsing a per-row relationship into a per-user grant would hand every manager
-- authority over every employee.
--
-- ================================================================================================
-- STATUS vs EFFECTIVE DATES. Read this before writing any query against these tables.
--
--   effective_from / effective_to  WHEN the relationship was true. A CLOSED row is still a true
--                                  record of the past and still answers historical questions.
--   status                         WHETHER the row is a trustworthy assertion at all.
--                                    'active'  = real; counts on any date inside its range.
--                                    'revoked' = entered in error; counts on no date.
--
-- SUPERSEDING AN EDGE SETS effective_to AND LEAVES status = 'active'. There is deliberately no
-- 'superseded' status: every historical query filters status = 'active', so a closed row that also
-- lost its active status would disappear from history — destroying the one thing this table exists
-- to keep. 'revoked' is only for rows that should never have existed.
--
-- ================================================================================================
-- TWO ID-SPACE TRAPS
--
-- 1. subject_employee_id and object_employee_id hold hr_employees.id. The legacy column they
--    replace, hr_employees.reporting_manager_id, holds a USERS id (db/hr-schema.sql:114-118). The
--    backfill translates between them via hr_employees.user_id.
--
-- 2. scope_id is TEXT and is NEVER cast to uuid. departments.id is varchar(50) — a slug — in
--    src/lib/db/schema.ts:80 and UUID in db/hr-schema.sql:31. A ::uuid cast throws
--    "invalid input syntax for type uuid" the first time a slug arrives.
--
-- ================================================================================================
-- WHAT WAS DELIBERATELY NOT BUILT: full bitemporality. The reference implementation this idea came
-- from uses btree_gist, EXCLUDE constraints over tstzrange, a NOLOGIN owner role and SECURITY
-- DEFINER functions. None of those are available on a Supabase transaction-pooler connection with
-- self-bootstrapping DDL. The overlap invariants are enforced instead by PARTIAL UNIQUE INDEXES over
-- the OPEN rows, which is strictly weaker: it prevents two edges being open at once, and does NOT
-- prevent two CLOSED rows overlapping in the past. db/org-graph-validate.sql detects the latter.
-- That gap is stated rather than assumed away.
-- ================================================================================================


-- ------------------------------------------------------------------------------------------------
-- org_relationships — THE EDGE TABLE. One row per relationship per lifetime.
--
-- DIRECTION, fixed and never re-derived. Read a row as this sentence:
--
--     <subject> is the <type> of <object>, within <scope>, from <effective_from> to <effective_to>
--
--   subject_employee_id  the person who HOLDS the responsibility (manager, head, mentor, delegate)
--   object_employee_id   the person it is ABOUT (the report, the mentee). NULL when the
--                        responsibility is to a SCOPE — a department head heads a DEPARTMENT, not
--                        one named person.
--
-- VOCABULARY for `type` (enforced in TypeScript, audited by db/org-graph-validate.sql, NOT by a
-- CHECK constraint — a CHECK would have to be dropped and recreated to add a type, and this project
-- has no migration runner, only CREATE/ADD IF NOT EXISTS):
--   reporting_manager, department_head, team_lead, functional_manager, project_manager,
--   mentor, reviewer, executive_sponsor, temporary_delegate, approval_owner
--
-- NO FOREIGN KEY TO hr_employees, deliberately. An employee row being deleted must not take the
-- history of who they reported to with it — that history is the evidence behind past approvals.
-- The hr_* tables already work this way. Orphan detection is db/org-graph-validate.sql's job.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_relationships (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                TEXT NOT NULL,
  subject_employee_id UUID NOT NULL,
  object_employee_id  UUID,
  scope_type          TEXT,
  scope_id            TEXT,
  effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active',
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note                TEXT,
  CONSTRAINT org_relationships_not_self CHECK (
    object_employee_id IS NULL OR subject_employee_id <> object_employee_id
  ),
  CONSTRAINT org_relationships_range CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);

-- CREATE TABLE IF NOT EXISTS is a no-op on an existing table, INCLUDING one that is missing columns.
-- That is exactly how hr_employees.work_email came to be declared in db/hr-schema.sql and absent
-- from the live table, which locked every administrator out of /admin. So every column past the
-- primary key is asserted again.
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS object_employee_id UUID;
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS scope_type         TEXT;
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS scope_id           TEXT;
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS effective_to       TIMESTAMPTZ;
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS status             TEXT NOT NULL DEFAULT 'active';
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS created_by         UUID;
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS note               TEXT;

-- Lookup indexes. Every column any resolver filters on is covered.
-- "who is X's manager / mentor / reviewer" — filter on the OBJECT.
CREATE INDEX IF NOT EXISTS org_relationships_object_idx
  ON org_relationships (object_employee_id, type, status, effective_from DESC);
-- "who reports to X" / "what does X hold" — filter on the SUBJECT.
CREATE INDEX IF NOT EXISTS org_relationships_subject_idx
  ON org_relationships (subject_employee_id, type, status, effective_from DESC);
-- "who heads department D", "who owns approvals for domain X".
CREATE INDEX IF NOT EXISTS org_relationships_scope_idx
  ON org_relationships (type, scope_type, scope_id, status);
-- isInitialized() and the open-edge sweeps.
CREATE INDEX IF NOT EXISTS org_relationships_open_idx
  ON org_relationships (status, effective_to, type);
-- The audit question: every edge in force on a given date.
CREATE INDEX IF NOT EXISTS org_relationships_effective_idx
  ON org_relationships (effective_from, effective_to);
-- "Who recorded this edge, and when" — the accountability read.
CREATE INDEX IF NOT EXISTS org_relationships_created_by_idx
  ON org_relationships (created_by, created_at DESC);

-- THE OVERLAP INVARIANTS — what EXCLUDE constraints would have given us, as partial unique indexes
-- over the OPEN rows. Plain btree, so they work on the transaction pooler with no extension.

-- ONE OPEN MANAGER PER PERSON. This is what makes "who was the manager on this date" have exactly
-- one answer instead of an arbitrary one.
CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_one_open_manager_uq
  ON org_relationships (object_employee_id)
  WHERE type = 'reporting_manager' AND status = 'active' AND effective_to IS NULL;

-- ONE OPEN HEAD PER DEPARTMENT. Two simultaneous heads means "who approves this" has two answers
-- and the planner picks. If co-heads ever become a real requirement, THIS is the index to drop —
-- deliberately, with the consequence understood.
CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_one_open_dept_head_uq
  ON org_relationships (scope_id)
  WHERE type = 'department_head' AND status = 'active' AND effective_to IS NULL;

-- NO DUPLICATE OPEN EDGE OF ANY KIND. COALESCE gives the nullable columns a stable key: two NULLs
-- are distinct to a plain unique index, so without this the same mentor could be recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_no_dupe_open_uq
  ON org_relationships (
    type,
    subject_employee_id,
    COALESCE(object_employee_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_type, ''),
    COALESCE(scope_id, '')
  )
  WHERE status = 'active' AND effective_to IS NULL;


-- ------------------------------------------------------------------------------------------------
-- org_teams — a team a relationship can be scoped to.
-- department_id is TEXT. See ID-SPACE TRAP 2. Never ::uuid.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_teams (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  slug           TEXT,
  department_id  TEXT,
  parent_team_id UUID,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS slug           TEXT;
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS department_id  TEXT;
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS parent_team_id UUID;
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS created_by     UUID;
CREATE INDEX IF NOT EXISTS org_teams_dept_idx   ON org_teams (department_id, is_active);
CREATE INDEX IF NOT EXISTS org_teams_parent_idx ON org_teams (parent_team_id);
CREATE UNIQUE INDEX IF NOT EXISTS org_teams_slug_uq ON org_teams (slug) WHERE slug IS NOT NULL;


-- ------------------------------------------------------------------------------------------------
-- org_positions — the SEAT, not the person and not a role name. "Backend Engineer II in
-- Engineering" is a position; who occupies it is an assignment row. `title` is descriptive text and
-- is never compared to users.role or to a capability.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_positions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  code          TEXT,
  department_id TEXT,
  team_id       UUID,
  grade         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS code          TEXT;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS department_id TEXT;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS team_id       UUID;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS grade         TEXT;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS created_by    UUID;
CREATE INDEX IF NOT EXISTS org_positions_dept_idx ON org_positions (department_id, is_active);
CREATE INDEX IF NOT EXISTS org_positions_team_idx ON org_positions (team_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS org_positions_code_uq ON org_positions (code) WHERE code IS NOT NULL;


-- ------------------------------------------------------------------------------------------------
-- org_employee_assignments — WHO SITS WHERE, AND WHEN.
-- Append-only on exactly the same terms as org_relationships: moving someone CLOSES the old row and
-- INSERTS a new one, and the closed row keeps status = 'active' so "which team was she in in March"
-- still answers.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_employee_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL,
  position_id    UUID,
  team_id        UUID,
  department_id  TEXT,
  allocation_pct INT,
  is_primary     BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'active',
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_employee_assignments_range CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS position_id    UUID;
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS team_id        UUID;
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS department_id  TEXT;
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS allocation_pct INT;
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS is_primary     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS effective_to   TIMESTAMPTZ;
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active';
ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS created_by     UUID;
CREATE INDEX IF NOT EXISTS org_assignments_employee_idx
  ON org_employee_assignments (employee_id, status, effective_from DESC);
CREATE INDEX IF NOT EXISTS org_assignments_team_idx
  ON org_employee_assignments (team_id, status, effective_to);
CREATE INDEX IF NOT EXISTS org_assignments_dept_idx
  ON org_employee_assignments (department_id, status, effective_to);
CREATE INDEX IF NOT EXISTS org_assignments_position_idx
  ON org_employee_assignments (position_id, status, effective_to);

-- ONE OPEN PRIMARY ASSIGNMENT PER PERSON. Two simultaneous primaries means "which department is she
-- in" has two answers, and every department-scoped screen would disagree with itself. Secondary
-- assignments (is_primary = FALSE) are unconstrained — that is how a dotted-line or part-allocation
-- posting is recorded.
CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_one_open_primary_uq
  ON org_employee_assignments (employee_id)
  WHERE is_primary = TRUE AND status = 'active' AND effective_to IS NULL;
