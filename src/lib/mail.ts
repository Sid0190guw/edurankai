// src/lib/mail.ts - unified mail engine (internal delivery + envelope + threading)
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
// THE BINDING THAT NEVER RAN. Five statements in this file matched a column against a JS array with
// `= ANY(${jsArray}::uuid[])` / `::text[]`. postgres-js serialises a JS array as a RECORD literal, so
// Postgres answers "cannot cast type record to uuid[]" and the statement never executes — the exact
// fault src/lib/pg-array.ts was written about and fixed in four other modules. Two of the five sat
// in getThreadMessages() with NO catch around them, so opening ANY mail conversation threw before a
// single message was rendered and MailClient drew the "could not be opened" state instead of the
// thread. `IN ${uuidIn(ids)}` is the repaired idiom already used by /admin/mail/analytics,
// /admin/applications, /admin/users and /admin/tests/attempts; it keeps the column's index usable.
import { uuidIn, textIn } from '@/lib/pg-array';

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
  // THE RFC ID GETS ITS OWN COLUMN. email_logs.message_id is uuid-typed here, and every transport
  // caller was passing an RFC id ("<uuid@host>") or an empty string into it. Those INSERTs threw
  // `invalid input syntax for type uuid` into a `.catch(() => {})` — so a send that FAILED at the
  // SMTP layer left no trace at all, which is half of why the reading pane could claim delivery.
  // Additive, never destructive: live rows exist under two historical shapes of this table.
  try { await db.execute(sql`ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS rfc_message_id TEXT`); } catch (e) {}
  try { await db.execute(sql`CREATE INDEX IF NOT EXISTS email_logs_msg_idx ON email_logs(message_id)`); } catch (e) {}
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
  const raw = Array.isArray(input) ? input.join('\n') : input;
  const out: string[] = [];
  // Gmail-style: pull EVERY email address found anywhere in the text, no matter
  // the delimiter (comma, semicolon, space, newline) or surrounding words. So a
  // pasted blob — even with names or nonsense mixed in — just extracts the
  // addresses and ignores the rest. Handles "Name <a@x.com>" too.
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  for (const m of raw.match(re) || []) {
    const email = normalizeEmail(m);
    if (email && !out.includes(email)) out.push(email);
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

  // RESOLVE, THEN INSERT ONCE — rather than resolve-and-insert per address.
  //
  // This was three awaited round trips per recipient on a thirty-address send: a resolve, a
  // mail_recipients insert, and later a mail_box insert. The inserts are trivial; what they cost is
  // a pooler connection held for a ~140ms network hop each, and sending a company-wide mail is not a
  // background job here — it happens inside a request while every other page competes for the same
  // handful of connections.
  //
  // The two INSERTS collapse to one statement each. The RESOLVE deliberately does not: batching it
  // needs a LEFT JOIN LATERAL to keep "first match wins, per address" and this is mail ROUTING —
  // delivering to the wrong person is a worse failure than a slow send, so it is left for a change
  // that can be tested against real address data rather than folded into a latency pass.
  const pending: { kind: RecipientKind; userId: string | null; email: string; name: string | null }[] = [];
  for (const [kind, list] of kinds) {
    for (const email of list) {
      const resolved = await resolveAddress(email);
      pending.push({ kind, userId: resolved.userId, email: resolved.email, name: resolved.name });
      if (resolved.userId) {
        if (!internalUsers.has(resolved.userId)) internalUsers.set(resolved.userId, kind);
      } else {
        external.push({ email: resolved.email, kind });
      }
    }
  }

  // jsonb_to_recordset rather than a VALUES list built from N placeholders: one parameter whatever
  // the recipient count, so the statement cannot grow toward the parameter limit on a large send.
  // The empty guard matters — jsonb_to_recordset over [] inserts nothing, but sending the statement
  // at all is a round trip for no rows.
  if (pending.length) {
    await db.execute(sql`
      INSERT INTO mail_recipients (message_id, kind, user_id, email, name)
      SELECT ${messageId}, x.kind, x.user_id, x.email, x.name
        FROM jsonb_to_recordset(${JSON.stringify(pending)}::jsonb)
          AS x(kind text, user_id uuid, email text, name text)
    `);
  }

  // Sender copy
  await db.execute(sql`
    INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
    VALUES (${opts.fromUserId}, ${messageId}, ${threadId}, ${opts.asDraft ? 'drafts' : 'sent'}, true)
    ON CONFLICT (user_id, message_id) DO UPDATE SET folder = EXCLUDED.folder
  `);

  // Internal recipient copies (skip drafts; skip sender to keep their Sent copy).
  // One statement for the whole distribution list, for the same reason as above. The sender filter
  // and the ON CONFLICT are unchanged, so a recipient who is also the sender still keeps the Sent
  // copy written just above rather than gaining an inbox row.
  if (!opts.asDraft) {
    const boxUserIds = [...internalUsers.keys()].filter((u) => u !== opts.fromUserId);
    if (boxUserIds.length) {
      await db.execute(sql`
        INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
        SELECT x.user_id, ${messageId}, ${threadId}, 'inbox', false
          FROM jsonb_to_recordset(${JSON.stringify(boxUserIds.map((u) => ({ user_id: u })))}::jsonb)
            AS x(user_id uuid)
        ON CONFLICT (user_id, message_id) DO NOTHING
      `);
    }
  }

  return { messageId, threadId, rfcMessageId, external };
}

