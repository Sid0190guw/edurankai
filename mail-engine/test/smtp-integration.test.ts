// A REAL SMTP CONVERSATION, over a real socket, against a server that misbehaves on cue.
//
// These are the tests that would have caught every bug this engine could plausibly ship with: the
// message that goes out unsigned, the recipient list that leaks Bcc, the 4xx that gets treated as a
// bounce, the multi-recipient send where one bad address poisons the other four. Nothing is mocked
// below the transport — nodemailer really speaks SMTP to test/helpers/fake-smtp.ts on localhost.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeSmtpServer } from './helpers/fake-smtp.js';
import { SmtpMailTransport } from '../src/smtp/transport.js';
import { DkimKeyStore, generateDkimKey } from '../src/dkim.js';
import { testConfig, testLogger, tempDir, removeDir } from './helpers/harness.js';
import type { OutboundMessage } from '../src/contracts/index.js';

function message(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    messageId: 'msg-1',
    from: 'noreply@edurankai.in',
    to: ['learner@example.com'],
    subject: 'Your certificate is ready',
    text: 'Congratulations on completing the programme.',
    html: '<p>Congratulations on completing the programme.</p>',
    ...over,
  };
}

describe('SmtpMailTransport against a live SMTP server', () => {
  let server: FakeSmtpServer;
  let port: number;
  let keyDir: string;

  beforeEach(async () => {
    server = new FakeSmtpServer();
    port = await server.listen();
    keyDir = await tempDir('dkim');
  });

  afterEach(async () => {
    await server.close();
    await removeDir(keyDir);
  });

  const transportFor = (extra: Record<string, string> = {}) => {
    const config = testConfig({
      MAIL_RELAY_HOST: '127.0.0.1',
      MAIL_RELAY_PORT: String(port),
      MAIL_RELAY_SECURE: 'false',
      MAIL_DKIM_KEY_DIR: keyDir,
      MAIL_SMTP_CONNECT_TIMEOUT_MS: '3000',
      MAIL_SMTP_GREETING_TIMEOUT_MS: '3000',
      ...extra,
    });
    const { logger } = testLogger();
    return new SmtpMailTransport({ config, logger, keys: new DkimKeyStore(config.dkimKeyDir, config.dkimSelector) });
  };

  it('delivers a message and reports what the server said', async () => {
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();

    expect(result.outcome).toBe('delivered');
    expect(result.smtpCode).toBe(250);
    expect(result.smtpResponse).toContain('queued as ABC123');
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0].mailFrom).toBe('noreply@edurankai.in');
    expect(server.messages[0].rcptTo).toEqual(['learner@example.com']);
    expect(server.messages[0].data).toContain('Congratulations on completing the programme.');
  });

  it('writes the headers a receiving server needs to thread and trust the message', async () => {
    const transport = transportFor();
    await transport.deliver(message({
      inReplyTo: '<parent@mail.edurankai.in>',
      references: ['<root@mail.edurankai.in>', '<parent@mail.edurankai.in>'],
      replyTo: 'admissions@edurankai.in',
    }), ['learner@example.com'], 1);
    await transport.close();

    const headers = server.messages[0].headers;
    expect(headers.from).toContain('noreply@edurankai.in');
    expect(headers.subject).toBe('Your certificate is ready');
    expect(headers['message-id']).toBe('<msg-1@mail.test.invalid>');
    expect(headers['in-reply-to']).toBe('<parent@mail.edurankai.in>');
    expect(headers.references).toContain('<root@mail.edurankai.in>');
    expect(headers['reply-to']).toContain('admissions@edurankai.in');
    expect(headers['content-type']).toContain('multipart/alternative');
  });

  it('SIGNS THE MESSAGE when a DKIM key exists for the sending domain', async () => {
    const keys = new DkimKeyStore(keyDir, 'era1');
    await keys.write(generateDkimKey('edurankai.in', 'era1'));

    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();

    expect(result.dkimSigned).toBe(true);
    const signature = server.messages[0].headers['dkim-signature'];
    expect(signature).toBeDefined();
    expect(signature).toContain('d=edurankai.in');
    expect(signature).toContain('s=era1');
    expect(signature).toMatch(/h=[^;]*from/);      // From must be among the signed headers
    expect(signature).toMatch(/bh=/);              // body hash
  });

  it('sends UNSIGNED and says so when there is no key, rather than pretending', async () => {
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.dkimSigned).toBe(false);
    expect(server.messages[0].headers['dkim-signature']).toBeUndefined();
  });

  it('puts Bcc recipients in the envelope and NEVER in a header', async () => {
    // The failure this prevents is the one nobody forgives: every recipient seeing who else was
    // blind-copied.
    const transport = transportFor();
    await transport.deliver(
      message({ to: ['visible@example.com'], bcc: ['hidden@example.com'] }),
      ['visible@example.com', 'hidden@example.com'],
      1,
    );
    await transport.close();

    expect(server.messages[0].rcptTo.sort()).toEqual(['hidden@example.com', 'visible@example.com']);
    expect(server.messages[0].headers.bcc).toBeUndefined();
    expect(server.messages[0].data).not.toContain('hidden@example.com');
    expect(server.messages[0].headers.to).toContain('visible@example.com');
  });

  it('reports one verdict per recipient when a domain rejects only some of them', async () => {
    // One SMTP conversation, five addresses, two of which do not exist. Three people must still get
    // the message and only two must bounce.
    server.configure({
      rcptReplies: {
        'gone@example.com': '550 5.1.1 <gone@example.com>: Recipient address rejected: User unknown',
        'full@example.com': '452 4.2.2 Over quota',
      },
    });
    const transport = transportFor();
    const recipients = ['a@example.com', 'gone@example.com', 'b@example.com', 'full@example.com', 'c@example.com'];
    const results = await transport.deliver(message({ to: recipients }), recipients, 1);
    await transport.close();

    const byRecipient = Object.fromEntries(results.map((r) => [r.recipient, r]));
    expect(byRecipient['a@example.com'].outcome).toBe('delivered');
    expect(byRecipient['b@example.com'].outcome).toBe('delivered');
    expect(byRecipient['c@example.com'].outcome).toBe('delivered');
    expect(byRecipient['gone@example.com'].outcome).toBe('bounced');
    expect(byRecipient['gone@example.com'].bounceClass).toBe('invalid_mailbox');
    expect(byRecipient['full@example.com'].outcome).toBe('deferred');
    expect(byRecipient['full@example.com'].bounceClass).toBe('mailbox_full');
    expect(server.messages[0].rcptTo.sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('treats a 4xx on the whole transaction as a deferral', async () => {
    server.configure({ dataReply: '451 4.3.0 Temporary system problem, try again later' });
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.outcome).toBe('deferred');
    expect(result.smtpCode).toBe(451);
  });

  it('treats a 5xx on the whole transaction as a bounce', async () => {
    server.configure({ dataReply: '554 5.7.1 Message rejected as spam' });
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.outcome).toBe('bounced');
    expect(result.bounceClass).toBe('spam_rejection');
  });

  it('defers when the server greets with 421', async () => {
    server.configure({ greeting: '421 4.7.0 Too many connections from your IP' });
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.outcome).toBe('deferred');
    expect(result.bounceClass).toBe('rate_limited');
  });

  it('defers when the connection is dropped mid-conversation', async () => {
    server.configure({ dropAt: 'data' });
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.outcome).toBe('deferred');
    expect(result.bounceClass).toBe('connection_failure');
  });

  it('defers when nothing is listening at all', async () => {
    await server.close();
    const transport = transportFor();
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.outcome).toBe('deferred');
    expect(result.bounceClass).toBe('connection_failure');
  });

  it('holds the message in the queue when delivery is switched off', async () => {
    // The dry-run default. It must report a DEFERRAL — reporting success for a message that was
    // never handed to anyone is the exact failure CLAUDE.md warns about.
    const transport = transportFor({ MAIL_DELIVERY_ENABLED: 'false' });
    const [result] = await transport.deliver(message(), ['learner@example.com'], 1);
    await transport.close();
    expect(result.outcome).toBe('deferred');
    expect(result.smtpResponse).toContain('MAIL_DELIVERY_ENABLED');
    expect(server.messages).toHaveLength(0);
  });

  it('sends an attachment intact', async () => {
    const transport = transportFor();
    await transport.deliver(message({
      attachments: [{ filename: 'certificate.pdf', content: Buffer.from('%PDF-1.4 fake').toString('base64'), contentType: 'application/pdf' }],
    }), ['learner@example.com'], 1);
    await transport.close();

    const data = server.messages[0].data;
    expect(data).toContain('multipart/mixed');
    expect(data).toContain('certificate.pdf');
    expect(data).toContain(Buffer.from('%PDF-1.4 fake').toString('base64'));
  });
});
