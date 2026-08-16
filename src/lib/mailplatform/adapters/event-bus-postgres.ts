// src/lib/mailplatform/adapters/event-bus-postgres.ts — EventBus + AnalyticsProvider over mp_events.
//
// ONE STREAM, MANY READERS. Everything that happens is appended to mp_events exactly once, and both
// webhook fan-out and analytics READ from it. The alternative — calling the webhook dispatcher and
// the metrics counter at each site where something happens — is how a new consumer becomes a change
// to forty call sites, and how one missed call becomes a fact that no report will ever show.
//
// The table shape (append-only, wide jsonb payload, time-ordered, no updates) is exactly what a
// column store ingests, so the ClickHouse move named in the brief is a copy pipeline rather than a
// remodel. Nothing here uses a Postgres-only construct that would block that.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import type {
  AnalyticsProvider,
  EventBus,
  EventQuery,
  MetricQuery,
  MetricSeries,
  OperationResult,
  ProviderInfo,
} from '../interfaces';
import type { Page, PlatformEvent } from '../types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** Canonical event names. Every publisher uses one of these; a test asserts the list is used. */
export const EVENT_TYPES = {
  messageQueued: 'message.queued',
  messageSent: 'message.sent',
  messageFailed: 'message.failed',
  messageReceived: 'message.received',
  messageRead: 'message.read',
  deliveryDelivered: 'delivery.delivered',
  deliveryDeferred: 'delivery.deferred',
  deliveryBounced: 'delivery.bounced',
  deliveryComplained: 'delivery.complained',
  deliverySuppressed: 'delivery.suppressed',
  contactCreated: 'contact.created',
  contactUpdated: 'contact.updated',
  contactUnsubscribed: 'contact.unsubscribed',
  campaignCreated: 'campaign.created',
  campaignStarted: 'campaign.started',
  campaignFinished: 'campaign.finished',
  domainAdded: 'domain.added',
  domainVerified: 'domain.verified',
  domainVerificationFailed: 'domain.verification_failed',
  templatePublished: 'template.published',
  workflowStarted: 'workflow.started',
  workflowCompleted: 'workflow.completed',
} as const;

export type EventTypeName = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

function toEvent(row: any): PlatformEvent {
  return {
    id: String(row.id),
    orgId: row.org_id,
    eventType: row.event_type,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    actorType: row.actor_type ?? null,
    actorId: row.actor_id ?? null,
    payload: row.payload ?? {},
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  };
}

