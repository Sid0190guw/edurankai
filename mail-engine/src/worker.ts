// mail-engine/src/worker.ts — the delivery worker. Claims from the spool, talks SMTP, decides again.
//
// One pass over one message:
//
//   claim -> group recipients by domain -> per domain: throttle, connect, deliver
//         -> classify each recipient's verdict -> emit events
//         -> delivered/bounced recipients leave `pending`; deferred ones stay
//         -> pending empty ? complete : (retries left ? release with backoff : dead-letter)
//
// WHY `pending` SHRINKS INSTEAD OF THE MESSAGE BEING RE-SENT WHOLE. A message to ten people where
// nine are accepted and one is greylisted must be retried for exactly one person. Re-queueing the
// original recipient list would deliver the message nine more times — and duplicate delivery is the
// failure users notice and never forgive.
//
// WHY A DEFERRAL DOES NOT SUPPRESS. See the note above suppressionFor() in smtp/classify.ts: a 4xx
// is a request for patience, and the retry engine is the patience. Only a permanent verdict, or a
// message that has exhausted the whole retry schedule, puts an address on the list.
//
// SHUTDOWN. stop() lets the in-flight pass finish and releases everything it still holds back to the
// queue. A worker that exited mid-attempt would still be safe — recoverStale() sweeps the leases —
// but it would leave those messages waiting out a full lease for no reason.

import type { DeliveryEventPublisher, DeliveryEvent, MailTransport } from './contracts/index.js';
import type { EngineConfig } from './config.js';
import { MessageSpool, type QueueEntry } from './queue/message-spool.js';
import { groupByDomain } from './smtp/mx.js';
import { Throttle } from './smtp/throttle.js';
import { makeEvent } from './events.js';
import { suppressionFor } from './smtp/classify.js';
import { backoffMs, isExhausted, humanDuration, maximumQueueLifetimeMs, type RetryPolicy } from './queue/retry.js';
import { type Logger, reasonOf } from './logger.js';
import { M, metrics } from './metrics.js';

export interface WorkerDeps {
  config: EngineConfig;
  logger: Logger;
  spool: MessageSpool;
  transport: MailTransport;
  publisher: DeliveryEventPublisher;
  throttle?: Throttle;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PassResult {
  claimed: number;
  delivered: number;
  deferred: number;
  bounced: number;
  deadLettered: number;
}

/** How long a claimed message may sit in processing/ before another worker may take it back. */
const LEASE_MS = 10 * 60 * 1000;

export class DeliveryWorker {
  private readonly cfg: EngineConfig;
  private readonly log: Logger;
  private readonly spool: MessageSpool;
  private readonly transport: MailTransport;
  private readonly publisher: DeliveryEventPublisher;
  private readonly throttle: Throttle;
  private readonly policy: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private stopping = false;

  constructor(deps: WorkerDeps) {
    this.cfg = deps.config;
    this.log = deps.logger.child({ component: 'delivery-worker' });
    this.spool = deps.spool;
    this.transport = deps.transport;
    this.publisher = deps.publisher;
    this.now = deps.now || (() => Date.now());
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.throttle = deps.throttle || new Throttle({
      perDomainConcurrency: this.cfg.perDomainConcurrency,
      globalConcurrency: this.cfg.globalConcurrency,
      perDomainRatePerMinute: this.cfg.perDomainRatePerMinute,
      onWait: (domain, reason) => metrics.counter(M.throttleWaits, 'Times a delivery waited on a limit', { domain, reason }),
    });
    this.policy = {
      maxAttempts: this.cfg.maxAttempts,
      baseDelayMs: this.cfg.retryBaseDelayMs,
      factor: this.cfg.retryFactor,
      maxDelayMs: this.cfg.retryMaxDelayMs,
      jitter: this.cfg.retryJitter,
    };
  }

  /** Run until stop() is called. */
  async start(): Promise<void> {
    this.running = true;
    this.stopping = false;
    const recovered = await this.spool.recoverStale(LEASE_MS, this.now());
    if (recovered) this.log.warn('recovered messages from an interrupted run', { count: recovered });
    this.log.info('delivery worker started', {
      transport: this.transport.name,
      deliveryEnabled: this.cfg.deliveryEnabled,
      maxAttempts: this.policy.maxAttempts,
      maxQueueLifetime: humanDuration(maximumQueueLifetimeMs(this.policy)),
    });

    let sweepCounter = 0;
    while (!this.stopping) {
      let pass: PassResult;
      try {
        pass = await this.runOnce();
      } catch (err) {
        // A throw out of a whole pass is a bug, not a delivery failure. Log it and keep the loop
        // alive: a worker that exits leaves a queue nobody is draining.
        this.log.error('delivery pass threw', { reason: reasonOf(err) });
        pass = { claimed: 0, delivered: 0, deferred: 0, bounced: 0, deadLettered: 0 };
      }
      // Flush anything the application could not take earlier, whether or not mail moved.
      await this.publisher.flush().catch(() => 0);

      if (++sweepCounter % 30 === 0) {
        const recoveredNow = await this.spool.recoverStale(LEASE_MS, this.now()).catch(() => 0);
        if (recoveredNow) this.log.warn('recovered stale claims', { count: recoveredNow });
      }
      if (pass.claimed === 0 && !this.stopping) await this.sleep(this.cfg.pollIntervalMs);
    }
    this.running = false;
    await this.transport.close().catch(() => { /* closing is best-effort */ });
    this.log.info('delivery worker stopped');
  }

