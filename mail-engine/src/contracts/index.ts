// mail-engine/src/contracts/index.ts — THE BOUNDARY BETWEEN THE MTA AND THE APPLICATION.
//
// Patch 1 owns the database. This file owns the shapes that cross between us, and nothing under
// mail-engine/src imports a database client, a Drizzle table or a Supabase key. Postfix internals
// stay on one side of this line and `delivery_attempts` / `delivery_events` / `bounce_events` /
// `suppression_entries` stay on the other; if the storage backend moves from Supabase to
// self-hosted infrastructure, only an implementation of these three interfaces changes.
//
// The three named in the brief:
//   MailTransport            — hands a message to the outside world and reports what the far end said
//   InboundMailProcessor     — turns a raw RFC 5322 blob arriving from the Internet into a delivery
//   DeliveryEventPublisher   — the only way anything in here tells the application what happened
//
// EVERY STAGE EMITS AN EVENT. That is why the kind enum below is as long as it is: a message that is
// validated, queued, attempted, deferred, retried and finally dead-lettered leaves a row behind at
// each step, so "what happened to that mail" is answerable from data rather than from a log grep.

/** Engine-side id for one message. Not the RFC Message-ID — that is `rfcMessageId`. */
export type MessageId = string;

export type EventStage =
  | 'validation'
  | 'suppression'
  | 'queue'
  | 'mx_lookup'
  | 'connection'
  | 'tls'
  | 'dkim'
  | 'smtp'
  | 'inbound';

export type EventKind =
  // outbound
  | 'accepted'        // passed validation, about to be queued
  | 'rejected'        // refused before ever being queued (bad address, suppressed, too large)
  | 'queued'
  | 'attempting'
  | 'delivered'       // 2xx from the recipient's MTA
  | 'deferred'        // 4xx — will be retried
  | 'bounced'         // 5xx — will not be retried
  | 'dead_lettered'   // retries exhausted, moved out of the active queue
  | 'suppressed'      // recipient added to the suppression list as a result of this event
  // inbound
  | 'inbound_received'
  | 'inbound_accepted'
  | 'inbound_rejected'
  | 'inbound_delivered';

/**
 * Bounce taxonomy. The brief lists these by name; it is a closed set because the suppression
 * decision is made from it, and a free-text reason cannot be reasoned about later.
 */
export type BounceClass =
  | 'hard'                 // generic permanent
  | 'soft'                 // generic temporary
  | 'invalid_mailbox'      // 5.1.1 — no such user
  | 'invalid_domain'       // 5.1.2 / NXDOMAIN / no MX
  | 'mailbox_full'         // 4.2.2 / 5.2.2 — over quota
  | 'temporary_rejection'  // 4.x with nothing more specific
  | 'rate_limited'         // 4.7.x throttling, "too many messages"
  | 'policy_rejection'     // 5.7.1 blocked by policy / relay denied
  | 'spam_rejection'       // content or reputation rejection
  | 'connection_failure'   // never got far enough to be told anything
  | 'content_rejection'    // refused for size or MIME reasons
  | 'unknown';

/** A single structured event. One row per stage transition, per recipient. */
export interface DeliveryEvent {
  /** Idempotency key. The publisher retries, so the receiver MUST upsert on this. */
  eventId: string;
  occurredAt: string;              // ISO 8601, UTC
  kind: EventKind;
  stage: EventStage;
  messageId: MessageId;
  rfcMessageId: string | null;
  /** Envelope sender, so the receiving app can tie the event back to a tenant/domain. */
  from: string;
  /** Exactly one recipient. A message to five people emits five of these. */
  recipient: string;
  recipientDomain: string;
  /** 1-based; 0 for events that happen before any delivery attempt. */
  attempt: number;
  smtpCode: number | null;         // 250, 421, 550 ...
  enhancedCode: string | null;     // RFC 3463, e.g. "5.1.1"
  smtpResponse: string | null;     // the far end's text, trimmed
  mxHost: string | null;
  tls: boolean | null;
  dkimSigned: boolean | null;
  latencyMs: number | null;
  bounceClass: BounceClass | null;
  /** Human-readable reason. Never the only place a fact is recorded. */
  reason: string | null;
  /** When the retry engine will try again. Null unless kind === 'deferred'. */
  nextAttemptAt: string | null;
}

