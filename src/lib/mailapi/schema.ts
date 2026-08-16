// src/lib/mailapi/schema.ts — the transactional email platform's own tables.
//
// SELF-BOOTSTRAPPING, LIKE EVERY OTHER MAIL TABLE IN THIS REPOSITORY. mail.ts, mail-advanced.ts and
// the templates screen all create their own schema at runtime because the migration scripts in
// .dev-scripts are run by hand against production and a deploy cannot assume one has been. This
// module follows that established contract rather than inventing a second one.
//
// WHY NEW TABLES INSTEAD OF EXTENDING mail_messages. mail_messages is a MAILBOX row: it belongs to a
// human, lands in a folder, joins a thread, and is read by the webmail client. A transactional
// message has none of those properties — it belongs to an organization and an API key, it has a
// delivery lifecycle with events, and nobody ever opens it in an inbox. Widening the mailbox table
// with fourteen nullable API columns would have made both meanings harder to read and would have put
// machine traffic into the operator's Sent folder. The two live side by side and share the SMTP
// transport, which is the part that genuinely is common.
//
// EVERY LIST COLUMN IS jsonb, DELIBERATELY. postgres-js serialises a JS array as a record literal in
// several positions — the fault documented at the top of src/lib/mail.ts, which stopped every mail
// thread from opening. jsonb sidesteps the whole class of problem: `${JSON.stringify(x)}::jsonb`
// binds identically everywhere, and the sets here (scopes, event types, recipients) are small enough
// that filtering in JS is cheaper than a clever containment query.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

/** The wire version stamped on every webhook payload. Bump only for a breaking payload change. */
export const PAYLOAD_VERSION = '2026-08-16';

