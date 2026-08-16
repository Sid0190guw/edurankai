// src/lib/mailplatform/interfaces.ts — the swap points.
//
// The rule this file exists to enforce: NOTHING above these interfaces knows which mail server,
// object store, queue or auth system is in use. The application calls a service; the service calls
// an interface; an adapter in ./adapters implements it. Replacing local SMTP with an EduRankAI MTA
// cluster, Vercel Blob with S3, or the Postgres queue with Kafka is then an adapter swap and a
// registry line — not a rewrite.
//
//   Application (API routes, admin screens, other EduRankAI products)
//        v
//   Services (send.ts, contacts.ts, campaigns.ts, domains.ts, ...)
//        v
//   Interfaces (this file)          <-- the only thing services import
//        v
//   Adapters (./adapters/*)         <-- the only thing that names a vendor
//
// Every method returns a RESULT rather than throwing for expected failures. A transport that
// cannot reach a server is an ordinary Tuesday, not an exception; making it one is how a failed
// send ends up in a `catch {}` and disappears — which has happened in this repository before, and
// is written up at the top of src/lib/mail-transport.ts.

import type {
  Attachment,
  Contact,
  DeliveryEvent,
  DkimKey,
  DnsRecord,
  DnsCheckType,
  Domain,
  Folder,
  Mailbox,
  MailboxMessageState,
  Message,
  MessageHeader,
  Page,
  PageRequest,
  PlatformEvent,
  Principal,
  Recipient,
  Thread,
  UUID,
} from './types';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** The shape every adapter reports itself with, so an ops screen can state what is actually wired. */
export interface ProviderInfo {
  /** Stable machine name: 'smtp', 's3', 'postgres-queue', 'session-auth'. */
  kind: string;
  /** True only when the adapter has everything it needs to do real work. */
  enabled: boolean;
  /** One sentence a human can act on when `enabled` is false. Never "not configured" alone. */
  detail: string;
}

export interface OperationResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Machine-readable failure reason, for callers that branch on it. */
  code?: string;
}

// ---------------------------------------------------------------------------
// 1. MailTransport — outbound
// ---------------------------------------------------------------------------

export interface OutboundEnvelope {
  /** Envelope sender (Return-Path / MAIL FROM). Bounces come back here, not to the From header. */
  returnPath?: string;
  from: string;
  fromName?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Extra RFC headers. `X-EduRankAI-*` keys are reserved for platform correlation. */
  headers?: Record<string, string>;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: { filename: string; url?: string; path?: string; contentType?: string }[];
  /**
   * DKIM signing material. The transport signs; the platform never holds a private key in a
   * database column. `privateKeyRef` is resolved by the transport out of its own secret store.
   */
  dkim?: { domain: string; selector: string; privateKeyRef: string } | null;
  /** Correlation id, echoed back on every delivery event the transport reports. */
  platformMessageId?: UUID | null;
}

export interface TransportSendResult {
  ok: boolean;
  /** The transport's own id for this send, when it has one. */
  providerMessageId?: string | null;
  /** Addresses the remote server accepted. */
  accepted: string[];
  rejected: { address: string; reason: string; smtpCode?: number | null }[];
  smtpCode?: number | null;
  smtpResponse?: string | null;
  remoteMx?: string | null;
  latencyMs?: number | null;
  error?: string;
  /** True when a retry could plausibly succeed (4xx, timeout, greylisting). */
  retryable?: boolean;
}

/**
 * Outbound delivery.
 *
 * Implemented today by ./adapters/transport-smtp.ts over the repository's existing nodemailer
 * transport. The EduRankAI MTA cluster implements this same interface and nothing above changes.
 *
 * OWNERSHIP: the SMTP/MTA agent owns implementations. This file owns the shape.
 */
export interface MailTransport {
  info(): ProviderInfo;
  send(envelope: OutboundEnvelope): Promise<TransportSendResult>;
  /** Prove the transport can authenticate and reach a server, without sending mail. */
  verify(): Promise<OperationResult<{ detail: string }>>;
}

