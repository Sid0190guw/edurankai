// src/lib/mailplatform/send.ts — the one way a message leaves EduRankAI.
//
// EVERY product — Careers, AquinTutor, HEI, anything built later — calls this, directly or through
// POST /api/v1/messages/send. That is the whole point of the patch: one place that knows about
// suppression, sending identity, templates, delivery recording and the event stream, instead of
// fifteen call sites that each remembered a different subset.
//
// ORDER OF OPERATIONS, and every step is here because skipping it has a name:
//   1. resolve the organization and the sending identity   (an unverified From is spam)
//   2. resolve the template, if one was named              (missing variable -> "Dear ,")
//   3. parse and validate recipients                       (a dropped recipient is a silent failure)
//   4. check the suppression list                          (mailing a hard bounce hurts everyone)
//   5. persist the message BEFORE any transport call       (a send with no record cannot be traced)
//   6. hand external recipients to the transport
//   7. record attempts, delivery status and events         (what the analytics and webhooks read)
//
// Step 5 before step 6 is the important one. The reverse order — send, then write the row — loses
// the message entirely if the process dies between them, and that is precisely when you most want
// to know what was sent.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { providers } from './providers';
import { ensureMailPlatformSchema } from './schema';
import { defaultOrgId } from './orgs';
import { checkSuppressed } from './suppression';
import { getCurrentVersion, renderTemplate } from './templates';
import { EVENT_TYPES } from './adapters/event-bus-postgres';
import {
  buildRecipients,
  buildReferences,
  domainOf,
  htmlToText,
  makeMessageId,
  normalizeEmail,
  sanitizeHeaders,
  textToHtml,
} from './rfc';
import type { DeliveryState, Principal, SendRequest, SendResult, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'edurankai.in';

function fail(error: string, code?: string): SendResult {
  return {
    ok: false,
    messageId: null,
    threadId: null,
    rfcMessageId: null,
    accepted: [],
    rejected: [],
    suppressed: [],
    status: 'failed',
    error: code ? `${error} (${code})` : error,
  };
}

// ---------------------------------------------------------------------------
// Sending identity
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  domainId: UUID | null;
  isVerified: boolean;
}

/**
 * Which address this message goes out as.
 *
 * A caller may REQUEST a From, but may not invent one: an address that is not a registered sending
 * identity for the organization is refused. Otherwise an API key issued to one integration could
 * send as any address at any domain the platform can reach, which is the definition of an open
 * relay with a login.
 *
 * When nothing is registered at all, the legacy configured address (from /admin/mail/settings) is
 * used and reported as unverified. That keeps existing transactional mail working on the day this
 * ships, rather than silently stopping it — but it is never treated as verified.
 */
