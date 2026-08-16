// POST /api/mail/inbound - receive external email. Accepts EITHER:
//   (a) JSON: { to, from, fromName, subject, text, html, messageId, inReplyTo }
//   (b) raw MIME (Content-Type not JSON) + headers x-mail-to / x-mail-from
//       -> parsed here with postal-mime. This lets a Cloudflare Email Worker just
//          forward the raw message with no bundling.
// AUTHENTICATED, in preference order:
//   1. HMAC signature over the exact request bytes — x-era-signature / x-era-timestamp, five-minute
//      window, constant-time compare. Set MAIL_WEBHOOK_SECRET and the forwarding worker signs.
//   2. Shared secret in the x-mail-secret header (constant-time), for a sender not signing yet.
//   3. Shared secret in the JSON body. DEPRECATED and logged on every use — a credential in a body
//      is logged, cached and proxied in more places than one in a header.
// The body is bounded before any of that (MAX_INBOUND_BYTES), because the signature is over the
// bytes and so they must be read before the request can be authenticated.
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
// The HMAC verifier this route was always meant to use. It already existed, fully written and
// tested, in src/lib/mailops/webhook.ts — and nothing called it. Meanwhile docker/mailops/ingest.mjs
// has been SIGNING every forwarded message with MAIL_WEBHOOK_SECRET, and /api/health/mail reports
// "signed webhooks available (HMAC + replay window)" whenever that variable is set. The signature
// was being sent, advertised as verified, and thrown away here. See the block in the handler.
import { verifyInbound, LEGACY_SECRET_HEADER } from '@/lib/mailops/webhook';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
// The real Postgres reason is on e.cause; e.message is only the failed SQL. Declared above the
// handler that uses it - `const` is not hoisted.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
/**
 * A ceiling on the raw body, in bytes.
 *
 * `await request.text()` on the MIME path had none, so one request could make the process buffer
 * as much as the caller cared to send — and this is the ONE mail route an unauthenticated stranger
 * can reach with a body at all, because the secret is checked after the body is read (it has to be:
 * the signature is over the body). 30 MB is above any message a mail server will accept and far
 * below anything that hurts.
 *
 * Declared above the handler: `const` is not hoisted.
 */
const MAX_INBOUND_BYTES = Math.max(1_000_000, Number(process.env.MAIL_MAX_INBOUND_BYTES) || 30 * 1024 * 1024);

export const POST: APIRoute = async ({ request }) => {
  await ensureMailSchema();
  const cfg = await getMailConfig();
  const ct = request.headers.get('content-type') || '';

  // ONE READ OF THE BODY, BOUNDED, BEFORE ANYTHING ELSE.
  //
  // The signature is computed over the exact bytes, so they have to be in hand before the request
  // can be authenticated — which is why the size ceiling matters here more than anywhere else in
  // the product: this is the one route where an unauthenticated caller gets to hand us a body at all.
  let raw: string;
  try {
    raw = await request.text();
  } catch (e: any) {
    console.error('[api/mail/inbound] could not read the request body:', reasonOf(e));
    return json({ ok: false, error: 'the request body could not be read' }, 400);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_INBOUND_BYTES) {
    // 413 rather than 400: a forwarding MTA reads 4xx as permanent and will stop retrying, which is
    // the right outcome for a message that is simply too big, and the operator gets a log line.
    console.error('[api/mail/inbound] refused a body of', Buffer.byteLength(raw, 'utf8'), 'bytes; ceiling is', MAX_INBOUND_BYTES);
    return json({ ok: false, error: 'that message is larger than this server accepts' }, 413);
  }

  let body: any = {};
  if (ct.includes('application/json')) {
    try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  } else {
    // Raw MIME from a Cloudflare Email Worker (or any MTA pipe).
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
  // ═══ AUTHENTICATION ═══
  //
  // WHAT THIS REPLACES, AND WHY EACH PART OF IT MATTERED:
  //
  //     if (!secret || (provided || body.secret) !== secret) return 403
  //
  //   `!==` on a secret is not constant time. Remotely exploiting a string-compare timing side
  //         channel over HTTP is hard, and the same repository already compares in constant time in
  //         src/lib/auth/cron-auth.ts — so the inconsistency was the finding as much as the timing.
  //   `body.secret` accepted the credential in the JSON BODY. Bodies are logged, cached and proxied
  //         in more places than headers are, so that was the weakest form of the same secret and it
  //         was accepted on equal terms.
  //   Nothing bound the request to a moment or to a message: a captured request replayed for ever.
  //
  // verifyInbound() is not new code. It has existed, complete and tested, in src/lib/mailops/
  // webhook.ts, doing HMAC over the exact bytes with a five-minute window and a constant-time
  // compare — and NOTHING CALLED IT. docker/mailops/ingest.mjs signs every message it forwards with
  // MAIL_WEBHOOK_SECRET, and /api/health/mail tells the operator that signed webhooks with a replay
  // window are available. The signature was being computed, sent, advertised as verified, and
  // dropped on the floor here. This wires the three together.
  //
  // THE LEGACY SHARED SECRET STILL WORKS, in the header and (deprecated) in the body, because a
  // deployment whose forwarding worker has not been given MAIL_WEBHOOK_SECRET must not stop
  // receiving mail the moment this ships. It is now a constant-time compare either way, and a body
  // secret is logged so an operator can see who still needs migrating.
  const bodySecret = typeof body?.secret === 'string' ? body.secret : '';
  const headerSecret = request.headers.get(LEGACY_SECRET_HEADER) || '';
  if (!headerSecret && bodySecret) {
    console.warn('[api/mail/inbound] a sender is still presenting the shared secret in the JSON body;',
      'move it to the ' + LEGACY_SECRET_HEADER + ' header, or better, sign with MAIL_WEBHOOK_SECRET');
  }
  const effectiveHeaders = new Headers(request.headers);
  if (!headerSecret && bodySecret) effectiveHeaders.set(LEGACY_SECRET_HEADER, bodySecret);

  const auth = await verifyInbound(effectiveHeaders, raw, {
    hmacSecret: process.env.MAIL_WEBHOOK_SECRET || '',
    sharedSecret: cfg.inboundSecret,
  });
  if (!auth.ok) {
    // The REASON is logged and NOT returned. An operator needs to know whether the timestamp drifted
    // or the signature is wrong; a caller who failed authentication does not get told which.
    console.error('[api/mail/inbound] refused (' + auth.scheme + '):', auth.reason);
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  if (auth.legacy) {
    console.warn('[api/mail/inbound] accepted on the legacy shared secret; this sender is not signing yet');
  }

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
