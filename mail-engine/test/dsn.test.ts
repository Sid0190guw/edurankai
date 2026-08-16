// Asynchronous bounces. These are real report formats from the field, trimmed but not tidied — the
// point of the parser is that it copes with the shapes MTAs actually emit, including the sloppy ones.

import { describe, it, expect } from 'vitest';
import { parseDsn, parseAddressField, parseDiagnosticCode } from '../src/mime/dsn.js';

const POSTFIX_DSN = [
  'From: MAILER-DAEMON@mx.example.com (Mail Delivery System)',
  'Subject: Undelivered Mail Returned to Sender',
  'To: noreply@edurankai.in',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
  'Message-ID: <report-123@mx.example.com>',
  '',
  '--B1',
  'Content-Description: Notification',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'This is the mail system at host mx.example.com.',
  '',
  '--B1',
  'Content-Description: Delivery report',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.com',
  'X-Postfix-Queue-ID: 3F2A1',
  '',
  'Final-Recipient: rfc822; gone@example.com',
  'Original-Recipient: rfc822;gone@example.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <gone@example.com>: Recipient address rejected: User unknown',
  '',
  '--B1',
  'Content-Description: Undelivered Message',
  'Content-Type: message/rfc822',
  '',
  'From: noreply@edurankai.in',
  'To: gone@example.com',
  'Subject: Your certificate is ready',
  'Message-ID: <original-abc@mail.edurankai.in>',
  '',
  'Congratulations.',
  '--B1--',
].join('\r\n');

describe('parseAddressField', () => {
  it('reads the address out of an addr-type field in either spelling', () => {
    expect(parseAddressField('rfc822; user@example.com')).toBe('user@example.com');
    expect(parseAddressField('RFC822;<User@Example.COM>')).toBe('user@example.com');
    expect(parseAddressField('utf-8; nobody')).toBeNull();
    expect(parseAddressField(null)).toBeNull();
  });
});

describe('parseDiagnosticCode', () => {
  it('extracts the quoted SMTP reply', () => {
    const r = parseDiagnosticCode('smtp; 550 5.1.1 <a@b.com>: User unknown');
    expect(r.smtpCode).toBe(550);
    expect(r.text).toContain('User unknown');
  });

  it('copes with no diagnostic code at all', () => {
    expect(parseDiagnosticCode(null)).toEqual({ smtpCode: null, text: null });
  });
});

describe('parseDsn — a Postfix delivery report', () => {
  const report = parseDsn(POSTFIX_DSN);

  it('identifies it as a DSN and names the reporting MTA', () => {
    expect(report.kind).toBe('dsn');
    expect(report.reportingMta).toBe('dns; mx.example.com');
  });

  it('finds the recipient, the status and the diagnostic', () => {
    expect(report.recipients).toHaveLength(1);
    expect(report.recipients[0].recipient).toBe('gone@example.com');
    expect(report.recipients[0].action).toBe('failed');
    expect(report.recipients[0].status).toBe('5.1.1');
    expect(report.recipients[0].smtpCode).toBe(550);
  });

  it('classifies it with the same rules as a synchronous bounce', () => {
    expect(report.recipients[0].outcome).toBe('bounced');
    expect(report.recipients[0].bounceClass).toBe('invalid_mailbox');
  });

  it('correlates back to the ORIGINAL message, not to the report', () => {
    // The report has its own Message-ID first; the quoted original comes later. Picking the wrong
    // one files the bounce against a message that never existed.
    expect(report.originalMessageId).toBe('<original-abc@mail.edurankai.in>');
  });
});

