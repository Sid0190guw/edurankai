// src/lib/email.ts - high-level transactional email.
// ALL outbound mail now goes through our OWN SMTP server (mail-transport.ts /
// Mail Settings). No third-party HTTP API. Configure the mail server at
// /admin/mail/settings; from-name/address come from there (env EMAIL_FROM is a
// last-resort default).
import { sendExternal } from '@/lib/mail-transport';
import { getMailConfig } from '@/lib/mail';

export interface EmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export async function sendEmail(params: EmailParams): Promise<{ ok: boolean; id?: string; error?: string }> {
  let from = process.env.EMAIL_FROM || 'EduRankAI <noreply@edurankai.in>';
  try {
    const c = await getMailConfig();
    if (c.fromAddress) from = (c.fromName ? c.fromName + ' ' : '') + '<' + c.fromAddress + '>';
  } catch (_) { /* fall back to env default */ }

  const r = await sendExternal({
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
  });
  if (!r.ok) console.log('[email] not sent (' + (r.error || 'no transport') + '):', params.subject, 'to', params.to);
  return { ok: r.ok, id: r.id, error: r.error };
}

// Branded email template wrapper
export function brandedEmail(opts: {
  preheader?: string;
  heading: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
  footerNote?: string;
}): string {
  const cta = opts.ctaText && opts.ctaUrl ? `
    <tr><td style="padding:24px 0;text-align:center;">
      <a href="${opts.ctaUrl}" style="display:inline-block;background:#FF4F00;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:8px;">${opts.ctaText}</a>
    </td></tr>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/>
<style>@media(prefers-color-scheme:dark){.body-bg{background:#0a0a0c!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f8f6f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
${opts.preheader ? `<div style="display:none;font-size:1px;color:#f8f6f1;">${opts.preheader}</div>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="body-bg" style="background:#f8f6f1;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid rgba(0,0,0,0.08);overflow:hidden;">
      <tr><td style="background:#0f0f14;padding:24px;text-align:center;">
        <p style="font-size:22px;font-weight:900;color:#fff;margin:0;letter-spacing:-0.02em;">EduRank<span style="color:#FF4F00;">AI</span></p>
      </td></tr>
      <tr><td style="padding:32px 28px 8px;">
        <h1 style="font-size:20px;font-weight:700;color:#111;margin:0 0 16px;line-height:1.3;">${opts.heading}</h1>
        <div style="font-size:14px;color:#374151;line-height:1.7;">${opts.body}</div>
      </td></tr>
      ${cta}
      <tr><td style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;">
        <p style="font-size:11px;color:#9ca3af;margin:0;line-height:1.6;">${opts.footerNote || 'EduRankAI - The Truth Report on Universities.<br/>If you have questions, reply to this email.'}</p>
      </td></tr>
    </table>
    <p style="font-size:10px;color:#9ca3af;margin:14px 0 0;">(c) 2026 EduRankAI. All rights reserved.</p>
  </td></tr>
</table>
</body></html>`;
}
