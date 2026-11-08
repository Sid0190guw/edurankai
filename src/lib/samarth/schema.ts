// SAMARTH tables. Additive, idempotent, no REFERENCES (so there is no creation order to get wrong)
// and no ALTER TABLE (so nothing takes an exclusive lock on a live table).
//
// NOT CREATED ON A REQUEST IN PRODUCTION. ensureOnce() is a no-op there (src/lib/ensure-once.ts),
// so these tables are created by the bootstrap at /admin/setup, or by hand:
//   psql -v ON_ERROR_STOP=1 -f db/samarth-schema.sql
// db/samarth-schema.sql is this same text; samarth.test.ts fails if the two drift apart.
// Every reader reports `ready: false` with that instruction when a table is missing, instead of
// rendering an empty list that reads as "there are none".

import { ensureBatch } from '@/lib/ensure-once';

export const SAMARTH_DDL = `
CREATE TABLE IF NOT EXISTS samarth_fee_schedule (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT NOT NULL,
  currency        TEXT NOT NULL,
  amount_minor    BIGINT NOT NULL,
  tax_mode        TEXT NOT NULL DEFAULT 'none',
  tax_label       TEXT,
  tax_rate_bp     INT NOT NULL DEFAULT 0,
  processing_bp   INT NOT NULL DEFAULT 0,
  charges_note    TEXT,
  terms           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
  note            TEXT,
  created_by      UUID,
  created_name    TEXT,
  approved_by     UUID,
  approved_name   TEXT,
  approved_at     TIMESTAMPTZ,
  approval_note   TEXT,
  retired_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_fee_lookup_idx ON samarth_fee_schedule (category, currency, status);

CREATE TABLE IF NOT EXISTS samarth_applications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                    TEXT NOT NULL UNIQUE,
  status                 TEXT NOT NULL DEFAULT 'DRAFT',
  category               TEXT NOT NULL,
  country                TEXT NOT NULL,
  region                 TEXT,
  city                   TEXT,
  timezone               TEXT,
  contact_name           TEXT NOT NULL,
  contact_email          TEXT NOT NULL,
  contact_phone          TEXT,
  contact_role           TEXT,
  org_name               TEXT,
  org_website            TEXT,
  org_registration       TEXT,
  turnover_band          TEXT,
  official               JSONB,
  pathway                TEXT,
  need                   TEXT,
  title                  TEXT,
  summary                TEXT,
  requirements           JSONB,
  documents              JSONB,
  fee_schedule_id        UUID,
  fee_currency           TEXT,
  fee_total_minor        BIGINT,
  fee_snapshot           JSONB,
  fee_terms_accepted_at  TIMESTAMPTZ,
  payment_method         TEXT,
  payment_order_id       TEXT,
  charged_inr_paise      BIGINT,
  fx_rate                NUMERIC,
  fx_date                TEXT,
  paid_at                TIMESTAMPTZ,
  payment_reference      TEXT,
  invoice_id             UUID,
  booking                JSONB,
  booking_requested_at   TIMESTAMPTZ,
  consultant_user_id     UUID,
  consultant_name        TEXT,
  consultant_email       TEXT,
  assigned_at            TIMESTAMPTZ,
  call_at                TIMESTAMPTZ,
  call_link              TEXT,
  call_completed_at      TIMESTAMPTZ,
  outcome_note           TEXT,
  ai_assisted            BOOLEAN NOT NULL DEFAULT false,
  consent_privacy        BOOLEAN NOT NULL DEFAULT false,
  consent_contact        BOOLEAN NOT NULL DEFAULT false,
  source                 TEXT NOT NULL DEFAULT 'web',
  access_hash            TEXT NOT NULL,
  archived               BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_app_status_idx ON samarth_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS samarth_app_created_idx ON samarth_applications (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS samarth_app_email_idx ON samarth_applications (contact_email);
CREATE INDEX IF NOT EXISTS samarth_app_order_idx ON samarth_applications (payment_order_id);

CREATE TABLE IF NOT EXISTS samarth_engagements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                 TEXT NOT NULL UNIQUE,
  application_id      UUID NOT NULL,
  kind                TEXT NOT NULL,
  package_code        TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  title               TEXT NOT NULL,
  scope               TEXT,
  deliverables        TEXT,
  exclusions          TEXT,
  delivery_model      TEXT,
  responsibility      TEXT,
  partner_ids         JSONB,
  currency            TEXT NOT NULL DEFAULT 'INR',
  amount_minor        BIGINT,
  tax_mode            TEXT NOT NULL DEFAULT 'none',
  tax_label           TEXT,
  tax_rate_bp         INT NOT NULL DEFAULT 0,
  total_minor         BIGINT,
  terms               TEXT,
  valid_until         DATE,
  payment_method      TEXT NOT NULL DEFAULT 'invoice',
  prepared_by         UUID,
  prepared_name       TEXT,
  approved_by         UUID,
  approved_name       TEXT,
  approved_at         TIMESTAMPTZ,
  approval_note       TEXT,
  sent_at             TIMESTAMPTZ,
  accepted_at         TIMESTAMPTZ,
  accepted_name       TEXT,
  acceptance_evidence TEXT,
  decided_note        TEXT,
  payment_state       TEXT NOT NULL DEFAULT 'none',
  payment_order_id    TEXT,
  charged_inr_paise   BIGINT,
  fx_rate             NUMERIC,
  paid_at             TIMESTAMPTZ,
  payment_reference   TEXT,
  invoice_id          UUID,
  award_reference     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_eng_app_idx ON samarth_engagements (application_id);
CREATE INDEX IF NOT EXISTS samarth_eng_status_idx ON samarth_engagements (status, created_at DESC);
CREATE INDEX IF NOT EXISTS samarth_eng_order_idx ON samarth_engagements (payment_order_id);

CREATE TABLE IF NOT EXISTS samarth_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  TEXT NOT NULL,
  subject_id    UUID NOT NULL,
  kind          TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  body          TEXT,
  visibility    TEXT NOT NULL DEFAULT 'internal',
  actor_user_id UUID,
  actor_name    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_events_subject_idx ON samarth_events (subject_type, subject_id, created_at);

CREATE TABLE IF NOT EXISTS samarth_partners (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'REGISTERED',
  org_name           TEXT NOT NULL,
  org_kind           TEXT,
  country            TEXT,
  website            TEXT,
  contact_name       TEXT NOT NULL,
  contact_email      TEXT NOT NULL,
  contact_phone      TEXT,
  domains            JSONB,
  capabilities       TEXT,
  qualifications     TEXT,
  certifications     TEXT,
  previous_projects  TEXT,
  regulatory         TEXT,
  security           TEXT,
  commercial         TEXT,
  documents          JSONB,
  dd_checklist       JSONB,
  rating             INT,
  performance_note   TEXT,
  consent_privacy    BOOLEAN NOT NULL DEFAULT false,
  access_hash        TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_partner_status_idx ON samarth_partners (status, created_at DESC);

CREATE TABLE IF NOT EXISTS samarth_x_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                   TEXT NOT NULL UNIQUE,
  channel               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'RECEIVED',
  applicant_kind        TEXT NOT NULL DEFAULT 'individual',
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT,
  country               TEXT,
  team                  JSONB,
  venture_name          TEXT,
  problem               TEXT,
  domain                TEXT,
  proposed_system       TEXT,
  skills                TEXT,
  previous_work         TEXT,
  github_url            TEXT,
  portfolio_url         TEXT,
  prototype_url         TEXT,
  vision                TEXT,
  market                TEXT,
  resources_needed      TEXT,
  source_event          TEXT,
  source_reference      TEXT,
  nominated_by          TEXT,
  cohort                TEXT,
  agreement_reference   TEXT,
  decision_note         TEXT,
  consent_privacy       BOOLEAN NOT NULL DEFAULT false,
  access_hash           TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_x_status_idx ON samarth_x_candidates (status, created_at DESC);
CREATE INDEX IF NOT EXISTS samarth_x_cohort_idx ON samarth_x_candidates (cohort, status);

CREATE TABLE IF NOT EXISTS samarth_x_reviews (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id     UUID NOT NULL,
  reviewer_user_id UUID NOT NULL,
  reviewer_name    TEXT,
  scores           JSONB NOT NULL,
  total            INT NOT NULL,
  recommendation   TEXT NOT NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, reviewer_user_id)
);

CREATE TABLE IF NOT EXISTS samarth_x_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  due_date     DATE,
  state        TEXT NOT NULL DEFAULT 'open',
  url          TEXT,
  actor_name   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS samarth_x_progress_idx ON samarth_x_progress (candidate_id, created_at);
`;

