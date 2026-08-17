// src/lib/mailplatform/events.ts — the event envelope, its buffer, and the ClickHouse migration
// (Patch 8 §5, §6).
//
// ONE SHAPE, WRITTEN DOWN ONCE. §5 lists the fields every major event must carry. They are a type
// here and a validator below, so an event missing `tenant_id` fails at the point it is created
// rather than three months later when somebody tries to bill by tenant and finds a third of the rows
// unattributable. Backfilling a missing dimension into an append-only store is not possible; the
// information was never captured.
//
// SNAKE_CASE ON THE WIRE, camelCase IN TYPESCRIPT. The wire form is what lands in Postgres and later
// in ClickHouse, and renaming a column across a store that holds a year of history is a migration
// nobody wants. toRow() is the one place the two spellings meet.
//
// WHY THE BUFFER EXISTS — this is the whole of §6's "analytics consumers must not block
// transactional workloads", and the failure it prevents is specific: an event write on the send path
// is a synchronous INSERT holding a pooled connection, so an analytics table under load slows down
// SENDING MAIL. Events are buffered in memory and flushed as ONE multi-row insert; a flush failure
// drops metrics, never mail. `eventsDropped` counts what was lost so the loss is visible rather than
// silent — a dropped-event counter that nobody reads is still better than a number that quietly
// undercounts, because at least it can be alerted on.
//
// THE SERVERLESS CAVEAT, STATED PLAINLY. On Vercel the process can freeze the moment a response is
// returned, so a buffer flushed on a timer may never flush. flushOnResponse() is the honest
// mitigation: flush before responding, accepting the latency, and keep the buffer for the cases that
// genuinely have a lifetime (the worker loop, a long-lived server). A dedicated worker process — the
// second stage in docs/mail-server-plan.md — is what makes the buffer pay for itself.

import type { UUID, ISODateString } from './types';

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * Event type names are `<entity>.<past-tense-verb>`, hierarchical so a consumer can subscribe to a
 * prefix. Past tense because an event is a FACT that happened; `message.send` would be a command,
 * and a store that mixes the two cannot be replayed.
 */
