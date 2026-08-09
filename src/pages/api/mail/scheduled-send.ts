// GET/POST /api/mail/scheduled-send  — cron: deliver due scheduled emails.
// Protected by CRON_SECRET (Authorization: Bearer <secret>, x-cron-secret, or ?secret=/?key=).
//
// IT USED TO FAIL OPEN, IN THE FIRST LINE OF ITS GUARD:
//
//     const secret = process.env.CRON_SECRET;
//     if (!secret) return true; // if no secret configured, allow (cron-only path)
//
// This is the same spelling that was removed from four job endpoints in src/pages/api/cron/* and
// src/pages/api/payments/reconcile.ts; this one was missed because it lives under /api/mail. Nothing
// else stands in front of the URL — src/middleware.ts isExempt() returns true for everything under
// /api/ — so with CRON_SECRET absent, empty, or damaged by a pasted newline (which has happened on
// this project's Vercel dashboard before), ANY anonymous caller could POST here and make the platform
// deliver up to 50 queued messages from the company mailbox to external addresses, repeatedly.
//
// It now uses the one helper, src/lib/auth/cron-auth.ts, which fails CLOSED, trims the configured
// value, compares in constant time, and accepts the same three shapes this endpoint already accepted
// so no scheduler entry has to change. A `?key=` form is additionally accepted now (the helper takes
// both names); nothing that worked before stops working.
//
// The trade is deliberate and stated in that helper: with no secret configured, scheduled mail stops
// going out — visibly, on /admin/mail (the message stays queued) — instead of the endpoint standing
// open. src/pages/admin/mail/health.astro already reports whether CRON_SECRET is present.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { claimDueScheduled, markScheduled, rewriteLinksForTracking } from '@/lib/mail-advanced';
import { deliverMessage, parseAddressList, logOutbound, getMailConfig, getMailboxAddress } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';
import { cronAuth } from '@/lib/auth/cron-auth';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

