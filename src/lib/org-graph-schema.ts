// src/lib/org-graph-schema.ts — LAYER 1 (ORGANIZATION) STORAGE. Nothing else.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
// =================================================================================================
//
// EduRankAI has three layers and they never merge:
//
//   Layer 1  ORGANIZATION     who is responsible for whom.  Resolved per ROW, from this graph.
//   Layer 2  AUTHORIZATION    what a user may do.           Capabilities, per USER, dotted
//                             lowercase, in src/lib/auth/permissions.ts. NOT HERE.
//   Layer 3  WORKFLOW         how work moves.               Elsewhere.
//
// Reporting manager, department head, team lead, functional manager, project manager, mentor,
// reviewer, approval owner, delegate and executive sponsor are RELATIONSHIPS. They are rows in
// org_relationships. They are NOT capabilities and they are NOT role names, and no code in this
// module or in src/lib/org-graph.ts may read `users.role` to answer any of them. Collapsing a
// per-row relationship into a per-user grant would hand every manager authority over every
// employee — the widest policy change available in this codebase.
//
// This file creates tables. It decides nothing. All resolution lives in src/lib/org-graph.ts.
//
// =================================================================================================
// WHY A ROW AND NOT A COLUMN — the defect this replaces
// =================================================================================================
//
// `hr_employees.reporting_manager_id` (db/hr-schema.sql:118) is a single column on a row that is
// MUTATED IN PLACE. When someone changes manager, the old value is overwritten and gone. So:
//
//   - "Who was Ravi's manager on 12 March, when this leave was approved?" is UNANSWERABLE.
//   - Every past approval is therefore unauditable: we can see who approved, and we cannot show
//     that they were entitled to.
//   - There is exactly one reporting line per person, so mentor / reviewer / project manager /
//     functional manager have nowhere to live at all.
//
// THE ADOPTED IDEA, taken from the reviewed reference HRMS: THE EDGE IS ITS OWN ROW WITH ITS OWN
// LIFETIME. Adding a manager INSERTS a row. Changing a manager CLOSES the old row
// (`effective_to = now`) and INSERTS a new one. Nothing is ever deleted, so the question above is a
// SELECT with a date in it.
//
// WHAT WAS DELIBERATELY NOT ADOPTED: full bitemporality. The reference implementation uses
// btree_gist, EXCLUDE constraints over tstzrange, a NOLOGIN owner role and SECURITY DEFINER
// functions. NONE of those are available here: this project bootstraps its own DDL over a Supabase
// TRANSACTION POOLER connection, which cannot create extensions or roles and does not guarantee a
// session for `SET LOCAL`. The overlap invariants that EXCLUDE would give us are enforced instead by
// PARTIAL UNIQUE INDEXES on the open rows (below) plus db/org-graph-validate.sql, which the founder
// runs. That is a weaker guarantee, honestly stated, not a silent one.
//
// =================================================================================================
// STATUS vs EFFECTIVE DATES — read this before writing any query against these tables
// =================================================================================================
//
// These two fields answer DIFFERENT questions and confusing them destroys the history:
//
//   effective_from / effective_to   WHEN the relationship was true. A CLOSED row (effective_to set)
//                                   is still a true, trustworthy record of the past.
//   status                          WHETHER the row is a trustworthy assertion at all.
//                                     'active'  = real. Counts on any date inside its range.
//                                     'revoked' = entered in error and retracted. Counts on NO date.
//
// SUPERSEDING AN EDGE SETS `effective_to` AND LEAVES `status = 'active'`. It must never set status
// to 'superseded' or 'closed': "who was the manager on 12 March" filters `status = 'active'`, so a
// closed-out row that also lost its active status would silently disappear from history — which is
// the exact failure this whole table exists to prevent. `revoked` is only for rows that should never
// have existed.
//
// =================================================================================================
// THE TWO ID-SPACE TRAPS, stated where the columns are declared
// =================================================================================================
//
// 1. EMPLOYEE IDS. subject_employee_id and object_employee_id hold `hr_employees.id`. They do NOT
//    hold `users.id`. The legacy column they replace does the opposite —
//    `hr_employees.reporting_manager_id` holds a USERS id (db/hr-schema.sql:114-118, and
//    hr-wallet.ts approverRole() compares it to the signed-in user's id). The backfill in
//    db/org-graph-backfill.sql therefore has to TRANSLATE, via `hr_employees.user_id`, and every
//    manager who has no hr_employees row of their own cannot be represented — validation SQL counts
//    them rather than letting them vanish.
//
// 2. DEPARTMENT IDS. scope_id is TEXT and is NEVER cast to uuid. `departments.id` is
//    varchar(50) — a slug — in src/lib/db/schema.ts:80, and UUID in db/hr-schema.sql:31. The same
//    logical thing has two types in two schema files, so every comparison against it is `::text`.
//    A `::uuid` cast here throws `invalid input syntax for type uuid` the moment a slug arrives.
//    scope_id is TEXT for exactly that reason and for no other.


