// src/lib/mailapi/messages.ts — the message record, its event log, and the status it derives.
//
// STATUS IS DERIVED FROM EVENTS, NEVER SET BY HAND. Every transition goes through nextStatus(), a
// pure function with a rank order, so a late 'sent' callback arriving after a 'bounced' cannot walk
// the message backwards and report success for mail that was rejected. This project has a standing
// rule that reported success and observable result are not the same thing; a status column that any
// caller can overwrite is exactly how those two come apart.
//
// THE EVENT LOG IS THE RECORD, AND IT IS APPEND-ONLY. Statuses answer "where is it now"; the log
// answers "what happened, in order, and when" — which is the question asked six months later when a
// candidate says they never received the interview invitation.
//
// CORRELATION IS THE POINT OF metadata. An application id goes in on the send and comes back on
// every webhook, so EduRankAI application -> email -> delivery -> recipient event is one join and not
// a reconstruction.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';
import { isUuid } from './keys';
import { queueEvent, type EventType } from './webhooks';

export type MessageStatus = 'queued' | 'processing' | 'sent' | 'delivered' | 'deferred' | 'bounced' | 'failed' | 'cancelled';

/**
 * Rank order for status transitions. A status may only move forward.
 *
 * 'deferred' sits below 'sent' on purpose: a deferral is a temporary refusal by the receiving server,
 * so the message has not been handed over yet and a later successful hand-off must be able to move it
 * to 'sent'.
 */
const RANK: Record<MessageStatus, number> = {
  queued: 1, processing: 2, deferred: 3, sent: 4, delivered: 5, bounced: 6, failed: 6, cancelled: 7,
};

/** Events that carry a status change. The rest (opens, clicks, unsubscribes) are recorded only. */
const EVENT_STATUS: Partial<Record<string, MessageStatus>> = {
  'email.queued': 'queued',
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.deferred': 'deferred',
  'email.bounced': 'bounced',
  'email.failed': 'failed',
};

/** Pure: the status a message should hold after an event. Never moves backwards. */
export function nextStatus(current: MessageStatus, eventType: string): MessageStatus {
  const candidate = EVENT_STATUS[eventType];
  if (!candidate) return current;
  return RANK[candidate] > RANK[current] ? candidate : current;
}

export function isTerminal(status: MessageStatus): boolean {
  return status === 'delivered' || status === 'bounced' || status === 'failed' || status === 'cancelled';
}

/** Retry backoff for a transient SMTP failure: 1m, 5m, 15m, 1h, 4h. */
const SEND_BACKOFF_SEC = [60, 300, 900, 3600, 14400];
export function sendBackoffMs(attempt: number): number {
  const i = Math.max(0, Math.min(SEND_BACKOFF_SEC.length - 1, Math.floor(attempt)));
  return SEND_BACKOFF_SEC[i] * 1000;
}

/**
 * Is an SMTP error worth retrying?
 *
 * A 4xx reply, a timeout or a dropped connection is the receiving side asking us to come back. A 5xx
 * is a refusal, and retrying it four more times is how a sending domain earns a reputation problem.
 */