/** Cursor is the bigserial id. Opaque to callers, stable under concurrent inserts, no offset scan. */
function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  const n = Number(cursor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function postgresEventBus(): EventBus {
  return {
    info(): ProviderInfo {
      return {
        kind: 'postgres-events',
        enabled: !!process.env.DATABASE_URL,
        detail: 'Append-only mp_events. ClickHouse-shaped: one row per fact, jsonb payload, time-ordered.',
      };
    },

    async publish(event): Promise<OperationResult<{ id: string }>> {
      try {
        const r = rows(await db.execute(sql`
          INSERT INTO mp_events (org_id, event_type, entity_type, entity_id, actor_type, actor_id, payload, occurred_at)
          VALUES (${event.orgId}, ${event.eventType}, ${event.entityType || null}, ${event.entityId || null},
                  ${event.actorType || null}, ${event.actorId || null},
                  ${JSON.stringify(event.payload || {})}::jsonb,
                  ${event.occurredAt ? new Date(event.occurredAt) : new Date()})
          RETURNING id`));
        return { ok: true, data: { id: String(r[0]?.id) } };
      } catch (e: any) {
        // NOT swallowed. A lost event is a webhook that never fires and a metric that is quietly
        // short — both of which look like "nothing happened" rather than like a failure.
        const error = causeOf(e);
        console.error('[mailplatform/events] publish failed:', event.eventType, '-', error);
        return { ok: false, error, code: 'publish_failed' };
      }
    },

    async publishMany(events): Promise<OperationResult<{ count: number }>> {
      if (!events || events.length === 0) return { ok: true, data: { count: 0 } };
      try {
        // One statement, not N. A campaign send publishes an event per recipient; a per-row INSERT
        // there is a round trip per recipient and it shows up as the slowest part of the send.
        const values = events.map(
          (e) => sql`(${e.orgId}, ${e.eventType}, ${e.entityType || null}, ${e.entityId || null},
                      ${e.actorType || null}, ${e.actorId || null}, ${JSON.stringify(e.payload || {})}::jsonb,
                      ${e.occurredAt ? new Date(e.occurredAt) : new Date()})`,
        );
        await db.execute(sql`
          INSERT INTO mp_events (org_id, event_type, entity_type, entity_id, actor_type, actor_id, payload, occurred_at)
          VALUES ${sql.join(values, sql`, `)}`);
        return { ok: true, data: { count: events.length } };
      } catch (e: any) {
        const error = causeOf(e);
        console.error('[mailplatform/events] publishMany failed for', events.length, 'events -', error);
        return { ok: false, error, code: 'publish_failed' };
      }
    },

    async query(q: EventQuery): Promise<Page<PlatformEvent>> {
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
      const cursor = decodeCursor(q.cursor);
      try {
        const conditions = [sql`org_id = ${q.orgId}`];
        if (q.eventTypes?.length) conditions.push(sql`event_type = ANY(${q.eventTypes})`);
        if (q.entityType) conditions.push(sql`entity_type = ${q.entityType}`);
        if (q.entityId) conditions.push(sql`entity_id = ${q.entityId}`);
        if (q.since) conditions.push(sql`occurred_at >= ${new Date(q.since)}`);
        if (q.until) conditions.push(sql`occurred_at <= ${new Date(q.until)}`);
        if (cursor) conditions.push(sql`id < ${cursor}`);

        // limit + 1: one extra row answers "is there more" without a second COUNT over the table.
        const r = rows(await db.execute(sql`
          SELECT id, org_id, event_type, entity_type, entity_id, actor_type, actor_id, payload, occurred_at
          FROM mp_events
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY id DESC
          LIMIT ${limit + 1}`));

        const hasMore = r.length > limit;
        const items = r.slice(0, limit).map(toEvent);
        return { items, hasMore, nextCursor: hasMore ? String(r[limit - 1].id) : null };
      } catch (e: any) {
        console.error('[mailplatform/events] query failed -', causeOf(e));
        return { items: [], hasMore: false, nextCursor: null };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Analytics over the same stream
// ---------------------------------------------------------------------------

/** Metrics this provider can answer. Anything else is refused by name rather than returning zero. */
export const SUPPORTED_METRICS = [
  'events',
  'messages_sent',
  'messages_delivered',
  'messages_bounced',
  'messages_opened',
  'messages_clicked',
  'contacts_created',
] as const;

const METRIC_EVENT_TYPES: Record<string, string[]> = {
  messages_sent: [EVENT_TYPES.messageSent],
  messages_delivered: [EVENT_TYPES.deliveryDelivered],
  messages_bounced: [EVENT_TYPES.deliveryBounced],
  messages_opened: ['delivery.opened'],
  messages_clicked: ['delivery.clicked'],
  contacts_created: [EVENT_TYPES.contactCreated],
};

export function postgresAnalytics(): AnalyticsProvider {
  return {
    info(): ProviderInfo {
      return {
        kind: 'postgres-analytics',
        enabled: !!process.env.DATABASE_URL,
        detail: 'Aggregates read from mp_events. A ClickHouse adapter reads the identical event shape.',
      };
    },

    async query(q: MetricQuery): Promise<OperationResult<MetricSeries>> {
      const metric = String(q.metric || '').trim();
      if (!(SUPPORTED_METRICS as readonly string[]).includes(metric)) {
        // A zero series for a metric nobody implemented is indistinguishable from a real zero, and
        // a dashboard will render it as a flat line rather than as the mistake it is.
        return {
          ok: false,
          error: `Unknown metric "${metric}". Supported: ${SUPPORTED_METRICS.join(', ')}.`,
          code: 'unknown_metric',
        };
      }
      try {
        const conditions = [sql`org_id = ${q.orgId}`];
        const types = METRIC_EVENT_TYPES[metric];
        if (types) conditions.push(sql`event_type = ANY(${types})`);
        if (q.since) conditions.push(sql`occurred_at >= ${new Date(q.since)}`);
        if (q.until) conditions.push(sql`occurred_at <= ${new Date(q.until)}`);

        const groupBy = q.groupBy || 'day';
        const keyExpr =
          groupBy === 'hour'
            ? sql`to_char(date_trunc('hour', occurred_at), 'YYYY-MM-DD"T"HH24:00')`
            : groupBy === 'event_type'
              ? sql`event_type`
              : groupBy === 'campaign'
                ? sql`coalesce(payload->>'campaignId', '(none)')`
                : groupBy === 'domain'
                  ? sql`coalesce(payload->>'recipientDomain', '(unknown)')`
                  : sql`to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD')`;

        const r = rows(await db.execute(sql`
          SELECT ${keyExpr} AS key, COUNT(*)::int AS value
          FROM mp_events
          WHERE ${sql.join(conditions, sql` AND `)}
          GROUP BY 1
          ORDER BY 1 ASC
          LIMIT 1000`));

        const points = r.map((row) => ({ key: String(row.key), value: Number(row.value) || 0 }));
        return {
          ok: true,
          data: { metric, points, total: points.reduce((sum, p) => sum + p.value, 0) },
        };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'query_failed' };
      }
    },
  };
}

/** In-memory bus for tests. Keeps published events so a suite can assert on them. */
export function memoryEventBus(store: Omit<PlatformEvent, 'id'>[] = []): EventBus & { published: Omit<PlatformEvent, 'id'>[] } {
  let n = 0;
  return {
    published: store,
    info: () => ({ kind: 'memory-events', enabled: true, detail: 'In-memory test bus.' }),
    async publish(event) {
      store.push(event);
      return { ok: true, data: { id: String(++n) } };
    },
    async publishMany(events) {
      store.push(...events);
      n += events.length;
      return { ok: true, data: { count: events.length } };
    },
    async query() {
      return { items: [], hasMore: false, nextCursor: null };
    },
  };
}
