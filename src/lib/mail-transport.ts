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

export async function sendExternal(p: SendExternalParams): Promise<SendResult> {
  const c = await getMailConfig();

  if (c.smtpHost) {
    try {
      const transport = nodemailer.createTransport({
        host: c.smtpHost,
        port: c.smtpPort,
        secure: c.smtpSecure || c.smtpPort === 465,
        auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined,
        tls: { rejectUnauthorized: process.env.SMTP_INSECURE !== 'true' },
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