import { db, sqlClient } from './db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from './ensure-once';

// Declared before every function below that uses it. `const` is not hoisted, and a const declared
// under its first use has taken pages down on this project.
const logFail = (tag: string, e: any) =>
  console.error('[org-graph-schema] ' + tag, e?.cause?.message || e?.message);

// =================================================================================================
// THE DDL, AND WHY IT IS TWO BATCHES PLUS FOUR SEPARATE STATEMENTS
// =================================================================================================
//
// Every `await db.execute(...)` is one network round trip, and this bootstrap was 52 of them. It
// runs on the first request into every cold serverless instance, before the page reads its first
// row: at the ~139ms round trip measured against this database that is ~7s of pure latency on an
// authenticated page, which is enough on its own to reach the gateway timeout. The statements below
// are grouped into strings and sent over the simple protocol — the same send ensureBatch() makes,
// src/lib/ensure-once.ts — so a group costs ONE round trip instead of one per statement.
//
// WHAT is created did not change. Same statements, same order, same ensureOnce key.
//
// WHAT IS DELIBERATELY LEFT OUT OF THE BATCHES. A batch is ONE IMPLICIT TRANSACTION: if any
// statement in it fails, the whole block rolls back. The four UNIQUE indexes further down each sit
// in their own try/catch precisely so that existing data violating one of them fails THAT index and
// leaves the rest of the schema standing — the comment above them says why. Batching them would
// turn a survivable index failure into a bootstrap that creates no tables at all, so they stay four
// separate db.execute() calls. 16 + 3 + 32 + 1 statements becomes 1 + 3 + 1 + 1 = 6 round trips.

// -----------------------------------------------------------------------------------------
// org_relationships — THE EDGE TABLE. One row per relationship per lifetime.
//
// DIRECTION, stated once and never re-derived. Read a row as this sentence:
//
//     <subject> is the <type> of <object>, within <scope>, from <effective_from> to <effective_to>
//
//   subject_employee_id  the person who HOLDS the responsibility  (the manager, the head,
//                        the mentor, the reviewer, the delegate)
//   object_employee_id   the person the responsibility is ABOUT   (the report, the mentee)
//                        NULL when the responsibility is to a SCOPE rather than to a person —
//                        a department head is the head of a department, not of one named person.
//
// Getting this backwards inverts the org chart, so both indexes below are named for the
// direction they serve and org-graph.ts states the direction at every query.
// -----------------------------------------------------------------------------------------
const ORG_RELATIONSHIPS_TABLE_DDL = `
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
`;

// CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS. That
// is how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
// table, which locked every administrator out of /admin. So every column past the primary key is
// asserted again. On a fresh database these are no-ops; on a database carrying an earlier
// revision they are the difference between working and a 500.
const ORG_RELATIONSHIPS_COLUMN_DDL = `
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS object_employee_id UUID;
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS scope_type TEXT;
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS scope_id TEXT;
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ;
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS created_by UUID;
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS note TEXT;
`;

