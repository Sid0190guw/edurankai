-- db/mail-saas-schema.sql
-- GENERATED. Source of truth: src/lib/mailplatform/saas/pg-store.ts (SAAS_DDL).
--
-- Apply AFTER db/mail-platform-schema.sql: every table here has a foreign key into
-- mp_organizations. Idempotent and additive - safe on a fresh database and on a populated one.

ALTER TABLE mp_organization_members ADD COLUMN IF NOT EXISTS team_role VARCHAR(24);
CREATE TABLE IF NOT EXISTS mp_org_profiles (
    org_id UUID PRIMARY KEY REFERENCES mp_organizations(id) ON DELETE CASCADE,
    org_type VARCHAR(24) NOT NULL DEFAULT 'individual',
    billing_email VARCHAR(255),
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    tax_id VARCHAR(64),
    country VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS mp_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(org_id, slug));
CREATE TABLE IF NOT EXISTS mp_team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES mp_teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    team_role VARCHAR(24) NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, user_id));
CREATE TABLE IF NOT EXISTS mp_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES mp_organizations(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    tier VARCHAR(24) NOT NULL DEFAULT 'enterprise',
    description TEXT NOT NULL DEFAULT '',
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    features JSONB NOT NULL DEFAULT '[]'::jsonb,
    overage JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, key));
CREATE TABLE IF NOT EXISTS mp_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES mp_organizations(id) ON DELETE CASCADE,
    plan_key VARCHAR(64) NOT NULL DEFAULT 'free',
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    period_end TIMESTAMPTZ NOT NULL,
    trial_ends_at TIMESTAMPTZ,
    cancel_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    pending_plan_key VARCHAR(64),
    pending_plan_at TIMESTAMPTZ,
    custom_limits JSONB,
    custom_overage JSONB,
    last_billing_event_at TIMESTAMPTZ,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_ref VARCHAR(200),
    suspended_reason TEXT,
    suspended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS mp_enterprise_terms (
    org_id UUID PRIMARY KEY REFERENCES mp_organizations(id) ON DELETE CASCADE,
    sla_uptime_percent VARCHAR(16),
    sla_support_response VARCHAR(120),
    dedicated_infra BOOLEAN NOT NULL DEFAULT false,
    dedicated_ips JSONB NOT NULL DEFAULT '[]'::jsonb,
    custom_smtp_host VARCHAR(255),
    data_retention_days INTEGER,
    data_region VARCHAR(64),
    contract_ref VARCHAR(120),
    contract_ends_at TIMESTAMPTZ,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS mp_usage_events (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL,
    quantity NUMERIC NOT NULL DEFAULT 0,
    mode VARCHAR(8) NOT NULL DEFAULT 'delta',
    source VARCHAR(64) NOT NULL DEFAULT 'unknown',
    idempotency_key VARCHAR(200),
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX IF NOT EXISTS mp_usage_idem_idx
    ON mp_usage_events(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mp_usage_org_metric_idx
    ON mp_usage_events(org_id, metric, occurred_at DESC);
CREATE TABLE IF NOT EXISTS mp_usage_counters (
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    value NUMERIC NOT NULL DEFAULT 0,
    peak NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, metric, period_start));
CREATE TABLE IF NOT EXISTS mp_quota_notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    threshold NUMERIC NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'warning',
    notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, metric, period_start, threshold));
CREATE TABLE IF NOT EXISTS mp_billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES mp_organizations(id) ON DELETE SET NULL,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    event_id VARCHAR(200) NOT NULL,
    type VARCHAR(48) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    error TEXT,
    UNIQUE(provider, event_id));
CREATE INDEX IF NOT EXISTS mp_billing_events_org_idx
    ON mp_billing_events(org_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS mp_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
    number VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    subtotal_minor BIGINT NOT NULL DEFAULT 0,
    tax_minor BIGINT NOT NULL DEFAULT 0,
    total_minor BIGINT NOT NULL DEFAULT 0,
    amount_paid_minor BIGINT NOT NULL DEFAULT 0,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    issued_at TIMESTAMPTZ,
    due_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_ref VARCHAR(200),
    hosted_url TEXT,
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, number));
