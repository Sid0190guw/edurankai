// src/lib/mailplatform/mailapi-bridge.ts — one mailbox, not three.
//
// WHY THIS FILE EXISTS. Four agents built this repository in one session, and two message stores
// appeared alongside the live one:
//
//   mail_messages     the live webmail store, read by MailClient.astro at /admin/mail and
//                     /portal/employee/mail, written by /api/mail/send and the IMAP poll
//   mailapi_messages  the developer API's own store (src/lib/mailapi/), separate from it
//   mp_*              this patch's platform tables, which EXTEND mail_messages rather than replace it
//
// Mail sent through one was invisible in the others. That is a fork, not a migration path, and it
// gets more expensive to undo with every message written. The user chose to unify on the live store.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT. `mailapi_messages` is retired as the MESSAGE
// STORE and kept as the SEND-JOB record. Those are two different things that happened to live in one
// table:
//
//   the message   who it is from and to, the subject, the bodies, the thread   -> mail_messages
//   the send job  environment, idempotency key, attempts, next_attempt_at,     -> mailapi_messages
//                 claimed_at, retry backoff, tags
//
// Retirement does not mean deleting the developer API's machinery. Its rate limiting, idempotency,
// scoped keys, live/test environments and error envelope are good, this patch does not duplicate any
// of them, and none of them are storage concerns. What moves is the message itself: after this, a
// message sent through /api/v1/* is a row in mail_messages and shows up in the webmail client, and
// `mailapi_messages.platform_message_id` points at it.
//
// The change required in the developer API's own file is three lines. Everything else is here, in a
// file this patch owns, because a shared file gets the smallest compatible change and no more.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { providers } from './providers';
import { ensureMailPlatformSchema } from './schema';
import { DEFAULT_ORG_SLUG, ensureDefaultOrg } from './orgs';
import { buildRecipients, makeMessageId, normalizeEmail } from './rfc';
import type { UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

// ---------------------------------------------------------------------------
// Organization mapping
// ---------------------------------------------------------------------------

// mailapi_orgs and mp_organizations are two tables describing the same tenants. They are matched by
// SLUG, which is the only value both sides agree on and a human recognises. Cached per process
// because it is resolved on every send; a failed lookup is never cached.
const orgCache = new Map<string, string>();

/**
 * The `mp_organizations.id` for a `mailapi_orgs.id`.
 *
 * Creates the platform organization if the developer API knows a tenant the platform does not — that
 * is the expected state on the first send after this bridge lands, not an error. Returns null only
 * when the database could not answer, and the caller then skips mirroring rather than failing the
 * send: a developer-API send must not start failing because a bridge could not resolve a tenant.
 */
export async function resolvePlatformOrg(mailapiOrgId: string): Promise<UUID | null> {
  if (!mailapiOrgId) return null;
  const cached = orgCache.get(mailapiOrgId);
  if (cached) return cached;

  try {
    const schema = await ensureMailPlatformSchema();
    if (!schema.ok) return null;

    const source = rows(await db.execute(sql`
      SELECT slug, name, mp_org_id FROM mailapi_orgs WHERE id = ${mailapiOrgId} LIMIT 1`));

    // The developer API already links its organizations to this platform's, by slug, in
    // src/lib/mailapi/bridge.ts (linkMailplatformOrg) — and stores the result on mailapi_orgs.mp_org_id.
    // That link is used when it exists rather than a second one being resolved here. Two independent
    // mappings between the same two tables is how they eventually disagree, and then one console
    // shows a tenant the other cannot find.
    const linked = source[0]?.mp_org_id;
    if (linked) {
      orgCache.set(mailapiOrgId, linked);
      return linked;
    }

    // No mailapi_orgs row (or no such table on this deployment): fall back to the default tenant so
    // the message still lands somewhere a human can find it.
    const slug = String(source[0]?.slug || DEFAULT_ORG_SLUG).toLowerCase();
    const name = String(source[0]?.name || 'EduRankAI');

    const existing = rows(await db.execute(sql`
      SELECT id FROM mp_organizations WHERE lower(slug) = ${slug} AND deleted_at IS NULL LIMIT 1`));
    if (existing.length) {
      orgCache.set(mailapiOrgId, existing[0].id);
      return existing[0].id;
    }

    const created = rows(await db.execute(sql`
      INSERT INTO mp_organizations (slug, name, status)
      VALUES (${slug}, ${name.slice(0, 200)}, 'active')
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (created.length) {
      orgCache.set(mailapiOrgId, created[0].id);
      return created[0].id;
    }

    const raced = rows(await db.execute(sql`
      SELECT id FROM mp_organizations WHERE lower(slug) = ${slug} AND deleted_at IS NULL LIMIT 1`));
    if (raced.length) {
      orgCache.set(mailapiOrgId, raced[0].id);
      return raced[0].id;
    }

    const fallback = await ensureDefaultOrg();
    return fallback?.id ?? null;
  } catch (e: any) {
    console.error('[mailapi-bridge] could not resolve the platform organization -', causeOf(e));
    return null;
  }
}

/** Forget the cache. Tests, and anything that renames an organization slug. */
export function resetOrgCache(): void {
  orgCache.clear();
}

// ---------------------------------------------------------------------------
// Mirroring a developer-API send into the shared store
// ---------------------------------------------------------------------------

export interface BridgeInput {
  /** mailapi_messages.id — the send job this message belongs to. */
  sendJobId: string;
  /** mailapi_orgs.id. */
  orgId: string;
  environment: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  templateKey?: string | null;
  templateVersion?: number | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  attachments?: { filename?: string; url?: string; mime?: string; size?: number }[];
  scheduledAt?: Date | null;
}

export interface BridgeResult {
  ok: boolean;
  platformMessageId: UUID | null;
  threadId: UUID | null;
  rfcMessageId: string | null;
  error?: string;
}

/**
 * Write a developer-API send into the shared message store.
 *
 * NEVER THROWS, AND NEVER BLOCKS THE SEND. If mirroring fails, the developer API's own send proceeds
 * and the failure is logged at error level. The alternative — a bridge that can fail a send — would
 * mean this unification made the API less reliable than the fork it replaced, which is not a trade
 * anyone agreed to. A message that mirrors late is recoverable; a send that did not happen is not.
 *
 * It does NOT call sendMessage(). The developer API has already resolved its own identity, checked
 * its own suppression list and will hand the message to the transport itself; running the platform
 * send pipeline here would deliver the message twice. This persists the RECORD only — which is
 * exactly what "one mailbox" requires and nothing more.
 */
export async function mirrorToPlatformStore(input: BridgeInput): Promise<BridgeResult> {
  const empty: BridgeResult = { ok: false, platformMessageId: null, threadId: null, rfcMessageId: null };
  try {
    const orgId = await resolvePlatformOrg(input.orgId);
    if (!orgId) return { ...empty, error: 'no platform organization could be resolved' };

    const { recipients, invalid } = buildRecipients({ to: input.to, cc: input.cc, bcc: input.bcc });
    if (recipients.length === 0) {
      return { ...empty, error: invalid.length ? `no valid recipients (${invalid.slice(0, 3).join(', ')})` : 'no recipients' };
    }

    const from = normalizeEmail(input.from);
    const rfcMessageId = makeMessageId(input.sendJobId, from.split('@')[1] || (process.env.MAIL_DOMAIN || 'edurankai.in'));

    const persisted = await providers().messages.persist({
      orgId,
      direction: 'outbound',
      from: { email: from, name: input.fromName ?? null },
      // No fromUserId: a developer-API send is made by an integration, not by a person, so nobody's
      // Sent folder should claim it. Internal recipients still get their inbox copy.
      fromUserId: null,
      recipients,
      subject: input.subject || '',
      bodyHtml: input.html || null,
      bodyText: input.text || null,
      rfcMessageId,
      replyTo: input.replyTo ?? null,
      attachments: (input.attachments || []).map((a) => ({
        filename: a.filename || 'attachment',
        url: a.url || '',
        mime: a.mime ?? null,
        sizeBytes: a.size ?? null,
      })),
      // A scheduled send has not been sent yet, and sent_at must say so. It is stamped by the
      // dispatcher when the message actually leaves.
      sentAt: null,
      isDraft: false,
    });

    if (!persisted.ok || !persisted.data) {
      return { ...empty, error: persisted.error || 'the shared store refused the message' };
    }

    const { messageId, threadId } = persisted.data;

    // The correlation the whole bridge exists for, written on both sides.
    await db.execute(sql`
      UPDATE mail_messages
      SET metadata = ${JSON.stringify({
        ...(input.metadata || {}),
        mailapiSendJobId: input.sendJobId,
        environment: input.environment,
        templateKey: input.templateKey ?? null,
        templateVersion: input.templateVersion ?? null,
        tags: input.tags || [],
      })}::jsonb
      WHERE id = ${messageId}`);

    await db.execute(sql`
      UPDATE mailapi_messages SET platform_message_id = ${messageId} WHERE id = ${input.sendJobId}`);

    return { ok: true, platformMessageId: messageId, threadId, rfcMessageId };
  } catch (e: any) {
    const error = causeOf(e);
    console.error('[mailapi-bridge] mirror failed for send job', input.sendJobId, '-', error);
    return { ...empty, error };
  }
}

/**
 * Read a message body from the shared store.
 *
 * Falls back to the developer API's own columns for rows written before this bridge landed. Those
 * rows are real mail somebody sent; a lookup that returns null for them because they predate a
 * refactor would make the message history look like it starts today.
 */
export async function readSharedBody(sendJobId: string): Promise<{ html: string; text: string } | null> {
  try {
    const r = rows(await db.execute(sql`
      SELECT m.body_html, m.body_text
      FROM mailapi_messages j
      JOIN mail_messages m ON m.id = j.platform_message_id
      WHERE j.id = ${sendJobId} LIMIT 1`));
    if (r.length) return { html: r[0].body_html || '', text: r[0].body_text || '' };
    return null;
  } catch (e: any) {
    console.error('[mailapi-bridge] shared body read failed for', sendJobId, '-', causeOf(e));
    return null;
  }
}

/**
 * Mirror a delivery outcome from the developer API onto the platform's delivery tables.
 *
 * Called by the dispatcher when it learns what happened. Without it the webmail client would show
 * the message with no delivery state at all, which reads as "we have no idea what happened to this"
 * — and would be true.
 */
export async function mirrorDeliveryOutcome(input: {
  sendJobId: string;
  recipients: string[];
  status: 'sent' | 'deferred' | 'failed' | 'delivered' | 'bounced';
  smtpCode?: number | null;
  error?: string | null;
  attemptNo?: number;
}): Promise<void> {
  try {
    const link = rows(await db.execute(sql`
      SELECT j.platform_message_id, m.org_id
      FROM mailapi_messages j
      LEFT JOIN mail_messages m ON m.id = j.platform_message_id
      WHERE j.id = ${input.sendJobId} LIMIT 1`));
    const messageId = link[0]?.platform_message_id;
    const orgId = link[0]?.org_id;
    if (!messageId || !orgId) return; // not mirrored (pre-bridge row): nothing to attach to

    const { recordAttempt, recordDelivered, recordBounce, recordEvent } = await import('./delivery');

    if (input.status === 'delivered') {
      for (const address of input.recipients) await recordDelivered(orgId, messageId, address);
      return;
    }
    if (input.status === 'bounced') {
      for (const address of input.recipients) {
        await recordBounce({
          orgId,
          messageId,
          recipientAddress: address,
          smtpCode: input.smtpCode ?? null,
          diagnosticCode: input.error ?? null,
          reportedBy: 'mailapi-dispatcher',
        });
      }
      return;
    }

    for (const address of input.recipients) {
      await recordAttempt({
        orgId,
        messageId,
        recipientAddress: address,
        transport: 'mailapi',
        attemptNo: input.attemptNo ?? 1,
        status: input.status,
        smtpCode: input.smtpCode ?? null,
        error: input.error ?? null,
      });
    }
    await recordEvent({
      orgId,
      messageId,
      recipients: input.recipients,
      eventType: input.status === 'sent' ? 'sent' : input.status === 'deferred' ? 'deferred' : 'failed',
    });

    if (input.status === 'sent') {
      await db.execute(sql`UPDATE mail_messages SET sent_at = COALESCE(sent_at, NOW()) WHERE id = ${messageId}`);
    }
  } catch (e: any) {
    console.error('[mailapi-bridge] delivery mirror failed for', input.sendJobId, '-', causeOf(e));
  }
}

/**
 * How much of the developer API's history has been unified. For an ops screen and for the report
 * that says whether the fork is actually closed.
 */
export async function bridgeStatus(): Promise<{
  available: boolean;
  totalSendJobs: number;
  mirrored: number;
  unmirrored: number;
  detail: string;
}> {
  try {
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(platform_message_id)::int AS mirrored
      FROM mailapi_messages`));
    const total = Number(r[0]?.total) || 0;
    const mirrored = Number(r[0]?.mirrored) || 0;
    return {
      available: true,
      totalSendJobs: total,
      mirrored,
      unmirrored: total - mirrored,
      detail:
        total === 0
          ? 'No developer-API sends yet. Every future send will be written to the shared store.'
          : mirrored === total
            ? `All ${total} developer-API sends are in the shared store.`
            : `${mirrored} of ${total} developer-API sends are in the shared store. The remaining ${total - mirrored} predate the bridge and are readable through the developer API only.`,
    };
  } catch (e: any) {
    return {
      available: false,
      totalSendJobs: 0,
      mirrored: 0,
      unmirrored: 0,
      detail: 'Could not read the developer API tables: ' + causeOf(e),
    };
  }
}
