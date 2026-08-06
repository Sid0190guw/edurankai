// src/lib/mail-transport.ts - outbound email delivery to EXTERNAL addresses.
// Config comes from the DB (UI-editable, /admin/mail/settings) and falls back to
// environment vars. Priority: SMTP (your VPS) -> Resend HTTP API -> log only.
import nodemailer from 'nodemailer';
import { getMailConfig, logOutbound } from '@/lib/mail';

export interface SendExternalParams {
  from: string;          // "Name <addr@edurankai.in>"
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string;
  attachments?: { filename: string; path?: string; href?: string }[];
  /**
   * Write an email_logs row for this send. Default true, because most callers here (password
   * resets, offer letters, reminders) have no other record of the attempt.
   *
   * /api/mail/send and /api/mail/scheduled-send set it FALSE: they log one row per recipient keyed
   * by the mail_messages UUID, which is what the reading pane and /admin/mail/analytics read. A
   * second row per send from here would double every status count on that page — and until now it
   * silently never landed at all, because this function passed an RFC id into a uuid column and
   * caught the error.
   */
  logToDb?: boolean;
}

export interface SendResult { ok: boolean; provider: 'smtp' | 'resend' | 'none'; id?: string; error?: string; }

export async function transportStatus(): Promise<{ mode: 'smtp' | 'resend' | 'none'; detail: string }> {
  const c = await getMailConfig();
  if (c.smtpHost) return { mode: 'smtp', detail: `${c.smtpHost}:${c.smtpPort}` };
  return { mode: 'none', detail: 'No SMTP transport configured (set it in Mail Settings)' };
}

export interface VerifySmtpParams {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  insecure?: boolean;
}

