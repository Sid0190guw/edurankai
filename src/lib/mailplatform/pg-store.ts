// src/lib/mailplatform/pg-store.ts — AutomationStore against Postgres.
//
// THE TABLES THIS ENGINE OWNS, AND THE ONES IT ONLY VISITS.
//
// `mail_automations`, `mail_automation_runs`, `mail_contacts`, `mail_lists`, `mail_list_members`
// and `email_templates` are created by src/lib/mail-product/schema.ts. This file NEVER redefines
// them. `CREATE TABLE IF NOT EXISTS` is SILENT when the table already exists with a different
// shape, so a second definition here would look like it worked, create nothing, and leave every
// query in this file selecting columns that are not there — the exact failure mail-contacts.ts
// warns about at the top of its own file.
//
// What it does add is ADDITIVE ONLY:
//   - three tables nobody else owns (events, steps, graph versions)
//   - a handful of `ADD COLUMN IF NOT EXISTS` on the two automation tables, for the run state an
//     executor needs and a builder never did: retries, dead letters, the event that started the
//     run, and the graph version it must keep following.
// Nothing that already worked changes shape, and the canvas at /mail/automations keeps writing the
// same `graph` column it always did.
//
// The engine's guarantees are claims about atomicity, and three statements carry all of them:
//   claimDueRuns   UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING
//   claimStep      INSERT … ON CONFLICT (run_id, node_id) DO UPDATE … WHERE (still claimable)
//   createRun      INSERT … ON CONFLICT (automation_id, trigger_event_id) DO NOTHING
//
// House rules observed: postgres-js returns a PLAIN ARRAY (never `r.rows[0]`); the real reason is on
// `e.cause`; and a failed schema bootstrap is not cached as done.
import type {
  AutomationRecord, AutomationStatus, AutomationStore, ClaimOutcome, ContactRecord, EventRecord,
  ListRecord, ListRunsFilter, RunRecord, RunState, StepRecord, StepStatus,
} from './store';
import { normalizeEmail, normalizeKey, normalizeTag } from './store';
import type { AutomationGraph } from './graph';
import { coerceGraph } from './graph';
import type { IncomingEvent } from './triggers';

const rows = (r: any): any[] => (Array.isArray(r) ? r : r?.rows || []);
const reason = (e: any): string => String(e?.cause?.message || e?.message || e);

/** The three tables this engine owns. Mirrored by db/mail-automation-schema.sql. */
export const AUTOMATION_DDL: string[] = [
  // The durable event log. event_id is the PRIMARY KEY, which IS the inbound idempotency guarantee.
  `CREATE TABLE IF NOT EXISTS mail_automation_events (
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
  )`,
  `CREATE INDEX IF NOT EXISTS mail_automation_events_org_idx ON mail_automation_events(org_id, received_at DESC)`,

  // THE IDEMPOTENCY LEDGER. One row per (run, node); the primary key is what stops a second send.
  `CREATE TABLE IF NOT EXISTS mail_automation_steps (
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
  )`,

  // A run executes the shape it started on. One row per EDIT, not per run.
  `CREATE TABLE IF NOT EXISTS mail_automation_versions (
    automation_id uuid NOT NULL,
    org_id varchar(64) NOT NULL DEFAULT 'edurankai',
    version integer NOT NULL,
    graph jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (automation_id, version)
  )`,
];

/**
 * Columns the EXECUTOR needs on tables the builder already owns. Each is additive and defaulted, so
 * every existing row and every existing query is unaffected.
 */
export const AUTOMATION_ALTERS: string[] = [
  `ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS org_id varchar(64) NOT NULL DEFAULT 'edurankai'`,
  `ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
  `ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS webhook_token varchar(64)`,
  `ALTER TABLE mail_automations ADD COLUMN IF NOT EXISTS webhook_secret varchar(128)`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS org_id varchar(64) NOT NULL DEFAULT 'edurankai'`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS graph_version integer NOT NULL DEFAULT 1`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS error_kind varchar(16)`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS dead_letter boolean NOT NULL DEFAULT false`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamptz`,
  `ALTER TABLE mail_automation_runs ADD COLUMN IF NOT EXISTS trigger_event_id varchar(128)`,
];