export function isTransientSmtpError(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (/\b5\d\d\b/.test(m) && !/\b4\d\d\b/.test(m)) return false;
  return /timeout|etimedout|econnreset|econnrefused|esocket|greylist|try again|temporar|\b4\d\d\b|too many|rate/i.test(m);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface MessageRecord {
  id: string;
  orgId: string;
  environment: string;
  status: MessageStatus;
  from: string;
  fromName: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  suppressedRecipients: any[];
  subject: string;
  templateKey: string | null;
  templateVersion: number | null;
  templateState: string | null;
  tags: string[];
  metadata: Record<string, any>;
  attachments: any[];
  scheduledAt: string | null;
  attempts: number;
  lastError: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export function mapMessage(r: any): MessageRecord {
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  return {
    id: r.id,
    orgId: r.org_id,
    environment: r.environment,
    status: r.status,
    from: r.from_email,
    fromName: r.from_name || null,
    replyTo: r.reply_to || null,
    to: arr(r.to_emails),
    cc: arr(r.cc_emails),
    bcc: arr(r.bcc_emails),
    suppressedRecipients: arr(r.suppressed),
    subject: r.subject || '',
    templateKey: r.template_key || null,
    templateVersion: r.template_version == null ? null : Number(r.template_version),
    templateState: r.template_state || null,
    tags: arr(r.tags),
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    attachments: arr(r.attachments),
    scheduledAt: r.scheduled_at || null,
    attempts: Number(r.attempts || 0),
    lastError: r.last_error || null,
    queuedAt: r.queued_at,
    sentAt: r.sent_at || null,
    deliveredAt: r.delivered_at || null,
    failedAt: r.failed_at || null,
    createdAt: r.created_at,
  };
}

/** The public shape of a message. bcc is never returned — see the note in the status route. */
export function publicMessage(m: MessageRecord, opts: { includeBcc?: boolean } = {}): Record<string, any> {
  return {
    id: m.id,
    object: 'message',
    status: m.status,
    environment: m.environment,
    from: m.fromName ? m.fromName + ' <' + m.from + '>' : m.from,
    to: m.to,
    cc: m.cc.length ? m.cc : undefined,
    ...(opts.includeBcc && m.bcc.length ? { bcc: m.bcc } : {}),
    reply_to: m.replyTo || undefined,
    subject: m.subject,
    template: m.templateKey ? { key: m.templateKey, version: m.templateVersion, state: m.templateState } : undefined,
    tags: m.tags.length ? m.tags : undefined,
    metadata: Object.keys(m.metadata).length ? m.metadata : undefined,
    attachments: m.attachments.length ? m.attachments : undefined,
    suppressed_recipients: m.suppressedRecipients.length ? m.suppressedRecipients : undefined,
    scheduled_at: m.scheduledAt || undefined,
    attempts: m.attempts,
    last_error: m.lastError || undefined,
    queued_at: m.queuedAt,
    sent_at: m.sentAt || undefined,
    delivered_at: m.deliveredAt || undefined,
    failed_at: m.failedAt || undefined,
    created_at: m.createdAt,
  };
}

export interface CreateMessageInput {
  orgId: string;
  environment: string;
  apiKeyId: string | null;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  suppressed?: any[];
  subject: string;
  html: string;
  text: string;
  templateId?: string | null;
  templateKey?: string | null;
  templateVersion?: number | null;
  templateState?: string | null;
  tags?: string[];
  metadata?: Record<string, any>;
  headers?: Record<string, string>;
  attachments?: any[];
  idempotencyKey?: string | null;
  scheduledAt?: Date | null;
}

export async function createMessage(p: CreateMessageInput): Promise<MessageRecord> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_messages (
      org_id, environment, api_key_id, status, from_email, from_name, reply_to,
      to_emails, cc_emails, bcc_emails, suppressed, subject, body_html, body_text,
      template_id, template_key, template_version, template_state,
      tags, metadata, headers, attachments, idempotency_key, scheduled_at, next_attempt_at)
    VALUES (
      ${p.orgId}, ${p.environment}, ${p.apiKeyId}, 'queued', ${p.from}, ${p.fromName || null}, ${p.replyTo || null},
      ${JSON.stringify(p.to)}::jsonb, ${JSON.stringify(p.cc || [])}::jsonb, ${JSON.stringify(p.bcc || [])}::jsonb,
      ${JSON.stringify(p.suppressed || [])}::jsonb, ${p.subject}, ${p.html}, ${p.text},
      ${p.templateId || null}, ${p.templateKey || null}, ${p.templateVersion ?? null}, ${p.templateState || null},
      ${JSON.stringify(p.tags || [])}::jsonb, ${JSON.stringify(p.metadata || {})}::jsonb,
      ${JSON.stringify(p.headers || {})}::jsonb, ${JSON.stringify(p.attachments || [])}::jsonb,
      ${p.idempotencyKey || null}, ${p.scheduledAt ? p.scheduledAt.toISOString() : null},
      ${p.scheduledAt ? p.scheduledAt.toISOString() : new Date().toISOString()})
    RETURNING *`));
  const record = mapMessage(r[0]);

  // ONE MAILBOX, NOT THREE. This row is the SEND JOB — environment, idempotency key, attempts,
  // backoff. The MESSAGE itself is written to the shared store (mail_messages), which is what the
  // webmail client at /admin/mail and /portal/employee/mail reads, so a message sent through this
  // API is visible there instead of living in a separate table nobody else queries.
  //
  // Nothing above changes: every field, signature and response shape in this module is untouched.
  // The bridge never throws and never blocks a send — if mirroring fails the send still happens and
  // the failure is logged, because a unification that could fail a send would be worse than the
  // fork it replaced. See src/lib/mailplatform/mailapi-bridge.ts.
  try {
    const { mirrorToPlatformStore } = await import('@/lib/mailplatform/mailapi-bridge');
    await mirrorToPlatformStore({
      sendJobId: record.id,
      orgId: p.orgId,
      environment: p.environment,
      from: p.from,
      fromName: p.fromName ?? null,
      replyTo: p.replyTo ?? null,
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      html: p.html,
      text: p.text,
      templateKey: p.templateKey ?? null,
      templateVersion: p.templateVersion ?? null,
      tags: p.tags,
      metadata: p.metadata,
      attachments: p.attachments,
      scheduledAt: p.scheduledAt ?? null,
    });
  } catch (e: any) {
    console.error('[mailapi] shared-store mirror failed for', record.id, '-', e?.cause?.message || e?.message);
  }

  return record;
}

export async function getMessage(id: string, opts: { orgId?: string; environment?: string } = {}): Promise<MessageRecord | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT * FROM mailapi_messages WHERE id = ${id.trim()}
      AND (${opts.orgId || null}::uuid IS NULL OR org_id = ${opts.orgId || null}::uuid)
      AND (${opts.environment || null}::text IS NULL OR environment = ${opts.environment || null})
    LIMIT 1`));
  return r[0] ? mapMessage(r[0]) : null;
}

