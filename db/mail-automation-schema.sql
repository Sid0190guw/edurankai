-- db/mail-automation-schema.sql
-- What the automation EXECUTOR adds (src/lib/mailplatform).
--
-- RUN THIS YOURSELF. CLAUDE.md forbids this repository's agents from opening a database connection,
-- so nothing here has been created for you. ensureAutomationSchema() runs the identical statements
-- on first use if you would rather.
--
--   psql "$DATABASE_URL" -f db/mail-automation-schema.sql
--
-- RUN db/mail-platform-schema.sql FIRST. mail_automations, mail_automation_runs, mail_contacts,
-- mail_lists, mail_list_members and email_templates are created there; this file only adds to them.
-- Nothing below redefines a table somebody else owns: CREATE TABLE IF NOT EXISTS is SILENT when a
-- table already exists with a different shape, which would look like it worked and create nothing.
--
-- Safe to run more than once.
--
-- THE THREE CONSTRAINTS IN HERE THAT ARE NOT DECORATION:
--   mail_automation_events.event_id PRIMARY KEY                  one event is handled once, however many times it arrives
--   mail_automation_runs UNIQUE (automation_id, trigger_event_id) one event starts at most one run per automation
--   mail_automation_steps PRIMARY KEY (run_id, node_id)           one effect per step, so nothing is sent twice

-- ---------------------------------------------------------------------------------------------
-- Tables this engine owns
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mail_automation_events (
    event_id varchar(128) PRIMARY KEY,
    org_id varchar(64) NOT NULL DEFAULT 'edurankai',
    type varchar(80) NOT NULL,
    contact_id uuid,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    source varchar(16) NOT NULL DEFAULT 'internal',
    occurred_at timestamptz NOT NULL DEFAULT now(),
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    started_runs integer NOT NULL DEFAULT 0,
    error text
  );

CREATE INDEX IF NOT EXISTS mail_automation_events_org_idx ON mail_automation_events(org_id, received_at DESC);

CREATE TABLE IF NOT EXISTS mail_automation_steps (
    run_id uuid NOT NULL,
    node_id varchar(64) NOT NULL,
    attempt integer NOT NULL DEFAULT 1,
    status varchar(16) NOT NULL DEFAULT 'running',
    claimed_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    result jsonb,
    error text,
    external_ref text,
    PRIMARY KEY (run_id, node_id)
  );

CREATE TABLE IF NOT EXISTS mail_automation_versions (
    automation_id uuid NOT NULL,
    org_id varchar(64) NOT NULL DEFAULT 'edurankai',
    version integer NOT NULL,
    graph jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (automation_id, version)
  );

-- ---------------------------------------------------------------------------------------------
-- Columns the executor needs on tables the builder already owns. Additive and defaulted, so every
-- existing row and every existing query is unaffected.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS org_id varchar(64) NOT NULL DEFAULT 'edurankai';
ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS webhook_token varchar(64);
ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS webhook_secret varchar(128);
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS org_id varchar(64) NOT NULL DEFAULT 'edurankai';
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS graph_version integer NOT NULL DEFAULT 1;
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS error_kind varchar(16);
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS dead_letter boolean NOT NULL DEFAULT false;
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS trigger_event_id varchar(128);

-- ---------------------------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS mail_automations_token_idx ON mail_automations(webhook_token) WHERE webhook_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mail_automation_runs_event_idx ON mail_automation_runs(automation_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mail_automation_runs_org_idx ON mail_automation_runs(org_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS mail_automation_runs_dead_idx ON mail_automation_runs(org_id) WHERE dead_letter;
