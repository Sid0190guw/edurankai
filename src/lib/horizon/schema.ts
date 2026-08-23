// src/lib/horizon/schema.ts — THE OWNED CONTRACT for every hzn_* table.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md section 10.
//
// ONE MODULE CREATES THESE TABLES. Not the page that happens to read them first, not each later
// patch bootstrapping its own slice. This repository has already paid for the alternative: two
// `CREATE TABLE IF NOT EXISTS` statements for one table with DIFFERENT SHAPES, where whichever ran
// second was a silent no-op and half the columns simply never existed (db/hr-schema.sql:300).
//
// A LATER HORIZON PATCH DOES NOT ADD A TABLE HERE WITHOUT SAYING SO IN docs/horizon. Nine tables is
// the whole surface, and it is small on purpose: the intelligence CONTENT lives in the tables the
// patch that computes it already owns, and reaches a record through a provider (record.ts). What is
// stored here is only what has no other owner — the run, the output, its evidence, its signals, and
// the log of who looked.
//
// FIVE RULES, ALL OF THEM SCAR TISSUE FROM THIS CODEBASE:
//
//  1. `organisation_id` and `department_id` ARE TEXT. `departments.id` is varchar(50) while
//     db/hr-schema.sql declares `department_id UUID REFERENCES departments(id)`. They cannot both be
//     right, and a `::uuid` cast against a department id is a guaranteed production 500. There is no
//     organisation table at all yet, so `organisation_id` is text with a default and no constraint.
//  2. NO FOREIGN KEY to a table whose id type is contested, and none to a table another patch owns.
//     Indexes and application-level checks, not constraints that fail to create and take the whole
//     ensure down with them.
//  3. THE ENSURE FAILS LOUDLY. ensureOnce drops a failed promise so the next call retries, and logs
//     `e.cause` — the real Postgres reason. A memoised, silently-resolved bootstrap over DDL that
//     never ran is how a write path went down here with nothing in the logs saying why.
//  4. IDEMPOTENT THROUGHOUT. Every statement is CREATE ... IF NOT EXISTS, so this is safe against an
//     environment that already has some of it.
//  5. ONE MESSAGE, NOT THIRTY. Each ensure is a single batched simple-protocol message. A round trip
//     to this database measures ~139-177ms because the functions and the database sit in different
//     regions, and ensureOnce memoises per PROCESS — so a serverless cold start pays the whole run
//     again before the page reads its first row. Thirty-one statements as thirty-one awaits is five
//     seconds of a page's budget spent before it starts.
//
// SAFE TO RUN ON PRODUCTION. It creates; it never drops, renames or retypes. db/horizon-schema.sql
// is the readable mirror an operator runs by hand — the established pattern here, because nothing in
// this project connects to the production database from a development process.

import { ensureBatch } from '@/lib/ensure-once';
import { textIn } from '@/lib/pg-array';

const KEY = 'horizon_core_v1';

/**
 * Create every hzn_* table. Call at the top of any HORIZON service entry point.
 *
 * WHAT IS DELIBERATELY NOT HERE: an ALTER TABLE. Every one of these tables is new, so nothing needs
 * altering — and that matters, because ALTER takes an ACCESS EXCLUSIVE lock BEFORE it evaluates
 * IF NOT EXISTS, and inside one batch it holds that lock until commit. A deploy makes every instance
 * cold at once; they all run this and contend on the same tables; each one blocked on a lock is also
 * holding a pooler session. That is how a schema bootstrap becomes an empty connection pool and a
 * site that answers only on the pages that never touch the database. It happened on 2026-08-23.
 * When a HORIZON table eventually needs a column, add it as a SEPARATE ensureOnce, not into this
 * batch.
 */