export const EVENT_TYPES = [
  'message.queued', 'message.sent', 'message.delivered', 'message.deferred', 'message.bounced',
  'message.failed', 'message.suppressed', 'message.opened', 'message.clicked', 'message.complained',
  'message.received', 'message.parsed',
  'campaign.created', 'campaign.scheduled', 'campaign.started', 'campaign.completed', 'campaign.cancelled',
  'campaign.recipients_generated',
  'contact.created', 'contact.updated', 'contact.subscribed', 'contact.unsubscribed', 'contact.bounced',
  'workflow.started', 'workflow.node_executed', 'workflow.completed', 'workflow.failed',
  'domain.verified', 'domain.verification_failed',
  'queue.job_enqueued', 'queue.job_completed', 'queue.job_failed', 'queue.job_dead_lettered', 'queue.job_reclaimed',
  'mta.node_degraded', 'mta.node_recovered', 'mta.throttled',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Where an event was produced. Needed to tell a replay from a live write, and one node from another. */
export type EventSource = 'api' | 'worker' | 'inbound' | 'webhook' | 'scheduler' | 'admin' | 'mta' | 'loadgen' | 'system';

/** The §5 envelope, in TypeScript spelling. */
export interface MailEvent {
  eventId: UUID;
  eventType: EventType | string;
  timestamp: ISODateString;
  tenantId: UUID;
  messageId?: string | null;
  contactId?: UUID | null;
  campaignId?: UUID | null;
  workflowId?: UUID | null;
  source: EventSource;
  /** Producing node/worker. Fixed cardinality, unlike metadata. */
  sourceId?: string | null;
  metadata: Record<string, unknown>;
}

/** The wire/storage form. Column names here are the column names in both stores. */
export interface EventRow {
  event_id: string;
  event_type: string;
  occurred_at: string;
  tenant_id: string;
  message_id: string | null;
  contact_id: string | null;
  campaign_id: string | null;
  workflow_id: string | null;
  source: string;
  source_id: string | null;
  metadata: string;
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Not cryptographically strong, and it does not need to be — this is a correlation id, not a
  // capability. It IS required to be unique, which the timestamp prefix carries.
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return Date.now().toString(16).padStart(12, '0').slice(-8) + '-' + r() + '-4' + r().slice(1) + '-a' + r().slice(1) + '-' + r() + r() + r();
}

export interface MakeEventInput {
  eventType: EventType | string;
  tenantId: UUID;
  source: EventSource;
  messageId?: string | null;
  contactId?: UUID | null;
  campaignId?: UUID | null;
  workflowId?: UUID | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  timestamp?: ISODateString;
}

export function makeEvent(input: MakeEventInput): MailEvent {
  return {
    eventId: uuid(),
    eventType: input.eventType,
    timestamp: input.timestamp ?? new Date().toISOString(),
    tenantId: input.tenantId,
    messageId: input.messageId ?? null,
    contactId: input.contactId ?? null,
    campaignId: input.campaignId ?? null,
    workflowId: input.workflowId ?? null,
    source: input.source,
    sourceId: input.sourceId ?? null,
    metadata: input.metadata ?? {},
  };
}

export interface EventValidation { valid: boolean; errors: string[] }

/**
 * Validate an envelope.
 *
 * `message.*` events REQUIRE a message id, because an event about a message that cannot name the
 * message is unjoinable — it inflates counts and answers nothing. Same for campaign and workflow
 * events. This is the rule that keeps the store queryable a year in.
 */
export function validateEvent(e: Partial<MailEvent>): EventValidation {
  const errors: string[] = [];
  if (!e.eventId) errors.push('eventId is required');
  if (!e.eventType) errors.push('eventType is required');
  else if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(String(e.eventType))) errors.push('eventType must be <entity>.<verb> in lower snake case, got ' + String(e.eventType));
  if (!e.timestamp) errors.push('timestamp is required');
  else if (Number.isNaN(Date.parse(String(e.timestamp)))) errors.push('timestamp is not a parseable date: ' + String(e.timestamp));
  if (!e.tenantId) errors.push('tenantId is required — an event that cannot be attributed to a tenant cannot be billed, filtered or deleted on request');
  if (!e.source) errors.push('source is required');
  if (e.metadata !== undefined && (typeof e.metadata !== 'object' || e.metadata === null || Array.isArray(e.metadata))) errors.push('metadata must be an object');

  const type = String(e.eventType || '');
  if (type.startsWith('message.') && !e.messageId) errors.push(type + ' requires messageId');
  if (type.startsWith('campaign.') && !e.campaignId) errors.push(type + ' requires campaignId');
  if (type.startsWith('workflow.') && !e.workflowId) errors.push(type + ' requires workflowId');
  return { valid: errors.length === 0, errors };
}

/**
 * Metadata keys that must never be written to the event store.
 *
 * The event store is the LEAST protected copy of this data: it is the thing exported to ClickHouse,
 * queried by analysts, and retained longest. A message body in `metadata` would outlive every
 * deletion policy that covers the mailbox it came from.
 */
export const METADATA_DENY: readonly string[] = ['body', 'bodyHtml', 'bodyText', 'html', 'text', 'raw', 'password', 'secret', 'token', 'apiKey', 'privateKey', 'attachments'];

export function scrubMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta || {})) {
    if (METADATA_DENY.some((d) => d.toLowerCase() === k.toLowerCase())) continue;
    const v = meta[k];
    // Depth-1 only, on purpose: metadata is a flat bag by convention, and a recursive scrub over
    // arbitrary nesting is where a hot-path function becomes a performance problem of its own.
    out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…[truncated]' : v;
  }
  return out;
}

export function toRow(e: MailEvent): EventRow {
  return {
    event_id: e.eventId,
    event_type: String(e.eventType),
    occurred_at: e.timestamp,
    tenant_id: e.tenantId,
    message_id: e.messageId ?? null,
    contact_id: e.contactId ?? null,
    campaign_id: e.campaignId ?? null,
    workflow_id: e.workflowId ?? null,
    source: e.source,
    source_id: e.sourceId ?? null,
    metadata: JSON.stringify(scrubMetadata(e.metadata || {})),
  };
}

