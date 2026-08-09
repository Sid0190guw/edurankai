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
    } catch (e) { parsed = {}; }
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
    const seen = new Set<string>();
    for (const addr of toList) {
      const resolved = await resolveAddress(addr);
      if (!resolved.userId || seen.has(resolved.userId)) continue;
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
    return json({ ok: true, delivered });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'inbound failed' }, 500);
  }
};
