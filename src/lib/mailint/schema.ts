// src/lib/mailint/schema.ts — the integration platform's own tables.
//
// SELF-BOOTSTRAPPING, like every other mail table in this repository (mail.ts, mail-advanced.ts,
// mailapi/schema.ts). The migration scripts in .dev-scripts are run BY HAND against production by
// the founder, so a deploy may not assume one has been run; each subsystem creates its own schema
// on first use. This module follows that established contract rather than inventing a second one.
//
// PREFIX. Every table here is `mailint_`. The repository already owns `events`, `webhooks`,
// `integrations`-shaped names in other subsystems and ~50 `hr_*` tables; an unprefixed
// `integrations` or `event_routes` would have collided on the first migration. The transactional
// API's tables are `mailapi_` and are REUSED rather than duplicated: webhook endpoints and their
// deliveries already exist there, correctly shaped (secret, previous_secret, consecutive_failures,
// attempts, next_attempt_at), and a second endpoint table would have split the same fact in two.
//
// EVERY LIST COLUMN IS jsonb. postgres-js serialises a JS array as a record literal in several
// positions — the fault written up at the top of src/lib/mail.ts, which stopped every mail thread
// from opening. `${JSON.stringify(x)}::jsonb` binds identically everywhere.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { ensureMailApiSchema } from '@/lib/mailapi/schema';

export { rows, dbReason } from '@/lib/mailapi/schema';