/** NDJSON — one row per line. The format ClickHouse ingests natively (JSONEachRow) and the one an S3 export uses. */
export function toNdjson(events: readonly MailEvent[]): string {
  return events.map((e) => JSON.stringify(toRow(e))).join('\n') + (events.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The Postgres event table for the analytics stream.
 *
 * NAMED `mp_event_stream`, NOT `mp_events`, AND THE RENAME IS THE WHOLE POINT. `mp_events` is
 * already taken: MP_DDL in schema.ts creates it as a PLAIN per-org audit log
 * (org_id / entity_type / payload), and adapters/event-bus-postgres.ts writes it on every send,
 * campaign and domain change. Both definitions were `CREATE TABLE IF NOT EXISTS`, so whichever ran
 * first silently won and the loser's queries failed on columns that had never been created — the
 * worst shape a schema conflict can take, because nothing errors at deploy time.
 *
 * They are two different things that collided on a name: that one is an audit log, this is a
 * high-volume analytics stream on its way to ClickHouse. Both are wanted; only the name was wrong.
 *
 * DECLARATIVE MONTHLY PARTITIONING, and it is not premature — §4 says not to add complexity without
 * measurement, and this is the one case where the measurement is arithmetic rather than a benchmark:
 * retention on an append-only table is either a partition DETACH (instant, no bloat) or a bulk
 * DELETE (hours of vacuum on a table that is also being written to). Converting a large unpartitioned
 * table later requires copying every row. The cost now is one extra DDL statement.
 *
 * `mp_` prefix per the convention asserted in types.ts — this repository already owns a table called
 * `events` and an unprefixed name would have collided on the first migration.
 *
 * NOT DEPLOYED ANYWHERE YET: postgresSink() below is the only thing that applies this DDL, and it
 * has no callers. eventStoreStats() therefore reports on the live audit log and probes for this
 * table's existence rather than assuming it.
 */
export const EVENT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS mp_event_stream (
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamptz NOT NULL,
    tenant_id uuid NOT NULL,
    message_id text,
    contact_id uuid,
    campaign_id uuid,
    workflow_id uuid,
    source text NOT NULL,
    source_id text,
    metadata jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (occurred_at, event_id)
  ) PARTITION BY RANGE (occurred_at)`,
  // A DEFAULT partition so an insert can never fail because next month has no partition yet. Rows
  // landing here are a signal that partition maintenance has stopped, not a failure — ensurePartition()
  // below creates the real ones, and the ops screen reports default-partition row count.
  `CREATE TABLE IF NOT EXISTS mp_event_stream_default PARTITION OF mp_event_stream DEFAULT`,
  `CREATE INDEX IF NOT EXISTS mp_event_stream_tenant_time_idx ON mp_event_stream (tenant_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_event_stream_type_time_idx ON mp_event_stream (event_type, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_event_stream_message_idx ON mp_event_stream (message_id) WHERE message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS mp_event_stream_campaign_idx ON mp_event_stream (campaign_id, occurred_at DESC) WHERE campaign_id IS NOT NULL`,
];

/** SQL creating the partition covering a given month. Idempotent; safe to run on every boot. */
export function partitionSql(year: number, month1to12: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const startY = year, startM = month1to12;
  const endY = month1to12 === 12 ? year + 1 : year;
  const endM = month1to12 === 12 ? 1 : month1to12 + 1;
  const name = 'mp_event_stream_' + startY + pad(startM);
  return `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF mp_event_stream FOR VALUES FROM ('${startY}-${pad(startM)}-01') TO ('${endY}-${pad(endM)}-01')`;
}

/**
 * The ClickHouse target table (§5, §6).
 *
 * Column names and order match EventRow exactly, so the migration is `INSERT INTO … SELECT` over an
 * NDJSON export rather than a remodelling exercise. That is the entire reason the Postgres shape was
 * chosen as it was.
 *
 * ORDER BY (tenant_id, event_type, occurred_at) because every analytics query starts by narrowing to
 * a tenant; putting occurred_at first would make the primary index useless for the filter that
 * actually reduces the scan. PARTITION BY month matches the Postgres side so retention policy is one
 * policy in two systems rather than two.
 */
export const CLICKHOUSE_DDL = `CREATE TABLE IF NOT EXISTS mail_events
(
    event_id     UUID,
    event_type   LowCardinality(String),
    occurred_at  DateTime64(3, 'UTC'),
    tenant_id    UUID,
    message_id   Nullable(String),
    contact_id   Nullable(UUID),
    campaign_id  Nullable(UUID),
    workflow_id  Nullable(UUID),
    source       LowCardinality(String),
    source_id    Nullable(String),
    metadata     String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, event_type, occurred_at)
TTL toDateTime(occurred_at) + INTERVAL 25 MONTH
SETTINGS index_granularity = 8192;`;

// ---------------------------------------------------------------------------
// Buffered ingestion
// ---------------------------------------------------------------------------

export interface EventSink {
  write(rows: readonly EventRow[]): Promise<void>;
}

export interface BufferStats { buffered: number; written: number; dropped: number; flushes: number; lastError: string | null }

/**
 * Batches events and flushes them as one insert.
 *
 * `maxBuffer` is a HARD CAP with a drop policy, not a queue that grows: an unbounded buffer in front
 * of a failing sink turns a metrics outage into an out-of-memory kill of the process that is sending
 * mail. Dropping oldest-first preserves the most recent events, which are the ones an operator is
 * looking at during the incident that caused the drop.
 */
export class EventBuffer {
  private rows: EventRow[] = [];
  private stats: BufferStats = { buffered: 0, written: 0, dropped: 0, flushes: 0, lastError: null };

  constructor(private readonly sink: EventSink, readonly batchSize = 200, readonly maxBuffer = 5000) {}

  /** Returns false when the event was rejected (invalid or dropped). Never throws onto the send path. */
  add(e: MailEvent): boolean {
    const v = validateEvent(e);
    if (!v.valid) { this.stats.dropped++; this.stats.lastError = 'invalid event: ' + v.errors.join('; '); return false; }
    if (this.rows.length >= this.maxBuffer) {
      this.rows.shift();
      this.stats.dropped++;
      this.stats.lastError = 'buffer full at ' + this.maxBuffer + '; oldest event dropped';
    }
    this.rows.push(toRow(e));
    this.stats.buffered = this.rows.length;
    return true;
  }

  get pending(): number { return this.rows.length; }
  shouldFlush(): boolean { return this.rows.length >= this.batchSize; }
  snapshot(): BufferStats { return { ...this.stats, buffered: this.rows.length }; }

  /**
   * Flush everything buffered.
   *
   * ON FAILURE THE ROWS GO BACK, up to the cap. A flush that discards on error loses events for a
   * transient pooler timeout, which is the single most common failure here and the one most worth
   * surviving.
   */
  async flush(): Promise<{ ok: boolean; written: number; error?: string }> {
    if (this.rows.length === 0) return { ok: true, written: 0 };
    const batch = this.rows;
    this.rows = [];
    try {
      await this.sink.write(batch);
      this.stats.written += batch.length;
      this.stats.flushes++;
      this.stats.lastError = null;
      return { ok: true, written: batch.length };
    } catch (e: unknown) {
      const err = e as { cause?: { message?: string }; message?: string };
      const message = String(err?.cause?.message || err?.message || 'event flush failed');
      this.stats.lastError = message;
      const room = Math.max(0, this.maxBuffer - this.rows.length);
      // `slice(-0)` IS `slice(0)`, WHICH IS THE WHOLE ARRAY. Negative-zero does not mean "take
      // nothing" — it means "start at index 0". With the buffer already full, room is 0 and the
      // naive `batch.slice(-room)` restored the ENTIRE failed batch, pushing the buffer past its
      // own cap and recording zero drops: the bound this class exists to enforce, silently absent
      // in exactly the situation it was written for (a failing sink under sustained load).
      const restored = room === 0 ? [] : batch.slice(-room);
      this.stats.dropped += batch.length - restored.length;
      this.rows = restored.concat(this.rows);
      return { ok: false, written: 0, error: message };
    }
  }
}

const reason = (e: unknown): string => {
  const err = e as { cause?: { message?: string }; message?: string };
  return String(err?.cause?.message || err?.message || 'unknown error');
};

/**
 * ISO-8601 with MILLISECONDS INTACT, whatever the driver handed back.
 *
 * THIS EXISTS BECAUSE `new Date(String(value)).toISOString()` SILENTLY TRUNCATES TO THE SECOND, and
 * that was a real bug here rather than a hypothetical one. postgres-js parses `timestamptz` (OID
 * 1184) into a JS `Date` by default — src/lib/db.ts registers no custom parser — so `String(value)`
 * takes `Date.prototype.toString()`, whose format is `Sun Aug 16 2026 15:30:00 GMT+0530` and carries
 * NO fractional seconds. Round-tripping that through `new Date()` returns `…T10:00:00.000Z` from an
 * input of `…T10:00:00.742Z`.
 *
 * Two things broke on that, and the second is the dangerous one:
 *
 *   1. Every exported event lost sub-second precision on its way into a ClickHouse column declared
 *      `DateTime64(3, 'UTC')` — the fidelity the column exists for, discarded in the copy.
 *   2. The keyset cursor is `(occurred_at, event_id)`. Truncated to the second, the cursor points
 *      BEFORE rows already emitted, so `(occurred_at, event_id) > cursor` stays true for every row
 *      in that second regardless of event_id. With more rows in one second than the page limit, the
 *      export re-emits the same page forever: duplicated rows in ClickHouse and a migration that
 *      never terminates.
 *
 * A `Date` is formatted directly; anything else is parsed. Never route a Date through String().
 */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * The Postgres sink: ONE multi-row INSERT per batch.
 *
 * One statement per batch rather than one per event is the difference between 200 pooled round trips
 * and one. On the transaction pooler, where each statement can mean a connection checkout, that is
 * the difference between event recording being free and event recording being the reason mail is slow.
 */
export function postgresSink(): EventSink {
  let ready = false;
  return {
    async write(rows: readonly EventRow[]): Promise<void> {
      if (!rows.length) return;
      const { db } = await import('@/lib/db');
      const { sql } = await import('drizzle-orm');
      if (!ready) {
        for (const ddl of EVENT_DDL) await db.execute(sql.raw(ddl));
        const now = new Date();
        await db.execute(sql.raw(partitionSql(now.getUTCFullYear(), now.getUTCMonth() + 1)));
        // Next month too, so a flush at 23:59 on the last day of the month does not land in DEFAULT.
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        await db.execute(sql.raw(partitionSql(next.getUTCFullYear(), next.getUTCMonth() + 1)));
        ready = true;
      }
      const values = rows.map((r) => sql`(${r.event_id}::uuid, ${r.event_type}, ${r.occurred_at}::timestamptz, ${r.tenant_id}::uuid, ${r.message_id}, ${r.contact_id}::uuid, ${r.campaign_id}::uuid, ${r.workflow_id}::uuid, ${r.source}, ${r.source_id}, ${r.metadata}::jsonb)`);
      await db.execute(sql`INSERT INTO mp_event_stream (event_id, event_type, occurred_at, tenant_id, message_id, contact_id, campaign_id, workflow_id, source, source_id, metadata) VALUES ${sql.join(values, sql`, `)}`);
    },
  };
}

/** In-memory sink for tests and for the load generator's dry-run mode. */
export function memorySink(): EventSink & { rows: EventRow[] } {
  const rows: EventRow[] = [];
  return { rows, async write(batch) { rows.push(...batch); } };
}

/**
 * Export a window of events as NDJSON, for the ClickHouse migration.
 *
 * KEYSET PAGINATION on (occurred_at, event_id), not OFFSET. `OFFSET 4000000` re-reads four million
 * rows to skip them, so an export of a large table gets quadratically slower as it proceeds — the
 * classic way a migration that worked in staging never finishes in production. The composite cursor
 * matches the table's primary key exactly, so each page is an index seek.
 */
export async function exportEventsNdjson(opts: { from: string; to: string; afterOccurredAt?: string; afterEventId?: string; limit?: number }): Promise<{ ok: boolean; ndjson: string; count: number; nextCursor: { occurredAt: string; eventId: string } | null; error?: string }> {
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const limit = Math.min(50_000, Math.max(1, opts.limit ?? 10_000));
    const cursor = opts.afterOccurredAt && opts.afterEventId
      ? sql`AND (occurred_at, event_id) > (${opts.afterOccurredAt}::timestamptz, ${opts.afterEventId}::uuid)`
      : sql``;
    const r = await db.execute(sql`
      SELECT event_id, event_type, occurred_at, tenant_id, message_id, contact_id, campaign_id, workflow_id, source, source_id, metadata
      FROM mp_event_stream
      WHERE occurred_at >= ${opts.from}::timestamptz AND occurred_at < ${opts.to}::timestamptz ${cursor}
      ORDER BY occurred_at ASC, event_id ASC
      LIMIT ${limit}`);
    const list = (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows || [])) as Record<string, unknown>[];
    const lines = list.map((row) => JSON.stringify({
      event_id: String(row.event_id),
      event_type: String(row.event_type),
      occurred_at: toIso(row.occurred_at),
      tenant_id: String(row.tenant_id),
      message_id: row.message_id ?? null,
      contact_id: row.contact_id ?? null,
      campaign_id: row.campaign_id ?? null,
      workflow_id: row.workflow_id ?? null,
      source: String(row.source),
      source_id: row.source_id ?? null,
      metadata: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? {}),
    }));
    const last = list[list.length - 1];
    return {
      ok: true,
      ndjson: lines.join('\n') + (lines.length ? '\n' : ''),
      count: lines.length,
      nextCursor: list.length === limit && last ? { occurredAt: toIso(last.occurred_at), eventId: String(last.event_id) } : null,
    };
  } catch (e) {
    return { ok: false, ndjson: '', count: 0, nextCursor: null, error: reason(e) };
  }
}

/** Event-store size and range, for the ops screen and for deciding when ClickHouse is due. */
export async function eventStoreStats(): Promise<{ ok: boolean; total: number | null; oldest: string | null; newest: string | null; last24h: number | null; defaultPartitionRows: number | null; error?: string }> {
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    // READS THE LIVE EVENT TABLE, which is MP_DDL's `mp_events` in schema.ts — the per-org audit log
    // that event-bus-postgres.ts actually writes. The partitioned analytics stream above is not
    // deployed anywhere yet, so reporting on it would report on nothing.
    const q = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::bigint FROM mp_events) AS total,
        (SELECT MIN(occurred_at) FROM mp_events) AS oldest,
        (SELECT MAX(occurred_at) FROM mp_events) AS newest,
        (SELECT COUNT(*)::bigint FROM mp_events WHERE occurred_at > now() - interval '24 hours') AS last24h`);
    const row = ((Array.isArray(q) ? q : ((q as { rows?: unknown[] })?.rows || [])) as Record<string, unknown>[])[0] || {};

    // The DEFAULT-partition count is a SEPARATE, GUARDED query, and it has to be separate. Postgres
    // resolves table names when it PARSES a statement, so naming a table that does not exist fails
    // the whole statement — a `to_regclass` guard in the same SELECT would not have saved it. That
    // is exactly how this function used to die: one subquery against a never-created partition took
    // the four useful numbers down with it, and the ops panel showed an error while mp_events had
    // rows the whole time. Absent table reports null (not deployed), never an error on the panel.
    let defaultPartitionRows: number | null = null;
    const probe = await db.execute(sql`SELECT to_regclass('public.mp_event_stream_default') IS NOT NULL AS present`);
    const present = ((Array.isArray(probe) ? probe : ((probe as { rows?: unknown[] })?.rows || [])) as Record<string, unknown>[])[0]?.present;
    if (present === true) {
      const d = await db.execute(sql`SELECT COUNT(*)::bigint AS default_rows FROM mp_event_stream_default`);
      const dr = ((Array.isArray(d) ? d : ((d as { rows?: unknown[] })?.rows || [])) as Record<string, unknown>[])[0]?.default_rows;
      defaultPartitionRows = dr === undefined || dr === null ? null : Number(dr);
    }

    return {
      ok: true,
      total: row.total === undefined || row.total === null ? null : Number(row.total),
      oldest: row.oldest ? toIso(row.oldest) : null,
      newest: row.newest ? toIso(row.newest) : null,
      last24h: row.last24h === undefined || row.last24h === null ? null : Number(row.last24h),
      defaultPartitionRows,
    };
  } catch (e) {
    return { ok: false, total: null, oldest: null, newest: null, last24h: null, defaultPartitionRows: null, error: reason(e) };
  }
}
