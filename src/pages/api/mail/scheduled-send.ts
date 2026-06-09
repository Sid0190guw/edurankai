// GET/POST /api/mail/scheduled-send  — cron: deliver due scheduled emails.
// Protected by CRON_SECRET (Authorization: Bearer <secret> or ?secret=).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { dueScheduled, markScheduled, rewriteLinksForTracking } from '@/lib/mail-advanced';
import { deliverMessage, parseAddressList, logOutbound, getMailConfig, getMailboxAddress } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

async function run() {
  const due = await dueScheduled(50);
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
        });
        for (const e of result.external) await logOutbound({ messageId: result.messageId, to: e.email, from: fromEmail, subject: s.subject || '', status: send.ok ? 'sent' : 'failed', provider: send.provider, error: send.error }).catch(() => {});
        await db.execute(sql`UPDATE mail_messages SET direction = 'outbound' WHERE id = ${result.messageId}`).catch(() => {});
      }
      await markScheduled(s.id, 'sent', result.messageId);
      sent++;
    } catch (e: any) {
      await markScheduled(s.id, 'failed', undefined, String(e?.message || e).slice(0, 240)).catch(() => {});
      failed++;
    }
  }
  return { ok: true, processed: due.length, sent, failed };
}

function authed(request: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // if no secret configured, allow (cron-only path)
  const auth = request.headers.get('authorization') || '';
  if (auth === 'Bearer ' + secret) return true;
  if (url.searchParams.get('secret') === secret) return true;
  return false;
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!authed(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  try { return json(await run()); } catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
};
export const POST = GET;
