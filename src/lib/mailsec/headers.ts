// src/lib/mailsec/headers.ts — NOTHING A CALLER TYPES MAY BECOME A HEADER OF ITS OWN.
//
// ═══ WHAT THIS GUARDS ═══
//
// /api/mail/send takes `subject`, `inReplyTo` and (through the composer) a display name from a
// request body, and hands them to nodemailer, which writes them into the message as headers. A
// value containing a carriage return and a line feed does not stay one header:
//
//     subject = "Invoice\r\nBcc: everyone@somewhere.example\r\nX-Priority: 1"
//
// becomes a Subject line, a Bcc line and an X-Priority line. That is header injection, and on a
// path that sends real mail from the company address it is a way to add recipients nobody can see,
// forge a Reply-To, or attach a body of the attacker's choosing.
//
// ═══ WHY THIS FILE EXISTS WHEN NODEMAILER ALREADY ENCODES HEADERS ═══
//
// It does, and that is very probably why this has never been exploited here. But:
//
//   - "safe because of what a dependency does" is a dependency, not a control. The installed
//     nodemailer carries GHSA-p6gq-j5cr-w38f, which is a reminder that its safety properties are
//     version-dependent facts, not axioms.
//   - The address lists ARE currently safe, but by accident: parseAddressList() extracts addresses
//     with a regex that cannot match a newline, so CR/LF cannot survive into an address. Nobody
//     wrote that down as the reason, and a future rewrite of address parsing would remove the
//     protection without anyone noticing it was there.
//   - The mail-engine SMTP path being built alongside this one writes its own headers, and a
//     control that lives inside nodemailer does not travel with the message when the transport
//     changes.
//
// So the rule is stated once, here, and applied by the callers. Every function REFUSES rather than
// silently repairing where a silent repair would change the sender's meaning — a subject with a
// newline in it is a mistake worth reporting, not a subject to quietly join up.
//
// ═══ WHY THE CHARACTER TESTS ARE LOOPS AND NOT REGEXES ═══
//
// A regex for "every C0 control and DEL" has to carry escape sequences, and the first version of
// this file shipped with LITERAL control bytes embedded in the source where those escapes were
// meant to be. That is invisible in a diff, survives review, and changes the meaning of the class.
// A loop over `charCodeAt` states the code points as numbers, where they can be read and cannot be
// mistyped into something else.
//
// Pure. No database, no network, no imports.

/** Line feed, carriage return, every other C0 control, DEL, and the three Unicode line separators. */
function isBreakingCodePoint(c: number): boolean {
  return c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029;
}

export interface HeaderCheck {
  ok: boolean;
  /** The value it is safe to use. Present whether or not `ok` — callers that must not fail can use it. */
  value: string;
  /** Why it was not ok. Empty when it was. */
  reason: string;
}

const GOOD = (value: string): HeaderCheck => ({ ok: true, value, reason: '' });
const BAD = (value: string, reason: string): HeaderCheck => ({ ok: false, value, reason });

/** True when this string would break out of the header it is placed in. */
export function looksLikeHeaderInjection(raw: unknown): boolean {
  const s = String(raw ?? '');
  for (let i = 0; i < s.length; i++) if (isBreakingCodePoint(s.charCodeAt(i))) return true;
  return false;
}

/**
 * Make a value safe to place in a header, whatever it was.
 *
 * Used where refusing is worse than repairing — a signature, a generated subject, an automated
 * notification. Callers handling human input should use the checking form and report the refusal.
 */
export function sanitizeHeaderValue(raw: unknown, maxLength = 998): string {
  const s = String(raw ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += isBreakingCodePoint(s.charCodeAt(i)) ? ' ' : s[i];
  }
  return out.replace(/\s{2,}/g, ' ').trim().slice(0, maxLength);
}

/**
 * A subject line.
 *
 * 998 is the RFC 5322 line-length limit; a longer subject is folded by the transport, and folding a
 * value that already contains an injected break is how a half-checked subject becomes two headers.
 */
