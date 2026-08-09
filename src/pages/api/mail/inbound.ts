// POST /api/mail/inbound - receive external email. Accepts EITHER:
//   (a) JSON: { to, from, fromName, subject, text, html, messageId, inReplyTo }
//   (b) raw MIME (Content-Type not JSON) + headers x-mail-to / x-mail-from
//       -> parsed here with postal-mime. This lets a Cloudflare Email Worker just
//          forward the raw message with no bundling.
// Secured by a shared secret (header x-mail-secret, or "secret" in JSON body).
//
// THIS ROUTE NO LONGER HAND-WRITES THE DELIVERY. It carried its own copy of the thread lookup, its
// own INSERTs and its own notification — a second implementation of what src/lib/mail.ts already
// does, drifted from the IMAP puller's third one. Two consequences no screen could show: a reply
// whose client dropped In-Reply-To started a brand new thread, because the subject/counterpart
// fallback in findThreadForInbound() was never reached (the function had no callers at all); and no
// inbound rule an administrator built on /admin/mail/rules had ever filed a message on arrival.
// Both doors now go through deliverInbound(). See the block above it in src/lib/mail.ts.
import type { APIRoute } from 'astro';
import { parseAddressList, resolveAddress, ensureMailSchema, getMailConfig, deliverInbound } from '@/lib/mail';
import { randomUUID } from 'node:crypto';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
// The real Postgres reason is on e.cause; e.message is only the failed SQL. Declared above the
// handler that uses it - `const` is not hoisted.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request }) => {
  await ensureMailSchema();
  const cfg = await getMailConfig();
  const secret = cfg.inboundSecret;
  const provided = request.headers.get('x-mail-secret');
  const ct = request.headers.get('content-type') || '';

  let body: any = {};
  if (ct.includes('application/json')) {
    try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  } else {
    // Raw MIME from a Cloudflare Email Worker (or any MTA pipe).
    const raw = await request.text();
    let parsed: any = {};
    try {
      const PostalMime = (await import('postal-mime')).default as any;
      parsed = await PostalMime.parse(raw);
    } catch (e: any) {
      // A MESSAGE THAT WOULD NOT PARSE USED TO VANISH IN SILENCE. `parsed = {}` leaves every field
      // empty, the recipient list comes back empty, and the request answers 400 "no recipients" -
      // which the forwarding worker reads as "malformed", not as "your parser broke". Real mail
      // arriving at the company address was being dropped with nothing anywhere saying so.
      console.error('[api/mail/inbound] MIME parse failed, falling back to headers:', reasonOf(e));
      parsed = {};
    }
    body = {
      to: request.headers.get('x-mail-to') || (parsed.to || []).map((a: any) => a.address).join(','),
      from: request.headers.get('x-mail-from') || (parsed.from && parsed.from.address) || '',
      fromName: (parsed.from && parsed.from.name) || '',
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || '',
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
    };
  }

  // A CONFIG THAT COULD NOT BE READ IS NOT A WRONG SECRET. getMailConfig() used to swallow its own
  // SELECT, so a database hiccup produced secret === '' and every real message from the forwarding
  // MTA was answered 403 forbidden — which an operator reads as "the shared secret drifted" and acts
  // on by rotating a secret that was never wrong. Still fails closed (nothing is delivered), but a
  // 503 is retriable at the sending MTA and names the actual condition.
  if (cfg.readError) {
    console.error('[api/mail/inbound] refusing delivery: mail_config unreadable -', cfg.readError);
    return json({ ok: false, error: 'mail configuration could not be read; retry shortly' }, 503);
  }
  if (!secret || (provided || body.secret) !== secret) return json({ ok: false, error: 'forbidden' }, 403);

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
    let delivered = 0;
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const addr of toList) {
      const resolved = await resolveAddress(addr);
      // MAIL TO AN ADDRESS WITH NO MAILBOX WAS ACCEPTED AND THROWN AWAY. The loop skipped it, the
      // response was `{ ok: true, delivered: 0 }`, and the sending MTA read that 200 as delivery -
      // so no bounce ever reached the person who wrote to us and no line anywhere recorded that a
      // message had arrived for nobody. The status stays 200 on purpose (a non-2xx makes a
      // forwarding worker retry the same undeliverable message for hours), but the addresses are
      // named in the log and in the answer so this is discoverable instead of silent.
      if (!resolved.userId) { if (!unresolved.includes(addr)) unresolved.push(addr); continue; }
      if (seen.has(resolved.userId)) continue;
      seen.add(resolved.userId);

      // Threading, storage, arrival filtering and the recipient's notification, in the one place
      // that does all four. A throw here still aborts the request and answers 500 — this is a write
      // path and it must not report a delivery that did not happen.
      await deliverInbound({
        userId: resolved.userId,
        email: resolved.email,
        name: resolved.name,
        fromEmail, fromName, subject, bodyText, bodyHtml,
        rfcMessageId: rfcId,
        inReplyTo,
      });
      delivered += 1;
    }
    if (unresolved.length) {
      console.error('[api/mail/inbound] no mailbox for', unresolved.join(', '), '- from', fromEmail, '- subject', subject.slice(0, 120));
    }
    if (delivered === 0) {
      console.error('[api/mail/inbound] message from', fromEmail, 'reached NO mailbox and has been discarded - subject', subject.slice(0, 120));
    }
    return json({ ok: true, delivered, unresolved });
  } catch (e: any) {
    // e.message is only the failed SQL; the reason is on e.cause and was going nowhere at all. On a
    // receive path a lost message with no log line is unrecoverable - nobody knows to look.
    console.error('[api/mail/inbound] delivery failed for', subject.slice(0, 120), '-', reasonOf(e));
    return json({ ok: false, error: 'the message could not be delivered' }, 500);
  }
};
