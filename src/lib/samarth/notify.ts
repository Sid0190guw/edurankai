// SAMARTH email and admin notifications.
//
// Email goes through the platform's own SMTP (src/lib/email.ts). A send that fails never undoes the
// action it reports, and every page that triggers one ALSO shows the same information on screen, so
// an unconfigured mail server costs a convenience, never access to a record.
//
// Admin alerts go to super admins only (src/lib/notify-audience.ts): the SAMARTH desks are gated to
// the `samarth` and `samarth_x` sections, which no built-in role below super admin holds.

import { sendEmail, brandedEmail } from '@/lib/email';
import { SITE } from '@/lib/site';
import { formatMoney } from '@/lib/samarth/currency';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const origin = () => SITE.url.replace(/\/+$/, '');

export function workspaceUrl(ref: string, token?: string): string {
  return origin() + '/samarth/r/' + encodeURIComponent(ref) + (token ? '?k=' + encodeURIComponent(token) : '');
}
export function partnerUrl(ref: string, token?: string): string {
  return origin() + '/samarth/partners/status/' + encodeURIComponent(ref) + (token ? '?k=' + encodeURIComponent(token) : '');
}
export function xUrl(ref: string, token?: string): string {
  return origin() + '/samarth/x/status/' + encodeURIComponent(ref) + (token ? '?k=' + encodeURIComponent(token) : '');
}

async function send(to: string, subject: string, heading: string, bodyHtml: string, ctaText?: string, ctaUrl?: string): Promise<boolean> {
  try {
    const r = await sendEmail({
      to, subject,
      html: brandedEmail({ heading, body: bodyHtml, ctaText, ctaUrl, footerNote: 'SAMARTH is the research, consulting and engineering initiative of EduRankAI. This message was sent because of a request made with this address.' }),
      text: heading + '\n\n' + bodyHtml.replace(/<[^>]+>/g, '') + (ctaUrl ? '\n\n' + ctaUrl : ''),
    });
    return !!r.ok;
  } catch (e: any) {
    // Not a database error: the mail transport's own message.
    console.error('[samarth/notify] email "' + subject + '" not sent:', String(e?.message || e));
    return false;
  }
}

export async function emailRegistration(to: string, name: string, ref: string, token: string): Promise<boolean> {
  return send(to, 'Your SAMARTH reference ' + ref, 'Your registration is saved',
    '<p>Hello ' + esc(name) + ',</p><p>Your SAMARTH consultation request has the reference <strong>' + esc(ref) + '</strong>. Use the private link below to continue: your details, your project requirements, the consultation booking fee, and booking your call.</p><p>Keep this link private. Anyone holding it can see and continue your request.</p>',
    'Continue my request', workspaceUrl(ref, token));
}

export async function emailNewLink(to: string, ref: string, token: string, kind: 'application' | 'partner' | 'x'): Promise<boolean> {
  const url = kind === 'partner' ? partnerUrl(ref, token) : kind === 'x' ? xUrl(ref, token) : workspaceUrl(ref, token);
  return send(to, 'Your new SAMARTH link for ' + ref, 'Here is your new private link',
    '<p>You asked for a new link to <strong>' + esc(ref) + '</strong>. Any earlier link has stopped working.</p><p>If you did not ask for this, you can ignore this message.</p>', 'Open my request', url);
}

export async function emailFeePaid(to: string, name: string, ref: string, totalMinor: number | null, currency: string, receiptOrder: string | null): Promise<boolean> {
  const receipt = receiptOrder ? '<p>Your receipt: <a href="' + origin() + '/receipt/' + encodeURIComponent(receiptOrder) + '?e=' + encodeURIComponent(to) + '">' + origin() + '/receipt/' + esc(receiptOrder) + '</a></p>' : '';
  return send(to, 'Booking fee received for ' + ref, 'Your booking fee is confirmed',
    '<p>Hello ' + esc(name) + ',</p><p>We have received the consultation booking fee' + (totalMinor ? ' of <strong>' + esc(formatMoney(totalMinor, currency)) + '</strong>' : '') + ' for <strong>' + esc(ref) + '</strong>.</p>' + receipt + '<p>Next, tell us when you can take the call. A SAMARTH consultant will then be assigned to you.</p>',
    'Book my call', workspaceUrl(ref));
}

export async function emailUpdate(to: string, ref: string, heading: string, message: string, link: string): Promise<boolean> {
  return send(to, 'SAMARTH update for ' + ref, heading, '<p>' + esc(message).replace(/\n/g, '<br/>') + '</p>', 'Open my request', link);
}

export async function emailPartnerReceived(to: string, name: string, ref: string, token: string): Promise<boolean> {
  return send(to, 'SAMARTH partner registration ' + ref, 'Your partner registration is received',
    '<p>Hello ' + esc(name) + ',</p><p>Thank you for registering as a SAMARTH technology partner. Your reference is <strong>' + esc(ref) + '</strong>.</p><p>Registration is not approval, and approval never entitles a partner to a project: partners are selected for specific work after due diligence. Follow your registration with the private link below.</p>',
    'View my registration', partnerUrl(ref, token));
}

export async function emailXReceived(to: string, name: string, ref: string, token: string): Promise<boolean> {
  return send(to, 'SAMARTH X application ' + ref, 'Your SAMARTH X application is received',
    '<p>Hello ' + esc(name) + ',</p><p>Your expression of interest has the reference <strong>' + esc(ref) + '</strong>. It is an application for consideration, not admission. There is no fee at any stage of SAMARTH X.</p>',
    'Follow my application', xUrl(ref, token));
}

/** Super-admin alert. Never throws. */
export async function alertAdmins(type: 'samarth_application' | 'samarth_payment' | 'samarth_partner' | 'samarth_x', title: string, body: string, url: string, tag: string): Promise<void> {
  try {
    const { sendPushToAdmins } = await import('@/lib/push');
    await sendPushToAdmins({ type, title, body: body.slice(0, 180), url, tag });
  } catch (e: any) {
    console.error('[samarth/notify] admin alert ' + type + ' not sent:', String(e?.cause?.message || e?.message || e));
  }
}