// NO FOREIGN KEY TO hr_employees, and this is deliberate rather than an omission. An employee row
// being deleted must not take the history of who they reported to with it — that history is the
// evidence behind past approvals. The hr_* tables already work this way (hr_task_log,
// hr_time_logs). Orphan detection is db/org-graph-validate.sql's job, not the planner's.
//
// NO CHECK CONSTRAINT ON `type`, either. A CHECK would have to be dropped and recreated to add a
// relationship type, and this project has no migration runner — every DDL change here is
// CREATE/ADD IF NOT EXISTS, which cannot alter an existing CHECK. The vocabulary is enforced in
// TypeScript (ORG_RELATIONSHIP_TYPES in src/lib/org-graph.ts) and audited by validation SQL, which
// reports any type outside the list. Same reasoning for `status` and `scope_type`.

// Indexes. Every column any resolver filters on is covered; nothing in org-graph.ts does a
// sequential scan of this table.
//
const ORG_RELATIONSHIPS_INDEX_DDL = `
  -- ...OF is the lookup "who is X's manager / mentor / reviewer" — filter on the OBJECT.
  CREATE INDEX IF NOT EXISTS org_relationships_object_idx
    ON org_relationships (object_employee_id, type, status, effective_from DESC);
  -- ...HOLDS is the lookup "who reports to X" / "what does X hold" — filter on the SUBJECT.
  CREATE INDEX IF NOT EXISTS org_relationships_subject_idx
    ON org_relationships (subject_employee_id, type, status, effective_from DESC);
  -- Scope lookups: "who heads department D", "who owns approvals for domain X".
  CREATE INDEX IF NOT EXISTS org_relationships_scope_idx
    ON org_relationships (type, scope_type, scope_id, status);
  -- isInitialized() and the open-edge sweeps: the currently-in-force rows.
  CREATE INDEX IF NOT EXISTS org_relationships_open_idx
    ON org_relationships (status, effective_to, type);
  -- The audit question — every edge in force on a given date.
  CREATE INDEX IF NOT EXISTS org_relationships_effective_idx
    ON org_relationships (effective_from, effective_to);
  -- "Who recorded this edge, and when" — the accountability read.
  CREATE INDEX IF NOT EXISTS org_relationships_created_by_idx
    ON org_relationships (created_by, created_at DESC);
`;

// Three constants, one batch. The split exists only so each block keeps the comment that explains
// it; they are concatenated and sent together, so this is still a single round trip. The six
// per-index notes moved into the string as SQL comments to stay next to the index they describe.
const ORG_RELATIONSHIPS_DDL =
  ORG_RELATIONSHIPS_TABLE_DDL + ORG_RELATIONSHIPS_COLUMN_DDL + ORG_RELATIONSHIPS_INDEX_DDL;

// Teams. `department_id` is TEXT — see ID-SPACE TRAP 2 at the top of this file. Never ::uuid.
const ORG_TEAMS_DDL = `
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
  ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS slug TEXT;
  ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS department_id TEXT;
  ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS parent_team_id UUID;
  ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS created_by UUID;
  CREATE INDEX IF NOT EXISTS org_teams_dept_idx ON org_teams (department_id, is_active);
  CREATE INDEX IF NOT EXISTS org_teams_parent_idx ON org_teams (parent_team_id);
  CREATE UNIQUE INDEX IF NOT EXISTS org_teams_slug_uq ON org_teams (slug) WHERE slug IS NOT NULL;
`;

// Positions — the SEAT, not the person and not the role name. A position is "Backend Engineer II
// in Engineering"; who occupies it is an assignment row below. `title` is descriptive text and
// is never compared to users.role or to a capability.
const ORG_POSITIONS_DDL = `
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
  ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS code TEXT;
  ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS department_id TEXT;
  ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS team_id UUID;
  ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS grade TEXT;
  ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS created_by UUID;
  CREATE INDEX IF NOT EXISTS org_positions_dept_idx ON org_positions (department_id, is_active);
  CREATE INDEX IF NOT EXISTS org_positions_team_idx ON org_positions (team_id, is_active);
  CREATE UNIQUE INDEX IF NOT EXISTS org_positions_code_uq ON org_positions (code) WHERE code IS NOT NULL;
`;