export interface MailConfig {
  smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpSecure: boolean; smtpInsecure: boolean;
  fromName: string; fromAddress: string; resendApiKey: string; inboundSecret: string;
  outboundEnabled: boolean; source: 'db' | 'env' | 'none';
  /**
   * NOT-CONFIGURED AND COULD-NOT-BE-READ ARE DIFFERENT ANSWERS, AND THEY USED TO BE THE SAME ONE.
   *
   * The mail_config SELECT below sat in a bare `catch (e) {}` over `row = {}`. Everything downstream
   * then read the environment fallback (empty in production, where the credentials live in the DB
   * row) and concluded the mail system was switched off:
   *
   *   sendExternal()        `if (!c.smtpHost)` -> logs 'no_transport' and answers "No SMTP transport
   *                         configured (add your mail server in Mail Settings)" for EVERY outbound
   *                         message, including password resets and offer letters
   *   /api/mail/inbound     `secret` comes out '' and the guard answers 403 forbidden to a real MTA,
   *                         which reads as "your shared secret is wrong" — so inbound mail is
   *                         rejected and the operator goes looking for a secret that never changed
   *   /admin/mail/health    draws the red "not configured" card
   *   /admin/mail/settings  renders a BLANK credential form over a live configuration
   *
   * getImapConfig() in src/lib/mail-imap.ts was repaired for exactly this and this half was left
   * behind. The read failure is now carried on the value instead of being thrown away: '' means the
   * row was read (however empty it was), a non-empty string is the database's own reason.
   */
  readError: string;
}

// Merged mail-server config: DB row (UI-editable) wins over environment vars.
function nonEmpty(v: any): string { const s = (v ?? '').toString().trim(); return s; }

export async function getMailConfig(): Promise<MailConfig> {
  await ensureMailSchema();
  let row: any = {};
  // e.message on a drizzle/postgres-js error is only the failed SQL; the database's real complaint
  // is on e.cause. Silence here is what made an unreadable row look like an unconfigured one.
  let readError = '';
  try {
    row = rows(await db.execute(sql`SELECT * FROM mail_config WHERE id = 1 LIMIT 1`))[0] || {};
  } catch (e: any) {
    readError = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[mail] mail_config could not be read:', readError);
  }

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
    smtpInsecure: row.smtp_insecure != null ? !!row.smtp_insecure : (process.env.SMTP_INSECURE === 'true'),
    fromName: nonEmpty(row.from_name) || 'EduRankAI',
    fromAddress: nonEmpty(row.from_address) || nonEmpty(process.env.EMAIL_FROM),
    resendApiKey,
    inboundSecret: nonEmpty(row.inbound_secret) || nonEmpty(process.env.MAIL_INBOUND_SECRET),
    outboundEnabled: !!(smtpHost || resendApiKey),
    source: hasDb ? 'db' : (hasEnv ? 'env' : 'none'),
    readError,
  };
}

