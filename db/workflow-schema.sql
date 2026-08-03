-- ================================================================================================
-- db/workflow-schema.sql — LAYER 3 (WORKFLOW) STORAGE, as one file the founder can run by hand.
--
-- WHO RUNS THIS: nobody has to. src/lib/workflow-schema.ts creates exactly these objects on the
-- first call to any workflow function, inside an ensureOnce() guard that resets on failure. This
-- file exists so the schema can be READ without reading TypeScript, applied ahead of time on a
-- database that has never served a workflow request, and diffed against what is actually live.
--
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase connected to a database.
--
--     psql "$DATABASE_URL" -f db/workflow-schema.sql
--
-- SAFE TO RUN TWICE. Every statement is CREATE ... IF NOT EXISTS or ADD COLUMN IF NOT EXISTS.
-- Running it against a database that already has these tables changes nothing.
--
-- IT MUST STAY BYTE-FOR-BYTE EQUIVALENT TO src/lib/workflow-schema.ts. If the two ever disagree,
-- the TypeScript is the one that runs in production — this file is the documentation of it, and a
-- documentation file that has drifted is worse than none.
--
-- ================================================================================================
-- THE THREE LAYERS. THIS FILE IS LAYER 3 AND NOTHING ELSE.
--
--   Layer 1  ORGANIZATION   who is responsible for whom   -> org_relationships (db/org-graph-schema.sql)
--   Layer 2  AUTHORIZATION  what a user may do            -> src/lib/auth/permissions.ts. NOT IN SQL.
--   Layer 3  WORKFLOW       how work moves                -> THESE TWO TABLES.
--
-- THERE IS NO ROLE COLUMN AND NO CAPABILITY COLUMN IN EITHER TABLE, and there must never be one.
-- `via` and `acted_via` record which RELATIONSHIP was walked and HOW the decider was entitled — they
-- are written after the decision, for audit, and nothing reads them to make one. The moment a
-- workflow table stores "who may approve" as a property of a person, the three layers have collapsed
-- and every manager has authority over every employee.
-- ================================================================================================


