// mail-engine/src/events.ts — one factory, so every event in the stream has the same shape.
//
// The alternative — building object literals at each of the dozen places an event is emitted — is
// how a stream ends up with three spellings of the same field and a consumer that has to guess.
// Every field is present on every event, null where it does not apply, because a consumer written
// against `event.smtpCode ?? null` is simpler than one written against `'smtpCode' in event`.

import { randomUUID } from 'node:crypto';
import type { DeliveryEvent, EventKind, EventStage } from './contracts/index.js';
import { domainOf } from './smtp/mx.js';

export interface EventInput {
  kind: EventKind;
  stage: EventStage;
  messageId: string;
  from: string;
  recipient: string;
  rfcMessageId?: string | null;
  attempt?: number;
  smtpCode?: number | null;
  enhancedCode?: string | null;
  smtpResponse?: string | null;
  mxHost?: string | null;
  tls?: boolean | null;
  dkimSigned?: boolean | null;
  latencyMs?: number | null;
  bounceClass?: DeliveryEvent['bounceClass'];
  reason?: string | null;
  nextAttemptAt?: number | string | null;
  occurredAt?: number | Date;
}

export function makeEvent(input: EventInput): DeliveryEvent {
  const occurred = input.occurredAt == null
    ? new Date()
    : input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  const next = input.nextAttemptAt == null
    ? null
    : typeof input.nextAttemptAt === 'string' ? input.nextAttemptAt : new Date(input.nextAttemptAt).toISOString();

  return {
    eventId: randomUUID(),
    occurredAt: occurred.toISOString(),
    kind: input.kind,
    stage: input.stage,
    messageId: input.messageId,
    rfcMessageId: input.rfcMessageId ?? null,
    from: input.from,
    recipient: input.recipient,
    recipientDomain: domainOf(input.recipient),
    attempt: input.attempt ?? 0,
    smtpCode: input.smtpCode ?? null,
    enhancedCode: input.enhancedCode ?? null,
    smtpResponse: input.smtpResponse ? String(input.smtpResponse).slice(0, 1000) : null,
    mxHost: input.mxHost ?? null,
    tls: input.tls ?? null,
    dkimSigned: input.dkimSigned ?? null,
    latencyMs: input.latencyMs ?? null,
    bounceClass: input.bounceClass ?? null,
    reason: input.reason ? String(input.reason).slice(0, 1000) : null,
    nextAttemptAt: next,
  };
}
