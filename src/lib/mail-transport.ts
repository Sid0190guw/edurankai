// src/lib/mail-transport.ts - outbound email delivery to EXTERNAL addresses.
// Config comes from the DB (UI-editable, /admin/mail/settings) and falls back to
// environment vars. Priority: SMTP (your VPS) -> Resend HTTP API -> log only.
import nodemailer from 'nodemailer';
// Refuses a destination that is not a public mail host. See the note in verifySmtp().
import { assertSafeMailTarget } from '@/lib/mailsec/net';
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
  /**
   * ATTACHMENTS ARE LINKS IN THE BODY, AND THIS TYPE NO LONGER LETS THEM BE ANYTHING ELSE.
   *
   * It used to be `{ filename, path?, href? }`, and both of those fields were passed straight to
   * nodemailer. `path` makes nodemailer READ A LOCAL FILE; `href` makes it FETCH A URL and embed the
   * response in the delivered message. Neither `disableFileAccess` nor `disableUrlAccess` was set on
   * any transport in this repository, so both were live capabilities — a caller that could name a
   * path could have `/etc/passwd`, or the deployment's own environment file, mailed to an address of
   * its choosing, and one that could name a URL had a full-response SSRF with the answer delivered
   * by email.
   *
   * No caller passed either today: /api/mail/send and scheduled-send both pass `[]`, deliberately,
   * with a comment saying why. The danger was the SHAPE — an interface that advertises `path` gets
   * used, and the mail platform being built alongside this one has an attachment model with byte
   * content looking for somewhere to go.
   *
   * `content` is the only form left: bytes the caller already has and has already validated through
   * src/lib/mail-attachments.ts. Nothing here reaches the filesystem or the network on its own.
   */
  attachments?: { filename: string; content: Buffer | string; contentType?: string }[];
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
  /**
   * Extra RFC5322 headers.
   *
   * ADDED FOR BULK SENDING, AND NOT OPTIONAL FOR IT. A campaign message needs List-Unsubscribe and
   * List-Unsubscribe-Post (RFC 8058) or the large providers will not offer the one-click opt-out and
   * will treat the mail as less trustworthy for it, and it needs a `Precedence: bulk` so an
   * out-of-office does not answer a newsletter. Nothing else in this file changes: callers that
   * pass no headers produce byte-identical mail to before.
   */
  headers?: Record<string, string>;
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

  // THE DESTINATION IS CHECKED AT THE POINT OF CONNECTION, NOT AT THE ENDPOINT.
  //
  // `host` and `port` arrive here from a request body — /api/mail/verify and /api/mail/test both
  // pass them through untouched — and this function then opens a TCP connection and reports, in
  // discriminating detail, what happened: ECONNREFUSED, ETIMEDOUT, ENOTFOUND and a TLS version
  // mismatch all produce different hints. That is a port scanner with an authentication oracle
  // attached, and `mail.manage` — which every one of the ten non-applicant built-in roles holds,
  // interns included — is the only thing in front of it.
  //
  // Guarding here rather than in each endpoint is deliberate: there are three callers today and the
  // one that got missed would be the one that mattered. assertSafeMailTarget() resolves the name and
  // refuses if ANY answer is loopback, link-local (where cloud metadata lives), private, CGNAT or
  // reserved — and refuses a port that is not a mail port, so this cannot be pointed at a database
  // or an internal admin interface.
  const target = await assertSafeMailTarget(p.host, port);
  if (!target.allowed) {
    return {
      ok: false,
      detail: target.reason,
      hint: target.code === 'private-address'
        ? 'A mail server this platform can reach has to be on the public internet. If yours genuinely is on a private network, that needs MAIL_ALLOW_PRIVATE_SMTP set on the deployment.'
        : undefined,
    };
  }

  try {
    const transport = nodemailer.createTransport({
      host: p.host,
      port,
      secure,
      auth: { user: p.user, pass: p.pass },
      tls: { rejectUnauthorized: !p.insecure },
      // Belt as well as braces: the attachment type no longer expresses a path or a URL, and the
      // transport is additionally told it may not open either. Two independent things would have to
      // regress before nodemailer reads a file or makes a request on our behalf. Note that the
      // installed version carries GHSA-p6gq-j5cr-w38f, in which a message-level `raw` option
      // bypasses exactly these two flags — which is why the type change above is the primary
      // control and these are the second line, not the first.
      disableFileAccess: true,
      disableUrlAccess: true,
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

  /**
 * The total time one SMTP send may take, including its retries.
 *
 * Declared as a FUNCTION and read per call, so it is hoisted above every use in this file -- `const`
 * is not, and a const used above its declaration has taken pages down on this project.
 *
 * Twenty seconds is far more than a healthy send needs (this deployment sends short transactional
 * mail; the house rule is links, not attachments, so there are no large payloads to push) and far
 * less than the ~95 seconds the previous timeouts multiplied out to.
 */
function sendBudgetMs(): number {
  const n = Number(process.env.SMTP_SEND_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 20000;
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
    // See verifySmtp() above: the attachment type is the control, these are the second line.
    disableFileAccess: true,
    disableUrlAccess: true,
    // DERIVED FROM ONE BUDGET, so the worst case is a number somebody chose rather than the product
    // of three that nobody multiplied together. See sendBudgetMs() and the deadline in the retry loop
    // below: 15000 + 10000 + 30000 per attempt, times three attempts, plus the backoff, was about
    // NINETY-FIVE SECONDS inside a single invocation -- and /api/auth/forgot-password awaits this on
    // a public, unauthenticated route. The platform kills the function long before that, so the
    // caller never learned anything and the visitor got a gateway error instead of "we could not
    // send the email".
    connectionTimeout: Math.min(10000, Math.floor(sendBudgetMs() / 2)),
    greetingTimeout: Math.min(8000, Math.floor(sendBudgetMs() / 2)),
    socketTimeout: sendBudgetMs(),
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
    // Bytes only. `path` and `href` are gone from the type above — see the note there.
    attachments: (p.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
    // Undefined rather than {} when there are none, so an existing caller's message is unchanged.
    headers: p.headers && Object.keys(p.headers).length ? p.headers : undefined,
  };

  // Retry transient failures (greylisting, timeouts, dropped connections).
  //
  // BOUNDED AS A WHOLE, not only per attempt. Three attempts each allowed to run to the socket
  // timeout, with the backoff between them, is a total this code never stated anywhere -- and the
  // total is what the platform enforces. The deadline is checked BEFORE paying for a retry, so a
  // slow host costs one attempt and an honest failure rather than an invocation the gateway kills.
  const deadline = Date.now() + sendBudgetMs();
  const delays = [0, 1500, 4000];
  let lastErr = 'SMTP error';
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0 && Date.now() + delays[attempt] >= deadline) {
      lastErr = lastErr + ' (gave up after ' + (attempt) + ' attempt(s); the send budget was spent)';
      break;
    }
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