/** The rendered bodies, kept out of the list/status shapes because they are large. */
export async function getMessageBody(id: string, orgId: string, environment: string): Promise<{ html: string; text: string } | null> {
  if (!isUuid(id)) return null;
  await ensureMailApiSchema();
  // The org and environment check stays here and runs FIRST. The shared store knows nothing about
  // this API's environments, so reading the body straight out of it would let a test-environment key
  // read a live-environment body.
  const r = rows(await db.execute(sql`
    SELECT body_html, body_text FROM mailapi_messages
    WHERE id = ${id.trim()} AND org_id = ${orgId} AND environment = ${environment} LIMIT 1`));
  if (!r[0]) return null;

  // Prefer the shared store: after the bridge, that is where the message of record lives. The local
  // columns remain the answer for rows written before it landed — real mail somebody sent, which
  // must not read as empty because it predates a refactor.
  try {
    const { readSharedBody } = await import('@/lib/mailplatform/mailapi-bridge');
    const shared = await readSharedBody(id.trim());
    if (shared) return shared;
  } catch (e: any) {
    console.error('[mailapi] shared body read failed, using the local copy -', e?.cause?.message || e?.message);
  }
  return { html: r[0].body_html || '', text: r[0].body_text || '' };
}

export interface ListMessagesQuery {
  orgId: string;
  environment: string;
  status?: string;
  tag?: string;
  recipient?: string;
  metadataKey?: string;
  metadataValue?: string;
  limit?: number;
  before?: string;
}

