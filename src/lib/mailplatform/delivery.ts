// src/lib/mailplatform/delivery.ts — attempts, current status, bounces, and the fact stream.
//
// THREE TABLES, THREE DIFFERENT QUESTIONS, and they are separate on purpose:
//
//   mp_delivery_attempts  "what did we try, and what did the remote server say?"   (one row per try)
//   mp_delivery_events    "what happened?"                                          (append-only facts)
//   mp_delivery_status    "where is this recipient right now?"                      (one row, updated)
//
// Collapsing them into one table means either losing history to an UPDATE, or answering "is this
// delivered?" with a sort over every event ever recorded for the message. Both are worse.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { addressKey, classifyBounce, shouldSuppressAfterBounce } from './rfc';
import { suppress } from './suppression';
import { providers } from './providers';
import { EVENT_TYPES } from './adapters/event-bus-postgres';
import type { BounceType, DeliveryEventType, DeliveryState, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Open a status row per recipient the moment a message is stored, before anything is attempted. */
export async function recordQueued(orgId: UUID, messageId: UUID, addresses: string[]): Promise<void> {
  const keys = [...new Set(addresses.map(addressKey).filter(Boolean))];
  if (!keys.length) return;
  try {
    const values = keys.map((a) => sql`(${orgId}, ${messageId}, ${a}, 'queued', NOW())`);
    await db.execute(sql`
      INSERT INTO mp_delivery_status (org_id, message_id, recipient_address, status, last_event_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (message_id, recipient_address) DO NOTHING`);
  } catch (e: any) {
    console.error('[mailplatform/delivery] recordQueued failed for', messageId, '-', causeOf(e));
  }
}

export interface AttemptInput {
  orgId: UUID;
  messageId: UUID;
  recipientAddress: string;
  transport: string;
  attemptNo: number;
  status: 'sent' | 'deferred' | 'failed';
  smtpCode?: number | null;
  smtpResponse?: string | null;
  remoteMx?: string | null;
  latencyMs?: number | null;
  error?: string | null;
}

/**
 * Record one delivery attempt and roll the recipient's current status forward.
 *
 * The status UPDATE deliberately does NOT move a recipient backwards: once 'delivered', a late
 * 'sent' event from a retry must not undo it. That is expressed in the WHERE rather than in code
 * that reads-then-writes, so two workers racing cannot produce a wrong final state.
 */
export async function recordAttempt(input: AttemptInput): Promise<void> {
  const address = addressKey(input.recipientAddress);
  try {
    await db.execute(sql`
      INSERT INTO mp_delivery_attempts
        (org_id, message_id, recipient_address, transport, attempt_no, status, smtp_code, smtp_response, remote_mx, latency_ms, error, finished_at)
      VALUES
        (${input.orgId}, ${input.messageId}, ${address}, ${input.transport}, ${input.attemptNo}, ${input.status},
         ${input.smtpCode ?? null}, ${input.smtpResponse ?? null}, ${input.remoteMx ?? null},
         ${input.latencyMs ?? null}, ${input.error ?? null}, NOW())`);

    await db.execute(sql`
      UPDATE mp_delivery_status
      SET status = ${input.status === 'sent' ? 'sent' : input.status},
          attempts = attempts + 1,
          last_event_at = NOW(),
          last_error = ${input.error ?? null},
          updated_at = NOW()
      WHERE message_id = ${input.messageId} AND recipient_address = ${address}
        AND status NOT IN ('delivered', 'bounced')`);
  } catch (e: any) {
    console.error('[mailplatform/delivery] recordAttempt failed for', input.messageId, address, '-', causeOf(e));
  }
}

export interface EventInput {
  orgId: UUID;
  messageId?: UUID | null;
  campaignId?: UUID | null;
  contactId?: UUID | null;
  recipients: string[];
  eventType: DeliveryEventType;
  providerEventId?: string | null;
  meta?: Record<string, unknown>;
  occurredAt?: string;
}

/** Append delivery events. One statement for the whole batch. */
export async function recordEvent(input: EventInput): Promise<void> {
  const keys = [...new Set((input.recipients || []).map(addressKey).filter(Boolean))];
  if (!keys.length) return;
  try {
    const when = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const values = keys.map(
      (a) => sql`(${input.orgId}, ${input.messageId || null}, ${input.campaignId || null}, ${input.contactId || null},
                  ${a}, ${input.eventType}, ${input.providerEventId || null},
                  ${JSON.stringify(input.meta || {})}::jsonb, ${when})`,
    );
    await db.execute(sql`
      INSERT INTO mp_delivery_events
        (org_id, message_id, campaign_id, contact_id, recipient_address, event_type, provider_event_id, meta, occurred_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (provider_event_id) DO NOTHING`);
  } catch (e: any) {
    console.error('[mailplatform/delivery] recordEvent failed -', causeOf(e));
  }
}

// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------

export interface BounceInput {
  orgId: UUID;
  messageId?: UUID | null;
  recipientAddress: string;
  smtpCode?: number | null;
  diagnosticCode?: string | null;
  reportedBy?: string | null;
  raw?: Record<string, unknown>;
  occurredAt?: string;
}

/**
 * Record a bounce and, when it is permanent, suppress the address.
 *
 * The classification is in ./rfc.ts and is tested there. This function is the policy: a HARD bounce
 * suppresses immediately; a SOFT bounce suppresses only after five in a row, counted from the
 * recorded bounce history rather than from a counter that could drift. An auto-reply is recorded
 * and does nothing else — an out-of-office is not a delivery failure, and treating it as one
 * unsubscribes people for going on holiday.
 */
export async function recordBounce(input: BounceInput): Promise<{ ok: boolean; bounceType: BounceType; suppressed: boolean; error?: string }> {
  const address = addressKey(input.recipientAddress);
  if (!address) return { ok: false, bounceType: 'unknown', suppressed: false, error: 'An address is required.' };

  const bounceType = classifyBounce(input.smtpCode, input.diagnosticCode);
  try {
    await db.execute(sql`
      INSERT INTO mp_bounce_events (org_id, message_id, recipient_address, bounce_type, smtp_code, diagnostic_code, reported_by, raw, occurred_at)
      VALUES (${input.orgId}, ${input.messageId || null}, ${address}, ${bounceType}, ${input.smtpCode ?? null},
              ${input.diagnosticCode ?? null}, ${input.reportedBy ?? null}, ${JSON.stringify(input.raw || {})}::jsonb,
              ${input.occurredAt ? new Date(input.occurredAt) : new Date()})`);

    if (input.messageId) {
      await db.execute(sql`
        UPDATE mp_delivery_status
        SET status = 'bounced', bounce_type = ${bounceType}, last_event_at = NOW(), updated_at = NOW()
        WHERE message_id = ${input.messageId} AND recipient_address = ${address}`);
    }

    await recordEvent({
      orgId: input.orgId,
      messageId: input.messageId,
      recipients: [address],
      eventType: 'bounced',
      meta: { bounceType, smtpCode: input.smtpCode ?? null, diagnostic: input.diagnosticCode ?? null },
      occurredAt: input.occurredAt,
    });

    let softCount = 0;
    if (bounceType === 'soft') {
      const r = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM mp_bounce_events
        WHERE org_id = ${input.orgId} AND lower(recipient_address) = ${address}
          AND bounce_type = 'soft' AND occurred_at > NOW() - INTERVAL '30 days'`));
      softCount = Number(r[0]?.n) || 0;
    }

    const decision = shouldSuppressAfterBounce(bounceType, softCount);
    if (decision.suppress && decision.reason) {
      await suppress({
        orgId: input.orgId,
        address,
        reason: decision.reason,
        source: input.reportedBy || 'delivery',
      });
    }

    await providers().events.publish({
      orgId: input.orgId,
      eventType: EVENT_TYPES.deliveryBounced,
      entityType: 'message',
      entityId: input.messageId || null,
      actorType: 'system',
      actorId: null,
      payload: { address, bounceType, suppressed: decision.suppress, smtpCode: input.smtpCode ?? null },
      occurredAt: (input.occurredAt ? new Date(input.occurredAt) : new Date()).toISOString(),
    });

    return { ok: true, bounceType, suppressed: decision.suppress };
  } catch (e: any) {
    return { ok: false, bounceType, suppressed: false, error: causeOf(e) };
  }
}

/** A spam complaint. Always suppresses — a complaint is the strongest opt-out signal there is. */
export async function recordComplaint(input: {
  orgId: UUID;
  messageId?: UUID | null;
  recipientAddress: string;
  reportedBy?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const address = addressKey(input.recipientAddress);
  if (!address) return { ok: false, error: 'An address is required.' };
  try {
    await recordEvent({
      orgId: input.orgId,
      messageId: input.messageId,
      recipients: [address],
      eventType: 'complained',
      meta: { reportedBy: input.reportedBy || null },
    });
    await suppress({ orgId: input.orgId, address, reason: 'complaint', source: input.reportedBy || 'feedback-loop' });
    await providers().events.publish({
      orgId: input.orgId,
      eventType: EVENT_TYPES.deliveryComplained,
      entityType: 'message',
      entityId: input.messageId || null,
      actorType: 'system',
      actorId: null,
      payload: { address },
      occurredAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** Mark a recipient delivered. Terminal — recordAttempt() will not move it back. */
export async function recordDelivered(orgId: UUID, messageId: UUID, address: string, providerEventId?: string | null): Promise<void> {
  const addr = addressKey(address);
  try {
    await db.execute(sql`
      UPDATE mp_delivery_status SET status = 'delivered', last_event_at = NOW(), updated_at = NOW()
      WHERE message_id = ${messageId} AND recipient_address = ${addr}`);
    await recordEvent({ orgId, messageId, recipients: [addr], eventType: 'delivered', providerEventId });
    await providers().events.publish({
      orgId,
      eventType: EVENT_TYPES.deliveryDelivered,
      entityType: 'message',
      entityId: messageId,
      actorType: 'system',
      actorId: null,
      payload: { address: addr },
      occurredAt: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[mailplatform/delivery] recordDelivered failed -', causeOf(e));
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RecipientStatus {
  address: string;
  status: DeliveryState;
  attempts: number;
  bounceType: BounceType | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export async function statusFor(orgId: UUID, messageId: UUID): Promise<RecipientStatus[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT recipient_address, status, attempts, bounce_type, last_event_at, last_error
      FROM mp_delivery_status WHERE org_id = ${orgId} AND message_id = ${messageId}
      ORDER BY recipient_address`));
    return r.map((row) => ({
      address: row.recipient_address,
      status: row.status,
      attempts: Number(row.attempts) || 0,
      bounceType: row.bounce_type ?? null,
      lastEventAt: row.last_event_at instanceof Date ? row.last_event_at.toISOString() : null,
      lastError: row.last_error ?? null,
    }));
  } catch (e: any) {
    console.error('[mailplatform/delivery] statusFor failed -', causeOf(e));
    return [];
  }
}

