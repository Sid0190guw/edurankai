// mail-engine/src/inbound/processor.ts — Internet -> MX -> Postfix -> here -> the application.
//
// THE ORDER OF THE CHECKS IS THE DESIGN. Each one is cheaper than the next and each one refuses
// something the next would have to handle:
//
//   size          bytes we will not even parse
//   parse         a blob that is not a message
//   bounce?       a delivery report about OUR mail — handled here, never filed to a person's inbox
//   spam          Rspamd's verdict, when a filter is in front of us
//   recipients    is this address ours at all
//   spool         durable, on our disk, before we say "accepted"
//
// ACCEPTED MEANS SPOOLED, NOT DELIVERED. Once the message is on this engine's disk, the sending MTA
// is told 250 and is released from its responsibility — and from that moment the message is OURS to
// deliver, retrying against the application for as long as it takes. The alternative, holding the
// SMTP connection open while the application writes to Supabase, makes every application deploy into
// a mail outage and every slow database query into a timeout at the sender.
//
// AND THE CONVERSE, WHICH MATTERS MORE: NOTHING IS ACCEPTED THAT IS NOT SPOOLED. If the spool write
// fails, process() returns retryable and the sending MTA is told 4xx, so it keeps the message and
// tries again in a few minutes. The one outcome that must never happen is answering 250 to a message
// this engine did not manage to keep.
//
// BOUNCES DO NOT GO TO A HUMAN'S INBOX. A delivery report addressed to the envelope sender is
// evidence about a message WE sent. It is parsed, turned into bounce events and suppressions, and
// acknowledged. Filing "Undelivered Mail Returned to Sender" into a user's inbox is how a mail
// system teaches its users to ignore it.

import type {
  DeliveryEventPublisher, InboundDeliveryOutcome, InboundMailProcessor, InboundMessage,
} from '../contracts/index.js';
import type { EngineConfig } from '../config.js';
import { Outbox } from '../queue/outbox.js';
import { WarnThrottle } from '../log-once.js';
import { parseInbound, looksLikeBounce } from '../mime/parse.js';
import { parseDsn } from '../mime/dsn.js';
import { makeEvent } from '../events.js';
import { suppressionFor } from '../smtp/classify.js';
import { isLocalRecipient } from '../validate.js';
import { type Logger, reasonOf } from '../logger.js';
import { M, metrics } from '../metrics.js';

/** What gets spooled for the application: the raw message plus the envelope we were given. */
export interface InboundSpoolItem {
  raw: string;                 // base64 of the original bytes — never re-encoded, never rewritten
  envelopeFrom: string;
  envelopeTo: string[];
  receivedAt: string;
  subject: string;
  rfcMessageId: string | null;
  spamScore: number | null;
}