// ---------------------------------------------------------------------------
// 2. InboundMailTransport — receiving
// ---------------------------------------------------------------------------

export interface InboundMessage {
  /** Full RFC 5322 source when available. The platform stores it in object storage, not a column. */
  raw?: Uint8Array | string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: { email: string; name?: string | null };
  to: { email: string; name?: string | null }[];
  cc?: { email: string; name?: string | null }[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: MessageHeader[];
  attachments: { filename: string; mime: string | null; sizeBytes: number | null; content?: Uint8Array }[];
  receivedAt: string;
  /** Set by the receiving edge (MTA, gateway) when it has already scored the message. */
  spamScore?: number | null;
  /** SPF/DKIM/DMARC results as observed at ingress. Advisory: a human decides quarantine. */
  authResults?: { spf?: string; dkim?: string; dmarc?: string } | null;
}

export interface InboundFetchResult {
  ok: boolean;
  fetched: number;
  delivered: number;
  error?: string;
  detail?: string;
}

/**
 * Inbound mail.
 *
 * Two shapes of source, one interface: a PULL source (IMAP poll — what runs today) and a PUSH
 * source (an MTA or gateway POSTing to /api/mail/inbound). `poll()` is a no-op returning
 * `fetched: 0` on a push-only adapter, and that is reported honestly in `info().detail` rather than
 * looking like an empty mailbox.
 */
export interface InboundMailTransport {
  info(): ProviderInfo;
  poll(opts?: { limit?: number; force?: boolean }): Promise<InboundFetchResult>;
  /** Parse a pushed payload into the platform's shape. Called by the inbound webhook route. */
  parse(payload: unknown): Promise<OperationResult<InboundMessage>>;
}

// ---------------------------------------------------------------------------
// 3. MessageStore — persistence for messages, threads, folders
// ---------------------------------------------------------------------------

export interface MessageQuery extends PageRequest {
  orgId?: UUID;
  mailboxId?: UUID | null;
  userId?: UUID;
  folder?: string;
  threadId?: UUID;
  labels?: string[];
  isRead?: boolean;
  isStarred?: boolean;
  isDraft?: boolean;
  direction?: Message['direction'];
  /** Full-text over subject, snippet and body. */
  search?: string;
  from?: string;
  to?: string;
  hasAttachments?: boolean;
  before?: string;
  after?: string;
}

export interface PersistMessageInput {
  orgId: UUID | null;
  threadId?: UUID | null;
  mailboxId?: UUID | null;
  direction: Message['direction'];
  from: { email: string; name?: string | null };
  fromUserId?: UUID | null;
  recipients: Recipient[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  replyTo?: string | null;
  headers?: MessageHeader[];
  attachments?: Omit<Attachment, 'id' | 'messageId'>[];
  rawObjectKey?: string | null;
  sizeBytes?: number | null;
  spamScore?: number | null;
  spamVerdict?: Message['spamVerdict'];
  isDraft?: boolean;
  sentAt?: string | null;
  receivedAt?: string | null;
}

export interface PersistMessageResult {
  messageId: UUID;
  threadId: UUID;
  rfcMessageId: string;
  /** Recipients with no local account — the caller hands these to a MailTransport. */
  external: Recipient[];
  /** Recipients that resolved to a local account and now have a mailbox copy. */
  internal: Recipient[];
}

export interface MailboxStatePatch {
  folder?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
  snoozedUntil?: string | null;
}

/**
 * The message store.
 *
 * Implemented by ./adapters/message-store-postgres.ts against the mail_* tables that already exist
 * in this repository, extended additively. A different backend (a dedicated message DB, an IMAP
 * server's own store) implements this interface instead.
 */
export interface MessageStore {
  info(): ProviderInfo;

