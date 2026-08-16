// src/lib/mailplatform/rfc.ts — RFC 5322 / 5321 helpers.
//
// Pure functions only: no database, no network, no clock beyond what is passed in. This is the
// module the SMTP/MTA agent, the webmail agent and the API routes all share, so that "what counts
// as a valid address", "what thread does this belong to" and "what does this Message-ID look like"
// have exactly ONE answer across four codebases.
//
// Where behaviour is a judgement call rather than a standard, the comment says which way it went
// and why.

import type { Address, Recipient, RecipientKind } from './types';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Address validation.
 *
 * Deliberately NOT the full RFC 5322 grammar. That grammar permits quoted local parts with spaces,
 * comments in parentheses and nested folding — all legal, none of it reachable through this
 * product's compose box, and a regex that tries has been a source of catastrophic backtracking in
 * every codebase that has attempted it. This accepts what real mail servers accept and rejects the
 * rest with a reason the sender can act on.
 */
export const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isValidEmail(input: unknown): boolean {
  const s = String(input || '').trim();
  // 320 = 64 local + @ + 255 domain, the RFC 5321 maximum. Longer is not a near miss; it is invalid.
  if (!s || s.length > 320) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return false;
  if (s.slice(0, at).length > 64) return false;
  return EMAIL_RE.test(s);
}

/** Lowercase and trim. The ONLY normalization applied — see the note on plus-addressing below. */
export function normalizeEmail(input: unknown): string {
  return String(input || '').trim().toLowerCase();
}

/**
 * The key an address is deduplicated and suppression-matched by.
 *
 * Plus-addressing (`user+tag@host`) is NOT stripped, and dots are NOT removed from the local part.
 * Both are provider-specific conventions, not standards: `a.b@` and `ab@` are the same mailbox at
 * one large provider and two different people at a self-hosted server. Collapsing them would
 * silently merge two real recipients into one, and on a suppression list it would stop mail to a
 * person who never asked us to.
 */
export function addressKey(input: unknown): string {
  return normalizeEmail(input);
}

export function domainOf(input: unknown): string {
  const s = normalizeEmail(input);
  const at = s.lastIndexOf('@');
  return at === -1 ? '' : s.slice(at + 1);
}

export function localPartOf(input: unknown): string {
  const s = normalizeEmail(input);
  const at = s.lastIndexOf('@');
  return at === -1 ? s : s.slice(0, at);
}