async function run() {
  // CLAIM, THEN SEND. This was `dueScheduled(50)` — a plain SELECT — followed by a loop that only
  // marked each row once its send had finished. Two overlapping invocations of this URL (a cron
  // retry, a manual trigger during the scheduled run, two warm instances) therefore read the same
  // queued messages and BOTH delivered them: the recipient got the mail twice and nothing recorded
  // it. claimDueScheduled() takes ownership in the same statement that selects, so a message is
  // picked up by exactly one run. See its docblock in src/lib/mail-advanced.ts.
  const due = await claimDueScheduled(50);
  let sent = 0, failed = 0;
  for (const s of due) {
    try {
      const to = parseAddressList((s.to_list || '').split(',').map((x: string) => x.trim()).filter(Boolean));
      const cc = parseAddressList((s.cc_list || '').split(',').map((x: string) => x.trim()).filter(Boolean));
      const bcc = parseAddressList((s.bcc_list || '').split(',').map((x: string) => x.trim()).filter(Boolean));
      const fromEmail = await getMailboxAddress(s.user_id);
      const uRows = await db.execute(sql`SELECT name FROM users WHERE id = ${s.user_id} LIMIT 1`);
      const u = (Array.isArray(uRows) ? uRows : ((uRows as any)?.rows || [])) as any[];
      const fromName = (u[0]?.name) || fromEmail;
      const result = await deliverMessage({
        fromUserId: s.user_id, fromEmail, fromName,
        to, cc, bcc, subject: s.subject || '', bodyHtml: s.body_html || '', bodyText: s.body_text || '',
        threadId: s.thread_id || null, inReplyTo: s.in_reply_to || null, attachments: [],
      });
      let externalError: string | null = null;
      if (result.external.length) {
        const cfg = await getMailConfig();
        const envFromAddr = cfg.fromAddress || cfg.smtpUser || fromEmail;
        const envFrom = `${cfg.fromName || fromName} <${envFromAddr}>`;
        const pixel = `<img src="https://edurankai.in/api/mail/track/${result.messageId}.gif" width="1" height="1" alt="" style="display:none;border:0;" />`;
        const html = rewriteLinksForTracking(s.body_html || '', result.messageId) + pixel;
        const send = await sendExternal({
          from: envFrom,
          to: result.external.filter((e: any) => e.kind === 'to').map((e: any) => e.email),
          cc: result.external.filter((e: any) => e.kind === 'cc').map((e: any) => e.email),
          bcc: result.external.filter((e: any) => e.kind === 'bcc').map((e: any) => e.email),
          subject: s.subject || '', html, text: s.body_text || '', replyTo: fromEmail, messageId: result.rfcMessageId,
          logToDb: false, // one row per recipient below, keyed by the mail_messages UUID
        });
        const status = send.ok ? 'sent' : (send.provider === 'none' ? 'no_transport' : 'failed');
        for (const e of result.external) await logOutbound({ messageId: result.messageId, rfcMessageId: result.rfcMessageId, to: e.email, from: fromEmail, subject: s.subject || '', status, provider: send.provider, error: send.error }).catch((le: any) => console.error('[scheduled-send] delivery log failed:', le?.cause?.message || le?.message));
        // Same best-effort-but-never-silent rule as /api/mail/send: `direction` is what the analytics
        // console counts and what places the Sent copy, so a failure here hides a message that did go.
        await db.execute(sql`UPDATE mail_messages SET direction = 'outbound' WHERE id = ${result.messageId}`)
          .catch((de: any) => console.error('[scheduled-send] outbound flag not set for ' + result.messageId + ':', de?.cause?.message || de?.message));
        if (!send.ok) externalError = send.error || 'the mail server refused the message';
      }
      // A scheduled message whose SMTP attempt was REFUSED used to be recorded as 'sent' — so the
      // scheduled list told the sender their message had gone when the only thing that happened
      // was a copy landing in their own Sent folder. It says what happened now.
      if (externalError) {
        // THE STATEMENT THAT RECORDS THE FAILURE WAS ITSELF ALLOWED TO FAIL IN SILENCE, and this
        // one is not cosmetic. claimDueScheduled() has already moved the row to 'sending', and it
        // reclaims anything left in that state for more than 15 minutes - so a markScheduled() that
        // throws leaves the queue row claimed-but-never-settled and the NEXT run picks it up and
        // sends the same message to the same recipient again. Mail cannot be recalled. It stays
        // best-effort (the send has happened; throwing here changes nothing about that) but the
        // reason is written down, because a redelivery with no log is unfindable.
        await markScheduled(s.id, 'failed', result.messageId, ('Saved to Sent, but not delivered: ' + externalError).slice(0, 240))
          .catch((me: any) => console.error('[scheduled-send] status not recorded for ' + s.id + ' (it may be re-sent):', me?.cause?.message || me?.message));
        failed++;
      } else {
        await markScheduled(s.id, 'sent', result.messageId);
        sent++;
      }
    } catch (e: any) {
      const reason = String(e?.cause?.message || e?.message || e);
      console.error('[scheduled-send] failed for', s.id, reason);
      await markScheduled(s.id, 'failed', undefined, reason.slice(0, 240))
        .catch((me: any) => console.error('[scheduled-send] status not recorded for ' + s.id + ' (it may be retried):', me?.cause?.message || me?.message));
      failed++;
    }
  }
  return { ok: true, processed: due.length, sent, failed };
}

export const GET: APIRoute = async ({ request, url }) => {
  const gate = cronAuth(request, url);
  if (!gate.allowed) {
    // The two refusals are different facts and the operator needs to tell them apart: one is a
    // deployment that never had the secret, the other is a caller sending the wrong one.
    return json({
      ok: false,
      error: gate.reason === 'not-configured'
        ? 'CRON_SECRET is not set on this deployment, so no scheduled mail can be sent. Nothing has been delivered and nothing has been lost — the queue is intact.'
        : 'unauthorized',
    }, 401);
  }
  try { return json(await run()); } catch (e: any) { return json({ ok: false, error: String(e?.cause?.message || e?.message || e) }, 500); }
};
export const POST = GET;
