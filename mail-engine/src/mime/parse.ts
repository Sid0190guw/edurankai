// mail-engine/src/mime/parse.ts — turning a blob of bytes from a stranger into a structured message.
//
// EVERYTHING IN AN INBOUND MESSAGE IS ATTACKER-CONTROLLED. Not "might be" — the whole point of an MX
// record is that anyone on the Internet can hand this function bytes. So the rules here are:
//
//   * Nothing is trusted for size. Attachments over the configured limit are recorded with their
//     name and size and their CONTENT is dropped, rather than being loaded into memory to be
//     rejected afterwards.
//   * Executable attachments are refused by extension, and the refusal is recorded on the part so
//     the recipient can see that something was removed rather than silently receiving a message with
//     a missing attachment.
//   * Filenames are stripped of path separators and control characters. A part named
//     `../../etc/cron.d/x` must never reach anything that opens files.
//   * A message that will not parse is not silently discarded — the caller gets an error and answers
//     the sending MTA with a 4xx, so the message is retried rather than lost. That is the same
//     lesson already written into /api/mail/inbound in the application.
//
// THREADING HEADERS ARE KEPT WHOLE. In-Reply-To and References are what make a reply join its
// conversation; the application's findThreadForInbound() falls back to subject matching when they
// are missing, and that fallback is much worse than the headers. Parse them, do not summarise them.

import { simpleParser, type ParsedMail, type AddressObject, type Attachment } from 'mailparser';
import type { InboundAttachment, InboundMessage } from '../contracts/index.js';
import { extensionOf } from '../validate.js';

export interface ParseOptions {
  maxAttachmentBytes: number;
  blockedExtensions: string[];
  /** Envelope from the SMTP conversation. Overrides the headers, which can lie. */
  envelope?: { from: string; to: string[] };
}