export interface InboundProcessorDeps {
  config: EngineConfig;
  logger: Logger;
  publisher: DeliveryEventPublisher;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AppInboundProcessor implements InboundMailProcessor {
  private readonly cfg: EngineConfig;
  private readonly log: Logger;
  private readonly publisher: DeliveryEventPublisher;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly outbox: Outbox<InboundSpoolItem>;
  private readonly warnThrottle: WarnThrottle;

  constructor(deps: InboundProcessorDeps) {
    this.cfg = deps.config;
    this.log = deps.logger.child({ component: 'inbound' });
    this.publisher = deps.publisher;
    this.fetchImpl = deps.fetchImpl || ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.now = deps.now || (() => Date.now());
    this.outbox = new Outbox<InboundSpoolItem>(this.cfg.spoolDir, 'inbound');
    this.warnThrottle = new WarnThrottle(60_000, this.now);
  }

  async process(raw: Buffer | string, envelope: { from: string; to: string[] }): Promise<InboundDeliveryOutcome> {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    metrics.counter(M.inboundReceived, 'Messages accepted from the Internet');

    if (buf.length > this.cfg.maxMessageBytes) {
      metrics.counter(M.inboundRejected, 'Inbound messages refused', { reason: 'too_large' });
      return this.reject(`message is ${Math.round(buf.length / 1024)}KB, over the ${Math.round(this.cfg.maxMessageBytes / 1024)}KB limit`, false);
    }

    let message: InboundMessage;
    try {
      message = await parseInbound(buf, {
        maxAttachmentBytes: this.cfg.maxAttachmentBytes,
        blockedExtensions: this.cfg.blockedAttachmentExtensions,
        envelope,
      });
    } catch (err) {
      // RETRYABLE, DELIBERATELY. A parser that fell over is our problem, not the sender's, and a
      // 4xx keeps the message at the sending MTA where it can be re-delivered after a fix. The
      // application's /api/mail/inbound learned this same lesson the hard way — see the comment in
      // src/pages/api/mail/inbound.ts about messages that vanished when parsing failed.
      this.log.error('inbound message would not parse', { reason: reasonOf(err), bytes: buf.length, envelope });
      metrics.counter(M.inboundRejected, 'Inbound messages refused', { reason: 'unparseable' });
      return this.reject(`message could not be parsed: ${reasonOf(err)}`, true);
    }

    // ---- is this a delivery report about our own mail? -------------------------
    if (looksLikeBounce(message)) {
      const handled = await this.handleBounce(buf, message);
      if (handled) {
        return { accepted: true, delivered: [], unresolved: [], rejectReason: null, retryable: false };
      }
      // Looked like a bounce but carried no readable report. Fall through and deliver it like any
      // other message rather than dropping it — a human may still need to read it.
      this.log.warn('bounce-shaped message carried no readable delivery report', {
        from: message.from.address, subject: message.subject.slice(0, 120),
      });
    }

    // ---- spam -------------------------------------------------------------------
    if (message.spamScore != null && message.spamScore >= this.cfg.spamRejectScore) {
      this.log.warn('inbound message refused as spam', {
        score: message.spamScore, threshold: this.cfg.spamRejectScore, from: message.envelopeFrom,
      });
      metrics.counter(M.inboundRejected, 'Inbound messages refused', { reason: 'spam' });
      await this.publisher.publish(message.envelopeTo.map((r) => makeEvent({
        kind: 'inbound_rejected', stage: 'inbound', messageId: message.rfcMessageId || '', rfcMessageId: message.rfcMessageId,
        from: message.envelopeFrom, recipient: r, reason: `spam score ${message.spamScore} >= ${this.cfg.spamRejectScore}`,
        occurredAt: this.now(),
      })));
      // NOT retryable: a spam verdict will be the same on the next attempt, and 4xx-ing a spammer
      // just invites the same message every fifteen minutes for a week.
      return this.reject(`rejected: spam score ${message.spamScore}`, false);
    }

    // ---- recipient validation ----------------------------------------------------
    const accepted: string[] = [];
    const unresolved: string[] = [];
    for (const rcpt of message.envelopeTo) {
      if (isLocalRecipient(rcpt, this.cfg) || this.cfg.catchAllEnabled) accepted.push(rcpt);
      else unresolved.push(rcpt);
    }

    if (!accepted.length) {
      // The engine only knows about DOMAINS; whether a particular mailbox exists is the
      // application's question, and it answers it when the message is handed over. So this refusal
      // means "not one of our domains", which is unambiguous and permanent.
      metrics.counter(M.inboundRejected, 'Inbound messages refused', { reason: 'not_local' });
      this.log.warn('inbound message for no domain of ours', { envelopeTo: message.envelopeTo, from: message.envelopeFrom });
      await this.publisher.publish(unresolved.map((r) => makeEvent({
        kind: 'inbound_rejected', stage: 'inbound', messageId: message.rfcMessageId || '', rfcMessageId: message.rfcMessageId,
        from: message.envelopeFrom, recipient: r, reason: 'relay access denied: not a domain hosted here',
        occurredAt: this.now(),
      })));
      return this.reject('relay access denied', false);
    }

    // ---- spool, then accept -------------------------------------------------------
    try {
      await this.outbox.add({
        raw: buf.toString('base64'),
        envelopeFrom: message.envelopeFrom,
        envelopeTo: accepted,
        receivedAt: new Date(this.now()).toISOString(),
        subject: message.subject,
        rfcMessageId: message.rfcMessageId,
        spamScore: message.spamScore,
      }, this.now());
    } catch (err) {
      this.log.error('could not spool an inbound message; refusing it so the sender retries', { reason: reasonOf(err) });
      return this.reject('temporary local error, please retry', true);
    }

    await this.publisher.publish(accepted.map((r) => makeEvent({
      kind: 'inbound_accepted', stage: 'inbound', messageId: message.rfcMessageId || '', rfcMessageId: message.rfcMessageId,
      from: message.envelopeFrom, recipient: r, occurredAt: this.now(),
      reason: message.spamScore != null && message.spamScore >= this.cfg.spamQuarantineScore ? `quarantined: spam score ${message.spamScore}` : null,
    })));

    this.log.info('inbound message accepted', {
      from: message.envelopeFrom, to: accepted, subject: message.subject.slice(0, 120),
      bytes: buf.length, attachments: message.attachments.length, spamScore: message.spamScore,
    });

    // Try immediately; failure is fine, the item is spooled and flushInbound() will keep at it.
    await this.flushInbound().catch(() => 0);

    return { accepted: true, delivered: accepted, unresolved, rejectReason: null, retryable: false };
  }

  private reject(reason: string, retryable: boolean): InboundDeliveryOutcome {
    return { accepted: false, delivered: [], unresolved: [], rejectReason: reason, retryable };
  }

  /**
   * Hand spooled inbound messages to the application. Called after every acceptance and on a timer.
   * Returns how many were delivered.
   */
  async flushInbound(limit = 20): Promise<number> {
    const batch = await this.outbox.take(limit);
    if (!batch.length) return 0;
    if (!this.cfg.inboundSecret) {
      // Throttled for the same reason as the publisher's: this is polled, and the condition does
      // not change between polls. See log-once.ts.
      const warn = this.warnThrottle.check('no-inbound-secret');
      if (warn.shouldLog) {
        this.log.warn('not delivering inbound mail: MAIL_INBOUND_SECRET is not set', {
          pending: batch.length,
          ...(warn.suppressed ? { similarSuppressed: warn.suppressed } : {}),
        });
      }
      return 0;
    }

    let delivered = 0;
    for (const { file, item } of batch) {
      const raw = Buffer.from(item.payload.raw, 'base64');
      let res: Response;
      try {
        // The application's existing contract, unchanged: raw MIME with the envelope in headers.
        // See src/pages/api/mail/inbound.ts — it already accepts exactly this shape from the
        // Cloudflare Email Worker, so the engine slots in beside that route rather than needing a
        // new one built for it.
        res = await this.fetchImpl(`${this.cfg.appBaseUrl.replace(/\/$/, '')}/api/mail/inbound`, {
          method: 'POST',
          headers: {
            'content-type': 'message/rfc822',
            'x-mail-secret': this.cfg.inboundSecret,
            'x-mail-to': item.payload.envelopeTo.join(','),
            'x-mail-from': item.payload.envelopeFrom,
          },
          body: raw,
          signal: AbortSignal.timeout(this.cfg.appTimeoutMs),
        });
      } catch (err) {
        await this.outbox.retry(file, item, reasonOf(err));
        this.log.warn('application unreachable; inbound mail held on disk', {
          pending: batch.length, reason: reasonOf(err), subject: item.payload.subject.slice(0, 80),
        });
        // One unreachable application means the rest of the batch will fail the same way.
        break;
      }

      if (res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        await this.outbox.ack(file);
        delivered += 1;
        metrics.counter(M.inboundDelivered, 'Inbound messages handed to the application');
        await this.publisher.publish(item.payload.envelopeTo.map((r) => makeEvent({
          kind: 'inbound_delivered', stage: 'inbound', messageId: item.payload.rfcMessageId || item.id,
          rfcMessageId: item.payload.rfcMessageId, from: item.payload.envelopeFrom, recipient: r,
          occurredAt: this.now(),
          reason: Array.isArray((body as { unresolved?: string[] }).unresolved) && (body as { unresolved: string[] }).unresolved.length
            ? `application had no mailbox for ${(body as { unresolved: string[] }).unresolved.join(', ')}`
            : null,
        })));
        continue;
      }

      const text = await res.text().catch(() => '');
      // 400 is the application saying this message can never be delivered (no recipients it knows
      // of). Park it in rejected/ — kept, not deleted, because a mailbox may be created tomorrow.
      // EVERYTHING ELSE IS RETRIED, including 403: a wrong shared secret is a misconfiguration, and
      // discarding real mail because of a misconfiguration is not a trade this engine will make.
      if (res.status === 400) {
        await this.outbox.reject(file, item, `${res.status}: ${text.slice(0, 200)}`);
        this.log.error('application refused an inbound message permanently', {
          status: res.status, body: text.slice(0, 200), subject: item.payload.subject.slice(0, 80),
        });
      } else {
        await this.outbox.retry(file, item, `${res.status}: ${text.slice(0, 200)}`);
        this.log.warn('application could not take an inbound message yet', { status: res.status, attempts: item.attempts });
        break;
      }
    }
    return delivered;
  }

  /** Bounce reports: parse, record, suppress. Returns false when there was no readable report. */
  private async handleBounce(raw: Buffer, message: InboundMessage): Promise<boolean> {
    const report = parseDsn(raw);
    if (!report.recipients.length) return false;

    this.log.info('delivery report received', {
      kind: report.kind, reportingMta: report.reportingMta,
      originalMessageId: report.originalMessageId, recipients: report.recipients.length,
      feedbackType: report.feedbackType,
    });

    for (const r of report.recipients) {
      if (r.outcome === 'delivered') continue;
      const event = makeEvent({
        kind: r.outcome === 'bounced' ? 'bounced' : 'deferred',
        stage: 'inbound',
        messageId: report.originalMessageId || message.rfcMessageId || '',
        rfcMessageId: report.originalMessageId,
        from: report.originalFrom || message.envelopeFrom,
        recipient: r.recipient,
        smtpCode: r.smtpCode,
        enhancedCode: r.status,
        smtpResponse: r.diagnosticCode,
        mxHost: r.remoteMta,
        bounceClass: r.bounceClass,
        reason: `asynchronous ${report.kind === 'arf' ? `${report.feedbackType || 'abuse'} complaint` : 'delivery report'} from ${report.reportingMta || 'the receiving server'}`,
        occurredAt: this.now(),
      });
      await this.publisher.publish([event]);
      metrics.counter(M.outboundBounced, 'Messages permanently rejected', {
        domain: r.recipient.split('@')[1] || 'unknown', class: r.bounceClass || 'unknown', source: 'dsn',
      });

      const suppression = suppressionFor(r.recipient, r.bounceClass, r.outcome, event.eventId, r.diagnosticCode, this.now(), false);
      if (suppression) await this.publisher.suppress(suppression);
    }
    return true;
  }

  async pending(): Promise<number> {
    return this.outbox.size();
  }
}