  stop(): void {
    this.stopping = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** One pass: claim a batch and process it. Exposed so tests can drive the worker deterministically. */
  async runOnce(): Promise<PassResult> {
    const claimed = await this.spool.claimBatch(this.cfg.batchSize, this.now());
    const result: PassResult = { claimed: claimed.length, delivered: 0, deferred: 0, bounced: 0, deadLettered: 0 };
    if (!claimed.length) return result;

    // The throttle bounds real concurrency; running the batch together is what lets a slow domain
    // stop blocking a fast one.
    await Promise.all(claimed.map(async ({ entry, claim }) => {
      try {
        const one = await this.processEntry(entry, claim);
        result.delivered += one.delivered;
        result.deferred += one.deferred;
        result.bounced += one.bounced;
        result.deadLettered += one.deadLettered;
      } catch (err) {
        // The message is still claimed. Put it back with a backoff rather than losing the lease and
        // waiting out the full ten minutes.
        this.log.error('message processing threw; requeueing', { messageId: entry.messageId, reason: reasonOf(err) });
        entry.lastError = reasonOf(err);
        entry.attempt += 1;
        entry.nextAttemptAt = this.now() + backoffMs(this.policy, entry.attempt);
        await this.spool.release(claim, entry).catch(() => { /* the lease sweep is the backstop */ });
      }
    }));

    return result;
  }

  private async processEntry(entry: QueueEntry, claim: string): Promise<Omit<PassResult, 'claimed'>> {
    const attempt = entry.attempt + 1;
    const rfcMessageId = entry.message.messageId.includes('@')
      ? entry.message.messageId
      : `<${entry.message.messageId}@${this.cfg.hostname}>`;
    const events: DeliveryEvent[] = [];
    const stillPending: string[] = [];
    const counts = { delivered: 0, deferred: 0, bounced: 0, deadLettered: 0 };
    let lastError: string | null = entry.lastError;

    for (const [domain, recipients] of groupByDomain(entry.pending)) {
      const release = await this.throttle.acquire(domain);
      try {
        for (const r of recipients) {
          events.push(makeEvent({
            kind: 'attempting', stage: 'smtp', messageId: entry.messageId, rfcMessageId,
            from: entry.message.from, recipient: r, attempt, occurredAt: this.now(),
          }));
        }

        const results = await this.transport.deliver(entry.message, recipients, attempt);

        for (const res of results) {
          entry.history.push({
            at: this.now(), recipient: res.recipient, outcome: res.outcome,
            smtpCode: res.smtpCode, smtpResponse: res.smtpResponse, mxHost: res.mxHost,
          });

          const base = {
            stage: 'smtp' as const, messageId: entry.messageId, rfcMessageId, from: entry.message.from,
            recipient: res.recipient, attempt, smtpCode: res.smtpCode, enhancedCode: res.enhancedCode,
            smtpResponse: res.smtpResponse, mxHost: res.mxHost, tls: res.tls, dkimSigned: res.dkimSigned,
            latencyMs: res.latencyMs, bounceClass: res.bounceClass, occurredAt: this.now(),
          };

          if (res.outcome === 'delivered') {
            counts.delivered += 1;
            events.push(makeEvent({ ...base, kind: 'delivered' }));
            continue;
          }

          if (res.outcome === 'bounced') {
            counts.bounced += 1;
            metrics.counter(M.outboundBounced, 'Messages permanently rejected', { domain, class: res.bounceClass || 'unknown' });
            events.push(makeEvent({ ...base, kind: 'bounced', reason: res.smtpResponse }));
            await this.applySuppression(res.recipient, res.bounceClass, 'bounced', events, res.smtpResponse, false);
            lastError = res.smtpResponse;
            continue;
          }

          // Deferred: stays pending unless this was the last attempt.
          counts.deferred += 1;
          lastError = res.smtpResponse;
          stillPending.push(res.recipient);
          metrics.counter(M.outboundDeferred, 'Messages temporarily rejected', { domain, class: res.bounceClass || 'unknown' });
        }
      } catch (err) {
        // The transport itself threw rather than returning verdicts. Treat every recipient of this
        // domain as deferred: an exception is not evidence that a mailbox does not exist.
        this.log.error('transport threw', { domain, messageId: entry.messageId, reason: reasonOf(err) });
        lastError = reasonOf(err);
        for (const r of recipients) {
          counts.deferred += 1;
          stillPending.push(r);
          events.push(makeEvent({
            kind: 'deferred', stage: 'connection', messageId: entry.messageId, rfcMessageId,
            from: entry.message.from, recipient: r, attempt, reason: reasonOf(err),
            bounceClass: 'connection_failure', occurredAt: this.now(),
          }));
        }
      } finally {
        release();
      }
    }

    entry.attempt = attempt;
    entry.pending = stillPending;
    entry.lastError = lastError;
    entry.updatedAt = this.now();

    if (!stillPending.length) {
      await this.spool.complete(claim);
      await this.emit(events);
      this.log.info('message finished', { messageId: entry.messageId, delivered: counts.delivered, bounced: counts.bounced, attempt });
      return counts;
    }

    if (isExhausted(this.policy, attempt)) {
      counts.deadLettered = stillPending.length;
      metrics.counter(M.outboundDeadLettered, 'Messages that ran out of retries', {}, stillPending.length);
      for (const r of stillPending) {
        events.push(makeEvent({
          kind: 'dead_lettered', stage: 'queue', messageId: entry.messageId, rfcMessageId,
          from: entry.message.from, recipient: r, attempt,
          reason: `gave up after ${attempt} attempts over ${humanDuration(this.now() - entry.createdAt)}: ${lastError || 'no response'}`,
          smtpResponse: lastError, bounceClass: 'soft', occurredAt: this.now(),
        }));
        // A message that spent a full day being deferred is evidence about the address, even though
        // no single deferral was. `exhausted` turns it into a short cool-off, never a permanent block.
        await this.applySuppression(r, 'soft', 'deferred', events, lastError, true);
      }
      await this.spool.deadLetter(claim, entry, lastError || 'retries exhausted');
      await this.emit(events);
      this.log.error('message dead-lettered', { messageId: entry.messageId, recipients: stillPending, attempt, lastError });
      return counts;
    }

    const delay = backoffMs(this.policy, attempt);
    entry.nextAttemptAt = this.now() + delay;
    metrics.counter(M.outboundRetries, 'Retries scheduled');
    for (const r of stillPending) {
      events.push(makeEvent({
        kind: 'deferred', stage: 'smtp', messageId: entry.messageId, rfcMessageId,
        from: entry.message.from, recipient: r, attempt, reason: lastError, smtpResponse: lastError,
        nextAttemptAt: entry.nextAttemptAt, occurredAt: this.now(),
      }));
    }
    await this.spool.release(claim, entry);
    await this.emit(events);
    this.log.info('message deferred', {
      messageId: entry.messageId, pending: stillPending.length, attempt,
      retryIn: humanDuration(delay), reason: lastError,
    });
    return counts;
  }

  /**
   * Publishing is a SIDE EFFECT OF A DELIVERY THAT ALREADY HAPPENED, and it must never be able to
   * unwind one. The publisher contract says implementations do not throw on a transient failure, but
   * a contract is not a guarantee: when a throwing publisher was allowed to escape processEntry(),
   * the exception surfaced in runOnce() AFTER spool.complete() had already removed the claim, and the
   * generic "requeue on error" handler then wrote the message back onto the queue — so a message
   * that had been delivered successfully was delivered a second time, because telling the
   * application about it failed. Caught here, logged, and the events are lost rather than the truth.
   */
  private async emit(events: DeliveryEvent[]): Promise<void> {
    if (!events.length) return;
    try {
      await this.publisher.publish(events);
    } catch (err) {
      this.log.error('could not publish delivery events; the delivery itself is unaffected', {
        reason: reasonOf(err), count: events.length, kinds: [...new Set(events.map((e) => e.kind))],
      });
    }
  }

  private async applySuppression(
    recipient: string,
    cls: DeliveryEvent['bounceClass'],
    outcome: 'delivered' | 'deferred' | 'bounced',
    events: DeliveryEvent[],
    detail: string | null,
    exhausted: boolean,
  ): Promise<void> {
    const eventId = events[events.length - 1]?.eventId || recipient;
    const entry = suppressionFor(recipient, cls, outcome, eventId, detail, this.now(), exhausted);
    if (!entry) return;
    await this.publisher.suppress(entry).catch((err) => this.log.error('could not record a suppression', { reason: reasonOf(err), recipient }));
    events.push(makeEvent({
      kind: 'suppressed', stage: 'suppression', messageId: eventId, from: '', recipient,
      reason: `${entry.permanent ? 'permanently' : `until ${entry.expiresAt}`} suppressed: ${entry.reason}`,
      bounceClass: entry.reason, occurredAt: this.now(),
    }));
  }
}