// Assignments — WHO SITS WHERE, AND WHEN. Append-only on exactly the same terms as
// org_relationships: moving someone CLOSES the old row and INSERTS a new one, status stays
// 'active' on the closed row so "which team was she in in March" still answers.
const ORG_ASSIGNMENTS_DDL = `
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
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS position_id UUID;
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS team_id UUID;
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS department_id TEXT;
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS allocation_pct INT;
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ;
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE org_employee_assignments ADD COLUMN IF NOT EXISTS created_by UUID;
  CREATE INDEX IF NOT EXISTS org_assignments_employee_idx
    ON org_employee_assignments (employee_id, status, effective_from DESC);
  CREATE INDEX IF NOT EXISTS org_assignments_team_idx
    ON org_employee_assignments (team_id, status, effective_to);
  CREATE INDEX IF NOT EXISTS org_assignments_dept_idx
    ON org_employee_assignments (department_id, status, effective_to);
  CREATE INDEX IF NOT EXISTS org_assignments_position_idx
    ON org_employee_assignments (position_id, status, effective_to);
`;

// The whole second pass as one batch, split into three constants for the same reason as above.
const ORG_STRUCTURES_DDL = ORG_TEAMS_DDL + ORG_POSITIONS_DDL + ORG_ASSIGNMENTS_DDL;

// The one-round-trip send ensureBatch() performs, WITHOUT its per-key memoisation, because this
// module already has one: everything below runs inside ensureOnce('org_graph_v1', ...). Nesting a
// second cache entry under a second key would break the retry this file depends on — ensureOnce
// swallows the rejection for its caller, so a failed inner batch would return as if it had worked,
// the outer key would be cached as done, and the outer catch that exists to delete that key and
// force a retry would never fire. The send itself is identical to ensureBatch's: one simple-protocol
// message, one implicit transaction, and only string literals declared above — never user input.
async function sendDdlBatch(ddl: string): Promise<void> {
  await sqlClient().unsafe(ddl).simple();
}

/**
 * Create the Layer 1 tables if they are absent. Idempotent, safe to call on every request.
 *
 * ensureOnce() memoises the in-flight promise per process and DELETES the cache entry if the
 * callback rejects (src/lib/ensure-once.ts:16-19), so a transient failure retries on the next call
 * instead of poisoning the process. That reset is why the catch below RE-THROWS after logging: a
 * swallowed failure here would leave no trace anywhere and the only symptom would be an org chart
 * that is permanently, silently empty.
 *
 * ensureOnce() then swallows the rejection for the CALLER, so consumers keep the tolerate-missing-
 * schema behaviour the rest of this codebase relies on. Every resolver in org-graph.ts fails closed
 * on top of that: no schema means no relationship, never "yes".
 */
export function ensureOrgGraphSchema(): Promise<void> {
  return ensureOnce('org_graph_v1', async () => {
    try {
      await createOrgGraphTables();
    } catch (e: any) {
      logFail('ensureOrgGraphSchema', e);
      throw e;
    }
  });
}

