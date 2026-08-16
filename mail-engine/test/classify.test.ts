// Bounce classification. The table below is the contract between what a receiving server says and
// what this platform does about it — including the two decisions that touch real people: whether an
// address goes on the suppression list, and whether it ever comes off.

import { describe, it, expect } from 'vitest';
import {
  classifySmtpReply, classifyNetworkError, parseEnhancedCode, parseReplyCode, suppressionFor,
} from '../src/smtp/classify.js';

describe('parseEnhancedCode', () => {
  it('finds an RFC 3463 code anywhere in the reply', () => {
    expect(parseEnhancedCode('550 5.1.1 <a@b.com>: Recipient address rejected')).toBe('5.1.1');
    expect(parseEnhancedCode('452 4.2.2 Over quota')).toBe('4.2.2');
    expect(parseEnhancedCode('550 Requested action not taken')).toBeNull();
  });

  it('does not mistake a version number or an IP for a status code', () => {
    expect(parseEnhancedCode('220 mail.example.com ESMTP Postfix 3.6.4')).toBeNull();
    expect(parseEnhancedCode('554 5.7.1 Service unavailable; 192.0.2.1 blocked')).toBe('5.7.1');
  });
});

describe('parseReplyCode', () => {
  it('reads the leading three digits only', () => {
    expect(parseReplyCode('550 5.1.1 user unknown')).toBe(550);
    expect(parseReplyCode('  250 OK')).toBe(250);
    expect(parseReplyCode('user unknown')).toBeNull();
    expect(parseReplyCode('999 nonsense')).toBeNull();
  });
});

describe('classifySmtpReply — the permanence decision', () => {
  it('treats 2xx as delivered', () => {
    const r = classifySmtpReply(250, '250 2.0.0 Ok: queued as 3F2A1');
    expect(r.outcome).toBe('delivered');
    expect(r.bounceClass).toBeNull();
  });

  it('treats 4xx as deferred and 5xx as bounced', () => {
    expect(classifySmtpReply(451, '451 4.3.0 Temporary failure').outcome).toBe('deferred');
    expect(classifySmtpReply(550, '550 5.0.0 Rejected').outcome).toBe('bounced');
  });

  it('does not let prose overturn the reply code', () => {
    // A 4xx line that quotes a 5.x.x code in its text is still a deferral: the numeric code is the
    // server's actual verdict and the prose is commentary.
    const r = classifySmtpReply(450, '450 4.7.1 <a@b.com>: greylisted, see 5.1.1 in our docs');
    expect(r.outcome).toBe('deferred');
  });
});

describe('classifySmtpReply — the bounce class', () => {
  const cases: [number, string, string][] = [
    [550, '550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown', 'invalid_mailbox'],
    [550, '550 5.1.2 Host or domain name not found', 'invalid_domain'],
    [452, '452 4.2.2 The email account that you tried to reach is over quota', 'mailbox_full'],
    [552, '552 5.2.2 Mailbox full', 'mailbox_full'],
    [421, '421 4.7.0 Too many messages from this sender, try again later', 'rate_limited'],
    [554, '554 5.7.1 Message rejected as spam by Spamhaus', 'spam_rejection'],
    [550, '550 5.7.1 Relay access denied', 'policy_rejection'],
    [450, '450 4.2.0 Greylisted, please try again in 5 minutes', 'temporary_rejection'],
    [552, '552 5.3.4 Message size exceeds fixed maximum message size', 'content_rejection'],
    [550, '550 5.1.1 no such user here', 'invalid_mailbox'],
    [550, '550 Requested action not taken: mailbox unavailable', 'invalid_mailbox'],
  ];

  for (const [code, text, expected] of cases) {
    it(`${code} "${text.slice(4, 44)}..." -> ${expected}`, () => {
      expect(classifySmtpReply(code, text).bounceClass).toBe(expected);
    });
  }

  it('reads throttling out of a 4.7.x policy response instead of calling it a block', () => {
    // This distinction is why the text pass exists. Both are "policy" by enhanced code; only one of
    // them means "you are sending too fast", and only one of them should ever suppress an address.
    const throttle = classifySmtpReply(421, '421 4.7.0 [TSS04] Messages from 1.2.3.4 temporarily deferred due to volume');
    expect(throttle.bounceClass).toBe('rate_limited');
    expect(throttle.outcome).toBe('deferred');
  });

  it('falls back to hard/soft when nothing else is knowable', () => {
    expect(classifySmtpReply(550, '550 Nope').bounceClass).toBe('invalid_mailbox'); // 550 alone
    expect(classifySmtpReply(499, '499 Something odd').bounceClass).toBe('soft');
    expect(classifySmtpReply(599, '599 Something odd').bounceClass).toBe('hard');
  });
});

describe('classifyNetworkError', () => {
  it('treats NXDOMAIN as a permanent invalid domain', () => {
    const r = classifyNetworkError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nosuchdomain.invalid' });
    expect(r.outcome).toBe('bounced');
    expect(r.bounceClass).toBe('invalid_domain');
    expect(r.enhancedCode).toBe('5.1.2');
  });

  it('treats a timeout, a refusal and a reset as temporary', () => {
    for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN']) {
      const r = classifyNetworkError({ code, message: `connect ${code}` });
      expect(r.outcome, code).toBe('deferred');
      expect(r.bounceClass, code).toBe('connection_failure');
    }
  });

  it('defers rather than bounces on a TLS failure', () => {
    // A certificate expiry must not permanently stop mail to a whole domain.
    const r = classifyNetworkError({ message: 'unable to verify the first certificate' });
    expect(r.outcome).toBe('deferred');
  });

  it('unwraps an SMTP error that arrived as an exception', () => {
    const r = classifyNetworkError({ responseCode: 550, response: '550 5.1.1 User unknown', message: 'Message failed' });
    expect(r.outcome).toBe('bounced');
    expect(r.bounceClass).toBe('invalid_mailbox');
  });
});

describe('suppressionFor — who goes on the list, and for how long', () => {
  const now = Date.parse('2026-08-16T10:00:00Z');

  it('suppresses a non-existent mailbox permanently', () => {
    const s = suppressionFor('gone@example.com', 'invalid_mailbox', 'bounced', 'ev1', '550 user unknown', now);
    expect(s?.permanent).toBe(true);
    expect(s?.expiresAt).toBeNull();
  });

  it('suppresses a full mailbox only temporarily', () => {
    const s = suppressionFor('full@example.com', 'mailbox_full', 'bounced', 'ev1', '552 over quota', now);
    expect(s?.permanent).toBe(false);
    expect(Date.parse(s!.expiresAt!)).toBe(now + 7 * 24 * 60 * 60 * 1000);
  });

  it('NEVER suppresses on an ordinary deferral', () => {
    // The single most consequential rule here: one bad hour at a large provider must not turn into a
    // list of addresses this platform refuses to mail.
    expect(suppressionFor('a@example.com', 'rate_limited', 'deferred', 'ev1', null, now)).toBeNull();
    expect(suppressionFor('a@example.com', 'connection_failure', 'deferred', 'ev1', null, now)).toBeNull();
  });

  it('suppresses briefly when a message exhausts every retry', () => {
    const s = suppressionFor('a@example.com', 'soft', 'deferred', 'ev1', 'no response', now, true);
    expect(s?.permanent).toBe(false);
    expect(Date.parse(s!.expiresAt!)).toBe(now + 24 * 60 * 60 * 1000);
  });

  it('never suppresses a delivered recipient', () => {
    expect(suppressionFor('a@example.com', null, 'delivered', 'ev1', null, now)).toBeNull();
  });
});
