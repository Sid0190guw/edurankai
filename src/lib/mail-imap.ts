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
import { ensureMailSchema, resolveInboundRecipients, getMailConfig, deliverInbound } from '@/lib/mail';
import { normalizeInboundMessageId } from '@/lib/mail-inbound-routing';
import { assertMailSecretReadableBeforeReplace, decodeMailSecret, encodeMailSecret } from '@/lib/mail-secrets';
import { cryptoFailureCode, cryptoFailureMessage } from '@/lib/crypto';
import { diagnoseImapFailure, type MailConnectionDiagnostic, type MailConnectionStage } from '@/lib/mail-connection-diagnostics';

function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export async function ensureImapSchema() {
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

export async function verifyImap(p: ImapTestParams): Promise<{ ok: boolean; detail: string; hint?: string; diagnostic?: MailConnectionDiagnostic }> {
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
  let stage: MailConnectionStage = 'connection';
  try {
    await client.connect();
    stage = 'mailbox_listing';
    const list: string[] = [];
    for (const m of await client.list()) list.push(m.path);
    await client.logout();
    return { ok: true, detail: 'IMAP connection, authentication, and mailbox listing succeeded.' };
  } catch (error: any) {
    const diagnostic = diagnoseImapFailure(error, stage);
    let hint: string | undefined;
    if (diagnostic.code === 'IMAP_AUTH_REJECTED') hint = 'The server rejected the login/authentication command. Verify the account authorization with the mail provider; do not paste credentials into chat.';
    else if (diagnostic.code === 'IMAP_CONNECTION_TIMEOUT' || diagnostic.code === 'IMAP_CONNECTION_FAILURE') hint = 'Check the IMAP host, port, TLS setting, and outbound network access.';
    else if (diagnostic.code === 'IMAP_TLS_FAILURE') hint = 'Check the IMAP TLS mode and certificate for the configured host and port.';
    else if (diagnostic.code === 'IMAP_DNS_FAILURE') hint = 'Check the IMAP host name in mail settings.';
    try { await client.logout(); } catch (_) {}
    console.error('[mail-imap] verification failed:', diagnostic.code, diagnostic.stage, diagnostic.command || '', diagnostic.protocolStatus || '', diagnostic.protocolCode || '');
    return { ok: false, detail: diagnostic.detail, hint, diagnostic };
  }
}

export async function saveImapConfig(p: { host?: string; port?: number; user?: string; pass?: string; secure?: boolean }) {
  await ensureMailSchema();
  await ensureImapSchema();
  const s = (v: any) => { const t = (v ?? '').toString().trim(); return t === '' ? null : t; };
  let expectedPass: unknown = null;
  if (s(p.pass)) {
    const current = rows(await db.execute(sql`SELECT imap_pass FROM mail_config WHERE id = 1 LIMIT 1`))[0] || {};
    expectedPass = current.imap_pass ?? null;
    assertMailSecretReadableBeforeReplace(current.imap_pass, 'imap_pass');
  }
  const encryptedPass = encodeMailSecret(p.pass, 'imap_pass');
  const result = await db.execute(sql`
    INSERT INTO mail_config (id, imap_host, imap_port, imap_user, imap_pass, imap_secure, updated_at)
    VALUES (1, ${s(p.host)}, ${p.port == null ? null : Number(p.port)}, ${s(p.user)}, ${encryptedPass},
            ${p.secure == null ? null : !!p.secure}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      imap_host = COALESCE(EXCLUDED.imap_host, mail_config.imap_host),
      imap_port = COALESCE(EXCLUDED.imap_port, mail_config.imap_port),
      imap_user = COALESCE(EXCLUDED.imap_user, mail_config.imap_user),
      imap_pass = COALESCE(EXCLUDED.imap_pass, mail_config.imap_pass),
      imap_secure = COALESCE(${p.secure == null ? null : !!p.secure}::boolean, mail_config.imap_secure),
      updated_at = NOW()
    ${s(p.pass) ? sql`WHERE mail_config.imap_pass IS NOT DISTINCT FROM ${expectedPass}` : sql``}
    RETURNING id
  `);
  if (s(p.pass) && rows(result).length !== 1) {
    throw new Error('The saved IMAP password changed during this save. Reload settings and retry.');
  }
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
  let readError = '';
  let secretError = '';
  let secretErrorCode = '';
  let pass = '';
  try {
    row = rows(await db.execute(sql`SELECT imap_host, imap_port, imap_user, imap_pass, imap_secure, imap_last_uid, imap_last_run FROM mail_config WHERE id = 1 LIMIT 1`))[0] || {};
  }
  catch (e: any) {
    configRead = false;
    readError = String(e?.cause?.message || e?.message || 'Database read failed.');
    console.error('[mail-imap] IMAP config could not be read:', 'database_error');
  }
  if (configRead) {
    try {
      pass = decodeMailSecret(row.imap_pass, 'imap_pass');
    } catch (error) {
      configRead = false;
      secretError = cryptoFailureMessage(error);
      secretErrorCode = cryptoFailureCode(error);
      console.error('[mail-imap] stored mail secret unavailable:', 'imap_pass', secretErrorCode);
    }
  }
  return {
    configRead,
    readError,
    secretError,
    secretErrorCode,
    host: row.imap_host || '',
    port: Number(row.imap_port || 993),
    user: row.imap_user || '',
    pass,
    secure: row.imap_secure == null ? true : !!row.imap_secure,
    lastUid: Number(row.imap_last_uid || 0),
    lastRun: row.imap_last_run || null,
  };
}

// Fetch new messages since the last seen UID, parse, and insert. Idempotent —
// re-running will not produce duplicates because we record last_uid.
export async function pollImapInbox(opts: { force?: boolean; limit?: number } = {}): Promise<{ ok: boolean; fetched: number; delivered: number; error?: string; detail?: string; diagnostic?: MailConnectionDiagnostic }> {
  const cfg = await getImapConfig();
  if (!cfg.configRead) {
    const diagnostic: MailConnectionDiagnostic = { code: 'IMAP_CONFIG_READ_FAILED', stage: 'configuration', detail: 'Saved IMAP configuration could not be read; no connection was attempted.' };
    console.error('[mail-imap] poll not attempted:', diagnostic.code, cfg.secretErrorCode || 'database_error');
    return { ok: false, fetched: 0, delivered: 0, error: diagnostic.detail, diagnostic };
  }
  if (!cfg.host || !cfg.user || !cfg.pass) {
    const diagnostic: MailConnectionDiagnostic = { code: 'IMAP_NOT_CONFIGURED', stage: 'configuration', detail: 'IMAP settings are incomplete.' };
    return { ok: false, fetched: 0, delivered: 0, error: diagnostic.detail, diagnostic };
  }
  const since = cfg.lastUid;
  const limit = opts.limit || 50;

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  let fetched = 0, delivered = 0;
  let maxUid = since;
  let stage: MailConnectionStage = 'connection';
  let runFailure: MailConnectionDiagnostic | null = null;
  try {
    await client.connect();
    stage = 'mailbox_selection';
    const lock = await client.getMailboxLock('INBOX');
    try {
      const range = since > 0 ? `${since + 1}:*` : '1:*';
      stage = 'message_fetch';
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
        let parsed: any;
        try {
          parsed = await simpleParser(msg.source as Buffer);
        } catch (error: any) {
          runFailure = diagnoseImapFailure(error, 'message_parse');
          console.error('[mail-imap] message processing failed:', runFailure.code, runFailure.stage);
          break;
        }

        stage = 'message_delivery';
        try {
          const fromAddr = (parsed.from?.value?.[0]?.address || '').toString().toLowerCase();
          const fromName = (parsed.from?.value?.[0]?.name || '').toString().slice(0, 200);
          const toList = [
            ...((parsed.to as any)?.value || []),
            ...((parsed.cc as any)?.value || []),
          ];
          const toAddrs = toList.map((a: any) => a.address).filter(Boolean).map((a: string) => a.toLowerCase());
          const subject = (parsed.subject || '(no subject)').toString().slice(0, 500);
          const bodyText = (parsed.text || '').toString();
          const bodyHtml = (parsed.html || '').toString();
          const rfcId = normalizeInboundMessageId(parsed.messageId, msg.source as Buffer);
          const inReplyTo = (parsed.inReplyTo || '').toString() || null;

          const seen = new Set<string>();
          for (const addr of toAddrs) {
            const recipients = await resolveInboundRecipients(addr);
            for (const resolved of recipients) {
              if (!resolved.userId || seen.has(resolved.userId)) continue;
              seen.add(resolved.userId);

              // deliverInbound() serializes and de-duplicates by RFC message id and user, so a
              // forced poll or a retry after an interrupted delivery cannot create another copy.
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
          }
        } catch (error: any) {
          // Do not move the persisted UID watermark past a failed database write or identity lookup.
          // The next poll retries this message; the shared delivery transaction makes earlier
          // recipient copies idempotent if a multi-recipient delivery was only partly completed.
          runFailure = diagnoseImapFailure(error, 'message_delivery');
          console.error('[mail-imap] message delivery failed:', runFailure.code, runFailure.stage);
          break;
        }
        if (msg.uid > maxUid) maxUid = msg.uid;
        stage = 'message_fetch';
      }
    } finally {
      lock.release();
    }
    stage = 'logout';
    await client.logout();

    // Persist watermark + run time. NOT swallowed: a watermark that did not save means the next
    // poll re-reads everything since the old UID. The per-message de-duplication above keeps that
    // from producing duplicates, so it is a cost problem rather than a correctness one - but a poll
    // that silently cannot record its own progress is exactly the thing an operator needs told.
    let watermarkSaved = true;
    stage = 'watermark_persistence';
    try {
      await db.execute(sql`UPDATE mail_config SET imap_last_uid = ${maxUid}, imap_last_run = NOW() WHERE id = 1`);
    } catch (error: any) {
      watermarkSaved = false;
      runFailure = diagnoseImapFailure(error, 'watermark_persistence');
      console.error('[mail-imap] poll progress could not be saved:', runFailure.code, runFailure.stage);
    }

    if (runFailure) return { ok: false, fetched, delivered, error: runFailure.detail, diagnostic: runFailure };
    return {
      ok: true, fetched, delivered,
      detail: `Fetched ${fetched} new message(s) since UID ${since}; ${delivered} delivered to a known mailbox; max UID is now ${maxUid}.`
        + (watermarkSaved ? '' : ' The position marker could NOT be saved, so the next poll will re-read from UID ' + since + '.'),
    };
  } catch (error: any) {
    try { await client.logout(); } catch (_) {}
    const diagnostic = diagnoseImapFailure(error, stage);
    console.error('[mail-imap] poll failed:', diagnostic.code, diagnostic.stage, diagnostic.command || '', diagnostic.protocolStatus || '', diagnostic.protocolCode || '');
    return { ok: false, fetched, delivered, error: diagnostic.detail, diagnostic };
  }
}
