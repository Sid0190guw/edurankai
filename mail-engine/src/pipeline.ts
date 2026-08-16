// mail-engine/src/pipeline.ts — everything between "the application called us" and "it is queued".
//
// Section 4 of the brief, in order, with an event at every step:
//
//   Mail API -> validation -> suppression check -> queue -> (worker takes over from here)
//
// SUPPRESSION IS CHECKED PER RECIPIENT, NOT PER MESSAGE. A newsletter to forty people where one
// address hard-bounced last week should go to the other thirty-nine. Refusing the whole message
// because one recipient is suppressed is a bug that looks like a safety feature.
//
// A REJECTION IS NOT A FAILURE TO RECORD. Every refused recipient gets a 'rejected' event with the
// reason, so "why did that person not get the mail" is answerable from the same stream that answers
// "why did that person not get the mail YET". A validation refusal that only returned an HTTP 400
// would leave nothing behind once the caller had logged it and moved on.

import { randomUUID } from 'node:crypto';
import type { DeliveryEventPublisher, OutboundMessage } from './contracts/index.js';
import type { EngineConfig } from './config.js';
import { MessageSpool, newQueueEntry } from './queue/message-spool.js';
import { validateOutbound, isLocalSender } from './validate.js';
import { makeEvent } from './events.js';
import type { Logger } from './logger.js';
import { M, metrics } from './metrics.js';

export interface SubmitResult {
  accepted: boolean;
  messageId: string;
  /** Recipients that made it into the queue. */
  queued: string[];
  /** Recipients refused, with the reason each was refused for. */
  refused: { recipient: string; reason: string }[];
  /** Message-level problems (bad From, oversized, header injection). */
  issues: { field: string; problem: string; value?: string }[];
}

export interface PipelineDeps {
  config: EngineConfig;
  logger: Logger;
  spool: MessageSpool;
  publisher: DeliveryEventPublisher;
  now?: () => number;
}

export class SubmissionPipeline {
  private readonly cfg: EngineConfig;
  private readonly log: Logger;
  private readonly spool: MessageSpool;
  private readonly publisher: DeliveryEventPublisher;
  private readonly now: () => number;

  constructor(deps: PipelineDeps) {
    this.cfg = deps.config;
    this.log = deps.logger.child({ component: 'pipeline' });
    this.spool = deps.spool;
    this.publisher = deps.publisher;
    this.now = deps.now || (() => Date.now());
  }

  async submit(input: OutboundMessage): Promise<SubmitResult> {
    const now = this.now();
    const message: OutboundMessage = { ...input, messageId: input.messageId || randomUUID() };
    const rfcMessageId = message.messageId.includes('@') ? message.messageId : `<${message.messageId}@${this.cfg.hostname}>`;
    metrics.counter(M.outboundSubmitted, 'Messages handed to the mail engine');

    // ---- validation ------------------------------------------------------------
    const validation = validateOutbound(message, this.cfg);

    // ANTI-RELAY, AT THE SUBMISSION DOOR. An engine that signs for edurankai.in and accepts a message
    // claiming to be from someone else's domain is an open relay with extra steps: it would sign and
    // send mail on behalf of a domain it has no authority over. Postfix enforces the same rule at
    // the SMTP layer (see docker/postfix/main.cf); this is the API layer's copy of it.
    if (validation.ok && !isLocalSender(message.from, this.cfg)) {
      validation.ok = false;
      validation.issues.push({
        field: 'from',
        problem: `this engine only sends as ${this.cfg.domains.join(', ')}`,
        value: message.from.slice(0, 120),
      });
    }

    if (!validation.ok) {
      const reason = validation.issues.map((i) => `${i.field}: ${i.problem}`).join('; ');
      metrics.counter(M.outboundRejected, 'Messages refused before being queued', { stage: 'validation' });
      const targets = validation.recipients.length ? validation.recipients : [''];
      await this.publisher.publish(targets.map((r) => makeEvent({
        kind: 'rejected', stage: 'validation', messageId: message.messageId, rfcMessageId,
        from: message.from, recipient: r, reason, occurredAt: now,
      })));
      this.log.warn('message refused at validation', { messageId: message.messageId, issues: validation.issues });
      return {
        accepted: false,
        messageId: message.messageId,
        queued: [],
        refused: validation.recipients.map((r) => ({ recipient: r, reason })),
        issues: validation.issues,
      };
    }

    // ---- suppression -----------------------------------------------------------
    const queued: string[] = [];
    const refused: { recipient: string; reason: string }[] = [];
    for (const recipient of validation.recipients) {
      if (await this.publisher.isSuppressed(recipient)) {
        refused.push({ recipient, reason: 'recipient is on the suppression list' });
        continue;
      }
      queued.push(recipient);
    }

    if (refused.length) {
      metrics.counter(M.outboundRejected, 'Messages refused before being queued', { stage: 'suppression' }, refused.length);
      await this.publisher.publish(refused.map((r) => makeEvent({
        kind: 'rejected', stage: 'suppression', messageId: message.messageId, rfcMessageId,
        from: message.from, recipient: r.recipient, reason: r.reason, occurredAt: now,
      })));
    }

    if (!queued.length) {
      this.log.warn('every recipient was suppressed', { messageId: message.messageId, refused: refused.length });
      return { accepted: false, messageId: message.messageId, queued: [], refused, issues: [] };
    }

    // ---- queue -----------------------------------------------------------------
    const entry = newQueueEntry({ ...message, dkimDomain: message.dkimDomain || undefined }, queued, now);
    await this.spool.enqueue(entry);

    await this.publisher.publish(queued.flatMap((r) => [
      makeEvent({ kind: 'accepted', stage: 'validation', messageId: message.messageId, rfcMessageId, from: message.from, recipient: r, occurredAt: now }),
      makeEvent({ kind: 'queued', stage: 'queue', messageId: message.messageId, rfcMessageId, from: message.from, recipient: r, occurredAt: now, nextAttemptAt: entry.nextAttemptAt }),
    ]));

    this.log.info('message queued', { messageId: message.messageId, recipients: queued.length, refused: refused.length });
    return { accepted: true, messageId: message.messageId, queued, refused, issues: [] };
  }
}
