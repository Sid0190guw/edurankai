// POST /api/mail/inbound - receive external email from your VPS/MTA (Postfix pipe,
// Cloudflare Email Worker, Resend Inbound, etc). Secured by a shared secret.
//
// Configure your MTA to POST JSON:
//   { "to": "siddharth@edurankai.in", "from": "alice@gmail.com", "fromName": "Alice",
//     "subject": "Hi", "text": "...", "html": "...", "messageId": "<...>", "inReplyTo": "<...>" }
// with header  x-mail-secret: $MAIL_INBOUND_SECRET   (or include "secret" in the body).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { parseAddressList, resolveAddress, makeSnippet, ensureMailSchema, getMailConfig } from '@/lib/mail';
import { randomUUID } from 'node:crypto';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  await ensureMailSchema();
  const cfg = await getMailConfig();
  const secret = cfg.inboundSecret;
  const provided = request.headers.get('x-mail-secret') || body.secret;
  if (!secret || provided !== secret) return json({ ok: false, error: 'forbidden' }, 403);

  const toList = parseAddressList(body.to).concat(parseAddressList(body.cc));
  if (!toList.length) return json({ ok: false, error: 'no recipients' }, 400);

  const fromEmail = parseAddressList(body.from)[0] || (body.from || '').toString();
  const fromName = (body.fromName || body.from_name || fromEmail).toString().slice(0, 200);
  const subject = (body.subject || '(no subject)').toString().slice(0, 500);
  const bodyText = (body.text || '').toString();
  const bodyHtml = (body.html || '').toString();
  const inReplyTo = (body.inReplyTo || body.in_reply_to || '').toString() || null;
  const rfcId = (body.messageId || body.message_id || `<${randomUUID()}@inbound>`).toString();

  try {
    await ensureMailSchema();
    // Deliver to each internal recipient mailbox
    let delivered = 0;
    const seen = new Set<string>();
    for (const addr of toList) {
      const resolved = await resolveAddress(addr);
      if (!resolved.userId || seen.has(resolved.userId)) continue;
      seen.add(resolved.userId);

      // thread by in-reply-to if we have it
      let threadId: string | null = null;
      if (inReplyTo) {
        const t = rows(await db.execute(sql`SELECT thread_id FROM mail_messages WHERE rfc_message_id = ${inReplyTo} LIMIT 1`));
        if (t[0]) threadId = t[0].thread_id;
      }
      if (!threadId) threadId = randomUUID();

      const ins = rows(await db.execute(sql`
        INSERT INTO mail_messages (thread_id, subject, from_user_id, from_email, from_name, body_html, body_text, snippet, direction, rfc_message_id, in_reply_to)
        VALUES (${threadId}, ${subject}, NULL, ${fromEmail}, ${fromName}, ${bodyHtml || null}, ${bodyText || null}, ${makeSnippet(bodyText, bodyHtml)}, 'inbound', ${rfcId}, ${inReplyTo})
        RETURNING id
      `));
      const messageId = ins[0].id;
      await db.execute(sql`INSERT INTO mail_recipients (message_id, kind, user_id, email, name) VALUES (${messageId}, 'to', ${resolved.userId}, ${resolved.email}, ${resolved.name})`);
      await db.execute(sql`
        INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
        VALUES (${resolved.userId}, ${messageId}, ${threadId}, 'inbox', false)
        ON CONFLICT (user_id, message_id) DO NOTHING
      `);
      delivered += 1;
    }
    return json({ ok: true, delivered });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'inbound failed' }, 500);
  }
};
