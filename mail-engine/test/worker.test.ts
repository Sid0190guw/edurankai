// The delivery worker: what happens to a message between the queue and the answer.
//
// The transport is scripted rather than real (smtp-integration.test.ts covers the socket). What is
// under test here is the DECISION LAYER — which recipients get retried, when, how many times, what
// goes on the suppression list, and what the event stream says about all of it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DeliveryWorker } from '../src/worker.js';
import { MessageSpool, newQueueEntry } from '../src/queue/message-spool.js';
import { Throttle } from '../src/smtp/throttle.js';
import { testConfig, testLogger, MemoryPublisher, tempDir, removeDir } from './helpers/harness.js';
import type { DeliveryResult, MailTransport, OutboundMessage } from '../src/contracts/index.js';

/** A transport that answers from a script: per-recipient, per-attempt. */
class ScriptedTransport implements MailTransport {
  readonly name = 'scripted';
  calls: { recipients: string[]; attempt: number }[] = [];
  closed = false;
  throwOnce = false;

  constructor(private script: (recipient: string, attempt: number) => Partial<DeliveryResult>) {}

  async deliver(_message: OutboundMessage, recipients: string[], attempt: number): Promise<DeliveryResult[]> {
    this.calls.push({ recipients: [...recipients], attempt });
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('socket exploded');
    }
    return recipients.map((r) => ({
      recipient: r,
      outcome: 'delivered',
      smtpCode: 250,
      enhancedCode: null,
      smtpResponse: '250 Ok',
      mxHost: 'mx.example.com',
      tls: true,
      dkimSigned: true,
      latencyMs: 5,
      bounceClass: null,
      ...this.script(r, attempt),
    } as DeliveryResult));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function message(to: string[]): OutboundMessage {
  return { messageId: 'm1', from: 'noreply@edurankai.in', to, subject: 'Subject', text: 'Body' };
}

describe('DeliveryWorker', () => {
  let dir: string;
  let spool: MessageSpool;
  let publisher: MemoryPublisher;
  let clock = 1_000_000;

  const workerWith = (transport: MailTransport, env: Record<string, string> = {}) => new DeliveryWorker({
    config: testConfig({ MAIL_RETRY_JITTER: '0', MAIL_PER_DOMAIN_RATE_PER_MINUTE: '0', ...env }),
    logger: testLogger().logger,
    spool,
    transport,
    publisher,
    now: () => clock,
    sleep: async () => { /* the test drives the clock */ },
    throttle: new Throttle({ perDomainConcurrency: 4, globalConcurrency: 8, perDomainRatePerMinute: 0 }),
  });

  beforeEach(async () => {
    dir = await tempDir('worker');
    spool = new MessageSpool(dir);
    publisher = new MemoryPublisher();
    clock = 1_000_000;
    await spool.init();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('delivers a message, completes it, and emits attempting + delivered', async () => {
    await spool.enqueue(newQueueEntry(message(['a@example.com']), ['a@example.com'], clock));
    const transport = new ScriptedTransport(() => ({}));
    const pass = await workerWith(transport).runOnce();

    expect(pass).toMatchObject({ claimed: 1, delivered: 1, deferred: 0, bounced: 0 });
    expect((await spool.stats(clock)).total).toBe(0);
    expect(publisher.kinds()).toEqual(['attempting', 'delivered']);
    expect(publisher.of('delivered')[0].mxHost).toBe('mx.example.com');
    expect(publisher.of('delivered')[0].attempt).toBe(1);
  });

  it('retries ONLY the recipients that were deferred', async () => {
    // A message to three people where one is greylisted must be re-sent to one person, not three.
    // Re-queueing the whole recipient list is how a mail system delivers duplicates.
    const recipients = ['ok@example.com', 'slow@example.com', 'gone@example.com'];
    await spool.enqueue(newQueueEntry(message(recipients), recipients, clock));

    const transport = new ScriptedTransport((r) => {
      if (r === 'slow@example.com') return { outcome: 'deferred', smtpCode: 450, smtpResponse: '450 4.7.1 Greylisted', bounceClass: 'temporary_rejection' };
      if (r === 'gone@example.com') return { outcome: 'bounced', smtpCode: 550, smtpResponse: '550 5.1.1 User unknown', bounceClass: 'invalid_mailbox' };
      return {};
    });

    const worker = workerWith(transport);
    const first = await worker.runOnce();
    expect(first).toMatchObject({ delivered: 1, deferred: 1, bounced: 1 });

    // Still queued, due after the first backoff (60s with the shipped base and no jitter).
    expect((await spool.stats(clock)).deferred).toBe(1);
    clock += 60_000;

    transport.calls = [];
    await worker.runOnce();
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].recipients).toEqual(['slow@example.com']);
    expect(transport.calls[0].attempt).toBe(2);
  });

  it('suppresses a hard bounce permanently and a deferral not at all', async () => {
    const recipients = ['gone@example.com', 'slow@example.com'];
    await spool.enqueue(newQueueEntry(message(recipients), recipients, clock));
    const transport = new ScriptedTransport((r) => r === 'gone@example.com'
      ? { outcome: 'bounced', smtpCode: 550, smtpResponse: '550 5.1.1 User unknown', bounceClass: 'invalid_mailbox' }
      : { outcome: 'deferred', smtpCode: 451, smtpResponse: '451 try later', bounceClass: 'temporary_rejection' });

    await workerWith(transport).runOnce();

    expect(publisher.suppressions.get('gone@example.com')?.permanent).toBe(true);
    expect(publisher.suppressions.has('slow@example.com')).toBe(false);
    expect(publisher.of('suppressed')).toHaveLength(1);
  });

  it('backs off exponentially between attempts', async () => {
    await spool.enqueue(newQueueEntry(message(['slow@example.com']), ['slow@example.com'], clock));
    const transport = new ScriptedTransport(() => ({ outcome: 'deferred', smtpCode: 451, smtpResponse: '451 later', bounceClass: 'temporary_rejection' }));
    const worker = workerWith(transport);

    const dueTimes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const pass = await worker.runOnce();
      if (!pass.claimed) break;
      const deferred = publisher.of('deferred').slice(-1)[0];
      dueTimes.push(Date.parse(deferred.nextAttemptAt!) - clock);
      clock = Date.parse(deferred.nextAttemptAt!);
    }
    expect(dueTimes).toEqual([60_000, 180_000, 540_000, 1_620_000]);
  });

  it('dead-letters a message that exhausts every attempt, and keeps it', async () => {
    await spool.enqueue(newQueueEntry(message(['slow@example.com']), ['slow@example.com'], clock));
    const transport = new ScriptedTransport(() => ({ outcome: 'deferred', smtpCode: 451, smtpResponse: '451 still down', bounceClass: 'temporary_rejection' }));
    const worker = workerWith(transport, { MAIL_MAX_ATTEMPTS: '3' });

    for (let i = 0; i < 3; i++) {
      await worker.runOnce();
      clock += 60 * 60 * 1000;
    }

    const stats = await spool.stats(clock);
    expect(stats.dead).toBe(1);
    expect(stats.total).toBe(0);
    const dead = await spool.listDead();
    expect(dead[0].deadReason).toContain('451 still down');
    expect(publisher.of('dead_lettered')).toHaveLength(1);
    expect(publisher.of('dead_lettered')[0].reason).toContain('gave up after 3 attempts');
    // A day-long failure earns a cool-off, never a permanent block.
    expect(publisher.suppressions.get('slow@example.com')?.permanent).toBe(false);
  });

  it('treats a transport exception as a deferral, never as a bounce', async () => {
    // An exception is not evidence that a mailbox does not exist. Bouncing on one would delete a
    // real address from a real mailing list because of a bug in our own code.
    await spool.enqueue(newQueueEntry(message(['a@example.com']), ['a@example.com'], clock));
    const transport = new ScriptedTransport(() => ({}));
    transport.throwOnce = true;

    const pass = await workerWith(transport).runOnce();
    expect(pass.deferred).toBe(1);
    expect(pass.bounced).toBe(0);
    expect(publisher.of('deferred')[0].bounceClass).toBe('connection_failure');
    expect((await spool.stats(clock)).deferred).toBe(1);
  });

  it('opens one conversation per destination domain', async () => {
    const recipients = ['a@one.com', 'b@two.com', 'c@one.com'];
    await spool.enqueue(newQueueEntry(message(recipients), recipients, clock));
    const transport = new ScriptedTransport(() => ({}));
    await workerWith(transport).runOnce();

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.map((c) => c.recipients.length).sort()).toEqual([1, 2]);
  });