export async function listMessages(q: ListMessagesQuery): Promise<MessageRecord[]> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT * FROM mailapi_messages
    WHERE org_id = ${q.orgId} AND environment = ${q.environment}
      AND (${q.status || null}::text IS NULL OR status = ${q.status || null})
      AND (${q.tag || null}::text IS NULL OR tags ? ${q.tag || null})
      AND (${q.recipient || null}::text IS NULL OR to_emails ? ${(q.recipient || '').toLowerCase() || null})
      AND (${q.metadataKey || null}::text IS NULL OR metadata ->> ${q.metadataKey || null} = ${q.metadataValue || null})
      AND (${q.before || null}::timestamptz IS NULL OR created_at < ${q.before || null}::timestamptz)
    ORDER BY created_at DESC LIMIT ${Math.min(200, Math.max(1, q.limit || 50))}`));
  return r.map(mapMessage);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface MessageEvent {
  id: string;
  type: string;
  recipient: string | null;
  data: Record<string, any>;
  occurredAt: string;
}

export async function getMessageEvents(messageId: string, limit = 100): Promise<MessageEvent[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT id, type, recipient, data, occurred_at FROM mailapi_message_events
    WHERE message_id = ${messageId} ORDER BY occurred_at ASC, id ASC LIMIT ${Math.min(500, limit)}`))
    .map((r: any) => ({ id: r.id, type: r.type, recipient: r.recipient || null, data: r.data || {}, occurredAt: r.occurred_at }));
}

export interface RecordEventInput {
  message: MessageRecord;
  orgSlug: string;
  type: EventType | 'webhook.verification';
  recipient?: string | null;
  data?: Record<string, any>;
  /** Skip the webhook fan-out. Used by the send path for events it batches itself. */
  skipWebhooks?: boolean;
}

/**
 * Append an event, move the status if the event implies one, and queue the webhook fan-out.
 *
 * The status UPDATE carries its own guard rather than trusting the value we just computed: two
 * concurrent events (a delivery confirmation and a bounce arriving together) would otherwise both
 * write, and the loser of the race would be whichever finished last rather than whichever is true.
 */
export async function recordEvent(p: RecordEventInput): Promise<{ eventId: string; status: MessageStatus }> {
  await ensureMailApiSchema();
  const m = p.message;
  const ev = rows(await db.execute(sql`
    INSERT INTO mailapi_message_events (message_id, org_id, environment, type, recipient, data)
    VALUES (${m.id}, ${m.orgId}, ${m.environment}, ${p.type}, ${p.recipient || null}, ${JSON.stringify(p.data || {})}::jsonb)
    RETURNING id, occurred_at`))[0];

  const target = nextStatus(m.status, p.type);
  let status = m.status;
  if (target !== m.status) {
    const ranks = Object.entries(RANK).filter(([, v]) => v < RANK[target]).map(([k]) => k);
    const updated = rows(await db.execute(sql`
      UPDATE mailapi_messages SET status = ${target}, updated_at = now(),
        sent_at = CASE WHEN ${target} = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
        delivered_at = CASE WHEN ${target} = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
        failed_at = CASE WHEN ${target} IN ('failed', 'bounced') THEN COALESCE(failed_at, now()) ELSE failed_at END,
        last_error = COALESCE(${(p.data?.error as string) || null}, last_error)
      WHERE id = ${m.id}
        AND status IN (SELECT jsonb_array_elements_text(${JSON.stringify(ranks)}::jsonb))
      RETURNING status`));
    status = (updated[0]?.status as MessageStatus) || m.status;
  }

  if (!p.skipWebhooks) {
    await queueEvent({
      orgId: m.orgId,
      orgSlug: p.orgSlug,
      environment: m.environment,
      eventId: ev.id,
      type: p.type,
      createdAt: new Date(ev.occurred_at).toISOString(),
      data: {
        message_id: m.id,
        status,
        subject: m.subject,
        from: m.from,
        to: m.to,
        recipient: p.recipient || m.to[0] || null,
        template: m.templateKey ? { key: m.templateKey, version: m.templateVersion } : null,
        tags: m.tags,
        metadata: m.metadata,
        ...(p.data || {}),
      },
    }).catch((e: any) => console.error('[mailapi] webhook fan-out failed:', e?.cause?.message || e?.message));
  }

  return { eventId: ev.id, status };
}

/**
 * Record an event when all you have is a message id — the tracking endpoints, the unsubscribe
 * handler and the delivery-event ingest all arrive that way.
 *
 * `dedupeWindowSec` exists because a mail client that prefetches images fires the open pixel two or
 * three times within a second. Emitting three `email.opened` webhooks for one human opening one mail
 * would make every integration's open count wrong, so a repeat of the same event type for the same
 * recipient inside the window is dropped. It is a dedupe, not a cap: a genuine second open an hour
 * later is a second event.
 */