/** Why a recipient is on the suppression list, and whether it can ever come off. */
export interface SuppressionEntry {
  recipient: string;
  reason: BounceClass;
  /** Permanent entries are never retried; temporary ones expire at `expiresAt`. */
  permanent: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastEventId: string;
  detail: string | null;
}

/** One outbound message, as the application hands it over. */
export interface OutboundMessage {
  messageId: MessageId;
  /** Envelope sender (MAIL FROM). Bounces come back here. */
  from: string;
  /** Header From, when it differs from the envelope (it usually should not). */
  headerFrom?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutboundAttachment[];
  /** Set by the API layer; the worker signs with the key held for this domain. */
  dkimDomain?: string;
}

export interface OutboundAttachment {
  filename: string;
  /** base64. Total message size is capped at the API — see config.maxMessageBytes. */
  content?: string;
  path?: string;
  href?: string;
  contentType?: string;
}

/** What one delivery attempt to one recipient produced. */
export interface DeliveryResult {
  recipient: string;
  outcome: 'delivered' | 'deferred' | 'bounced';
  smtpCode: number | null;
  enhancedCode: string | null;
  smtpResponse: string | null;
  mxHost: string | null;
  tls: boolean;
  dkimSigned: boolean;
  latencyMs: number;
  bounceClass: BounceClass | null;
}

/**
 * Hands a message to the outside world. Implementations: SmtpMailTransport (direct-to-MX or via a
 * relay) and, in tests, a transport that answers from a script.
 */
export interface MailTransport {
  readonly name: string;
  /** One call per destination domain; the recipients given always share a domain. */
  deliver(message: OutboundMessage, recipients: string[], attempt: number): Promise<DeliveryResult[]>;
  /** Release pooled connections. Safe to call more than once. */
  close(): Promise<void>;
}

/** A message that arrived from the Internet, after parsing. */
export interface InboundMessage {
  /** Envelope recipients — from RCPT TO, not from the headers, which lie for Bcc and aliases. */
  envelopeTo: string[];
  envelopeFrom: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  cc: { address: string; name: string }[];
  replyTo: string | null;
  subject: string;
  date: string | null;
  text: string;
  html: string;
  attachments: InboundAttachment[];
  /** Rspamd's verdict, when the message came through the milter. */
  spamScore: number | null;
  spamAction: string | null;
  sizeBytes: number;
  /** Authentication-Results header, kept so SPF/DKIM/DMARC outcomes stay auditable. */
  authResults: string | null;
}

export interface InboundAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  /** base64 of the part. Only populated for parts under config.maxAttachmentBytes. */
  content: string | null;
  /** Set when the part was refused; `content` is then null and this says why. */
  rejectedReason: string | null;
}

export interface InboundDeliveryOutcome {
  accepted: boolean;
  /** Addresses that resolved to a mailbox. */
  delivered: string[];
  /** Addresses with no mailbox here. Non-empty means the sender has to be told. */
  unresolved: string[];
  /** Set when the whole message was refused (spam, size, malformed). */
  rejectReason: string | null;
  /** True when the caller should answer the sending MTA 4xx so it retries. */
  retryable: boolean;
}

export interface InboundMailProcessor {
  /** Parse and deliver one raw RFC 5322 message. The envelope overrides the headers when known. */
  process(raw: Buffer | string, envelope: { from: string; to: string[] }): Promise<InboundDeliveryOutcome>;
}

export interface DeliveryEventPublisher {
  /** Publish a batch. MUST NOT throw on a transient failure — durably retry instead. */
  publish(events: DeliveryEvent[]): Promise<void>;
  /** Ask the application whether this recipient is suppressed. */
  isSuppressed(recipient: string): Promise<boolean>;
  /** Record (or refresh) a suppression entry. */
  suppress(entry: SuppressionEntry): Promise<void>;
  /** Flush anything held in the local outbox. Returns how many events were accepted. */
  flush(): Promise<number>;
  /** How many events are waiting because the application could not be reached. */
  pending(): Promise<number>;
}
