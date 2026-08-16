-- db/mail-automation-schema.sql
-- The tables for the event-driven automation engine (src/lib/mailplatform).
--
-- RUN THIS YOURSELF. CLAUDE.md forbids this repository's agents from opening a database connection,
-- so these tables have NOT been created for you. Either run this file, or let
-- ensureAutomationSchema() create them on first use -- the statements are identical and idempotent.
--
--   psql "$DATABASE_URL" -f db/mail-automation-schema.sql
--
-- Safe to run more than once: every statement is IF NOT EXISTS.
--
-- THE THREE CONSTRAINTS IN HERE THAT ARE NOT DECORATION:
--   mail_workflow_events.event_id PRIMARY KEY                   one event is handled once, however many times it arrives
--   mail_workflow_runs UNIQUE (workflow_id, trigger_event_id)   one event starts at most one run per workflow
--   mail_workflow_steps PRIMARY KEY (run_id, node_id)           one effect per step, so nothing is sent twice

CREATE TABLE IF NOT EXISTS mail_workflows (
    id VARCHAR(64) PRIMARY KEY,
    org_id VARCHAR(64) NOT NULL DEFAULT 'edurankai',
    key VARCHAR(80) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    version INT NOT NULL DEFAULT 1,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    trigger_event VARCHAR(80) NOT NULL DEFAULT '',
    webhook_token VARCHAR(64),
    webhook_secret VARCHAR(128),
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE UNIQUE INDEX IF NOT EXISTS mail_workflows_org_key_idx ON mail_workflows(org_id, key);

CREATE INDEX IF NOT EXISTS mail_workflows_listen_idx ON mail_workflows(org_id, trigger_event) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS mail_workflows_token_idx ON mail_workflows(webhook_token) WHERE webhook_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_workflow_versions (
    workflow_id VARCHAR(64) NOT NULL,
    org_id VARCHAR(64) NOT NULL,
    version INT NOT NULL,
    definition JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workflow_id, version)
  );

CREATE TABLE IF NOT EXISTS mail_workflow_events (
    event_id VARCHAR(128) PRIMARY KEY,
    org_id VARCHAR(64) NOT NULL,
    type VARCHAR(80) NOT NULL,
    contact_id VARCHAR(64),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(16) NOT NULL DEFAULT 'internal',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    started_runs INT NOT NULL DEFAULT 0,
    error TEXT
  );

CREATE INDEX IF NOT EXISTS mail_workflow_events_org_idx ON mail_workflow_events(org_id, received_at DESC);

CREATE TABLE IF NOT EXISTS mail_workflow_runs (
    run_id VARCHAR(64) PRIMARY KEY,
    workflow_id VARCHAR(64) NOT NULL,
    workflow_version INT NOT NULL DEFAULT 1,
    org_id VARCHAR(64) NOT NULL,
    contact_id VARCHAR(64),
    current_node VARCHAR(64),
    state VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
    wait_until TIMESTAMPTZ,
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error TEXT,
    error_kind VARCHAR(16),
    retry_count INT NOT NULL DEFAULT 0,
    dead_letter BOOLEAN NOT NULL DEFAULT false,
    trigger_event_id VARCHAR(128)
  );

CREATE UNIQUE INDEX IF NOT EXISTS mail_workflow_runs_event_idx ON mail_workflow_runs(workflow_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mail_workflow_runs_due_idx ON mail_workflow_runs(state, wait_until) WHERE state IN ('WAITING','RUNNING');

CREATE INDEX IF NOT EXISTS mail_workflow_runs_list_idx ON mail_workflow_runs(org_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS mail_workflow_runs_wf_idx ON mail_workflow_runs(workflow_id, state);

CREATE TABLE IF NOT EXISTS mail_workflow_steps (
    run_id VARCHAR(64) NOT NULL,
    node_id VARCHAR(64) NOT NULL,
    attempt INT NOT NULL DEFAULT 1,
    status VARCHAR(16) NOT NULL DEFAULT 'running',
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    result JSONB,
    error TEXT,
    external_ref TEXT,
    PRIMARY KEY (run_id, node_id)
  );

CREATE TABLE IF NOT EXISTS mail_contacts (
    id VARCHAR(64) PRIMARY KEY DEFAULT ('contact_' || replace(gen_random_uuid()::text, '-', '')),
    org_id VARCHAR(64) NOT NULL DEFAULT 'edurankai',
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(120),
    last_name VARCHAR(120),
    organization VARCHAR(200),
    phone VARCHAR(40),
    role_title VARCHAR(120),
    application_stage VARCHAR(40),
    application_number VARCHAR(64),
    custom JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    unsubscribed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE UNIQUE INDEX IF NOT EXISTS mail_contacts_org_email_idx ON mail_contacts(org_id, email);

CREATE TABLE IF NOT EXISTS mail_contact_lists (
    id VARCHAR(64) PRIMARY KEY DEFAULT ('list_' || replace(gen_random_uuid()::text, '-', '')),
    org_id VARCHAR(64) NOT NULL DEFAULT 'edurankai',
    key VARCHAR(64) NOT NULL,
    name VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE UNIQUE INDEX IF NOT EXISTS mail_contact_lists_org_key_idx ON mail_contact_lists(org_id, key);

CREATE TABLE IF NOT EXISTS mail_contact_list_members (
    list_id VARCHAR(64) NOT NULL,
    contact_id VARCHAR(64) NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_id, contact_id)
  );