const DDL: string[] = [
  // ---- tenancy -------------------------------------------------------------
  // An "organization" here is a sending product, not a customer account: AquinTutor, Careers, HEI,
  // the university systems. It exists so a key, a template, a webhook and a message all have one
  // owner, and so one product's bad day cannot spend another product's rate limit.
  `CREATE TABLE IF NOT EXISTS mailapi_orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    daily_send_cap int,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // THE LINK TO THE CAMPAIGN PLATFORM'S ORGANIZATION. Not a foreign key, on purpose: mp_organizations
  // belongs to another workstream and may not exist on every deployment, and a hard constraint would
  // make this whole schema fail to bootstrap when it does not. See src/lib/mailapi/bridge.ts for what
  // the link is FOR — chiefly so a person who unsubscribed over there is not mailed from here.
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS mp_org_id uuid`,

  // ---- API keys ------------------------------------------------------------
  // key_hash is a sha256 of the whole key and is the ONLY copy we keep. key_prefix is the first 16
  // characters, which is what the console lists and what a support conversation can safely quote.
  `CREATE TABLE IF NOT EXISTS mailapi_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'development',
    name text,
    key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL,
    scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid,
    last_used_at timestamptz,
    last_used_ip text,
    request_count bigint NOT NULL DEFAULT 0,
    rate_limit_per_minute int,
    expires_at timestamptz,
    revoked_at timestamptz,
    revoked_reason text,
    rotated_from uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_keys_org_idx ON mailapi_keys (org_id, environment)`,

  // ---- templates -----------------------------------------------------------
  // A template is a NAME. Its content lives entirely in versions, so publishing is a pointer move
  // and an edit can never silently change what production is already sending.
  `CREATE TABLE IF NOT EXISTS mailapi_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'development',
    template_key text NOT NULL,
    name text NOT NULL,
    description text,
    is_archived boolean NOT NULL DEFAULT false,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Environment-scoped by key: a development template and a production template may share a key and
  // are still different rows. This is what makes "a development key cannot reach a production
  // resource" true of templates as well as of messages.
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_templates_key_idx
     ON mailapi_templates (org_id, environment, template_key)`,
  `CREATE TABLE IF NOT EXISTS mailapi_template_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL REFERENCES mailapi_templates(id) ON DELETE CASCADE,
    version int NOT NULL,
    state text NOT NULL DEFAULT 'draft',
    subject text NOT NULL DEFAULT '',
    html text NOT NULL DEFAULT '',
    text text,
    variables jsonb NOT NULL DEFAULT '[]'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_tv_state_idx ON mailapi_template_versions (template_id, state, version DESC)`,

  // ---- idempotency ---------------------------------------------------------
  // The stored response is the whole point: a replay must return what the FIRST call returned, not a
  // fresh render of the same intent, or a retrying client would learn a different message id.
  `CREATE TABLE IF NOT EXISTS mailapi_idempotency (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    message_id uuid,
    status text NOT NULL DEFAULT 'in_progress',
    response_status int,
    response_json jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_idem_key_idx
     ON mailapi_idempotency (org_id, environment, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS mailapi_idem_expiry_idx ON mailapi_idempotency (expires_at)`,

  // ---- messages + events ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailapi_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL,
    api_key_id uuid,
    status text NOT NULL DEFAULT 'queued',
    from_email text NOT NULL,
    from_name text,
    reply_to text,
    to_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
    cc_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
    bcc_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
    suppressed jsonb NOT NULL DEFAULT '[]'::jsonb,
    subject text NOT NULL DEFAULT '',
    body_html text,
    body_text text,
    template_id uuid,
    template_key text,
    template_version int,
    template_state text,
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    idempotency_key text,
    scheduled_at timestamptz,
    claimed_at timestamptz,
    next_attempt_at timestamptz,
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 5,
    rfc_message_id text,
    last_error text,
    queued_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    delivered_at timestamptz,
    failed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_msg_org_idx ON mailapi_messages (org_id, environment, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_msg_due_idx ON mailapi_messages (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS mailapi_msg_sched_idx ON mailapi_messages (status, scheduled_at)`,
  `CREATE TABLE IF NOT EXISTS mailapi_message_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES mailapi_messages(id) ON DELETE CASCADE,
    org_id uuid NOT NULL,
    environment text NOT NULL,
    type text NOT NULL,
    recipient text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_ev_msg_idx ON mailapi_message_events (message_id, occurred_at ASC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_ev_org_idx ON mailapi_message_events (org_id, environment, occurred_at DESC)`,

  // ---- webhooks ------------------------------------------------------------
  // The secret is stored recoverably because we have to SIGN with it — a hash cannot produce a
  // signature. previous_secret exists so a rotation is not an outage: both secrets sign the payload
  // during the overlap window, and the endpoint owner can switch at their own pace.
  `CREATE TABLE IF NOT EXISTS mailapi_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'development',
    url text NOT NULL,
    description text,
    events jsonb NOT NULL DEFAULT '[]'::jsonb,
    secret text NOT NULL,
    previous_secret text,
    previous_secret_expires_at timestamptz,
    status text NOT NULL DEFAULT 'pending_verification',
    verified_at timestamptz,
    consecutive_failures int NOT NULL DEFAULT 0,
    disabled_reason text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_wh_org_idx ON mailapi_webhooks (org_id, environment)`,
  `CREATE TABLE IF NOT EXISTS mailapi_webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id uuid NOT NULL REFERENCES mailapi_webhooks(id) ON DELETE CASCADE,
    org_id uuid NOT NULL,
    environment text NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 8,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    response_status int,
    response_body text,
    duration_ms int,
    error text,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_whd_due_idx ON mailapi_webhook_deliveries (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS mailapi_whd_wh_idx ON mailapi_webhook_deliveries (webhook_id, created_at DESC)`,
  // One delivery row per (endpoint, event). Without this a dispatcher that runs twice on the same
  // event posts the customer's endpoint twice, which is exactly the duplicate this platform promises
  // not to produce.
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_whd_unique_idx ON mailapi_webhook_deliveries (webhook_id, event_id)`,

  // ---- rate limits ---------------------------------------------------------
  // Fixed-window counters. One row per (bucket, window) so the whole check-and-increment is a single
  // upsert: a read-then-write would let two concurrent requests both see "under the limit".
  `CREATE TABLE IF NOT EXISTS mailapi_rate_windows (
    bucket text NOT NULL,
    window_start timestamptz NOT NULL,
    count int NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_rate_window_idx ON mailapi_rate_windows (window_start)`,

  // ---- suppression ---------------------------------------------------------
  // A hard bounce, a complaint or an unsubscribe means we stop sending to that address for that
  // organization. Suppression is per-org and per-environment so a test that bounces cannot mute a
  // real candidate's production mail.
  `CREATE TABLE IF NOT EXISTS mailapi_suppressions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL,
    email text NOT NULL,
    reason text NOT NULL,
    source text,
    detail text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_supp_idx ON mailapi_suppressions (org_id, environment, email)`,

  // ---- sending identities (domains) ---------------------------------------
  `CREATE TABLE IF NOT EXISTS mailapi_domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'development',
    domain text NOT NULL,
    status text NOT NULL DEFAULT 'unverified',
    spf_ok boolean,
    dkim_ok boolean,
    dmarc_ok boolean,
    last_checked_at timestamptz,
    check_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_domains_idx ON mailapi_domains (org_id, environment, domain)`,
];

export function ensureMailApiSchema(): Promise<void> {
  return ensureOnce('mailapi.schema', async () => {
    for (const stmt of DDL) {
      // Not swallowed per statement: one failing CREATE leaves the whole platform half-built, and
      // this project has already shipped a bootstrap that reported success over ten missing tables.
      // ensureOnce drops a failed run from its cache and logs the real reason (e.cause).
      await db.execute(sql.raw(stmt));
    }
  });
}

/** Normalize a postgres-js result. It returns a plain array, never `{ rows }`. */
export function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) ? r : (r?.rows || [])) as T[];
}

/** The real Postgres reason lives on e.cause; e.message is only the SQL that failed. */
export function dbReason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown database error');
}
