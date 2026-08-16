// Message validation. The header-injection cases are the reason this file exists: everything else
// here is hygiene, and those are a security boundary.

import { describe, it, expect } from 'vitest';
import { validateOutbound, isValidAddress, hasHeaderInjection, isLocalSender, extensionOf } from '../src/validate.js';
import { testConfig } from './helpers/harness.js';
import type { OutboundMessage } from '../src/contracts/index.js';

const cfg = testConfig();

function msg(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    messageId: 'm1',
    from: 'noreply@edurankai.in',
    to: ['learner@example.com'],
    subject: 'Your certificate is ready',
    text: 'Congratulations.',
    ...over,
  };
}

describe('isValidAddress', () => {
  it('accepts the addresses real people have', () => {
    for (const a of [
      'a@b.co', 'first.last@example.com', 'user+tag@example.co.uk',
      'siddharth@edurankai.in', "o'brien@example.com".replace("'", ''), 'x_y-z@sub.domain.example',
    ]) expect(isValidAddress(a), a).toBe(true);
  });

  it('rejects what is not an address', () => {
    for (const a of [
      '', 'nobody', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a@b .com',
      '.leading@example.com', 'trailing.@example.com', 'double..dot@example.com',
      'a@b..com', 'a'.repeat(65) + '@example.com',
    ]) expect(isValidAddress(a), a).toBe(false);
  });

  it('rejects an address carrying a newline', () => {
    expect(isValidAddress('victim@example.com\nBcc: everyone@example.com')).toBe(false);
    expect(isValidAddress('victim@example.com\r\nBcc: everyone@example.com')).toBe(false);
  });
});

describe('hasHeaderInjection', () => {
  it('catches CR and LF wherever they appear', () => {
    expect(hasHeaderInjection('Invoice\r\nBcc: everyone@example.com')).toBe(true);
    expect(hasHeaderInjection('Invoice\nX-Priority: 1')).toBe(true);
    expect(hasHeaderInjection('Invoice for July')).toBe(false);
    expect(hasHeaderInjection(undefined)).toBe(false);
  });
});

describe('validateOutbound', () => {
  it('accepts an ordinary message and normalises its recipients', () => {
    const r = validateOutbound(msg({ to: ['Learner@Example.COM'], cc: ['tutor@example.com'] }), cfg);
    expect(r.ok).toBe(true);
    expect(r.recipients).toEqual(['learner@example.com', 'tutor@example.com']);
  });

  it('deduplicates a recipient listed in both To and Cc', () => {
    // Otherwise the same person gets the message twice and the delivery counts are wrong.
    const r = validateOutbound(msg({ to: ['a@example.com'], cc: ['A@example.com'], bcc: ['a@example.com'] }), cfg);
    expect(r.recipients).toEqual(['a@example.com']);
  });

  it('counts Bcc recipients as recipients', () => {
    const r = validateOutbound(msg({ to: ['a@example.com'], bcc: ['secret@example.com'] }), cfg);
    expect(r.recipients).toContain('secret@example.com');
  });

  it('REFUSES a subject that would inject a header', () => {
    const r = validateOutbound(msg({ subject: 'Invoice\r\nBcc: everyone@example.com' }), cfg);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.problem.includes('header injection'))).toBe(true);
  });

  it('refuses a caller-supplied Bcc or Authentication-Results header', () => {
    // Letting a caller write Authentication-Results forges the exact field a receiver reads to
    // decide whether to trust us.
    for (const header of ['Bcc', 'Authentication-Results', 'Received', 'DKIM-Signature']) {
      const r = validateOutbound(msg({ headers: { [header]: 'anything' } }), cfg);
      expect(r.ok, header).toBe(false);
    }
  });

  it('refuses an executable attachment', () => {
    const r = validateOutbound(msg({ attachments: [{ filename: 'invoice.pdf.exe', content: 'AAAA' }] }), cfg);
    expect(r.ok).toBe(false);
    expect(r.issues[0].problem).toContain('.exe attachments are refused');
  });

  it('refuses an attachment over the per-attachment limit', () => {
    const small = testConfig({ MAIL_MAX_ATTACHMENT_BYTES: '10' });
    const r = validateOutbound(msg({ attachments: [{ filename: 'a.pdf', content: 'AAAAAAAAAAAAAAAAAAAA' }] }), small);
    expect(r.ok).toBe(false);
    expect(r.issues[0].problem).toContain('per-attachment limit');
  });

  it('refuses a message with no recipients at all', () => {
    const r = validateOutbound(msg({ to: [], cc: [], bcc: [] }), cfg);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.problem === 'no valid recipients')).toBe(true);
  });

  it('refuses more recipients than the configured maximum', () => {
    const many = Array.from({ length: 5 }, (_, i) => `p${i}@example.com`);
    const limited = testConfig({ MAIL_MAX_RECIPIENTS: '3' });
    expect(validateOutbound(msg({ to: many }), limited).ok).toBe(false);
    expect(validateOutbound(msg({ to: many.slice(0, 3) }), limited).ok).toBe(true);
  });

  it('refuses a message with nothing in it', () => {
    expect(validateOutbound(msg({ subject: '', text: '', html: '' }), cfg).ok).toBe(false);
  });

  it('reports every bad recipient rather than stopping at the first', () => {
    const r = validateOutbound(msg({ to: ['good@example.com', 'bad', 'also bad@x'] }), cfg);
    expect(r.recipients).toEqual(['good@example.com']);
    expect(r.issues).toHaveLength(2);
  });
});

describe('isLocalSender — the anti-relay rule', () => {
  it('allows a configured domain and refuses everything else', () => {
    expect(isLocalSender('anyone@edurankai.in', cfg)).toBe(true);
    expect(isLocalSender('ANYONE@EduRankAI.in', cfg)).toBe(true);
    expect(isLocalSender('someone@gmail.com', cfg)).toBe(false);
    expect(isLocalSender('someone@edurankai.in.evil.com', cfg)).toBe(false);
    expect(isLocalSender('not-an-address', cfg)).toBe(false);
  });
});

describe('extensionOf', () => {
  it('reads the last extension, which is the one that executes', () => {
    expect(extensionOf('invoice.pdf.exe')).toBe('exe');
    expect(extensionOf('report.PDF')).toBe('pdf');
    expect(extensionOf('no-extension')).toBe('');
  });
});
