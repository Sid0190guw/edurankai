-- db/manager-intelligence-schema.sql
-- PATCH 14 — Manager and Team Lead Intelligence. The three tables this patch owns.
--
-- RUN THIS ONCE, BY HAND, AGAINST THE PRODUCTION DATABASE.
--
-- Schema bootstrap is switched off in production on this project (src/lib/ensure-once.ts returns
-- early when NODE_ENV is production, after a cold deploy's DDL storm took the site down on
-- 2026-08-23). So src/lib/manager-intelligence/schema.ts creates these tables in development and
-- this file creates them everywhere else. The statements are the same statements in the same order;
-- MTI_DDL in that module is the source they were copied from.
--
-- Every statement is idempotent. Running it twice changes nothing.
--
-- WHAT THIS DOES NOT CREATE, ON PURPOSE:
--   no feedback table   -- hr_feedback exists; src/lib/performance.ts owns it
--   no ticket table     -- helpdesk_tickets exists; src/lib/helpdesk.ts owns it, with routing
--   no employee, task, attendance, leave, goal or event table -- all of them already exist
--
-- NO FOREIGN KEYS to hr_employees or users, matching every other hr_* table in this repository: a
-- record of what a manager did should outlive the deletion of a row rather than vanish with it.

BEGIN;

-- -------------------------------------------------------------------------------------------------
-- 1. THE ACT LOG. APPEND-ONLY (see the trigger at the bottom of this file).
--
-- signal_snapshot holds the signal envelope the manager was looking at when they acted — inputs,
-- processing, output, evidence, confidence, timestamp. It is stored rather than recomputed because
-- the numbers move: "why did they record this intervention" has to survive next week's task board.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mti_manager_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_employee_id  UUID NOT NULL,
  actor_user_id        UUID NOT NULL,
  actor_employee_id    UUID,
  kind                 TEXT NOT NULL,
  section              TEXT,
  signal_key           TEXT,
  signal_snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_ref           TEXT,
  note                 TEXT,
  visibility           TEXT NOT NULL DEFAULT 'manager_and_hr',
  authority_basis      TEXT NOT NULL DEFAULT 'unrecorded',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mti_actions_subject_idx ON mti_manager_actions (subject_employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mti_actions_actor_idx ON mti_manager_actions (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mti_actions_signal_idx ON mti_manager_actions (subject_employee_id, signal_key, created_at DESC);

-- -------------------------------------------------------------------------------------------------
-- 2. TRACKED DEVELOPMENT ACTIONS. A status that moves — unlike the log above.
--
-- Every move also appends a row to mti_manager_actions, so the TRAIL is append-only even though the
-- item itself is not.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mti_development_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id            UUID,
  subject_employee_id  UUID NOT NULL,
  created_by_user_id   UUID NOT NULL,
  title                TEXT NOT NULL,
  detail               TEXT,
  status               TEXT NOT NULL DEFAULT 'open',
  target_date          DATE,
  visible_to_employee  BOOLEAN NOT NULL DEFAULT TRUE,
  outcome_note         TEXT,
  closed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mti_dev_subject_idx ON mti_development_actions (subject_employee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS mti_dev_owner_idx ON mti_development_actions (created_by_user_id, created_at DESC);

-- -------------------------------------------------------------------------------------------------
-- 3. THE OUTBOX TO THE CENTRAL EMPLOYEE INTELLIGENCE RECORD.
--
-- Written inside the same request as the act it describes, so nothing is lost when the central
-- record's owning patch is not deployed, not registered, or temporarily failing. The consumer
-- contract is in docs/manager-intelligence.md.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mti_record_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id     UUID NOT NULL,
  envelope      JSONB NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  published_at  TIMESTAMPTZ,
  publish_error TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mti_outbox_pending_idx ON mti_record_outbox (created_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS mti_outbox_action_idx ON mti_record_outbox (action_id);

COMMIT;

-- -------------------------------------------------------------------------------------------------
-- THE APPEND-ONLY GUARANTEE, OUTSIDE THE TRANSACTION ABOVE SO IT CAN FAIL ALONE.
--
-- A record of what a manager did about a colleague is worth nothing if it can be edited afterwards.
-- src/lib/manager-intelligence/schema.ts reports through schemaState().appendOnlyEnforced whether
-- this actually took, rather than assuming it did.
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mti_actions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mti_manager_actions is append-only: % is refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mti_actions_no_change ON mti_manager_actions;
CREATE TRIGGER mti_actions_no_change
  BEFORE UPDATE OR DELETE ON mti_manager_actions
  FOR EACH ROW EXECUTE FUNCTION mti_actions_append_only();

-- -------------------------------------------------------------------------------------------------
-- VERIFY. Expect three rows, and t for the trigger.
-- -------------------------------------------------------------------------------------------------
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public'
--    AND table_name IN ('mti_manager_actions','mti_development_actions','mti_record_outbox')
--  ORDER BY table_name;
--
-- SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mti_actions_no_change' AND NOT tgisinternal)
--        AS append_only_enforced;
