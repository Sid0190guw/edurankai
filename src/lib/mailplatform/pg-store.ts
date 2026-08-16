// src/lib/mailplatform/pg-store.ts — AutomationStore against Postgres.
//
// The engine's guarantees are claims about atomicity, and this is the file that has to make them
// true. Three statements carry all of them, and each is a single statement on purpose — a SELECT
// followed by an UPDATE is two workers reading the same row and both acting on it:
//
//   claimDueRuns   UPDATE … WHERE run_id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING
//   claimStep      INSERT … ON CONFLICT (run_id, node_id) DO UPDATE … WHERE (still claimable)
//   createRun      INSERT … ON CONFLICT (workflow_id, trigger_event_id) DO NOTHING
//
// HOUSE RULES OBSERVED HERE, each of which has cost this project an outage before:
//   - postgres-js returns a PLAIN ARRAY. `r.rows[0]` is undefined against it. Everything goes
//     through rows().
//   - the real Postgres reason is on e.cause; e.message is only the failed SQL.
//   - a schema bootstrap that fails is NOT cached as done, or one transient pooler error leaves the
//     process permanently convinced the tables exist.
//
// THE DDL IS ALSO WRITTEN OUT AS db/mail-automation-schema.sql. CLAUDE.md forbids this repository's
// agents from opening a database connection, so these tables have NOT been created by me; the SQL
// file is what a human runs. ensureAutomationSchema() below is the same statements, idempotent, for
// the deployment that would rather have them created on first use.
import type {
  AutomationStore, ClaimOutcome, ContactRecord, EventRecord, ListRecord, ListRunsFilter,
  RunRecord, RunState, StepRecord, StepStatus, WorkflowRecord, WorkflowStatus,
} from './store';
import { normalizeEmail, normalizeKey, normalizeTag } from './store';
import type { WorkflowDefinition } from './graph';
import type { IncomingEvent } from './triggers';

const rows = (r: any): any[] => (Array.isArray(r) ? r : r?.rows || []);
const reason = (e: any): string => String(e?.cause?.message || e?.message || e);

/** Every statement, in dependency order. Mirrored by db/mail-automation-schema.sql. */
export const AUTOMATION_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS mail_workflows (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_workflows_org_key_idx ON mail_workflows(org_id, key)`,
  // The router's one query. Narrow, because it runs for every event the platform emits.
  `CREATE INDEX IF NOT EXISTS mail_workflows_listen_idx ON mail_workflows(org_id, trigger_event) WHERE status = 'active'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_workflows_token_idx ON mail_workflows(webhook_token) WHERE webhook_token IS NOT NULL`,

  // A run executes the shape it started on. One row per EDIT, not per run.
  `CREATE TABLE IF NOT EXISTS mail_workflow_versions (
    workflow_id VARCHAR(64) NOT NULL,
    org_id VARCHAR(64) NOT NULL,
    version INT NOT NULL,
    definition JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workflow_id, version)
  )`,

  // event_id is the PRIMARY KEY, which IS the idempotency guarantee for inbound events.
  `CREATE TABLE IF NOT EXISTS mail_workflow_events (
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
  )`,
  `CREATE INDEX IF NOT EXISTS mail_workflow_events_org_idx ON mail_workflow_events(org_id, received_at DESC)`,

  `CREATE TABLE IF NOT EXISTS mail_workflow_runs (
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
  )`,
  // ONE EVENT STARTS AT MOST ONE RUN PER WORKFLOW. The index is the guarantee; the check in
  // createRun() is a convenience that makes the answer readable.
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_workflow_runs_event_idx ON mail_workflow_runs(workflow_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL`,
  // The claim query's index: due waiters first, then abandoned runners.
  `CREATE INDEX IF NOT EXISTS mail_workflow_runs_due_idx ON mail_workflow_runs(state, wait_until) WHERE state IN ('WAITING','RUNNING')`,
  `CREATE INDEX IF NOT EXISTS mail_workflow_runs_list_idx ON mail_workflow_runs(org_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mail_workflow_runs_wf_idx ON mail_workflow_runs(workflow_id, state)`,

  // THE IDEMPOTENCY LEDGER. One row per (run, node); the primary key is what stops a second send.
  `CREATE TABLE IF NOT EXISTS mail_workflow_steps (
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
  )`,

  `CREATE TABLE IF NOT EXISTS mail_contacts (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_contacts_org_email_idx ON mail_contacts(org_id, email)`,

  `CREATE TABLE IF NOT EXISTS mail_contact_lists (
    id VARCHAR(64) PRIMARY KEY DEFAULT ('list_' || replace(gen_random_uuid()::text, '-', '')),
    org_id VARCHAR(64) NOT NULL DEFAULT 'edurankai',
    key VARCHAR(64) NOT NULL,
    name VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_contact_lists_org_key_idx ON mail_contact_lists(org_id, key)`,

  `CREATE TABLE IF NOT EXISTS mail_contact_list_members (
    list_id VARCHAR(64) NOT NULL,
    contact_id VARCHAR(64) NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_id, contact_id)
  )`,
];