export const AUTOMATION_INDEXES: string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_automations_token_idx ON mail_automations(webhook_token) WHERE webhook_token IS NOT NULL`,
  // ONE EVENT STARTS AT MOST ONE RUN PER AUTOMATION. The index is the guarantee; the check in
  // createRun() only makes the answer readable.
  `CREATE UNIQUE INDEX IF NOT EXISTS mail_automation_runs_event_idx ON mail_automation_runs(automation_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS mail_automation_runs_org_idx ON mail_automation_runs(org_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mail_automation_runs_dead_idx ON mail_automation_runs(org_id) WHERE dead_letter`,
];

let ready: Promise<void> | null = null;

/**
 * Create what this engine owns and add what it needs. Idempotent.
 *
 * A FAILURE IS NOT CACHED AS DONE — `ready` is cleared on the way out, so a pooler blip during a
 * cold start does not leave the process permanently convinced the schema exists and failing with
 * "relation does not exist" and no line anywhere saying why.
 */
export function ensureAutomationSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // The tables this engine EXTENDS must exist before it can alter them, and mail-product owns
      // their creation. Asking it first is what makes the ALTERs below safe on a fresh database.
      const { ensureMailProductSchema } = await import('@/lib/mail-product/schema');
      await ensureMailProductSchema();

      const { db } = await import('@/lib/db');
      const { sql } = await import('drizzle-orm');
      for (const stmt of AUTOMATION_DDL) await db.execute(sql.raw(stmt));
      for (const stmt of AUTOMATION_ALTERS) {
        // Each ALTER on its own: one column failing must not abandon the rest, and the reason is
        // written down rather than swallowed.
        try { await db.execute(sql.raw(stmt)); } catch (e: any) { console.error('[mailplatform] alter skipped:', reason(e)); }
      }
      for (const stmt of AUTOMATION_INDEXES) {
        try { await db.execute(sql.raw(stmt)); } catch (e: any) { console.error('[mailplatform] index skipped:', reason(e)); }
      }
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
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
/** `tags` is a Postgres text[], which postgres-js hands back as a JS array. A string is what a
 *  jsonb column would give, so both are accepted rather than assuming which one arrived. */
const asTags = (v: any): string[] => {
  if (Array.isArray(v)) return v.map((t) => String(t));
  if (typeof v === 'string') { const p = safeParse(v); return Array.isArray(p) ? p.map((t) => String(t)) : []; }
  return [];
};

function toAutomation(r: any): AutomationRecord {
  return {
    id: r.id, orgId: r.org_id || 'edurankai', name: r.name, description: r.description || '',
    status: (r.status || 'draft') as AutomationStatus, version: Number(r.version || 1),
    graph: coerceGraph(r.graph), webhookToken: r.webhook_token || null,
    createdByUserId: r.created_by || null,
    createdAt: asDate(r.created_at) as Date, updatedAt: asDate(r.updated_at) as Date,
  };
}
function toRun(r: any): RunRecord {
  return {
    runId: r.id, automationId: r.automation_id, graphVersion: Number(r.graph_version || 1),
    orgId: r.org_id || 'edurankai', contactId: r.contact_id || null, currentNode: r.node_id || null,
    state: (r.status || 'running') as RunState, waitUntil: asDate(r.wait_until), context: asObj(r.context),
    startedAt: asDate(r.started_at) as Date, updatedAt: asDate(r.updated_at) as Date, completedAt: asDate(r.completed_at),
    error: r.last_error || null, errorKind: (r.error_kind || null) as any, retryCount: Number(r.retry_count || 0),
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
    id: r.id, email: r.email,
    firstName: r.first_name || null, lastName: r.last_name || null, organization: r.organization || null,
    phone: r.phone || null, roleTitle: r.role_title || null, status: r.status || 'subscribed',
    fields: asObj(r.fields), tags: asTags(r.tags),
    createdAt: asDate(r.created_at) as Date, updatedAt: asDate(r.updated_at) as Date,
  };
}

export const pgStore: AutomationStore = {
  // ---- automations ----
  async getAutomation(orgId, id) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_automations WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`));
    return r[0] ? toAutomation(r[0]) : null;
  },
  async getAutomationByWebhookToken(token) {
    if (!token) return null;
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_automations WHERE webhook_token = ${token} LIMIT 1`));
    return r[0] ? toAutomation(r[0]) : null;
  },
  async listAutomations(orgId, opts = {}) {
    const { db, sql } = await ctx();
    const r = opts.status
      ? rows(await db.execute(sql`SELECT * FROM mail_automations WHERE org_id = ${orgId} AND status = ${opts.status} ORDER BY updated_at DESC LIMIT ${opts.limit || 200}`))
      : rows(await db.execute(sql`SELECT * FROM mail_automations WHERE org_id = ${orgId} ORDER BY updated_at DESC LIMIT ${opts.limit || 200}`));
    return r.map(toAutomation);
  },
  async activeAutomations(orgId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_automations WHERE org_id = ${orgId} AND status = 'active' ORDER BY updated_at DESC LIMIT 500`));
    return r.map(toAutomation);
  },
  async setVersion(orgId, id, version) {
    const { db, sql } = await ctx();
    await db.execute(sql`UPDATE mail_automations SET version = ${version}, updated_at = now() WHERE org_id = ${orgId} AND id = ${id}`);
  },
  async saveGraphVersion(orgId, automationId, version, graph) {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mail_automation_versions (automation_id, org_id, version, graph)
      VALUES (${automationId}, ${orgId}, ${version}, ${JSON.stringify(graph || {})}::jsonb)
      ON CONFLICT (automation_id, version) DO NOTHING`);
  },
  async getGraphVersion(orgId, automationId, version) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT graph FROM mail_automation_versions WHERE org_id = ${orgId} AND automation_id = ${automationId} AND version = ${version} LIMIT 1`));
    return r[0] ? (coerceGraph(r[0].graph) as AutomationGraph) : null;
  },

  // ---- events ----
  async recordEvent(e: IncomingEvent) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      INSERT INTO mail_automation_events (event_id, org_id, type, contact_id, payload, source, occurred_at)
      VALUES (${e.eventId}, ${e.orgId}, ${e.type}, ${e.contactId}, ${JSON.stringify(e.payload || {})}::jsonb, ${e.source}, ${e.occurredAt})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING *`));
    if (r[0]) return { stored: true, record: toEvent(r[0]) };
    // DO NOTHING returns no row, which IS the duplicate. Read the original back so a caller can say
    // when it was first seen rather than only that it was.
    const existing = rows(await db.execute(sql`SELECT * FROM mail_automation_events WHERE event_id = ${e.eventId} LIMIT 1`));
    return {
      stored: false,
      record: toEvent(existing[0] || { event_id: e.eventId, org_id: e.orgId, type: e.type, payload: {}, source: e.source, occurred_at: e.occurredAt, received_at: e.occurredAt }),
    };
  },
  async markEventProcessed(eventId, startedRuns, error = null) {
    const { db, sql } = await ctx();
    await db.execute(sql`UPDATE mail_automation_events SET processed_at = now(), started_runs = ${startedRuns}, error = ${error} WHERE event_id = ${eventId}`);
  },
  async listEvents(orgId, opts = {}) {
    const { db, sql } = await ctx();
    const r = opts.type
      ? rows(await db.execute(sql`SELECT * FROM mail_automation_events WHERE org_id = ${orgId} AND type = ${opts.type} ORDER BY received_at DESC LIMIT ${opts.limit || 100}`))
      : rows(await db.execute(sql`SELECT * FROM mail_automation_events WHERE org_id = ${orgId} ORDER BY received_at DESC LIMIT ${opts.limit || 100}`));
    return r.map(toEvent);
  },

  // ---- runs ----
  async createRun(run) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      INSERT INTO mail_automation_runs (id, automation_id, graph_version, org_id, contact_id, node_id, status, wait_until, context, started_at, updated_at, retry_count, dead_letter, trigger_event_id)
      VALUES (${run.runId}, ${run.automationId}, ${run.graphVersion}, ${run.orgId}, ${run.contactId}, ${run.currentNode}, ${run.state}, ${run.waitUntil},
              ${JSON.stringify(run.context || {})}::jsonb, ${run.startedAt}, ${run.updatedAt}, ${run.retryCount}, ${run.deadLetter}, ${run.triggerEventId})
      ON CONFLICT (automation_id, trigger_event_id) DO NOTHING
      RETURNING *`));
    if (r[0]) return { created: true, run: toRun(r[0]) };
    const existing = rows(await db.execute(sql`SELECT * FROM mail_automation_runs WHERE automation_id = ${run.automationId} AND trigger_event_id = ${run.triggerEventId} LIMIT 1`));
    return { created: false, run: existing[0] ? toRun(existing[0]) : run };
  },
  async getRun(orgId, runId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_automation_runs WHERE org_id = ${orgId} AND id = ${runId} LIMIT 1`));
    return r[0] ? toRun(r[0]) : null;
  },
  async updateRun(runId, patch) {
    const { db, sql } = await ctx();
    // Written out rather than assembled from a loop: every column here is one an operator reads on a
    // failure screen, and a generic setter is how a typo silently writes to nothing.
    const r = rows(await db.execute(sql`
      UPDATE mail_automation_runs SET
        node_id       = ${patch.currentNode !== undefined ? patch.currentNode : sql`node_id`},
        status        = ${patch.state !== undefined ? patch.state : sql`status`},
        wait_until    = ${patch.waitUntil !== undefined ? patch.waitUntil : sql`wait_until`},
        context       = ${patch.context !== undefined ? sql`${JSON.stringify(patch.context)}::jsonb` : sql`context`},
        completed_at  = ${patch.completedAt !== undefined ? patch.completedAt : sql`completed_at`},
        last_error    = ${patch.error !== undefined ? patch.error : sql`last_error`},
        error_kind    = ${patch.errorKind !== undefined ? patch.errorKind : sql`error_kind`},
        retry_count   = ${patch.retryCount !== undefined ? patch.retryCount : sql`retry_count`},
        dead_letter   = ${patch.deadLetter !== undefined ? patch.deadLetter : sql`dead_letter`},
        updated_at    = now()
      WHERE id = ${runId}
      RETURNING *`));
    return r[0] ? toRun(r[0]) : null;
  },
  async listRuns(orgId, f: ListRunsFilter = {}) {
    const { db, sql } = await ctx();
    const conds = [sql`org_id = ${orgId}`];
    if (f.automationId) conds.push(sql`automation_id = ${f.automationId}`);
    if (f.contactId) conds.push(sql`contact_id = ${f.contactId}`);
    if (f.state) conds.push(sql`status = ${f.state}`);
    if (f.deadLetterOnly) conds.push(sql`dead_letter = true`);
    let where = conds[0];
    for (let i = 1; i < conds.length; i++) where = sql`${where} AND ${conds[i]}`;
    const r = rows(await db.execute(sql`SELECT * FROM mail_automation_runs WHERE ${where} ORDER BY updated_at DESC LIMIT ${f.limit || 100}`));
    return r.map(toRun);
  },
  async claimDueRuns(now, limit, staleMs) {
    const { db, sql } = await ctx();
    const stale = new Date(now.getTime() - staleMs);
    // ONE STATEMENT. SKIP LOCKED is what lets two overlapping ticks take DIFFERENT runs instead of
    // the same one; a SELECT-then-UPDATE here would let both advance the same run and execute the
    // same node twice.
    const r = rows(await db.execute(sql`
      UPDATE mail_automation_runs SET status = 'running', wait_until = NULL, updated_at = now()
      WHERE id IN (
        SELECT id FROM mail_automation_runs
        WHERE (status = 'waiting' AND wait_until IS NOT NULL AND wait_until <= ${now})
           OR (status = 'running' AND updated_at <= ${stale})
        ORDER BY COALESCE(wait_until, updated_at) ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`));
    return r.map(toRun);
  },
  async countRuns(orgId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT status, COUNT(*)::int AS n FROM mail_automation_runs WHERE org_id = ${orgId} GROUP BY status`));
    const c: Record<RunState, number> = { running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0, paused: 0 };
    for (const row of r) if (row.status in c) (c as any)[row.status] = Number(row.n || 0);
    return c;
  },

  // ---- steps ----
  async claimStep(runId, nodeId, opts): Promise<ClaimOutcome> {
    const { db, sql } = await ctx();
    const stale = new Date(opts.now.getTime() - opts.staleMs);
    // The WHERE on the DO UPDATE is what makes this a CLAIM rather than a write: it only takes the
    // row back if the step is retryable ('failed'), or abandoned AND safe to repeat.
    const claimed = rows(await db.execute(sql`
      INSERT INTO mail_automation_steps (run_id, node_id, status, attempt, claimed_at)
      VALUES (${runId}, ${nodeId}, 'running', 1, ${opts.now})
      ON CONFLICT (run_id, node_id) DO UPDATE
        SET attempt = mail_automation_steps.attempt + 1, status = 'running', claimed_at = ${opts.now}, finished_at = NULL, error = NULL
        WHERE mail_automation_steps.status = 'failed'
           OR (${opts.reclaimStale} AND mail_automation_steps.status = 'running' AND mail_automation_steps.claimed_at <= ${stale})
      RETURNING *`));
    if (claimed[0]) return { outcome: 'claimed', step: toStep(claimed[0]) };

    const existing = rows(await db.execute(sql`SELECT * FROM mail_automation_steps WHERE run_id = ${runId} AND node_id = ${nodeId} LIMIT 1`));
    if (!existing[0]) {
      return { outcome: 'in_flight', step: { runId, nodeId, attempt: 0, status: 'running', claimedAt: opts.now, finishedAt: null, result: null, error: 'the step row could not be read back', externalRef: null } };
    }
    const step = toStep(existing[0]);
    if (step.status === 'done') return { outcome: 'already_done', step };
    if (step.status === 'needs_review') return { outcome: 'needs_review', step };
    if (step.status === 'running' && step.claimedAt.getTime() <= stale.getTime() && !opts.reclaimStale) {
      // Abandoned, and repeating it is visible outside this platform. Park it for a person.
      const marked = rows(await db.execute(sql`
        UPDATE mail_automation_steps
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
      UPDATE mail_automation_steps SET
        status = ${status},
        finished_at = now(),
        result = ${patch.result !== undefined ? sql`${JSON.stringify(patch.result)}::jsonb` : sql`result`},
        error = ${patch.error !== undefined ? patch.error : sql`error`},
        external_ref = ${patch.externalRef !== undefined ? patch.externalRef : sql`external_ref`}
      WHERE run_id = ${runId} AND node_id = ${nodeId}`);
  },
  async listSteps(runId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_automation_steps WHERE run_id = ${runId} ORDER BY claimed_at ASC`));
    return r.map(toStep);
  },
  async resetStep(runId, nodeId) {
    const { db, sql } = await ctx();
    // `status <> 'done'` is the guard that stops a retry repeating a step that finished.
    const r = rows(await db.execute(sql`
      UPDATE mail_automation_steps SET status = 'failed', finished_at = now()
      WHERE run_id = ${runId} AND node_id = ${nodeId} AND status <> 'done'
      RETURNING run_id`));
    return r.length > 0;
  },

  // ---- audience: mail-product's tables, read and written, never created here ----
  async getContact(contactId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE id = ${contactId} LIMIT 1`));
    return r[0] ? toContact(r[0]) : null;
  },
  async findContactByEmail(email) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE lower(email) = ${normalizeEmail(email)} LIMIT 1`));
    return r[0] ? toContact(r[0]) : null;
  },
  async upsertContact(c) {
    const { db, sql } = await ctx();
    const email = normalizeEmail(c.email);
    // COALESCE on every optional column: an event that knows only the address must not blank out a
    // first name somebody typed in last week. The unique index is on lower(email), so the conflict
    // target is that expression, not the column.
    const r = rows(await db.execute(sql`
      INSERT INTO mail_contacts (email, first_name, last_name, organization, phone, role_title, fields, source)
      VALUES (${email}, ${c.firstName ?? null}, ${c.lastName ?? null}, ${c.organization ?? null}, ${c.phone ?? null}, ${c.roleTitle ?? null},
              ${JSON.stringify(c.fields || {})}::jsonb, 'automation')
      ON CONFLICT (lower(email)) DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, mail_contacts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, mail_contacts.last_name),
        organization = COALESCE(EXCLUDED.organization, mail_contacts.organization),
        phone = COALESCE(EXCLUDED.phone, mail_contacts.phone),
        role_title = COALESCE(EXCLUDED.role_title, mail_contacts.role_title),
        fields = mail_contacts.fields || EXCLUDED.fields,
        updated_at = now()
      RETURNING *`));
    return toContact(r[0]);
  },
  async updateContactFields(contactId, fields) {
    const { db, sql } = await ctx();
    const known: Record<string, string> = {
      first_name: 'first_name', last_name: 'last_name', organization: 'organization',
      phone: 'phone', role_title: 'role_title',
    };
    const custom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields || {})) {
      const col = known[k];
      if (!col) { custom[k] = v; continue; }
      // The column name comes from the whitelist above and never from the request. Interpolating a
      // caller's key into SQL is the injection.
      await db.execute(sql`UPDATE mail_contacts SET ${sql.raw(col)} = ${v === null ? null : String(v)}, updated_at = now() WHERE id = ${contactId}`);
    }
    if (Object.keys(custom).length) {
      await db.execute(sql`UPDATE mail_contacts SET fields = fields || ${JSON.stringify(custom)}::jsonb, updated_at = now() WHERE id = ${contactId}`);
    }
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE id = ${contactId} LIMIT 1`));
    return r[0] ? toContact(r[0]) : null;
  },
  async addTag(contactId, tag) {
    const { db, sql } = await ctx();
    const t = normalizeTag(tag);
    if (!t) return false;
    // `NOT (tags @> ARRAY[t])` makes it idempotent IN THE DATABASE: adding a tag twice changes zero
    // rows, so the "changed" answer is the truth and no duplicate tag.added event is emitted.
    const r = rows(await db.execute(sql`
      UPDATE mail_contacts SET tags = array_append(tags, ${t}), updated_at = now()
      WHERE id = ${contactId} AND NOT (tags @> ARRAY[${t}]::text[])
      RETURNING id`));
    return r.length > 0;
  },
  async removeTag(contactId, tag) {
    const { db, sql } = await ctx();
    const t = normalizeTag(tag);
    if (!t) return false;
    const r = rows(await db.execute(sql`
      UPDATE mail_contacts SET tags = array_remove(tags, ${t}), updated_at = now()
      WHERE id = ${contactId} AND tags @> ARRAY[${t}]::text[]
      RETURNING id`));
    return r.length > 0;
  },
  async addToList(contactId, listKey) {
    const { db, sql } = await ctx();
    const key = normalizeKey(listKey);
    if (!key) return false;
    const list = rows(await db.execute(sql`SELECT id FROM mail_lists WHERE lower(slug) = ${key} LIMIT 1`));
    if (!list[0]) {
      // A list an operator has not created is NOT invented here. mail_lists is the audience module's
      // table, its rows carry a name and an owner, and a list conjured by an automation would appear
      // on the lists screen with a slug for a name and nobody able to say where it came from.
      return false;
    }
    const r = rows(await db.execute(sql`
      INSERT INTO mail_list_members (list_id, contact_id) VALUES (${list[0].id}, ${contactId})
      ON CONFLICT (list_id, contact_id) DO NOTHING RETURNING contact_id`));
    return r.length > 0;
  },
  async removeFromList(contactId, listKey) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      DELETE FROM mail_list_members m USING mail_lists l
      WHERE m.list_id = l.id AND lower(l.slug) = ${normalizeKey(listKey)} AND m.contact_id = ${contactId}
      RETURNING m.contact_id`));
    return r.length > 0;
  },
  async getList(listKey) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT id, slug, name FROM mail_lists WHERE lower(slug) = ${normalizeKey(listKey)} LIMIT 1`));
    return r[0] ? ({ id: r[0].id, key: r[0].slug, name: r[0].name } as ListRecord) : null;
  },
  async listContacts(opts) {
    const { db, sql } = await ctx();
    const limit = Math.max(1, Math.min(5000, opts.limit || 500));
    const tag = opts.tag ? normalizeTag(opts.tag) : '';
    if (opts.listKey && tag) {
      const r = rows(await db.execute(sql`
        SELECT c.* FROM mail_contacts c
        JOIN mail_list_members m ON m.contact_id = c.id
        JOIN mail_lists l ON l.id = m.list_id AND lower(l.slug) = ${normalizeKey(opts.listKey)}
        WHERE c.tags @> ARRAY[${tag}]::text[] ORDER BY c.created_at ASC LIMIT ${limit}`));
      return r.map(toContact);
    }
    if (opts.listKey) {
      const r = rows(await db.execute(sql`
        SELECT c.* FROM mail_contacts c
        JOIN mail_list_members m ON m.contact_id = c.id
        JOIN mail_lists l ON l.id = m.list_id AND lower(l.slug) = ${normalizeKey(opts.listKey)}
        ORDER BY c.created_at ASC LIMIT ${limit}`));
      return r.map(toContact);
    }
    if (tag) {
      const r = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE tags @> ARRAY[${tag}]::text[] ORDER BY created_at ASC LIMIT ${limit}`));
      return r.map(toContact);
    }
    const r = rows(await db.execute(sql`SELECT * FROM mail_contacts ORDER BY created_at ASC LIMIT ${limit}`));
    return r.map(toContact);
  },
  async isSuppressed(email) {
    // ONE SUPPRESSION READER FOR THE WHOLE PLATFORM. src/lib/mailsec/sending.ts already owns this —
    // /api/mail/send and /api/mail/scheduled-send both ask it — and a second query here would be a
    // second answer to "has this person asked not to be mailed", diverging the first time either
    // side learns a new reason.
    await ctx();
    try {
      const { suppressionReasons } = await import('@/lib/mailsec/sending');
      const found = await suppressionReasons([normalizeEmail(email)]);
      return found.size > 0;
    } catch (e: any) {
      // FAILS CLOSED. If the suppression list cannot be read we do not know whether this person asked
      // not to be mailed, and "we could not check" must never become "so we sent it".
      console.error('[mailplatform] suppression check failed, refusing to send:', reason(e));
      return true;
    }
  },
  async setStatus(contactId, status) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`UPDATE mail_contacts SET status = ${status}, updated_at = now() WHERE id = ${contactId} AND status <> ${status} RETURNING id`));
    return r.length > 0;
  },
  async getTemplate(templateId) {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT id, template_key, subject, body_html, body_text, is_active FROM email_templates WHERE id = ${templateId} LIMIT 1`));
    if (!r[0]) return null;
    if (r[0].is_active === false) return null;   // a switched-off template is not a template
    return { id: r[0].id, name: r[0].template_key || '', subject: r[0].subject || '', html: r[0].body_html || '', text: r[0].body_text || '' };
  },
};

/** The webhook secret, read on its own because it never belongs in an AutomationRecord that a page
 *  might render. Nothing else in this module returns it. */
export async function webhookSecretFor(orgId: string, automationId: string): Promise<string | null> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT webhook_secret FROM mail_automations WHERE org_id = ${orgId} AND id = ${automationId} LIMIT 1`));
  return r[0]?.webhook_secret || null;
}

export async function setWebhookCredentials(orgId: string, automationId: string, token: string | null, secret: string | null): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE mail_automations SET webhook_token = ${token}, webhook_secret = ${secret}, updated_at = now() WHERE org_id = ${orgId} AND id = ${automationId}`);
}