/** Strip anything that makes a filename dangerous to hand to a filesystem or a browser. */
export function safeFilename(name: string | undefined | null, fallback = 'attachment'): string {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  // Take the last path segment. A part named `../../etc/cron.d/x` is not a filename with an unusual
  // prefix, it is an attempt to choose where a file lands; the only part of it that is a name is the
  // last one. Splitting on both separators matters because the message may have come from either
  // kind of system and this engine may be running on either kind.
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\r\n\t\0]/g, '')
    .replace(/^\.+/, '')             // leading dots: hidden files, and what is left of `..`
    .replace(/[<>:"|?*]/g, '_')      // reserved on Windows
    .slice(0, 200);
  return cleaned || fallback;
}

function addressesOf(field: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  const out: { address: string; name: string }[] = [];
  for (const group of list) {
    for (const a of group?.value || []) {
      if (!a?.address) continue;
      out.push({ address: String(a.address).toLowerCase(), name: String(a.name || '') });
    }
  }
  return out;
}

function headerString(parsed: ParsedMail, name: string): string | null {
  const v = parsed.headers.get(name.toLowerCase());
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join('; ');
  if (typeof v === 'object' && 'value' in (v as unknown as Record<string, unknown>)) {
    return String((v as unknown as { value: unknown }).value);
  }
  return String(v);
}

/**
 * Rspamd (via the milter) and most spam engines write their verdict into headers. Read whichever is
 * present rather than requiring one particular filter to be installed — the engine has to behave
 * sensibly when it runs with no spam filter at all, which is the case on a fresh laptop.
 */
export function extractSpamVerdict(parsed: ParsedMail): { score: number | null; action: string | null } {
  const rspamd = headerString(parsed, 'x-spamd-result');
  const scoreHeaders = ['x-spam-score', 'x-rspamd-score', 'x-spam-status', 'x-spam-level'];
  let score: number | null = null;
  let action: string | null = headerString(parsed, 'x-spamd-action') || headerString(parsed, 'x-rspamd-action');

  for (const h of scoreHeaders) {
    const raw = headerString(parsed, h);
    if (!raw) continue;
    if (h === 'x-spam-level') {
      // SpamAssassin's star scale: one asterisk per point.
      const stars = (raw.match(/\*/g) || []).length;
      if (stars) { score = stars; break; }
      continue;
    }
    const m = /(-?\d+(?:\.\d+)?)/.exec(raw);
    if (m) { score = Number(m[1]); break; }
  }
  if (score == null && rspamd) {
    const m = /\[\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*\]/.exec(rspamd);
    if (m) score = Number(m[1]);
  }
  const flag = headerString(parsed, 'x-spam-flag');
  if (!action && flag && /yes/i.test(flag)) action = 'add header';
  return { score: Number.isFinite(score as number) ? score : null, action };
}

function toInboundAttachment(a: Attachment, opts: ParseOptions): InboundAttachment {
  const filename = safeFilename(a.filename, 'attachment.bin');
  const sizeBytes = a.size || (a.content ? a.content.length : 0);
  const ext = extensionOf(filename);
  let rejectedReason: string | null = null;

  if (ext && opts.blockedExtensions.includes(ext)) {
    rejectedReason = `.${ext} attachments are not accepted`;
  } else if (sizeBytes > opts.maxAttachmentBytes) {
    rejectedReason = `attachment is ${Math.round(sizeBytes / 1024)}KB, over the ${Math.round(opts.maxAttachmentBytes / 1024)}KB limit`;
  }

  return {
    filename,
    contentType: String(a.contentType || 'application/octet-stream'),
    sizeBytes,
    contentId: a.cid ? String(a.cid) : null,
    content: rejectedReason ? null : Buffer.isBuffer(a.content) ? a.content.toString('base64') : null,
    rejectedReason,
  };
}

export async function parseInbound(raw: Buffer | string, opts: ParseOptions): Promise<InboundMessage> {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const parsed = await simpleParser(buf, {
    // The raw bytes are kept out of the parsed object; the caller already has them.
    skipHtmlToText: false,
    skipTextToHtml: false,
    skipImageLinks: true,
  });

  const from = addressesOf(parsed.from)[0] || { address: '', name: '' };
  const to = addressesOf(parsed.to);
  const cc = addressesOf(parsed.cc);
  const replyTo = addressesOf(parsed.replyTo)[0]?.address || null;
  const spam = extractSpamVerdict(parsed);

  // References can arrive as a string or an array depending on how many there were.
  const refsRaw = parsed.references;
  const references = !refsRaw ? [] : Array.isArray(refsRaw) ? refsRaw.map(String) : String(refsRaw).split(/\s+/).filter(Boolean);

  // The ENVELOPE wins over the headers. A Bcc'd recipient appears in no header at all, and an alias
  // delivers to a mailbox whose address is nowhere in To — using the headers to decide who a message
  // is for is how Bcc'd mail goes missing and how aliases silently stop working.
  const envelopeTo = (opts.envelope?.to || []).map((a) => a.toLowerCase()).filter(Boolean);
  const envelopeFrom = (opts.envelope?.from || from.address || '').toLowerCase();

  return {
    envelopeTo: envelopeTo.length ? envelopeTo : to.map((t) => t.address),
    envelopeFrom,
    rfcMessageId: parsed.messageId ? String(parsed.messageId) : null,
    inReplyTo: parsed.inReplyTo ? String(parsed.inReplyTo) : null,
    references,
    from,
    to,
    cc,
    replyTo,
    subject: String(parsed.subject || '').slice(0, 500),
    date: parsed.date ? new Date(parsed.date).toISOString() : null,
    text: String(parsed.text || ''),
    html: typeof parsed.html === 'string' ? parsed.html : '',
    attachments: (parsed.attachments || []).map((a) => toInboundAttachment(a, opts)),
    spamScore: spam.score,
    spamAction: spam.action,
    sizeBytes: buf.length,
    authResults: headerString(parsed, 'authentication-results'),
  };
}

/** True when the parsed message looks like a delivery report rather than a human's mail. */
export function looksLikeBounce(message: Pick<InboundMessage, 'envelopeFrom' | 'from' | 'subject'>): boolean {
  const envelope = (message.envelopeFrom || '').toLowerCase();
  // An empty envelope sender ("<>") is the RFC-required marker of a bounce: a delivery report must
  // never itself generate one, so it is sent with a null return path.
  if (envelope === '' || envelope === '<>') return true;
  const from = (message.from?.address || '').toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply)@/.test(from)) return true;
  return /^(undelivered mail returned|mail delivery (failed|system)|delivery status notification|returned mail|failure notice|undeliverable)/i.test(String(message.subject || ''));
}