-- ================================================================================================
-- workflow_instances — ONE ROW PER REQUEST MOVING THROUGH AN APPROVAL.
--
--   domain      'leave' | 'attendance' | 'expenses' | 'procurement' | 'recruitment' | 'travel'
--   record_id   the id of the row in that domain's own table. TEXT, NOT uuid — these six domains do
--               not agree on an id type, and a ::uuid column would throw the first time a non-uuid
--               domain is wired.
--   state       draft | pending | approved | rejected | cancelled | halted
--
--               'halted' IS THE IMPORTANT ONE. It is what the engine writes when the organization
--               graph cannot name an approver. It is not 'approved' and it is not 'pending' waiting
--               on nobody. A request that auto-approved because routing failed is the worst outcome
--               this system can produce, so "we could not work out who approves this" has its own
--               state and its own sentence in halt_reason.
--
-- NO CHECK CONSTRAINT ON state OR domain, and NO FOREIGN KEY to any domain table. Three reasons:
--   - a CHECK would have to be DROPPED and recreated to add a state or a domain, and this project
--     has no migration runner: every DDL change is CREATE/ADD IF NOT EXISTS, which cannot alter an
--     existing CHECK. The vocabulary is enforced in TypeScript (WORKFLOW_STATES / WORKFLOW_DOMAINS
--     in src/lib/workflow.ts) and audited by db/workflow-validate.sql;
--   - a foreign key to hr_leave_request would make deleting a leave row take the approval history
--     with it, and that history is the evidence behind the decision;
--   - record_id points at six different tables, so there is no single table to reference anyway.
-- ================================================================================================
CREATE TABLE IF NOT EXISTS workflow_instances (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain               TEXT NOT NULL,
  record_id            TEXT NOT NULL,
  subject_employee_id  UUID,          -- hr_employees.id. NOT users.id. See the trap note below.
  requested_by_user_id UUID,          -- users.id.
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

-- CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS. That is
-- how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
-- table, which locked every administrator out of /admin for a day. Every column past the primary key
-- is asserted again.
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS subject_employee_id  UUID;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS requested_by_user_id UUID;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS state                TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS current_step         INT NOT NULL DEFAULT 1;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS halt_reason          TEXT;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS summary              TEXT;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS amount               NUMERIC(14,2);
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS currency             TEXT;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS created_by           UUID;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS settled_at           TIMESTAMPTZ;

-- ONE INSTANCE PER RECORD, ENFORCED BY THE DATABASE.
--
-- This is the idempotency backstop for startWorkflow(): two clicks on "send for approval", or a
-- retried POST on a phone with one bar of signal, cannot produce two live approvals of the same
-- request routed to two different people. The engine checks before inserting as well, but a check
-- standing in front of a write is a race and this index is not.
--
-- DELIBERATELY NOT PARTIAL. A rejected request that is raised again becomes a NEW row in the domain
-- table with a new id, so it gets a new instance naturally. Allowing a second instance against the
-- same record_id would mean one request could be approved and rejected at the same time.
--
-- IF THIS FAILS TO CREATE because of existing duplicate rows, db/workflow-validate.sql section 3
-- lists them. The engine still works without it — startWorkflow() uses an untargeted
-- ON CONFLICT DO NOTHING for exactly that reason — with the weaker guarantee stated rather than
-- assumed.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_instances_record_uq
  ON workflow_instances (domain, record_id);

-- "What is waiting, across the company" — the queue view.
CREATE INDEX IF NOT EXISTS workflow_instances_state_idx
  ON workflow_instances (state, domain, created_at DESC);
-- "Everything raised about this person" — their own history.
CREATE INDEX IF NOT EXISTS workflow_instances_subject_idx
  ON workflow_instances (subject_employee_id, created_at DESC);
-- The halt sweep: every request stopped because routing could not name anybody.
CREATE INDEX IF NOT EXISTS workflow_instances_halted_idx
  ON workflow_instances (state, updated_at DESC);


-- ================================================================================================
-- workflow_steps — ONE ROW PER APPROVAL DECISION THAT IS OWED.
--
--   step_no    the position in the chain. SEQUENTIAL steps have one row each and run in ascending
--              order. PARALLEL approval is several rows SHARING one step_no — every one of them must
--              approve before current_step advances. That is the entire mechanism; there is no
--              separate parallel flag that could get out of step with the rows.
--   mode       'sequential' | 'parallel' | 'executive'. DESCRIPTIVE, for rendering and audit. The
--              behaviour comes from how many rows share step_no, never from this string.
--   via        WHICH ORG RELATIONSHIP RESOLVED THIS APPROVER — a value of org_relationships.type
--              ('reporting_manager', 'department_head', 'approval_owner', 'executive_sponsor').
--              RECORDED, NEVER CONSULTED. It is not a role name, nothing compares it to users.role,
--              and nothing grants anything from it.
--   acted_via  HOW THE PERSON WHO DECIDED WAS ENTITLED TO: 'routed' (they are the approver this step
--              was routed to), 'delegate' (an in-force temporary_delegate edge over that approver)
--              or 'capability' (they hold the domain's Layer 2 approval capability). Written AFTER
--              the check, never read to make one.
--   due_at     when this step becomes eligible for escalation. NULL never escalates on its own.
--   escalated_from_step_id
--              set on a step created BECAUSE another went unanswered. The original row is left
--              pending on purpose — escalation ADDS somebody who can act, it does not take the
--              decision away from the person whose decision it is.
--
-- THE ID-SPACE TRAP, stated where the columns are: approver_employee_id holds hr_employees.id,
-- approver_user_id holds users.id. BOTH are stored because the workflow needs both — the org graph
-- answers in employee ids, and notifications and session checks happen in user ids. Resolving one
-- from the other on every read would be a query per row on somebody's phone.
-- ================================================================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id            UUID NOT NULL,
  step_no                INT NOT NULL DEFAULT 1,
  mode                   TEXT NOT NULL DEFAULT 'sequential',
  via                    TEXT,
  approver_employee_id   UUID,          -- hr_employees.id
  approver_user_id       UUID,          -- users.id
  decision               TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|skipped
  decided_by_user_id     UUID,
  decided_at             TIMESTAMPTZ,
  acted_via              TEXT,
  note                   TEXT,
  due_at                 TIMESTAMPTZ,
  escalated_from_step_id UUID,
  notified_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS step_no                INT NOT NULL DEFAULT 1;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS mode                   TEXT NOT NULL DEFAULT 'sequential';
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS via                    TEXT;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approver_employee_id   UUID;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approver_user_id       UUID;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS decision               TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS decided_by_user_id     UUID;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS decided_at             TIMESTAMPTZ;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS acted_via              TEXT;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS note                   TEXT;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS due_at                 TIMESTAMPTZ;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS escalated_from_step_id UUID;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS notified_at            TIMESTAMPTZ;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The step list for one instance, in chain order. Every read of an instance uses this.
CREATE INDEX IF NOT EXISTS workflow_steps_instance_idx
  ON workflow_steps (instance_id, step_no, created_at);
-- "What is waiting on ME" — the only query an approver's phone actually runs.
CREATE INDEX IF NOT EXISTS workflow_steps_approver_idx
  ON workflow_steps (approver_user_id, decision, due_at);
-- The same question in employee-id space, for the delegate lookup.
CREATE INDEX IF NOT EXISTS workflow_steps_approver_emp_idx
  ON workflow_steps (approver_employee_id, decision);
-- The escalation sweep: pending steps past due.
CREATE INDEX IF NOT EXISTS workflow_steps_due_idx
  ON workflow_steps (decision, due_at);

-- ONE PENDING DECISION PER PERSON PER STEP.
--
-- Without this, two routing passes over one instance — a retried start, or an escalation that
-- resolves somebody the graph had already named — would owe one person two approvals of one
-- request, and "all approved" would be unreachable until they clicked twice.
--
-- COALESCE gives the nullable approver column a stable key: two NULLs are DISTINCT to a plain
-- unique index, so without it the same gap could be recorded twice.
--
-- Scoped to PENDING rows deliberately: a person may legitimately appear twice in the history of one
-- instance, and constraining decided rows would make that history unrecordable.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_steps_one_pending_per_approver_uq
  ON workflow_steps (
    instance_id,
    step_no,
    COALESCE(approver_employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE decision = 'pending';


-- ================================================================================================
-- WHAT IS DELIBERATELY ABSENT FROM THIS FILE
--
-- NO workflow_events TABLE. `audit_log` is this codebase's audit log (src/lib/audit.ts) and every
-- transition in src/lib/workflow.ts writes to it. A parallel events table would be a SECOND audit
-- log that drifts from the first, consulted by different screens, disagreeing about the same
-- approval. The instance timeline is fully reconstructable without one: each step row carries its
-- decision, decider, timestamp and note; an escalation is a step pointing at the step it escalated
-- from; a delegated action is recorded on the step it was taken against.
--
-- NO NOTIFICATION TABLE. `notifications` already exists and src/lib/push.ts already writes to it.
-- One notifier.
--
-- NO TRIGGERS AND NO SECURITY DEFINER FUNCTIONS. This project bootstraps its DDL over a Supabase
-- TRANSACTION POOLER connection, which cannot create roles and does not guarantee a session for
-- SET LOCAL. Every invariant here is an index or is enforced in TypeScript and audited by
-- db/workflow-validate.sql. That is a weaker guarantee than a trigger, honestly stated.
-- ================================================================================================
