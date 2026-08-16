// src/lib/mail-product/schema.ts — the tables the MAIL PRODUCT surface owns.
//
// WHAT THIS IS AND IS NOT. The mail ENGINE (delivery, threading, folders, transport, IMAP) lives in
// src/lib/mail.ts + mail-transport.ts + mail-groups.ts + mail-advanced.ts and bootstraps its own
// tables. Nothing here touches those. This module adds only what the product layer needs and the
// engine has never had: an audience (contacts / lists / segments), campaigns and their per-recipient
// state, versioned templates, automations, sending domains, API keys and webhooks.
//
// WHY DDL AT RUNTIME. It is the established idiom in this codebase — ensureMailSchema() in mail.ts,
// ensureMailAdvancedSchema() in mail-advanced.ts and the email_templates block in
// /admin/mail/templates.astro all do exactly this, because .dev-scripts migrations are run by hand
// and a surface that assumes one was must not 500 when it was not. Everything below is additive and
// idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS. No
// statement here drops or rewrites anything, because live rows already exist in email_templates.
//
// ONCE PER PROCESS, AND NOT IN SILENCE. Through ensureOnce(), which drops a failed run from its
// cache so a transient hiccup is retried rather than poisoning the process, and logs the real
// Postgres reason (e.cause.message — e.message is only the failed SQL).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

/** Suppression is a state on the contact, not a separate table: one row per address, one truth. */
export const CONTACT_STATUSES = ['subscribed', 'unconfirmed', 'unsubscribed', 'bounced', 'complained'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/**
 * The campaign state machine. Written down once, here, so the UI badge, the list filter and the
 * dispatcher cannot disagree about what a campaign is doing.
 *
 *   draft ──▶ scheduled ──▶ queued ──▶ sending ──▶ completed
 *     │           │            │          │
 *     │           └────────────┴──────────┴──▶ cancelled
 *     │                                   └──▶ paused ──▶ queued
 *     └──────────────────────────────────────▶ failed
 */
export const CAMPAIGN_STATUSES = [
  'draft', 'scheduled', 'queued', 'sending', 'completed', 'paused', 'cancelled', 'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Which transitions the API will actually perform. A move not listed here is refused with a reason. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled', 'queued', 'cancelled'],
  scheduled: ['queued', 'draft', 'cancelled'],
  // queued -> failed IS legal, and it has to be. dispatchBatch() refuses before claiming a single
  // recipient when there is no transport configured, and it reports that refusal as `failed`. If the
  // machine forbade the move, the row would stay 'queued' while the response said 'failed' — a UI
  // and a database disagreeing about the same campaign, which is the exact class of defect this
  // table exists to prevent. `failed -> queued` below is the way back once SMTP is set up.
  queued: ['sending', 'paused', 'cancelled', 'failed'],
  sending: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: ['draft', 'queued'],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return (CAMPAIGN_TRANSITIONS[from] || []).includes(to);
}