export async function recordEventById(messageId: string, type: string, opts: { recipient?: string | null; data?: Record<string, any>; dedupeWindowSec?: number } = {}): Promise<{ recorded: boolean; reason?: string }> {
  if (!isUuid(messageId)) return { recorded: false, reason: 'bad id' };
  await ensureMailApiSchema();
  const message = await getMessage(messageId);
  if (!message) return { recorded: false, reason: 'no such message' };

  const window = opts.dedupeWindowSec ?? 0;
  if (window > 0) {
    const recent = rows(await db.execute(sql`
      SELECT id FROM mailapi_message_events
      WHERE message_id = ${messageId} AND type = ${type}
        AND (${opts.recipient || null}::text IS NULL OR recipient = ${opts.recipient || null})
        AND occurred_at > now() - (${String(window)} || ' seconds')::interval
      LIMIT 1`));
    if (recent.length) return { recorded: false, reason: 'deduped' };
  }

  const slugRow = rows(await db.execute(sql`SELECT slug FROM mailapi_orgs WHERE id = ${message.orgId} LIMIT 1`))[0];
  await recordEvent({
    message,
    orgSlug: slugRow?.slug || 'unknown',
    type: type as any,
    recipient: opts.recipient || null,
    data: opts.data || {},
  });
  return { recorded: true };
}

// ---------------------------------------------------------------------------
// Dispatcher support
// ---------------------------------------------------------------------------

/**
 * Claim messages that are due to be sent, in ONE statement.
 *
 * Same shape as claimDueScheduled() in mail-advanced.ts and for the same reason recorded there: a
 * plain SELECT followed by a send lets two overlapping runs deliver the same message twice, and mail
 * that has left the building cannot be recalled.
 */
export async function claimDueMessages(limit = 20): Promise<MessageRecord[]> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_messages SET status = 'processing', claimed_at = now(), updated_at = now()
    WHERE id IN (
      SELECT id FROM mailapi_messages
      WHERE ((status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= now()) AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
          OR (status = 'deferred' AND next_attempt_at <= now())
          OR (status = 'processing' AND claimed_at < now() - interval '10 minutes'))
        AND attempts < max_attempts
      ORDER BY COALESCE(scheduled_at, queued_at) ASC
      LIMIT ${Math.min(100, limit)} FOR UPDATE SKIP LOCKED)
    RETURNING *`));
  return r.map(mapMessage);
}

export async function markAttempt(id: string, p: { rfcMessageId?: string | null; nextAttemptAt?: Date | null; error?: string | null }): Promise<void> {
  await ensureMailApiSchema();
  await db.execute(sql`
    UPDATE mailapi_messages SET attempts = attempts + 1, updated_at = now(),
      rfc_message_id = COALESCE(${p.rfcMessageId || null}, rfc_message_id),
      next_attempt_at = ${p.nextAttemptAt ? p.nextAttemptAt.toISOString() : null},
      last_error = ${p.error ? String(p.error).slice(0, 500) : null}
    WHERE id = ${id}`);
}

export async function cancelMessage(orgId: string, environment: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_messages SET status = 'cancelled', updated_at = now()
    WHERE id = ${id.trim()} AND org_id = ${orgId} AND environment = ${environment}
      AND status = 'queued' AND scheduled_at IS NOT NULL AND scheduled_at > now()
    RETURNING id`));
  return r.length > 0;
}

/** Counters for the console and for GET /v1/messages/stats. */
export async function messageStats(orgId: string, environment: string, days = 7): Promise<Record<string, number>> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT status, COUNT(*)::int AS c FROM mailapi_messages
    WHERE org_id = ${orgId} AND environment = ${environment}
      AND created_at > now() - (${String(Math.max(1, days))} || ' days')::interval
    GROUP BY status`));
  const out: Record<string, number> = { queued: 0, processing: 0, sent: 0, delivered: 0, deferred: 0, bounced: 0, failed: 0, cancelled: 0 };
  for (const row of r) out[String(row.status)] = Number(row.c);
  return out;
}
