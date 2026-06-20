// IMAP fetcher — pulls new messages from a mailbox (GoDaddy, Office365, Gmail
// etc.) and inserts them into mail_messages / mail_box. Designed to be called
// from a cron (Vercel cron) and from a manual "Check now" button.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema, resolveAddress, makeSnippet, getMailConfig } from '@/lib/mail';
import { randomUUID } from 'node:crypto';

function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureImapSchema() {
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_host TEXT`); } catch (_) {}
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_port INT`); } catch (_) {}
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_user TEXT`); } catch (_) {}
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_pass TEXT`); } catch (_) {}
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_secure BOOLEAN NOT NULL DEFAULT true`); } catch (_) {}
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_last_uid INT NOT NULL DEFAULT 0`); } catch (_) {}
  try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_last_run TIMESTAMPTZ`); } catch (_) {}
}

export interface ImapTestParams {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
}

export async function verifyImap(p: ImapTestParams): Promise<{ ok: boolean; detail: string; hint?: string; mailboxes?: string[] }> {
  if (!p.host) return { ok: false, detail: 'IMAP host is empty', hint: 'GoDaddy: imap.secureserver.net · Office365: outlook.office365.com · Gmail: imap.gmail.com' };
  if (!p.user || !p.pass) return { ok: false, detail: 'Username or password missing' };
  const port = p.port || 993;
  const secure = p.secure === false ? false : true;
  const client = new ImapFlow({
    host: p.host, port, secure,
    auth: { user: p.user, pass: p.pass },
    logger: false,
  });
  try {
    await client.connect();
    const list: string[] = [];
    for (const m of await client.list()) list.push(m.path);
    await client.logout();
    return { ok: true, detail: `Connected to ${p.host}:${port}. Found ${list.length} folders.`, mailboxes: list.slice(0, 10) };
  } catch (e: any) {
    const msg = (e?.message || 'IMAP connect failed').toString();
    const low = msg.toLowerCase();
    let hint: string | undefined;
    if (low.includes('auth') || low.includes('login') || low.includes('bad credentials')) hint = 'IMAP auth failed. Use FULL email as username. GoDaddy Workspace + M365: same password as webmail. If 2FA is on, generate an app password.';
    else if (low.includes('etimedout') || low.includes('econnrefused')) hint = 'Server did not respond. Try port 993 (SSL) — most IMAP providers require it.';
    else if (low.includes('certificate')) hint = 'Cert problem — usually a host typo. GoDaddy = imap.secureserver.net.';
    else if (low.includes('enotfound') || low.includes('getaddrinfo')) hint = 'Could not resolve host — check the spelling.';
    try { await client.logout(); } catch (_) {}
    return { ok: false, detail: msg, hint };
  }
}

export async function saveImapConfig(p: { host?: string; port?: number; user?: string; pass?: string; secure?: boolean }) {
  await ensureMailSchema();
  await ensureImapSchema();
  const s = (v: any) => { const t = (v ?? '').toString().trim(); return t === '' ? null : t; };
  await db.execute(sql`
    INSERT INTO mail_config (id, imap_host, imap_port, imap_user, imap_pass, imap_secure, updated_at)
    VALUES (1, ${s(p.host)}, ${p.port == null ? null : Number(p.port)}, ${s(p.user)}, ${s(p.pass)},
            ${p.secure == null ? null : !!p.secure}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      imap_host = COALESCE(EXCLUDED.imap_host, mail_config.imap_host),
      imap_port = COALESCE(EXCLUDED.imap_port, mail_config.imap_port),
      imap_user = COALESCE(EXCLUDED.imap_user, mail_config.imap_user),
      imap_pass = COALESCE(EXCLUDED.imap_pass, mail_config.imap_pass),
      imap_secure = COALESCE(${p.secure == null ? null : !!p.secure}::boolean, mail_config.imap_secure),
      updated_at = NOW()
  `);
}

export async function getImapConfig() {
  await ensureMailSchema();
  await ensureImapSchema();
  let row: any = {};
  try { row = rows(await db.execute(sql`SELECT imap_host, imap_port, imap_user, imap_pass, imap_secure, imap_last_uid, imap_last_run FROM mail_config WHERE id = 1 LIMIT 1`))[0] || {}; } catch (_) {}
  return {
    host: row.imap_host || '',
    port: Number(row.imap_port || 993),
    user: row.imap_user || '',
    pass: row.imap_pass || '',
    secure: row.imap_secure == null ? true : !!row.imap_secure,
    lastUid: Number(row.imap_last_uid || 0),
    lastRun: row.imap_last_run || null,
  };
}

// Fetch new messages since the last seen UID, parse, and insert. Idempotent —
// re-running will not produce duplicates because we record last_uid.
export async function pollImapInbox(opts: { force?: boolean; limit?: number } = {}): Promise<{ ok: boolean; fetched: number; delivered: number; error?: string; detail?: string }> {
  const cfg = await getImapConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return { ok: false, fetched: 0, delivered: 0, error: 'IMAP not configured' };
  const since = cfg.lastUid;
  const limit = opts.limit || 50;

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  let fetched = 0, delivered = 0;
  let maxUid = since;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const range = since > 0 ? `${since + 1}:*` : '1:*';
      for await (const msg of client.fetch(range, { uid: true, source: true, envelope: true, internalDate: true })) {
        if (!opts.force && msg.uid <= since) continue;
        fetched++;
        if (msg.uid > maxUid) maxUid = msg.uid;
        if (fetched > limit) break;
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          const fromAddr = (parsed.from?.value?.[0]?.address || '').toString().toLowerCase();
          const fromName = (parsed.from?.value?.[0]?.name || '').toString().slice(0, 200);
          const toList = (parsed.to as any)?.value || [];
          const toAddrs = toList.map((a: any) => a.address).filter(Boolean).map((a: string) => a.toLowerCase());
          const subject = (parsed.subject || '(no subject)').toString().slice(0, 500);
          const bodyText = (parsed.text || '').toString();
          const bodyHtml = (parsed.html || '').toString();
          const rfcId = (parsed.messageId || `<${randomUUID()}@inbound>`).toString();
          const inReplyTo = (parsed.inReplyTo || '').toString() || null;

          const seen = new Set<string>();
          for (const addr of toAddrs) {
            const resolved = await resolveAddress(addr);
            if (!resolved.userId || seen.has(resolved.userId)) continue;
            seen.add(resolved.userId);

            let threadId: string | null = null;
            if (inReplyTo) {
              const t = rows(await db.execute(sql`SELECT thread_id FROM mail_messages WHERE rfc_message_id = ${inReplyTo} LIMIT 1`));
              if (t[0]) threadId = t[0].thread_id;
            }
            if (!threadId) threadId = randomUUID();

            // Skip if we've already delivered this exact RFC id to this user
            const dupe = rows(await db.execute(sql`
              SELECT 1 FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
              WHERE b.user_id = ${resolved.userId} AND m.rfc_message_id = ${rfcId} LIMIT 1
            `));
            if (dupe[0]) continue;

            const ins = rows(await db.execute(sql`
              INSERT INTO mail_messages (thread_id, subject, from_user_id, from_email, from_name, body_html, body_text, snippet, direction, rfc_message_id, in_reply_to)
              VALUES (${threadId}, ${subject}, NULL, ${fromAddr}, ${fromName}, ${bodyHtml || null}, ${bodyText || null}, ${makeSnippet(bodyText, bodyHtml)}, 'inbound', ${rfcId}, ${inReplyTo})
              RETURNING id
            `));
            const messageId = ins[0].id;
            await db.execute(sql`INSERT INTO mail_recipients (message_id, kind, user_id, email, name) VALUES (${messageId}, 'to', ${resolved.userId}, ${resolved.email}, ${resolved.name})`);
            await db.execute(sql`
              INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
              VALUES (${resolved.userId}, ${messageId}, ${threadId}, 'inbox', false)
              ON CONFLICT (user_id, message_id) DO NOTHING
            `);
            delivered++;
          }
        } catch (_) { /* parse failure: skip but record UID */ }
      }
    } finally {
      lock.release();
    }
    await client.logout();

    // Persist watermark + run time
    await db.execute(sql`UPDATE mail_config SET imap_last_uid = ${maxUid}, imap_last_run = NOW() WHERE id = 1`).catch(() => {});

    return { ok: true, fetched, delivered, detail: `Fetched ${fetched} new message(s) since UID ${since}; ${delivered} delivered to a known mailbox; max UID is now ${maxUid}.` };
  } catch (e: any) {
    try { await client.logout(); } catch (_) {}
    return { ok: false, fetched, delivered, error: e?.message || 'IMAP poll failed' };
  }
}
