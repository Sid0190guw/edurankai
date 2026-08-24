// src/lib/mailplatform/schema.ts — the authoritative database definition for EduRankAI Mail.
//
// ONE SOURCE, THREE CONSUMERS. The statements below are (1) applied by ensureMailPlatformSchema()
// in dev and test, (2) written out verbatim to db/mail-platform-schema.sql for the operator to run
// against production by hand, and (3) asserted over by mailplatform-schema.test.ts. A schema that
// lives in two places diverges; this one cannot.
//
// WHY A MIGRATION FILE AND NOT `drizzle-kit push`. CLAUDE.md forbids this agent from opening a
// database connection at all, and the established practice in this repository is that migrations
// are handed to the operator to run. Nothing here connects on import.
//
// WHY EVERY TABLE IS `mp_`-PREFIXED. This database already has ~539 tables including `roles`,
// `sessions`, `api_keys`, `events`, `users`, `workflow_instances` and ~75 `hr_*` tables. The brief
// asked for tables called `roles`, `workflows`, `events` and `templates`. Creating those names here
// would have collided with a live HR system and a live permissions registry on the first migration.
// The prefix is not a preference — it is the difference between a migration that applies and one
// that takes the admin console down. A test asserts no statement creates an unprefixed table.
//
// WHAT THIS DOES *NOT* CREATE. The message bodies, mailbox copies and attachments already exist as
// mail_messages / mail_box / mail_attachments (src/lib/mail.ts) and are read by a live webmail
// client. They are EXTENDED with additive `ADD COLUMN IF NOT EXISTS` here, never replaced. The same
// goes for `api_keys`, which gains org scoping instead of being duplicated as `mp_api_keys`.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ddlPermitted } from '@/lib/schema-bootstrap';

/** Bumped whenever MP_DDL changes. Stored in mp_schema_migrations so a cold start can skip work. */
export const SCHEMA_VERSION = 2;

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

// ---------------------------------------------------------------------------
// Additive extensions to tables this repository already owns.
// ---------------------------------------------------------------------------
//
// Kept separate from MP_DDL so it is obvious at a glance which statements touch existing, live
// tables. Every one is `IF NOT EXISTS` and none drops, renames or retypes anything.

export const MP_EXTENSIONS: string[] = [
  // --- mail_messages: the RFC fields and platform links the brief requires that it lacked ---
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS org_id UUID`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS mailbox_id UUID`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS references_header TEXT`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS reply_to VARCHAR(320)`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS spam_score NUMERIC(6,3)`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS spam_verdict VARCHAR(16) NOT NULL DEFAULT 'unknown'`,
  // Full MIME source lives in object storage; Postgres holds the pointer. Never the bytes.
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS raw_object_key TEXT`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS raw_storage_backend VARCHAR(32)`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS size_bytes BIGINT`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS campaign_id UUID`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS mail_msg_org_created_idx ON mail_messages(org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mail_msg_campaign_idx ON mail_messages(campaign_id) WHERE campaign_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS mail_msg_from_email_idx ON mail_messages(lower(from_email))`,
  // Search over what a user actually types into a mailbox search box.
  `CREATE INDEX IF NOT EXISTS mail_msg_search_idx ON mail_messages
     USING gin(to_tsvector('simple', coalesce(subject,'') || ' ' || coalesce(snippet,'')))`,

  // --- mail_attachments: object-storage coordinates + inline (cid:) parts ---
  `ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS storage_key TEXT`,
  `ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32)`,
  `ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS content_id VARCHAR(255)`,
  `ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS is_inline BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  // --- mail_box: link a mailbox copy to a platform mailbox row ---
  `ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS mailbox_id UUID`,
  `ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS org_id UUID`,
  `ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS mail_box_mailbox_idx ON mail_box(mailbox_id, folder, created_at DESC)`,

  // --- mailapi_messages: the link that makes the two API layers one mailbox ---
  // The developer API (src/lib/mailapi/) kept its own message store. Rather than fork the mailbox,
  // its rows now point at the shared message they represent: mailapi_messages remains the SEND JOB
  // (environment, idempotency key, attempts, backoff) and mail_messages holds the MESSAGE. If this
  // deployment has no developer API tables the statement fails harmlessly and is logged — the
  // extension loop tolerates that per statement, which is why these live here and not in MP_DDL.
  `ALTER TABLE mailapi_messages ADD COLUMN IF NOT EXISTS platform_message_id UUID`,
  `CREATE INDEX IF NOT EXISTS mailapi_msg_platform_idx ON mailapi_messages(platform_message_id) WHERE platform_message_id IS NOT NULL`,

  // --- api_keys: org scoping + scopes, rather than a second key table nobody would look in ---
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS org_id UUID`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(org_id) WHERE org_id IS NOT NULL`,
];

// ---------------------------------------------------------------------------
// The mail platform's own tables.
// ---------------------------------------------------------------------------

