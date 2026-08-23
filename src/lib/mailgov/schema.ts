// src/lib/mailgov/schema.ts — the governance tables, and the one place the database itself is asked
// to enforce something rather than being trusted to.
//
// SELF-BOOTSTRAPPING, like every other mail table in this repository (src/lib/mail.ts,
// src/lib/mailapi/schema.ts). There is no migration runner here: .dev-scripts migrations are run by
// hand against production, and a deploy cannot assume one has been. This module follows that
// established contract rather than inventing a second one.
//
// THE PREFIX IS `mailapi_`, NOT A NEW ONE. Governance is not a separate product from the mail
// platform — it administers it — and a second prefix would mean two namespaces to remember, two
// places to look, and a `mailgov_orgs` that somebody eventually joins against `mailapi_orgs` and
// wonders why it is empty. One platform, one prefix.
//
// WHAT THE DATABASE ENFORCES HERE, rather than the application promising it:
//
//   1. `mailapi_audit_events` REFUSES UPDATE. A trigger raises an exception on any UPDATE, always,
//      with no escape hatch. Nothing in this repository issues one; the trigger is what makes that
//      true of everything else that ever connects, including a console session at 2am.
//
//   2. It refuses DELETE too, EXCEPT inside a transaction that has set `mailgov.prune`. That
//      exception exists because the brief requires a retention policy for audit logs, and a table
//      that cannot be pruned at all cannot have one. Setting the flag is a deliberate act performed
//      in exactly one function (pruneAuditLog in ./retention.ts), which writes a checkpoint first so
//      the hash chain stays verifiable across the gap.
//
//   3. `prev_hash` is UNIQUE. That is what turns two concurrent appends into one success and one
//      failed insert that retries, instead of a silently forked chain. It is the cheapest
//      correctness guarantee in the file and the one that would have been hardest to debug.
//
// IF THE TRIGGER CANNOT BE CREATED — a role without CREATE FUNCTION, say — the ensure logs the real
// reason and the platform still runs, because append-only is also enforced by there being no UPDATE
// path in the code. governanceHealth() in ./health.ts REPORTS whether the trigger actually exists,
// so the difference between "enforced by the database" and "enforced by convention" is visible on a
// screen rather than assumed. A reported success and an observable result are not the same thing.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { textIn } from '@/lib/pg-array';
import { ensureOnce } from '@/lib/ensure-once';

/** Normalize a postgres-js result. It returns a plain array, never `{ rows }`. */
export function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) ? r : (r?.rows || [])) as T[];
}

/** The real Postgres reason lives on e.cause; e.message is only the SQL that failed. */
export function dbReason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown database error');
}

/** Every table this module owns, so health and export can check existence rather than guess. */
export const GOVERNANCE_TABLES = [
  'mailapi_audit_events',
  'mailapi_audit_checkpoints',
  'mailapi_platform_admins',
  'mailapi_org_members',
  'mailapi_retention_policies',
  'mailapi_retention_runs',
  'mailapi_export_jobs',
  'mailapi_deletion_jobs',
  'mailapi_consent',
  'mailapi_security_events',
  'mailapi_legal_holds',
  'mailapi_support_grants',
  'mailapi_ai_records',
] as const;