  persist(input: PersistMessageInput): Promise<OperationResult<PersistMessageResult>>;
  get(messageId: UUID, viewer: { userId?: UUID; orgId?: UUID }): Promise<Message | null>;
  list(query: MessageQuery): Promise<Page<Message>>;
  listThreads(query: MessageQuery): Promise<Page<Thread & { lastMessage?: Message }>>;
  getThread(threadId: UUID, viewer: { userId?: UUID; orgId?: UUID }): Promise<Message[]>;

  /** Per-mailbox flags. Never touches the message body — that is shared by every copy. */
  patchState(
    messageId: UUID,
    viewer: { userId: UUID },
    patch: MailboxStatePatch,
  ): Promise<OperationResult<MailboxMessageState>>;

  /** Soft delete: moves to trash. `hard` erases the row, and is audited by the caller. */
  remove(messageId: UUID, viewer: { userId: UUID }, opts?: { hard?: boolean }): Promise<OperationResult>;

  folders(mailboxOrUser: { mailboxId?: UUID; userId?: UUID }): Promise<Folder[]>;
  counts(viewer: { userId: UUID }): Promise<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// 4. AttachmentStore — object storage
// ---------------------------------------------------------------------------

export interface StoredAttachment {
  key: string;
  url: string;
  backend: string;
  sizeBytes: number | null;
}

/**
 * Object storage for attachments and raw MIME.
 *
 * Binary payloads NEVER go in Postgres. Implemented over the repository's existing src/lib/storage.ts,
 * which already speaks S3 (SigV4, no vendor SDK) with a Vercel Blob fallback and an in-memory dev
 * store — so the sovereignty requirement (S3-compatible, self-hostable) is met today, not later.
 */
export interface AttachmentStore {
  info(): ProviderInfo;
  put(
    key: string,
    data: Uint8Array | ArrayBuffer | string | Blob,
    contentType: string,
  ): Promise<OperationResult<StoredAttachment>>;
  /** A time-limited URL a browser can PUT to directly, for large attachments. */
  presignUpload(key: string, opts?: { expiresInSeconds?: number }): Promise<OperationResult<{ url: string; fields?: Record<string, string> }>>;
  url(key: string): string | null;
}

// ---------------------------------------------------------------------------
// 5. QueueProvider — background work
// ---------------------------------------------------------------------------

export interface QueueJob<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  /** Idempotency key. A repeat enqueue with the same key is dropped, not duplicated. */
  dedupKey?: string;
  maxAttempts?: number;
  delayMs?: number;
}

/**
 * Background work.
 *
 * Implemented over src/lib/job-queue.ts (Postgres: atomic claim with FOR UPDATE SKIP LOCKED,
 * exponential backoff, unique dedup key). A Kafka or SQS adapter implements the same four methods.
 * The dedup key is what makes "send this campaign" safe to retry, so it is part of the interface
 * rather than an implementation detail.
 */
export interface QueueProvider {
  info(): ProviderInfo;
  enqueue<T>(kind: string, payload: T, opts?: EnqueueOptions): Promise<OperationResult<{ id: string | null; deduped: boolean }>>;
  claim(limit?: number): Promise<QueueJob[]>;
  complete(jobId: string): Promise<void>;
  fail(job: QueueJob, error: string): Promise<void>;
  health(): Promise<{ pending: number; processing: number; failed: number; done: number }>;
}

// ---------------------------------------------------------------------------
// 6. EventBus — the fact stream
// ---------------------------------------------------------------------------

export interface EventQuery extends PageRequest {
  orgId: UUID;
  eventTypes?: string[];
  entityType?: string;
  entityId?: string;
  since?: string;
  until?: string;
}

/**
 * Append-only platform events.
 *
 * Every meaningful thing that happens (message.sent, delivery.bounced, contact.subscribed,
 * campaign.started) is published here exactly once. Webhooks and analytics both READ this stream
 * rather than being called separately at each site — so a new consumer never requires a new call
 * site, and a missed webhook is a replay rather than a lost fact.
 */
export interface EventBus {
  info(): ProviderInfo;
  publish(event: Omit<PlatformEvent, 'id'>): Promise<OperationResult<{ id: string }>>;
  publishMany(events: Omit<PlatformEvent, 'id'>[]): Promise<OperationResult<{ count: number }>>;
  query(q: EventQuery): Promise<Page<PlatformEvent>>;
}

// ---------------------------------------------------------------------------
// 7. AuthenticationProvider — who is calling
// ---------------------------------------------------------------------------

export interface AuthContext {
  request: Request;
  /** Astro's `locals`, which already carries `user` when a session cookie validated. */
  locals?: unknown;
}

/**
 * Identity resolution.
 *
 * Today: the repository's own session cookies (src/lib/auth/session.ts) and its own hashed API keys
 * (src/lib/api-keys.ts). Not Supabase Auth — this codebase has a self-built multi-method auth stack
 * (password, passkey, face, TOTP) that the platform must not fork. A Supabase or OIDC adapter is a
 * drop-in for this interface if that ever changes, which is the whole point of it having one.
 */
export interface AuthenticationProvider {
  info(): ProviderInfo;
  /** Null means "not authenticated" — never a partly-filled Principal. */
  authenticate(ctx: AuthContext): Promise<Principal | null>;
  /** Capability check. Kept on the provider so a future policy engine can replace the whole thing. */
  authorize(principal: Principal | null, permission: string): boolean;
}

// ---------------------------------------------------------------------------
// 8. AnalyticsProvider — aggregates
// ---------------------------------------------------------------------------

export interface MetricQuery {
  orgId: UUID;
  metric: string;
  since?: string;
  until?: string;
  groupBy?: 'day' | 'hour' | 'campaign' | 'domain' | 'event_type';
  filters?: Record<string, string | number | boolean>;
}

export interface MetricSeries {
  metric: string;
  points: { key: string; value: number }[];
  total: number;
}

/**
 * Aggregate reads.
 *
 * Postgres today, over the same append-only mp_events table the EventBus writes. A ClickHouse
 * adapter reads the identical event shape, so the migration is an ingest pipeline, not a remodel.
 */
export interface AnalyticsProvider {
  info(): ProviderInfo;
  query(q: MetricQuery): Promise<OperationResult<MetricSeries>>;
}

// ---------------------------------------------------------------------------
// 9. DomainProvider — DNS truth
// ---------------------------------------------------------------------------

export interface DnsLookupResult {
  ok: boolean;
  records: string[];
  error?: string;
}

/**
 * DNS observation and (optionally) automation.
 *
 * `lookup*` is required and read-only — it is how domain verification learns what is actually
 * published. `applyRecord` is OPTIONAL and returns `code: 'unsupported'` on the manual adapter,
 * because most registrars are configured by a human; a provider-API adapter (registrar or DNS host)
 * can implement it later without changing verification.
 */
export interface DomainProvider {
  info(): ProviderInfo;
  lookupTxt(host: string): Promise<DnsLookupResult>;
  lookupMx(host: string): Promise<DnsLookupResult>;
  lookupCname(host: string): Promise<DnsLookupResult>;
  /** The records a domain must publish. Pure — no network, so it is testable and previewable. */
  requiredRecords(domain: Domain, dkim?: DkimKey | null, opts?: { mxHost?: string; spfInclude?: string }): DnsRecord[];
  verify(domain: Domain, checks?: DnsCheckType[]): Promise<{ checkType: DnsCheckType; status: 'pass' | 'fail'; expected: string | null; observed: string | null; detail: string }[]>;
  applyRecord?(domainName: string, record: DnsRecord): Promise<OperationResult>;
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

/** Everything the platform is wired to, resolved once. See ./providers.ts. */
export interface PlatformProviders {
  transport: MailTransport;
  inbound: InboundMailTransport;
  messages: MessageStore;
  attachments: AttachmentStore;
  queue: QueueProvider;
  events: EventBus;
  auth: AuthenticationProvider;
  analytics: AnalyticsProvider;
  dns: DomainProvider;
}

/** Re-exported so an adapter file imports one module. */
export type { Contact, DeliveryEvent, Mailbox, Message, Page, Principal, UUID };