export async function saveMailConfig(p: Partial<{ smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpSecure: boolean; smtpInsecure: boolean; fromName: string; fromAddress: string; resendApiKey: string; inboundSecret: string }>): Promise<void> {
  await ensureMailSchema();
  // ensure the optional cert-tolerance column exists
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS smtp_insecure BOOLEAN NOT NULL DEFAULT false`); } catch (_) {}
  // Convert empty / blank values to NULL. We then use COALESCE on every text
  // field in the UPDATE so a blank input PRESERVES the existing value rather
  // than wiping it — the old behaviour silently nuked smtp_host when users
  // re-saved without re-typing it.
  const s = (v: any) => { const t = (v ?? '').toString().trim(); return t === '' ? null : t; };
  const smtpHost     = s(p.smtpHost);
  const smtpPort     = p.smtpPort == null || isNaN(Number(p.smtpPort)) ? null : Number(p.smtpPort);
  const smtpUser     = s(p.smtpUser);
  const smtpPass     = s(p.smtpPass);                   // null = keep existing
  const smtpSecure   = p.smtpSecure == null ? null : !!p.smtpSecure;
  const smtpInsecure = p.smtpInsecure == null ? null : !!p.smtpInsecure;
  const fromName     = s(p.fromName);
  const fromAddress  = s(p.fromAddress);
  const resendApiKey = s(p.resendApiKey);                // null = keep existing
  const inboundSecret = s(p.inboundSecret);              // null = keep existing
  await db.execute(sql`
    INSERT INTO mail_config (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_insecure, from_name, from_address, resend_api_key, inbound_secret, updated_at)
    VALUES (1, ${smtpHost}, ${smtpPort}, ${smtpUser}, ${smtpPass}, ${smtpSecure ?? false}, ${smtpInsecure ?? false}, ${fromName}, ${fromAddress}, ${resendApiKey}, ${inboundSecret}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      smtp_host    = COALESCE(EXCLUDED.smtp_host, mail_config.smtp_host),
      smtp_port    = COALESCE(EXCLUDED.smtp_port, mail_config.smtp_port),
      smtp_user    = COALESCE(EXCLUDED.smtp_user, mail_config.smtp_user),
      smtp_pass    = COALESCE(EXCLUDED.smtp_pass, mail_config.smtp_pass),
      smtp_secure  = COALESCE(${smtpSecure}::boolean, mail_config.smtp_secure),
      smtp_insecure = COALESCE(${smtpInsecure}::boolean, mail_config.smtp_insecure),
      from_name    = COALESCE(EXCLUDED.from_name, mail_config.from_name),
      from_address = COALESCE(EXCLUDED.from_address, mail_config.from_address),
      resend_api_key = COALESCE(EXCLUDED.resend_api_key, mail_config.resend_api_key),
      inbound_secret = COALESCE(EXCLUDED.inbound_secret, mail_config.inbound_secret),
      updated_at = NOW()
  `);
}

// Hard-clear a single field. Used by the "Clear" button in the admin so a user
// CAN actually wipe a setting (since saveMailConfig now preserves on blank).
export async function clearMailField(field: 'smtp_host' | 'smtp_user' | 'smtp_pass' | 'from_name' | 'from_address' | 'resend_api_key' | 'inbound_secret'): Promise<void> {
  await ensureMailSchema();
  const allowed = new Set(['smtp_host','smtp_user','smtp_pass','from_name','from_address','resend_api_key','inbound_secret']);
  if (!allowed.has(field)) return;
  await db.execute(sql.raw(`UPDATE mail_config SET ${field} = NULL, updated_at = NOW() WHERE id = 1`));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function logOutbound(p: { messageId: string; to: string; from: string; subject: string; status: string; provider: string; error?: string | null; rfcMessageId?: string | null }) {
  // message_id is uuid-typed; anything that is not a uuid (an RFC id, an empty string) goes to
  // rfc_message_id instead of poisoning the whole INSERT. See the note in bootstrapSchema.
  const mailMessageId = UUID_RE.test(String(p.messageId || '')) ? String(p.messageId) : null;
  const rfc = (p.rfcMessageId || (mailMessageId ? null : (p.messageId || null))) || null;
  await db.execute(sql`
    INSERT INTO email_logs (message_id, rfc_message_id, to_email, from_email, subject, status, provider, error)
    VALUES (${mailMessageId}, ${rfc}, ${p.to}, ${p.from}, ${p.subject}, ${p.status}, ${p.provider}, ${p.error || null})
  `);
}

// ---- Delivery truth ----------------------------------------------------------------
//
// WHAT THE READING PANE USED TO DO. It looked up email_logs by rfc_message_id, while
// /api/mail/send wrote those rows keyed by the mail_messages UUID. Nothing ever matched, so
// `m.delivery` was always undefined and the template's ternary fell through to a green
// "Delivered" badge on EVERY sent message — including one whose SMTP attempt had hard-failed.
// (The same query also bound `::text[]` against a uuid column, which threw and blanked the whole
// thread.) This is the exact failure mode this project keeps producing: a surface reporting
// success while nothing happened.
//
// The rule now: a message is only called delivered when something says so. Internal-only mail is
// "delivered" because we wrote the recipient's mailbox row ourselves and can see it. External mail
// is delivered only when a transport logged 'sent'. Anything else says what it is, and an unknown
// state says "unknown" — never "Delivered".

export type DeliveryState = 'internal' | 'sent' | 'partial' | 'failed' | 'no_transport' | 'unknown';

export interface DeliveryStatus {
  state: DeliveryState;
  /** External recipients on the message. 0 means the mail never needed to leave. */
  externalCount: number;
  sent: number;
  failed: number;
  provider: string | null;
  error: string | null;
}

/**
 * Roll up email_logs per message. Cast BOTH sides to text: email_logs exists in production under
 * two historical shapes (uuid and text message_id) and this read must work against either.
 */
export async function getDeliveryStatuses(
  messageIds: string[],
  externalCounts: Record<string, number> = {},
): Promise<Record<string, DeliveryStatus>> {
  const out: Record<string, DeliveryStatus> = {};
  const ids = (messageIds || []).filter((x) => typeof x === 'string' && x.length > 0);
  if (!ids.length) return out;

  let logRows: any[] = [];
  try {
    const r = await db.execute(sql`
      SELECT message_id::text AS mid, status, provider, error, created_at
      FROM email_logs
      WHERE message_id::text IN ${textIn(ids)}
      ORDER BY created_at DESC
    `);
    logRows = rows(r);
  } catch (e: any) {
    // Not swallowed: a delivery read that did not run must not be reported as a delivery.
    console.error('[mail] delivery status read failed:', (e as any)?.cause?.message || (e as any)?.message);
    for (const id of ids) {
      out[id] = { state: 'unknown', externalCount: externalCounts[id] || 0, sent: 0, failed: 0, provider: null, error: null };
    }
    return out;
  }

  for (const id of ids) {
    const mine = logRows.filter((l) => String(l.mid) === id);
    const externalCount = externalCounts[id] || 0;
    const sent = mine.filter((l) => l.status === 'sent').length;
    const failed = mine.filter((l) => l.status === 'failed' || l.status === 'bounced').length;
    const noTransport = mine.filter((l) => l.status === 'no_transport').length;
    const firstBad = mine.find((l) => l.error);

    let state: DeliveryState;
    if (externalCount === 0 && !mine.length) state = 'internal';
    else if (noTransport && !sent) state = 'no_transport';
    else if (failed && sent) state = 'partial';
    else if (failed) state = 'failed';
    else if (sent) state = 'sent';
    else state = 'unknown';

    out[id] = {
      state,
      externalCount,
      sent,
      failed: failed + noTransport,
      provider: mine[0]?.provider || null,
      error: firstBad?.error || null,
    };
  }
  return out;
}

/** One sentence per state. Kept here so the composer's toast and the thread badge cannot disagree. */
export function deliveryWording(d: DeliveryStatus): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; detail: string } {
  switch (d.state) {
    case 'internal':
      return { label: 'Delivered in app', tone: 'ok', detail: 'Everyone on this message has a mailbox here, so it was placed in their inbox directly. It never needed a mail server.' };
    case 'sent':
      return { label: 'Sent', tone: 'ok', detail: 'Handed to the mail server for ' + d.externalCount + ' address' + (d.externalCount === 1 ? '' : 'es') + ' outside the organisation. Acceptance by their server is not something we can see from here.' };
    case 'partial':
      return { label: 'Partly delivered', tone: 'warn', detail: d.sent + ' address' + (d.sent === 1 ? '' : 'es') + ' accepted, ' + d.failed + ' not. ' + (d.error || '') };
    case 'failed':
      return { label: 'Not delivered', tone: 'bad', detail: 'The mail server refused this message. ' + (d.error || 'No reason was recorded.') };
    case 'no_transport':
      return { label: 'Not sent', tone: 'bad', detail: 'This message has recipients outside the organisation and no mail server is connected, so it went nowhere. It is saved in Sent.' };
    default:
      return { label: 'Delivery unknown', tone: 'muted', detail: 'No delivery record was found for this message. It has not been confirmed as delivered.' };
  }
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
  from_name: string; from_email: string; from_user_id: string | null; created_at: string;
  is_read: boolean; is_starred: boolean; has_attachments: boolean;
  folder: string; labels: string[]; thread_count: number; direction: string;
  is_draft: boolean; participants?: string;
}

// ---- Search ------------------------------------------------------------------------
//
// WHAT PEOPLE ACTUALLY SEARCH. The old query matched subject, snippet, from_name and from_email —
// so "the paragraph I wrote about the Kerala site visit" was unfindable, because the BODY was never
// looked at, and "everything from Anita in July" was unexpressible, because there was no notion of
// a sender filter or a date. Both are the ordinary way a person looks for mail they remember
// having rather than mail they can name.
//
// The grammar is the one people already have in their fingers, and every operator is optional:
//   from:anita  to:accounts  subject:invoice  label:payroll
//   has:attachment  is:unread  is:starred  is:read
//   after:2026-07-01  before:2026-08-01  after:7d  after:today  after:yesterday
//   in:anywhere        (search every folder except Trash and Spam)
//   "exact phrase"     (quoted terms are kept whole)
// Anything not recognised as an operator is free text and is matched against subject, body,
// snippet, sender AND recipients — so a plain search still behaves like a plain search.
//
// The parse result is ECHOED ON SCREEN (describe). If a search finds nothing, the person can see
// what was actually searched for rather than guessing whether the operator was understood.

export interface MailQuery {
  text: string[];
  from: string[];
  to: string[];
  subject: string[];
  label: string | null;
  hasAttachment: boolean;
  unreadOnly: boolean;
  readOnly: boolean;
  starredOnly: boolean;
  after: Date | null;
  before: Date | null;
  everywhere: boolean;
  raw: string;
  active: boolean;
  describe: string;
}

const EMPTY_QUERY: MailQuery = {
  text: [], from: [], to: [], subject: [], label: null,
  hasAttachment: false, unreadOnly: false, readOnly: false, starredOnly: false,
  after: null, before: null, everywhere: false, raw: '', active: false, describe: '',
};

function parseWhen(v: string): Date | null {
  const s = (v || '').trim().toLowerCase();
  if (!s) return null;
  const now = new Date();
  if (s === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s === 'yesterday') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const rel = /^(\d{1,4})\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const d = new Date(now);
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'm') d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}

export function parseMailQuery(raw: string): MailQuery {
  const q: MailQuery = { ...EMPTY_QUERY, text: [], from: [], to: [], subject: [], raw: String(raw || '') };
  const src = q.raw.trim();
  if (!src) return q;

  // Split on whitespace but keep "quoted phrases" and field:"quoted values" whole.
  const tokens = src.match(/[a-zA-Z]+:"[^"]*"|"[^"]*"|\S+/g) || [];
  for (const tokRaw of tokens) {
    const tok = tokRaw.trim();
    if (!tok) continue;
    const m = /^([a-zA-Z]+):(.*)$/.exec(tok);
    const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1').trim();
    if (m) {
      const field = m[1].toLowerCase();
      const value = unquote(m[2]);
      if (!value && field !== 'is' && field !== 'has') continue;
      if (field === 'from') { q.from.push(value.toLowerCase()); continue; }
      if (field === 'to' || field === 'cc' || field === 'bcc') { q.to.push(value.toLowerCase()); continue; }
      if (field === 'subject' || field === 'title') { q.subject.push(value.toLowerCase()); continue; }
      if (field === 'label' || field === 'tag') { q.label = value; continue; }
      if (field === 'has') {
        if (/attach|file|link|doc/.test(value.toLowerCase())) q.hasAttachment = true;
        continue;
      }
      if (field === 'is') {
        const v = value.toLowerCase();
        if (v === 'unread') q.unreadOnly = true;
        else if (v === 'read') q.readOnly = true;
        else if (v === 'starred' || v === 'star') q.starredOnly = true;
        continue;
      }
      if (field === 'after' || field === 'since' || field === 'newer') { q.after = parseWhen(value); continue; }
      if (field === 'before' || field === 'until' || field === 'older') {
        const d = parseWhen(value);
        // `before:` is inclusive of the named day — nobody means "up to midnight that morning".
        if (d) { d.setDate(d.getDate() + 1); q.before = d; }
        continue;
      }
      if (field === 'in') {
        const v = value.toLowerCase();
        if (v === 'anywhere' || v === 'all' || v === 'everywhere') q.everywhere = true;
        continue;
      }
      // An unknown field: treat the whole token as free text rather than dropping it silently.
      q.text.push(tok.toLowerCase());
      continue;
    }
    const plain = unquote(tok).toLowerCase();
    if (plain) q.text.push(plain);
  }

  const bits: string[] = [];
  if (q.text.length) bits.push('“' + q.text.join(' ') + '”');
  if (q.from.length) bits.push('from ' + q.from.join(', '));
  if (q.to.length) bits.push('to ' + q.to.join(', '));
  if (q.subject.length) bits.push('subject containing ' + q.subject.join(', '));
  if (q.label) bits.push('labelled ' + q.label);
  if (q.hasAttachment) bits.push('with an attachment');
  if (q.unreadOnly) bits.push('unread only');
  if (q.readOnly) bits.push('read only');
  if (q.starredOnly) bits.push('starred only');
  if (q.after) bits.push('on or after ' + fmtDay(q.after));
  if (q.before) { const b = new Date(q.before); b.setDate(b.getDate() - 1); bits.push('on or before ' + fmtDay(b)); }
  q.describe = bits.join(' · ');
  q.active = bits.length > 0;
  return q;
}

export interface ListFolderOptions {
  folder: Folder;
  /** The Starred pseudo-folder in the rail. */
  starred?: boolean;
  /** A label pseudo-folder in the rail; searches every folder except Trash and Spam. */
  label?: string | null;
  query?: string;
  limit?: number;
  /**
   * KEYSET PAGING, ADDED FOR THE /mail PRODUCT SURFACE AND OPTIONAL EVERYWHERE ELSE.
   *
   * Return only threads whose latest message is strictly OLDER than this instant. That is what makes
   * "load more" in a long mailbox a bounded, constant-cost request instead of either an OFFSET walk
   * (which re-reads and discards every earlier row) or a limit that grows on every scroll.
   *
   * Omitting it is exactly the previous behaviour — MailClient.astro passes no cursor and is
   * unchanged.
   */
  before?: string | null;
}

export interface FolderListing {
  rows: ThreadRow[];
  query: MailQuery;
  /** True when the listing is narrowed by anything other than the folder itself. */
  filtered: boolean;
  scopeLabel: string;
}

// List the latest message per thread, with search. One statement for the threads, one for the
// participant names (a window function cannot do DISTINCT, and N+1 per row is what made the old
// reading pane slow).
export async function listFolder(userId: string, opts: ListFolderOptions): Promise<FolderListing> {
  await ensureMailSchema();
  const q = parseMailQuery(opts.query || '');
  const limit = Math.min(Math.max(opts.limit || 100, 1), 200);
  const wide = q.everywhere || !!opts.label;

  let where = sql`b.user_id = ${userId}`;
  let scopeLabel: string;
  if (opts.label) {
    where = sql`${where} AND b.labels @> ARRAY[${opts.label}]::text[] AND b.folder NOT IN ('trash','spam')`;
    scopeLabel = 'Label: ' + opts.label;
  } else if (opts.starred) {
    where = sql`${where} AND b.is_starred = true AND b.folder <> 'trash'`;
    scopeLabel = 'Starred';
  } else if (q.everywhere) {
    where = sql`${where} AND b.folder NOT IN ('trash','spam')`;
    scopeLabel = 'All mail';
  } else {
    where = sql`${where} AND b.folder = ${opts.folder}`;
    scopeLabel = (FOLDERS.find((f) => f.key === opts.folder)?.label) || opts.folder;
  }

  if (q.label && !opts.label) where = sql`${where} AND b.labels @> ARRAY[${q.label}]::text[]`;
  if (q.unreadOnly) where = sql`${where} AND b.is_read = false`;
  if (q.readOnly) where = sql`${where} AND b.is_read = true`;
  if (q.starredOnly) where = sql`${where} AND b.is_starred = true`;
  if (q.hasAttachment) where = sql`${where} AND m.has_attachments = true`;
  if (q.after) where = sql`${where} AND m.created_at >= ${q.after.toISOString()}::timestamptz`;
  if (q.before) where = sql`${where} AND m.created_at < ${q.before.toISOString()}::timestamptz`;
  // The paging cursor, kept separate from the `before:` SEARCH operator above on purpose: one is
  // what the reader asked for and is echoed on screen, the other is where the last page ended. A
  // cursor that could not be parsed is ignored rather than throwing — the reader gets page one, not
  // an error about a value they never typed.
  if (opts.before) {
    const cur = new Date(opts.before);
    if (!isNaN(cur.getTime())) where = sql`${where} AND m.created_at < ${cur.toISOString()}::timestamptz`;
  }

  for (const term of q.from) {
    const like = '%' + term + '%';
    where = sql`${where} AND (lower(coalesce(m.from_email,'')) LIKE ${like} OR lower(coalesce(m.from_name,'')) LIKE ${like})`;
  }
  for (const term of q.to) {
    const like = '%' + term + '%';
    where = sql`${where} AND EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id
      AND (lower(coalesce(r.email,'')) LIKE ${like} OR lower(coalesce(r.name,'')) LIKE ${like}))`;
  }
  for (const term of q.subject) {
    const like = '%' + term + '%';
    where = sql`${where} AND lower(coalesce(m.subject,'')) LIKE ${like}`;
  }
  // Free text: every term must appear SOMEWHERE on the message — subject, body, snippet, sender or
  // any recipient. Body included, which is the whole point.
  for (const term of q.text) {
    const like = '%' + term + '%';
    where = sql`${where} AND (
      lower(coalesce(m.subject,'')) LIKE ${like}
      OR lower(coalesce(m.snippet,'')) LIKE ${like}
      OR lower(coalesce(m.body_text,'')) LIKE ${like}
      OR lower(coalesce(m.body_html,'')) LIKE ${like}
      OR lower(coalesce(m.from_name,'')) LIKE ${like}
      OR lower(coalesce(m.from_email,'')) LIKE ${like}
      OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id
                 AND (lower(coalesce(r.email,'')) LIKE ${like} OR lower(coalesce(r.name,'')) LIKE ${like}))
    )`;
  }

  const r = await db.execute(sql`
    WITH box AS (
      SELECT b.thread_id, b.message_id, b.folder, b.is_read, b.is_starred, b.labels,
             m.subject, m.snippet, m.from_name, m.from_email, m.from_user_id,
             m.has_attachments, m.direction, m.is_draft, m.created_at AS msg_created
      FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
      WHERE ${where}
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY msg_created DESC) AS rn,
             COUNT(*) OVER (PARTITION BY thread_id)::int AS thread_count,
             bool_and(is_read) OVER (PARTITION BY thread_id) AS all_read,
             bool_or(is_starred) OVER (PARTITION BY thread_id) AS any_star
      FROM box
    )
    SELECT thread_id, message_id, subject, snippet, from_name, from_email, from_user_id,
           msg_created AS created_at, all_read AS is_read, any_star AS is_starred,
           has_attachments, folder, labels, thread_count, direction, is_draft
    FROM ranked WHERE rn = 1
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  const list = rows(r) as ThreadRow[];

  // Participants, so a thread reads like a conversation instead of repeating the last sender.
  if (list.length) {
    try {
      const ids = list.map((t) => t.thread_id);
      const p = await db.execute(sql`
        SELECT b.thread_id, string_agg(DISTINCT coalesce(nullif(m.from_name,''), m.from_email), ', ') AS names
        FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
        WHERE b.user_id = ${userId} AND b.thread_id IN ${uuidIn(ids)}
        GROUP BY b.thread_id
      `);
      const byThread: Record<string, string> = {};
      for (const row of rows(p)) byThread[String(row.thread_id)] = row.names || '';
      for (const t of list) t.participants = byThread[t.thread_id] || t.from_name || t.from_email;
    } catch (e: any) {
      console.error('[mail] participants read failed:', e?.cause?.message || e?.message);
    }
  }

  return { rows: list, query: q, filtered: q.active || wide, scopeLabel };
}

