// src/lib/workflow-schema.ts — LAYER 3 (WORKFLOW) STORAGE. Nothing else.
//
// =================================================================================================
// THE THREE LAYERS, AND WHERE THIS ONE SITS
// =================================================================================================
//
//   Layer 1  ORGANIZATION   who is responsible for whom   -> src/lib/org-graph.ts. Per ROW.
//   Layer 2  AUTHORIZATION  what a user may do            -> src/lib/auth/permissions.ts. Per USER.
//   Layer 3  WORKFLOW       how work moves                -> THIS. A row with an explicit state.
//
// This file creates two tables. It decides nothing, routes nothing and grants nothing. Routing lives
// in src/lib/workflow.ts and is answered by Layer 1; authorization is answered by Layer 2 and by
// nothing here. There is NO capability column, NO role column and no place to put one — the moment a
// workflow table starts storing "who may approve" as a property of a person rather than resolving it
// per request, the three layers have collapsed into one and every manager has authority over every
// employee.
//
// =================================================================================================
// WHY A ROW WITH A STATE, AND NOT A STATUS COLUMN ON THE DOMAIN TABLE
// =================================================================================================
//
// `hr_leave_request.status` is a single string on the request itself. It can only ever say what
// happened, never what is supposed to happen next, so:
//
//   - MULTI-STEP APPROVAL IS UNREPRESENTABLE. "Manager, then the department head" has nowhere to
//     live: the second the manager writes 'approved' the request is finished.
//   - PARALLEL APPROVAL IS UNREPRESENTABLE for the same reason — two people cannot both hold a
//     pending decision on one string.
//   - WHO IT IS WAITING ON IS NOT RECORDED. `decided_by` is filled in AFTERWARDS. Before the
//     decision the request names nobody, so nothing can notify the person who is the blocker and
//     nothing can escalate when they do not act.
//   - AN INVALID MOVE CANNOT BE REFUSED. Any writer can put any string in the column.
//
// So an INSTANCE is a row (workflow_instances) and each APPROVAL is a row (workflow_steps). The
// instance carries the explicit state; the steps carry who each decision is waiting on, resolved
// from the org graph AT THE TIME THE STEP WAS CREATED and then frozen. Freezing matters: a
// reorganisation two weeks later must not silently move a pending approval to somebody else, and the
// record of who it was actually waiting on must survive the reorganisation.
//
// =================================================================================================
// THIS IS NOT A SECOND AUDIT LOG, AND THERE IS DELIBERATELY NO EVENTS TABLE
// =================================================================================================
//
// An obvious third table here would be `workflow_events` — one row per thing that happened. It is
// not here on purpose. `audit_log` (src/lib/audit.ts) is this codebase's audit log and every
// transition in src/lib/workflow.ts writes to it. A parallel events table would be a SECOND audit
// log that drifts from the first, and the two would be consulted by different screens and disagree
// about the same approval.
//
// The instance timeline is reconstructable without one: every step row carries its decision, its
// decider, its timestamp and its note, an escalation is a step row pointing at the step it escalated
// from, and a delegated action is recorded on the step it was taken against. Nothing is lost.
//
// =================================================================================================
// THE ID-SPACE TRAPS, stated where the columns are declared
// =================================================================================================
//
// 1. `subject_employee_id` and `approver_employee_id` hold `hr_employees.id`. `approver_user_id`
//    and every `*_user_id` hold `users.id`. Both are stored because the workflow needs BOTH: the
//    graph answers in employee ids, and notifications and session checks happen in user ids.
//    Resolving one from the other on every read would be a query per row on a phone.
//
// 2. `record_id` is TEXT, NOT uuid. The domains this serves do not agree on an id type — leave
//    requests are uuid, and a procurement or travel record may not be. A ::uuid cast here would
//    throw `invalid input syntax for type uuid` the first time a non-uuid domain is wired.
//
// 3. NOTHING IN THESE TABLES IS EVER COMPARED TO `departments.id` WITHOUT ::text. That column is
//    varchar(50) in src/lib/db/schema.ts and UUID in db/hr-schema.sql. It does not appear here at
//    all, which is the safest form of that rule.

import { db, sqlClient } from './db';
import { sql } from 'drizzle-orm';
import { ensureOnce, guardedDdl } from './ensure-once';

// Declared before every function below that uses it. `const` is not hoisted, and a const declared
// under its first use throws on the first line of whatever reads it — that pattern has taken pages
// down on this project twice.
const logFail = (tag: string, e: any) =>
  console.error('[workflow-schema] ' + tag, e?.cause?.message || e?.message);