  it('processes a whole batch in one pass', async () => {
    for (let i = 0; i < 5; i++) {
      const m = { ...message([`u${i}@example.com`]), messageId: `m${i}` };
      await spool.enqueue(newQueueEntry(m, [`u${i}@example.com`], clock));
    }
    const transport = new ScriptedTransport(() => ({}));
    const pass = await workerWith(transport).runOnce();
    expect(pass).toMatchObject({ claimed: 5, delivered: 5 });
    expect((await spool.stats(clock + 10)).total).toBe(0);
  });

  it('leaves nothing claimed when a pass is over', async () => {
    // A leaked claim is a message that waits out a ten-minute lease for no reason.
    await spool.enqueue(newQueueEntry(message(['a@example.com']), ['a@example.com'], clock));
    await workerWith(new ScriptedTransport(() => ({ outcome: 'deferred', smtpCode: 451, smtpResponse: '451', bounceClass: 'soft' }))).runOnce();
    expect((await spool.stats(clock)).processing).toBe(0);
  });

  it('does not lose a delivery when the event publisher is broken', async () => {
    // Publishing is a side effect of a delivery that already happened. If it throws, the message
    // must still be completed rather than being sent a second time on the next pass.
    await spool.enqueue(newQueueEntry(message(['a@example.com']), ['a@example.com'], clock));
    publisher.failPublish = true;
    const transport = new ScriptedTransport(() => ({}));
    const pass = await workerWith(transport).runOnce();

    expect(pass.delivered).toBe(1);
    expect((await spool.stats(clock)).total).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });
});