export function checkSubject(raw: unknown): HeaderCheck {
  const s = String(raw ?? '');
  if (looksLikeHeaderInjection(s)) {
    return BAD(sanitizeHeaderValue(s, 500), 'A subject cannot contain line breaks or control characters.');
  }
  if (s.length > 500) return BAD(s.slice(0, 500), 'That subject is too long.');
  return GOOD(s);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Addresses
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A deliberately conservative address shape.
 *
 * It rejects things RFC 5322 technically permits — quoted local parts, comments, bare IP domain
 * literals — because none of them arrive from a real sender on this platform, all of them are
 * awkward for every downstream consumer, and each one is a parsing corner where an injection can
 * hide. A sender who genuinely needs one gets a clear refusal instead of a silently mangled address.
 */
const ADDRESS_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidAddress(raw: unknown): boolean {
  // THE INJECTION CHECK COMES BEFORE THE TRIM, and that ordering is the whole point.
  // `'a@b.com\n'` trims to a perfectly valid address, so a guard that trims first answers "valid"
  // about a string that still has a newline in it — and the caller who then uses the value it was
  // handed, rather than a re-trimmed copy, writes that newline into a header. Refuse the input we
  // were actually given.
  if (looksLikeHeaderInjection(raw)) return false;
  const s = String(raw ?? '').trim();
  if (!s || s.length > 254) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || s.length - at - 1 > 253) return false;
  if (s.slice(0, at).length > 64) return false;
  return ADDRESS_RE.test(s);
}