export const SAMARTH_TABLES = [
  'samarth_fee_schedule', 'samarth_applications', 'samarth_engagements', 'samarth_events',
  'samarth_partners', 'samarth_x_candidates', 'samarth_x_reviews', 'samarth_x_progress',
] as const;

export function ensureSamarthSchema(): Promise<void> {
  return ensureBatch('samarth_schema_v1', SAMARTH_DDL);
}

export interface SamarthSchemaStatus { ready: boolean; missing: string[]; error?: string }

/** Which SAMARTH tables exist right now. Table names are constants, never user input. */
export async function samarthSchemaStatus(): Promise<SamarthSchemaStatus> {
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const cols = SAMARTH_TABLES.map((t, i) => "to_regclass('public." + t + "') IS NOT NULL AS t" + i).join(', ');
    const r: any = await db.execute(sql.raw('SELECT ' + cols));
    const row = (Array.isArray(r) ? r : (r?.rows || []))[0] || {};
    const missing = SAMARTH_TABLES.filter((_, i) => row['t' + i] !== true);
    return { ready: missing.length === 0, missing };
  } catch (e: any) {
    return { ready: false, missing: [...SAMARTH_TABLES], error: dbReason(e) };
  }
}

/**
 * CREATE THE SAMARTH TABLES NOW, ON AN OPERATOR'S EXPLICIT REQUEST.
 *
 * Production refuses request-time DDL (src/lib/ensure-once.ts), which is right for page views and
 * is why /samarth/consultation said "the published fees could not be loaded" on the live site: its
 * tables had never been created. This is the same operator action as "Create module tables" on
 * /admin/setup, scoped to SAMARTH and reachable from the SAMARTH desk itself. It runs the DDL inside
 * allowingDdl(), never through ensureOnce (which would swallow a failure), and then checks every
 * table, so the answer is what the database says rather than what the DDL call returned.
 *
 * Safe on a live database: CREATE TABLE / INDEX IF NOT EXISTS on brand-new tables only, no ALTER, so
 * no lock is taken on any table other pages read.
 */