/**
 * The single sentence to show a human about a message's delivery.
 *
 * Pure, so it is tested. The wording is deliberately not optimistic: 'sent' means handed to a
 * server, NOT that anyone received it, and saying "Delivered" for a message that has only been
 * accepted by the first hop is the lie that makes a delivery report useless.
 */
export function summarize(statuses: RecipientStatus[]): { state: DeliveryState; label: string; detail: string } {
  if (!statuses.length) return { state: 'unknown', label: 'No delivery record', detail: 'Nothing has been recorded for this message.' };

  const count = (s: string) => statuses.filter((x) => x.status === s).length;
  const total = statuses.length;
  const bounced = count('bounced');
  const delivered = count('delivered');
  const failed = count('failed');
  const queued = count('queued') + count('deferred');
  const sent = count('sent');

  if (bounced === total) return { state: 'bounced', label: 'Bounced', detail: 'Every recipient rejected this message.' };
  if (delivered === total) return { state: 'delivered', label: 'Delivered', detail: `Confirmed delivered to all ${total}.` };
  if (failed === total) return { state: 'failed', label: 'Failed', detail: 'This message did not leave the platform.' };
  if (queued === total) return { state: 'queued', label: 'Queued', detail: 'Waiting to be sent.' };
  if (sent + delivered === total) {
    return {
      state: 'sent',
      label: 'Sent',
      detail:
        delivered > 0
          ? `Handed to the receiving servers. ${delivered} of ${total} confirmed delivered.`
          : 'Handed to the receiving servers. No delivery confirmation yet — that is normal for SMTP.',
    };
  }
  return {
    state: 'partial',
    label: 'Partly delivered',
    detail: `${delivered} delivered, ${sent} sent, ${bounced} bounced, ${failed} failed, ${queued} still queued, of ${total}.`,
  };
}
