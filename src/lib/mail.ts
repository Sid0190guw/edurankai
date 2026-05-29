// src/lib/mail.ts - unified mail engine (internal delivery + envelope + threading)
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

export const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'edurankai.in';

export type Folder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam';
export type RecipientKind = 'to' | 'cc' | 'bcc';

export interface AddressInput { email: string; name?: string; kind?: RecipientKind; }
export interface ResolvedUser { userId: string | null; email: string; name: string | null; }

function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) ? r : (r?.rows || [])) as T[];
}

export function normalizeEmail(e: string): string {
  return String(e || '').trim().toLowerCase();
}

// Split a comma/semicolon/newline separated address list into emails (strips display names)
export function parseAddressList(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(',') : input;
  const out: string[] = [];
  for (let part of raw.split(/[,;\n]+/)) {
    part = part.trim();
    if (!part) continue;
    const m = part.match(/<([^>]+)>/);
    const email = normalizeEmail(m ? m[1] : part);
    if (email && /.+@.+\..+/.test(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

export function isInternalAddress(email: string): boolean {
  return normalizeEmail(email).endsWith('@' + MAIL_DOMAIN);
}

export function makeSnippet(text: string | null | undefined, html?: string | null): string {
  let s = (text || '').trim();
  if (!s && html) s = String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 300);
}

// Resolve a single email to a platform user (by mailbox address or login email)
export async function resolveAddress(email: string): Promise<ResolvedUser> {
  const e = normalizeEmail(email);
  const r = await db.execute(sql`
    SELECT id, name, email, mailbox_address FROM users
    WHERE lower(mailbox_address) = ${e} OR lower(email) = ${e}
    LIMIT 1
  `);
  const u = rows(r)[0];
  if (u) return { userId: u.id, email: u.mailbox_address || u.email, name: u.name };
  return { userId: null, email: e, name: null };
}

export async function getMailboxAddress(userId: string): Promise<string> {
  const r = await db.execute(sql`SELECT mailbox_address, email FROM users WHERE id = ${userId} LIMIT 1`);
  const u = rows(r)[0];
  return u?.mailbox_address || u?.email || '';
}

export interface DeliverInput {
  fromUserId: string;
  fromEmail: string;
  fromName: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  attachments?: { filename: string; url: string; mime?: string; size?: number }[];
  asDraft?: boolean;
}

export interface DeliverResult {
  messageId: string;
  threadId: string;
  rfcMessageId: string;
  external: { email: string; kind: RecipientKind }[];
}

// Persist a message + create mailbox copies for sender and internal recipients.
// Returns the list of EXTERNAL recipients so the caller can hand off to SMTP/Resend.
export async function deliverMessage(opts: DeliverInput): Promise<DeliverResult> {
  const threadId = opts.threadId || randomUUID();
  const rfcMessageId = `<${randomUUID()}@${MAIL_DOMAIN}>`;
  const atts = opts.attachments || [];
  const hasAtt = atts.length > 0;
  const snippet = makeSnippet(opts.bodyText, opts.bodyHtml);
  const direction = 'internal';

  const ins = await db.execute(sql`
    INSERT INTO mail_messages
      (thread_id, subject, from_user_id, from_email, from_name, body_html, body_text, snippet, direction, has_attachments, rfc_message_id, in_reply_to, is_draft)
    VALUES
      (${threadId}, ${opts.subject || ''}, ${opts.fromUserId}, ${opts.fromEmail}, ${opts.fromName}, ${opts.bodyHtml}, ${opts.bodyText}, ${snippet}, ${direction}, ${hasAtt}, ${rfcMessageId}, ${opts.inReplyTo || null}, ${!!opts.asDraft})
    RETURNING id
  `);
  const messageId = rows(ins)[0].id as string;

  for (const a of atts) {
    await db.execute(sql`
      INSERT INTO mail_attachments (message_id, filename, url, mime, size_bytes)
      VALUES (${messageId}, ${a.filename || 'attachment'}, ${a.url}, ${a.mime || null}, ${a.size || null})
    `);
  }

  // Resolve recipients
  const kinds: [RecipientKind, string[]][] = [
    ['to', opts.to || []],
    ['cc', opts.cc || []],
    ['bcc', opts.bcc || []],
  ];
  const internalUsers = new Map<string, RecipientKind>(); // userId -> first kind
  const external: { email: string; kind: RecipientKind }[] = [];

  for (const [kind, list] of kinds) {
    for (const email of list) {
      const resolved = await resolveAddress(email);
      await db.execute(sql`
        INSERT INTO mail_recipients (message_id, kind, user_id, email, name)
        VALUES (${messageId}, ${kind}, ${resolved.userId}, ${resolved.email}, ${resolved.name})
      `);
      if (resolved.userId) {
        if (!internalUsers.has(resolved.userId)) internalUsers.set(resolved.userId, kind);
      } else {
        external.push({ email: resolved.email, kind });
      }
    }
  }

  // Sender copy
  await db.execute(sql`
    INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
    VALUES (${opts.fromUserId}, ${messageId}, ${threadId}, ${opts.asDraft ? 'drafts' : 'sent'}, true)
    ON CONFLICT (user_id, message_id) DO UPDATE SET folder = EXCLUDED.folder
  `);

  // Internal recipient copies (skip drafts; skip sender to keep their Sent copy)
  if (!opts.asDraft) {
    for (const [userId] of internalUsers) {
      if (userId === opts.fromUserId) continue;
      await db.execute(sql`
        INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
        VALUES (${userId}, ${messageId}, ${threadId}, 'inbox', false)
        ON CONFLICT (user_id, message_id) DO NOTHING
      `);
    }
  }

  return { messageId, threadId, rfcMessageId, external };
}

export async function logOutbound(p: { messageId: string; to: string; from: string; subject: string; status: string; provider: string; error?: string | null }) {
  await db.execute(sql`
    INSERT INTO email_logs (message_id, to_email, from_email, subject, status, provider, error)
    VALUES (${p.messageId}, ${p.to}, ${p.from}, ${p.subject}, ${p.status}, ${p.provider}, ${p.error || null})
  `);
}

// ---- Read-side helpers for the mail client ----

export const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'sent', label: 'Sent' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'archive', label: 'Archive' },
  { key: 'spam', label: 'Spam' },
  { key: 'trash', label: 'Trash' },
];

export async function getFolderCounts(userId: string): Promise<Record<string, number>> {
  const r = await db.execute(sql`
    SELECT folder, COUNT(*) FILTER (WHERE is_read = false)::int AS unread, COUNT(*)::int AS total
    FROM mail_box WHERE user_id = ${userId} GROUP BY folder
  `);
  const out: Record<string, number> = {};
  for (const row of rows(r)) {
    out[row.folder] = Number(row.unread) || 0;
    out[row.folder + '_total'] = Number(row.total) || 0;
  }
  return out;
}

export interface ThreadRow {
  thread_id: string; message_id: string; subject: string; snippet: string;
  from_name: string; from_email: string; created_at: string;
  is_read: boolean; is_starred: boolean; has_attachments: boolean;
  folder: string; labels: string[]; thread_count: number; direction: string;
}

// List the latest message per thread within a folder for a user, with optional search.
export async function listFolder(userId: string, folder: Folder, q?: string, starred?: boolean): Promise<ThreadRow[]> {
  const search = q && q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const r = await db.execute(sql`
    WITH box AS (
      SELECT b.*, m.subject, m.snippet, m.from_name, m.from_email, m.has_attachments, m.direction, m.created_at AS msg_created
      FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
      WHERE b.user_id = ${userId}
        AND ${starred ? sql`b.is_starred = true` : sql`b.folder = ${folder}`}
        AND (${search}::text IS NULL OR lower(m.subject) LIKE ${search} OR lower(m.snippet) LIKE ${search} OR lower(m.from_name) LIKE ${search} OR lower(m.from_email) LIKE ${search})
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY msg_created DESC) AS rn,
             COUNT(*) OVER (PARTITION BY thread_id)::int AS thread_count,
             bool_and(is_read) OVER (PARTITION BY thread_id) AS all_read,
             bool_or(is_starred) OVER (PARTITION BY thread_id) AS any_star
      FROM box
    )
    SELECT thread_id, message_id, subject, snippet, from_name, from_email, msg_created AS created_at,
           all_read AS is_read, any_star AS is_starred, has_attachments, folder, labels, thread_count, direction
    FROM ranked WHERE rn = 1
    ORDER BY created_at DESC LIMIT 100
  `);
  return rows(r) as ThreadRow[];
}

export async function getThreadMessages(userId: string, threadId: string) {
  const r = await db.execute(sql`
    SELECT m.id, m.subject, m.from_name, m.from_email, m.from_user_id, m.body_html, m.body_text,
           m.created_at, m.direction, m.has_attachments, b.folder, b.is_read, b.is_starred
    FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
    WHERE b.user_id = ${userId} AND b.thread_id = ${threadId}
    ORDER BY m.created_at ASC
  `);
  const msgs = rows(r);
  for (const m of msgs) {
    const rec = await db.execute(sql`SELECT kind, email, name FROM mail_recipients WHERE message_id = ${m.id}`);
    m.recipients = rows(rec);
    if (m.has_attachments) {
      const at = await db.execute(sql`SELECT filename, url, mime, size_bytes FROM mail_attachments WHERE message_id = ${m.id}`);
      m.attachments = rows(at);
    } else m.attachments = [];
  }
  return msgs;
}

export async function markThreadRead(userId: string, threadId: string) {
  await db.execute(sql`UPDATE mail_box SET is_read = true WHERE user_id = ${userId} AND thread_id = ${threadId} AND is_read = false`);
}