/** Parse `Display Name <addr@host>`, `<addr@host>` or a bare address. Never throws. */
export function parseAddress(raw: unknown): Address | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const angled = /^(.*?)<\s*([^>]+)\s*>\s*$/.exec(s);
  if (angled) {
    const name = angled[1].trim().replace(/^["']|["']$/g, '').trim();
    const email = angled[2].trim();
    if (!isValidEmail(email)) return null;
    return { email: normalizeEmail(email), name: name || null };
  }
  if (!isValidEmail(s)) return null;
  return { email: normalizeEmail(s), name: null };
}

/**
 * Split a To/Cc/Bcc field into addresses.
 *
 * Splits on comma, semicolon and newline, but NOT on a comma inside angle brackets or quotes — so
 * `"Prasad, Siddharth" <s@x.in>` stays one recipient instead of becoming two invalid ones.
 * Returns valid and invalid separately: an address we cannot parse is REPORTED, never dropped, so
 * a mistyped recipient cannot turn into a message that quietly went to fewer people than intended.
 */
export function parseAddressList(input: string | string[] | null | undefined): {
  addresses: Address[];
  invalid: string[];
} {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const addresses: Address[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  let buf = '';
  let inQuotes = false;
  let inAngle = false;
  const tokens: string[] = [];
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !inQuotes && !inAngle) {
      tokens.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  tokens.push(buf);

  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    const parsed = parseAddress(t);
    if (!parsed) {
      invalid.push(t);
      continue;
    }
    if (seen.has(parsed.email)) continue;
    seen.add(parsed.email);
    addresses.push(parsed);
  }
  return { addresses, invalid };
}

/** Render an address for a header. Quotes the display name when it contains a special character. */
export function formatAddress(addr: Address): string {
  if (!addr?.email) return '';
  const name = (addr.name || '').trim();
  if (!name) return addr.email;
  const needsQuoting = /[",;:<>@\[\]\\]/.test(name);
  const safe = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${needsQuoting ? `"${safe}"` : name} <${addr.email}>`;
}

/**
 * Build the recipient set for a message.
 *
 * Deduplicates ACROSS fields with to > cc > bcc precedence: an address in both To and Bcc is a To
 * recipient and appears once. Sending twice is the visible bug; the invisible one is a Bcc copy of
 * a message whose To line already names the reader, which leaks that they were also blind-copied.
 */
export function buildRecipients(fields: {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
}): { recipients: Recipient[]; invalid: string[] } {
  const invalid: string[] = [];
  const byEmail = new Map<string, Recipient>();
  const order: [RecipientKind, string | string[] | undefined][] = [
    ['to', fields.to],
    ['cc', fields.cc],
    ['bcc', fields.bcc],
  ];
  for (const [kind, value] of order) {
    const parsed = parseAddressList(value);
    invalid.push(...parsed.invalid);
    for (const a of parsed.addresses) {
      if (byEmail.has(a.email)) continue;
      byEmail.set(a.email, { email: a.email, name: a.name ?? null, kind });
    }
  }
  return { recipients: [...byEmail.values()], invalid };
}

// ---------------------------------------------------------------------------
// Message identifiers and threading
// ---------------------------------------------------------------------------

/** `<uuid@domain>`. The uuid is supplied so this stays pure and testable. */
export function makeMessageId(uuid: string, domain: string): string {
  const d = String(domain || 'localhost').trim().toLowerCase().replace(/^@/, '');
  return `<${uuid}@${d}>`;
}

export function isMessageId(value: unknown): boolean {
  const s = String(value || '').trim();
  return /^<[^\s<>@]+@[^\s<>@]+>$/.test(s);
}

/** Extract every `<...>` id from a References or In-Reply-To header, in order. */
export function parseReferences(header: unknown): string[] {
  const s = String(header || '');
  const out: string[] = [];
  const re = /<[^\s<>]+>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

/**
 * The References header for a reply.
 *
 * RFC 5322 §3.6.4: parent's References, then the parent's own Message-ID. Capped at 20 ids, keeping
 * the FIRST and the most recent — the head identifies the conversation root and the tail is what
 * clients actually match on, so a long thread stays threaded without an unbounded header.
 */
export function buildReferences(parentReferences: unknown, parentMessageId: unknown): string {
  const chain = parseReferences(parentReferences);
  const parent = String(parentMessageId || '').trim();
  if (parent && isMessageId(parent) && !chain.includes(parent)) chain.push(parent);
  if (chain.length <= 20) return chain.join(' ');
  return [chain[0], ...chain.slice(chain.length - 19)].join(' ');
}

const REPLY_PREFIX_RE = /^\s*(?:(?:re|fw|fwd|aw|antw|sv|vs|res|rif|odp|ynt|回复|转发)\s*(?:\[\d+\])?\s*:\s*)+/i;

/**
 * Strip reply/forward prefixes so `Re: Re: FW: Offer` and `Offer` land in the same thread.
 *
 * The prefix list is multilingual on purpose. A German client sends `AW:`, a Swedish one `SV:`, an
 * Italian one `R:`/`RIF:`; matching only `Re:` splits one conversation into a thread per client
 * locale, which is exactly the failure users describe as "my replies keep starting new threads".
 */
export function normalizeSubject(subject: unknown): string {
  let s = String(subject || '').replace(/\s+/g, ' ').trim();
  let previous = '';
  // Loop because a subject can carry several prefixes that only match one at a time.
  while (s !== previous) {
    previous = s;
    s = s.replace(REPLY_PREFIX_RE, '').trim();
  }
  return s;
}

/** The value threads are grouped by. Case-folded, prefix-stripped, length-bounded. */
export function threadKey(subject: unknown): string {
  return normalizeSubject(subject).toLowerCase().slice(0, 500);
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** Strip tags and collapse whitespace. Not a sanitizer — never render this as HTML. */
export function htmlToText(html: unknown): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    // Whitespace either side of a newline is stripped BEFORE runs of newlines are collapsed.
    // Without this `<p>a</p><p>b</p>` renders as "a\n\n b": the </p> produces the break and the
    // following <p> becomes the space the tag-stripper leaves behind — so every paragraph of every
    // plain-text body arrived indented by one character. Found by a test, not by a reader.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text to a minimal HTML body, escaped. Used when a caller supplies only `bodyText`. */
export function textToHtml(text: unknown): string {
  return '<div>' + escapeHtml(text).replace(/\n/g, '<br/>') + '</div>';
}

/** The preview line stored on the message row. Bounded so a list query never reads a body. */
export function makeSnippet(text: unknown, html?: unknown, max = 300): string {
  const source = String(text || '').trim() || htmlToText(html);
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Header names are case-insensitive per RFC 5322 §1.2.2; this is the canonical comparison form. */
export function headerKey(name: unknown): string {
  return String(name || '').trim().toLowerCase();
}

const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'reply-to',
  'return-path',
  'received',
  'dkim-signature',
  'content-type',
  'content-transfer-encoding',
  'mime-version',
]);

/**
 * Filter caller-supplied custom headers.
 *
 * A caller may not set From, Date, Message-ID, Return-Path or DKIM-Signature through the API. Those
 * are the headers that decide identity and authentication; allowing an integration to write them is
 * how an API key becomes a way to send mail that appears to come from someone else. CR and LF are
 * stripped from values, which is the header-injection hole that turns one header into an extra
 * recipient.
 */
export function sanitizeHeaders(input: Record<string, unknown> | null | undefined): {
  headers: Record<string, string>;
  rejected: string[];
} {
  const headers: Record<string, string> = {};
  const rejected: string[] = [];
  if (!input || typeof input !== 'object') return { headers, rejected };
  for (const [name, value] of Object.entries(input)) {
    const key = headerKey(name);
    if (!key || !/^[A-Za-z0-9-]+$/.test(key)) {
      rejected.push(String(name));
      continue;
    }
    if (RESERVED_HEADERS.has(key)) {
      rejected.push(String(name));
      continue;
    }
    const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!clean) continue;
    headers[name.trim()] = clean.slice(0, 998); // RFC 5322 line-length limit
  }
  return { headers, rejected };
}

// ---------------------------------------------------------------------------
// SMTP result classification
// ---------------------------------------------------------------------------

/** Pull the leading 3-digit reply code out of an SMTP response line. */
export function smtpCodeOf(response: unknown): number | null {
  const m = /\b([2-5]\d\d)\b/.exec(String(response || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Is this failure worth retrying?
 *
 * 4xx is a temporary failure by definition (RFC 5321 §4.2.1) and 5xx is permanent. Network-level
 * errors carry no code at all and are treated as retryable, because a socket timeout says nothing
 * about whether the address exists. Retrying a 5xx is how a hard bounce becomes five hard bounces
 * and a reputation problem, so the default when a code IS present is NOT to retry.
 */
export function isRetryableFailure(smtpCode: number | null | undefined, error?: unknown): boolean {
  if (typeof smtpCode === 'number') return smtpCode >= 400 && smtpCode < 500;
  const msg = String(error || '').toLowerCase();
  if (!msg) return false;
  // Both the errno form and the English form. nodemailer and the TLS layer report "connection reset
  // by peer" as often as ECONNRESET, and matching only the code form classified a reset socket as a
  // PERMANENT failure — dropping a message that a retry a second later would have delivered.
  return /timeout|etimedout|econnreset|connection reset|econnrefused|connection refused|ehostunreach|enetunreach|esocket|greylist|try again|temporar|too many connections|closed unexpectedly/.test(msg);
}

/**
 * Classify a bounce.
 *
 * A hard bounce suppresses the address permanently; a soft one does not. Getting this backwards in
 * either direction is expensive — suppress on a soft bounce and a customer stops receiving their
 * receipts after one full mailbox; treat a hard bounce as soft and we keep mailing a dead address
 * until a provider notices the pattern.
 */
export function classifyBounce(
  smtpCode: number | null | undefined,
  diagnostic?: unknown,
): 'hard' | 'soft' | 'block' | 'auto_reply' | 'unknown' {
  const text = String(diagnostic || '').toLowerCase();
  if (/auto[- ]?(reply|responder)|out of (the )?office|vacation|abwesenheit/.test(text)) return 'auto_reply';
  if (/blocked|blacklist|blocklist|spamhaus|policy reasons|rejected due to spam|reputation/.test(text)) return 'block';
  if (typeof smtpCode === 'number') {
    if (smtpCode >= 500) {
      // 5.7.x is a policy refusal (blocked), not "this person does not exist".
      if (/5\.7\.\d+/.test(text) || smtpCode === 550 && /policy|denied|blocked/.test(text)) return 'block';
      return 'hard';
    }
    if (smtpCode >= 400) return 'soft';
  }
  if (/user unknown|no such user|does not exist|invalid recipient|unrouteable|recipient rejected|550 5\.1\.1/.test(text)) return 'hard';
  if (/quota|mailbox full|over quota|temporarily deferred|greylist|try again later/.test(text)) return 'soft';
  return 'unknown';
}

/** Does this bounce mean "never mail this address again"? Only a hard bounce does. */
export function shouldSuppressAfterBounce(
  bounceType: ReturnType<typeof classifyBounce>,
  softBounceCount = 0,
): { suppress: boolean; reason: 'hard_bounce' | 'repeated_soft_bounce' | null } {
  if (bounceType === 'hard') return { suppress: true, reason: 'hard_bounce' };
  // Five consecutive soft bounces is a mailbox that has been full or unreachable for weeks. The
  // threshold is deliberately high: a single soft bounce is normal operation, not a signal.
  if (bounceType === 'soft' && softBounceCount >= 5) return { suppress: true, reason: 'repeated_soft_bounce' };
  return { suppress: false, reason: null };
}