let ready: Promise<void> | null = null;

/**
 * Create the tables if they are not there. Idempotent.
 *
 * A FAILURE IS NOT CACHED AS DONE. `ready` is cleared on the way out of the catch, so a pooler blip
 * during a cold start does not leave every later call in the process convinced the schema exists and
 * failing with "relation does not exist" and no line anywhere saying why.
 */
export function ensureAutomationSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      const { db } = await import('@/lib/db');
      const { sql } = await import('drizzle-orm');
      for (const stmt of AUTOMATION_DDL) await db.execute(sql.raw(stmt));
    } catch (e: any) {
      console.error('[mailplatform] schema boot failed:', reason(e));
      ready = null;
      throw e;
    }
  })();
  return ready;
}

async function ctx() {
  await ensureAutomationSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const asDate = (v: any): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v));
const asObj = (v: any): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v : typeof v === 'string' ? (safeParse(v) ?? {}) : {});
const asArr = (v: any): any[] => (Array.isArray(v) ? v : typeof v === 'string' ? (Array.isArray(safeParse(v)) ? safeParse(v) : []) : []);
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

function toWorkflow(r: any): WorkflowRecord {
  return {
    id: r.id, orgId: r.org_id, key: r.key, name: r.name, description: r.description || '',
    status: r.status as WorkflowStatus, version: Number(r.version || 1),
    definition: asObj(r.definition) as unknown as WorkflowDefinition,
    triggerEvent: r.trigger_event || '', webhookToken: r.webhook_token || null,
    createdByUserId: r.created_by_user_id || null,
    createdAt: asDate(r.created_at) as Date, updatedAt: asDate(r.updated_at) as Date,
  };
}
function toRun(r: any): RunRecord {
  return {
    runId: r.run_id, workflowId: r.workflow_id, workflowVersion: Number(r.workflow_version || 1), orgId: r.org_id,
    contactId: r.contact_id || null, currentNode: r.current_node || null, state: r.state as RunState,
    waitUntil: asDate(r.wait_until), context: asObj(r.context),
    startedAt: asDate(r.started_at) as Date, updatedAt: asDate(r.updated_at) as Date, completedAt: asDate(r.completed_at),
    error: r.error || null, errorKind: (r.error_kind || null) as any, retryCount: Number(r.retry_count || 0),
    deadLetter: !!r.dead_letter, triggerEventId: r.trigger_event_id || null,
  };
}
function toStep(r: any): StepRecord {
  return {
    runId: r.run_id, nodeId: r.node_id, attempt: Number(r.attempt || 1), status: r.status as StepStatus,
    claimedAt: asDate(r.claimed_at) as Date, finishedAt: asDate(r.finished_at),
    result: r.result ? asObj(r.result) : null, error: r.error || null, externalRef: r.external_ref || null,
  };
}
function toEvent(r: any): EventRecord {
  return {
    eventId: r.event_id, orgId: r.org_id, type: r.type, contactId: r.contact_id || null,
    payload: asObj(r.payload), source: r.source, occurredAt: asDate(r.occurred_at) as Date,
    receivedAt: asDate(r.received_at) as Date, processedAt: asDate(r.processed_at),
    startedRuns: Number(r.started_runs || 0), error: r.error || null,
  };
}
function toContact(r: any): ContactRecord {
  return {
    id: r.id, orgId: r.org_id, email: r.email,
    firstName: r.first_name || null, lastName: r.last_name || null, organization: r.organization || null,
    phone: r.phone || null, roleTitle: r.role_title || null,
    applicationStage: r.application_stage || null, applicationNumber: r.application_number || null,
    custom: asObj(r.custom), tags: asArr(r.tags).map((t) => String(t)), unsubscribed: !!r.unsubscribed,
    createdAt: asDate(r.created_at) as Date, updatedAt: asDate(r.updated_at) as Date,
  };
}

