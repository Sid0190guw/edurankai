// src/lib/talent/schema.ts — THE OWNED CONTRACT for every tal_* table.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md section 26.
//
// ONE MODULE CREATES THESE TABLES. Not the page that happens to read them first, not each service
// bootstrapping its own slice. This repository has already paid for the alternative: two
// `CREATE TABLE IF NOT EXISTS` statements for one table with DIFFERENT SHAPES, where whichever ran
// second was a silent no-op and half the columns simply never existed (db/hr-schema.sql:300).
//
// FOUR RULES, ALL OF THEM SCAR TISSUE FROM THIS CODEBASE:
//
//  1. `department_id` IS TEXT. `departments.id` is varchar(50) (src/lib/db/schema.ts:80) while
//     db/hr-schema.sql:53 declares `department_id UUID REFERENCES departments(id)`. They cannot
//     both be right. src/lib/org-graph-schema.ts carries the same warning. A `::uuid` cast against
//     a department id is a guaranteed production 500 — spec F8.
//  2. NO FOREIGN KEY to a table whose id type is contested. Indexes and application-level checks,
//     not constraints that fail to create and take the whole ensure down with them.
//  3. THE ENSURE FAILS LOUDLY. ensureOnce drops a failed promise so the next call retries, and logs
//     e.cause — the real Postgres reason. A memoised, silently-resolved bootstrap over DDL that
//     never ran is how a write path went down here with nothing in the logs saying why.
//  4. IDEMPOTENT THROUGHOUT. Every statement is CREATE ... IF NOT EXISTS or ADD COLUMN IF NOT
//     EXISTS, so this is safe to run against an environment that already has some of it.
//
// SAFE TO RUN ON PRODUCTION. It creates; it never drops, renames or retypes. db/talent-schema.sql
// is the readable mirror an operator can run by hand — the established pattern here, because this
// project does not connect to the production database from a development process.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { reasonOf } from '@/lib/talent/types';

// Declared before anything that uses it: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const KEY = 'talent_platform_v1';
const KEY_BRIDGE = 'talent_platform_bridge_v1';

/**
 * Create every tal_* table. Call at the top of any talent service entry point.
 *
 * Grouped into try blocks by concern so a failure names the group it happened in. The whole
 * function still rejects — a partial schema must not report success.
 */
/**
 * ONE ROUND TRIP WHEN THE SCHEMA IS ALREADY THERE, WHICH IS EVERY REQUEST AFTER THE FIRST DEPLOY.
 *
 * WHAT THIS FIXES. The bootstrap below is 83 statements, each its own network round trip, and
 * ensureOnce caches per PROCESS — so every cold serverless instance paid the whole run again before
 * the page read its first row. A round trip to this database measures ~135ms from bom1, which puts
 * a cold bootstrap somewhere north of eleven seconds: past the gateway timeout, while holding a
 * transaction-pooler session the whole time. A deploy makes every instance cold at once, so they all
 * do it together and contend on the same tables. That is the exact shape of the outage recorded in
 * the commit "Send each schema bootstrap as one message instead of thirty-seven", and of the
 * request-time DDL outage before it.
 *
 * WHY A SENTINEL AND NOT A BATCH. Batching these 83 statements into one message is the other valid
 * fix and the one src/lib/ensure-once.ts offers through ensureBatch(). It is not used here because a
 * batch is ONE IMPLICIT TRANSACTION holding every lock it takes until commit, and this run creates
 * tables that live production code already reads. A sentinel changes nothing about how the DDL is
 * sent when it DOES need to run; it only stops it being re-sent when it does not.
 *
 * WHY THE LAST INDEX AND NOT THE FIRST TABLE. tal_event_subject_idx is the final object this
 * function creates. Its existence therefore proves every statement before it committed. Sentinelling
 * on tal_person — the first — would skip the whole run on a database where an earlier bootstrap died
 * half way, and the missing tables would never be created.
 *
 * It fails OPEN, deliberately: any error looking the sentinel up falls through to the full run,
 * because the cost of running idempotent DDL twice is a slow request and the cost of skipping it
 * wrongly is a page that cannot work at all.
 */
