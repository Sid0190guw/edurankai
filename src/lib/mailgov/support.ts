// src/lib/mailgov/support.ts — THE SUPPORT DESK, AND THE DOOR IN FRONT OF MESSAGE CONTENT.
//
// The projections and the grant rules are in ./support-policy.ts (pure, tested). This file does the
// reads and holds the grant lifecycle.
//
// THE DEFAULT PATH TOUCHES NO BODY COLUMN. lookupMessages() and messageMetadata() select an explicit
// column list that does not include body_html or body_text — not "select them and strip them later",
// because a projection applied after the fact is a projection somebody eventually forgets, and the
// bytes have already crossed a process boundary by then. The only function in this repository that
// selects a body for support is readMessageContent(), and it will not run without an approved grant.
//
// EVERY CONTENT READ IS AUDITED AND COUNTED, and the count is enforced. A grant is not a mode; it is
// a small number of uses against one record for a few hours, and the console shows the tenant's
// administrators every time one is used against their organization.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureGovernanceSchema, rows, dbReason } from './schema';
import { recordSecurityEvent } from './security-events';
import {
  GRANT_HOURS, GRANT_MAX_USES, grantExpiry, grantUsable, retryEligible,
  toContentView, toMetadataView, validateGrantRequest,
  type ContentGrant, type MessageContentView, type MessageMetadataView, type SupportSubjectType,
} from './support-policy';

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

/**
 * The columns support may see without any authorisation.
 *
 * `subject` and the body columns are absent by construction. Adding one to this list is the change a
 * reviewer should stop, which is why it is a named constant rather than an inline string.
 */
const METADATA_COLUMNS = `id, org_id, environment, status, from_email, from_name, to_emails, cc_emails,
  template_key, template_version, attempts, max_attempts, last_error, rfc_message_id,
  scheduled_at, queued_at, sent_at, delivered_at, failed_at, created_at`;

export interface MessageLookup {
  orgId?: string | null;
  messageId?: string | null;
  rfcMessageId?: string | null;
  recipient?: string | null;
  status?: string | null;
  since?: string | null;
  limit?: number;
}

/** Find messages by envelope facts. Never by subject and never by body — see the note at the top. */
export async function lookupMessages(q: MessageLookup): Promise<ReadResult<MessageMetadataView>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const r = await db.execute(sql`
      SELECT ${sql.raw(METADATA_COLUMNS)}, (body_html IS NOT NULL OR body_text IS NOT NULL) AS has_content
        FROM mailapi_messages
       WHERE ${q.orgId ? sql`org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.messageId ? sql`id = ${q.messageId}::uuid` : sql`TRUE`}
         AND ${q.rfcMessageId ? sql`rfc_message_id = ${q.rfcMessageId}` : sql`TRUE`}
         AND ${q.recipient ? sql`to_emails @> ${JSON.stringify([String(q.recipient).toLowerCase()])}::jsonb` : sql`TRUE`}
         AND ${q.status ? sql`status = ${q.status}` : sql`TRUE`}
         AND ${q.since ? sql`created_at >= ${q.since}::timestamptz` : sql`TRUE`}
       ORDER BY created_at DESC
       LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(toMetadataView) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

