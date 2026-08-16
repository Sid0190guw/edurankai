// RFC helper tests — addresses, threading, headers and SMTP classification.
//
// Every case here is a real failure mode, not a coverage exercise. Where a test exists because
// getting it wrong sends mail to the wrong person or suppresses the right one, the comment says so.

import { describe, it, expect } from 'vitest';
import {
  addressKey,
  buildRecipients,
  buildReferences,
  classifyBounce,
  domainOf,
  formatAddress,
  htmlToText,
  isRetryableFailure,
  isValidEmail,
  makeMessageId,
  makeSnippet,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  parseReferences,
  sanitizeHeaders,
  shouldSuppressAfterBounce,
  smtpCodeOf,
  threadKey,
} from './rfc';

describe('address validation', () => {
  it('accepts ordinary addresses', () => {
    for (const address of ['a@b.co', 'first.last@sub.example.org', "o'brien@example.com", 'user+tag@example.com']) {
      expect(isValidEmail(address), address).toBe(true);
    }
  });

  it('rejects what real servers reject', () => {
    for (const bad of ['', 'no-at-sign', '@example.com', 'user@', 'user@localhost', 'a b@example.com', 'user@exam ple.com']) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it('enforces the RFC 5321 length limits', () => {
    expect(isValidEmail('a'.repeat(65) + '@example.com')).toBe(false); // local part max 64
    expect(isValidEmail('a'.repeat(64) + '@example.com')).toBe(true);
    expect(isValidEmail('a@' + 'b'.repeat(400) + '.com')).toBe(false);
  });

  it('does NOT strip plus-addressing or dots when keying an address', () => {
    // Collapsing these would merge two different recipients at a self-hosted server into one, and
    // on the suppression list it would stop mail to somebody who never asked us to.
    expect(addressKey('User+Newsletter@Example.com')).toBe('user+newsletter@example.com');
    expect(addressKey('first.last@example.com')).toBe('first.last@example.com');
    expect(addressKey('first.last@example.com')).not.toBe('firstlast@example.com');
  });

  it('reads the domain from the LAST @, not the first', () => {
    expect(domainOf('"odd@name"@example.com')).toBe('example.com');
  });
});

describe('address list parsing', () => {
  it('does not split on a comma inside a quoted display name', () => {
    // Splitting here turns one recipient into two invalid ones, and the message goes nowhere.
    const parsed = parseAddressList('"Prasad, Siddharth" <s@example.in>, other@example.com');
    expect(parsed.addresses.map((a) => a.email)).toEqual(['s@example.in', 'other@example.com']);
    expect(parsed.invalid).toEqual([]);
  });

  it('does not split on a comma inside angle brackets', () => {
    const parsed = parseAddressList('Name <a@example.com>; b@example.com\nc@example.com');
    expect(parsed.addresses).toHaveLength(3);
  });

  it('REPORTS an unparsable address rather than dropping it', () => {
    // A message that reached three of four intended people with no indication which one was missed
    // is the failure a user cannot debug.
    const parsed = parseAddressList('good@example.com, not-an-address, also.good@example.com');
    expect(parsed.addresses).toHaveLength(2);
    expect(parsed.invalid).toEqual(['not-an-address']);
  });

  it('deduplicates within a field', () => {
    expect(parseAddressList('a@example.com, A@Example.com').addresses).toHaveLength(1);
  });

  it('parses a display name and drops surrounding quotes', () => {
    expect(parseAddress('"Jane Doe" <jane@example.com>')).toEqual({ email: 'jane@example.com', name: 'Jane Doe' });
    expect(parseAddress('<bare@example.com>')).toEqual({ email: 'bare@example.com', name: null });
    expect(parseAddress('nope')).toBeNull();
  });

  it('quotes a display name that contains a special character', () => {
    expect(formatAddress({ email: 'a@b.co', name: 'Prasad, S' })).toBe('"Prasad, S" <a@b.co>');
    expect(formatAddress({ email: 'a@b.co', name: 'Plain Name' })).toBe('Plain Name <a@b.co>');
    expect(formatAddress({ email: 'a@b.co', name: null })).toBe('a@b.co');
  });
});

describe('recipient building', () => {
  it('deduplicates across to/cc/bcc with to winning', () => {
    // The invisible failure this prevents: a Bcc copy of a message whose To line already names the
    // reader, which reveals that they were also blind-copied.
    const { recipients } = buildRecipients({ to: 'a@x.com', cc: 'a@x.com, b@x.com', bcc: 'a@x.com' });
    expect(recipients).toHaveLength(2);
    expect(recipients.find((r) => r.email === 'a@x.com')?.kind).toBe('to');
    expect(recipients.find((r) => r.email === 'b@x.com')?.kind).toBe('cc');
  });

  it('collects invalid addresses from every field', () => {
    const { invalid } = buildRecipients({ to: 'bad1', cc: 'bad2', bcc: 'ok@x.com' });
    expect(invalid.sort()).toEqual(['bad1', 'bad2']);
  });
});

describe('threading', () => {
  it('strips reply prefixes in several languages', () => {
    // Matching only "Re:" splits one conversation into a thread per client locale — which is what
    // users describe as "my replies keep starting new threads".
    expect(normalizeSubject('Re: Offer')).toBe('Offer');
    expect(normalizeSubject('RE: FW: Re: Offer')).toBe('Offer');
    expect(normalizeSubject('AW: Angebot')).toBe('Angebot');
    expect(normalizeSubject('SV: Erbjudande')).toBe('Erbjudande');
    expect(normalizeSubject('Re[2]: Offer')).toBe('Offer');
  });

  it('leaves a subject that merely starts with those letters alone', () => {
    expect(normalizeSubject('Real estate update')).toBe('Real estate update');
    expect(normalizeSubject('Review requested')).toBe('Review requested');
  });

  it('produces a case-folded, bounded thread key', () => {
    expect(threadKey('Re:  Quarterly   Report ')).toBe('quarterly report');
    expect(threadKey('x'.repeat(600)).length).toBe(500);
  });

  it('builds a References chain per RFC 5322 §3.6.4', () => {
    expect(buildReferences('<a@x>', '<b@x>')).toBe('<a@x> <b@x>');
    expect(buildReferences(null, '<b@x>')).toBe('<b@x>');
    expect(buildReferences('<a@x> <b@x>', '<b@x>')).toBe('<a@x> <b@x>'); // no duplicate
  });

  it('caps a long chain while keeping the root and the tail', () => {
    const long = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(' ');
    const chain = buildReferences(long, '<new@x>').split(' ');
    expect(chain).toHaveLength(20);
    expect(chain[0]).toBe('<m0@x>');          // the root identifies the conversation
    expect(chain[chain.length - 1]).toBe('<new@x>'); // the tail is what clients match on
  });

  it('extracts ids from a header', () => {
    expect(parseReferences('<a@x> <b@x>\n\t<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences(null)).toEqual([]);
  });

  it('makes a well-formed Message-ID', () => {
    expect(makeMessageId('abc-123', 'edurankai.in')).toBe('<abc-123@edurankai.in>');
  });
});

describe('header sanitization', () => {
  it('refuses headers that decide identity or authentication', () => {
    // Allowing an integration to set From or DKIM-Signature is how an API key becomes a way to send
    // mail that appears to come from someone else.
    const { headers, rejected } = sanitizeHeaders({
      From: 'attacker@evil.com',
      'DKIM-Signature': 'v=1;...',
      'Message-ID': '<forged@x>',
      'X-Campaign': 'spring',
    });
    expect(rejected.sort()).toEqual(['DKIM-Signature', 'From', 'Message-ID']);
    expect(headers).toEqual({ 'X-Campaign': 'spring' });
  });

  it('strips CR and LF from a value', () => {
    // This is header injection: without stripping, one header becomes an extra Bcc recipient.
    const { headers } = sanitizeHeaders({ 'X-Note': 'hello\r\nBcc: victim@example.com' });
    expect(headers['X-Note']).toBe('hello Bcc: victim@example.com');
    expect(headers['X-Note']).not.toContain('\n');
  });

  it('rejects a header name that is not a token', () => {
    const { rejected } = sanitizeHeaders({ 'bad name': 'x', 'also:bad': 'y' });
    expect(rejected).toHaveLength(2);
  });
});

describe('SMTP classification', () => {
  it('reads the reply code out of a response', () => {
    expect(smtpCodeOf('550 5.1.1 User unknown')).toBe(550);
    expect(smtpCodeOf('421 Service not available')).toBe(421);
    expect(smtpCodeOf('connection reset')).toBeNull();
  });

  it('retries a 4xx and never a 5xx', () => {
    // Retrying a 5xx turns one hard bounce into five and becomes a reputation problem.
    expect(isRetryableFailure(451)).toBe(true);
    expect(isRetryableFailure(550)).toBe(false);
  });

  it('retries a network error that carries no code', () => {
    // A socket timeout says nothing about whether the address exists.
    expect(isRetryableFailure(null, 'ETIMEDOUT')).toBe(true);
    expect(isRetryableFailure(null, 'connection reset by peer')).toBe(true);
    expect(isRetryableFailure(null, 'mailbox does not exist')).toBe(false);
  });

  it('classifies bounces', () => {
    expect(classifyBounce(550, '5.1.1 user unknown')).toBe('hard');
    expect(classifyBounce(452, 'mailbox full')).toBe('soft');
    expect(classifyBounce(550, 'blocked by policy reasons')).toBe('block');
    expect(classifyBounce(null, 'Out of Office: I am on leave')).toBe('auto_reply');
    expect(classifyBounce(null, 'something unfamiliar')).toBe('unknown');
  });

  it('suppresses on a hard bounce and not on one soft bounce', () => {
    // Suppressing on a single soft bounce stops a customer's receipts after one full mailbox.
    expect(shouldSuppressAfterBounce('hard')).toEqual({ suppress: true, reason: 'hard_bounce' });
    expect(shouldSuppressAfterBounce('soft', 1).suppress).toBe(false);
    expect(shouldSuppressAfterBounce('soft', 5)).toEqual({ suppress: true, reason: 'repeated_soft_bounce' });
  });

  it('never suppresses on an auto-reply', () => {
    // Otherwise going on holiday unsubscribes you.
    expect(shouldSuppressAfterBounce('auto_reply', 99).suppress).toBe(false);
  });
});

describe('bodies', () => {
  it('turns HTML into readable text', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello\n\nWorld');
    expect(htmlToText('<script>alert(1)</script>Text')).toBe('Text');
    expect(htmlToText('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });

  it('makes a bounded snippet', () => {
    expect(makeSnippet('  a   b  ')).toBe('a b');
    expect(makeSnippet(null, '<p>from html</p>')).toBe('from html');
    const long = makeSnippet('x'.repeat(500));
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });
});