export function ensureHorizonSchema(): Promise<void> {
  return ensureBatch(KEY, `
    -- =========================================================================================
    -- hzn_profile — THE MASTER RECORD HEADER.
    --
    -- Deliberately almost empty. Every column is about the RECORD, not about the person: the
    -- content is composed at read time from providers (src/lib/horizon/record.ts). A column named
    -- current_rating appearing here would mean the composition has been abandoned and this is a
    -- master table again, duplicating data that already has an owner.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_profile (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id        TEXT NOT NULL DEFAULT 'org_edurankai',
      subject_kind           TEXT NOT NULL,
      subject_id             TEXT NOT NULL,
      subject_scheme         TEXT NOT NULL,
      active                 BOOLEAN NOT NULL DEFAULT TRUE,
      last_composed_at       TIMESTAMPTZ,
      recompute_requested_at TIMESTAMPTZ,
      recompute_requested_by TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- ONE HEADER PER SUBJECT PER ORGANISATION. The scheme is part of the key because an applicant
    -- anchored on tal_person and the same human anchored on an application row are two different
    -- anchors, and merging them is the identity patch's job, not an accident of a unique index.
    CREATE UNIQUE INDEX IF NOT EXISTS hzn_profile_subject_uq
      ON hzn_profile (organisation_id, subject_kind, subject_scheme, subject_id);

    -- =========================================================================================
    -- hzn_computation — ONE ROW PER RUN OF ONE ENGINE.
    --
    -- This is what makes INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
    -- reconstructable months later. inputs_digest is a hash of what went in, not the inputs
    -- themselves: an engine's inputs are a person's records, and copying them into a second table
    -- with different retention and a wider read audience is the thing this system exists to prevent.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_computation (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id TEXT NOT NULL DEFAULT 'org_edurankai',
      engine_id       TEXT NOT NULL,
      engine_class    TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      subject_kind    TEXT,
      subject_id      TEXT,
      subject_scheme  TEXT,
      trigger_event_id UUID,
      trigger_reason  TEXT,
      inputs_digest   TEXT,
      input_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
      status          TEXT NOT NULL DEFAULT 'running',
      outcome         TEXT,
      detail          TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at     TIMESTAMPTZ,
      duration_ms     INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS hzn_computation_subject_idx
      ON hzn_computation (organisation_id, subject_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS hzn_computation_engine_idx
      ON hzn_computation (engine_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS hzn_computation_open_idx
      ON hzn_computation (status) WHERE finished_at IS NULL;

    -- =========================================================================================
    -- hzn_intelligence_result — THE STANDARD OUTPUT.
    --
    -- SUPERSEDED, NEVER UPDATED IN PLACE. supersedes points at the row this one replaces and the
    -- old row's status becomes 'superseded'. A record about a person that silently changes under a
    -- decision taken on it is not auditable, and "what did this say in March" is exactly the
    -- question an appeal asks.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_intelligence_result (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id     TEXT NOT NULL DEFAULT 'org_edurankai',
      profile_id          UUID,
      subject_kind        TEXT NOT NULL,
      subject_id          TEXT NOT NULL,
      subject_scheme      TEXT NOT NULL,
      dimension_family    TEXT NOT NULL,
      dimension_key       TEXT NOT NULL,
      dimension_label     TEXT NOT NULL,
      score_kind          TEXT NOT NULL,
      score_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence_band     TEXT NOT NULL,
      confidence_value    NUMERIC(5,4),
      confidence_basis    TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'active',
      summary             TEXT NOT NULL,
      source_breakdown    JSONB NOT NULL DEFAULT '[]'::jsonb,
      computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stale_at            TIMESTAMPTZ NOT NULL,
      recompute_after_days INTEGER NOT NULL DEFAULT 30,
      computation_id      UUID NOT NULL,
      engine_id           TEXT NOT NULL,
      engine_class        TEXT NOT NULL,
      engine_version      TEXT NOT NULL,
      human_review_status TEXT NOT NULL DEFAULT 'not_required',
      layer               TEXT NOT NULL,
      decision_use        TEXT NOT NULL,
      scientific_status   TEXT NOT NULL,
      supersedes          UUID,
      unreadable          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- THE READ EVERY SCREEN MAKES: the active results for this person, newest first.
    CREATE INDEX IF NOT EXISTS hzn_result_subject_idx
      ON hzn_intelligence_result (organisation_id, subject_id, status, computed_at DESC);
    CREATE INDEX IF NOT EXISTS hzn_result_dimension_idx
      ON hzn_intelligence_result (organisation_id, dimension_family, dimension_key, status);
    CREATE INDEX IF NOT EXISTS hzn_result_computation_idx
      ON hzn_intelligence_result (computation_id);
    -- THE REVIEW QUEUE. Partial, because the rows that need a human are a tiny minority and a full
    -- index on a status column that is almost always the same value earns nothing.
    CREATE INDEX IF NOT EXISTS hzn_result_review_idx
      ON hzn_intelligence_result (organisation_id, human_review_status, computed_at DESC)
      WHERE human_review_status IN ('pending', 'in_review');

    -- =========================================================================================
    -- hzn_evidence — WHAT AN OUTPUT RESTS ON.
    --
    -- NOT A FORK OF capability_evidence (src/lib/evidence-graph.ts). That table answers "why does the
    -- system believe this person has this SKILL". This one answers "what did this intelligence
    -- output rest on", and one of the things it may rest on is a capability_evidence row, cited by
    -- reference: source_type = 'capability_evidence', source_id = that row's id. No copy is made.
    --
    -- collected_under HAS NO VALUE MEANING "COVERTLY". Rule 26 is enforced by the vocabulary having
    -- no member for it, and by the application-level check in types.ts validateEvidence().
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_evidence (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id     TEXT NOT NULL DEFAULT 'org_edurankai',
      result_id           UUID,
      signal_id           UUID,
      source_type         TEXT NOT NULL,
      source_id           TEXT NOT NULL,
      occurred_at         TIMESTAMPTZ NOT NULL,
      relevance_value     NUMERIC(5,4) NOT NULL,
      relevance_band      TEXT NOT NULL,
      relevance_basis     TEXT NOT NULL,
      reliability_value   NUMERIC(5,4) NOT NULL,
      reliability_band    TEXT NOT NULL,
      reliability_basis   TEXT NOT NULL,
      summary             TEXT NOT NULL,
      evidence_class      TEXT NOT NULL,
      layer               TEXT NOT NULL,
      collected_under     TEXT NOT NULL,
      owner_module        TEXT NOT NULL,
      source_table        TEXT NOT NULL,
      record_id           TEXT NOT NULL,
      locator             TEXT,
      document_url        TEXT,
      unreadable          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS hzn_evidence_result_idx ON hzn_evidence (result_id);
    CREATE INDEX IF NOT EXISTS hzn_evidence_signal_idx ON hzn_evidence (signal_id);
    CREATE INDEX IF NOT EXISTS hzn_evidence_source_idx ON hzn_evidence (source_type, source_id);

    -- =========================================================================================
    -- hzn_signal — SOMETHING MAY DESERVE ATTENTION.
    --
    -- expires_at IS NOT NULL. A signal that never expires is a permanent mark on a person, and
    -- nothing in this schema lets one be created.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_signal (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id       TEXT NOT NULL DEFAULT 'org_edurankai',
      subject_kind          TEXT NOT NULL,
      subject_id            TEXT NOT NULL,
      subject_scheme        TEXT NOT NULL,
      category              TEXT NOT NULL,
      severity              TEXT NOT NULL,
      title                 TEXT NOT NULL,
      explanation           TEXT NOT NULL,
      source_types          JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidence_band       TEXT NOT NULL,
      confidence_value      NUMERIC(5,4),
      confidence_basis      TEXT NOT NULL,
      recommended_actions   JSONB NOT NULL DEFAULT '[]'::jsonb,
      human_review_required BOOLEAN NOT NULL DEFAULT FALSE,
      layer                 TEXT NOT NULL,
      decision_use          TEXT NOT NULL,
      computation_id        UUID,
      status                TEXT NOT NULL DEFAULT 'open',
      resolution            TEXT,
      resolved_by_kind      TEXT,
      resolved_by_id        TEXT,
      resolved_reason       TEXT,
      generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at            TIMESTAMPTZ NOT NULL,
      resolved_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- THE OPEN QUEUE, which is the only read anybody makes often.
    CREATE INDEX IF NOT EXISTS hzn_signal_open_idx
      ON hzn_signal (organisation_id, status, severity, generated_at DESC)
      WHERE status IN ('open', 'acknowledged', 'in_progress');
    CREATE INDEX IF NOT EXISTS hzn_signal_subject_idx
      ON hzn_signal (organisation_id, subject_id, generated_at DESC);
    -- THE EXPIRY SWEEP reads this and nothing else.
    CREATE INDEX IF NOT EXISTS hzn_signal_expiry_idx
      ON hzn_signal (expires_at) WHERE resolved_at IS NULL;

    -- =========================================================================================
    -- hzn_feedback_contribution — THE AGGREGATION LEDGER.
    --
    -- HORIZON STORES NO FEEDBACK BODY. The words a human wrote stay in the module that collected
    -- them (src/lib/interview-feedback.ts, src/lib/performance.ts, whatever comes later), under that
    -- module's access rules. This row carries the normalised value, who gave it, and in what
    -- relationship — which is exactly what rules 24 and 25 need and nothing more.
    --
    -- ANONYMITY IS A RENDERING DECISION, NOT A STORAGE ONE. contributor_id is always recorded.
    -- Bias detection over contributions with no contributor is impossible, and a system that cannot
    -- tell whether one person filed nine of the eleven ratings has no business aggregating them.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_feedback_contribution (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id  TEXT NOT NULL DEFAULT 'org_edurankai',
      feedback_id      TEXT NOT NULL,
      owner_module     TEXT NOT NULL,
      subject_kind     TEXT NOT NULL,
      subject_id       TEXT NOT NULL,
      subject_scheme   TEXT NOT NULL,
      dimension_family TEXT NOT NULL,
      dimension_key    TEXT NOT NULL,
      contributor_kind TEXT NOT NULL,
      contributor_id   TEXT NOT NULL,
      relationship     TEXT NOT NULL,
      normalised_value NUMERIC(5,4) NOT NULL,
      raw_value        TEXT NOT NULL,
      raw_scale        TEXT NOT NULL,
      submitted_at     TIMESTAMPTZ NOT NULL,
      superseded_by    UUID,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- ONE LEDGER ROW PER FEEDBACK ROW PER DIMENSION. A feedback form that rates four dimensions
    -- makes four rows; submitting it twice must not make eight.
    CREATE UNIQUE INDEX IF NOT EXISTS hzn_feedback_contribution_uq
      ON hzn_feedback_contribution (owner_module, feedback_id, dimension_key);
    CREATE INDEX IF NOT EXISTS hzn_feedback_subject_idx
      ON hzn_feedback_contribution (organisation_id, subject_id, dimension_key);
    CREATE INDEX IF NOT EXISTS hzn_feedback_contributor_idx
      ON hzn_feedback_contribution (organisation_id, contributor_id, submitted_at DESC);

    -- =========================================================================================
    -- hzn_report — WHAT WAS SHOWN, TO WHOM, MADE OF WHAT.
    --
    -- The header only. The rendering belongs to the reporting patch. What is stored is the thing an
    -- appeal needs: which results this reader was actually shown, on what date, in what audience
    -- view — because "the report said X" is unanswerable if the report was regenerated since.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_report (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id  TEXT NOT NULL DEFAULT 'org_edurankai',
      subject_kind     TEXT NOT NULL,
      subject_id       TEXT NOT NULL,
      subject_scheme   TEXT NOT NULL,
      audience         TEXT NOT NULL,
      purpose          TEXT,
      requested_by_kind TEXT NOT NULL,
      requested_by_id  TEXT NOT NULL,
      result_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
      signal_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
      computation_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
      withheld         JSONB NOT NULL DEFAULT '[]'::jsonb,
      as_of            TIMESTAMPTZ,
      generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS hzn_report_subject_idx
      ON hzn_report (organisation_id, subject_id, generated_at DESC);

    -- =========================================================================================
    -- hzn_event — THE TRANSACTIONAL OUTBOX.
    --
    -- The event is recorded next to the fact that caused it, and delivery is a separate retried
    -- pass. On this platform the function can be frozen the instant the response is written, so a
    -- module that writes its row and then emits has a window in which the fact exists and nothing
    -- downstream ever hears about it.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_event (
      id              UUID PRIMARY KEY,
      organisation_id TEXT NOT NULL DEFAULT 'org_edurankai',
      type            TEXT NOT NULL,
      version         INTEGER NOT NULL DEFAULT 1,
      occurred_at     TIMESTAMPTZ NOT NULL,
      subject_kind    TEXT,
      subject_id      TEXT,
      subject_scheme  TEXT,
      actor_kind      TEXT,
      actor_id        TEXT,
      actor_name      TEXT,
      correlation_id  TEXT,
      causation_id    UUID,
      payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts        INTEGER NOT NULL DEFAULT 0,
      claimed_at      TIMESTAMPTZ,
      delivered_at    TIMESTAMPTZ,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- THE DRAIN'S ONLY QUERY. Partial on undelivered, because the table is almost entirely delivered
    -- rows within a day and an index over those earns nothing.
    CREATE INDEX IF NOT EXISTS hzn_event_pending_idx
      ON hzn_event (created_at) WHERE delivered_at IS NULL;
    CREATE INDEX IF NOT EXISTS hzn_event_type_idx ON hzn_event (type, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS hzn_event_subject_idx ON hzn_event (subject_id, occurred_at DESC);
    -- THE STUCK QUEUE, for the ops screen. Also partial: this should always be empty.
    CREATE INDEX IF NOT EXISTS hzn_event_stuck_idx
      ON hzn_event (attempts, created_at) WHERE delivered_at IS NULL AND attempts >= 5;

    -- =========================================================================================
    -- hzn_access_log — WHO LOOKED AT WHOM, AND WHY.
    --
    -- SEPARATE FROM audit_log DELIBERATELY. audit_log records ACTS on entities and is written by 454
    -- call sites across this codebase; this table records READS OF A PERSON'S INTELLIGENCE RECORD,
    -- which has a different retention need, a different read audience, and a rule audit_log does not
    -- carry: for most audiences the row must be written BEFORE anything renders, and a failure to
    -- write it refuses the response.
    --
    -- omitted RECORDS WHAT THE READER DID NOT SEE. The reader was not told; the auditor is.
    -- =========================================================================================
    CREATE TABLE IF NOT EXISTS hzn_access_log (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id   TEXT NOT NULL DEFAULT 'org_edurankai',
      actor_kind        TEXT NOT NULL,
      actor_id          TEXT NOT NULL,
      actor_name        TEXT,
      subject_kind      TEXT NOT NULL,
      subject_id        TEXT NOT NULL,
      subject_scheme    TEXT NOT NULL,
      audience          TEXT NOT NULL,
      visibility_served TEXT NOT NULL,
      purpose           TEXT,
      request_id        TEXT NOT NULL,
      omitted           JSONB NOT NULL DEFAULT '[]'::jsonb,
      succeeded         BOOLEAN NOT NULL DEFAULT TRUE,
      refusal_reason    TEXT,
      ip_address        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- "WHO HAS LOOKED AT MY RECORD" — the read a subject is entitled to make about themselves.
    CREATE INDEX IF NOT EXISTS hzn_access_subject_idx
      ON hzn_access_log (organisation_id, subject_id, created_at DESC);
    -- "WHAT HAS THIS PERSON BEEN LOOKING AT" — the read an investigation makes.
    CREATE INDEX IF NOT EXISTS hzn_access_actor_idx
      ON hzn_access_log (organisation_id, actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS hzn_access_refused_idx
      ON hzn_access_log (created_at DESC) WHERE succeeded = FALSE
  `);
}

