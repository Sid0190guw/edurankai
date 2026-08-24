-- db/mail-platform-schema.sql
-- GENERATED FILE. Source of truth: src/lib/mailplatform/schema.ts. Regenerate with:
--   npm run mail:schema
--
-- Apply against the EduRankAI database as the operator, e.g.:
--   psql "$DATABASE_URL" -f db/mail-platform-schema.sql
--
-- Idempotent: every statement is IF NOT EXISTS / OR REPLACE, so re-running is safe.
-- Additive: nothing here drops, renames or retypes an existing column.
-- Schema version: 2

BEGIN;
-- ==========================================================================
-- MAIL PLATFORM TABLES
-- ==========================================================================

CREATE TABLE IF NOT EXISTS mp_schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
  );

CREATE TABLE IF NOT EXISTS mp_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT mp_org_status_chk CHECK (status IN ('active','suspended','closed'))
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_org_slug_uk ON mp_organizations(lower(slug)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT mp_member_role_chk CHECK (role IN ('owner','admin','member','analyst','service'))
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_member_org_user_uk ON mp_organization_members(org_id, user_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_member_user_idx ON mp_organization_members(user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_roles_org_key_uk ON mp_roles(coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(key)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES mp_roles(id) ON DELETE CASCADE,
  permission_key VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(role_id, permission_key)
  );

CREATE TABLE IF NOT EXISTS mp_audit_logs (
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
  );

CREATE INDEX IF NOT EXISTS mp_audit_org_time_idx ON mp_audit_logs(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mp_audit_target_idx ON mp_audit_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS mp_mailboxes (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_mailbox_addr_uk ON mp_mailboxes(lower(primary_address)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_mailbox_org_idx ON mp_mailboxes(org_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_mailbox_owner_idx ON mp_mailboxes(owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_mailbox_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access VARCHAR(12) NOT NULL DEFAULT 'read',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT mp_mailbox_access_chk CHECK (access IN ('read','send','manage'))
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_mailbox_member_uk ON mp_mailbox_members(mailbox_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_email_addresses (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_address_uk ON mp_email_addresses(lower(address)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_address_mailbox_idx ON mp_email_addresses(mailbox_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_aliases (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_alias_source_uk ON mp_aliases(lower(source_address)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_folders (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_folder_key_uk ON mp_folders(mailbox_id, lower(key)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
  mailbox_id UUID REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_label_uk ON mp_labels(coalesce(mailbox_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_message_labels (
  message_id UUID NOT NULL,
  label_id UUID NOT NULL REFERENCES mp_labels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, label_id)
  );

CREATE INDEX IF NOT EXISTS mp_message_labels_label_idx ON mp_message_labels(label_id);

CREATE TABLE IF NOT EXISTS mp_threads (
  id UUID PRIMARY KEY,
  org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
  mailbox_id UUID REFERENCES mp_mailboxes(id) ON DELETE SET NULL,
  subject_normalized VARCHAR(500) NOT NULL DEFAULT '',
  last_message_at TIMESTAMPTZ,
  message_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
  );

CREATE INDEX IF NOT EXISTS mp_threads_org_recent_idx ON mp_threads(org_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS mp_threads_subject_idx ON mp_threads(lower(subject_normalized));

CREATE TABLE IF NOT EXISTS mp_message_headers (
  id BIGSERIAL PRIMARY KEY,
  message_id UUID NOT NULL,
  name VARCHAR(120) NOT NULL,
  value TEXT NOT NULL,
  ordinal INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS mp_headers_msg_idx ON mp_message_headers(message_id, ordinal);

CREATE INDEX IF NOT EXISTS mp_headers_name_idx ON mp_message_headers(lower(name));

CREATE TABLE IF NOT EXISTS mp_domains (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_domain_uk ON mp_domains(org_id, lower(domain)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_domain_name_idx ON mp_domains(lower(domain)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_domain_verifications (
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
  );

CREATE INDEX IF NOT EXISTS mp_dv_domain_idx ON mp_domain_verifications(domain_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS mp_dns_records (
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
  );

CREATE INDEX IF NOT EXISTS mp_dns_domain_idx ON mp_dns_records(domain_id);

CREATE TABLE IF NOT EXISTS mp_dkim_keys (
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
  );

CREATE INDEX IF NOT EXISTS mp_dkim_active_idx ON mp_dkim_keys(domain_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS mp_domain_settings (
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
  );

CREATE TABLE IF NOT EXISTS mp_sending_domains (
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
  );

CREATE TABLE IF NOT EXISTS mp_sending_identities (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_identity_uk ON mp_sending_identities(org_id, lower(from_address)) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mp_identity_default_uk ON mp_sending_identities(org_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_delivery_attempts (
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
  );

CREATE INDEX IF NOT EXISTS mp_attempt_msg_idx ON mp_delivery_attempts(message_id, attempt_no);

CREATE INDEX IF NOT EXISTS mp_attempt_org_time_idx ON mp_delivery_attempts(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mp_delivery_events (
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
  );

CREATE INDEX IF NOT EXISTS mp_devent_msg_idx ON mp_delivery_events(message_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mp_devent_org_time_idx ON mp_delivery_events(org_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mp_devent_campaign_idx ON mp_delivery_events(campaign_id, event_type) WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mp_devent_recipient_idx ON mp_delivery_events(lower(recipient_address), occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS mp_devent_provider_uk ON mp_delivery_events(provider_event_id) WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mp_delivery_status (
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
  );

CREATE INDEX IF NOT EXISTS mp_dstatus_org_status_idx ON mp_delivery_status(org_id, status);

CREATE TABLE IF NOT EXISTS mp_bounce_events (
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
  );

CREATE INDEX IF NOT EXISTS mp_bounce_addr_idx ON mp_bounce_events(lower(recipient_address), occurred_at DESC);

CREATE TABLE IF NOT EXISTS mp_suppression_entries (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_supp_uk ON mp_suppression_entries(org_id, lower(address), scope, coalesce(scope_ref,''));

CREATE INDEX IF NOT EXISTS mp_supp_lookup_idx ON mp_suppression_entries(org_id, lower(address));

CREATE TABLE IF NOT EXISTS mp_contacts (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_contact_email_uk ON mp_contacts(org_id, lower(email)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_contact_org_created_idx ON mp_contacts(org_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_contact_status_idx ON mp_contacts(org_id, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_contact_attrs_idx ON mp_contacts USING gin(attributes);

CREATE INDEX IF NOT EXISTS mp_contact_search_idx ON mp_contacts
  USING gin(to_tsvector('simple', coalesce(email,'') || ' ' || coalesce(full_name,'') || ' ' || coalesce(company,'')));

CREATE TABLE IF NOT EXISTS mp_contact_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_list_slug_uk ON mp_contact_lists(org_id, lower(slug)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_contact_list_members (
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
  );

CREATE INDEX IF NOT EXISTS mp_lm_contact_idx ON mp_contact_list_members(contact_id);

CREATE INDEX IF NOT EXISTS mp_lm_list_status_idx ON mp_contact_list_members(list_id, status);

CREATE TABLE IF NOT EXISTS mp_contact_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_tag_uk ON mp_contact_tags(org_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_contact_tag_members (
  contact_id UUID NOT NULL REFERENCES mp_contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES mp_contact_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
  );

CREATE INDEX IF NOT EXISTS mp_ctm_tag_idx ON mp_contact_tag_members(tag_id);

CREATE TABLE IF NOT EXISTS mp_custom_fields (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_cf_uk ON mp_custom_fields(org_id, entity, lower(key)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_contact_events (
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
  );

CREATE INDEX IF NOT EXISTS mp_ce_contact_idx ON mp_contact_events(contact_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mp_ce_org_type_idx ON mp_contact_events(org_id, event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mp_templates (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_tpl_key_uk ON mp_templates(org_id, lower(key)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_template_versions (
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
  );

CREATE TABLE IF NOT EXISTS mp_campaigns (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_camp_slug_uk ON mp_campaigns(org_id, lower(slug)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mp_camp_status_idx ON mp_campaigns(org_id, status, scheduled_at);

CREATE TABLE IF NOT EXISTS mp_campaign_recipients (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_cr_campaign_addr_uk ON mp_campaign_recipients(campaign_id, lower(address));

CREATE INDEX IF NOT EXISTS mp_cr_pending_idx ON mp_campaign_recipients(campaign_id, status) WHERE status IN ('pending','queued');

CREATE TABLE IF NOT EXISTS mp_campaign_events (
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
  );

CREATE INDEX IF NOT EXISTS mp_camp_ev_idx ON mp_campaign_events(campaign_id, event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mp_workflows (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_wf_slug_uk ON mp_workflows(org_id, lower(slug)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mp_workflow_nodes (
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
  );

CREATE TABLE IF NOT EXISTS mp_workflow_edges (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS mp_wfe_uk ON mp_workflow_edges(from_node_id, to_node_id, coalesce(branch,''));

CREATE TABLE IF NOT EXISTS mp_workflow_runs (
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
  );

CREATE INDEX IF NOT EXISTS mp_wfr_due_idx ON mp_workflow_runs(next_run_at) WHERE status IN ('running','waiting');

CREATE UNIQUE INDEX IF NOT EXISTS mp_wfr_active_uk ON mp_workflow_runs(workflow_id, contact_id)
  WHERE status IN ('running','waiting') AND contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mp_workflow_events (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES mp_workflows(id) ON DELETE CASCADE,
  run_id UUID REFERENCES mp_workflow_runs(id) ON DELETE CASCADE,
  node_id UUID,
  event_type VARCHAR(40) NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS mp_wfev_run_idx ON mp_workflow_events(run_id, occurred_at);

CREATE TABLE IF NOT EXISTS mp_events (
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
  );

CREATE INDEX IF NOT EXISTS mp_events_org_time_idx ON mp_events(org_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mp_events_type_idx ON mp_events(org_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mp_events_entity_idx ON mp_events(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS mp_webhook_endpoints (
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
  );

CREATE INDEX IF NOT EXISTS mp_wh_org_idx ON mp_webhook_endpoints(org_id) WHERE deleted_at IS NULL AND is_active;

CREATE TABLE IF NOT EXISTS mp_webhook_deliveries (
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
  );

CREATE INDEX IF NOT EXISTS mp_whd_due_idx ON mp_webhook_deliveries(next_attempt_at) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS mp_whd_once_uk ON mp_webhook_deliveries(endpoint_id, event_id) WHERE event_id IS NOT NULL;

-- ==========================================================================
-- ADDITIVE EXTENSIONS TO EXISTING TABLES
-- ==========================================================================

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS org_id UUID;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS mailbox_id UUID;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS references_header TEXT;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS reply_to VARCHAR(320);

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS spam_score NUMERIC(6,3);

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS spam_verdict VARCHAR(16) NOT NULL DEFAULT 'unknown';

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS raw_object_key TEXT;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS raw_storage_backend VARCHAR(32);

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS campaign_id UUID;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS mail_msg_org_created_idx ON mail_messages(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mail_msg_campaign_idx ON mail_messages(campaign_id) WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mail_msg_from_email_idx ON mail_messages(lower(from_email));

CREATE INDEX IF NOT EXISTS mail_msg_search_idx ON mail_messages
  USING gin(to_tsvector('simple', coalesce(subject,'') || ' ' || coalesce(snippet,'')));

ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS storage_key TEXT;

ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32);

ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS content_id VARCHAR(255);

ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS is_inline BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS mailbox_id UUID;

ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS org_id UUID;

ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE mail_box ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS mail_box_mailbox_idx ON mail_box(mailbox_id, folder, created_at DESC);

ALTER TABLE mailapi_messages ADD COLUMN IF NOT EXISTS platform_message_id UUID;

CREATE INDEX IF NOT EXISTS mailapi_msg_platform_idx ON mailapi_messages(platform_message_id) WHERE platform_message_id IS NOT NULL;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS org_id UUID;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(org_id) WHERE org_id IS NOT NULL;

-- ==========================================================================
-- updated_at TRIGGERS
-- ==========================================================================

CREATE OR REPLACE FUNCTION mp_touch_updated_at() RETURNS trigger AS $mp$
  BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
  $mp$ LANGUAGE plpgsql;

DO $mp$
  DECLARE t record;
  BEGIN
  FOR t IN
  SELECT c.table_name FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND c.table_name LIKE 'mp\_%'
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
  $mp$;

INSERT INTO mp_schema_migrations (version, note) VALUES (2, 'mail platform patch 1')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