export async function resolveIdentity(orgId: UUID, requested?: string | null): Promise<ResolvedIdentity | { error: string }> {
  const wanted = normalizeEmail(requested);
  try {
    if (wanted) {
      const r = rows(await db.execute(sql`
        SELECT * FROM mp_sending_identities
        WHERE org_id = ${orgId} AND lower(from_address) = ${wanted} AND deleted_at IS NULL LIMIT 1`));
      if (!r.length) {
        return {
          error: `"${wanted}" is not a registered sending identity for this organization. Add it under Domains first — the platform will not send as an address it cannot authenticate.`,
        };
      }
      return {
        fromAddress: r[0].from_address,
        fromName: r[0].from_name ?? null,
        replyTo: r[0].reply_to ?? null,
        domainId: r[0].domain_id ?? null,
        isVerified: !!r[0].is_verified,
      };
    }

    const def = rows(await db.execute(sql`
      SELECT * FROM mp_sending_identities
      WHERE org_id = ${orgId} AND is_default = true AND deleted_at IS NULL LIMIT 1`));
    if (def.length) {
      return {
        fromAddress: def[0].from_address,
        fromName: def[0].from_name ?? null,
        replyTo: def[0].reply_to ?? null,
        domainId: def[0].domain_id ?? null,
        isVerified: !!def[0].is_verified,
      };
    }

    const { getMailConfig } = await import('@/lib/mail');
    const config = await getMailConfig();
    if (config.fromAddress) {
      return {
        fromAddress: config.fromAddress,
        fromName: config.fromName || 'EduRankAI',
        replyTo: null,
        domainId: null,
        isVerified: false,
      };
    }
    return {
      error: 'No sending identity is configured. Add one under Domains, or set a from address at /admin/mail/settings.',
    };
  } catch (e: any) {
    return { error: causeOf(e) };
  }
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

export interface SendContext {
  /** The caller, when the send came through the API. Absent for internal product sends. */
  principal?: Principal | null;
  /** Overrides the principal's org. Internal callers with no principal pass this. */
  orgId?: UUID;
  /** The user whose Sent folder gets a copy. Absent for machine-sent transactional mail. */
  fromUserId?: UUID | null;
}

export async function sendMessage(request: SendRequest, ctx: SendContext = {}): Promise<SendResult> {
  const schema = await ensureMailPlatformSchema();
  if (!schema.ok) return fail('The mail platform schema is not applied on this database: ' + schema.error, 'schema_missing');

  const orgId = request.orgId || ctx.orgId || ctx.principal?.orgId || (await defaultOrgId());
  if (!orgId) return fail('No organization could be resolved for this send.', 'no_org');

  const p = providers();

  // --- 1. identity -------------------------------------------------------
  const identity = await resolveIdentity(orgId, request.from);
  if ('error' in identity) return fail(identity.error, 'identity');

  // --- 2. template -------------------------------------------------------
  let subject = String(request.subject || '');
  let bodyHtml = request.bodyHtml || '';
  let bodyText = request.bodyText || '';

  if (request.template) {
    const found = await getCurrentVersion(orgId, request.template);
    if (!found) {
      return fail(
        `No published template with the key "${request.template}". A template must have a published version before it can be sent.`,
        'unknown_template',
      );
    }
    const rendered = renderTemplate(found.version, request.variables || {});
    if (rendered.missing.length) {
      // Refused, not sent with blanks. `Dear ,` reaching a candidate is worse than a 400 the
      // calling product can see in its own logs.
      return fail(
        `Template "${request.template}" needs ${rendered.missing.length === 1 ? 'a variable that was not supplied' : 'variables that were not supplied'}: ${rendered.missing.join(', ')}.`,
        'missing_variables',
      );
    }
    subject = request.subject || rendered.subject;
    bodyHtml = rendered.html;
    bodyText = rendered.text;
  }

  if (!bodyHtml && !bodyText) return fail('A message needs a body, a template, or both.', 'empty_body');
  if (!bodyHtml) bodyHtml = textToHtml(bodyText);
  if (!bodyText) bodyText = htmlToText(bodyHtml);
  if (bodyHtml.length > 2_000_000) return fail('That message body is too large to send.', 'body_too_large');

  // --- 3. recipients -----------------------------------------------------
  const { recipients, invalid } = buildRecipients({ to: request.to, cc: request.cc, bcc: request.bcc });
  if (invalid.length) {
    // Reported, never silently dropped. A message that went to four of five intended people, with
    // no indication which one was missed, is the failure users cannot debug.
    return fail(
      `${invalid.length === 1 ? 'This address is not valid' : 'These addresses are not valid'}: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}. Nothing has been sent.`,
      'invalid_recipients',
    );
  }
  if (recipients.length === 0) return fail('At least one recipient is required.', 'no_recipients');
  if (recipients.length > 100) {
    return fail(
      `${recipients.length} recipients on a single message. Use a campaign for bulk sending — it personalises each message, honours per-recipient unsubscribes, and does not put everyone's address in one header.`,
      'too_many_recipients',
    );
  }

  // --- 4. suppression ----------------------------------------------------
  const suppressed: { address: string; reason: string }[] = [];
  let deliverable = recipients;

  const bypassAllowed =
    request.ignoreSuppression === true &&
    !request.campaignId &&
    (!ctx.principal || ctx.principal.permissions.includes('mail.manage'));

  if (request.ignoreSuppression && request.campaignId) {
    return fail('A campaign send may never bypass the suppression list.', 'suppression_bypass_refused');
  }
  if (request.ignoreSuppression && !bypassAllowed) {
    return fail('Bypassing the suppression list requires the mail.manage capability.', 'suppression_bypass_forbidden');
  }

  if (!bypassAllowed) {
    // ═══ THE SUPPRESSION READ NOW FAILS CLOSED, AND THAT MUST NOT BECOME A THROW OUT OF HERE ═══
    //
    // checkSuppressed() used to answer "nobody is suppressed" when it could not read the table,
    // which mailed everyone who had bounced, unsubscribed or reported us for spam. It now raises
    // SuppressionUnavailableError instead, and that is the right direction — but sendMessage()'s
    // contract, relied on by every caller in this package, is that it RETURNS a SendResult and
    // never throws. Every other failure in this function goes through fail().
    //
    // The caller that makes this load-bearing is sendCampaignBatch() in campaigns.ts. It claims a
    // batch durably (pending -> 'queued') and then loops calling sendMessage() with no try/catch
    // around the loop. A throw escaping here would leave the claimed rows stranded in 'queued' —
    // the claim query only ever selects 'pending', and the remaining-count that marks a campaign
    // 'sent' only counts 'pending' — so a batch would be lost AND the campaign could be reported as
    // sent when most of it never left. Failing closed must not cost more than the failure it
    // prevents.
    //
    // Converting the throw to fail() keeps the direction exactly: nothing is stored, nothing is
    // sent, the reason is carried, and the code is one the caller can retry on.
    let checks;
    try {
      checks = await checkSuppressed(orgId, recipients.map((r) => r.email), { campaignId: request.campaignId });
    } catch (e: any) {
      const reason = String(e?.cause?.message || e?.message || 'unknown error');
      console.error('[mailplatform/send] suppression list unreadable, refusing the send:', reason);
      return fail(
        'The suppression list could not be read, so nothing has been sent. This is temporary — retry shortly.',
        'suppression_unavailable',
      );
    }
    deliverable = recipients.filter((r) => {
      const check = checks.get(r.email);
      if (check?.suppressed) {
        suppressed.push({ address: r.email, reason: check.detail || check.reason || 'on the suppression list' });
        return false;
      }
      return true;
    });

    if (deliverable.length === 0) {
      // Not an error the caller did anything wrong about, but not a success either. The message is
      // not written, and the reason names every address.
      return {
        ok: false,
        messageId: null,
        threadId: null,
        rfcMessageId: null,
        accepted: [],
        rejected: [],
        suppressed,
        status: 'suppressed',
        error: 'Every recipient is on the suppression list. Nothing was sent.',
      };
    }
  }

  // --- headers -----------------------------------------------------------
  const { headers: customHeaders, rejected: rejectedHeaders } = sanitizeHeaders(request.headers);
  if (rejectedHeaders.length) {
    return fail(
      `These headers may not be set through the API: ${rejectedHeaders.join(', ')}. They decide sender identity and authentication.`,
      'reserved_headers',
    );
  }
  // Correlation id, so a delivery event arriving from a transport can be matched to this message
  // even when the transport does not echo our Message-ID.
  const platformMessageId = randomUUID();
  const rfcMessageId = makeMessageId(platformMessageId, domainOf(identity.fromAddress) || MAIL_DOMAIN);
  customHeaders['X-EduRankAI-Message-Id'] = platformMessageId;
  if (request.campaignId) customHeaders['X-EduRankAI-Campaign-Id'] = String(request.campaignId);

  // --- 5. persist BEFORE any transport call ------------------------------
  let references: string | null = null;
  if (request.inReplyTo) {
    try {
      const parent = rows(await db.execute(sql`
        SELECT references_header, rfc_message_id FROM mail_messages WHERE rfc_message_id = ${request.inReplyTo} LIMIT 1`));
      references = buildReferences(parent[0]?.references_header, parent[0]?.rfc_message_id || request.inReplyTo);
    } catch (e: any) {
      // Threading is a nicety; losing it must not stop a message. Logged, not swallowed.
      console.error('[mailplatform/send] could not read parent for threading -', causeOf(e));
      references = buildReferences(null, request.inReplyTo);
    }
  }

  const persisted = await p.messages.persist({
    orgId,
    threadId: request.threadId || null,
    direction: 'outbound',
    from: { email: identity.fromAddress, name: request.fromName || identity.fromName },
    fromUserId: ctx.fromUserId || null,
    recipients: deliverable,
    subject,
    bodyHtml,
    bodyText,
    rfcMessageId,
    inReplyTo: request.inReplyTo || null,
    references,
    replyTo: request.replyTo || identity.replyTo,
    attachments: (request.attachments || []).map((a) => ({
      filename: a.filename,
      url: a.url,
      mime: a.mime ?? null,
      sizeBytes: a.size ?? null,
    })),
    sentAt: null,
    isDraft: false,
  });

  if (!persisted.ok || !persisted.data) {
    return fail('The message could not be stored, so it has not been sent: ' + (persisted.error || 'unknown'), 'persist_failed');
  }
  const { messageId, threadId, external, internal } = persisted.data;

  if (request.metadata && Object.keys(request.metadata).length) {
    try {
      await db.execute(sql`UPDATE mail_messages SET metadata = ${JSON.stringify(request.metadata)}::jsonb WHERE id = ${messageId}`);
    } catch (e: any) {
      console.error('[mailplatform/send] metadata not stored for', messageId, '-', causeOf(e));
    }
  }
  if (request.campaignId) {
    try {
      await db.execute(sql`UPDATE mail_messages SET campaign_id = ${request.campaignId} WHERE id = ${messageId}`);
    } catch (e: any) {
      console.error('[mailplatform/send] campaign link not stored for', messageId, '-', causeOf(e));
    }
  }

  const { recordQueued, recordAttempt, recordEvent } = await import('./delivery');
  await recordQueued(orgId, messageId, deliverable.map((r) => r.email));

  // --- scheduled: stop here, the worker sends it -------------------------
  if (request.scheduledAt) {
    const when = new Date(request.scheduledAt);
    if (isNaN(when.getTime())) return fail('scheduledAt is not a valid date.', 'bad_schedule');
    if (when.getTime() > Date.now() + 30_000) {
      await p.queue.enqueue(
        'mp.send_message',
        { messageId, orgId },
        { dedupKey: `mp.send:${messageId}`, delayMs: when.getTime() - Date.now() },
      );
      await p.events.publish({
        orgId,
        eventType: EVENT_TYPES.messageQueued,
        entityType: 'message',
        entityId: messageId,
        actorType: ctx.principal ? (ctx.principal.kind === 'api_key' ? 'api_key' : 'user') : 'system',
        actorId: ctx.principal?.id || null,
        payload: { scheduledAt: when.toISOString(), recipients: deliverable.length },
        occurredAt: new Date().toISOString(),
      });
      return {
        ok: true,
        messageId,
        threadId,
        rfcMessageId,
        accepted: deliverable.map((r) => r.email),
        rejected: [],
        suppressed,
        status: 'queued',
      };
    }
  }

  // --- 6. transport ------------------------------------------------------
  const accepted: string[] = internal.map((r) => r.email);
  const rejected: { address: string; reason: string }[] = [];
  let status: DeliveryState = external.length === 0 ? 'internal' : 'sent';

  if (external.length > 0) {
    const started = Date.now();
    const result = await p.transport.send({
      from: identity.fromAddress,
      fromName: request.fromName || identity.fromName,
      to: external.filter((r) => r.kind === 'to').map((r) => r.email),
      cc: external.filter((r) => r.kind === 'cc').map((r) => r.email),
      bcc: external.filter((r) => r.kind === 'bcc').map((r) => r.email),
      replyTo: request.replyTo || identity.replyTo,
      subject,
      html: bodyHtml,
      text: bodyText,
      headers: customHeaders,
      messageId: rfcMessageId,
      inReplyTo: request.inReplyTo || null,
      references,
      attachments: (request.attachments || []).map((a) => ({ filename: a.filename, url: a.url, contentType: a.mime })),
      platformMessageId: messageId,
    });

    // A transport that hands the whole envelope to one server cannot report per-recipient outcomes,
    // so an all-or-nothing failure is recorded against every external address. That is the truth of
    // what happened, not a convenience.
    for (const address of external.map((r) => r.email)) {
      await recordAttempt({
        orgId,
        messageId,
        recipientAddress: address,
        transport: p.transport.info().kind,
        attemptNo: 1,
        status: result.ok ? 'sent' : result.retryable ? 'deferred' : 'failed',
        smtpCode: result.smtpCode ?? null,
        smtpResponse: result.smtpResponse ?? null,
        remoteMx: result.remoteMx ?? null,
        latencyMs: result.latencyMs ?? Date.now() - started,
        error: result.ok ? null : result.error || 'send failed',
      });
    }

    if (result.ok) {
      accepted.push(...result.accepted);
      await db.execute(sql`UPDATE mail_messages SET sent_at = NOW() WHERE id = ${messageId}`).catch(() => {});
    } else {
      rejected.push(...result.rejected.map((r) => ({ address: r.address, reason: r.reason })));
      status = accepted.length > 0 ? 'partial' : result.retryable ? 'deferred' : 'failed';

      if (result.retryable) {
        // Retryable failures go on the queue rather than being retried inline. An inline retry ties
        // up a serverless invocation and dies with it; a queued one survives the process.
        await p.queue.enqueue(
          'mp.send_message',
          { messageId, orgId, attempt: 2 },
          { dedupKey: `mp.send:${messageId}:2`, delayMs: 60_000 },
        );
        status = 'queued';
      }
    }
  }

  // --- 7. events ---------------------------------------------------------
  await recordEvent({
    orgId,
    messageId,
    recipients: external.map((r) => r.email),
    eventType: status === 'failed' ? 'failed' : status === 'queued' ? 'queued' : 'sent',
  });

  await p.events.publish({
    orgId,
    eventType: status === 'failed' ? EVENT_TYPES.messageFailed : EVENT_TYPES.messageSent,
    entityType: 'message',
    entityId: messageId,
    actorType: ctx.principal ? (ctx.principal.kind === 'api_key' ? 'api_key' : 'user') : 'system',
    actorId: ctx.principal?.id || null,
    payload: {
      subject,
      recipients: deliverable.length,
      external: external.length,
      internal: internal.length,
      suppressed: suppressed.length,
      status,
      campaignId: request.campaignId || null,
      template: request.template || null,
      recipientDomain: domainOf(deliverable[0]?.email || ''),
      metadata: request.metadata || {},
    },
    occurredAt: new Date().toISOString(),
  });

  return {
    ok: rejected.length === 0,
    messageId,
    threadId,
    rfcMessageId,
    accepted,
    rejected,
    suppressed,
    status,
    error: rejected.length ? rejected[0].reason : undefined,
  };
}

/**
 * Re-send a message that is already stored. Used by the queue worker for scheduled and retried mail.
 *
 * Reads the stored message rather than taking a body, so a retry sends exactly what was recorded —
 * not a re-render that could differ because a template changed in between.
 */
export async function sendStoredMessage(messageId: UUID, orgId: UUID): Promise<SendResult> {
  try {
    const r = rows(await db.execute(sql`SELECT * FROM mail_messages WHERE id = ${messageId} LIMIT 1`));
    if (!r.length) return fail('No stored message with that id.', 'not_found');
    const m = r[0];
    if (m.sent_at) {
      // Already sent. Not an error — a duplicate queue entry is expected under at-least-once
      // delivery — but it must not send a second copy.
      return {
        ok: true,
        messageId,
        threadId: m.thread_id,
        rfcMessageId: m.rfc_message_id,
        accepted: [],
        rejected: [],
        suppressed: [],
        status: 'sent',
      };
    }

    const recips = rows(await db.execute(sql`
      SELECT kind, email FROM mail_recipients WHERE message_id = ${messageId} AND user_id IS NULL`));
    if (!recips.length) {
      await db.execute(sql`UPDATE mail_messages SET sent_at = NOW() WHERE id = ${messageId}`);
      return { ok: true, messageId, threadId: m.thread_id, rfcMessageId: m.rfc_message_id, accepted: [], rejected: [], suppressed: [], status: 'internal' };
    }

    const p = providers();
    const started = Date.now();
    const result = await p.transport.send({
      from: m.from_email,
      fromName: m.from_name,
      to: recips.filter((x) => x.kind === 'to').map((x) => x.email),
      cc: recips.filter((x) => x.kind === 'cc').map((x) => x.email),
      bcc: recips.filter((x) => x.kind === 'bcc').map((x) => x.email),
      replyTo: m.reply_to,
      subject: m.subject || '',
      html: m.body_html,
      text: m.body_text,
      headers: { 'X-EduRankAI-Message-Id': messageId },
      messageId: m.rfc_message_id,
      inReplyTo: m.in_reply_to,
      references: m.references_header,
      platformMessageId: messageId,
    });

    const { recordAttempt, recordEvent } = await import('./delivery');
    for (const address of recips.map((x) => x.email)) {
      await recordAttempt({
        orgId,
        messageId,
        recipientAddress: address,
        transport: p.transport.info().kind,
        attemptNo: 2,
        status: result.ok ? 'sent' : result.retryable ? 'deferred' : 'failed',
        smtpCode: result.smtpCode ?? null,
        smtpResponse: result.smtpResponse ?? null,
        latencyMs: result.latencyMs ?? Date.now() - started,
        error: result.ok ? null : result.error || 'send failed',
      });
    }

    if (result.ok) await db.execute(sql`UPDATE mail_messages SET sent_at = NOW() WHERE id = ${messageId}`);
    await recordEvent({
      orgId,
      messageId,
      recipients: recips.map((x) => x.email),
      eventType: result.ok ? 'sent' : 'failed',
    });

    return {
      ok: result.ok,
      messageId,
      threadId: m.thread_id,
      rfcMessageId: m.rfc_message_id,
      accepted: result.accepted,
      rejected: result.rejected.map((x) => ({ address: x.address, reason: x.reason })),
      suppressed: [],
      status: result.ok ? 'sent' : result.retryable ? 'deferred' : 'failed',
      error: result.ok ? undefined : result.error,
    };
  } catch (e: any) {
    return fail(causeOf(e), 'resend_failed');
  }
}
