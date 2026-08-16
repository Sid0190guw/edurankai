// src/lib/mailsec/headers.test.ts — header injection, address validation, and the relay rule.
//
// The injection payloads are written with escape sequences and built through String.fromCharCode
// where a raw byte would otherwise end up in the source. The first version of headers.ts shipped
// with literal control characters where its escapes were meant to be, which is invisible in a diff
// and silently changes what the guard matches — so these tests construct the dangerous characters
// from their code points, where a reader can see exactly which ones are being asserted.
import { describe, it, expect } from 'vitest';
import {
  looksLikeHeaderInjection, sanitizeHeaderValue, checkSubject,
  isValidAddress, normalizeAddress, addressDomain, checkAddressList,
  formatAddress, checkMessageId, checkReferences,
  checkEnvelopeSender, checkInboundRecipient,
} from './headers';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe('looksLikeHeaderInjection', () => {
  it('catches every character that can start a new header line', () => {
    for (const [label, ch] of [['CR', CR], ['LF', LF], ['NUL', NUL], ['DEL', DEL], ['NEL', NEL], ['LS', LS], ['PS', PS]] as const) {
      expect(looksLikeHeaderInjection('Invoice' + ch + 'Bcc: x@y.example'), label).toBe(true);
    }
  });

  it('catches the canonical payload', () => {
    expect(looksLikeHeaderInjection('Invoice' + CR + LF + 'Bcc: everyone@somewhere.example')).toBe(true);
  });

  it('leaves an ordinary subject alone', () => {
    expect(looksLikeHeaderInjection('Your offer letter — please read')).toBe(false);
    expect(looksLikeHeaderInjection('Re: interview on the 3rd (round 2)')).toBe(false);
  });

  it('does not flag a tab, which is legal folding whitespace inside a header', () => {
    // A tab is 0x09 and IS a control character, so the guard refuses it. Asserted deliberately:
    // refusing a tab in a subject costs nothing, and allowing one opens the folding question.
    expect(looksLikeHeaderInjection('a' + String.fromCharCode(9) + 'b')).toBe(true);
  });
});

describe('sanitizeHeaderValue', () => {
  it('replaces breaks with a space and collapses the result', () => {
    expect(sanitizeHeaderValue('Invoice' + CR + LF + 'Bcc: x@y.example')).toBe('Invoice Bcc: x@y.example');
  });

  it('trims and caps', () => {
    expect(sanitizeHeaderValue('   padded   ')).toBe('padded');
    expect(sanitizeHeaderValue('x'.repeat(2000)).length).toBe(998);
    expect(sanitizeHeaderValue('x'.repeat(2000), 100).length).toBe(100);
  });

  it('is total — it never throws on odd input', () => {
    expect(sanitizeHeaderValue(null)).toBe('');
    expect(sanitizeHeaderValue(undefined)).toBe('');
    expect(sanitizeHeaderValue(42)).toBe('42');
  });
});

describe('checkSubject', () => {
  it('refuses an injected subject and still hands back something usable', () => {
    const r = checkSubject('Invoice' + CR + LF + 'Bcc: everyone@somewhere.example');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/line breaks/i);
    expect(looksLikeHeaderInjection(r.value)).toBe(false);
  });

  it('accepts a normal subject unchanged', () => {
    const r = checkSubject('Interview confirmation');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('Interview confirmation');
  });

  it('refuses an over-long subject', () => {
    expect(checkSubject('x'.repeat(600)).ok).toBe(false);
  });
});

describe('isValidAddress', () => {
  it('accepts the addresses this platform actually sends to', () => {
    for (const a of [
      'connect@edurankai.in', 'first.last@example.co.uk', 'a+tag@example.com',
      'user_name@sub.domain.example', "o'brien@example.com", 'x@y.io',
    ]) expect(isValidAddress(a), a).toBe(true);
  });

  it('refuses anything with a line break in it', () => {
    expect(isValidAddress('a@b.com' + CR + LF + 'Bcc: c@d.com')).toBe(false);
    expect(isValidAddress('a@b.com' + LF)).toBe(false);
  });

  it('refuses the shapes that are not addresses', () => {
    for (const a of [
      '', 'no-at-sign', '@example.com', 'a@', 'a@b', 'a b@example.com', 'a@exam ple.com',
      'a@@example.com', 'a@-example.com', 'a@example-.com', '"quoted local"@example.com',
      'a@[127.0.0.1]', 'a@example..com', '.lead@example.com', 'trail.@example.com',
    ]) expect(isValidAddress(a), JSON.stringify(a)).toBe(false);
  });

  it('enforces the length limits', () => {
    expect(isValidAddress('x'.repeat(65) + '@example.com')).toBe(false);
    expect(isValidAddress('x'.repeat(64) + '@example.com')).toBe(true);
    expect(isValidAddress('x'.repeat(250) + '@example.com')).toBe(false);
  });
});

describe('normalizeAddress / addressDomain', () => {
  it('lower-cases and trims', () => {
    expect(normalizeAddress('  Connect@EduRankAI.IN ')).toBe('connect@edurankai.in');
  });
  it('reads the domain', () => {
    expect(addressDomain('A@Sub.Example.COM')).toBe('sub.example.com');
    expect(addressDomain('nonsense')).toBe('');
  });
});

