// src/lib/mailplatform/adapters/message-store-postgres.ts — MessageStore over the EXISTING tables.
//
// This is the single most important "extend, don't replace" decision in the patch, so it is spelled
// out rather than left to be inferred.
//
// mail_messages / mail_recipients / mail_box / mail_attachments already exist in this repository,
// already hold live mail, and are already read by a working webmail client (src/components/
// MailClient.astro at /admin/mail and /portal/employee/mail) and written by /api/mail/send and the
// IMAP poll. Creating a parallel `mp_messages` would have produced two mailboxes: mail sent through
// the new API would be invisible in the client people actually use, and vice versa. That is not a
// migration path, it is a fork.
//
// So: the existing tables ARE the message store. schema.ts adds the RFC and platform columns they
// lacked (org_id, references_header, sent_at, received_at, spam_verdict, raw_object_key, metadata,
// updated_at, deleted_at) with `ADD COLUMN IF NOT EXISTS`, and this adapter reads and writes them
// through the MessageStore interface. Existing code keeps working untouched, because every added
// column is nullable or defaulted.
//
// The one deviation from the brief's table list is message_bodies: bodies stay inline on
// mail_messages. Splitting them would rewrite every existing reader for no measured gain, and the
// RFC-complete original is preserved out of band via raw_object_key. Recorded in /docs/DATABASE.md.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  MailboxStatePatch,
  MessageQuery,
  MessageStore,
  OperationResult,
  PersistMessageInput,
  PersistMessageResult,
  ProviderInfo,
} from '../interfaces';
import type {
  Attachment,
  Folder,
  MailboxMessageState,
  Message,
  Page,
  Recipient,
  Thread,
  UUID,
} from '../types';
import { SYSTEM_FOLDERS } from '../types';
import { makeMessageId, makeSnippet, normalizeEmail, threadKey } from '../rfc';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'edurankai.in';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toMessage(row: any, recipients: Recipient[] = [], attachments: Attachment[] = []): Message {
  return {
    id: row.id,
    orgId: row.org_id ?? null,
    threadId: row.thread_id,
    mailboxId: row.mailbox_id ?? null,
    direction: row.direction || 'internal',
    rfcMessageId: row.rfc_message_id ?? null,
    inReplyTo: row.in_reply_to ?? null,
    references: row.references_header ?? null,
    replyTo: row.reply_to ?? null,
    subject: row.subject || '',
    from: { email: row.from_email, name: row.from_name ?? null },
    recipients,
    bodyHtml: row.body_html ?? null,
    bodyText: row.body_text ?? null,
    snippet: row.snippet || '',
    attachments,
    hasAttachments: !!row.has_attachments,
    rawObjectKey: row.raw_object_key ?? null,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    spamVerdict: row.spam_verdict || 'unknown',
    spamScore: row.spam_score == null ? null : Number(row.spam_score),
    isDraft: !!row.is_draft,
    sentAt: iso(row.sent_at),
    receivedAt: iso(row.received_at),
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}

/** Resolve an address to a local account, if there is one. */
async function resolveLocalUser(email: string): Promise<{ userId: UUID | null; name: string | null }> {
  const addr = normalizeEmail(email);
  if (!addr) return { userId: null, name: null };
  try {
    // mailbox_address is the platform address (set by ensureMailSchema's backfill); `email` is the
    // login address. Both are checked, because an internal recipient may be addressed either way.
    const r = rows(await db.execute(sql`
      SELECT id, name FROM users
      WHERE lower(mailbox_address) = ${addr} OR lower(email) = ${addr}
      ORDER BY (lower(mailbox_address) = ${addr}) DESC
      LIMIT 1`));
    return r.length ? { userId: r[0].id, name: r[0].name ?? null } : { userId: null, name: null };
  } catch (e: any) {
    // Fails OPEN as external. Treating an unresolvable address as external means the message goes
    // out over SMTP rather than vanishing into an internal mailbox that does not exist.
    console.error('[mailplatform/messages] address resolution failed for', addr, '-', causeOf(e));
    return { userId: null, name: null };
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function postgresMessageStore(): MessageStore {
  const store: MessageStore = {
    info(): ProviderInfo {
      return {
        kind: 'postgres-mail',
        enabled: !!process.env.DATABASE_URL,
        detail: 'Messages in mail_messages / mail_recipients / mail_box / mail_attachments, extended for the platform.',
      };
    },

    async persist(input: PersistMessageInput): Promise<OperationResult<PersistMessageResult>> {
      try {
        const { ensureMailSchema } = await import('@/lib/mail');
        await ensureMailSchema();

        const threadId = input.threadId || randomUUID();
        const rfcMessageId = input.rfcMessageId || makeMessageId(randomUUID(), MAIL_DOMAIN);
        const snippet = makeSnippet(input.bodyText, input.bodyHtml);
        const hasAttachments = (input.attachments || []).length > 0;

        const ins = rows(await db.execute(sql`
          INSERT INTO mail_messages
            (thread_id, subject, from_user_id, from_email, from_name, body_html, body_text, snippet,
             direction, has_attachments, rfc_message_id, in_reply_to, is_draft,
             org_id, mailbox_id, references_header, reply_to, sent_at, received_at,
             spam_score, spam_verdict, raw_object_key, size_bytes)
          VALUES
            (${threadId}, ${input.subject || ''}, ${input.fromUserId || null}, ${normalizeEmail(input.from.email)},
             ${input.from.name || null}, ${input.bodyHtml}, ${input.bodyText}, ${snippet},
             ${input.direction}, ${hasAttachments}, ${rfcMessageId}, ${input.inReplyTo || null}, ${!!input.isDraft},
             ${input.orgId}, ${input.mailboxId || null}, ${input.references || null}, ${input.replyTo || null},
             ${input.sentAt ? new Date(input.sentAt) : null}, ${input.receivedAt ? new Date(input.receivedAt) : null},
             ${input.spamScore ?? null}, ${input.spamVerdict || 'unknown'},
             ${input.rawObjectKey || null}, ${input.sizeBytes ?? null})
          RETURNING id`));

        const messageId = ins[0]?.id as UUID;
        if (!messageId) return { ok: false, error: 'The message row was not written.', code: 'insert_failed' };

        // --- thread aggregate ---
        await db.execute(sql`
          INSERT INTO mp_threads (id, org_id, mailbox_id, subject_normalized, last_message_at, message_count)
          VALUES (${threadId}, ${input.orgId}, ${input.mailboxId || null}, ${threadKey(input.subject)}, NOW(), 1)
          ON CONFLICT (id) DO UPDATE
            SET last_message_at = NOW(),
                message_count = mp_threads.message_count + 1,
                updated_at = NOW()`);

        // --- headers (inbound RFC capture) ---
        if (input.headers?.length) {
          const values = input.headers
            .slice(0, 200) // a message with 200+ headers is a loop or an attack, not correspondence
            .map((h) => sql`(${messageId}, ${String(h.name).slice(0, 120)}, ${String(h.value).slice(0, 8000)}, ${h.ordinal})`);
          await db.execute(sql`
            INSERT INTO mp_message_headers (message_id, name, value, ordinal)
            VALUES ${sql.join(values, sql`, `)}`);
        }

        // --- attachments ---
        for (const a of input.attachments || []) {
          await db.execute(sql`
            INSERT INTO mail_attachments (message_id, filename, url, mime, size_bytes, storage_key, storage_backend, content_id, is_inline)
            VALUES (${messageId}, ${a.filename || 'attachment'}, ${a.url}, ${a.mime || null}, ${a.sizeBytes ?? null},
                    ${a.storageKey || null}, ${a.storageBackend || null}, ${a.contentId || null}, ${!!a.isInline})`);
        }

        // --- recipients, split internal vs external ---
        const internal: Recipient[] = [];
        const external: Recipient[] = [];
        const mailboxCopies = new Map<string, Recipient>();

        for (const r of input.recipients) {
          const resolved = await resolveLocalUser(r.email);
          await db.execute(sql`
            INSERT INTO mail_recipients (message_id, kind, user_id, email, name)
            VALUES (${messageId}, ${r.kind}, ${resolved.userId}, ${normalizeEmail(r.email)}, ${r.name || resolved.name || null})`);
          if (resolved.userId) {
            const withUser = { ...r, userId: resolved.userId };
            internal.push(withUser);
            if (!mailboxCopies.has(resolved.userId)) mailboxCopies.set(resolved.userId, withUser);
          } else {
            external.push(r);
          }
        }

        // --- sender's copy ---
        if (input.fromUserId) {
          await db.execute(sql`
            INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read, org_id, mailbox_id)
            VALUES (${input.fromUserId}, ${messageId}, ${threadId}, ${input.isDraft ? 'drafts' : 'sent'}, true,
                    ${input.orgId}, ${input.mailboxId || null})
            ON CONFLICT (user_id, message_id) DO UPDATE SET folder = EXCLUDED.folder`);
        }

        // --- recipient copies (never for a draft: a draft is not delivered to anyone) ---
        if (!input.isDraft) {
          for (const [userId] of mailboxCopies) {
            if (userId === input.fromUserId) continue; // keep their Sent copy, don't overwrite it
            await db.execute(sql`
              INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read, org_id, mailbox_id)
              VALUES (${userId}, ${messageId}, ${threadId}, 'inbox', false, ${input.orgId}, ${input.mailboxId || null})
              ON CONFLICT (user_id, message_id) DO NOTHING`);
          }
        }

        return { ok: true, data: { messageId, threadId, rfcMessageId, external, internal } };
      } catch (e: any) {
        const error = causeOf(e);
        console.error('[mailplatform/messages] persist failed -', error);
        return { ok: false, error, code: 'persist_failed' };
      }
    },

    async get(messageId: UUID, viewer): Promise<Message | null> {
      if (!messageId) return null;
      try {
        // The viewer clause is the access control. A message is readable when the viewer holds a
        // mailbox copy of it, or when an org-scoped caller and the message share an organization.
        // Without one of those, a valid uuid from any signed-in account would read anyone's mail.
        const conditions = [sql`m.id = ${messageId}`, sql`m.deleted_at IS NULL`];
        if (viewer.userId) {
          conditions.push(sql`EXISTS (SELECT 1 FROM mail_box b WHERE b.message_id = m.id AND b.user_id = ${viewer.userId})`);
        } else if (viewer.orgId) {
          conditions.push(sql`m.org_id = ${viewer.orgId}`);
        } else {
          return null; // no viewer, no read. Never a bare id lookup.
        }

        const r = rows(await db.execute(sql`
          SELECT m.* FROM mail_messages m WHERE ${sql.join(conditions, sql` AND `)} LIMIT 1`));
        if (!r.length) return null;

        const recips = rows(await db.execute(sql`
          SELECT kind, user_id, email, name FROM mail_recipients WHERE message_id = ${messageId}`));
        const atts = rows(await db.execute(sql`
          SELECT id, message_id, filename, url, mime, size_bytes, storage_key, storage_backend, content_id, is_inline
          FROM mail_attachments WHERE message_id = ${messageId}`));

        return toMessage(
          r[0],
          recips.map((x) => ({ email: x.email, name: x.name, kind: x.kind, userId: x.user_id })),
          atts.map((a) => ({
            id: a.id,
            messageId: a.message_id,
            filename: a.filename,
            url: a.url,
            mime: a.mime,
            sizeBytes: a.size_bytes == null ? null : Number(a.size_bytes),
            storageKey: a.storage_key,
            storageBackend: a.storage_backend,
            contentId: a.content_id,
            isInline: !!a.is_inline,
          })),
        );
      } catch (e: any) {
        console.error('[mailplatform/messages] get failed -', causeOf(e));
        return null;
      }
    },

    async list(query: MessageQuery): Promise<Page<Message>> {
      const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
      try {
        const conditions = [sql`m.deleted_at IS NULL`];
        let joinBox = false;

        if (query.userId) {
          joinBox = true;
          conditions.push(sql`b.user_id = ${query.userId}`);
          if (query.folder) conditions.push(sql`b.folder = ${query.folder}`);
          if (typeof query.isRead === 'boolean') conditions.push(sql`b.is_read = ${query.isRead}`);
          if (typeof query.isStarred === 'boolean') conditions.push(sql`b.is_starred = ${query.isStarred}`);
          if (query.labels?.length) conditions.push(sql`b.labels && ${query.labels}`);
        } else if (query.orgId) {
          conditions.push(sql`m.org_id = ${query.orgId}`);
        } else {
          return { items: [], hasMore: false, nextCursor: null };
        }

        if (query.threadId) conditions.push(sql`m.thread_id = ${query.threadId}`);
        if (typeof query.isDraft === 'boolean') conditions.push(sql`m.is_draft = ${query.isDraft}`);
        if (query.direction) conditions.push(sql`m.direction = ${query.direction}`);
        if (query.from) conditions.push(sql`lower(m.from_email) = ${normalizeEmail(query.from)}`);
        if (query.hasAttachments === true) conditions.push(sql`m.has_attachments = true`);
        if (query.before) conditions.push(sql`m.created_at < ${new Date(query.before)}`);
        if (query.after) conditions.push(sql`m.created_at > ${new Date(query.after)}`);
        if (query.to) {
          conditions.push(sql`EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND lower(r.email) = ${normalizeEmail(query.to)})`);
        }
        if (query.search) {
          const term = `%${String(query.search).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
          conditions.push(sql`(m.subject ILIKE ${term} OR m.snippet ILIKE ${term} OR m.body_text ILIKE ${term})`);
        }
        // Keyset pagination on created_at, not OFFSET. An OFFSET of 10,000 reads and discards
        // 10,000 rows on every page; on a mailbox with millions of messages that is the whole cost.
        if (query.cursor) conditions.push(sql`m.created_at < ${new Date(query.cursor)}`);

        const r = rows(await db.execute(sql`
          SELECT m.*
          FROM mail_messages m
          ${joinBox ? sql`JOIN mail_box b ON b.message_id = m.id` : sql``}
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY m.created_at DESC
          LIMIT ${limit + 1}`));

        const hasMore = r.length > limit;
        const page = r.slice(0, limit);
        return {
          items: page.map((row) => toMessage(row)),
          hasMore,
          nextCursor: hasMore ? iso(page[page.length - 1].created_at) : null,
        };
      } catch (e: any) {
        console.error('[mailplatform/messages] list failed -', causeOf(e));
        return { items: [], hasMore: false, nextCursor: null };
      }
    },

    async listThreads(query: MessageQuery): Promise<Page<Thread & { lastMessage?: Message }>> {
      const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
      try {
        const conditions = [sql`m.deleted_at IS NULL`];
        let joinBox = false;
        if (query.userId) {
          joinBox = true;
          conditions.push(sql`b.user_id = ${query.userId}`);
          if (query.folder) conditions.push(sql`b.folder = ${query.folder}`);
        } else if (query.orgId) {
          conditions.push(sql`m.org_id = ${query.orgId}`);
        } else {
          return { items: [], hasMore: false, nextCursor: null };
        }
        if (query.cursor) conditions.push(sql`m.created_at < ${new Date(query.cursor)}`);

        // DISTINCT ON gives the newest message per thread in one pass. The ORDER BY must lead with
        // the DISTINCT ON expression — Postgres requires it, and getting it wrong returns an
        // arbitrary message per thread rather than the latest.
        const r = rows(await db.execute(sql`
          SELECT DISTINCT ON (m.thread_id) m.*,
                 (SELECT COUNT(*)::int FROM mail_messages mm WHERE mm.thread_id = m.thread_id AND mm.deleted_at IS NULL) AS thread_count
          FROM mail_messages m
          ${joinBox ? sql`JOIN mail_box b ON b.message_id = m.id` : sql``}
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY m.thread_id, m.created_at DESC
          LIMIT ${limit + 1}`));

        const hasMore = r.length > limit;
        const page = r.slice(0, limit);
        const items = page.map((row) => ({
          id: row.thread_id,
          orgId: row.org_id ?? null,
          mailboxId: row.mailbox_id ?? null,
          subjectNormalized: threadKey(row.subject),
          lastMessageAt: iso(row.created_at),
          messageCount: Number(row.thread_count) || 1,
          createdAt: iso(row.created_at) || '',
          updatedAt: iso(row.updated_at) || iso(row.created_at) || '',
          deletedAt: null,
          lastMessage: toMessage(row),
        })) as (Thread & { lastMessage?: Message })[];

        return { items, hasMore, nextCursor: hasMore ? iso(page[page.length - 1].created_at) : null };
      } catch (e: any) {
        console.error('[mailplatform/messages] listThreads failed -', causeOf(e));
        return { items: [], hasMore: false, nextCursor: null };
      }
    },

    async getThread(threadId: UUID, viewer): Promise<Message[]> {
      if (!threadId) return [];
      try {
        const conditions = [sql`m.thread_id = ${threadId}`, sql`m.deleted_at IS NULL`];
        if (viewer.userId) {
          conditions.push(sql`EXISTS (SELECT 1 FROM mail_box b WHERE b.message_id = m.id AND b.user_id = ${viewer.userId})`);
        } else if (viewer.orgId) {
          conditions.push(sql`m.org_id = ${viewer.orgId}`);
        } else {
          return [];
        }
        const r = rows(await db.execute(sql`
          SELECT m.* FROM mail_messages m
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY m.created_at ASC LIMIT 500`));
        if (!r.length) return [];

        // One query for every recipient in the thread, not one per message. A 40-message thread
        // otherwise costs 40 round trips to render.
        const ids = r.map((x) => x.id);
        const recips = rows(await db.execute(sql`
          SELECT message_id, kind, user_id, email, name FROM mail_recipients WHERE message_id = ANY(${ids})`));
        const byMessage = new Map<string, Recipient[]>();
        for (const x of recips) {
          const list = byMessage.get(x.message_id) || [];
          list.push({ email: x.email, name: x.name, kind: x.kind, userId: x.user_id });
          byMessage.set(x.message_id, list);
        }
        return r.map((row) => toMessage(row, byMessage.get(row.id) || []));
      } catch (e: any) {
        console.error('[mailplatform/messages] getThread failed -', causeOf(e));
        return [];
      }
    },

    async patchState(messageId, viewer, patch: MailboxStatePatch): Promise<OperationResult<MailboxMessageState>> {
      if (!messageId || !viewer?.userId) return { ok: false, error: 'A message and a viewer are required.', code: 'bad_request' };
      try {
        const sets: any[] = [];
        if (patch.folder) {
          const folder = String(patch.folder).toLowerCase();
          const known = (SYSTEM_FOLDERS as readonly string[]).includes(folder);
          if (!known) {
            const custom = rows(await db.execute(sql`
              SELECT 1 FROM mp_folders f
              JOIN mp_mailboxes mb ON mb.id = f.mailbox_id
              WHERE lower(f.key) = ${folder} AND mb.owner_user_id = ${viewer.userId} AND f.deleted_at IS NULL LIMIT 1`));
            if (!custom.length) {
              return { ok: false, error: `There is no folder called "${patch.folder}".`, code: 'unknown_folder' };
            }
          }
          sets.push(sql`folder = ${folder}`);
        }
        if (typeof patch.isRead === 'boolean') sets.push(sql`is_read = ${patch.isRead}`);
        if (typeof patch.isStarred === 'boolean') sets.push(sql`is_starred = ${patch.isStarred}`);
        if (typeof patch.isImportant === 'boolean') sets.push(sql`is_important = ${patch.isImportant}`);
        if (patch.snoozedUntil !== undefined) {
          sets.push(sql`snoozed_until = ${patch.snoozedUntil ? new Date(patch.snoozedUntil) : null}`);
        }
        if (patch.addLabels?.length) {
          // array_cat + a dedup pass, so applying the same label twice does not grow the array.
          sets.push(sql`labels = ARRAY(SELECT DISTINCT unnest(array_cat(labels, ${patch.addLabels})))`);
        }
        if (patch.removeLabels?.length) {
          sets.push(sql`labels = ARRAY(SELECT unnest(labels) EXCEPT SELECT unnest(${patch.removeLabels}))`);
        }
        if (!sets.length) return { ok: false, error: 'Nothing to change.', code: 'empty_patch' };
        sets.push(sql`updated_at = NOW()`);

        // user_id in the WHERE is the access control AND the reason a "changed nothing" result is
        // reported honestly: a message the viewer holds no copy of updates zero rows.
        const r = rows(await db.execute(sql`
          UPDATE mail_box SET ${sql.join(sets, sql`, `)}
          WHERE message_id = ${messageId} AND user_id = ${viewer.userId}
          RETURNING user_id, message_id, thread_id, folder, is_read, is_starred, is_important, labels, snoozed_until, mailbox_id`));

        if (!r.length) {
          return { ok: false, error: 'No message in your mailbox with that id.', code: 'not_found' };
        }
        const row = r[0];
        return {
          ok: true,
          data: {
            mailboxId: row.mailbox_id ?? null,
            userId: row.user_id,
            messageId: row.message_id,
            threadId: row.thread_id,
            folder: row.folder,
            isRead: !!row.is_read,
            isStarred: !!row.is_starred,
            isImportant: !!row.is_important,
            labels: row.labels || [],
            snoozedUntil: iso(row.snoozed_until),
          },
        };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'patch_failed' };
      }
    },

    async remove(messageId, viewer, opts = {}): Promise<OperationResult> {
      if (!messageId || !viewer?.userId) return { ok: false, error: 'A message and a viewer are required.', code: 'bad_request' };
      try {
        if (!opts.hard) {
          // Soft delete is a folder move. The row survives, so an accidental delete is one click to
          // undo and a legal hold still finds the message.
          const r = rows(await db.execute(sql`
            UPDATE mail_box SET folder = 'trash', updated_at = NOW()
            WHERE message_id = ${messageId} AND user_id = ${viewer.userId} AND folder <> 'trash'
            RETURNING message_id`));
          return r.length
            ? { ok: true }
            : { ok: false, error: 'That message is not in your mailbox, or is already in Trash.', code: 'not_found' };
        }

        // Hard delete removes THIS VIEWER'S copy. The message body is shared by every recipient's
        // copy, so deleting it would erase the message from other people's mailboxes too. The body
        // is removed only when the last copy goes.
        const r = rows(await db.execute(sql`
          DELETE FROM mail_box WHERE message_id = ${messageId} AND user_id = ${viewer.userId} RETURNING message_id`));
        if (!r.length) return { ok: false, error: 'That message is not in your mailbox.', code: 'not_found' };

        const remaining = rows(await db.execute(sql`
          SELECT 1 FROM mail_box WHERE message_id = ${messageId} LIMIT 1`));
        if (!remaining.length) {
          await db.execute(sql`UPDATE mail_messages SET deleted_at = NOW() WHERE id = ${messageId}`);
        }
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'delete_failed' };
      }
    },

    async folders(target): Promise<Folder[]> {
      const systemFolders: Folder[] = SYSTEM_FOLDERS.map((key, i) => ({
        id: `system:${key}`,
        orgId: '',
        mailboxId: target.mailboxId || '',
        key,
        name: key.charAt(0).toUpperCase() + key.slice(1),
        kind: 'system',
        parentId: null,
        sortOrder: i,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
      }));
      if (!target.mailboxId) return systemFolders;
      try {
        const r = rows(await db.execute(sql`
          SELECT * FROM mp_folders WHERE mailbox_id = ${target.mailboxId} AND deleted_at IS NULL ORDER BY sort_order, name`));
        return [
          ...systemFolders,
          ...r.map((row) => ({
            id: row.id,
            orgId: row.org_id,
            mailboxId: row.mailbox_id,
            key: row.key,
            name: row.name,
            kind: row.kind,
            parentId: row.parent_id ?? null,
            sortOrder: row.sort_order,
            createdAt: iso(row.created_at) || '',
            updatedAt: iso(row.updated_at) || '',
            deletedAt: null,
          })),
        ];
      } catch (e: any) {
        console.error('[mailplatform/messages] folders failed -', causeOf(e));
        return systemFolders;
      }
    },

    async counts(viewer): Promise<Record<string, number>> {
      const empty: Record<string, number> = {};
      for (const f of SYSTEM_FOLDERS) empty[f] = 0;
      empty.unread = 0;
      if (!viewer?.userId) return empty;
      try {
        const r = rows(await db.execute(sql`
          SELECT folder, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_read = false)::int AS unread
          FROM mail_box WHERE user_id = ${viewer.userId} GROUP BY folder`));
        const out = { ...empty };
        for (const row of r) {
          out[row.folder] = Number(row.total) || 0;
          if (row.folder === 'inbox') out.unread = Number(row.unread) || 0;
        }
        return out;
      } catch (e: any) {
        console.error('[mailplatform/messages] counts failed -', causeOf(e));
        return empty;
      }
    },
  };

  return store;
}
