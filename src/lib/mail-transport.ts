// src/lib/mail-transport.ts - outbound email delivery to EXTERNAL addresses.
// Config comes from the DB (UI-editable, /admin/mail/settings) and falls back to
// environment vars. Priority: SMTP (your VPS) -> Resend HTTP API -> log only.
import nodemailer from 'nodemailer';
import { getMailConfig } from '@/lib/mail';

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
}

export interface SendResult { ok: boolean; provider: 'smtp' | 'resend' | 'none'; id?: string; error?: string; }

export async function transportStatus(): Promise<{ mode: 'smtp' | 'resend' | 'none'; detail: string }> {
  const c = await getMailConfig();
  if (c.smtpHost) return { mode: 'smtp', detail: `${c.smtpHost}:${c.smtpPort}` };
  if (c.resendApiKey) return { mode: 'resend', detail: 'Resend HTTP API' };
  return { mode: 'none', detail: 'No outbound transport configured' };
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

export async function sendExternal(p: SendExternalParams): Promise<SendResult> {
  const c = await getMailConfig();

  if (c.smtpHost) {
    try {
      // Port-driven secure mode: 465 = implicit TLS, 587 = STARTTLS, anything
      // else honours the saved checkbox.
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
      });
      const info = await transport.sendMail({
        from: p.from,
        to: Array.isArray(p.to) ? p.to.join(', ') : p.to,
        cc: p.cc && p.cc.length ? p.cc.join(', ') : undefined,
        bcc: p.bcc && p.bcc.length ? p.bcc.join(', ') : undefined,
        subject: p.subject,
        html: p.html,
        text: p.text,
        replyTo: p.replyTo,
        messageId: p.messageId,
        inReplyTo: p.inReplyTo,
        attachments: (p.attachments || []).map(a => ({ filename: a.filename, path: a.href || a.path })),
      });
      return { ok: true, provider: 'smtp', id: info.messageId };
    } catch (e: any) {
      console.error('[mail-transport] SMTP send failed:', e?.message);
      return { ok: false, provider: 'smtp', error: e?.message || 'SMTP error' };
    }
  }

  if (c.resendApiKey) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: p.from || c.fromAddress || 'EduRankAI <noreply@edurankai.in>',
          to: Array.isArray(p.to) ? p.to : [p.to],
          cc: p.cc && p.cc.length ? p.cc : undefined,
          bcc: p.bcc && p.bcc.length ? p.bcc : undefined,
          subject: p.subject, html: p.html, text: p.text, reply_to: p.replyTo,
        }),
      });
      if (!resp.ok) return { ok: false, provider: 'resend', error: await resp.text() };
      const data = await resp.json() as any;
      return { ok: true, provider: 'resend', id: data.id };
    } catch (e: any) {
      return { ok: false, provider: 'resend', error: e?.message || 'Resend error' };
    }
  }

  return { ok: false, provider: 'none', error: 'No outbound transport configured (add SMTP details in Mail Settings)' };
}