export const pgStore: AutomationStore = {
  // ---- workflows ----
  async getWorkflow(orgId, id) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflows WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`));
    return r[0] ? toWorkflow(r[0]) : null;
  },
  async getWorkflowByKey(orgId, key) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflows WHERE org_id = ${orgId} AND key = ${key} LIMIT 1`));
    return r[0] ? toWorkflow(r[0]) : null;
  },
  async getWorkflowByWebhookToken(token) {
    if (!token) return null;
    const { db, sql } = await ctx();
    // The organisation comes from the ROW, never from the caller — otherwise whoever holds a token
    // chooses which tenant their events land in.
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflows WHERE webhook_token = ${token} LIMIT 1`));
    return r[0] ? toWorkflow(r[0]) : null;
  },
  async listWorkflows(orgId, opts = {}) {
    const { db, sql } = await ctx();
    const r = opts.status
      ? rows(await db.execute(sql`SELECT * FROM mail_workflows WHERE org_id = ${orgId} AND status = ${opts.status} ORDER BY updated_at DESC LIMIT ${opts.limit || 200}`))
      : rows(await db.execute(sql`SELECT * FROM mail_workflows WHERE org_id = ${orgId} ORDER BY updated_at DESC LIMIT ${opts.limit || 200}`));
    return r.map(toWorkflow);
  },
  async saveWorkflow(w) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      INSERT INTO mail_workflows (id, org_id, key, name, description, status, version, definition, trigger_event, webhook_token, created_by_user_id)
      VALUES (${w.id}, ${w.orgId}, ${w.key}, ${w.name}, ${w.description || ''}, ${w.status}, ${w.version},
              ${JSON.stringify(w.definition || {})}::jsonb, ${w.triggerEvent || ''}, ${w.webhookToken}, ${w.createdByUserId})
      ON CONFLICT (id) DO UPDATE SET
        key = EXCLUDED.key, name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
        version = EXCLUDED.version, definition = EXCLUDED.definition, trigger_event = EXCLUDED.trigger_event,
        webhook_token = EXCLUDED.webhook_token, updated_at = NOW()
      RETURNING *`));
    return toWorkflow(r[0]);
  },
  async deleteWorkflow(orgId, id) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`DELETE FROM mail_workflows WHERE org_id = ${orgId} AND id = ${id} RETURNING id`));
    return r.length > 0;
  },
  async workflowsListeningFor(orgId, eventType) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflows WHERE org_id = ${orgId} AND status = 'active' AND trigger_event = ${eventType}`));
    return r.map(toWorkflow);
  },
  async saveWorkflowVersion(orgId, workflowId, version, definition) {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mail_workflow_versions (workflow_id, org_id, version, definition)
      VALUES (${workflowId}, ${orgId}, ${version}, ${JSON.stringify(definition || {})}::jsonb)
      ON CONFLICT (workflow_id, version) DO NOTHING`);
  },
  async getWorkflowDefinition(orgId, workflowId, version) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT definition FROM mail_workflow_versions WHERE org_id = ${orgId} AND workflow_id = ${workflowId} AND version = ${version} LIMIT 1`));
    return r[0] ? (asObj(r[0].definition) as unknown as WorkflowDefinition) : null;
  },

  // ---- events ----
  async recordEvent(e: IncomingEvent) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      INSERT INTO mail_workflow_events (event_id, org_id, type, contact_id, payload, source, occurred_at)
      VALUES (${e.eventId}, ${e.orgId}, ${e.type}, ${e.contactId}, ${JSON.stringify(e.payload || {})}::jsonb, ${e.source}, ${e.occurredAt})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING *`));
    if (r[0]) return { stored: true, record: toEvent(r[0]) };
    // DO NOTHING returns no row, which is exactly the duplicate. Read the original back so the
    // caller can say WHEN it was first seen rather than only that it was.
    const existing = rows(await db.execute(sql`SELECT * FROM mail_workflow_events WHERE event_id = ${e.eventId} LIMIT 1`));
    return { stored: false, record: toEvent(existing[0] || { event_id: e.eventId, org_id: e.orgId, type: e.type, payload: {}, source: e.source, occurred_at: e.occurredAt, received_at: e.occurredAt }) };
  },
  async markEventProcessed(eventId, startedRuns, error = null) {
    const { db, sql } = await ctx();
    await db.execute(sql`UPDATE mail_workflow_events SET processed_at = NOW(), started_runs = ${startedRuns}, error = ${error} WHERE event_id = ${eventId}`);
  },
  async listEvents(orgId, opts = {}) {
    const { db, sql } = await ctx();
    const r = opts.type
      ? rows(await db.execute(sql`SELECT * FROM mail_workflow_events WHERE org_id = ${orgId} AND type = ${opts.type} ORDER BY received_at DESC LIMIT ${opts.limit || 100}`))
      : rows(await db.execute(sql`SELECT * FROM mail_workflow_events WHERE org_id = ${orgId} ORDER BY received_at DESC LIMIT ${opts.limit || 100}`));
    return r.map(toEvent);
  },

  // ---- runs ----
  async createRun(run) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      INSERT INTO mail_workflow_runs (run_id, workflow_id, workflow_version, org_id, contact_id, current_node, state, wait_until, context, started_at, updated_at, retry_count, dead_letter, trigger_event_id)
      VALUES (${run.runId}, ${run.workflowId}, ${run.workflowVersion}, ${run.orgId}, ${run.contactId}, ${run.currentNode}, ${run.state}, ${run.waitUntil},
              ${JSON.stringify(run.context || {})}::jsonb, ${run.startedAt}, ${run.updatedAt}, ${run.retryCount}, ${run.deadLetter}, ${run.triggerEventId})
      ON CONFLICT (workflow_id, trigger_event_id) DO NOTHING
      RETURNING *`));
    if (r[0]) return { created: true, run: toRun(r[0]) };
    const existing = rows(await db.execute(sql`SELECT * FROM mail_workflow_runs WHERE workflow_id = ${run.workflowId} AND trigger_event_id = ${run.triggerEventId} LIMIT 1`));
    return { created: false, run: existing[0] ? toRun(existing[0]) : run };
  },
  async getRun(orgId, runId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflow_runs WHERE org_id = ${orgId} AND run_id = ${runId} LIMIT 1`));
    return r[0] ? toRun(r[0]) : null;
  },
  async updateRun(runId, patch) {
    const { db, sql } = await ctx();
    // Written out rather than assembled from a loop: every column here is one an operator reads on a
    // failure screen, and a generic setter is how a typo silently writes to nothing.
    const r = rows(await db.execute(sql`
      UPDATE mail_workflow_runs SET
        current_node = ${patch.currentNode !== undefined ? patch.currentNode : sql`current_node`},
        state        = ${patch.state !== undefined ? patch.state : sql`state`},
        wait_until   = ${patch.waitUntil !== undefined ? patch.waitUntil : sql`wait_until`},
        context      = ${patch.context !== undefined ? sql`${JSON.stringify(patch.context)}::jsonb` : sql`context`},
        completed_at = ${patch.completedAt !== undefined ? patch.completedAt : sql`completed_at`},
        error        = ${patch.error !== undefined ? patch.error : sql`error`},
        error_kind   = ${patch.errorKind !== undefined ? patch.errorKind : sql`error_kind`},
        retry_count  = ${patch.retryCount !== undefined ? patch.retryCount : sql`retry_count`},
        dead_letter  = ${patch.deadLetter !== undefined ? patch.deadLetter : sql`dead_letter`},
        updated_at   = NOW()
      WHERE run_id = ${runId}
      RETURNING *`));
    return r[0] ? toRun(r[0]) : null;
  },
  async listRuns(orgId, f: ListRunsFilter = {}) {
    const { db, sql } = await ctx();
    const conds = [sql`org_id = ${orgId}`];
    if (f.workflowId) conds.push(sql`workflow_id = ${f.workflowId}`);
    if (f.contactId) conds.push(sql`contact_id = ${f.contactId}`);
    if (f.state) conds.push(sql`state = ${f.state}`);
    if (f.deadLetterOnly) conds.push(sql`dead_letter = true`);
    let where = conds[0];
    for (let i = 1; i < conds.length; i++) where = sql`${where} AND ${conds[i]}`;
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflow_runs WHERE ${where} ORDER BY updated_at DESC LIMIT ${f.limit || 100}`));
    return r.map(toRun);
  },
  async claimDueRuns(now, limit, staleMs) {
    const { db, sql } = await ctx();
    const stale = new Date(now.getTime() - staleMs);
    // ONE STATEMENT. SKIP LOCKED is what lets two overlapping ticks take DIFFERENT runs instead of
    // the same one; a SELECT-then-UPDATE here would let both advance the same run and execute the
    // same node twice.
    const r = rows(await db.execute(sql`
      UPDATE mail_workflow_runs SET state = 'RUNNING', wait_until = NULL, updated_at = NOW()
      WHERE run_id IN (
        SELECT run_id FROM mail_workflow_runs
        WHERE (state = 'WAITING' AND wait_until IS NOT NULL AND wait_until <= ${now})
           OR (state = 'RUNNING' AND updated_at <= ${stale})
        ORDER BY COALESCE(wait_until, updated_at) ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`));
    return r.map(toRun);
  },
  async countRuns(orgId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT state, COUNT(*)::int AS n FROM mail_workflow_runs WHERE org_id = ${orgId} GROUP BY state`));
    const c: Record<RunState, number> = { RUNNING: 0, WAITING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0, PAUSED: 0 };
    for (const row of r) if (row.state in c) (c as any)[row.state] = Number(row.n || 0);
    return c;
  },

  // ---- steps ----
  async claimStep(runId, nodeId, opts): Promise<ClaimOutcome> {
    const { db, sql } = await ctx();
    const stale = new Date(opts.now.getTime() - opts.staleMs);
    // The claim. The WHERE on the DO UPDATE is what makes it a claim rather than a write: it only
    // takes the row back if the step is retryable ('failed'), or abandoned AND safe to repeat.
    const claimed = rows(await db.execute(sql`
      INSERT INTO mail_workflow_steps (run_id, node_id, status, attempt, claimed_at)
      VALUES (${runId}, ${nodeId}, 'running', 1, ${opts.now})
      ON CONFLICT (run_id, node_id) DO UPDATE
        SET attempt = mail_workflow_steps.attempt + 1, status = 'running', claimed_at = ${opts.now}, finished_at = NULL, error = NULL
        WHERE mail_workflow_steps.status = 'failed'
           OR (${opts.reclaimStale} AND mail_workflow_steps.status = 'running' AND mail_workflow_steps.claimed_at <= ${stale})
      RETURNING *`));
    if (claimed[0]) return { outcome: 'claimed', step: toStep(claimed[0]) };

    const existing = rows(await db.execute(sql`SELECT * FROM mail_workflow_steps WHERE run_id = ${runId} AND node_id = ${nodeId} LIMIT 1`));
    if (!existing[0]) {
      // The insert did not happen and there is no row: another worker inserted and deleted between
      // the two statements, which nothing in this system does. Reported rather than guessed at.
      return { outcome: 'in_flight', step: { runId, nodeId, attempt: 0, status: 'running', claimedAt: opts.now, finishedAt: null, result: null, error: 'the step row could not be read back', externalRef: null } };
    }
    const step = toStep(existing[0]);
    if (step.status === 'done') return { outcome: 'already_done', step };
    if (step.status === 'needs_review') return { outcome: 'needs_review', step };
    if (step.status === 'running' && step.claimedAt.getTime() <= stale.getTime() && !opts.reclaimStale) {
      // Abandoned, and repeating it is visible outside this platform. Park it for a person.
      const marked = rows(await db.execute(sql`
        UPDATE mail_workflow_steps
        SET status = 'needs_review', error = ${'The worker stopped while this step was running, and repeating it could send the same message twice.'}
        WHERE run_id = ${runId} AND node_id = ${nodeId} AND status = 'running'
        RETURNING *`));
      return { outcome: 'needs_review', step: marked[0] ? toStep(marked[0]) : step };
    }
    return { outcome: 'in_flight', step };
  },
  async finishStep(runId, nodeId, status, patch) {
    const { db, sql } = await ctx();
    await db.execute(sql`
      UPDATE mail_workflow_steps SET
        status = ${status},
        finished_at = NOW(),
        result = ${patch.result !== undefined ? sql`${JSON.stringify(patch.result)}::jsonb` : sql`result`},
        error = ${patch.error !== undefined ? patch.error : sql`error`},
        external_ref = ${patch.externalRef !== undefined ? patch.externalRef : sql`external_ref`}
      WHERE run_id = ${runId} AND node_id = ${nodeId}`);
  },
  async listSteps(runId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_workflow_steps WHERE run_id = ${runId} ORDER BY claimed_at ASC`));
    return r.map(toStep);
  },
  async resetStep(runId, nodeId) {
    const { db, sql } = await ctx();
    // `status <> 'done'` is the guard that stops a retry repeating a step that finished.
    const r = rows(await db.execute(sql`
      UPDATE mail_workflow_steps SET status = 'failed', finished_at = NOW()
      WHERE run_id = ${runId} AND node_id = ${nodeId} AND status <> 'done'
      RETURNING run_id`));
    return r.length > 0;
  },

  // ---- audience ----
  async getContact(orgId, contactId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE org_id = ${orgId} AND id = ${contactId} LIMIT 1`));
    return r[0] ? toContact(r[0]) : null;
  },
  async findContactByEmail(orgId, email) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE org_id = ${orgId} AND email = ${normalizeEmail(email)} LIMIT 1`));
    return r[0] ? toContact(r[0]) : null;
  },
  async upsertContact(orgId, c) {
    const { db, sql } = await ctx();
    const email = normalizeEmail(c.email);
    // COALESCE on every optional column: an event that knows only the email must not blank out a
    // first name somebody typed in last week.
    const r = rows(await db.execute(sql`
      INSERT INTO mail_contacts (org_id, email, first_name, last_name, organization, phone, role_title, application_stage, application_number, custom, tags, unsubscribed)
      VALUES (${orgId}, ${email}, ${c.firstName ?? null}, ${c.lastName ?? null}, ${c.organization ?? null}, ${c.phone ?? null}, ${c.roleTitle ?? null},
              ${c.applicationStage ?? null}, ${c.applicationNumber ?? null}, ${JSON.stringify(c.custom || {})}::jsonb, ${JSON.stringify(c.tags || [])}::jsonb, ${!!c.unsubscribed})
      ON CONFLICT (org_id, email) DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, mail_contacts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, mail_contacts.last_name),
        organization = COALESCE(EXCLUDED.organization, mail_contacts.organization),
        phone = COALESCE(EXCLUDED.phone, mail_contacts.phone),
        role_title = COALESCE(EXCLUDED.role_title, mail_contacts.role_title),
        application_stage = COALESCE(EXCLUDED.application_stage, mail_contacts.application_stage),
        application_number = COALESCE(EXCLUDED.application_number, mail_contacts.application_number),
        custom = mail_contacts.custom || EXCLUDED.custom,
        updated_at = NOW()
      RETURNING *`));
    return toContact(r[0]);
  },
  async updateContactFields(orgId, contactId, fields) {
    const { db, sql } = await ctx();
    const known: Record<string, string> = {
      first_name: 'first_name', last_name: 'last_name', organization: 'organization', phone: 'phone',
      role_title: 'role_title', application_stage: 'application_stage', application_number: 'application_number',
    };
    const custom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields || {})) {
      const col = known[k];
      if (!col) { custom[k] = v; continue; }
      // One statement per known column, with the column name coming from the whitelist above and
      // never from the request. Interpolating a caller's key into SQL is the injection.
      await db.execute(sql`UPDATE mail_contacts SET ${sql.raw(col)} = ${v === null ? null : String(v)}, updated_at = NOW() WHERE org_id = ${orgId} AND id = ${contactId}`);
    }
    if (Object.keys(custom).length) {
      await db.execute(sql`UPDATE mail_contacts SET custom = custom || ${JSON.stringify(custom)}::jsonb, updated_at = NOW() WHERE org_id = ${orgId} AND id = ${contactId}`);
    }
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE org_id = ${orgId} AND id = ${contactId} LIMIT 1`));
    return r[0] ? toContact(r[0]) : null;
  },
  async addTag(orgId, contactId, tag) {
    const { db, sql } = await ctx();
    const t = normalizeTag(tag);
    if (!t) return false;
    // NOT ? ${t} makes it idempotent in the database: adding a tag twice changes zero rows, so the
    // "changed" answer is the truth and no duplicate tag.added event is emitted.
    const r = rows(await db.execute(sql`
      UPDATE mail_contacts SET tags = tags || ${JSON.stringify([t])}::jsonb, updated_at = NOW()
      WHERE org_id = ${orgId} AND id = ${contactId} AND NOT (tags ? ${t})
      RETURNING id`));
    return r.length > 0;
  },
  async removeTag(orgId, contactId, tag) {
    const { db, sql } = await ctx();
    const t = normalizeTag(tag);
    if (!t) return false;
    const r = rows(await db.execute(sql`
      UPDATE mail_contacts SET tags = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(tags) x WHERE x <> ${JSON.stringify(t)}::jsonb), updated_at = NOW()
      WHERE org_id = ${orgId} AND id = ${contactId} AND (tags ? ${t})
      RETURNING id`));
    return r.length > 0;
  },
  async addToList(orgId, contactId, listKey) {
    const { db, sql } = await ctx();
    const key = normalizeKey(listKey);
    if (!key) return false;
    const list = rows(await db.execute(sql`
      INSERT INTO mail_contact_lists (org_id, key, name) VALUES (${orgId}, ${key}, ${key})
      ON CONFLICT (org_id, key) DO UPDATE SET key = EXCLUDED.key RETURNING id`));
    const listId = list[0]?.id;
    if (!listId) return false;
    // The contact must belong to this organisation; a list id and a contact id are both strings from
    // outside, and joining them without that check crosses tenants.
    const owned = rows(await db.execute(sql`SELECT id FROM mail_contacts WHERE org_id = ${orgId} AND id = ${contactId} LIMIT 1`));
    if (!owned[0]) return false;
    const r = rows(await db.execute(sql`
      INSERT INTO mail_contact_list_members (list_id, contact_id) VALUES (${listId}, ${contactId})
      ON CONFLICT (list_id, contact_id) DO NOTHING RETURNING contact_id`));
    return r.length > 0;
  },
  async removeFromList(orgId, contactId, listKey) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      DELETE FROM mail_contact_list_members m USING mail_contact_lists l
      WHERE m.list_id = l.id AND l.org_id = ${orgId} AND l.key = ${normalizeKey(listKey)} AND m.contact_id = ${contactId}
      RETURNING m.contact_id`));
    return r.length > 0;
  },
  async getList(orgId, listKey) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT id, org_id, key, name FROM mail_contact_lists WHERE org_id = ${orgId} AND key = ${normalizeKey(listKey)} LIMIT 1`));
    return r[0] ? ({ id: r[0].id, orgId: r[0].org_id, key: r[0].key, name: r[0].name } as ListRecord) : null;
  },
  async listContacts(orgId, opts) {
    const { db, sql } = await ctx();
    const limit = Math.max(1, Math.min(5000, opts.limit || 500));
    if (opts.listKey && opts.tag) {
      const r = rows(await db.execute(sql`
        SELECT c.* FROM mail_contacts c
        JOIN mail_contact_list_members m ON m.contact_id = c.id
        JOIN mail_contact_lists l ON l.id = m.list_id AND l.org_id = ${orgId} AND l.key = ${normalizeKey(opts.listKey)}
        WHERE c.org_id = ${orgId} AND (c.tags ? ${normalizeTag(opts.tag)}) ORDER BY c.created_at ASC LIMIT ${limit}`));
      return r.map(toContact);
    }
    if (opts.listKey) {
      const r = rows(await db.execute(sql`
        SELECT c.* FROM mail_contacts c
        JOIN mail_contact_list_members m ON m.contact_id = c.id
        JOIN mail_contact_lists l ON l.id = m.list_id AND l.org_id = ${orgId} AND l.key = ${normalizeKey(opts.listKey)}
        WHERE c.org_id = ${orgId} ORDER BY c.created_at ASC LIMIT ${limit}`));
      return r.map(toContact);
    }
    if (opts.tag) {
      const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE org_id = ${orgId} AND (tags ? ${normalizeTag(opts.tag)}) ORDER BY created_at ASC LIMIT ${limit}`));
      return r.map(toContact);
    }
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT ${limit}`));
    return r.map(toContact);
  },
  async setUnsubscribed(orgId, contactId, on) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`UPDATE mail_contacts SET unsubscribed = ${on}, updated_at = NOW() WHERE org_id = ${orgId} AND id = ${contactId} AND unsubscribed <> ${on} RETURNING id`));
    return r.length > 0;
  },
};

/** The webhook secret, read on its own because it never belongs in a WorkflowRecord that a page
 *  might render. Nothing else in this module returns it. */
export async function webhookSecretFor(orgId: string, workflowId: string): Promise<string | null> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT webhook_secret FROM mail_workflows WHERE org_id = ${orgId} AND id = ${workflowId} LIMIT 1`));
  return r[0]?.webhook_secret || null;
}

export async function setWebhookCredentials(orgId: string, workflowId: string, token: string | null, secret: string | null): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE mail_workflows SET webhook_token = ${token}, webhook_secret = ${secret}, updated_at = NOW() WHERE org_id = ${orgId} AND id = ${workflowId}`);
}
