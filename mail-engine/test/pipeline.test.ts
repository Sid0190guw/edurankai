// Submission: validation, then suppression, then the queue — and an event at every step.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubmissionPipeline } from '../src/pipeline.js';
import { MessageSpool } from '../src/queue/message-spool.js';
import { testConfig, testLogger, MemoryPublisher, tempDir, removeDir } from './helpers/harness.js';

describe('SubmissionPipeline', () => {
  let dir: string;
  let spool: MessageSpool;
  let publisher: MemoryPublisher;
  let pipeline: SubmissionPipeline;

  beforeEach(async () => {
    dir = await tempDir('pipeline');
    spool = new MessageSpool(dir);
    publisher = new MemoryPublisher();
    pipeline = new SubmissionPipeline({
      config: testConfig(), logger: testLogger().logger, spool, publisher, now: () => 1_000_000,
    });
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  const good = {
    messageId: 'm1',
    from: 'noreply@edurankai.in',
    to: ['learner@example.com'],
    subject: 'Welcome',
    text: 'Hello',
  };

  it('queues a valid message and emits accepted + queued for each recipient', async () => {
    const result = await pipeline.submit({ ...good, to: ['a@example.com', 'b@example.com'] });

    expect(result.accepted).toBe(true);
    expect(result.queued).toEqual(['a@example.com', 'b@example.com']);
    expect((await spool.stats(1_000_000)).ready).toBe(1);
    expect(publisher.of('accepted')).toHaveLength(2);
    expect(publisher.of('queued')).toHaveLength(2);
    expect(publisher.of('queued')[0].recipientDomain).toBe('example.com');
    expect(publisher.of('queued')[0].rfcMessageId).toBe('<m1@mail.test.invalid>');
  });

  it('mints a message id when the caller does not supply one', async () => {
    const result = await pipeline.submit({ ...good, messageId: '' });
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a message from a domain this engine does not host', async () => {
    // The anti-relay rule at the submission door. Without it the engine would sign and send mail on
    // behalf of a domain it has no authority over.
    const result = await pipeline.submit({ ...good, from: 'attacker@gmail.com' });
    expect(result.accepted).toBe(false);
    expect(result.issues[0].problem).toContain('only sends as');
    expect((await spool.stats(1_000_000)).total).toBe(0);
    expect(publisher.of('rejected')).toHaveLength(1);
  });

  it('refuses a header-injection attempt and records why', async () => {
    const result = await pipeline.submit({ ...good, subject: 'Invoice\r\nBcc: everyone@example.com' });
    expect(result.accepted).toBe(false);
    expect(publisher.of('rejected')[0].reason).toContain('header injection');
    expect((await spool.stats(1_000_000)).total).toBe(0);
  });

  it('drops a suppressed recipient but still sends to everyone else', async () => {
    // The rule that stops one dead address cancelling a mailing to thirty-nine live ones.
    await publisher.suppress({
      recipient: 'gone@example.com', reason: 'invalid_mailbox', permanent: true,
      expiresAt: null, createdAt: new Date().toISOString(), lastEventId: 'e1', detail: '550 user unknown',
    });

    const result = await pipeline.submit({ ...good, to: ['live@example.com', 'gone@example.com'] });
    expect(result.accepted).toBe(true);
    expect(result.queued).toEqual(['live@example.com']);
    expect(result.refused).toEqual([{ recipient: 'gone@example.com', reason: 'recipient is on the suppression list' }]);

    const claimed = await spool.claimBatch(10, 1_000_000);
    expect(claimed[0].entry.pending).toEqual(['live@example.com']);
  });

  it('refuses the message outright when every recipient is suppressed', async () => {
    await publisher.suppress({
      recipient: 'gone@example.com', reason: 'invalid_mailbox', permanent: true,
      expiresAt: null, createdAt: new Date().toISOString(), lastEventId: 'e1', detail: null,
    });
    const result = await pipeline.submit({ ...good, to: ['gone@example.com'] });
    expect(result.accepted).toBe(false);
    expect((await spool.stats(1_000_000)).total).toBe(0);
  });

  it('records a rejection event even when nothing could be queued', async () => {
    // A refusal that only returned an HTTP 400 would leave no trace once the caller had moved on.
    await pipeline.submit({ ...good, to: ['not-an-address'] });
    expect(publisher.of('rejected')).toHaveLength(1);
    expect(publisher.of('rejected')[0].stage).toBe('validation');
  });

  it('queues the message due immediately', async () => {
    await pipeline.submit(good);
    const claimed = await spool.claimBatch(1, 1_000_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].entry.nextAttemptAt).toBe(1_000_000);
    expect(claimed[0].entry.attempt).toBe(0);
  });
});