/** The tables this module owns. Exported so an ops screen and a test can both check for them. */
export const HORIZON_TABLES: readonly string[] = Object.freeze([
  'hzn_profile',
  'hzn_computation',
  'hzn_intelligence_result',
  'hzn_evidence',
  'hzn_signal',
  'hzn_feedback_contribution',
  'hzn_report',
  'hzn_event',
  'hzn_access_log',
]);

export interface SchemaReport {
  ok: boolean;
  present: string[];
  missing: string[];
  /** Present when the check itself could not run. Distinguished from "the tables are missing". */
  unreadable?: string;
}

/**
 * Which HORIZON tables actually exist.
 *
 * "NOTHING ON RECORD" IS NOT THE SAME AS "WE COULD NOT READ IT". A bootstrap endpoint in this
 * repository once reported `ok: true, ran: 8, failed: 0` while the health check said ten tables were
 * missing, because every ensure had thrown into a swallow. So a failed check returns `unreadable`
 * rather than an empty `present` list that reads as a catastrophe.
 *
 * The database handle is resolved lazily, so importing this module costs no connection.
 */
export async function verifyHorizonSchema(): Promise<SchemaReport> {
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const res: any = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ${textIn(HORIZON_TABLES as string[])}`);
    const rows = Array.isArray(res) ? res : (res?.rows || []);
    const present = rows.map((r: any) => String(r.table_name));
    const missing = HORIZON_TABLES.filter((t) => !present.includes(t));
    return { ok: missing.length === 0, present, missing: missing.slice() };
  } catch (e: any) {
    return {
      ok: false,
      present: [],
      missing: HORIZON_TABLES.slice(),
      unreadable: String(e?.cause?.message || e?.message || e),
    };
  }
}