describe('parseDsn — the other shapes', () => {
  it('reads a delayed report as a deferral, not a bounce', () => {
    const delayed = [
      'Reporting-MTA: dns; mx.example.com',
      '',
      'Final-Recipient: rfc822; slow@example.com',
      'Action: delayed',
      'Status: 4.4.7',
      'Diagnostic-Code: smtp; 451 4.4.7 Delivery time expired',
    ].join('\r\n');
    const r = parseDsn(delayed);
    expect(r.recipients[0].outcome).toBe('deferred');
  });

  it('reads a report about several recipients', () => {
    const multi = [
      'Reporting-MTA: dns; mx.example.com',
      '',
      'Final-Recipient: rfc822; one@example.com',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
      '',
      'Final-Recipient: rfc822; two@example.com',
      'Action: failed',
      'Status: 5.2.2',
      'Diagnostic-Code: smtp; 552 5.2.2 Mailbox full',
      '',
      'Final-Recipient: rfc822; three@example.com',
      'Action: delivered',
      'Status: 2.0.0',
    ].join('\r\n');
    const r = parseDsn(multi);
    expect(r.recipients.map((x) => x.recipient)).toEqual(['one@example.com', 'two@example.com', 'three@example.com']);
    expect(r.recipients[0].bounceClass).toBe('invalid_mailbox');
    expect(r.recipients[1].bounceClass).toBe('mailbox_full');
    expect(r.recipients[2].outcome).toBe('delivered');
  });

  it('handles a report with no blank line between recipient groups', () => {
    // Plenty of MTAs emit this. A parser that split on blank lines would find one recipient.
    const squashed = [
      'Final-Recipient: rfc822; a@example.com',
      'Action: failed',
      'Status: 5.1.1',
      'Final-Recipient: rfc822; b@example.com',
      'Action: failed',
      'Status: 5.1.1',
    ].join('\r\n');
    expect(parseDsn(squashed).recipients).toHaveLength(2);
  });

  it('unfolds a diagnostic code split across lines', () => {
    const folded = [
      'Final-Recipient: rfc822; a@example.com',
      'Action: failed',
      'Status: 5.7.1',
      'Diagnostic-Code: smtp; 550 5.7.1 Message rejected as spam by',
      '  the receiving server, see https://example.com/why',
    ].join('\r\n');
    const r = parseDsn(folded);
    expect(r.recipients[0].diagnosticCode).toContain('see https://example.com/why');
    expect(r.recipients[0].bounceClass).toBe('spam_rejection');
  });

  it('returns nothing for ordinary mail, so the caller can tell it apart', () => {
    const ordinary = 'From: friend@example.com\r\nSubject: lunch?\r\n\r\nAre you free Thursday?';
    const r = parseDsn(ordinary);
    expect(r.kind).toBe('unknown');
    expect(r.recipients).toHaveLength(0);
  });
});

describe('parseDsn — ARF abuse complaints', () => {
  const ARF = [
    'From: complaints@isp.example',
    'Subject: FW: Your message',
    'Content-Type: multipart/report; report-type=feedback-report; boundary="F1"',
    '',
    '--F1',
    'Content-Type: message/feedback-report',
    '',
    'Feedback-Type: abuse',
    'User-Agent: SomeGenerator/1.0',
    'Version: 1',
    'Original-Mail-From: noreply@edurankai.in',
    'Original-Rcpt-To: annoyed@isp.example',
    'Reported-Domain: edurankai.in',
    '',
    '--F1',
    'Content-Type: message/rfc822',
    '',
    'From: noreply@edurankai.in',
    'Message-ID: <campaign-9@mail.edurankai.in>',
    '',
    '--F1--',
  ].join('\r\n');

  it('recognises a complaint and treats it as more serious than a bounce', () => {
    const r = parseDsn(ARF);
    expect(r.kind).toBe('arf');
    expect(r.feedbackType).toBe('abuse');
    expect(r.originalFrom).toBe('noreply@edurankai.in');
    expect(r.recipients[0].recipient).toBe('annoyed@isp.example');
    // Somebody pressed "this is spam". Mailing them again is how a sending domain gets blocked.
    expect(r.recipients[0].outcome).toBe('bounced');
    expect(r.recipients[0].bounceClass).toBe('spam_rejection');
  });
});
