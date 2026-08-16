// src/lib/mailplatform/adapters/email.ts — the one channel that actually sends.
//
// It goes through src/lib/mail-transport.ts (sendExternal), which is the platform's existing SMTP
// path: own mail server, From normalised to the configured address, one row in email_logs per
// attempt. THIS DOES NOT TOUCH THE CAMPAIGN ENGINE — no campaign row is written, no group is
// expanded, nothing in src/lib/mail.ts or mail-advanced.ts changes behaviour. An automation send is
// one message to one contact, which is why it can carry per-person merge fields at all.
//
// Every import is lazy. This module is imported by the action registry, the action registry is
// imported by the engine, and the engine is imported by the pure tests; a top-level import of
// mail-transport pulls in the database connection and nodemailer and takes those tests down with it.
import type { ChannelAdapter, ChannelMessage, ChannelResult } from './channel';
import { TemporaryFailure } from '../errors';

async function config(): Promise<any> {
  const { getMailConfig } = await import('@/lib/mail');
  return getMailConfig();
}

export const emailAdapter: ChannelAdapter = {
  id: 'email',
  label: 'Email',

  async available(): Promise<boolean> {
    try { return !!(await config())?.smtpHost; } catch { return false; }
  },

  async unavailableReason(): Promise<string> {
    try {
      const c = await config();
      return c?.smtpHost ? '' : 'No SMTP server is configured. Add one on /admin/mail/settings — until then a workflow that sends email will fail rather than pretend.';
    } catch (e: any) {
      return 'The mail configuration could not be read: ' + String(e?.cause?.message || e?.message || e);
    }
  },

  async send(m: ChannelMessage): Promise<ChannelResult> {
    const { sendExternal } = await import('@/lib/mail-transport');
    const c = await config();
    const fromAddress = c?.fromAddress || c?.smtpUser || '';
    if (!fromAddress) {
      // Not a transport failure: there is no address to send FROM. Retrying cannot invent one.
      return { ok: false, error: 'No sending address is configured (Mail Settings -> from address).' };
    }
    const from = (c?.fromName ? c.fromName + ' ' : '') + '<' + fromAddress + '>';

    let html = m.html || '';
    // Open and click tracking reuse the existing pixel and link-rewriter, so automation sends appear
    // on /admin/mail/analytics beside everything else instead of in a second set of numbers. The
    // idempotency key doubles as the tracking id: it is stable per run and node, so a re-delivered
    // open does not look like a new one.
    if (html) {
      try {
        const { rewriteLinksForTracking } = await import('@/lib/mail-advanced');
        html = rewriteLinksForTracking(html, m.idempotencyKey);
      } catch (e: any) {
        // Tracking is not the message. A rewriter that throws must not stop the send.
        console.error('[mailplatform/email] link tracking skipped:', e?.cause?.message || e?.message);
      }
    }

    let res: any;
    try {
      res = await sendExternal({
        from,
        to: [m.to],
        subject: m.subject || '',
        html,
        text: m.text || '',
        replyTo: fromAddress,
        logToDb: true,
      });
    } catch (e: any) {
      // sendExternal normally returns {ok:false}; a THROW here is the socket layer, which is the
      // textbook temporary failure and must be retried rather than dead-lettered.
      throw new TemporaryFailure('The mail server could not be reached: ' + String(e?.cause?.message || e?.message || e));
    }

    if (!res?.ok) {
      // The transport's own words, unedited. classifyError() reads SMTP 4.x.x as temporary and
      // 5.x.x as permanent, which is the distinction that decides whether we try this address again.
      return { ok: false, error: String(res?.error || 'the mail server refused the message') };
    }
    return { ok: true, ref: String(res.id || m.idempotencyKey) };
  },
};