// =================================================================================================
// FOUR ROUND TRIPS, NOT THIRTY-SEVEN
// =================================================================================================
//
// Four, not two: the two batched blocks are one message each, and the two individually-tolerated
// unique indexes below are still a round trip apiece. That is the whole cost of this bootstrap now.
//
// This bootstrap was 37 separate `await db.execute(...)` calls. Each one is its own round trip, and
// a measured round trip to this database is ~139ms, so a cold instance spent ~5s in here before the
// page could read its first row. ensureOnce() caches per PROCESS, not per database, so every cold
// serverless instance paid the whole bill again — a large part of why
// /portal/employee/attendance/clock-out was reaching the gateway timeout. The unguarded statements
// are now two blocks sent over the simple protocol, one message each, carrying exactly the same
// statements in exactly the order they were written.
//
// THE TWO GUARDED UNIQUE INDEXES ARE NOT IN THE BLOCKS. A block is ONE IMPLICIT TRANSACTION: if any
// statement in it fails, the whole block rolls back. Both unique indexes can legitimately fail
// against existing data that violates them, and both are individually tolerated for exactly that
// reason (the comment at each says so). Batching them would turn "the index is missing, and the log
// names why" into "the tables do not exist". They stay as their own db.execute() calls, in their
// original positions, each still wrapped in its own try/catch.
//
// sqlClient().unsafe(ddl).simple() is the mechanism ensureBatch() uses in src/lib/ensure-once.ts.
// It is called directly here rather than through ensureBatch because ensureBatch is ensureOnce plus
// ONE block, and this bootstrap is four ordered steps under the single 'workflow_v1' key — and
// because ensureBatch carries its OWN ensureOnce, so a failed block would be logged and swallowed
// inside it and the catch/re-throw below would never see it. (The cache entry is still dropped on
// failure either way, so a transient failure retries; what is lost is this file's own error path.)
// The strings are literals in this file; nothing user-supplied reaches unsafe().
// =================================================================================================

// -----------------------------------------------------------------------------------------
// workflow_instances — ONE ROW PER REQUEST MOVING THROUGH AN APPROVAL.
//
//   domain       'leave' | 'attendance' | 'expenses' | 'procurement' | 'recruitment' | 'travel'
//   record_id    the id of the row in that domain's own table. TEXT — see trap 2 above.
//   state        THE EXPLICIT STATE. draft | pending | approved | rejected | cancelled | halted.
//                'halted' is the one that matters most: it is what the engine writes when the org
//                graph cannot name an approver. It is NOT 'approved' and it is NOT 'pending'
//                waiting on nobody — a request that auto-approved because routing failed is the
//                worst outcome this system can produce, and a state that means exactly "stopped,
//                and here is the sentence explaining why" is how that is made impossible.
//   halt_reason  the sentence. Rendered to a person verbatim.
//   current_step which step_no is live. Sequential steps advance it; parallel steps share it.
// -----------------------------------------------------------------------------------------
const WORKFLOW_INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_instances (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain               TEXT NOT NULL,
    record_id            TEXT NOT NULL,
    subject_employee_id  UUID,
    requested_by_user_id UUID,
    state                TEXT NOT NULL DEFAULT 'draft',
    current_step         INT NOT NULL DEFAULT 1,
    halt_reason          TEXT,
    summary              TEXT,
    amount               NUMERIC(14,2),
    currency             TEXT,
    created_by           UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at           TIMESTAMPTZ
  );

  -- CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS. That
  -- is how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
  -- table, which locked every administrator out of /admin for a day. Every column past the primary
  -- key is therefore asserted again. On a fresh database these are no-ops; on a database carrying an
  -- earlier revision of this file they are the difference between working and a 500.
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS subject_employee_id UUID;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS requested_by_user_id UUID;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'draft';
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS current_step INT NOT NULL DEFAULT 1;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS halt_reason TEXT;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS summary TEXT;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2);
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS currency TEXT;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS created_by UUID;
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
`;

// The read paths workflow_instances actually serves. These come AFTER the record_uq unique index in
// the original order and are kept there — they are sent in the same message as the workflow_steps
// block below, which is the next unguarded run.
const WORKFLOW_INSTANCE_INDEXES_DDL = `
  -- "What is waiting, across the company" — the queue view, newest first.
  CREATE INDEX IF NOT EXISTS workflow_instances_state_idx
    ON workflow_instances (state, domain, created_at DESC);
  -- "Everything raised by this person" — their own history.
  CREATE INDEX IF NOT EXISTS workflow_instances_subject_idx
    ON workflow_instances (subject_employee_id, created_at DESC);
  -- The halt sweep: every request stopped because routing could not name anybody.
  CREATE INDEX IF NOT EXISTS workflow_instances_halted_idx
    ON workflow_instances (state, updated_at DESC);
