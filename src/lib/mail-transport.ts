// src/lib/mail-transport.ts - outbound email delivery to EXTERNAL addresses.
// Priority: your own VPS SMTP (nodemailer) -> Resend HTTP API -> log only.
import nodemailer from 'nodemailer';
import { sendEmail } from '@/lib/email';

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

let cachedTransport: nodemailer.Transporter | null = null;

function getSmtpTransport(): nodemailer.Transporter | null {
  if (!process.env.SMTP_HOST) return null;
  if (cachedTransport) return cachedTransport;
  const port = Number(process.env.SMTP_PORT || 587);
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    tls: { rejectUnauthorized: process.env.SMTP_INSECURE !== 'true' },
  });
  return cachedTransport;
}

export function transportStatus(): { mode: 'smtp' | 'resend' | 'none'; detail: string } {
  if (process.env.SMTP_HOST) return { mode: 'smtp', detail: `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}` };
  if (process.env.RESEND_API_KEY) return { mode: 'resend', detail: 'Resend HTTP API' };
  return { mode: 'none', detail: 'No outbound transport configured' };
}

export async function sendExternal(p: SendExternalParams): Promise<SendResult> {
  const smtp = getSmtpTransport();
  if (smtp) {
    try {
      const info = await smtp.sendMail({
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

  if (process.env.RESEND_API_KEY) {
    const r = await sendEmail({ to: p.to, subject: p.subject, html: p.html, text: p.text, replyTo: p.replyTo });
    return { ok: r.ok, provider: 'resend', id: r.id, error: r.error };
  }

  return { ok: false, provider: 'none', error: 'No outbound transport configured (set SMTP_HOST or RESEND_API_KEY)' };
}