export async function createSamarthTables(): Promise<SamarthSchemaStatus> {
  try {
    const { allowingDdl } = await import('@/lib/schema-bootstrap');
    const { runGuardedDdl } = await import('@/lib/ensure-once');
    await allowingDdl(() => runGuardedDdl(SAMARTH_DDL));
  } catch (e: any) {
    const after = await samarthSchemaStatus();
    return { ...after, error: dbReason(e) };
  }
  return samarthSchemaStatus();
}

/** The sentence every reader shows when a SAMARTH table is absent. */
export const SAMARTH_NOT_SET_UP =
  'SAMARTH is not set up on this deployment yet: its tables do not exist. Run the bootstrap at /admin/setup, or psql -v ON_ERROR_STOP=1 -f db/samarth-schema.sql.';

/** What a PUBLIC visitor is told when SAMARTH is not set up. Never the operator instruction above. */
export const PUBLIC_NOT_OPEN = 'SAMARTH is not open for this yet. Please try again shortly, or write to connect@edurankai.in and we will reply.';

/** Map an internal error to what a public visitor may read. */
export function publicMessage(error: string): string {
  return error === SAMARTH_NOT_SET_UP ? PUBLIC_NOT_OPEN : error;
}

export function isMissingTable(e: any): boolean {
  return String(e?.cause?.code || e?.code || '') === '42P01';
}

export function dbReason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}