const DDL: string[] = [
  // ---- integrations --------------------------------------------------------------------------
  // One row per connected system, per organisation, per environment. `connector` is the registry
  // key from connectors.ts; a row whose connector is no longer registered is shown as unknown in
  // the console rather than being deleted, because deleting it would take its credentials and its
  // event history with it.
  `CREATE TABLE IF NOT EXISTS mailint_integrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'development',
    connector text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    direction text NOT NULL DEFAULT 'inbound',
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_enabled boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'connected',
    status_detail text,
    consecutive_failures int NOT NULL DEFAULT 0,
    last_event_at timestamptz,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_checked_at timestamptz,
    expected_interval_seconds int,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailint_integrations_slug_idx
     ON mailint_integrations (org_id, environment, slug)`,
  `CREATE INDEX IF NOT EXISTS mailint_integrations_org_idx ON mailint_integrations (org_id, environment)`,

  // ---- credentials ---------------------------------------------------------------------------
  // THE CIPHERTEXT IS THE ONLY COPY. `ciphertext` is AES-256-GCM; `iv` and `tag` are its nonce and
  // authentication tag; `key_id` names WHICH master key encrypted it, so a master-key rotation can
  // re-encrypt row by row instead of invalidating every credential at once.
  //
  // `hint` is the last four characters and is the ONLY part ever returned by an API. Section 6 of
  // the brief: "never expose secrets to frontend clients after creation" — enforced by there being
  // no read path that returns plaintext to a response, not by remembering not to write one.
  `CREATE TABLE IF NOT EXISTS mailint_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    integration_id uuid REFERENCES mailint_integrations(id) ON DELETE CASCADE,
    kind text NOT NULL,
    label text,
    ciphertext text NOT NULL,
    iv text NOT NULL,
    tag text NOT NULL,
    key_id text NOT NULL DEFAULT 'env:v1',
    hint text,
    fingerprint text,
    scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    expires_at timestamptz,
    rotated_from uuid,
    revoked_at timestamptz,
    revoked_reason text,
    last_used_at timestamptz,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_cred_int_idx ON mailint_credentials (integration_id, kind, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS mailint_cred_expiry_idx ON mailint_credentials (expires_at) WHERE revoked_at IS NULL`,

  // ---- the canonical event bus ---------------------------------------------------------------
  // Append-only, one row per fact, wide jsonb payload, ordered by occurred_at. That shape is
  // deliberate: it is what a column store ingests without remodelling, so a future analytics move
  // is a copy rather than a redesign.
  //
  // THE UNIQUE INDEX ON (org_id, idempotency_key) IS THE DUPLICATE PROMISE. Section 9 of the brief
  // says duplicate events must not create duplicate emails; a check-then-insert in application code
  // would let two concurrent deliveries of the same event both pass the check. The database refuses
  // the second one, and the insert is written to expect that refusal.
  `CREATE TABLE IF NOT EXISTS mailint_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'production',
    event_type text NOT NULL,
    source text NOT NULL,
    integration_id uuid,
    entity_type text,
    entity_id text,
    actor_type text,
    actor_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text NOT NULL,
    external_event_id text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailint_events_idem_idx
     ON mailint_events (org_id, environment, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS mailint_events_org_idx ON mailint_events (org_id, environment, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailint_events_type_idx ON mailint_events (org_id, event_type, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailint_events_entity_idx ON mailint_events (org_id, entity_type, entity_id)`,

  // ---- inbound receipts ------------------------------------------------------------------------
  // What arrived, before we understood it. Kept separately from mailint_events because the two
  // answer different questions: "did their system call us?" and "what facts do we hold?". An
  // integration that is posting malformed payloads has rows here and none there, which is exactly
  // the state that is invisible if you only store what parsed.
  `CREATE TABLE IF NOT EXISTS mailint_inbound (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    environment text NOT NULL DEFAULT 'development',
    integration_id uuid,
    connector text NOT NULL,
    external_event_id text,
    external_type text,
    status text NOT NULL DEFAULT 'received',
    detail text,
    request_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    trace jsonb NOT NULL DEFAULT '[]'::jsonb,
    received_count int NOT NULL DEFAULT 0,
    published_count int NOT NULL DEFAULT 0,
    duplicate_count int NOT NULL DEFAULT 0,
    failed_count int NOT NULL DEFAULT 0,
    event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    request_id text,
    ip text,
    duration_ms int,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_inbound_org_idx ON mailint_inbound (org_id, environment, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailint_inbound_int_idx ON mailint_inbound (integration_id, created_at DESC)`,

  // ---- routes --------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailint_routes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'development',
    name text NOT NULL,
    event_pattern text NOT NULL,
    action text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    stop_on_match boolean NOT NULL DEFAULT false,
    priority int NOT NULL DEFAULT 100,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_routes_org_idx ON mailint_routes (org_id, environment, is_active)`,

  // ---- mappings ------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailint_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    integration_id uuid REFERENCES mailint_integrations(id) ON DELETE CASCADE,
    name text NOT NULL,
    source text NOT NULL,
    definition jsonb NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    priority int NOT NULL DEFAULT 100,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_mappings_int_idx ON mailint_mappings (integration_id, is_active, priority)`,

  // ---- what an event caused --------------------------------------------------------------------
  // Without this table the console can show that an event arrived and that an email was sent, and
  // cannot show that the second happened BECAUSE of the first. That link is the whole question an
  // operator asks when a candidate says they received the wrong message.
  `CREATE TABLE IF NOT EXISTS mailint_route_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    environment text NOT NULL DEFAULT 'development',
    event_id uuid NOT NULL,
    route_id uuid,
    route_name text,
    action text NOT NULL,
    status text NOT NULL,
    detail text,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    duration_ms int,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_runs_event_idx ON mailint_route_runs (event_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS mailint_runs_org_idx ON mailint_route_runs (org_id, environment, created_at DESC)`,

  // ---- dead letter ------------------------------------------------------------------------------
  // Everything that has stopped being retried, with enough of the original to replay it. A dead
  // letter queue whose rows cannot be replayed is a log file with a grander name.
  `CREATE TABLE IF NOT EXISTS mailint_dead_letter (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    environment text NOT NULL DEFAULT 'development',
    kind text NOT NULL,
    ref_id uuid,
    integration_id uuid,
    endpoint_id uuid,
    event_id uuid,
    event_type text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempts int NOT NULL DEFAULT 0,
    last_status int,
    last_error text,
    first_failed_at timestamptz NOT NULL DEFAULT now(),
    last_failed_at timestamptz NOT NULL DEFAULT now(),
    replayed_at timestamptz,
    replayed_by uuid,
    replay_delivery_id uuid,
    resolved_at timestamptz,
    resolution text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_dl_org_idx ON mailint_dead_letter (org_id, environment, resolved_at, last_failed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailint_dl_ref_idx ON mailint_dead_letter (kind, ref_id)`,

  // ---- scheduled actions ------------------------------------------------------------------------
  // What the `workflow` channel actually is on this platform: an ordered set of DELAYED steps
  // caused by one event. "Stage 3 email workflow" from section 8 of the brief is a route whose
  // steps are (immediately: the invitation) and (+72h: the reminder, unless the event that would
  // cancel it has arrived).
  //
  // Deliberately NOT a second job queue. The rows are claimed by the same dispatcher cron as the
  // webhook deliveries, with the same FOR UPDATE SKIP LOCKED claim and the same backoff, so there
  // is one thing to run and one place a stuck job is visible.
  `CREATE TABLE IF NOT EXISTS mailint_scheduled_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    environment text NOT NULL DEFAULT 'development',
    event_id uuid NOT NULL,
    route_id uuid,
    route_name text,
    workflow_key text,
    step_index int NOT NULL DEFAULT 0,
    action text NOT NULL DEFAULT 'email',
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'pending',
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 4,
    claimed_at timestamptz,
    last_error text,
    executed_at timestamptz,
    cancelled_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_sched_due_idx ON mailint_scheduled_actions (status, run_at)`,
  `CREATE INDEX IF NOT EXISTS mailint_sched_event_idx ON mailint_scheduled_actions (event_id)`,
  // One row per (event, route, step). A router that runs twice on the same event — a retried emit,
  // two dispatchers — must not schedule the same reminder twice.
  `CREATE UNIQUE INDEX IF NOT EXISTS mailint_sched_unique_idx
     ON mailint_scheduled_actions (event_id, route_id, step_index)`,

  // ---- health history -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailint_health_checks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    status text NOT NULL,
    detail text,
    latency_ms int,
    checked_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailint_health_int_idx ON mailint_health_checks (integration_id, checked_at DESC)`,

  // ---- webhook endpoint additions ------------------------------------------------------------
  // mailapi_webhooks already exists (mailapi/schema.ts) with url, events, secret, previous_secret
  // and failure counters. Three columns are added here rather than a second endpoint table being
  // created, because one endpoint is one fact.
  //
  // `grant_sensitive` is the explicit decision described in routing.ts: an endpoint sees a
  // rejection reason or an assessment score ONLY if somebody deliberately granted it.
  `ALTER TABLE mailapi_webhooks ADD COLUMN IF NOT EXISTS grant_sensitive boolean NOT NULL DEFAULT false`,
  `ALTER TABLE mailapi_webhooks ADD COLUMN IF NOT EXISTS integration_id uuid`,
  `ALTER TABLE mailapi_webhooks ADD COLUMN IF NOT EXISTS last_delivery_at timestamptz`,
  // NOTHING IS ADDED TO mailapi_webhook_deliveries. The delivery row already carries `event_id`,
  // and fanout.ts writes OUR event id into it — so "which deliveries did this fact cause?" is a
  // query on a column that already exists, and the shipped dispatcher needs no change at all.
];

/**
 * CONTACTS ARE NOT ENSURED HERE, DELIBERATELY.
 *
 * An earlier draft of this file created `mail_contacts` additively so the import/export surface had
 * somewhere to write. It does not any more: src/lib/mail-contacts.ts owns that table and creates it
 * with `email VARCHAR(320) UNIQUE` and `mail_contact_tags` keyed `(contact_id, tag)`. A second
 * bootstrap adding a unique index on `lower(email)` would either fail on real data or silently
 * impose a different uniqueness rule than the module that does the writing — two answers to "is this
 * the same contact?", which is exactly the class of split-brain this codebase keeps paying for.
 *
 * Anything in this directory that touches contacts calls ensureContactSchema() and the functions in
 * that module instead.
 */

export function ensureMailIntSchema(): Promise<void> {
  return ensureOnce('mailint.schema', async () => {
    // The transactional API's tables first: mailint_integrations references mailapi_orgs, and the
    // webhook ALTERs below need mailapi_webhooks to exist.
    await ensureMailApiSchema();
    for (const stmt of DDL) {
      // Not swallowed per statement. One failing CREATE leaves the platform half-built, and this
      // project has already shipped a bootstrap that reported success over ten missing tables.
      // ensureOnce drops a failed run from its cache and logs the real reason (e.cause).
      await db.execute(sql.raw(stmt));
    }
  });
}
