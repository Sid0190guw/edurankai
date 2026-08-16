// src/lib/mailplatform/types.ts — the shared domain model for EduRankAI Mail.
//
// THIS FILE IS A CONTRACT, NOT AN IMPLEMENTATION. Three other agents (SMTP/MTA, webmail UI,
// DevOps) build against these shapes; changing a field here changes their code, so additions are
// cheap and renames are not. Nothing in this file imports a database, a transport or a framework —
// it is pure types, so any layer may depend on it without pulling a connection in behind it.
//
// Naming: every persisted table for this subsystem is prefixed `mp_`. That is not decoration. This
// repository already owns `roles`, `sessions`, `api_keys`, `events`, `users`, `workflow_instances`
// and ~50 `hr_*` tables; an unprefixed `workflows` or `roles` here would have collided with a live
// HR system on the first migration. The prefix is asserted by a test.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A v4 UUID string. Aliased so signatures say what they mean. */
export type UUID = string;

/** An RFC 5322 message identifier, angle brackets included: `<abc@edurankai.in>`. */
export type RfcMessageId = string;

export type ISODateString = string;

/** Every list endpoint returns this shape. Cursor is opaque; callers must not parse it. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Total is OPTIONAL and often absent: an exact count over millions of rows is a table scan. */
  total?: number;
}

export interface PageRequest {
  limit?: number;
  cursor?: string | null;
}

// ---------------------------------------------------------------------------
// Identity and tenancy
// ---------------------------------------------------------------------------

export type OrganizationStatus = 'active' | 'suspended' | 'closed';

