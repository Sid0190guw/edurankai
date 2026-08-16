// Inbound: Internet -> parse -> decide -> spool -> application.
//
// The two rules under test that matter most:
//   1. NOTHING IS ACCEPTED THAT IS NOT SPOOLED — a spool failure must produce a 4xx, not a 250.
//   2. A message the application cannot take yet is HELD, never dropped.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppInboundProcessor } from '../src/inbound/processor.js';
import { testConfig, testLogger, MemoryPublisher, tempDir, removeDir } from './helpers/harness.js';

const MESSAGE = [
  'From: "Priya Raman" <priya@example.com>',
  'To: admissions@edurankai.in',
  'Subject: Application status',
  'Message-ID: <inbound-1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Could you confirm my application has been received?',
].join('\r\n');

const BOUNCE = [
  'From: MAILER-DAEMON@mx.example.com',
  'To: noreply@edurankai.in',
  'Subject: Undelivered Mail Returned to Sender',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
  '',
  '--B',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.com',
  '',
  'Final-Recipient: rfc822; gone@example.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
  '--B--',
].join('\r\n');

describe('AppInboundProcessor', () => {
  let dir: string;
  let publisher: MemoryPublisher;
  let posted: { url: string; headers: Record<string, string>; body: string }[];

  beforeEach(async () => {
    dir = await tempDir('inbound');
    publisher = new MemoryPublisher();
    posted = [];
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  const processorWith = (fetchImpl?: typeof fetch, env: Record<string, string> = {}) => new AppInboundProcessor({
    config: testConfig({ MAIL_SPOOL_DIR: dir, ...env }),
    logger: testLogger().logger,
    publisher,
    fetchImpl: fetchImpl || ((async (url: string, init: RequestInit) => {
      posted.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: Buffer.isBuffer(init.body) ? init.body.toString('utf8') : String(init.body),
      });
      return new Response('{"ok":true,"delivered":1}', { status: 200 });
    }) as unknown as typeof fetch),
    now: () => 1_700_000_000_000,
  });

  it('accepts a message for a hosted domain and hands it to the application', async () => {
    const processor = processorWith();
    const outcome = await processor.process(MESSAGE, { from: 'priya@example.com', to: ['admissions@edurankai.in'] });

    expect(outcome.accepted).toBe(true);
    expect(outcome.delivered).toEqual(['admissions@edurankai.in']);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://127.0.0.1:4321/api/mail/inbound');
    expect(posted[0].headers['x-mail-secret']).toBe('test-inbound-secret');
    expect(posted[0].headers['x-mail-to']).toBe('admissions@edurankai.in');
    expect(posted[0].headers['content-type']).toBe('message/rfc822');
    // The RAW message goes over, byte for byte. Re-encoding it here would break the DKIM signature
    // on a forwarded message and lose anything the parser did not understand.
    expect(posted[0].body).toBe(MESSAGE);
    expect(await processor.pending()).toBe(0);
  });

  it('emits inbound_accepted and inbound_delivered', async () => {
    await processorWith().process(MESSAGE, { from: 'priya@example.com', to: ['admissions@edurankai.in'] });
    expect(publisher.of('inbound_accepted')).toHaveLength(1);
    expect(publisher.of('inbound_delivered')).toHaveLength(1);
    expect(publisher.of('inbound_delivered')[0].rfcMessageId).toBe('<inbound-1@example.com>');
  });

  it('refuses relay for a domain it does not host', async () => {
    const outcome = await processorWith().process(MESSAGE, { from: 'spammer@example.com', to: ['victim@someone-else.com'] });
    expect(outcome.accepted).toBe(false);
    expect(outcome.retryable).toBe(false);         // permanent: we will never host that domain
    expect(outcome.rejectReason).toContain('relay access denied');
    expect(posted).toHaveLength(0);
  });

  it('accepts anything at a hosted domain only when catch-all is switched on', async () => {
    const strict = await processorWith(undefined, { MAIL_CATCH_ALL: 'false' })
      .process(MESSAGE, { from: 'a@example.com', to: ['someone@not-ours.com'] });
    expect(strict.accepted).toBe(false);

    const open = await processorWith(undefined, { MAIL_CATCH_ALL: 'true' })
      .process(MESSAGE, { from: 'a@example.com', to: ['anything@not-ours.com'] });
    expect(open.accepted).toBe(true);
  });

  it('refuses spam permanently, so the sender does not retry it every quarter hour', async () => {
    const spam = MESSAGE.replace('Subject:', 'X-Spamd-Result: default: True [22.10 / 15.00]\r\nSubject:');
    const outcome = await processorWith().process(spam, { from: 'spammer@example.com', to: ['admissions@edurankai.in'] });
    expect(outcome.accepted).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(publisher.of('inbound_rejected')).toHaveLength(1);
  });

  it('lets a merely suspicious message through to be quarantined, not refused', async () => {
    const suspicious = MESSAGE.replace('Subject:', 'X-Spamd-Result: default: True [8.00 / 15.00]\r\nSubject:');
    const outcome = await processorWith().process(suspicious, { from: 'a@example.com', to: ['admissions@edurankai.in'] });
    expect(outcome.accepted).toBe(true);
    expect(publisher.of('inbound_accepted')[0].reason).toContain('quarantined');
  });

  it('refuses an oversized message', async () => {
    const huge = MESSAGE + '\r\n' + 'x'.repeat(5000);
    const outcome = await processorWith(undefined, { MAIL_MAX_MESSAGE_BYTES: '1000' })
      .process(huge, { from: 'a@example.com', to: ['admissions@edurankai.in'] });
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejectReason).toContain('over the');
  });

  it('HOLDS a message the application cannot take, and accepts it anyway', async () => {
    // The sending MTA is released the moment the message is on our disk. An application deploy must
    // not become a mail outage, and the message must not be lost while it is happening.
    const processor = processorWith((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    const outcome = await processor.process(MESSAGE, { from: 'priya@example.com', to: ['admissions@edurankai.in'] });

    expect(outcome.accepted).toBe(true);
    expect(await processor.pending()).toBe(1);
  });

  it('retries the held message when the application comes back', async () => {
    let up = false;
    const processor = processorWith((async (url: string, init: RequestInit) => {
      if (!up) throw new Error('ECONNREFUSED');
      posted.push({ url: String(url), headers: init.headers as Record<string, string>, body: '' });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch);

    await processor.process(MESSAGE, { from: 'priya@example.com', to: ['admissions@edurankai.in'] });
    expect(await processor.pending()).toBe(1);

    up = true;
    expect(await processor.flushInbound()).toBe(1);
    expect(await processor.pending()).toBe(0);
  });

  it('keeps retrying through a 403, because a wrong secret must not destroy real mail', async () => {
    const processor = processorWith((async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch);
    await processor.process(MESSAGE, { from: 'priya@example.com', to: ['admissions@edurankai.in'] });
    expect(await processor.pending()).toBe(1);
    await processor.flushInbound();
    expect(await processor.pending()).toBe(1);
  });

  it('handles a delivery report as a bounce and never files it to a mailbox', async () => {
    const processor = processorWith();
    const outcome = await processor.process(BOUNCE, { from: '', to: ['noreply@edurankai.in'] });

    expect(outcome.accepted).toBe(true);
    expect(outcome.delivered).toEqual([]);                 // nobody's inbox
    expect(posted).toHaveLength(0);                        // never handed to the application as mail
    expect(publisher.of('bounced')).toHaveLength(1);
    expect(publisher.of('bounced')[0].recipient).toBe('gone@example.com');
    expect(publisher.of('bounced')[0].bounceClass).toBe('invalid_mailbox');
    expect(publisher.suppressions.get('gone@example.com')?.permanent).toBe(true);
  });

  it('delivers a bounce-shaped message that carries no readable report', async () => {
    // "Undeliverable" from a human, or a report this parser cannot read. Dropping it would throw
    // away a real message; a person still needs to see it.
    const looksLikeOne = [
      'From: postmaster@example.com',
      'To: admissions@edurankai.in',
      'Subject: Delivery Status Notification (Failure)',
      '',
      'Sorry, something went wrong. No machine-readable part here.',
    ].join('\r\n');
    const outcome = await processorWith().process(looksLikeOne, { from: 'postmaster@example.com', to: ['admissions@edurankai.in'] });
    expect(outcome.accepted).toBe(true);
    expect(outcome.delivered).toEqual(['admissions@edurankai.in']);
  });

  it('takes the recipient from the envelope, not from the headers', async () => {
    // A Bcc'd address appears in no header. Reading To here is how Bcc'd mail goes missing.
    const outcome = await processorWith().process(MESSAGE, { from: 'priya@example.com', to: ['hidden@edurankai.in'] });
    expect(outcome.delivered).toEqual(['hidden@edurankai.in']);
    expect(posted[0].headers['x-mail-to']).toBe('hidden@edurankai.in');
  });
});