`;

// -----------------------------------------------------------------------------------------
// workflow_steps — ONE ROW PER APPROVAL DECISION THAT IS OWED.
//
//   step_no      the position in the chain. SEQUENTIAL steps have one row each and run in
//                ascending order. PARALLEL approval is several rows SHARING one step_no — all of
//                them must approve before current_step advances. That is the entire mechanism;
//                there is no separate parallel flag to get out of step with the rows.
//   mode         'sequential' | 'parallel' | 'executive'. Descriptive, for rendering and audit.
//                The BEHAVIOUR comes from how many rows share step_no, never from this string.
//   via          WHICH ORG RELATIONSHIP RESOLVED THIS APPROVER — 'reporting_manager',
//                'department_head', 'approval_owner', 'executive_sponsor'. This is a value of
//                org_relationships.type, recorded so a screen can say "waiting on her manager"
//                and an auditor can see which edge was walked. IT IS NOT A ROLE NAME AND IT IS
//                NOT A CAPABILITY. Nothing compares it to users.role, and nothing grants anything
//                from it.
//   acted_via    HOW THE PERSON WHO ACTUALLY DECIDED WAS ENTITLED TO: 'routed' (they are the
//                resolved approver), 'delegate' (they are standing in for the resolved approver
//                under an in-force temporary_delegate edge) or 'capability' (they hold the
//                domain's approval capability from Layer 2). Written by the engine AFTER the
//                check, never read to make one.
//   due_at       when this step becomes escalatable. NULL means it never escalates on its own.
//   escalated_from_step_id  set on a step created BECAUSE another one went unanswered. The
//                original row is left pending, so either person can still act and the record
//                shows the escalation happened rather than replacing the history with its result.
// -----------------------------------------------------------------------------------------
const WORKFLOW_STEPS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id            UUID NOT NULL,
    step_no                INT NOT NULL DEFAULT 1,
    mode                   TEXT NOT NULL DEFAULT 'sequential',
    via                    TEXT,
    approver_employee_id   UUID,
    approver_user_id       UUID,
    decision               TEXT NOT NULL DEFAULT 'pending',
    decided_by_user_id     UUID,
    decided_at             TIMESTAMPTZ,
    acted_via              TEXT,
    note                   TEXT,
    due_at                 TIMESTAMPTZ,
    escalated_from_step_id UUID,
    notified_at            TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS step_no INT NOT NULL DEFAULT 1;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'sequential';
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS via TEXT;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approver_employee_id UUID;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approver_user_id UUID;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS decided_by_user_id UUID;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS acted_via TEXT;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS note TEXT;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS escalated_from_step_id UUID;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
  ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  -- The step list for one instance, in order. Every read of an instance uses this.
  CREATE INDEX IF NOT EXISTS workflow_steps_instance_idx
    ON workflow_steps (instance_id, step_no, created_at);
  -- "What is waiting on ME" — the only query an approver's phone actually runs.
  CREATE INDEX IF NOT EXISTS workflow_steps_approver_idx
    ON workflow_steps (approver_user_id, decision, due_at);
  -- The same question in employee-id space, for the delegate lookup.
  CREATE INDEX IF NOT EXISTS workflow_steps_approver_emp_idx
    ON workflow_steps (approver_employee_id, decision);
  -- The escalation sweep: pending steps that are past due.
  CREATE INDEX IF NOT EXISTS workflow_steps_due_idx
    ON workflow_steps (decision, due_at);
`;

/**
 * Create the Layer 3 tables if they are absent. Idempotent, safe to call on every request.
 *
 * ensureOnce() memoises the in-flight promise per process and DELETES the cache entry if the
 * callback rejects (src/lib/ensure-once.ts:16-19), so a transient failure retries on the next call
 * instead of poisoning the process for its lifetime. That reset is why the catch below RE-THROWS
 * after logging: a swallowed failure here would leave no trace and the only symptom would be a
 * workflow surface that is permanently, silently empty.
 *
 * ensureOnce() then swallows the rejection for the CALLER, so consumers keep the tolerate-missing-
 * schema behaviour the rest of this codebase relies on. Every read in workflow.ts fails closed on
 * top of that, and every WRITE refuses rather than proceeding: no schema means no approval, never
 * an assumed one.
 */