export interface Organization {
  id: UUID;
  slug: string;
  name: string;
  status: OrganizationStatus;
  /** Free-form per-tenant configuration. Never put secrets here — see DomainSettings/DkimKey. */
  settings: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

/**
 * Membership roles for the MAIL PLATFORM only.
 *
 * These are deliberately NOT the repository's `users.role` values. That column drives the whole
 * EduRankAI admin console (src/lib/auth/permissions.ts, ~1400 lines of it) and a mail platform has
 * no business widening it. A user's platform role is resolved from mp_organization_members; an
 * EduRankAI admin is mapped onto the default organization at bootstrap instead of being copied.
 */
export type OrgMemberRole = 'owner' | 'admin' | 'member' | 'analyst' | 'service';

export interface OrganizationMember {
  id: UUID;
  orgId: UUID;
  userId: UUID;
  role: OrgMemberRole;
  invitedBy: UUID | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

/** Capability keys for the mail platform. Checked by `can()` in ./permissions.ts. */
export type MailPermission =
  | 'mail.read'
  | 'mail.send'
  | 'mail.manage'
  | 'mailbox.manage'
  | 'contacts.read'
  | 'contacts.write'
  | 'campaigns.read'
  | 'campaigns.write'
  | 'campaigns.send'
  | 'templates.read'
  | 'templates.write'
  | 'domains.read'
  | 'domains.manage'
  | 'automation.read'
  | 'automation.write'
  | 'events.read'
  | 'webhooks.manage'
  | 'org.manage';

/** Who is making a request. Produced by AuthenticationProvider, consumed by every /api/v1 route. */
export interface Principal {
  kind: 'user' | 'api_key' | 'service';
  /** users.id for a session, api_keys.id for a key. */
  id: UUID;
  orgId: UUID;
  role: OrgMemberRole;
  /** Resolved capability set. Empty means "authenticated but may do nothing". */
  permissions: MailPermission[];
  /** Present for `kind === 'user'`; the signed-in account's address. */
  email?: string;
  label?: string | null;
}

export interface AuditEntry {
  id: UUID;
  orgId: UUID;
  actorUserId: UUID | null;
  actorApiKeyId: UUID | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Mailboxes and addresses
// ---------------------------------------------------------------------------

export type MailboxKind = 'user' | 'shared' | 'group' | 'system';

export interface Mailbox {
  id: UUID;
  orgId: UUID;
  kind: MailboxKind;
  /** Null for shared/system mailboxes — those are reached through membership, not ownership. */
  ownerUserId: UUID | null;
  name: string;
  primaryAddress: string;
  quotaBytes: number | null;
  usedBytes: number;
  isActive: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface EmailAddress {
  id: UUID;
  orgId: UUID;
  mailboxId: UUID | null;
  domainId: UUID | null;
  address: string;
  isPrimary: boolean;
  purpose: 'mailbox' | 'sending' | 'bounce' | 'alias';
  verifiedAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface Alias {
  id: UUID;
  orgId: UUID;
  sourceAddress: string;
  destinationAddress: string;
  mailboxId: UUID | null;
  isActive: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

/** System folders are fixed; a user folder is anything else. `key` is stable, `name` is display. */
export type FolderKind = 'system' | 'user';
export const SYSTEM_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];

export interface Folder {
  id: UUID;
  orgId: UUID;
  mailboxId: UUID;
  key: string;
  name: string;
  kind: FolderKind;
  parentId: UUID | null;
  sortOrder: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface Label {
  id: UUID;
  orgId: UUID;
  mailboxId: UUID | null;
  name: string;
  color: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface Thread {
  id: UUID;
  orgId: UUID;
  mailboxId: UUID | null;
  subjectNormalized: string;
  lastMessageAt: ISODateString | null;
  messageCount: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type RecipientKind = 'to' | 'cc' | 'bcc';
export type MessageDirection = 'inbound' | 'outbound' | 'internal';

export interface Address {
  email: string;
  name?: string | null;
}

export interface Recipient extends Address {
  kind: RecipientKind;
  /** Set when the address resolves to a local account; null for external addresses. */
  userId?: UUID | null;
}

/**
 * The attachment record.
 *
 * `storageKey` + `storageBackend` are the object-storage coordinates; `url` is what a client
 * renders. A binary body is NEVER a column — see AttachmentStore in ./interfaces.ts. `url` may be a
 * link supplied by the composer (this product's attachment policy is links, not uploads) or a URL
 * returned by the object store for an inbound MIME part.
 */
export interface Attachment {
  id: UUID;
  messageId: UUID;
  filename: string;
  url: string;
  mime: string | null;
  sizeBytes: number | null;
  storageKey?: string | null;
  storageBackend?: string | null;
  contentId?: string | null;
  isInline?: boolean;
}

export interface MessageHeader {
  name: string;
  value: string;
  ordinal: number;
}

export type SpamVerdict = 'unknown' | 'ham' | 'spam' | 'quarantine';

/**
 * A message as the platform stores it.
 *
 * Bodies are inline TEXT columns rather than a separate `message_bodies` table, because the
 * existing `mail_messages` table in this repository already stores them that way and a live
 * webmail client reads it. Splitting them would have been a rewrite of working code for no measured
 * gain; the RFC-complete original stays reachable through `rawObjectKey`, which points at the full
 * MIME source in object storage. Recorded in /docs/DATABASE.md under "Deviations from the brief".
 */
export interface Message {
  id: UUID;
  orgId: UUID | null;
  threadId: UUID;
  mailboxId: UUID | null;
  direction: MessageDirection;

  rfcMessageId: RfcMessageId | null;
  inReplyTo: RfcMessageId | null;
  /** Space-separated RFC 5322 References chain, oldest first. */
  references: string | null;
  replyTo: string | null;

  subject: string;
  from: Address;
  recipients: Recipient[];

  bodyHtml: string | null;
  bodyText: string | null;
  snippet: string;

  headers?: MessageHeader[];
  attachments?: Attachment[];
  hasAttachments: boolean;

  /** Full MIME source in object storage. Null when the message was composed here. */
  rawObjectKey: string | null;
  sizeBytes: number | null;

  spamVerdict: SpamVerdict;
  spamScore: number | null;

  isDraft: boolean;
  sentAt: ISODateString | null;
  receivedAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString | null;
  deletedAt: ISODateString | null;
}

/** Per-mailbox state. One message has ONE body and N of these — one per mailbox that holds it. */
export interface MailboxMessageState {
  mailboxId: UUID | null;
  userId: UUID;
  messageId: UUID;
  threadId: UUID;
  folder: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
  snoozedUntil: ISODateString | null;
}

/** What a caller hands the send service. Exactly one of `bodyHtml`/`bodyText` or `template`. */
export interface SendRequest {
  orgId?: UUID;
  from?: string;
  fromName?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  /** Template key, resolved against mp_templates for this org. */
  template?: string;
  variables?: Record<string, unknown>;
  attachments?: { filename: string; url: string; mime?: string; size?: number }[];
  threadId?: UUID | null;
  inReplyTo?: RfcMessageId | null;
  headers?: Record<string, string>;
  /** Opaque caller data, echoed on every delivery event for this message. */
  metadata?: Record<string, unknown>;
  scheduledAt?: ISODateString | null;
  campaignId?: UUID | null;
  /** Skip the suppression list. Requires `mail.manage`; refused for campaign sends, always. */
  ignoreSuppression?: boolean;
}

export interface SendResult {
  ok: boolean;
  messageId: UUID | null;
  threadId: UUID | null;
  rfcMessageId: RfcMessageId | null;
  /** Recipients accepted for delivery, internal and external. */
  accepted: string[];
  /** Recipients refused before any transport was contacted, with the reason. */
  rejected: { address: string; reason: string }[];
  /** Recipients dropped because they are on the suppression list. */
  suppressed: { address: string; reason: string }[];
  status: DeliveryState;
  error?: string;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryState =
  | 'queued'
  | 'internal'
  | 'sent'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'failed'
  | 'partial'
  | 'suppressed'
  | 'no_transport'
  | 'unknown';

export type DeliveryEventType =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'unsubscribed'
  | 'failed'
  | 'suppressed';

export interface DeliveryAttempt {
  id: UUID;
  orgId: UUID;
  messageId: UUID;
  recipientAddress: string;
  transport: string;
  attemptNo: number;
  status: 'sent' | 'deferred' | 'failed';
  smtpCode: number | null;
  smtpResponse: string | null;
  remoteMx: string | null;
  latencyMs: number | null;
  error: string | null;
  startedAt: ISODateString;
  finishedAt: ISODateString | null;
}

export interface DeliveryEvent {
  id: string;
  orgId: UUID;
  messageId: UUID | null;
  campaignId: UUID | null;
  contactId: UUID | null;
  recipientAddress: string;
  eventType: DeliveryEventType;
  providerEventId: string | null;
  meta: Record<string, unknown>;
  occurredAt: ISODateString;
}

export type BounceType = 'hard' | 'soft' | 'block' | 'auto_reply' | 'unknown';

export interface BounceEvent {
  id: UUID;
  orgId: UUID;
  messageId: UUID | null;
  recipientAddress: string;
  bounceType: BounceType;
  smtpCode: number | null;
  diagnosticCode: string | null;
  reportedBy: string | null;
  occurredAt: ISODateString;
}

export type SuppressionReason =
  | 'hard_bounce'
  | 'repeated_soft_bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'manual'
  | 'invalid_address';

export interface SuppressionEntry {
  id: UUID;
  orgId: UUID;
  address: string;
  scope: 'org' | 'domain' | 'campaign';
  scopeRef: string | null;
  reason: SuppressionReason;
  source: string | null;
  expiresAt: ISODateString | null;
  createdAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export type DomainStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'disabled';
export type DomainPurpose = 'sending' | 'receiving' | 'both';

export interface Domain {
  id: UUID;
  orgId: UUID;
  domain: string;
  status: DomainStatus;
  purpose: DomainPurpose;
  verificationToken: string;
  verifiedAt: ISODateString | null;
  dkimSelector: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export type DnsCheckType = 'ownership' | 'spf' | 'dkim' | 'dmarc' | 'mx';

export interface DomainVerification {
  id: UUID;
  orgId: UUID;
  domainId: UUID;
  checkType: DnsCheckType;
  status: 'pass' | 'fail' | 'pending';
  expected: string | null;
  observed: string | null;
  detail: string | null;
  checkedAt: ISODateString;
}

export interface DnsRecord {
  id?: UUID;
  orgId?: UUID;
  domainId?: UUID;
  recordType: 'TXT' | 'MX' | 'CNAME' | 'A';
  host: string;
  value: string;
  ttl: number;
  priority: number | null;
  purpose: DnsCheckType;
  isRequired: boolean;
}

export interface DkimKey {
  id: UUID;
  orgId: UUID;
  domainId: UUID;
  selector: string;
  algorithm: 'rsa-sha256' | 'ed25519-sha256';
  keySize: number | null;
  publicKey: string;
  /**
   * NEVER the private key itself. A reference the MTA resolves out of a secret store (env var
   * name, KMS id, mounted file path). See /docs/INTEGRATION-CONTRACTS.md.
   */
  privateKeyRef: string | null;
  status: 'pending' | 'active' | 'rotating' | 'retired';
  activatedAt: ISODateString | null;
  retiredAt: ISODateString | null;
}

export interface DomainSettings {
  domainId: UUID;
  orgId: UUID;
  trackingDomain: string | null;
  openTracking: boolean;
  clickTracking: boolean;
  dmarcPolicy: 'none' | 'quarantine' | 'reject' | null;
  customReturnPath: string | null;
  bounceAddress: string | null;
  maxSendRatePerHour: number | null;
}

export interface SendingIdentity {
  id: UUID;
  orgId: UUID;
  domainId: UUID | null;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  isDefault: boolean;
  isVerified: boolean;
  verifiedAt: ISODateString | null;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'pending';

export interface Contact {
  id: UUID;
  orgId: UUID;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  phone: string | null;
  company: string | null;
  locale: string | null;
  timezone: string | null;
  status: ContactStatus;
  source: string | null;
  /** Values for org-defined mp_custom_fields, keyed by field key. */
  attributes: Record<string, unknown>;
  lastEngagedAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface ContactList {
  id: UUID;
  orgId: UUID;
  name: string;
  slug: string;
  description: string | null;
  memberCount?: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface ContactListMember {
  id: UUID;
  orgId: UUID;
  listId: UUID;
  contactId: UUID;
  status: 'subscribed' | 'unsubscribed' | 'pending';
  subscribedAt: ISODateString | null;
  unsubscribedAt: ISODateString | null;
}

export interface ContactTag {
  id: UUID;
  orgId: UUID;
  name: string;
  color: string | null;
}

export type CustomFieldType = 'text' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect' | 'url';

export interface CustomField {
  id: UUID;
  orgId: UUID;
  entity: 'contact';
  key: string;
  label: string;
  dataType: CustomFieldType;
  options: string[] | null;
  isRequired: boolean;
}

export interface ContactEvent {
  id: string;
  orgId: UUID;
  contactId: UUID;
  eventType: string;
  source: string | null;
  messageId: UUID | null;
  campaignId: UUID | null;
  meta: Record<string, unknown>;
  occurredAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Templates and campaigns
// ---------------------------------------------------------------------------

export type TemplateCategory = 'transactional' | 'marketing' | 'system';

export interface Template {
  id: UUID;
  orgId: UUID;
  key: string;
  name: string;
  description: string | null;
  category: TemplateCategory;
  currentVersionId: UUID | null;
  isActive: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface TemplateVersion {
  id: UUID;
  orgId: UUID;
  templateId: UUID;
  version: number;
  subject: string;
  htmlBody: string;
  textBody: string | null;
  /** Declared variables. Used to validate a send before it reaches a transport. */
  variables: string[];
  createdBy: UUID | null;
  publishedAt: ISODateString | null;
  createdAt: ISODateString;
}

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'paused'
  | 'sent'
  | 'cancelled'
  | 'failed';

export interface Campaign {
  id: UUID;
  orgId: UUID;
  name: string;
  slug: string;
  type: 'broadcast' | 'automated' | 'ab_test';
  status: CampaignStatus;
  templateId: UUID | null;
  sendingIdentityId: UUID | null;
  subject: string | null;
  preheader: string | null;
  listId: UUID | null;
  segment: Record<string, unknown> | null;
  scheduledAt: ISODateString | null;
  startedAt: ISODateString | null;
  finishedAt: ISODateString | null;
  stats: CampaignStats;
  createdBy: UUID | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface CampaignStats {
  recipients: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
}

export interface CampaignRecipient {
  id: UUID;
  orgId: UUID;
  campaignId: UUID;
  contactId: UUID | null;
  address: string;
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped' | 'suppressed';
  messageId: UUID | null;
  personalization: Record<string, unknown>;
  queuedAt: ISODateString | null;
  sentAt: ISODateString | null;
  failedReason: string | null;
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type WorkflowNodeType =
  | 'trigger'
  | 'send_email'
  | 'delay'
  | 'condition'
  | 'tag'
  | 'webhook'
  | 'exit';

export interface Workflow {
  id: UUID;
  orgId: UUID;
  name: string;
  slug: string;
  status: WorkflowStatus;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  createdBy: UUID | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface WorkflowNode {
  id: UUID;
  orgId: UUID;
  workflowId: UUID;
  key: string;
  nodeType: WorkflowNodeType;
  config: Record<string, unknown>;
  position: { x: number; y: number } | null;
}

export interface WorkflowEdge {
  id: UUID;
  orgId: UUID;
  workflowId: UUID;
  fromNodeId: UUID;
  toNodeId: UUID;
  branch: string | null;
  condition: Record<string, unknown> | null;
}

export interface WorkflowRun {
  id: UUID;
  orgId: UUID;
  workflowId: UUID;
  contactId: UUID | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  currentNodeId: UUID | null;
  context: Record<string, unknown>;
  startedAt: ISODateString;
  finishedAt: ISODateString | null;
  nextRunAt: ISODateString | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Platform events and webhooks
// ---------------------------------------------------------------------------

/**
 * The canonical platform event.
 *
 * Append-only, one row per fact, wide `payload` jsonb, ordered by `occurred_at`. That shape is
 * deliberate: it is what a column store (ClickHouse) ingests without remodelling, so the analytics
 * migration named in the brief becomes a copy rather than a redesign.
 */
export interface PlatformEvent {
  id: string;
  orgId: UUID;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  actorType: 'user' | 'api_key' | 'system' | null;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: ISODateString;
}

export interface WebhookEndpoint {
  id: UUID;
  orgId: UUID;
  url: string;
  description: string | null;
  eventTypes: string[];
  /** Returned ONCE at creation. Never re-read through the API. */
  secret?: string;
  isActive: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
}

export interface WebhookDelivery {
  id: UUID;
  orgId: UUID;
  endpointId: UUID;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseCode: number | null;
  nextAttemptAt: ISODateString | null;
  deliveredAt: ISODateString | null;
}