/** One message's metadata, plus its delivery event trail — which is what answers most tickets. */
export async function messageMetadata(messageId: string): Promise<{
  ok: boolean;
  reason?: string;
  message?: MessageMetadataView;
  events?: { type: string; recipient: string | null; occurredAt: string; data: Record<string, unknown> }[];
}> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT ${sql.raw(METADATA_COLUMNS)}, (body_html IS NOT NULL OR body_text IS NOT NULL) AS has_content
        FROM mailapi_messages WHERE id = ${messageId}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, reason: 'No such message.' };

    const ev = rows(await db.execute(sql`
      SELECT type, recipient, data, occurred_at FROM mailapi_message_events
       WHERE message_id = ${messageId}::uuid ORDER BY occurred_at ASC LIMIT 200`));

    return {
      ok: true,
      message: toMetadataView(r),
      events: ev.map((x: any) => ({
        type: String(x.type),
        recipient: x.recipient ?? null,
        occurredAt: new Date(x.occurred_at).toISOString(),
        data: (x.data && typeof x.data === 'object') ? x.data : {},
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Content grants
// ---------------------------------------------------------------------------------------------

function mapGrant(r: any): ContentGrant {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    subjectType: String(r.subject_type) as SupportSubjectType,
    subjectId: String(r.subject_id),
    requestedBy: String(r.requested_by),
    reason: String(r.reason),
    matterRef: r.matter_ref ?? null,
    status: String(r.status) as ContentGrant['status'],
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    uses: Number(r.uses) || 0,
    maxUses: Number(r.max_uses) || GRANT_MAX_USES,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function requestContentGrant(input: {
  orgId: string;
  subjectType: SupportSubjectType;
  subjectId: string;
  reason: string;
  matterRef?: string | null;
  requestedBy: string;
}): Promise<{ ok: boolean; error?: string; grantId?: string }> {
  const v = validateGrantRequest(input);
  if (!v.ok) return { ok: false, error: v.error };
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO mailapi_support_grants (org_id, subject_type, subject_id, requested_by, reason, matter_ref, status, max_uses)
      VALUES (${input.orgId}::uuid, ${input.subjectType}, ${input.subjectId}, ${input.requestedBy}::uuid,
              ${String(input.reason).slice(0, 4000)}, ${input.matterRef || null}, 'requested', ${GRANT_MAX_USES})
      RETURNING id`))[0];
    return { ok: true, grantId: String(r?.id) };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Approve a request to read somebody's mail.
 *
 * THE APPROVER MAY NOT BE THE REQUESTER, and that is checked here as well as by the capability split
 * (support holds `support.content.request`; only a platform owner holds `support.content.approve`).
 * Two independent checks, because this is the control that a single mistake would make meaningless.
 */
export async function approveContentGrant(input: {
  grantId: string;
  byUserId: string;
  hours?: number;
  now?: Date;
}): Promise<{ ok: boolean; error?: string; expiresAt?: string }> {
  const now = input.now || new Date();
  try {
    await ensureGovernanceSchema();
    const g = rows(await db.execute(sql`SELECT * FROM mailapi_support_grants WHERE id = ${input.grantId}::uuid LIMIT 1`))[0];
    if (!g) return { ok: false, error: 'No such authorisation request.' };
    if (String(g.status) !== 'requested') return { ok: false, error: 'That request is ' + String(g.status) + '.' };
    if (String(g.requested_by) === input.byUserId) {
      return { ok: false, error: 'The person who asked to read the content cannot authorise it themselves.' };
    }

    const expires = grantExpiry(now, input.hours || GRANT_HOURS);
    await db.execute(sql`
      UPDATE mailapi_support_grants
         SET status = 'approved', approved_by = ${input.byUserId}::uuid, approved_at = now(), expires_at = ${expires}::timestamptz
       WHERE id = ${input.grantId}::uuid`);
    return { ok: true, expiresAt: expires };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function denyContentGrant(input: {
  grantId: string;
  byUserId: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_support_grants
         SET status = 'denied', denied_by = ${input.byUserId}::uuid, denied_at = now(),
             denial_reason = ${String(input.reason || '').slice(0, 2000) || null}
       WHERE id = ${input.grantId}::uuid AND status = 'requested'
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'That request is not open.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function revokeContentGrant(input: { grantId: string; byUserId: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_support_grants
         SET status = 'revoked', revoked_by = ${input.byUserId}::uuid, revoked_at = now()
       WHERE id = ${input.grantId}::uuid AND status IN ('requested', 'approved')
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'That authorisation cannot be revoked.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function listContentGrants(q: { orgId?: string | null; status?: string | null; limit?: number }): Promise<ReadResult<ContentGrant>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT * FROM mailapi_support_grants
       WHERE ${q.orgId ? sql`org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.status ? sql`status = ${q.status}` : sql`TRUE`}
       ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(q.limit) || 100, 1), 300)}`);
    return { ok: true, rows: rows(r).map(mapGrant) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export interface ContentReadResult {
  ok: boolean;
  error?: string;
  view?: MessageContentView;
  /** Uses left on the authorisation after this read. Shown on screen so it is never a surprise. */
  usesRemaining?: number;
}

/**
 * READ A MESSAGE BODY.
 *
 * The order is: load the grant, ask ./support-policy.ts whether it may be used for THIS record right
 * now, increment the use count CONDITIONALLY, and only then select the body. The conditional
 * increment is what makes the use limit real under concurrency — two simultaneous reads on a grant
 * with one use left produce one success and one refusal, rather than two reads and a counter that
 * says 26 of 25.
 *
 * The audit event is written by the ROUTE through auditedWrite(), before this is called, so a body is
 * never selected on a request whose audit could not be recorded. A security event is written here as
 * well: content access is rare enough, and serious enough, to belong on the security screen too.
 */
export async function readMessageContent(input: {
  grantId: string;
  messageId: string;
  actorUserId: string;
  ip?: string | null;
  requestId?: string | null;
  now?: Date;
}): Promise<ContentReadResult> {
  const now = input.now || new Date();
  try {
    await ensureGovernanceSchema();
    const g = rows(await db.execute(sql`SELECT * FROM mailapi_support_grants WHERE id = ${input.grantId}::uuid LIMIT 1`))[0];
    if (!g) return { ok: false, error: 'No such authorisation.' };
    const grant = mapGrant(g);

    const msgMeta = rows(await db.execute(sql`
      SELECT id, org_id FROM mailapi_messages WHERE id = ${input.messageId}::uuid LIMIT 1`))[0];
    if (!msgMeta) return { ok: false, error: 'No such message.' };

    const usable = grantUsable(grant, {
      orgId: String(msgMeta.org_id),
      subjectType: 'message',
      subjectId: input.messageId,
    }, now);
    if (!usable.usable) return { ok: false, error: usable.reason };

    // Conditional increment: the WHERE clause carries the same limits the check above applied, so a
    // race cannot spend a use that is not there.
    const claimed = rows(await db.execute(sql`
      UPDATE mailapi_support_grants SET uses = uses + 1
       WHERE id = ${input.grantId}::uuid AND status = 'approved'
         AND uses < max_uses AND (expires_at IS NULL OR expires_at > now())
      RETURNING uses, max_uses`))[0];
    if (!claimed) return { ok: false, error: 'That authorisation was used up, expired or revoked between the check and the read.' };

    const row = rows(await db.execute(sql`
      SELECT id, org_id, environment, status, from_email, from_name, to_emails, cc_emails, subject,
             body_html, body_text, template_key, template_version, attempts, max_attempts, last_error,
             rfc_message_id, scheduled_at, queued_at, sent_at, delivered_at, failed_at, created_at
        FROM mailapi_messages WHERE id = ${input.messageId}::uuid LIMIT 1`))[0];
    if (!row) return { ok: false, error: 'The message disappeared between the authorisation and the read.' };

    await recordSecurityEvent({
      type: 'support.content_accessed',
      orgId: String(msgMeta.org_id),
      subject: input.messageId,
      actorUserId: input.actorUserId,
      ip: input.ip || null,
      requestId: input.requestId || null,
      detail: { grantId: grant.id, approvedBy: grant.approvedBy, matterRef: grant.matterRef, reason: grant.reason },
    });

    const remaining = Math.max(0, Number(claimed.max_uses) - Number(claimed.uses));
    if (remaining === 0) {
      await db.execute(sql`UPDATE mailapi_support_grants SET status = 'exhausted' WHERE id = ${grant.id}::uuid`);
    }

    return { ok: true, view: toContentView(row, grant), usesRemaining: remaining };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Retry a message the platform failed to deliver.
 *
 * Eligibility is decided by retryEligible() in ./support-policy.ts, which refuses a suppressed
 * message — retrying one would mail an address that is on the suppression list, which is the single
 * most damaging thing a support tool could do by accident.
 *
 * The retry only resets the SCHEDULING columns. It does not touch the body, the recipients or the
 * attempt history, so a retried message is the same message tried again rather than a new one that
 * happens to look similar.
 */
export async function retryMessage(messageId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT id, status, attempts, max_attempts FROM mailapi_messages WHERE id = ${messageId}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, error: 'No such message.' };

    const check = retryEligible(r);
    if (!check.ok) return { ok: false, error: check.reason };

    await db.execute(sql`
      UPDATE mailapi_messages
         SET status = 'queued', next_attempt_at = now(), claimed_at = NULL, updated_at = now()
       WHERE id = ${messageId}::uuid`);
    return { ok: true, detail: check.reason };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}