const SENTINEL = 'tal_event_subject_idx';

async function schemaAlreadyPresent(): Promise<boolean> {
  try {
    const r = await db.execute(sql`SELECT to_regclass(${'public.' + SENTINEL}) IS NOT NULL AS present`);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    return rows[0]?.present === true;
  } catch (e: any) {
    console.error('[talent-schema] sentinel check failed, running full bootstrap: ' + reasonOf(e));
    return false;
  }
}

export function ensureTalentSchema(): Promise<void> {
  return ensureOnce(KEY, async () => {
    if (await schemaAlreadyPresent()) return;
    try {
      // -------------------------------------------------------------------------------------
      // PERSON — spec 26.1. The thing the brief's section 43 exists to protect: one human, many
      // applications, never a new person row per application.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_person (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        person_code    TEXT NOT NULL UNIQUE,
        display_name   TEXT NOT NULL,
        preferred_name TEXT,
        primary_email  TEXT,
        primary_phone  TEXT,
        country        TEXT,
        merged_into_id UUID,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_person_email_idx ON tal_person (lower(primary_email))`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_person_merged_idx ON tal_person (merged_into_id) WHERE merged_into_id IS NOT NULL`);

      // Matching happens HERE, never by comparing tal_person.primary_email to a form field.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_person_identifier (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id   UUID NOT NULL,
        kind        TEXT NOT NULL,
        value_norm  TEXT NOT NULL,
        source_id   UUID,
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_person_ident_uq
        ON tal_person_identifier (kind, value_norm, person_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_person_ident_lookup
        ON tal_person_identifier (kind, value_norm)`);

      // PROPOSED merges only. Nothing applies one unattended — spec F2.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_person_merge (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        keep_person_id  UUID NOT NULL,
        merge_person_id UUID NOT NULL,
        confidence      NUMERIC(4,3),
        evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
        status          TEXT NOT NULL DEFAULT 'proposed',
        decided_by      UUID,
        decided_at      TIMESTAMPTZ,
        reason          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_person_merge_status_idx
        ON tal_person_merge (status, created_at DESC)`);
      // One open proposal per pair, so a re-run of the backfill does not stack duplicates in the queue.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_person_merge_open_uq
        ON tal_person_merge (keep_person_id, merge_person_id) WHERE status = 'proposed'`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_candidate_profile (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id      UUID NOT NULL UNIQUE,
        candidate_code TEXT NOT NULL UNIQUE,
        headline       TEXT,
        education      JSONB NOT NULL DEFAULT '[]'::jsonb,
        experience     JSONB NOT NULL DEFAULT '[]'::jsonb,
        skills         JSONB NOT NULL DEFAULT '[]'::jsonb,
        portfolio_url  TEXT,
        talent_pool    BOOLEAN NOT NULL DEFAULT FALSE,
        consent_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // Identifier counters. The UNIQUE index on each code column is the real guarantee; this table
      // is the allocator. Counter-without-constraint produces duplicates under concurrency.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_id_series (
        series     TEXT PRIMARY KEY,
        period     TEXT NOT NULL DEFAULT '',
        next_value BIGINT NOT NULL DEFAULT 1,
        pad_width  INT NOT NULL DEFAULT 6,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`ALTER TABLE tal_id_series ADD COLUMN IF NOT EXISTS period TEXT NOT NULL DEFAULT ''`);
    } catch (e: any) {
      console.error('[talent-schema] person: ' + reasonOf(e));
      throw e;
    }

    try {
      // -------------------------------------------------------------------------------------
      // RECRUITMENT SOURCES — spec 26.2. PROVENANCE. src/lib/application-sources.ts keeps
      // ATTRIBUTION ("how did you hear about us") and the two are never merged — spec F5.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_recruitment_source (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        category    TEXT NOT NULL DEFAULT 'other',
        ingest_mode TEXT NOT NULL DEFAULT 'manual',
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_by  UUID,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // The secret is never stored. Same shape as the mailapi key model already in this tree.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_source_key (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id  UUID NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash   TEXT NOT NULL,
        scopes     JSONB NOT NULL DEFAULT '[]'::jsonb,
        revoked_at TIMESTAMPTZ,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_source_key_prefix_uq ON tal_source_key (key_prefix)`);

      // (source, external id) is UNIQUE: a re-delivered webhook updates, it never creates a second
      // candidate — spec 15 rule 1.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_external_application_ref (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id               UUID NOT NULL,
        external_application_id TEXT NOT NULL,
        application_id          UUID,
        person_id               UUID,
        raw_payload             JSONB,
        ingested_by             UUID,
        ingested_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_ext_app_uq
        ON tal_external_application_ref (source_id, external_application_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_ext_app_person_idx
        ON tal_external_application_ref (person_id)`);

      // Malformed payloads are quarantined, never dropped — spec 15 failure states.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_ingest_quarantine (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id   UUID,
        reason      TEXT NOT NULL,
        raw_payload JSONB,
        replayed_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    } catch (e: any) {
      console.error('[talent-schema] sources: ' + reasonOf(e));
      throw e;
    }

    try {
      // -------------------------------------------------------------------------------------
      // OPPORTUNITY AND PIPELINE — spec 26.3.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_pipeline (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug       TEXT NOT NULL,
        name       TEXT NOT NULL,
        version    INT NOT NULL DEFAULT 1,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_pipeline_slug_ver_uq ON tal_pipeline (slug, version)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_pipeline_stage (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pipeline_id     UUID NOT NULL,
        ordinal         INT NOT NULL,
        key             TEXT NOT NULL,
        label           TEXT NOT NULL,
        candidate_blurb TEXT NOT NULL,
        stage_type      TEXT NOT NULL,
        owner_role      TEXT,
        sla_hours       INT,
        is_terminal     BOOLEAN NOT NULL DEFAULT FALSE,
        config          JSONB NOT NULL DEFAULT '{}'::jsonb
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_pipeline_stage_uq ON tal_pipeline_stage (pipeline_id, ordinal)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_pipeline_stage_key_uq ON tal_pipeline_stage (pipeline_id, key)`);

      // department_id TEXT. See rule 1 at the top of this file.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_opportunity (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opportunity_code            TEXT NOT NULL UNIQUE,
        position_id                 UUID,
        department_id               TEXT NOT NULL,
        role_id                     UUID,
        title                       TEXT NOT NULL,
        employment_type             TEXT NOT NULL,
        level                       TEXT,
        headcount                   INT,
        eligible_identity_types     JSONB NOT NULL DEFAULT '[]'::jsonb,
        internal_visible_to_manager BOOLEAN NOT NULL DEFAULT FALSE,
        pipeline_id                 UUID NOT NULL,
        pipeline_version            INT NOT NULL DEFAULT 1,
        hiring_manager_id           UUID,
        compensation_kind           TEXT NOT NULL DEFAULT 'unpaid',
        compensation_note           TEXT,
        onboarding_pack             TEXT,
        status                      TEXT NOT NULL DEFAULT 'draft',
        deadline_at                 TIMESTAMPTZ,
        published_at                TIMESTAMPTZ,
        closed_at                   TIMESTAMPTZ,
        created_by                  UUID,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_opp_status_idx ON tal_opportunity (status, deadline_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_opp_dept_idx ON tal_opportunity (department_id, status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_opp_hm_idx ON tal_opportunity (hiring_manager_id, status)`);

      // Evaluator and interviewer assignment. Attribute-scoped access (spec 21.1) reads this.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_opportunity_evaluator (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opportunity_id UUID NOT NULL,
        user_id        UUID NOT NULL,
        assign_role    TEXT NOT NULL DEFAULT 'evaluator',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_opp_eval_uq
        ON tal_opportunity_evaluator (opportunity_id, user_id, assign_role)`);
    } catch (e: any) {
      console.error('[talent-schema] opportunity: ' + reasonOf(e));
      throw e;
    }

    try {
      // -------------------------------------------------------------------------------------
      // APPLICATION, STAGES, EVALUATION — spec 26.4.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_application (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_code      TEXT NOT NULL UNIQUE,
        person_id             UUID NOT NULL,
        opportunity_id        UUID NOT NULL,
        legacy_application_id UUID,
        source_id             UUID,
        status                TEXT NOT NULL DEFAULT 'application_received',
        current_stage_key     TEXT,
        pipeline_id           UUID NOT NULL,
        pipeline_version      INT NOT NULL DEFAULT 1,
        is_internal           BOOLEAN NOT NULL DEFAULT FALSE,
        submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at             TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // One person applies to one opportunity once. Spec 27 cardinality.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_app_person_opp_uq
        ON tal_application (person_id, opportunity_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_app_status_idx ON tal_application (status, submitted_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_app_opp_idx ON tal_application (opportunity_id, status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_app_legacy_idx ON tal_application (legacy_application_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_application_stage (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL,
        stage_key      TEXT NOT NULL,
        ordinal        INT NOT NULL,
        entered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        due_at         TIMESTAMPTZ,
        completed_at   TIMESTAMPTZ,
        outcome        TEXT,
        owner_user_id  UUID,
        note           TEXT,
        actor_user_id  UUID
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_app_stage_idx ON tal_application_stage (application_id, ordinal)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_app_stage_sla_idx
        ON tal_application_stage (due_at) WHERE completed_at IS NULL`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_evaluation (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id    UUID NOT NULL,
        stage_key         TEXT NOT NULL,
        evaluation_type   TEXT NOT NULL,
        evaluator_user_id UUID,
        rubric            JSONB NOT NULL DEFAULT '{}'::jsonb,
        scores            JSONB NOT NULL DEFAULT '{}'::jsonb,
        total_score       NUMERIC(6,2),
        recommendation    TEXT,
        comments          TEXT,
        is_automated      BOOLEAN NOT NULL DEFAULT FALSE,
        status            TEXT NOT NULL DEFAULT 'pending',
        submitted_at      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_eval_app_idx ON tal_evaluation (application_id, evaluation_type)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_eval_pending_idx ON tal_evaluation (status, evaluator_user_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_interview (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id   UUID NOT NULL,
        stage_key        TEXT NOT NULL,
        scheduled_at     TIMESTAMPTZ,
        duration_minutes INT,
        mode             TEXT,
        panel            JSONB NOT NULL DEFAULT '[]'::jsonb,
        outcome          TEXT,
        notes            TEXT,
        recorded_by      UUID,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_interview_app_idx ON tal_interview (application_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_interview_pending_idx
        ON tal_interview (scheduled_at) WHERE outcome IS NULL`);

      // decided_by_user_id is NOT NULL. There is no automated-selection path — spec F12.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_selection_decision (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        selection_code            TEXT NOT NULL UNIQUE,
        application_id            UUID NOT NULL UNIQUE,
        person_id                 UUID NOT NULL,
        opportunity_id            UUID NOT NULL,
        decision                  TEXT NOT NULL,
        reason                    TEXT NOT NULL,
        decided_by_user_id        UUID NOT NULL,
        decided_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        position_id               UUID,
        department_id             TEXT,
        employment_type           TEXT,
        level                     TEXT,
        reporting_manager_user_id UUID,
        proposed_joining_date     DATE,
        compensation_note         TEXT,
        approved_for_onboarding_at TIMESTAMPTZ,
        approved_for_onboarding_by UUID,
        withdrawn_at              TIMESTAMPTZ,
        withdrawn_reason          TEXT
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_sel_decision_idx ON tal_selection_decision (decision, decided_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_sel_person_idx ON tal_selection_decision (person_id)`);
    } catch (e: any) {
      console.error('[talent-schema] application: ' + reasonOf(e));
      throw e;
    }

    try {
      // -------------------------------------------------------------------------------------
      // ONBOARDING — spec 26.5. The secret is NEVER stored; code_hash is.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_onboarding_code (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code_id             TEXT NOT NULL UNIQUE,
        code_prefix         TEXT NOT NULL,
        code_hash           TEXT NOT NULL,
        selection_id        UUID NOT NULL,
        person_id           UUID NOT NULL,
        bound_email_norm    TEXT NOT NULL,
        opportunity_id      UUID NOT NULL,
        position_id         UUID,
        department_id       TEXT,
        employment_type     TEXT,
        max_uses            INT NOT NULL DEFAULT 1,
        used_count          INT NOT NULL DEFAULT 0,
        requires_identity_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
        valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_until         TIMESTAMPTZ NOT NULL,
        status              TEXT NOT NULL DEFAULT 'active',
        multi_use_reason    TEXT,
        issued_by           UUID NOT NULL,
        issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at        TIMESTAMPTZ,
        delivery_channel    TEXT,
        delivery_error      TEXT,
        revoked_by          UUID,
        revoked_at          TIMESTAMPTZ,
        revoked_reason      TEXT,
        supersedes_code_id  UUID,
        failed_attempts     INT NOT NULL DEFAULT 0
      )`);
      // ONE ACTIVE CODE PER SELECTION, enforced by the database — spec 16.7 rule 4. Reissue revokes
      // first; two live secrets for one selection is an audit trail nobody can read.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_onbcode_active_uq
        ON tal_onboarding_code (selection_id) WHERE status = 'active'`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_onbcode_expiry_idx ON tal_onboarding_code (status, valid_until)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_onbcode_prefix_idx ON tal_onboarding_code (code_prefix)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_onboarding_code_attempt (
        id           BIGSERIAL PRIMARY KEY,
        code_id      UUID,
        code_prefix  TEXT,
        outcome      TEXT NOT NULL,
        ip_address   TEXT,
        user_agent   TEXT,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_onbattempt_ip_idx
        ON tal_onboarding_code_attempt (ip_address, attempted_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_onbattempt_code_idx
        ON tal_onboarding_code_attempt (code_id, attempted_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_onboarding_application (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        onboarding_code_id  UUID NOT NULL,
        onboarding_code_ref TEXT NOT NULL,
        selection_id        UUID NOT NULL,
        person_id           UUID NOT NULL,
        status              TEXT NOT NULL DEFAULT 'in_progress',
        form_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
        sections_complete   JSONB NOT NULL DEFAULT '[]'::jsonb,
        declarations        JSONB NOT NULL DEFAULT '{}'::jsonb,
        submitted_at        TIMESTAMPTZ,
        reviewed_by         UUID,
        reviewed_at         TIMESTAMPTZ,
        review_note         TEXT,
        approved_at         TIMESTAMPTZ,
        identity_id         UUID,
        session_token_hash  TEXT,
        session_expires_at  TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_onbapp_selection_uq ON tal_onboarding_application (selection_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_onbapp_status_idx ON tal_onboarding_application (status, submitted_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_onbapp_session_idx
        ON tal_onboarding_application (session_token_hash) WHERE session_token_hash IS NOT NULL`);

      // Document REFERENCES, not documents. The file lives in the candidate's Drive — spec F7/33.1.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_document_ref (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_kind TEXT NOT NULL,
        subject_id   UUID NOT NULL,
        person_id    UUID NOT NULL,
        doc_type     TEXT NOT NULL,
        title        TEXT NOT NULL DEFAULT '',
        drive_url    TEXT NOT NULL,
        is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
        status       TEXT NOT NULL DEFAULT 'submitted',
        version      INT NOT NULL DEFAULT 1,
        replaces_id  UUID,
        expires_on   DATE,
        review_note  TEXT,
        reviewed_by  UUID,
        reviewed_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_docref_subject_idx
        ON tal_document_ref (subject_kind, subject_id, status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_docref_person_idx ON tal_document_ref (person_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_docref_expiry_idx
        ON tal_document_ref (expires_on) WHERE expires_on IS NOT NULL`);
    } catch (e: any) {
      console.error('[talent-schema] onboarding: ' + reasonOf(e));
      throw e;
    }

    try {
      // -------------------------------------------------------------------------------------
      // IDENTITY AND ACCESS — spec 26.6.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_identity (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identity_code             TEXT NOT NULL UNIQUE,
        code_series               TEXT NOT NULL,
        code_is_legacy            BOOLEAN NOT NULL DEFAULT FALSE,
        person_id                 UUID NOT NULL,
        identity_type             TEXT NOT NULL,
        employment_type           TEXT,
        user_id                   UUID,
        hr_employee_id            UUID,
        username                  TEXT,
        work_email                TEXT,
        department_id             TEXT,
        position_id               UUID,
        status                    TEXT NOT NULL DEFAULT 'invited_for_onboarding',
        start_date                DATE,
        end_date                  DATE,
        onboarding_application_id UUID,
        selection_id              UUID,
        previous_identity_id      UUID,
        status_reason             TEXT,
        created_by                UUID,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_identity_person_idx ON tal_identity (person_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_identity_status_idx ON tal_identity (status, identity_type)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_identity_dept_idx ON tal_identity (department_id, status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_identity_hr_idx ON tal_identity (hr_employee_id)`);
      // One ACTIVE identity per login account. Several over a lifetime is correct; two at once is not.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_identity_user_active_uq
        ON tal_identity (user_id) WHERE status = 'active' AND user_id IS NOT NULL`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_access_group (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key            TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        department_id  TEXT,
        classification TEXT NOT NULL DEFAULT 'internal',
        capabilities   JSONB NOT NULL DEFAULT '[]'::jsonb,
        systems        JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_access_policy (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_kind    TEXT NOT NULL,
        subject_key     TEXT NOT NULL,
        access_group_id UUID NOT NULL,
        version         INT NOT NULL DEFAULT 1,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        changed_by      UUID,
        change_reason   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_access_policy_subj_idx
        ON tal_access_policy (subject_kind, subject_key, is_active)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_access_policy_uq
        ON tal_access_policy (subject_kind, subject_key, access_group_id) WHERE is_active`);

      // A CACHE. Nightly reconciliation re-derives and reports drift — spec 23.2.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_identity_access (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identity_id     UUID NOT NULL,
        access_group_id UUID NOT NULL,
        source          TEXT NOT NULL,
        granted_by      UUID,
        reason          TEXT,
        valid_until     TIMESTAMPTZ,
        policy_version  INT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tal_identity_access_uq
        ON tal_identity_access (identity_id, access_group_id, source)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_identity_access_expiry
        ON tal_identity_access (valid_until) WHERE valid_until IS NOT NULL`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_access_request (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identity_id         UUID NOT NULL,
        access_group_id     UUID NOT NULL,
        reason              TEXT NOT NULL,
        requested_until     TIMESTAMPTZ,
        status              TEXT NOT NULL DEFAULT 'pending',
        manager_decision    JSONB,
        department_decision JSONB,
        security_decision   JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at          TIMESTAMPTZ
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_access_request_idx
        ON tal_access_request (status, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_provisioning_run (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identity_id  UUID NOT NULL,
        trigger      TEXT NOT NULL,
        proposed     JSONB NOT NULL DEFAULT '[]'::jsonb,
        diff         JSONB NOT NULL DEFAULT '{}'::jsonb,
        status       TEXT NOT NULL DEFAULT 'proposed',
        reviewed_by  UUID,
        reviewed_at  TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        failures     JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_prov_run_idx
        ON tal_provisioning_run (status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_prov_identity_idx
        ON tal_provisioning_run (identity_id, created_at DESC)`);

      // OUTBOX — spec 29. Written in the SAME transaction as the domain row, so an event is never
      // lost when the process dies between the write and the enqueue.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS tal_event (
        id            BIGSERIAL PRIMARY KEY,
        event_name    TEXT NOT NULL,
        subject_kind  TEXT NOT NULL,
        subject_id    UUID,
        payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
        actor_user_id UUID,
        occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at  TIMESTAMPTZ,
        attempts      INT NOT NULL DEFAULT 0,
        last_error    TEXT
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_event_undelivered_idx
        ON tal_event (delivered_at, id) WHERE delivered_at IS NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tal_event_subject_idx
        ON tal_event (subject_kind, subject_id, occurred_at DESC)`);
    } catch (e: any) {
      console.error('[talent-schema] identity/access: ' + reasonOf(e));
      throw e;
    }
  });
}

/**
 * ADDITIVE columns on tables this module does NOT own — spec 26.7.
 *
 * Separate ensure key, and separately catchable, for two reasons. First, ownership: `applications`,
 * `roles`, `departments` and `org_positions` belong to other modules, and a failure to extend one of
 * them must not stop the tal_* core from existing. Second, blast radius: these run against tables
 * with live production rows, so they are ADD COLUMN IF NOT EXISTS and nothing else. Nothing here
 * drops, renames or retypes a column somebody else's code reads.
 */
export function ensureTalentBridge(): Promise<void> {
  return ensureOnce(KEY_BRIDGE, async () => {
    try {
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS person_id UUID`);
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS tal_application_id UUID`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS applications_person_idx ON applications (person_id)`);
      await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS position_id UUID`);
      await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS opportunity_id UUID`);
      await db.execute(sql`ALTER TABLE departments ADD COLUMN IF NOT EXISTS parent_department_id VARCHAR(50)`);
    } catch (e: any) {
      console.error('[talent-schema] bridge: ' + reasonOf(e));
      throw e;
    }

    try {
      // org_positions is Layer 1's table (src/lib/org-graph-schema.ts:289) and it ships INACTIVE —
      // nothing imports the module, so nothing has created it. Create it here if it is absent, with
      // the SAME shape Layer 1 declares, then extend. Two definitions of one table with different
      // shapes is the exact failure db/hr-schema.sql:300 documents, so this must stay byte-compatible
      // with the org-graph declaration.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS org_positions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title         TEXT NOT NULL,
        code          TEXT,
        department_id TEXT,
        team_id       UUID,
        grade         TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_by    UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS org_positions_code_uq
        ON org_positions (code) WHERE code IS NOT NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS org_positions_dept_idx ON org_positions (department_id, is_active)`);

      // The attributes the access engine needs — spec 19.
      await db.execute(sql`ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS employment_type TEXT`);
      await db.execute(sql`ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS is_sensitive BOOLEAN NOT NULL DEFAULT FALSE`);
      await db.execute(sql`ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS headcount INT`);
      await db.execute(sql`ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS competencies JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await db.execute(sql`ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS default_pipeline_id UUID`);
      await db.execute(sql`ALTER TABLE org_positions ADD COLUMN IF NOT EXISTS onboarding_pack TEXT`);
    } catch (e: any) {
      console.error('[talent-schema] positions: ' + reasonOf(e));
      throw e;
    }
  });
}

/** Both halves. What a service entry point calls. */
export async function ensureTalent(): Promise<void> {
  await ensureTalentSchema();
  await ensureTalentBridge();
}