export async function verifySmtp(p: VerifySmtpParams): Promise<{ ok: boolean; detail: string; hint?: string }> {
  if (!p.host) return { ok: false, detail: 'SMTP host is empty', hint: 'Type your mail server hostname (e.g. mail.yourdomain.com or smtp.office365.com)' };
  if (!p.user || !p.pass) return { ok: false, detail: 'Username or password missing', hint: 'Most SMTP servers require auth. Use the full email for username and an app password if 2FA is on.' };
  // Auto-correct: 587 → STARTTLS (secure:false), 465 → implicit TLS (secure:true).
  const port = p.port || 587;
  const secure = port === 465 ? true : port === 587 ? false : !!p.secure;
  try {
    const transport = nodemailer.createTransport({
      host: p.host,
      port,
      secure,
      auth: { user: p.user, pass: p.pass },
      tls: { rejectUnauthorized: !p.insecure },
      connectionTimeout: 12000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    await transport.verify();
    return { ok: true, detail: `Authenticated as ${p.user} against ${p.host}:${port} (${secure ? 'implicit TLS' : 'STARTTLS'})` };
  } catch (e: any) {
    const msg = (e?.message || 'connect failed').toString();
    let hint: string | undefined;
    const low = msg.toLowerCase();
    if (low.includes('wrong version number') || low.includes('tlsv1') || low.includes('ssl routines')) hint = 'TLS mode mismatch. Port 587 uses STARTTLS — UNTICK "Use TLS/SSL" for port 587. Only tick it for port 465.';
    else if (low.includes('etimedout') || low.includes('econnrefused')) hint = 'The server did not respond on that port. Try 587 (STARTTLS) or 465 (TLS). Check that the firewall allows outbound to your mail host.';
    else if (low.includes('self-signed') || low.includes('self signed') || low.includes('certificate')) hint = 'TLS certificate problem. Tick "Allow self-signed certs" below if you trust this server.';
    else if (low.includes('authentication') || low.includes('535') || low.includes('invalid login')) hint = 'Auth failed. For Office365 / GoDaddy use the FULL email address as username and an app password if 2FA is on.';
    else if (low.includes('enotfound') || low.includes('getaddrinfo')) hint = 'Could not resolve that hostname — check the SMTP host spelling.';
    return { ok: false, detail: msg, hint };
  }
}

// Own SMTP only (your VPS). NO third-party HTTP API. Transient failures are
// retried with backoff; every attempt's final outcome is logged to email_logs.
export async function sendExternal(p: SendExternalParams): Promise<SendResult> {
  const c = await getMailConfig();
  const toStr = Array.isArray(p.to) ? p.to.join(', ') : p.to;
  const shouldLog = p.logToDb !== false;
  // p.messageId is an RFC id ("<uuid@host>"), and email_logs.message_id is uuid-typed. Passing it
  // there threw into a .catch(() => {}) on every single send, which is why a failed SMTP attempt
  // could leave no trace anywhere. It has its own column now.
  const logLine = async (status: string, error: string | null) => {
    if (!shouldLog) return;
    try {
      await logOutbound({ messageId: '', rfcMessageId: p.messageId || null, to: toStr, from: p.from, subject: p.subject, status, provider: status === 'no_transport' ? 'none' : 'smtp', error });
    } catch (e: any) {
      console.error('[mail-transport] could not write email_logs:', e?.cause?.message || e?.message);
    }
  };

  if (!c.smtpHost) {
    await logLine('no_transport', 'No SMTP configured');
    return { ok: false, provider: 'none', error: 'No SMTP transport configured (add your mail server in Mail Settings)' };
  }

  // Port-driven secure mode: 465 = implicit TLS, 587 = STARTTLS.
  const port = c.smtpPort || 587;
  const secure = port === 465 ? true : port === 587 ? false : !!c.smtpSecure;
  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port,
    secure,
    auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined,
    tls: { rejectUnauthorized: !(c.smtpInsecure || process.env.SMTP_INSECURE === 'true') },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    pool: true,
    maxConnections: 3,
  });

  // Providers reject or spam-folder a From that doesn't match the account we
  // authenticate as (sender-address enforcement). Keep the caller's display
  // name but normalize the address to the configured from_address; the
  // caller's intended address becomes Reply-To so responses still route.
  let fromHeader = p.from;
  let replyTo = p.replyTo;
  const m = /^(.*?)<\s*([^>]+)\s*>\s*$/.exec(p.from || '');
  const callerName = (m ? m[1] : '').trim().replace(/"/g, '') || c.fromName || 'EduRankAI';
  const callerAddr = (m ? m[2] : p.from || '').trim();
  if (c.fromAddress && callerAddr && callerAddr.toLowerCase() !== c.fromAddress.toLowerCase()) {
    fromHeader = callerName + ' <' + c.fromAddress + '>';
    if (!replyTo) replyTo = callerAddr;
  }

  const mail = {
    from: fromHeader,
    to: toStr,
    cc: p.cc && p.cc.length ? p.cc.join(', ') : undefined,
    bcc: p.bcc && p.bcc.length ? p.bcc.join(', ') : undefined,
    subject: p.subject,
    html: p.html,
    text: p.text,
    replyTo,
    messageId: p.messageId,
    inReplyTo: p.inReplyTo,
    attachments: (p.attachments || []).map((a) => ({ filename: a.filename, path: a.href || a.path })),
  };

  // Retry transient failures (greylisting, timeouts, dropped connections).
  const delays = [0, 1500, 4000];
  let lastErr = 'SMTP error';
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const info = await transport.sendMail(mail);
      await logLine('sent', null);
      try { transport.close(); } catch (_) {}
      return { ok: true, provider: 'smtp', id: info.messageId };
    } catch (e: any) {
      lastErr = (e?.message || 'SMTP error').toString();
      const transient = /timeout|etimedout|econnreset|econnrefused|esocket|greylist|\b4(2[0-9]|5[0-9])\b/i.test(lastErr);
      if (!transient) break; // permanent failure -> don't keep retrying
    }
  }
  try { transport.close(); } catch (_) {}
  console.error('[mail-transport] SMTP send failed after retries:', lastErr);
  await logLine('failed', lastErr);
  return { ok: false, provider: 'smtp', error: lastErr };
}
