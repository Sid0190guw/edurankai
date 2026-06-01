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

// Self-bootstrap the mail schema at runtime so the system works even if the
// .dev-scripts migration was never run. Idempotent; runs once per warm instance.
let schemaReady: Promise<void> | null = null;
export function ensureMailSchema(): Promise<void> {
  if (!schemaReady) schemaReady = bootstrapSchema();
  return schemaReady;
}
async function bootstrapSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS mailbox_address VARCHAR(160)`);
  // non-unique on purpose so a best-effort backfill never errors on a collision
  await db.execute(sql`CREATE INDEX IF NOT EXISTS users_mailbox_address_idx ON users(mailbox_address)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), thread_id UUID NOT NULL, subject TEXT,
    from_user_id UUID REFERENCES users(id) ON DELETE SET NULL, from_email VARCHAR(255) NOT NULL,
    from_name VARCHAR(200), body_html TEXT, body_text TEXT, snippet VARCHAR(320),
    direction VARCHAR(12) NOT NULL DEFAULT 'internal', has_attachments BOOLEAN NOT NULL DEFAULT false,
    rfc_message_id VARCHAR(255), in_reply_to VARCHAR(255), is_draft BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_msg_thread_idx ON mail_messages(thread_id, created_at ASC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_msg_rfc_idx ON mail_messages(rfc_message_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    kind VARCHAR(4) NOT NULL DEFAULT 'to', user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    email VARCHAR(255) NOT NULL, name VARCHAR(200))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_recip_msg_idx ON mail_recipients(message_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_box (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE, thread_id UUID NOT NULL,
    folder VARCHAR(12) NOT NULL DEFAULT 'inbox', is_read BOOLEAN NOT NULL DEFAULT false,
    is_starred BOOLEAN NOT NULL DEFAULT false, is_important BOOLEAN NOT NULL DEFAULT false,
    labels TEXT[] NOT NULL DEFAULT '{}', snoozed_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, message_id))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_box_folder_idx ON mail_box(user_id, folder, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_box_thread_idx ON mail_box(user_id, thread_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    filename VARCHAR(300), url TEXT NOT NULL, mime VARCHAR(120), size_bytes BIGINT)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_attach_msg_idx ON mail_attachments(message_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, signature_html TEXT,
    display_name VARCHAR(200), vacation_on BOOLEAN NOT NULL DEFAULT false, vacation_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID, to_email VARCHAR(255),
    from_email VARCHAR(255), subject TEXT, status VARCHAR(20) NOT NULL DEFAULT 'queued',
    provider VARCHAR(20), error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  // Per-open read-receipt log. One row per read event (so multiple opens are
  // visible). Recipient_email is for external reads (pixel tracker), user_id
  // is for internal reads.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    recipient_email VARCHAR(255),
    kind VARCHAR(12) NOT NULL DEFAULT 'internal',
    ip_address VARCHAR(64),
    country VARCHAR(80),
    region VARCHAR(120),
    city VARCHAR(120),
    user_agent TEXT,
    read_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_reads_msg_idx ON mail_reads(message_id, read_at DESC)`);
  // single-row mail server config (UI-editable, overrides env vars)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_config (
    id INT PRIMARY KEY DEFAULT 1,
    smtp_host TEXT, smtp_port INT, smtp_user TEXT, smtp_pass TEXT, smtp_secure BOOLEAN NOT NULL DEFAULT false,
    from_name TEXT, from_address TEXT, resend_api_key TEXT, inbound_secret TEXT,
    outbound_enabled BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mail_config_singleton CHECK (id = 1))`);
  // best-effort backfill of mailbox addresses.
  // 1) Anyone with an assigned internal handle: that handle IS their mailbox
  //    address (it's what's shown on the Users page and what people send to).
  //    Also corrects any address an earlier email-local backfill set wrongly.
  try {
    await db.execute(sql`
      UPDATE users SET mailbox_address = lower(internal_handle)
      WHERE internal_handle IS NOT NULL AND internal_handle LIKE '%@%'
        AND (mailbox_address IS DISTINCT FROM lower(internal_handle))`);
  } catch (e) {}
  // 2) Everyone still missing one: derive from their login email local part.
  try {
    await db.execute(sql`
      WITH d AS (
        SELECT id,
          lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9._-]+', '.', 'g')) AS loc,
          row_number() OVER (PARTITION BY lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9._-]+', '.', 'g')) ORDER BY created_at) AS rn
        FROM users WHERE mailbox_address IS NULL AND email IS NOT NULL
      )
      UPDATE users u SET mailbox_address = d.loc || (CASE WHEN d.rn = 1 THEN '' ELSE d.rn::text END) || '@' || ${MAIL_DOMAIN}
      FROM d WHERE u.id = d.id`);
  } catch (e) { /* collisions left NULL; lazy assignment covers the active user */ }
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

// Resolve a single email to a platform user. Matches the canonical mailbox
// address, the assigned internal handle (what's shown on the Users page), AND
// the login email - so whichever form the sender typed will deliver internally.
export async function resolveAddress(email: string): Promise<ResolvedUser> {
  await ensureMailSchema();
  const e = normalizeEmail(email);
  const local = e.split('@')[0];
  const r = await db.execute(sql`
    SELECT id, name, email, mailbox_address, internal_handle FROM users
    WHERE lower(mailbox_address) = ${e}
       OR lower(email) = ${e}
       OR lower(internal_handle) = ${e}
       OR lower(internal_handle) = ${local}
       OR lower(internal_handle || '@' || ${MAIL_DOMAIN}) = ${e}
    LIMIT 1
  `);
  const u = rows(r)[0];
  if (u) {
    const canonical = (u.internal_handle && String(u.internal_handle).includes('@'))
      ? u.internal_handle
      : (u.mailbox_address || u.email);
    return { userId: u.id, email: canonical, name: u.name };
  }
  return { userId: null, email: e, name: null };
}

export async function getMailboxAddress(userId: string): Promise<string> {
  await ensureMailSchema();
  const r = await db.execute(sql`SELECT mailbox_address, internal_handle, email FROM users WHERE id = ${userId} LIMIT 1`);
  const u = rows(r)[0];
  if (u?.internal_handle && String(u.internal_handle).includes('@')) return u.internal_handle;
  if (u?.mailbox_address) return u.mailbox_address;
  // Lazy-assign for this user if the backfill missed them.
  const localBase = (u?.email ? String(u.email).split('@')[0] : 'user').toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[.-]+|[.-]+$/g, '') || 'user';
  let local = localBase, n = 1, addr = `${local}@${MAIL_DOMAIN}`;
  while (n < 50) {
    const clash = rows(await db.execute(sql`SELECT 1 FROM users WHERE lower(mailbox_address) = ${addr.toLowerCase()} AND id <> ${userId} LIMIT 1`));
    if (!clash.length) break;
    n += 1; local = `${localBase}${n}`; addr = `${local}@${MAIL_DOMAIN}`;
  }
  try { await db.execute(sql`UPDATE users SET mailbox_address = ${addr} WHERE id = ${userId}`); } catch (e) {}
  return addr;
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
  await ensureMailSchema();
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

export interface MailConfig {
  smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpSecure: boolean;
  fromName: string; fromAddress: string; resendApiKey: string; inboundSecret: string;
  outboundEnabled: boolean; source: 'db' | 'env' | 'none';
}

// Merged mail-server config: DB row (UI-editable) wins over environment vars.
function nonEmpty(v: any): string { const s = (v ?? '').toString().trim(); return s; }

export async function getMailConfig(): Promise<MailConfig> {
  await ensureMailSchema();
  let row: any = {};
  try { row = rows(await db.execute(sql`SELECT * FROM mail_config WHERE id = 1 LIMIT 1`))[0] || {}; } catch (e) {}

  const dbSmtpHost = nonEmpty(row.smtp_host);
  const dbResendKey = nonEmpty(row.resend_api_key);
  const envSmtpHost = nonEmpty(process.env.SMTP_HOST);
  const envResendKey = nonEmpty(process.env.RESEND_API_KEY);

  const smtpHost = dbSmtpHost || envSmtpHost;
  const resendApiKey = dbResendKey || envResendKey;
  const hasDb = !!(dbSmtpHost || dbResendKey);
  const hasEnv = !!(envSmtpHost || envResendKey);

  return {
    smtpHost,
    smtpPort: Number(nonEmpty(row.smtp_port) || nonEmpty(process.env.SMTP_PORT) || '587'),
    smtpUser: nonEmpty(row.smtp_user) || nonEmpty(process.env.SMTP_USER),
    smtpPass: nonEmpty(row.smtp_pass) || nonEmpty(process.env.SMTP_PASS),
    smtpSecure: row.smtp_secure != null ? !!row.smtp_secure : (process.env.SMTP_SECURE === 'true'),
    fromName: nonEmpty(row.from_name) || 'EduRankAI',
    fromAddress: nonEmpty(row.from_address) || nonEmpty(process.env.EMAIL_FROM),
    resendApiKey,
    inboundSecret: nonEmpty(row.inbound_secret) || nonEmpty(process.env.MAIL_INBOUND_SECRET),
    outboundEnabled: !!(smtpHost || resendApiKey),
    source: hasDb ? 'db' : (hasEnv ? 'env' : 'none'),
  };
}

export async function saveMailConfig(p: Partial<{ smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpSecure: boolean; fromName: string; fromAddress: string; resendApiKey: string; inboundSecret: string }>): Promise<void> {
  await ensureMailSchema();
  // Convert empty / blank values to NULL so the source-detection logic in
  // getMailConfig (which uses nonEmpty) sees the row consistently.
  const s = (v: any) => { const t = (v ?? '').toString().trim(); return t === '' ? null : t; };
  const smtpHost     = s(p.smtpHost);
  const smtpPort     = p.smtpPort == null || isNaN(Number(p.smtpPort)) ? null : Number(p.smtpPort);
  const smtpUser     = s(p.smtpUser);
  const smtpPass     = s(p.smtpPass);                   // null = keep existing
  const smtpSecure   = p.smtpSecure ?? false;
  const fromName     = s(p.fromName);
  const fromAddress  = s(p.fromAddress);
  const resendApiKey = s(p.resendApiKey);                // null = keep existing
  const inboundSecret = s(p.inboundSecret);              // null = keep existing
  await db.execute(sql`
    INSERT INTO mail_config (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, from_name, from_address, resend_api_key, inbound_secret, updated_at)
    VALUES (1, ${smtpHost}, ${smtpPort}, ${smtpUser}, ${smtpPass}, ${smtpSecure}, ${fromName}, ${fromAddress}, ${resendApiKey}, ${inboundSecret}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      smtp_host    = EXCLUDED.smtp_host,
      smtp_port    = EXCLUDED.smtp_port,
      smtp_user    = EXCLUDED.smtp_user,
      smtp_pass    = COALESCE(EXCLUDED.smtp_pass, mail_config.smtp_pass),
      smtp_secure  = EXCLUDED.smtp_secure,
      from_name    = EXCLUDED.from_name,
      from_address = EXCLUDED.from_address,
      resend_api_key = COALESCE(EXCLUDED.resend_api_key, mail_config.resend_api_key),
      inbound_secret = COALESCE(EXCLUDED.inbound_secret, mail_config.inbound_secret),
      updated_at = NOW()
  `);
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
  await ensureMailSchema();
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
  await ensureMailSchema();
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
  await ensureMailSchema();
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