/** Every delivery event the analytics screens count. Named once so a typo cannot invent a metric. */
export const EVENT_TYPES = [
  'sent', 'delivered', 'deferred', 'bounced', 'opened', 'clicked', 'unsubscribed', 'complained', 'failed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function ensureMailProductSchema(): Promise<void> {
  return ensureOnce('mail-product.schema', async () => {
    // ---- Audience ----------------------------------------------------------------------------
    // email is CITEXT-less on purpose (the extension may not be installed): the column is stored
    // lower-cased by the service layer and the unique index is on the raw column, so a duplicate
    // cannot be created through any path that goes through normaliseEmail().
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      first_name text,
      last_name text,
      status text NOT NULL DEFAULT 'subscribed',
      source text,
      fields jsonb NOT NULL DEFAULT '{}'::jsonb,
      tags text[] NOT NULL DEFAULT '{}',
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      subscribed_at timestamptz NOT NULL DEFAULT now(),
      unsubscribed_at timestamptz,
      last_activity_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_contacts_email_uq ON mail_contacts(lower(email))`);
    // The three indexes the list screen's ORDER BY and WHERE actually use. Without the first one,
    // "prepare for millions of contacts" is a sentence rather than a property.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_contacts_created_idx ON mail_contacts(created_at DESC, id DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_contacts_status_idx ON mail_contacts(status, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_contacts_tags_idx ON mail_contacts USING gin(tags)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_lists (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL,
      description text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_lists_slug_uq ON mail_lists(lower(slug))`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_list_members (
      list_id uuid NOT NULL REFERENCES mail_lists(id) ON DELETE CASCADE,
      contact_id uuid NOT NULL REFERENCES mail_contacts(id) ON DELETE CASCADE,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (list_id, contact_id)
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_list_members_contact_idx ON mail_list_members(contact_id)`);

    // A segment is a stored FILTER, never a stored membership: it must reflect the audience as it is
    // now, not as it was when somebody pressed save.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_segments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      rules jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    // Custom fields are DECLARED, so the contact form, the import mapper and the {{variable}} picker
    // all offer the same list instead of each guessing from whatever jsonb keys happen to exist.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_contact_fields (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL,
      label text NOT NULL,
      kind text NOT NULL DEFAULT 'text',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_contact_fields_key_uq ON mail_contact_fields(lower(key))`);

    // ---- Templates ---------------------------------------------------------------------------
    // email_templates already exists and holds live rows (see /admin/mail/templates.astro). It is
    // EXTENDED, never recreated: `blocks` is the builder document, `kind` separates a transactional
    // template from a campaign one, `version` is the number the version table counts from.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS email_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key text NOT NULL,
      subject text NOT NULL,
      body_html text NOT NULL DEFAULT '',
      body_text text,
      description text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const stmt of [
      sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS blocks jsonb`,
      sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'campaign'`,
      sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
      sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false`,
      sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS created_by uuid`,
      sql`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS preheader text`,
    ]) {
      // Each ALTER on its own so one failing column does not abandon the rest.
      try { await db.execute(stmt); } catch (e: any) {
        console.error('[mail-product] email_templates alter:', e?.cause?.message || e?.message);
      }
    }

    // "Template versioning must be supported" — a version is an immutable snapshot, so a campaign
    // that went out can still be shown exactly as it was sent after the template is edited.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_template_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id uuid NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
      version integer NOT NULL,
      subject text NOT NULL DEFAULT '',
      preheader text,
      body_html text NOT NULL DEFAULT '',
      body_text text,
      blocks jsonb,
      note text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_template_versions_uq ON mail_template_versions(template_id, version)`);

    // ---- Campaigns ---------------------------------------------------------------------------
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      subject text NOT NULL DEFAULT '',
      preheader text,
      from_name text,
      from_email text,
      reply_to text,
      template_id uuid REFERENCES email_templates(id) ON DELETE SET NULL,
      blocks jsonb,
      body_html text NOT NULL DEFAULT '',
      body_text text,
      status text NOT NULL DEFAULT 'draft',
      list_ids uuid[] NOT NULL DEFAULT '{}',
      segment_id uuid REFERENCES mail_segments(id) ON DELETE SET NULL,
      scheduled_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      recipients_total integer NOT NULL DEFAULT 0,
      sent_count integer NOT NULL DEFAULT 0,
      failed_count integer NOT NULL DEFAULT 0,
      last_error text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaigns_status_idx ON mail_campaigns(status, updated_at DESC)`);

    // One row per (campaign, contact). The UNIQUE index is the idempotency key the dispatcher relies
    // on: a retried batch cannot send the same person the same campaign twice.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_campaign_recipients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id uuid NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
      contact_id uuid REFERENCES mail_contacts(id) ON DELETE SET NULL,
      email text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      message_id text,
      error text,
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_campaign_recipients_uq ON mail_campaign_recipients(campaign_id, lower(email))`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaign_recipients_pending_idx ON mail_campaign_recipients(campaign_id, status)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_campaign_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id uuid REFERENCES mail_campaigns(id) ON DELETE CASCADE,
      contact_id uuid REFERENCES mail_contacts(id) ON DELETE SET NULL,
      email text,
      type text NOT NULL,
      url text,
      meta jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    // The analytics screens aggregate by (campaign, type, day) and by (type, day). Both are covered.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaign_events_c_idx ON mail_campaign_events(campaign_id, type, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaign_events_t_idx ON mail_campaign_events(type, created_at DESC)`);

    // ---- Automations -------------------------------------------------------------------------
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_automations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'draft',
      graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
      entered_count integer NOT NULL DEFAULT 0,
      completed_count integer NOT NULL DEFAULT 0,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_automation_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      automation_id uuid NOT NULL REFERENCES mail_automations(id) ON DELETE CASCADE,
      contact_id uuid REFERENCES mail_contacts(id) ON DELETE SET NULL,
      node_id text,
      status text NOT NULL DEFAULT 'running',
      wait_until timestamptz,
      context jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_error text,
      started_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_automation_runs_due_idx ON mail_automation_runs(status, wait_until)`);

    // ---- Sending domains ----------------------------------------------------------------------
    // The four record checks are stored per-domain so the screen can show WHEN each was last looked
    // at, not just what it says now. /api/mail/dns-check.ts is the live checker; this is its record.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      domain text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      spf_status text NOT NULL DEFAULT 'pending',
      dkim_status text NOT NULL DEFAULT 'pending',
      dmarc_status text NOT NULL DEFAULT 'pending',
      mx_status text NOT NULL DEFAULT 'pending',
      dkim_selector text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at timestamptz,
      verified_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_domains_uq ON mail_domains(lower(domain))`);

    // ---- API keys + webhooks -------------------------------------------------------------------
    // ONLY THE HASH IS STORED. key_prefix is the first 12 characters, kept solely so the list screen
    // can identify a key without being able to reconstruct it. The full secret is returned exactly
    // once, at creation, and never again — which is why the create dialog says so.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      key_prefix text NOT NULL,
      key_hash text NOT NULL,
      scopes text[] NOT NULL DEFAULT '{}',
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_api_keys_hash_uq ON mail_api_keys(key_hash)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      url text NOT NULL,
      events text[] NOT NULL DEFAULT '{}',
      secret text,
      is_active boolean NOT NULL DEFAULT true,
      failure_count integer NOT NULL DEFAULT 0,
      last_delivery_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      webhook_id uuid NOT NULL REFERENCES mail_webhooks(id) ON DELETE CASCADE,
      event text NOT NULL,
      attempt integer NOT NULL DEFAULT 1,
      ok boolean NOT NULL DEFAULT false,
      status_code integer,
      response_body text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_webhook_deliveries_idx ON mail_webhook_deliveries(webhook_id, created_at DESC)`);
  });
}