const DDL: string[] = [
  // ---- audit ---------------------------------------------------------------------------------
  // `seq` is the chain order and `prev_hash` is the link. Both are written by the INSERT in
  // ./audit.ts, which reads the current tail inside the same statement — see the note there.
  `CREATE TABLE IF NOT EXISTS mailapi_audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq bigserial NOT NULL UNIQUE,
    org_id uuid,
    actor_user_id uuid,
    actor_email text,
    actor_role text,
    actor_api_key_id uuid,
    action text NOT NULL,
    target_type text,
    target_id text,
    result text NOT NULL DEFAULT 'ok',
    reason text,
    ip text,
    user_agent text,
    request_id text,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash text NOT NULL,
    prev_hash text NOT NULL,
    hash text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
  )`,
  // The uniqueness that prevents a forked chain. Two appends racing for the same tail: one wins, the
  // other gets a unique violation and retries against the new tail.
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_audit_prev_idx ON mailapi_audit_events (prev_hash)`,
  `CREATE INDEX IF NOT EXISTS mailapi_audit_org_idx ON mailapi_audit_events (org_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_audit_actor_idx ON mailapi_audit_events (actor_user_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_audit_action_idx ON mailapi_audit_events (action, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_audit_target_idx ON mailapi_audit_events (target_type, target_id)`,
  `CREATE INDEX IF NOT EXISTS mailapi_audit_seq_idx ON mailapi_audit_events (seq DESC)`,

  // The refusal, in the database. TG_OP is named in the message so an operator who trips it knows
  // which operation was refused rather than only that something was.
  `CREATE OR REPLACE FUNCTION mailapi_audit_guard() RETURNS trigger AS $mailapi_audit_guard$
   BEGIN
     IF TG_OP = 'UPDATE' THEN
       RAISE EXCEPTION 'mailapi_audit_events is append-only: UPDATE is refused';
     END IF;
     IF TG_OP = 'DELETE' AND COALESCE(current_setting('mailgov.prune', true), '') <> 'on' THEN
       RAISE EXCEPTION 'mailapi_audit_events is append-only: DELETE is refused outside a retention prune';
     END IF;
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END;
   $mailapi_audit_guard$ LANGUAGE plpgsql`,
  `DO $mailapi_audit_trigger$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mailapi_audit_no_change') THEN
       CREATE TRIGGER mailapi_audit_no_change
         BEFORE UPDATE OR DELETE ON mailapi_audit_events
         FOR EACH ROW EXECUTE FUNCTION mailapi_audit_guard();
     END IF;
   END
   $mailapi_audit_trigger$`,

  // A prune leaves a hole in the chain. This is the record that explains it, written BEFORE the rows
  // go, so a verifier can link the surviving chain back to something rather than concluding tampering.
  `CREATE TABLE IF NOT EXISTS mailapi_audit_checkpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_seq bigint NOT NULL,
    to_seq bigint NOT NULL,
    removed int NOT NULL,
    last_removed_hash text NOT NULL,
    cutoff timestamptz NOT NULL,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  // ---- platform grants ------------------------------------------------------------------------
  // An EXPLICIT appointment, separate from the EduRankAI role matrix. Being a super admin of the
  // company console does not make somebody a support engineer on the mail platform, and the reverse
  // is more important: a support engineer needs no EduRankAI admin role at all.
  `CREATE TABLE IF NOT EXISTS mailapi_platform_admins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    role text NOT NULL,
    granted_by uuid,
    reason text,
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by uuid,
    revoked_reason text
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_platform_admins_active_idx
     ON mailapi_platform_admins (user_id) WHERE revoked_at IS NULL`,

  // ---- membership -----------------------------------------------------------------------------
  // The vocabulary is OrgMemberRole from src/lib/mailplatform/types.ts, unchanged. `status` is
  // separate from the role because suspending somebody and demoting them are different acts with
  // different reversals.
  `CREATE TABLE IF NOT EXISTS mailapi_org_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'member',
    status text NOT NULL DEFAULT 'active',
    invited_by uuid,
    suspended_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_org_members_idx
     ON mailapi_org_members (org_id, user_id) WHERE removed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mailapi_org_members_user_idx ON mailapi_org_members (user_id) WHERE removed_at IS NULL`,

  // ---- organization controls -------------------------------------------------------------------
  // ADDITIVE COLUMNS on the existing mailapi_orgs rather than a parallel controls table: a send path
  // that has to join two tables to find out whether it may send is a send path that will one day
  // forget to. `is_active` already exists and stays the master switch; these are the finer stops the
  // brief asks for.
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`,
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS sending_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS receiving_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS campaigns_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS suspended_at timestamptz`,
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS suspended_by uuid`,
  `ALTER TABLE mailapi_orgs ADD COLUMN IF NOT EXISTS suspension_reason text`,

  // ---- retention -------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailapi_retention_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'production',
    data_class text NOT NULL,
    retain_days int NOT NULL,
    action text NOT NULL DEFAULT 'delete',
    enabled boolean NOT NULL DEFAULT true,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_retention_idx
     ON mailapi_retention_policies (org_id, environment, data_class)`,
  // What a sweep actually did. Without this, "retention is configured" and "retention has ever run"
  // are indistinguishable on screen — and they are the two states an operator most needs to tell
  // apart.
  `CREATE TABLE IF NOT EXISTS mailapi_retention_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid,
    environment text,
    data_class text NOT NULL,
    action text NOT NULL,
    cutoff timestamptz NOT NULL,
    affected int NOT NULL DEFAULT 0,
    skipped_held int NOT NULL DEFAULT 0,
    ok boolean NOT NULL DEFAULT true,
    error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_retention_runs_idx ON mailapi_retention_runs (org_id, started_at DESC)`,

  // ---- export ----------------------------------------------------------------------------------
  // The download token is stored as a SHA-256 like an API key, and returned exactly once. A token we
  // can read is a token an operator with database access can use, which would put every export
  // behind the weakest credential in the building rather than behind the grant that authorised it.
  `CREATE TABLE IF NOT EXISTS mailapi_export_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'production',
    datasets jsonb NOT NULL DEFAULT '[]'::jsonb,
    format text NOT NULL DEFAULT 'jsonl',
    filters jsonb NOT NULL DEFAULT '{}'::jsonb,
    includes_content boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'pending',
    requested_by uuid NOT NULL,
    requested_reason text,
    row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    manifest jsonb,
    object_key text,
    object_url text,
    byte_size bigint,
    download_token_hash text,
    expires_at timestamptz,
    download_count int NOT NULL DEFAULT 0,
    last_downloaded_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
  )`,
  // WHERE THE FILE ACTUALLY LIVES WHEN THERE IS NO OBJECT STORE. src/lib/storage.ts falls back to an
  // in-memory store whose put() DISCARDS the bytes and returns a url — perfect for tests, and a
  // silent data-loss bug for an export somebody is about to hand to a regulator. So on a deployment
  // with no S3 and no blob token, small exports are stored here instead and large ones are refused
  // with a reason. An export that reports "ready" must be an export that can be downloaded.
  `ALTER TABLE mailapi_export_jobs ADD COLUMN IF NOT EXISTS inline_payload text`,
  `ALTER TABLE mailapi_export_jobs ADD COLUMN IF NOT EXISTS storage_backend text`,
  `CREATE INDEX IF NOT EXISTS mailapi_export_org_idx ON mailapi_export_jobs (org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_export_due_idx ON mailapi_export_jobs (status, created_at)`,

  // ---- deletion --------------------------------------------------------------------------------
  // org_id is NULLABLE here and nowhere else in this file. A `mailbox` deletion acts on EduRankAI's
  // own internal mail store, which belongs to no tenant — forcing an organization onto it would file
  // the job under a customer who has nothing to do with it, and that customer's administrators would
  // then see it in their own audit view.
  // NO FOREIGN KEY ON org_id, AND THAT IS THE POINT. Every other tenant table cascades from
  // mailapi_orgs; this one must not. Deleting an organization is performed BY a row in this table,
  // and a cascade would delete that row in the middle of its own execution — taking the record of
  // the deletion with it, which is exactly what a governance system must never lose.
  `CREATE TABLE IF NOT EXISTS mailapi_deletion_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid,
    scope text NOT NULL,
    target text NOT NULL,
    target_label text,
    reason text NOT NULL,
    also_remove_suppression boolean NOT NULL DEFAULT false,
    plan jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending_approval',
    requested_by uuid NOT NULL,
    approvals jsonb NOT NULL DEFAULT '[]'::jsonb,
    scheduled_for timestamptz,
    counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    blocked_reason text,
    error text,
    cancelled_by uuid,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_deletion_org_idx ON mailapi_deletion_jobs (org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_deletion_due_idx ON mailapi_deletion_jobs (status, scheduled_for)`,

  // ---- consent ---------------------------------------------------------------------------------
  // One row per (org, environment, address, CATEGORY). The category in the key is the whole design:
  // it is what makes it impossible for a marketing unsubscribe to touch a transactional send, because
  // they are literally different rows.
  `CREATE TABLE IF NOT EXISTS mailapi_consent (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'production',
    email text NOT NULL,
    category text NOT NULL,
    status text NOT NULL DEFAULT 'never',
    consent_at timestamptz,
    source text,
    purpose text,
    unsubscribed_at timestamptz,
    unsubscribe_source text,
    ip text,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mailapi_consent_idx
     ON mailapi_consent (org_id, environment, email, category)`,
  `CREATE INDEX IF NOT EXISTS mailapi_consent_email_idx ON mailapi_consent (email)`,

  // ---- security events --------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailapi_security_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid,
    environment text,
    type text NOT NULL,
    family text NOT NULL,
    severity text NOT NULL DEFAULT 'low',
    subject text,
    actor_user_id uuid,
    actor_api_key_id uuid,
    ip text,
    user_agent text,
    request_id text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'new',
    resolved_by uuid,
    resolved_at timestamptz,
    resolution_note text,
    occurred_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_sec_org_idx ON mailapi_security_events (org_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_sec_type_idx ON mailapi_security_events (type, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_sec_open_idx ON mailapi_security_events (status, severity, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_sec_subject_idx ON mailapi_security_events (subject)`,

  // ---- legal hold --------------------------------------------------------------------------------
  // `matter_ref` is mandatory text and `matter_id` optionally links a row in legal_matters
  // (src/lib/legal-hold.ts). The mail platform must be able to hold records for a customer's own
  // matter, which will not exist in our matters table — so the reference is the required field and
  // the link is the optional one.
  // NO FOREIGN KEY ON org_id either, for the same class of reason: a hold outliving the organization
  // is the whole point of a hold. If deleting a tenant cascaded their holds away, the record of what
  // was being preserved and under which matter would vanish with the data it was preserving.
  `CREATE TABLE IF NOT EXISTS mailapi_legal_holds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    matter_ref text NOT NULL,
    matter_id uuid,
    scope text NOT NULL,
    scope_ref text,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    placed_by uuid NOT NULL,
    placed_at timestamptz NOT NULL DEFAULT now(),
    released_by uuid,
    released_at timestamptz,
    release_reason text
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_hold_org_idx ON mailapi_legal_holds (org_id, status)`,
  `CREATE INDEX IF NOT EXISTS mailapi_hold_scope_idx ON mailapi_legal_holds (scope, scope_ref) WHERE status = 'active'`,

  // ---- support grants -----------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS mailapi_support_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    requested_by uuid NOT NULL,
    reason text NOT NULL,
    matter_ref text,
    status text NOT NULL DEFAULT 'requested',
    approved_by uuid,
    approved_at timestamptz,
    denied_by uuid,
    denied_at timestamptz,
    denial_reason text,
    revoked_by uuid,
    revoked_at timestamptz,
    expires_at timestamptz,
    uses int NOT NULL DEFAULT 0,
    max_uses int NOT NULL DEFAULT 25,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_grant_org_idx ON mailapi_support_grants (org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_grant_subject_idx ON mailapi_support_grants (subject_type, subject_id, status)`,

  // ---- AI processing records ------------------------------------------------------------------------
  // The register the brief's retention section requires. It records THAT content was processed by a
  // model, by which model, for what purpose and what was kept — never the content itself, which is
  // the point: a governance register that copies the data it governs has doubled the exposure it was
  // built to manage. The mail platform's AI features write here through recordAiProcessing().
  `CREATE TABLE IF NOT EXISTS mailapi_ai_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    environment text NOT NULL DEFAULT 'production',
    message_id uuid,
    purpose text NOT NULL,
    model text NOT NULL,
    provider text,
    /* A hash of the input, so the same content can be recognised without being stored. */
    input_digest text,
    input_chars int,
    output_kept text,
    retained_output boolean NOT NULL DEFAULT false,
    human_reviewed boolean NOT NULL DEFAULT false,
    actor_user_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mailapi_ai_org_idx ON mailapi_ai_records (org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mailapi_ai_msg_idx ON mailapi_ai_records (message_id)`,
];

/**
 * Create everything, once per process.
 *
 * Not swallowed per statement: one failing CREATE leaves governance half-built, and this project has
 * already shipped a bootstrap that reported `ok: true, ran: 8, failed: 0` over ten missing tables.
 * ensureOnce drops a failed run from its cache so the next call retries, and logs the real Postgres
 * reason from e.cause.
 *
 * DEPENDS ON mailapi_orgs. Several tables reference it, so the mail API's own schema is ensured
 * first — otherwise a fresh deployment fails on the first foreign key and the governance console is
 * unreachable on exactly the deployments where it is most needed.
 */
export function ensureGovernanceSchema(): Promise<void> {
  return ensureOnce('mailgov.schema', async () => {
    const { ensureMailApiSchema } = await import('@/lib/mailapi/schema');
    await ensureMailApiSchema();
    for (const stmt of DDL) {
      await db.execute(sql.raw(stmt));
    }
  });
}

/**
 * Does this table exist on THIS deployment?
 *
 * Used by the export and deletion engines before they touch anything. The catalogue in
 * ./export-plan.ts declares datasets (contacts, campaigns) whose tables are not built yet, and the
 * honest behaviour is "this deployment has no campaigns table" rather than an empty file that reads
 * exactly like "this organization ran no campaigns".
 */
export async function tableExists(table: string): Promise<boolean> {
  try {
    const r = rows(await db.execute(sql`SELECT to_regclass(${'public.' + table}) IS NOT NULL AS ok`))[0];
    return !!r?.ok;
  } catch {
    return false;
  }
}

/** Which of a list of tables exist. One round trip rather than N. */
export async function tablesExisting(tables: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!tables.length) return out;
  try {
    const r = rows(await db.execute(sql`
      SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname::text IN ${textIn(tables)}`));
    for (const row of r) out.add(String(row.name));
  } catch {
    /* An unreadable catalogue is reported by health, not guessed at here. */
  }
  return out;
}

/**
 * Is the append-only trigger actually installed?
 *
 * Asked by ./health.ts and printed on the audit screen. The difference between "the database refuses
 * UPDATE" and "we believe nothing issues one" is the difference between a control and an intention,
 * and an operator is entitled to know which one they have.
 */
export async function auditTriggerInstalled(): Promise<boolean> {
  try {
    const r = rows(await db.execute(sql`
      SELECT 1 AS ok FROM pg_trigger WHERE tgname = 'mailapi_audit_no_change' LIMIT 1`));
    return r.length > 0;
  } catch {
    return false;
  }
}