export const MP_DDL: string[] = [
  // === bookkeeping =========================================================
  `CREATE TABLE IF NOT EXISTS mp_schema_migrations (
     version INT PRIMARY KEY,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     note TEXT
   )`,

  // === identity and tenancy ================================================
  `CREATE TABLE IF NOT EXISTS mp_organizations (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     slug VARCHAR(80) NOT NULL,
     name VARCHAR(200) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     settings JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_org_status_chk CHECK (status IN ('active','suspended','closed'))
   )`,
  // Partial unique: a closed org's slug is freed for reuse, a live one is not.
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_org_slug_uk ON mp_organizations(lower(slug)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_organization_members (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role VARCHAR(16) NOT NULL DEFAULT 'member',
     invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_member_role_chk CHECK (role IN ('owner','admin','member','analyst','service'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_member_org_user_uk ON mp_organization_members(org_id, user_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_member_user_idx ON mp_organization_members(user_id) WHERE deleted_at IS NULL`,

  // Per-org role definitions. The built-in five above are code; this is for org-defined roles.
  `CREATE TABLE IF NOT EXISTS mp_roles (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
     key VARCHAR(64) NOT NULL,
     label VARCHAR(120) NOT NULL,
     description TEXT,
     is_system BOOLEAN NOT NULL DEFAULT false,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_roles_org_key_uk ON mp_roles(coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(key)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_role_permissions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     role_id UUID NOT NULL REFERENCES mp_roles(id) ON DELETE CASCADE,
     permission_key VARCHAR(64) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(role_id, permission_key)
   )`,

  `CREATE TABLE IF NOT EXISTS mp_audit_logs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
     actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     actor_api_key_id UUID,
     action VARCHAR(80) NOT NULL,
     target_type VARCHAR(60),
     target_id VARCHAR(120),
     meta JSONB NOT NULL DEFAULT '{}'::jsonb,
     ip_address VARCHAR(64),
     user_agent TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS mp_audit_org_time_idx ON mp_audit_logs(org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_audit_target_idx ON mp_audit_logs(target_type, target_id)`,

  // === mailboxes and addresses ============================================
  `CREATE TABLE IF NOT EXISTS mp_mailboxes (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     kind VARCHAR(12) NOT NULL DEFAULT 'user',
     owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     name VARCHAR(200) NOT NULL,
     primary_address VARCHAR(320) NOT NULL,
     quota_bytes BIGINT,
     used_bytes BIGINT NOT NULL DEFAULT 0,
     is_active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_mailbox_kind_chk CHECK (kind IN ('user','shared','group','system'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_mailbox_addr_uk ON mp_mailboxes(lower(primary_address)) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_mailbox_org_idx ON mp_mailboxes(org_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_mailbox_owner_idx ON mp_mailboxes(owner_user_id) WHERE deleted_at IS NULL`,

  // Membership of a shared mailbox. A user mailbox needs no row here; ownership covers it.
  `CREATE TABLE IF NOT EXISTS mp_mailbox_members (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     mailbox_id UUID NOT NULL REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     access VARCHAR(12) NOT NULL DEFAULT 'read',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_mailbox_access_chk CHECK (access IN ('read','send','manage'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_mailbox_member_uk ON mp_mailbox_members(mailbox_id, user_id) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_email_addresses (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     mailbox_id UUID REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
     domain_id UUID,
     address VARCHAR(320) NOT NULL,
     is_primary BOOLEAN NOT NULL DEFAULT false,
     purpose VARCHAR(12) NOT NULL DEFAULT 'mailbox',
     verified_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_address_purpose_chk CHECK (purpose IN ('mailbox','sending','bounce','alias'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_address_uk ON mp_email_addresses(lower(address)) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_address_mailbox_idx ON mp_email_addresses(mailbox_id) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_aliases (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     source_address VARCHAR(320) NOT NULL,
     destination_address VARCHAR(320) NOT NULL,
     mailbox_id UUID REFERENCES mp_mailboxes(id) ON DELETE SET NULL,
     is_active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_alias_not_self_chk CHECK (lower(source_address) <> lower(destination_address))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_alias_source_uk ON mp_aliases(lower(source_address)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_folders (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     mailbox_id UUID NOT NULL REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
     key VARCHAR(64) NOT NULL,
     name VARCHAR(120) NOT NULL,
     kind VARCHAR(8) NOT NULL DEFAULT 'user',
     parent_id UUID REFERENCES mp_folders(id) ON DELETE CASCADE,
     sort_order INT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_folder_kind_chk CHECK (kind IN ('system','user'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_folder_key_uk ON mp_folders(mailbox_id, lower(key)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_labels (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     mailbox_id UUID REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
     name VARCHAR(120) NOT NULL,
     color VARCHAR(16),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_label_uk ON mp_labels(coalesce(mailbox_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE deleted_at IS NULL`,

  // No FK to mail_messages: that table predates this subsystem and is written by code this patch
  // does not own. Referential integrity is enforced on delete by the message store instead.
  `CREATE TABLE IF NOT EXISTS mp_message_labels (
     message_id UUID NOT NULL,
     label_id UUID NOT NULL REFERENCES mp_labels(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (message_id, label_id)
   )`,
  `CREATE INDEX IF NOT EXISTS mp_message_labels_label_idx ON mp_message_labels(label_id)`,

  // The thread aggregate. mail_messages.thread_id has always been a bare uuid pointing at nothing;
  // this gives it a home without changing a single existing insert.
  `CREATE TABLE IF NOT EXISTS mp_threads (
     id UUID PRIMARY KEY,
     org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
     mailbox_id UUID REFERENCES mp_mailboxes(id) ON DELETE SET NULL,
     subject_normalized VARCHAR(500) NOT NULL DEFAULT '',
     last_message_at TIMESTAMPTZ,
     message_count INT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS mp_threads_org_recent_idx ON mp_threads(org_id, last_message_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_threads_subject_idx ON mp_threads(lower(subject_normalized))`,

  // Full RFC header capture for inbound mail. The MTA agent writes these; the UI rarely reads them.
  `CREATE TABLE IF NOT EXISTS mp_message_headers (
     id BIGSERIAL PRIMARY KEY,
     message_id UUID NOT NULL,
     name VARCHAR(120) NOT NULL,
     value TEXT NOT NULL,
     ordinal INT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS mp_headers_msg_idx ON mp_message_headers(message_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS mp_headers_name_idx ON mp_message_headers(lower(name))`,

  // === domains =============================================================
  `CREATE TABLE IF NOT EXISTS mp_domains (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     domain VARCHAR(253) NOT NULL,
     status VARCHAR(12) NOT NULL DEFAULT 'pending',
     purpose VARCHAR(12) NOT NULL DEFAULT 'both',
     verification_token VARCHAR(64) NOT NULL,
     verified_at TIMESTAMPTZ,
     dkim_selector VARCHAR(63),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_domain_status_chk CHECK (status IN ('pending','verifying','verified','failed','disabled')),
     CONSTRAINT mp_domain_purpose_chk CHECK (purpose IN ('sending','receiving','both'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_domain_uk ON mp_domains(org_id, lower(domain)) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_domain_name_idx ON mp_domains(lower(domain)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_domain_verifications (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     domain_id UUID NOT NULL REFERENCES mp_domains(id) ON DELETE CASCADE,
     check_type VARCHAR(12) NOT NULL,
     status VARCHAR(8) NOT NULL DEFAULT 'pending',
     expected TEXT,
     observed TEXT,
     detail TEXT,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_dv_type_chk CHECK (check_type IN ('ownership','spf','dkim','dmarc','mx')),
     CONSTRAINT mp_dv_status_chk CHECK (status IN ('pass','fail','pending'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_dv_domain_idx ON mp_domain_verifications(domain_id, checked_at DESC)`,

  `CREATE TABLE IF NOT EXISTS mp_dns_records (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     domain_id UUID NOT NULL REFERENCES mp_domains(id) ON DELETE CASCADE,
     record_type VARCHAR(8) NOT NULL,
     host VARCHAR(253) NOT NULL,
     value TEXT NOT NULL,
     ttl INT NOT NULL DEFAULT 3600,
     priority INT,
     purpose VARCHAR(12) NOT NULL,
     is_required BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_dns_type_chk CHECK (record_type IN ('TXT','MX','CNAME','A'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_dns_domain_idx ON mp_dns_records(domain_id)`,

  // The private key is NOT here. private_key_ref names where the MTA finds it (env var, KMS id,
  // mounted path). A signing key in a queryable column is one SQL injection away from a forged
  // domain, and the whole point of DKIM is that only the sender can produce the signature.
  `CREATE TABLE IF NOT EXISTS mp_dkim_keys (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     domain_id UUID NOT NULL REFERENCES mp_domains(id) ON DELETE CASCADE,
     selector VARCHAR(63) NOT NULL,
     algorithm VARCHAR(20) NOT NULL DEFAULT 'rsa-sha256',
     key_size INT,
     public_key TEXT NOT NULL,
     private_key_ref TEXT,
     status VARCHAR(10) NOT NULL DEFAULT 'pending',
     activated_at TIMESTAMPTZ,
     retired_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(domain_id, selector),
     CONSTRAINT mp_dkim_status_chk CHECK (status IN ('pending','active','rotating','retired'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_dkim_active_idx ON mp_dkim_keys(domain_id) WHERE status = 'active'`,

  `CREATE TABLE IF NOT EXISTS mp_domain_settings (
     domain_id UUID PRIMARY KEY REFERENCES mp_domains(id) ON DELETE CASCADE,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     tracking_domain VARCHAR(253),
     open_tracking BOOLEAN NOT NULL DEFAULT false,
     click_tracking BOOLEAN NOT NULL DEFAULT false,
     dmarc_policy VARCHAR(12),
     custom_return_path VARCHAR(320),
     bounce_address VARCHAR(320),
     max_send_rate_per_hour INT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_dmarc_chk CHECK (dmarc_policy IS NULL OR dmarc_policy IN ('none','quarantine','reject'))
   )`,

  // mp_domains is the OWNERSHIP record; this is the SENDING AUTHORISATION for it. Separate because
  // a domain can be verified for receiving and still be barred from sending — which is exactly the
  // state a newly warmed domain should be in.
  `CREATE TABLE IF NOT EXISTS mp_sending_domains (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     domain_id UUID NOT NULL REFERENCES mp_domains(id) ON DELETE CASCADE,
     pool VARCHAR(60) NOT NULL DEFAULT 'default',
     is_enabled BOOLEAN NOT NULL DEFAULT false,
     daily_quota INT,
     sent_today INT NOT NULL DEFAULT 0,
     quota_reset_at TIMESTAMPTZ,
     reputation_score NUMERIC(5,2),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     UNIQUE(domain_id, pool)
   )`,

  `CREATE TABLE IF NOT EXISTS mp_sending_identities (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     domain_id UUID REFERENCES mp_domains(id) ON DELETE SET NULL,
     from_address VARCHAR(320) NOT NULL,
     from_name VARCHAR(200),
     reply_to VARCHAR(320),
     is_default BOOLEAN NOT NULL DEFAULT false,
     is_verified BOOLEAN NOT NULL DEFAULT false,
     verified_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_identity_uk ON mp_sending_identities(org_id, lower(from_address)) WHERE deleted_at IS NULL`,
  // Exactly one default per org, enforced by the database rather than by hope.
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_identity_default_uk ON mp_sending_identities(org_id) WHERE is_default AND deleted_at IS NULL`,

  // === delivery ============================================================
  `CREATE TABLE IF NOT EXISTS mp_delivery_attempts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     message_id UUID NOT NULL,
     recipient_address VARCHAR(320) NOT NULL,
     transport VARCHAR(40) NOT NULL,
     attempt_no INT NOT NULL DEFAULT 1,
     status VARCHAR(10) NOT NULL,
     smtp_code INT,
     smtp_response TEXT,
     remote_mx VARCHAR(253),
     latency_ms INT,
     error TEXT,
     started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     finished_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_attempt_status_chk CHECK (status IN ('sent','deferred','failed'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_attempt_msg_idx ON mp_delivery_attempts(message_id, attempt_no)`,
  `CREATE INDEX IF NOT EXISTS mp_attempt_org_time_idx ON mp_delivery_attempts(org_id, created_at DESC)`,

  // Append-only. One row per fact. Never updated — the current state lives in mp_delivery_status.
  `CREATE TABLE IF NOT EXISTS mp_delivery_events (
     id BIGSERIAL PRIMARY KEY,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     message_id UUID,
     campaign_id UUID,
     contact_id UUID,
     recipient_address VARCHAR(320) NOT NULL,
     event_type VARCHAR(16) NOT NULL,
     provider_event_id VARCHAR(200),
     meta JSONB NOT NULL DEFAULT '{}'::jsonb,
     occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_devent_type_chk CHECK (event_type IN
       ('queued','sent','delivered','deferred','bounced','complained','opened','clicked','unsubscribed','failed','suppressed'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_devent_msg_idx ON mp_delivery_events(message_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_devent_org_time_idx ON mp_delivery_events(org_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_devent_campaign_idx ON mp_delivery_events(campaign_id, event_type) WHERE campaign_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS mp_devent_recipient_idx ON mp_delivery_events(lower(recipient_address), occurred_at DESC)`,
  // A provider that redelivers a webhook must not double-count an open.
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_devent_provider_uk ON mp_delivery_events(provider_event_id) WHERE provider_event_id IS NOT NULL`,

  // The materialised "where is this recipient now". One row per (message, recipient).
  `CREATE TABLE IF NOT EXISTS mp_delivery_status (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     message_id UUID NOT NULL,
     recipient_address VARCHAR(320) NOT NULL,
     status VARCHAR(14) NOT NULL DEFAULT 'queued',
     attempts INT NOT NULL DEFAULT 0,
     bounce_type VARCHAR(12),
     last_event_at TIMESTAMPTZ,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(message_id, recipient_address)
   )`,
  `CREATE INDEX IF NOT EXISTS mp_dstatus_org_status_idx ON mp_delivery_status(org_id, status)`,

  `CREATE TABLE IF NOT EXISTS mp_bounce_events (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     message_id UUID,
     recipient_address VARCHAR(320) NOT NULL,
     bounce_type VARCHAR(12) NOT NULL DEFAULT 'unknown',
     smtp_code INT,
     diagnostic_code TEXT,
     reported_by VARCHAR(200),
     raw JSONB NOT NULL DEFAULT '{}'::jsonb,
     occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_bounce_type_chk CHECK (bounce_type IN ('hard','soft','block','auto_reply','unknown'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_bounce_addr_idx ON mp_bounce_events(lower(recipient_address), occurred_at DESC)`,

  // The list that stops us mailing an address that told us to stop. Checked on EVERY send.
  `CREATE TABLE IF NOT EXISTS mp_suppression_entries (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     address VARCHAR(320) NOT NULL,
     scope VARCHAR(10) NOT NULL DEFAULT 'org',
     scope_ref VARCHAR(120),
     reason VARCHAR(24) NOT NULL,
     source VARCHAR(120),
     expires_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_supp_scope_chk CHECK (scope IN ('org','domain','campaign')),
     CONSTRAINT mp_supp_reason_chk CHECK (reason IN
       ('hard_bounce','repeated_soft_bounce','complaint','unsubscribe','manual','invalid_address'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_supp_uk ON mp_suppression_entries(org_id, lower(address), scope, coalesce(scope_ref,''))`,
  `CREATE INDEX IF NOT EXISTS mp_supp_lookup_idx ON mp_suppression_entries(org_id, lower(address))`,

  // === contacts ============================================================
  `CREATE TABLE IF NOT EXISTS mp_contacts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     email VARCHAR(320) NOT NULL,
     first_name VARCHAR(120),
     last_name VARCHAR(120),
     full_name VARCHAR(240),
     phone VARCHAR(40),
     company VARCHAR(200),
     locale VARCHAR(12),
     timezone VARCHAR(60),
     status VARCHAR(12) NOT NULL DEFAULT 'subscribed',
     source VARCHAR(80),
     attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
     last_engaged_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_contact_status_chk CHECK (status IN ('subscribed','unsubscribed','bounced','complained','pending'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_contact_email_uk ON mp_contacts(org_id, lower(email)) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_contact_org_created_idx ON mp_contacts(org_id, created_at DESC) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_contact_status_idx ON mp_contacts(org_id, status) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_contact_attrs_idx ON mp_contacts USING gin(attributes)`,
  `CREATE INDEX IF NOT EXISTS mp_contact_search_idx ON mp_contacts
     USING gin(to_tsvector('simple', coalesce(email,'') || ' ' || coalesce(full_name,'') || ' ' || coalesce(company,'')))`,

  `CREATE TABLE IF NOT EXISTS mp_contact_lists (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     name VARCHAR(200) NOT NULL,
     slug VARCHAR(120) NOT NULL,
     description TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_list_slug_uk ON mp_contact_lists(org_id, lower(slug)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_contact_list_members (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     list_id UUID NOT NULL REFERENCES mp_contact_lists(id) ON DELETE CASCADE,
     contact_id UUID NOT NULL REFERENCES mp_contacts(id) ON DELETE CASCADE,
     status VARCHAR(12) NOT NULL DEFAULT 'subscribed',
     subscribed_at TIMESTAMPTZ,
     unsubscribed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(list_id, contact_id),
     CONSTRAINT mp_lm_status_chk CHECK (status IN ('subscribed','unsubscribed','pending'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_lm_contact_idx ON mp_contact_list_members(contact_id)`,
  `CREATE INDEX IF NOT EXISTS mp_lm_list_status_idx ON mp_contact_list_members(list_id, status)`,

  `CREATE TABLE IF NOT EXISTS mp_contact_tags (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     name VARCHAR(120) NOT NULL,
     color VARCHAR(16),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_tag_uk ON mp_contact_tags(org_id, lower(name)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_contact_tag_members (
     contact_id UUID NOT NULL REFERENCES mp_contacts(id) ON DELETE CASCADE,
     tag_id UUID NOT NULL REFERENCES mp_contact_tags(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (contact_id, tag_id)
   )`,
  `CREATE INDEX IF NOT EXISTS mp_ctm_tag_idx ON mp_contact_tag_members(tag_id)`,

  `CREATE TABLE IF NOT EXISTS mp_custom_fields (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     entity VARCHAR(20) NOT NULL DEFAULT 'contact',
     key VARCHAR(64) NOT NULL,
     label VARCHAR(120) NOT NULL,
     data_type VARCHAR(16) NOT NULL DEFAULT 'text',
     options JSONB,
     is_required BOOLEAN NOT NULL DEFAULT false,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_cf_type_chk CHECK (data_type IN ('text','number','boolean','date','select','multiselect','url'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_cf_uk ON mp_custom_fields(org_id, entity, lower(key)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_contact_events (
     id BIGSERIAL PRIMARY KEY,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     contact_id UUID NOT NULL REFERENCES mp_contacts(id) ON DELETE CASCADE,
     event_type VARCHAR(48) NOT NULL,
     source VARCHAR(80),
     message_id UUID,
     campaign_id UUID,
     meta JSONB NOT NULL DEFAULT '{}'::jsonb,
     occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS mp_ce_contact_idx ON mp_contact_events(contact_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_ce_org_type_idx ON mp_contact_events(org_id, event_type, occurred_at DESC)`,

  // === templates ===========================================================
  `CREATE TABLE IF NOT EXISTS mp_templates (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     key VARCHAR(120) NOT NULL,
     name VARCHAR(200) NOT NULL,
     description TEXT,
     category VARCHAR(16) NOT NULL DEFAULT 'transactional',
     current_version_id UUID,
     is_active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_tpl_category_chk CHECK (category IN ('transactional','marketing','system'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_tpl_key_uk ON mp_templates(org_id, lower(key)) WHERE deleted_at IS NULL`,

  // Versions are immutable once published. Editing produces a new row, never an UPDATE — so a
  // message sent last March can still be shown with the exact wording that was sent.
  `CREATE TABLE IF NOT EXISTS mp_template_versions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     template_id UUID NOT NULL REFERENCES mp_templates(id) ON DELETE CASCADE,
     version INT NOT NULL,
     subject TEXT NOT NULL,
     html_body TEXT NOT NULL,
     text_body TEXT,
     variables JSONB NOT NULL DEFAULT '[]'::jsonb,
     created_by UUID REFERENCES users(id) ON DELETE SET NULL,
     published_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(template_id, version)
   )`,

  // === campaigns ===========================================================
  `CREATE TABLE IF NOT EXISTS mp_campaigns (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     name VARCHAR(200) NOT NULL,
     slug VARCHAR(140) NOT NULL,
     type VARCHAR(12) NOT NULL DEFAULT 'broadcast',
     status VARCHAR(12) NOT NULL DEFAULT 'draft',
     template_id UUID REFERENCES mp_templates(id) ON DELETE SET NULL,
     sending_identity_id UUID REFERENCES mp_sending_identities(id) ON DELETE SET NULL,
     subject TEXT,
     preheader TEXT,
     list_id UUID REFERENCES mp_contact_lists(id) ON DELETE SET NULL,
     segment JSONB,
     scheduled_at TIMESTAMPTZ,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     stats JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_by UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_camp_type_chk CHECK (type IN ('broadcast','automated','ab_test')),
     CONSTRAINT mp_camp_status_chk CHECK (status IN ('draft','scheduled','sending','paused','sent','cancelled','failed'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_camp_slug_uk ON mp_campaigns(org_id, lower(slug)) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mp_camp_status_idx ON mp_campaigns(org_id, status, scheduled_at)`,

  `CREATE TABLE IF NOT EXISTS mp_campaign_recipients (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     campaign_id UUID NOT NULL REFERENCES mp_campaigns(id) ON DELETE CASCADE,
     contact_id UUID REFERENCES mp_contacts(id) ON DELETE SET NULL,
     address VARCHAR(320) NOT NULL,
     status VARCHAR(12) NOT NULL DEFAULT 'pending',
     message_id UUID,
     personalization JSONB NOT NULL DEFAULT '{}'::jsonb,
     queued_at TIMESTAMPTZ,
     sent_at TIMESTAMPTZ,
     failed_reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_cr_status_chk CHECK (status IN ('pending','queued','sent','failed','skipped','suppressed'))
   )`,
  // One send per contact per campaign, enforced in the database. This is the constraint that makes
  // "resume a half-finished campaign" safe: a retry cannot mail the first half a second time.
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_cr_campaign_addr_uk ON mp_campaign_recipients(campaign_id, lower(address))`,
  `CREATE INDEX IF NOT EXISTS mp_cr_pending_idx ON mp_campaign_recipients(campaign_id, status) WHERE status IN ('pending','queued')`,

  `CREATE TABLE IF NOT EXISTS mp_campaign_events (
     id BIGSERIAL PRIMARY KEY,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     campaign_id UUID NOT NULL REFERENCES mp_campaigns(id) ON DELETE CASCADE,
     contact_id UUID,
     recipient_id UUID,
     event_type VARCHAR(16) NOT NULL,
     url TEXT,
     user_agent TEXT,
     ip_address VARCHAR(64),
     meta JSONB NOT NULL DEFAULT '{}'::jsonb,
     occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS mp_camp_ev_idx ON mp_campaign_events(campaign_id, event_type, occurred_at DESC)`,

  // === automation ==========================================================
  `CREATE TABLE IF NOT EXISTS mp_workflows (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     name VARCHAR(200) NOT NULL,
     slug VARCHAR(140) NOT NULL,
     status VARCHAR(10) NOT NULL DEFAULT 'draft',
     trigger_type VARCHAR(60) NOT NULL DEFAULT 'manual',
     trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_by UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ,
     CONSTRAINT mp_wf_status_chk CHECK (status IN ('draft','active','paused','archived'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_wf_slug_uk ON mp_workflows(org_id, lower(slug)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS mp_workflow_nodes (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     workflow_id UUID NOT NULL REFERENCES mp_workflows(id) ON DELETE CASCADE,
     key VARCHAR(64) NOT NULL,
     node_type VARCHAR(20) NOT NULL,
     config JSONB NOT NULL DEFAULT '{}'::jsonb,
     position JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(workflow_id, key),
     CONSTRAINT mp_wfn_type_chk CHECK (node_type IN ('trigger','send_email','delay','condition','tag','webhook','exit'))
   )`,

  `CREATE TABLE IF NOT EXISTS mp_workflow_edges (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     workflow_id UUID NOT NULL REFERENCES mp_workflows(id) ON DELETE CASCADE,
     from_node_id UUID NOT NULL REFERENCES mp_workflow_nodes(id) ON DELETE CASCADE,
     to_node_id UUID NOT NULL REFERENCES mp_workflow_nodes(id) ON DELETE CASCADE,
     branch VARCHAR(40),
     condition JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_wfe_not_self_chk CHECK (from_node_id <> to_node_id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_wfe_uk ON mp_workflow_edges(from_node_id, to_node_id, coalesce(branch,''))`,

  `CREATE TABLE IF NOT EXISTS mp_workflow_runs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     workflow_id UUID NOT NULL REFERENCES mp_workflows(id) ON DELETE CASCADE,
     contact_id UUID REFERENCES mp_contacts(id) ON DELETE CASCADE,
     status VARCHAR(10) NOT NULL DEFAULT 'running',
     current_node_id UUID REFERENCES mp_workflow_nodes(id) ON DELETE SET NULL,
     context JSONB NOT NULL DEFAULT '{}'::jsonb,
     started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     finished_at TIMESTAMPTZ,
     next_run_at TIMESTAMPTZ,
     error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_wfr_status_chk CHECK (status IN ('running','waiting','completed','failed','cancelled'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_wfr_due_idx ON mp_workflow_runs(next_run_at) WHERE status IN ('running','waiting')`,
  // A contact does not enter the same workflow twice while a run is still open.
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_wfr_active_uk ON mp_workflow_runs(workflow_id, contact_id)
     WHERE status IN ('running','waiting') AND contact_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS mp_workflow_events (
     id BIGSERIAL PRIMARY KEY,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     workflow_id UUID NOT NULL REFERENCES mp_workflows(id) ON DELETE CASCADE,
     run_id UUID REFERENCES mp_workflow_runs(id) ON DELETE CASCADE,
     node_id UUID,
     event_type VARCHAR(40) NOT NULL,
     meta JSONB NOT NULL DEFAULT '{}'::jsonb,
     occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS mp_wfev_run_idx ON mp_workflow_events(run_id, occurred_at)`,

  // === platform events and webhooks =======================================
  // Append-only, wide-payload, time-ordered: the shape a column store ingests unchanged.
  `CREATE TABLE IF NOT EXISTS mp_events (
     id BIGSERIAL PRIMARY KEY,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     event_type VARCHAR(60) NOT NULL,
     entity_type VARCHAR(40),
     entity_id VARCHAR(120),
     actor_type VARCHAR(10),
     actor_id VARCHAR(120),
     payload JSONB NOT NULL DEFAULT '{}'::jsonb,
     occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS mp_events_org_time_idx ON mp_events(org_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_events_type_idx ON mp_events(org_id, event_type, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mp_events_entity_idx ON mp_events(entity_type, entity_id)`,

  `CREATE TABLE IF NOT EXISTS mp_webhook_endpoints (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     url TEXT NOT NULL,
     description TEXT,
     event_types TEXT[] NOT NULL DEFAULT '{}',
     secret_hash TEXT NOT NULL,
     secret_prefix VARCHAR(16),
     is_active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS mp_wh_org_idx ON mp_webhook_endpoints(org_id) WHERE deleted_at IS NULL AND is_active`,

  `CREATE TABLE IF NOT EXISTS mp_webhook_deliveries (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     endpoint_id UUID NOT NULL REFERENCES mp_webhook_endpoints(id) ON DELETE CASCADE,
     event_id BIGINT,
     event_type VARCHAR(60) NOT NULL,
     payload JSONB NOT NULL DEFAULT '{}'::jsonb,
     status VARCHAR(10) NOT NULL DEFAULT 'pending',
     attempts INT NOT NULL DEFAULT 0,
     response_code INT,
     response_body TEXT,
     next_attempt_at TIMESTAMPTZ,
     delivered_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT mp_whd_status_chk CHECK (status IN ('pending','delivered','failed'))
   )`,
  `CREATE INDEX IF NOT EXISTS mp_whd_due_idx ON mp_webhook_deliveries(next_attempt_at) WHERE status = 'pending'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mp_whd_once_uk ON mp_webhook_deliveries(endpoint_id, event_id) WHERE event_id IS NOT NULL`,
];

/**
 * `updated_at` maintained by the database, not by every INSERT site.
 *
 * A column that only some writers remember to set is worse than no column: it reads as "unchanged
 * since 2026" for the rows whose writer forgot. The DO block finds every mp_* table that has an
 * updated_at and attaches the trigger, so a table added later is covered by re-running this file.
 */
export const MP_TRIGGERS: string[] = [
  `CREATE OR REPLACE FUNCTION mp_touch_updated_at() RETURNS trigger AS $mp$
     BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $mp$ LANGUAGE plpgsql`,
  // CREATE THE MISSING ONES. DO NOT RE-CREATE THE PRESENT ONES.
  //
  // This used to DROP and then CREATE the trigger on every mp_ table it found, unconditionally. On
  // this database that is 47 tables, so 94 DDL commands on every call — and Supabase installs an
  // event trigger (extensions.pgrst_ddl_watch on ddl_command_end) that answers each one with a
  // schema-reload notification to PostgREST. With 500+ relations each reload is an introspection
  // query expensive enough to hit PostgREST's own statement timeout, and a failed load retries at
  // 1-2-4-8-16s. Ninety-four of those from one function call is the reload storm in the 2026-08-24
  // logs, and this was its single largest contributor.
  //
  // The NOT EXISTS against pg_trigger makes the loop body run only for a table that genuinely has no
  // trigger yet. In steady state it executes NOTHING and fires NOTHING; on a first run it creates
  // what is missing; when a new mp_ table is added it creates exactly one.
  //
  // tgisinternal is excluded because foreign keys and constraints are implemented as internal
  // triggers — counting one of those as ours would skip a table that has no touch trigger at all.
  //
  // The db.execute chokepoint already refuses this whole block in production, so this is not what
  // stops the storm today. It is what makes the block safe for the moment somebody sets
  // SCHEMA_BOOTSTRAP=on to apply a migration, which is precisely when 94 notifications would land.
  `DO $mp$
   DECLARE t record;
   BEGIN
     FOR t IN
       SELECT c.table_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND c.table_name LIKE 'mp\\_%'
         AND NOT EXISTS (
           SELECT 1
             FROM pg_trigger g
             JOIN pg_class cl ON cl.oid = g.tgrelid
             JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE n.nspname = 'public'
              AND cl.relname = c.table_name
              AND g.tgname = 'trg_' || c.table_name || '_touch'
              AND NOT g.tgisinternal
         )
     LOOP
       EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mp_touch_updated_at()',
                      'trg_' || t.table_name || '_touch', t.table_name);
     END LOOP;
   END
   $mp$`,
];

/** Every table this module creates. Used by the schema test and by /docs/DATABASE.md. */
export const MP_TABLES: string[] = MP_DDL
  .map((s) => /CREATE TABLE IF NOT EXISTS ([a-z_]+)/i.exec(s)?.[1] || '')
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

let ready: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Apply the schema, once per process.
 *
 * The FIRST thing it does is a single cheap probe. On a database that is already at
 * SCHEMA_VERSION this costs one indexed row read and returns — it does not re-issue 120 DDL
 * statements on every cold start of a serverless function, which on this deployment would be every
 * few minutes.
 *
 * It does NOT memoise a failure as a success. That exact bug is written up at the top of
 * src/lib/api-keys.ts: a `catch (_) {}` under a memoised promise made every later call sail past a
 * resolved cache while every query failed, with nothing anywhere naming the reason.
 */
export function ensureMailPlatformSchema(): Promise<{ ok: boolean; error?: string }> {
  if (!ready) ready = applySchema();
  return ready;
}

async function applySchema(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Probe: is this database already at the current version?
    try {
      const r = rows(await db.execute(sql`
        SELECT version FROM mp_schema_migrations WHERE version = ${SCHEMA_VERSION} LIMIT 1`));
      if (r.length > 0) return { ok: true };
    } catch {
      // mp_schema_migrations does not exist yet. That is the expected first-run path, not an error.
    }

    // A SUPPRESSED MIGRATION MUST NOT BE ABLE TO RECORD ITSELF AS DONE.
    //
    // src/lib/db/index.ts refuses DDL at db.execute when SCHEMA_BOOTSTRAP is off — the production
    // default — and a refused statement RESOLVES rather than throwing, by design, so the loops below
    // complete without error having executed nothing. The marker INSERT at the foot of this function
    // is not DDL and is therefore NOT suppressed, so it would write version=N while none of the
    // version-N statements ran.
    //
    // That is worse than a failed migration, because it is permanent: the probe above short-circuits
    // on the marker row forever after, so every caller is told { ok: true } while the tables do not
    // exist, and the documented remedy of turning SCHEMA_BOOTSTRAP back on can no longer help — the
    // function returns before it reaches the DDL. The honest answer is to refuse up front and say
    // which lever fixes it.
    if (!ddlPermitted()) {
      return {
        ok: false,
        error: 'The mail platform schema is not applied and cannot be applied from a request: '
          + 'request-time DDL is disabled on this deployment (SCHEMA_BOOTSTRAP is off). Apply '
          + 'db/mail-platform-schema.sql by hand, or set SCHEMA_BOOTSTRAP=on and redeploy. Nothing '
          + 'was written, including the migration marker, so this stays repairable.',
      };
    }

    for (const stmt of MP_DDL) await db.execute(sql.raw(stmt));
    for (const stmt of MP_EXTENSIONS) {
      // Extensions touch tables owned by other code. One that fails (a column already there under a
      // different type, a table this deployment does not have) must not abort the whole migration —
      // but it is reported, never swallowed.
      try {
        await db.execute(sql.raw(stmt));
      } catch (e: any) {
        console.error('[mailplatform] extension statement failed:', stmt.slice(0, 90), '-', causeOf(e));
      }
    }
    for (const stmt of MP_TRIGGERS) await db.execute(sql.raw(stmt));

    await db.execute(sql`
      INSERT INTO mp_schema_migrations (version, note) VALUES (${SCHEMA_VERSION}, 'mail platform patch 1')
      ON CONFLICT (version) DO NOTHING`);
    return { ok: true };
  } catch (e: any) {
    const error = causeOf(e);
    console.error('[mailplatform] ensureMailPlatformSchema failed -', error);
    ready = null; // a failure is NOT remembered as a success; the next call retries
    return { ok: false, error };
  }
}

/**
 * The whole schema as one .sql file body.
 *
 * This is what an operator runs by hand against production. Generated rather than hand-maintained,
 * so it cannot drift from what the code applies in development. See scripts/gen-mail-schema.mjs.
 */
export function mailPlatformSchemaSql(): string {
  const banner = [
    '-- db/mail-platform-schema.sql',
    '-- GENERATED FILE. Source of truth: src/lib/mailplatform/schema.ts. Regenerate with:',
    '--   npm run mail:schema',
    '--',
    '-- Apply against the EduRankAI database as the operator, e.g.:',
    '--   psql "$DATABASE_URL" -f db/mail-platform-schema.sql',
    '--',
    '-- Idempotent: every statement is IF NOT EXISTS / OR REPLACE, so re-running is safe.',
    '-- Additive: nothing here drops, renames or retypes an existing column.',
    `-- Schema version: ${SCHEMA_VERSION}`,
    '',
    'BEGIN;',
    '',
  ].join('\n');

  const section = (title: string, stmts: string[]) =>
    `-- ${'='.repeat(74)}\n-- ${title}\n-- ${'='.repeat(74)}\n\n` +
    stmts.map((s) => s.trim().replace(/\n\s{2,}/g, '\n  ') + ';').join('\n\n') +
    '\n\n';

  return (
    banner +
    section('MAIL PLATFORM TABLES', MP_DDL) +
    section('ADDITIVE EXTENSIONS TO EXISTING TABLES', MP_EXTENSIONS) +
    section('updated_at TRIGGERS', MP_TRIGGERS) +
    `INSERT INTO mp_schema_migrations (version, note) VALUES (${SCHEMA_VERSION}, 'mail platform patch 1')\n` +
    '  ON CONFLICT (version) DO NOTHING;\n\nCOMMIT;\n'
  );
}
