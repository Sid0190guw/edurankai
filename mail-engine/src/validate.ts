// mail-engine/src/validate.ts — the gate every message passes before it costs anything.
//
// The pipeline in section 4 of the brief puts validation before the suppression check and before the
// queue, and the order matters: a malformed address should never occupy a queue slot, and a header
// injection attempt should never reach the code that writes headers.
//
// HEADER INJECTION IS THE ONE THAT ACTUALLY MATTERS. A subject of
//     "Invoice\r\nBcc: everyone@example.com"
// written naively into a message adds a header. Every field that ends up on a header line is
// therefore checked for CR and LF here, at the boundary, rather than trusting each writer downstream
// to remember. nodemailer does encode these correctly, which makes this defence in depth — but the
// engine also writes raw headers in the bounce path, and defence in depth is the point.

import type { OutboundMessage } from './contracts/index.js';
import type { EngineConfig } from './config.js';

export interface ValidationIssue {
  field: string;
  problem: string;
  /** The offending value, truncated. Never the whole body. */
  value?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Recipients that parsed cleanly, deduplicated and lowercased. */
  recipients: string[];
  /** Approximate on-the-wire size, used against maxMessageBytes. */
  estimatedBytes: number;
}

/**
 * Address syntax. Deliberately stricter than RFC 5322 (which permits quoted strings, comments and
 * bare IP literals) and deliberately looser than a full parser: it accepts what real mail systems
 * hand out and rejects everything with a control character, a space or a missing part.
 */
const ADDRESS_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidAddress(address: string): boolean {
  const a = String(address || '').trim();
  if (!a || a.length > 320) return false;
  if (/[\r\n\t\0]/.test(a)) return false;
  const at = a.lastIndexOf('@');
  if (at < 1) return false;
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (local.length > 64 || domain.length > 255) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return ADDRESS_RE.test(a);
}

export function normalizeAddress(address: string): string {
  return String(address || '').trim().toLowerCase();
}

/** True when a value would break out of its header line. */
export function hasHeaderInjection(value: string | undefined | null): boolean {
  if (value == null) return false;
  return /[\r\n]/.test(String(value));
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || '').trim());
  return m ? m[1].toLowerCase() : '';
}

export function validateOutbound(message: OutboundMessage, cfg: EngineConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!message.messageId) issues.push({ field: 'messageId', problem: 'missing' });

  const from = normalizeAddress(message.from);
  if (!isValidAddress(from)) issues.push({ field: 'from', problem: 'not a valid address', value: String(message.from).slice(0, 120) });

  // Recipients: To + Cc + Bcc, deduplicated. Bcc recipients get their own envelope, so they are
  // just recipients here — the header is what must never carry them, and toNodemailer never writes it.
  const all = [...(message.to || []), ...(message.cc || []), ...(message.bcc || [])];
  const recipients: string[] = [];
  for (const raw of all) {
    const a = normalizeAddress(raw);
    if (!a) continue;
    if (!isValidAddress(a)) {
      issues.push({ field: 'to', problem: 'not a valid address', value: String(raw).slice(0, 120) });
      continue;
    }
    if (!recipients.includes(a)) recipients.push(a);
  }
  if (!recipients.length) issues.push({ field: 'to', problem: 'no valid recipients' });
  if (recipients.length > cfg.maxRecipientsPerMessage) {
    issues.push({ field: 'to', problem: `more than ${cfg.maxRecipientsPerMessage} recipients in one message` });
  }

  // Every field that becomes a header line.
  const headerFields: [string, string | undefined][] = [
    ['subject', message.subject],
    ['replyTo', message.replyTo],
    ['inReplyTo', message.inReplyTo],
    ['headerFrom', message.headerFrom],
    ['messageId', message.messageId],
  ];
  for (const [field, value] of headerFields) {
    if (hasHeaderInjection(value)) issues.push({ field, problem: 'contains CR or LF (header injection)', value: String(value).slice(0, 120) });
  }
  for (const [name, value] of Object.entries(message.headers || {})) {
    if (hasHeaderInjection(name) || hasHeaderInjection(value)) {
      issues.push({ field: `headers.${name}`, problem: 'contains CR or LF (header injection)' });
    }
    if (/^(bcc|received|return-path|dkim-signature|authentication-results)$/i.test(name)) {
      // Headers the engine controls. Letting a caller set these lets it forge a delivery path or an
      // authentication result, which is exactly what a receiver reads to decide whether to trust us.
      issues.push({ field: `headers.${name}`, problem: 'this header is set by the mail engine and cannot be supplied' });
    }
  }

  if (!message.subject && !message.text && !message.html) {
    issues.push({ field: 'body', problem: 'message has no subject and no body' });
  }

  // Size. base64 attachments are ~4/3 of their bytes; the estimate is on the encoded form, which is
  // what actually crosses the wire and what the receiving server measures against its own limit.
  let bytes = Buffer.byteLength(message.subject || '', 'utf8')
    + Buffer.byteLength(message.text || '', 'utf8')
    + Buffer.byteLength(message.html || '', 'utf8');
  for (const a of message.attachments || []) {
    const size = a.content ? Buffer.byteLength(a.content, 'utf8') : 0;
    bytes += size;
    if (size > cfg.maxAttachmentBytes) {
      issues.push({ field: 'attachments', problem: `${a.filename} is larger than the ${Math.round(cfg.maxAttachmentBytes / 1024 / 1024)}MB per-attachment limit` });
    }
    const ext = extensionOf(a.filename);
    if (ext && cfg.blockedAttachmentExtensions.includes(ext)) {
      issues.push({ field: 'attachments', problem: `.${ext} attachments are refused`, value: a.filename.slice(0, 120) });
    }
    if (hasHeaderInjection(a.filename)) {
      issues.push({ field: 'attachments', problem: 'filename contains CR or LF' });
    }
  }
  if (bytes > cfg.maxMessageBytes) {
    issues.push({ field: 'message', problem: `message is larger than the ${Math.round(cfg.maxMessageBytes / 1024 / 1024)}MB limit` });
  }

  return { ok: issues.length === 0, issues, recipients, estimatedBytes: bytes };
}

/**
 * Is this engine allowed to send AS this address? An engine that signs for edurankai.in must not
 * accept a message claiming to be from someone else's domain — that is what an open relay is, seen
 * from the submission side rather than the delivery side.
 */
export function isLocalSender(address: string, cfg: EngineConfig): boolean {
  const at = normalizeAddress(address).lastIndexOf('@');
  if (at === -1) return false;
  const domain = normalizeAddress(address).slice(at + 1);
  return cfg.domains.includes(domain);
}

/** Is this engine responsible for delivering TO this address (inbound recipient validation)? */
export function isLocalRecipient(address: string, cfg: EngineConfig): boolean {
  return isLocalSender(address, cfg);
}