export function ensureWorkflowSchema(): Promise<void> {
  return ensureOnce('workflow_v1', async () => {
    try {
      await createWorkflowTables();
    } catch (e: any) {
      logFail('ensureWorkflowSchema', e);
      throw e;
    }
  });
}

async function createWorkflowTables(): Promise<void> {
  // workflow_instances and its twelve column assertions, in one message.
  await sqlClient().unsafe(guardedDdl(WORKFLOW_INSTANCES_DDL)).simple();

  // NO CHECK CONSTRAINT ON `state` OR `domain`, and no foreign key to the domain tables. Same three
  // reasons as org_relationships:
  //   - a CHECK would have to be DROPPED and recreated to add a state or a domain, and this project
  //     has no migration runner: every DDL change is CREATE/ADD IF NOT EXISTS, which cannot alter an
  //     existing CHECK. The vocabulary is enforced in TypeScript (WORKFLOW_STATES, WORKFLOW_DOMAINS
  //     in src/lib/workflow.ts) and audited by db/workflow-validate.sql, which reports any value
  //     outside the list;
  //   - a foreign key to hr_leave_request would make deleting a leave row take the approval history
  //     with it, and that history is the evidence behind the decision;
  //   - record_id is TEXT and points at six different tables, so there is no single table to
  //     reference anyway.

  // ONE INSTANCE PER RECORD, ENFORCED BY THE DATABASE.
  //
  // This is the idempotency backstop for startWorkflow(): two clicks on "Send for approval", or a
  // retried POST, cannot produce two live approvals of the same request routed to two different
  // people. The engine ALSO checks before inserting, but a check standing in front of a write is a
  // race and this index is not — a second concurrent insert is rejected by Postgres, and
  // startWorkflow() reads the existing row back and reports "already started" rather than failing.
  //
  // DELIBERATELY NOT PARTIAL. A rejected leave request that is re-submitted becomes a NEW row in
  // hr_leave_request with a new id, so it gets a new instance naturally. Allowing a second instance
  // against the SAME record_id would mean one request could be approved and rejected at once.
  //
  // NOT IN EITHER BLOCK ABOVE, for the reason its catch describes: a block is one implicit
  // transaction, so folding this in would let a duplicate row in existing data roll the tables back.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS workflow_instances_record_uq
      ON workflow_instances (domain, record_id)`);
  } catch (e: any) {
    // Its own try/catch: if existing data violates it the index fails to create and the log names
    // the real Postgres reason, but the table above is already built and the engine still works
    // (startWorkflow's own pre-check still prevents the ordinary double-click). A bootstrap that
    // aborts halfway leaves a half-made schema, which is worse than a missing index.
    logFail('workflow_instances_record_uq', e);
  }

  // The three workflow_instances indexes and the whole of workflow_steps — the next unguarded run,
  // in its original order. Concatenated so it travels as ONE message while each block keeps the
  // comments that belong above it.
  await sqlClient().unsafe(guardedDdl(WORKFLOW_INSTANCE_INDEXES_DDL + WORKFLOW_STEPS_DDL)).simple();

  try {
    // ONE PENDING DECISION PER PERSON PER STEP. Without this, two routing passes over the same
    // instance — a retried start, an escalation that resolves the same person the graph already
    // named — would owe one person two approvals of one request, and "all approved" would then be
    // unreachable until they clicked twice. COALESCE gives the nullable approver column a stable
    // key, because two NULLs are distinct to a plain unique index.
    //
    // Scoped to PENDING rows only, deliberately: a person may legitimately appear twice in the
    // history of one instance (approve, the instance is reopened, approve again).
    //
    // Left out of the block above for the same reason as workflow_instances_record_uq: it is
    // tolerated individually, and a block that included it would roll the whole of workflow_steps
    // back the first time existing data owed one person two pending decisions.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS workflow_steps_one_pending_per_approver_uq
      ON workflow_steps (
        instance_id,
        step_no,
        COALESCE(approver_employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      WHERE decision = 'pending'`);
  } catch (e: any) {
    logFail('workflow_steps_one_pending_per_approver_uq', e);
  }
}