/** Every label this person has actually put on something — the rail and the label picker agree
 *  because they read the same list. */
export async function getUserLabels(userId: string): Promise<string[]> {
  await ensureMailSchema();
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT unnest(labels) AS label FROM mail_box WHERE user_id = ${userId} ORDER BY 1 ASC
    `);
    return rows(r).map((x: any) => String(x.label)).filter(Boolean).slice(0, 60);
  } catch (e: any) {
    console.error('[mail] label read failed:', e?.cause?.message || e?.message);
    return [];
  }
}

export interface ThreadMessage {
  id: string; subject: string; from_name: string; from_email: string; from_user_id: string | null;
  body_html: string | null; body_text: string | null; created_at: string; direction: string;
  has_attachments: boolean; folder: string; is_read: boolean; is_starred: boolean;
  is_draft: boolean; rfc_message_id: string | null; in_reply_to: string | null; labels: string[];
  recipients: { kind: string; email: string; name: string | null }[];
  attachments: { filename: string; url: string; mime: string | null; size_bytes: number | null }[];
  reads: any[];
  delivery: DeliveryStatus | null;
}

/**
 * Every message in a thread that this user has a mailbox row for, with its recipients,
 * attachments, read receipts and DELIVERY TRUTH already resolved.
 *
 * This used to be N+1 (two statements per message) plus a block of raw SQL inside the .astro
 * component, one line of which compared a uuid column to a text array and threw — and the
 * component's catch turned that into an EMPTY THREAD. Four statements now, whatever the length of
 * the conversation, and the component renders what it is given.
 */
export async function getThreadMessages(userId: string, threadId: string): Promise<ThreadMessage[]> {
  await ensureMailSchema();
  const r = await db.execute(sql`
    SELECT m.id, m.subject, m.from_name, m.from_email, m.from_user_id, m.body_html, m.body_text,
           m.created_at, m.direction, m.has_attachments, m.is_draft, m.rfc_message_id, m.in_reply_to,
           b.folder, b.is_read, b.is_starred, b.labels
    FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
    WHERE b.user_id = ${userId} AND b.thread_id = ${threadId}
    ORDER BY m.created_at ASC
  `);
  const msgs = rows(r) as ThreadMessage[];
  if (!msgs.length) return msgs;

  const ids = msgs.map((m) => m.id);
  const byId: Record<string, ThreadMessage> = {};
  for (const m of msgs) { m.recipients = []; m.attachments = []; m.reads = []; m.delivery = null; byId[m.id] = m; }

  const rec = await db.execute(sql`
    SELECT message_id, kind, email, name, user_id FROM mail_recipients WHERE message_id IN ${uuidIn(ids)}
  `);
  const externalCounts: Record<string, number> = {};
  for (const x of rows(rec)) {
    byId[String(x.message_id)]?.recipients.push({ kind: x.kind, email: x.email, name: x.name });
    if (!x.user_id) externalCounts[String(x.message_id)] = (externalCounts[String(x.message_id)] || 0) + 1;
  }

  const at = await db.execute(sql`
    SELECT message_id, filename, url, mime, size_bytes FROM mail_attachments WHERE message_id IN ${uuidIn(ids)}
  `);
  for (const x of rows(at)) {
    byId[String(x.message_id)]?.attachments.push({ filename: x.filename, url: x.url, mime: x.mime, size_bytes: x.size_bytes });
  }

  // Read receipts and delivery are the sender's business only.
  const mine = msgs.filter((m) => m.from_user_id === userId).map((m) => m.id);
  if (mine.length) {
    try {
      const rr = await db.execute(sql`
        SELECT message_id, kind, country, region, city, ip_address, read_at, user_id
        FROM mail_reads WHERE message_id IN ${uuidIn(mine)} ORDER BY read_at DESC
      `);
      for (const x of rows(rr)) byId[String(x.message_id)]?.reads.push(x);
    } catch (e: any) {
      console.error('[mail] read-receipt read failed:', e?.cause?.message || e?.message);
    }
    const delivery = await getDeliveryStatuses(mine, externalCounts);
    for (const id of mine) if (byId[id]) byId[id].delivery = delivery[id] || null;
  }

  return msgs;
}

/**
 * A draft, in the shape the composer needs to reopen it. Drafts are ordinary rows in
 * mail_messages with is_draft = true, so this is scoped to the owner's own mailbox row.
 */
export async function getDraft(userId: string, draftId: string): Promise<any | null> {
  await ensureMailSchema();
  if (!UUID_RE.test(String(draftId || ''))) return null;
  const r = await db.execute(sql`
    SELECT m.id, m.subject, m.body_text, m.body_html, m.thread_id, m.in_reply_to, m.created_at
    FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
    WHERE b.user_id = ${userId} AND b.message_id = ${draftId} AND b.folder = 'drafts' AND m.is_draft = true
    LIMIT 1
  `);
  const d = rows(r)[0];
  if (!d) return null;
  const rec = rows(await db.execute(sql`SELECT kind, email FROM mail_recipients WHERE message_id = ${draftId}`));
  const at = rows(await db.execute(sql`SELECT filename, url, mime FROM mail_attachments WHERE message_id = ${draftId}`));
  const pick = (k: string) => rec.filter((x: any) => x.kind === k).map((x: any) => x.email).join(', ');
  return {
    draftId: d.id,
    threadId: d.thread_id,
    inReplyTo: d.in_reply_to,
    subject: d.subject || '',
    body: d.body_text || '',
    to: pick('to'), cc: pick('cc'), bcc: pick('bcc'),
    attachments: at.map((a: any) => ({ url: a.url, filename: a.filename, mime: a.mime })),
    savedAt: d.created_at,
  };
}

/**
 * WHICH CONVERSATION DOES AN ARRIVING MESSAGE BELONG TO?
 *
 * In-Reply-To against rfc_message_id is the correct answer and is tried first. It fails often in
 * practice: plenty of clients drop the header on a forward, and a reply typed into a webmail that
 * lost the reference arrives as an orphan. When that happens the message used to start a brand new
 * thread with the same subject, which is how a conversation ends up scattered down the list.
 *
 * The fallback is deliberately narrow — same normalised subject, same counterpart address, inside
 * 30 days, in this user's own mailbox. Merging on subject alone would staple every "Hello" in the
 * building into one thread, so it is not done.
 */
export async function findThreadForInbound(p: {
  userId: string; inReplyTo?: string | null; subject?: string | null; fromEmail?: string | null;
}): Promise<string | null> {
  try {
    if (p.inReplyTo) {
      const t = rows(await db.execute(sql`SELECT thread_id FROM mail_messages WHERE rfc_message_id = ${p.inReplyTo} LIMIT 1`));
      if (t[0]) return String(t[0].thread_id);
    }
    const base = normalizeSubject(p.subject || '');
    if (!base || !p.fromEmail) return null;
    const t = rows(await db.execute(sql`
      SELECT b.thread_id FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
      WHERE b.user_id = ${p.userId}
        AND m.created_at > NOW() - INTERVAL '30 days'
        AND lower(regexp_replace(coalesce(m.subject,''), '^((re|fw|fwd)\\s*:\\s*)+', '', 'i')) = ${base}
        AND (lower(coalesce(m.from_email,'')) = ${normalizeEmail(p.fromEmail)}
             OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND lower(coalesce(r.email,'')) = ${normalizeEmail(p.fromEmail)}))
      ORDER BY m.created_at DESC LIMIT 1
    `));
    return t[0] ? String(t[0].thread_id) : null;
  } catch (e: any) {
    console.error('[mail] thread match failed:', e?.cause?.message || e?.message);
    return null;
  }
}

export function normalizeSubject(s: string): string {
  return String(s || '').replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
}

// =================================================================================================
// ONE DOOR FOR ARRIVING MAIL
// =================================================================================================
//
// WHAT WAS WRONG. Mail reaches this product two ways — the webhook at src/pages/api/mail/inbound.ts
// (a Cloudflare Email Worker or any MTA pipe) and the IMAP pull in src/lib/mail-imap.ts — and each
// carried its OWN hand-written copy of the delivery. The two copies had drifted, in the way two
// copies always do, and every difference was invisible from any screen:
//
//   * BOTH re-implemented "which thread does this belong to?" as a single lookup of In-Reply-To
//     against rfc_message_id. findThreadForInbound() — written for exactly this, sitting in this
//     file, carrying the subject/counterpart/30-day fallback for the very common case of a client
//     that dropped the header — was imported by NOTHING. So a reply that lost its reference started
//     a brand new thread and the conversation scattered down the list.
//   * THE RULES NEVER RAN AT ARRIVAL. An administrator could build a full set of filters on
//     /admin/mail/rules, watch them save, list back and (since the backfill was added) run over old
//     mail — and no message has ever been filed by one as it landed. applyRulesToMessage() existed
//     and this path did not call it.
//   * ONLY THE WEBHOOK TOLD THE RECIPIENT. mail arriving over IMAP was inserted into mail_box and
//     announced to nobody, so whether you were notified about your own mail depended on which
//     transport the company happened to be using that week.
//
// This is the one engine both doors now go through. Every step after the message row is best-effort
// and REPORTED, never swallowed: the mail is already delivered and must stay delivered even if the
// filing or the notification fails, but "the rules did not run" is a fact worth having in the log
// rather than a silence.
//
// DE-DUPLICATION IS THE CALLER'S JOB and stays there — the IMAP puller has its own UID watermark
// plus an rfc-id check, and the webhook is fired once per message by its sender.
export interface InboundDelivery {
  /** The recipient in THIS product, already resolved from the envelope address. */
  userId: string;
  /** The address the mail was sent to, as stored on the recipient row. */
  email: string;
  name: string | null;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  /** The RFC Message-Id. The caller mints a synthetic one when the sender omitted it. */
  rfcMessageId: string;
  inReplyTo: string | null;
}

export interface InboundResult {
  messageId: string;
  threadId: string;
  /** What the filing rules changed, if any ran. Empty is a real answer, not a failure. */
  ruleActions: string[];
}

/** Deliver one arriving message to one recipient: thread it, store it, file it, announce it. */
export async function deliverInbound(d: InboundDelivery): Promise<InboundResult> {
  // THE ENGINE, NOT A SECOND COPY OF ITS FIRST LINE. In-Reply-To is still tried first inside
  // findThreadForInbound(); what is new here is that a reply which lost the header now rejoins its
  // conversation instead of starting a fresh one.
  const threadId = (await findThreadForInbound({
    userId: d.userId,
    inReplyTo: d.inReplyTo,
    subject: d.subject,
    fromEmail: d.fromEmail,
  })) || randomUUID();

  const ins = rows(await db.execute(sql`
    INSERT INTO mail_messages (thread_id, subject, from_user_id, from_email, from_name, body_html, body_text, snippet, direction, rfc_message_id, in_reply_to)
    VALUES (${threadId}, ${d.subject}, NULL, ${d.fromEmail}, ${d.fromName}, ${d.bodyHtml || null}, ${d.bodyText || null}, ${makeSnippet(d.bodyText, d.bodyHtml)}, 'inbound', ${d.rfcMessageId}, ${d.inReplyTo})
    RETURNING id`));
  const messageId = String(ins[0].id);

  await db.execute(sql`
    INSERT INTO mail_recipients (message_id, kind, user_id, email, name)
    VALUES (${messageId}, 'to', ${d.userId}, ${d.email}, ${d.name})`);
  await db.execute(sql`
    INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
    VALUES (${d.userId}, ${messageId}, ${threadId}, 'inbox', false)
    ON CONFLICT (user_id, message_id) DO NOTHING`);

  // ---- THE FILTERS RUN, AT LAST, ON THE MESSAGE THAT JUST LANDED ---------------------------------
  //
  // Dynamically imported so the advanced-mail schema is only ever bootstrapped on a path that
  // actually needs it, and so this core module keeps no static edge to the layer built on top of it.
  // The message is already in the inbox; a filing failure leaves it in the inbox, which is the safe
  // direction, and says so in the log.
  let ruleActions: string[] = [];
  try {
    const { ensureMailAdvancedSchema, applyRulesToMessage } = await import('@/lib/mail-advanced');
    await ensureMailAdvancedSchema();
    const res = await applyRulesToMessage(
      d.userId,
      { message_id: messageId, folder: 'inbox', is_read: false, is_starred: false, labels: [] },
      { from: d.fromEmail, to: d.email, subject: d.subject, body: d.bodyText },
    );
    ruleActions = res.actions;
  } catch (e: any) {
    console.error('[mail] arrival filters did NOT run for message', messageId, '-', e?.cause?.message || e?.message);
  }

  // ---- AND THE PERSON IS TOLD, WHICHEVER TRANSPORT BROUGHT IT ------------------------------------
  //
  // A rule may have marked it read or filed it out of the inbox; the recipient is still told, because
  // the alternative is a mailbox that changes underneath somebody with no signal at all.
  try {
    const { pushNotify } = await import('@/lib/push');
    await pushNotify.inboundMail(d.userId, d.fromName || d.fromEmail || 'someone', d.subject);
  } catch (e: any) {
    console.error('[mail] recipient NOT told about message', messageId, '-', e?.cause?.message || e?.message);
  }

  return { messageId, threadId, ruleActions };
}

export async function markThreadRead(userId: string, threadId: string) {
  await db.execute(sql`UPDATE mail_box SET is_read = true WHERE user_id = ${userId} AND thread_id = ${threadId} AND is_read = false`);
}