/** Lower-cased and trimmed. The one normalisation everything else compares against. */
export function normalizeAddress(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/** The domain part, lower-cased, or '' when the address is not one. */
export function addressDomain(raw: unknown): string {
  const s = normalizeAddress(raw);
  const at = s.lastIndexOf('@');
  return at > 0 ? s.slice(at + 1) : '';
}

export interface AddressListResult {
  /** Valid, normalised, de-duplicated, in the order first seen. */
  addresses: string[];
  /** Entries that were refused, with the reason. Never silently dropped. */
  rejected: { value: string; reason: string }[];
  /** True when the list was cut short by `max`. */
  truncated: boolean;
}

/**
 * Normalise a recipient list.
 *
 * REFUSALS ARE RETURNED, NOT DISCARDED. A send that quietly drops the one address it could not
 * parse and reports success is the same failure as a distribution list that expands to nobody:
 * the sender believes the message reached someone it did not.
 */
export function checkAddressList(input: unknown, max = 500): AddressListResult {
  const raw: string[] = Array.isArray(input)
    ? input.map((x) => String(x ?? ''))
    : String(input ?? '').split(/[,;\n]+/);

  const addresses: string[] = [];
  const rejected: { value: string; reason: string }[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (addresses.length >= max) { truncated = true; break; }

    // "Display Name <addr@example.com>" — take the angle-addr, ignore the name.
    const angle = /<([^>]*)>\s*$/.exec(trimmed);
    const candidate = (angle ? angle[1] : trimmed).trim();

    if (!isValidAddress(candidate)) {
      rejected.push({
        value: trimmed.slice(0, 120),
        reason: looksLikeHeaderInjection(trimmed)
          ? 'that address contained a line break, which is not something an address can contain'
          : 'that is not an email address we can send to',
      });
      continue;
    }
    const norm = normalizeAddress(candidate);
    if (seen.has(norm)) continue;
    seen.add(norm);
    addresses.push(norm);
  }

  return { addresses, rejected, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Constructed headers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** True when every character is printable ASCII, which is what may go in a header unencoded. */
function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/**
 * `Name <addr@example.com>`, built so the name cannot escape its own quotes.
 *
 * A display name is the field a person is most likely to have pasted something odd into, and it is
 * the one that gets concatenated into a From header by string arithmetic in three places in this
 * codebase today. Non-ASCII is encoded per RFC 2047 rather than passed through, because a raw UTF-8
 * byte in a header is not portable and some relays will re-encode it — badly.
 */
export function formatAddress(name: unknown, email: unknown): string {
  const addr = normalizeAddress(email);
  if (!isValidAddress(addr)) return '';
  const clean = sanitizeHeaderValue(name, 120).replace(/[<>]/g, '');
  if (!clean) return addr;

  if (!isPrintableAscii(clean)) {
    return '=?UTF-8?B?' + Buffer.from(clean, 'utf8').toString('base64') + '?= <' + addr + '>';
  }
  if (/[()<>@,;:\\".[\]]/.test(clean)) {
    return '"' + clean.replace(/([\\"])/g, '\\$1') + '" <' + addr + '>';
  }
  return clean + ' <' + addr + '>';
}

/** `<local@domain>`. Anything else is refused — a Message-ID is machine-generated, never typed. */
export function checkMessageId(raw: unknown): HeaderCheck {
  // Before the trim, for the reason given on isValidAddress: `'<a@b>\r'` is not a message id that
  // happens to have trailing whitespace, it is a message id with a carriage return in it.
  if (looksLikeHeaderInjection(raw)) return BAD('', 'That message id contained a line break.');
  const s = String(raw ?? '').trim();
  if (!s) return GOOD('');
  if (s.length > 998) return BAD('', 'That message id is too long.');
  if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(s)) return BAD('', 'That is not a message id.');
  return GOOD(s);
}

/**
 * The References / In-Reply-To value: a space-separated run of message ids.
 *
 * Returns only the ids that were well-formed. A malformed entry breaks threading for the recipient,
 * which is annoying; a malformed entry passed through breaks the header, which is not.
 */
export function checkReferences(raw: unknown, maxIds = 20): HeaderCheck {
  const s = String(raw ?? '').trim();
  if (!s) return GOOD('');
  const ids = s.split(/\s+/).filter(Boolean).slice(0, maxIds);
  const good = ids.filter((id) => checkMessageId(id).ok);
  if (!good.length) return BAD('', 'None of those message ids were usable.');
  return good.length === ids.length
    ? GOOD(good.join(' '))
    : BAD(good.join(' '), 'Some message ids were not usable and were left out.');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Envelope authorisation — the "never an open relay" rule, in the one place both transports can ask
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface EnvelopeVerdict {
  allowed: boolean;
  reason: string;
}

function domainMatches(domain: string, owned: readonly string[]): boolean {
  return owned.some((d) => domain === d || domain.endsWith('.' + d));
}

function ownedList(domains: readonly string[]): string[] {
  return domains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean);
}

/**
 * May this envelope sender leave through us?
 *
 * The rule an outbound path must never be without: WE SIGN WHAT WE SEND, so the address in the
 * envelope must be one of ours. Relaying somebody else's domain out of our IP is what makes a
 * sender an open relay whether or not it has an SMTP listener — the reputation consequence is
 * identical, and it is our reputation.
 *
 * `sendingDomains` is passed in rather than read from the environment here, so the caller decides
 * what "ours" means: today MAIL_DOMAIN, and later the verified-domain table, without this function
 * changing.
 */
export function checkEnvelopeSender(from: unknown, sendingDomains: readonly string[]): EnvelopeVerdict {
  const addr = normalizeAddress(from);
  if (!isValidAddress(addr)) return { allowed: false, reason: 'The sender address is not a valid address.' };
  const owned = ownedList(sendingDomains);
  if (!owned.length) return { allowed: false, reason: 'No sending domain is configured, so nothing may be sent.' };
  return domainMatches(addressDomain(addr), owned)
    ? { allowed: true, reason: '' }
    : { allowed: false, reason: 'Mail cannot be sent as ' + addressDomain(addr) + ' from here. Use an address on a domain this platform sends for.' };
}

/**
 * May we accept this recipient for delivery INTO the platform?
 *
 * The inbound counterpart, and the other half of the open-relay rule: an inbound endpoint that
 * accepts a recipient it does not host, and then forwards it, is a relay. Accepting and dropping is
 * not much better — that is mail silently discarded — so the caller is expected to answer a refusal
 * to the sending side rather than swallow it.
 */
export function checkInboundRecipient(to: unknown, hostedDomains: readonly string[]): EnvelopeVerdict {
  const addr = normalizeAddress(to);
  if (!isValidAddress(addr)) return { allowed: false, reason: 'That is not a valid recipient address.' };
  const hosted = ownedList(hostedDomains);
  return domainMatches(addressDomain(addr), hosted)
    ? { allowed: true, reason: '' }
    : { allowed: false, reason: 'This server does not accept mail for ' + addressDomain(addr) + '.' };
}