async function createOrgGraphTables(): Promise<void> {
  // The edge table, its nine re-asserted columns and its six indexes: 16 statements, one round trip.
  // The comments that used to sit between them are with the DDL above, in the same order.
  await sendDdlBatch(ORG_RELATIONSHIPS_DDL);

  // -----------------------------------------------------------------------------------------
  // THE OVERLAP INVARIANTS. These are what EXCLUDE constraints would have given us, expressed as
  // PARTIAL UNIQUE INDEXES over the OPEN rows only (effective_to IS NULL AND status = 'active').
  // Plain btree, no btree_gist, so they work on the transaction pooler.
  //
  // WHAT THEY DO AND DO NOT COVER, stated honestly: they make it impossible to have two edges OPEN
  // at once. They do NOT prevent two CLOSED rows from overlapping in the past — a true EXCLUDE over
  // tstzrange would. Retroactive overlaps are detected by db/org-graph-validate.sql instead. That is
  // the one thing lost by not taking bitemporality, and it is written down rather than assumed away.
  //
  // Each index gets its OWN try/catch. If existing data violates one, the index fails to create and
  // the log names the real Postgres reason — but the tables above are already built and the graph
  // still works. A bootstrap that aborts halfway leaves a half-made schema, which is worse.
  // -----------------------------------------------------------------------------------------
  try {
    // ONE OPEN MANAGER PER PERSON. This is the invariant that makes "who was the manager on this
    // date" have exactly one answer instead of an arbitrary one.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_one_open_manager_uq
      ON org_relationships (object_employee_id)
      WHERE type = 'reporting_manager' AND status = 'active' AND effective_to IS NULL`);
  } catch (e: any) {
    logFail('one_open_manager_uq', e);
  }

  try {
    // ONE OPEN HEAD PER DEPARTMENT. A department with two simultaneous heads has no single answer
    // to "who approves this", and getDepartmentHead() would return whichever row the planner
    // happened to hand back first. If co-heads are ever a real requirement this index is the thing
    // to drop, deliberately and with the consequence understood.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_one_open_dept_head_uq
      ON org_relationships (scope_id)
      WHERE type = 'department_head' AND status = 'active' AND effective_to IS NULL`);
  } catch (e: any) {
    logFail('one_open_dept_head_uq', e);
  }

  try {
    // NO DUPLICATE OPEN EDGE OF ANY KIND. COALESCE gives NULL-able columns a stable key: two NULLs
    // are distinct to a plain unique index, so without this the same mentor could be recorded twice.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_no_dupe_open_uq
      ON org_relationships (
        type,
        subject_employee_id,
        COALESCE(object_employee_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(scope_type, ''),
        COALESCE(scope_id, '')
      )
      WHERE status = 'active' AND effective_to IS NULL`);
  } catch (e: any) {
    logFail('no_dupe_open_uq', e);
  }

  // -----------------------------------------------------------------------------------------
  // SECOND PASS — the structures relationships can be SCOPED to. Non-fatal as a block.
  //
  // WHAT STILL WORKS IF THIS LOGS AND STOPS: every relationship resolver in org-graph.ts. None of
  // them read the tables below; a reporting line scoped to a team stores the team id as TEXT in
  // scope_id and resolves without ever joining org_teams. What stops is the ability to NAME a team
  // or a position in a UI. An org chart that renders without labels is a bad afternoon; an org
  // chart that cannot answer who approves anything is an outage.
  // -----------------------------------------------------------------------------------------
  try {
    // The three structure tables, their columns and their indexes: 32 statements, one round trip.
    // Still non-fatal as a block, under this same try/catch, and the comments are with the DDL
    // above. One difference worth stating rather than assuming away: a batch rolls back as a unit,
    // so a failure here now leaves none of these three tables instead of the first few. Every
    // statement is IF NOT EXISTS, so the next process retries the whole group and lands in the
    // same place — and a clean rollback is the outcome the comment above already argues for.
    await sendDdlBatch(ORG_STRUCTURES_DDL);
  } catch (e: any) {
    logFail('ensureOrgGraphSchema structures', e);
  }

  try {
    // ONE OPEN PRIMARY ASSIGNMENT PER PERSON. Two simultaneous primaries means "which department is
    // she in" has two answers, and every department-scoped screen would then disagree with itself.
    // Secondary assignments (is_primary = false) are unconstrained — that is how a dotted-line or
    // part-allocation posting is recorded.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_one_open_primary_uq
      ON org_employee_assignments (employee_id)
      WHERE is_primary = TRUE AND status = 'active' AND effective_to IS NULL`);
  } catch (e: any) {
    logFail('one_open_primary_uq', e);
  }
}