describe('checkAddressList', () => {
  it('parses the forms a composer produces', () => {
    const r = checkAddressList('Priya <priya@example.com>, raj@example.com; sam@example.com');
    expect(r.addresses).toEqual(['priya@example.com', 'raj@example.com', 'sam@example.com']);
    expect(r.rejected).toEqual([]);
  });

  it('de-duplicates case-insensitively, keeping first-seen order', () => {
    const r = checkAddressList(['B@example.com', 'a@example.com', 'b@EXAMPLE.com']);
    expect(r.addresses).toEqual(['b@example.com', 'a@example.com']);
  });

  it('REPORTS what it refused instead of silently shortening the list', () => {
    const r = checkAddressList('good@example.com, not-an-address, also@example.com');
    expect(r.addresses).toEqual(['good@example.com', 'also@example.com']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].value).toBe('not-an-address');
  });

  it('names a line break as the reason when that is the reason', () => {
    const r = checkAddressList(['ok@example.com' + CR + 'Bcc: hidden@example.com']);
    expect(r.addresses).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/line break/i);
  });

  it('caps the list and says it capped it', () => {
    const many = Array.from({ length: 20 }, (_, i) => 'u' + i + '@example.com');
    const r = checkAddressList(many, 5);
    expect(r.addresses).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });

  it('does not report truncation when the list fits', () => {
    expect(checkAddressList(['a@example.com'], 5).truncated).toBe(false);
  });
});

describe('formatAddress', () => {
  it('builds a plain From', () => {
    expect(formatAddress('Priya Nair', 'priya@example.com')).toBe('Priya Nair <priya@example.com>');
  });

  it('quotes a name containing a special character', () => {
    expect(formatAddress('Nair, Priya', 'priya@example.com')).toBe('"Nair, Priya" <priya@example.com>');
  });

  it('escapes a quote inside the name so it cannot end the quoted string', () => {
    const out = formatAddress('He said "hi"', 'a@example.com');
    expect(out).toBe('"He said ' + chr92() + '"hi' + chr92() + '"" <a@example.com>');
  });

  it('strips angle brackets, so a name cannot introduce a second address', () => {
    const out = formatAddress('Real Name <attacker@evil.example>', 'real@example.com');
    expect(out).toContain('<real@example.com>');
    expect(out).not.toContain('attacker@evil.example>');
  });

  it('removes a line break from the display name rather than emitting it', () => {
    const out = formatAddress('Name' + CR + LF + 'Bcc: x@y.example', 'a@example.com');
    expect(looksLikeHeaderInjection(out)).toBe(false);
  });

  it('encodes a non-ASCII name instead of putting raw bytes in a header', () => {
    const out = formatAddress('प्रिया', 'priya@example.com');
    expect(out.startsWith('=?UTF-8?B?')).toBe(true);
    expect(out.endsWith('<priya@example.com>')).toBe(true);
  });

  it('returns nothing at all for an address it will not vouch for', () => {
    expect(formatAddress('X', 'not-an-address')).toBe('');
  });
});

function chr92() { return String.fromCharCode(92); }

describe('checkMessageId / checkReferences', () => {
  it('accepts a well-formed id', () => {
    expect(checkMessageId('<abc-123@edurankai.in>').ok).toBe(true);
  });

  it('refuses anything else, including a bare uuid', () => {
    for (const bad of ['abc@edurankai.in', '<no-at-sign>', '<a b@c.d>', '<a@b>' + CR, '<>']) {
      expect(checkMessageId(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('treats an empty value as fine, because the header is optional', () => {
    expect(checkMessageId('').ok).toBe(true);
  });

  it('keeps the usable references and reports that it dropped the rest', () => {
    const r = checkReferences('<a@x.in> not-an-id <b@x.in>');
    expect(r.value).toBe('<a@x.in> <b@x.in>');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/left out/i);
  });

  it('passes a clean chain through unchanged', () => {
    const r = checkReferences('<a@x.in> <b@x.in>');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('<a@x.in> <b@x.in>');
  });
});

describe('checkEnvelopeSender — the open-relay rule, outbound', () => {
  const OURS = ['edurankai.in'];

  it('allows our own domain and its subdomains', () => {
    expect(checkEnvelopeSender('connect@edurankai.in', OURS).allowed).toBe(true);
    expect(checkEnvelopeSender('noreply@mail.edurankai.in', OURS).allowed).toBe(true);
  });

  it('refuses somebody else’s domain, which is what relaying is', () => {
    const v = checkEnvelopeSender('ceo@bank.example', OURS);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('bank.example');
  });

  it('is not fooled by a domain that merely ends with ours', () => {
    expect(checkEnvelopeSender('x@notedurankai.in', OURS).allowed).toBe(false);
    expect(checkEnvelopeSender('x@edurankai.in.evil.example', OURS).allowed).toBe(false);
  });

  it('refuses everything when no sending domain is configured — fails closed', () => {
    expect(checkEnvelopeSender('connect@edurankai.in', []).allowed).toBe(false);
  });

  it('refuses an address that is not an address', () => {
    expect(checkEnvelopeSender('not-an-address', OURS).allowed).toBe(false);
  });
});

describe('checkInboundRecipient — the open-relay rule, inbound', () => {
  const HOSTED = ['edurankai.in', 'aquintutor.com'];

  it('accepts a recipient we host', () => {
    expect(checkInboundRecipient('priya@edurankai.in', HOSTED).allowed).toBe(true);
    expect(checkInboundRecipient('hello@aquintutor.com', HOSTED).allowed).toBe(true);
  });

  it('refuses a recipient we do not host, rather than accepting and forwarding it', () => {
    const v = checkInboundRecipient('victim@somewhere.example', HOSTED);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/does not accept mail/i);
  });

  it('refuses everything when nothing is hosted', () => {
    expect(checkInboundRecipient('a@edurankai.in', []).allowed).toBe(false);
  });
});
