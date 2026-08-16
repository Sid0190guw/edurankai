// IMAP fetcher — pulls new messages from a mailbox (GoDaddy, Office365, Gmail
// etc.) and inserts them into mail_messages / mail_box. Designed to be called
// from a cron (Vercel cron) and from a manual "Check now" button.
import { ImapFlow } from 'imapflow';
// Refuses a destination that is not a public mail host. See the note in verifyImap().
import { assertSafeMailTarget } from '@/lib/mailsec/net';
import { simpleParser } from 'mailparser';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
// deliverInbound() rather than a third hand-written copy of the delivery. This file used to thread,
// insert and stop: the message landed in mail_box, no inbound rule ran against it, and the recipient
// was told NOTHING — while the same message arriving through the webhook at /api/mail/inbound did
// get a push. Whether you heard about your own mail depended on which transport the company was
// using that week. See the block above deliverInbound() in src/lib/mail.ts.
import { ensureMailSchema, resolveAddress, getMailConfig, deliverInbound } from '@/lib/mail';
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

  // THE DESTINATION IS CHECKED BEFORE THE SOCKET OPENS. `host` and `port` reach here straight from
  // the body of POST /api/mail/imap-test, whose gate is `mail.manage` — held by all ten
  // non-applicant built-in roles, interns included. Without this, the endpoint connects wherever it
  // is told and reports back a discriminating error (ECONNREFUSED / ETIMEDOUT / ENOTFOUND /
  // certificate), which is a port scanner with a credential oracle attached. The same guard is
  // applied at the SMTP sink in src/lib/mail-transport.ts — at the sinks rather than at the three
  // endpoints, because the endpoint that got missed would be the one that mattered.
  const target = await assertSafeMailTarget(p.host, port);
  if (!target.allowed) {
    return {
      ok: false,
      detail: target.reason,
      hint: target.code === 'private-address'
        ? 'A mail server this platform can reach has to be on the public internet.'
        : undefined,
    };
  }

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
  // "NOT CONFIGURED" AND "COULD NOT BE READ" ARE DIFFERENT FACTS. This ended in `catch (_) {}` over
  // an empty object, so a failed read of mail_config produced a config with no host - and the two
  // consumers then state that as fact: pollImapInbox() answers 'IMAP not configured' and
  // /admin/mail/health draws the red "Inbound IMAP - not configured" card. An operator reading that
  // goes and re-enters credentials that were never lost. `configRead` travels with the config so a
  // caller can tell the two apart.
  let configRead = true;
  try { row = rows(await db.execute(sql`SELECT imap_host, imap_port, imap_user, imap_pass, imap_secure, imap_last_uid, imap_last_run FROM mail_config WHERE id = 1 LIMIT 1`))[0] || {}; }
  catch (e: any) {
    configRead = false;
    console.error('[mail-imap] IMAP config could not be read:', e?.cause?.message || e?.message);
  }
  return {
    configRead,
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
  if (!cfg.configRead) {
    return { ok: false, fetched: 0, delivered: 0, error: 'The IMAP settings could not be read, so no poll was attempted. This is not the same as IMAP being unconfigured - nothing has been changed or lost.' };
  }
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
        // THE LIMIT USED TO EAT ONE MESSAGE, PERMANENTLY. The order was `fetched++; maxUid =
        // msg.uid; if (fetched > limit) break;` - so on the (limit + 1)th message the watermark was
        // raised to ITS uid and the loop broke without delivering it. The watermark is persisted
        // below, so the next poll starts AFTER that message and it is never fetched again: on any
        // mailbox with more than `limit` new messages, exactly one real email was destroyed on every
        // poll, and the only outward sign was `fetched` exceeding `delivered` by one. The bound is
        // now tested BEFORE this message is claimed, so the watermark never passes a message that
        // was not processed.
        if (fetched >= limit) break;
        fetched++;
        if (msg.uid > maxUid) maxUid = msg.uid;
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

            // DE-DUPLICATION STAYS HERE. It is the puller's own problem: a re-poll with `force`, or
            // a watermark that went backwards, re-reads UIDs already delivered. deliverInbound() is
            // deliberately not idempotent — the webhook is fired once per message by its sender — so
            // this check must come BEFORE the call, not inside it.
            const dupe = rows(await db.execute(sql`
              SELECT 1 FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
              WHERE b.user_id = ${resolved.userId} AND m.rfc_message_id = ${rfcId} LIMIT 1
            `));
            if (dupe[0]) continue;

            await deliverInbound({
              userId: resolved.userId,
              email: resolved.email,
              name: resolved.name,
              fromEmail: fromAddr, fromName, subject, bodyText, bodyHtml,
              rfcMessageId: rfcId,
              inReplyTo,
            });
            delivered++;
          }
        } catch (e: any) {
          // NOT A BARE catch (_) ANY MORE. This swallowed everything — a malformed MIME part, yes,
          // but equally a failed INSERT or a database that had gone away — and the loop then recorded
          // the UID as processed, so the message was never fetched again. Mail could be dropped
          // permanently and the only outward sign was `fetched` exceeding `delivered` by a number
          // nobody was looking at. The UID watermark still advances (a message that cannot be parsed
          // must not wedge the poll for every message behind it), but the reason is now on the record.
          console.error('[mail-imap] message UID', msg.uid, 'was NOT delivered -', e?.cause?.message || e?.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();

    // Persist watermark + run time. NOT swallowed: a watermark that did not save means the next
    // poll re-reads everything since the old UID. The per-message de-duplication above keeps that
    // from producing duplicates, so it is a cost problem rather than a correctness one - but a poll
    // that silently cannot record its own progress is exactly the thing an operator needs told.
    let watermarkSaved = true;
    try {
      await db.execute(sql`UPDATE mail_config SET imap_last_uid = ${maxUid}, imap_last_run = NOW() WHERE id = 1`);
    } catch (e: any) {
      watermarkSaved = false;
      console.error('[mail-imap] the IMAP watermark could not be saved:', e?.cause?.message || e?.message);
    }

    return {
      ok: true, fetched, delivered,
      detail: `Fetched ${fetched} new message(s) since UID ${since}; ${delivered} delivered to a known mailbox; max UID is now ${maxUid}.`
        + (watermarkSaved ? '' : ' The position marker could NOT be saved, so the next poll will re-read from UID ' + since + '.'),
    };
  } catch (e: any) {
    try { await client.logout(); } catch (_) {}
    // e.message on a wrapped driver error is only the failed statement; the reason is on e.cause.
    const reason = e?.cause?.message || e?.message || 'IMAP poll failed';
    console.error('[mail-imap] poll failed:', reason);
    return { ok: false, fetched, delivered, error: reason };
  }
}
