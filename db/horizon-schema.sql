-- db/horizon-schema.sql — the HORIZON Human Intelligence System's own tables.
--
-- SAFE TO RUN ON PRODUCTION. Every statement is CREATE TABLE IF NOT EXISTS or CREATE INDEX IF NOT
-- EXISTS. Nothing here drops, renames or retypes anything, and nothing here touches a table another
-- module owns.
--
-- WHY THIS FILE EXISTS AT ALL. src/lib/horizon/schema.ts creates these tables itself on first use,
-- and that is what runs in practice. This is the READABLE MIRROR an operator can run by hand — the
-- established pattern on this project, because nothing here connects to the production database
-- from a development process. If you are applying a schema change to production, you are running
-- this file; you are not running a script that opens a connection for you.
--
-- GENERATED FROM src/lib/horizon/schema.ts. The two cannot drift: this file is produced from the
-- same DDL string the bootstrap sends, so a change made in one place is a change in both. If you
-- edit this file by hand, edit schema.ts to match, or the next regeneration will overwrite you.
--
-- NINE TABLES, AND THE LIST IS DELIBERATELY SHORT. The intelligence CONTENT lives in the tables of
-- whichever patch computes it and reaches a person's record through a provider
-- (src/lib/horizon/record.ts). What is stored here is only what has no other owner: the profile
-- header, the computation run, the output, its evidence, its signals, the feedback aggregation
-- ledger, the report header, the event outbox, and the log of who looked at whom.
--
--   psql "$DATABASE_URL" -f db/horizon-schema.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

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
  ON hzn_access_log (created_at DESC) WHERE succeeded = FALSE;

COMMIT;

-- WHAT IS NOT IN THIS FILE, ON PURPOSE:
--
--   NO FOREIGN KEYS to hr_employees, users, roles, departments or any tal_* table. Those tables
--   belong to other modules, and a constraint across that boundary makes one patch's migration able
--   to fail another patch's insert. Referential integrity for those columns is an application-level
--   check, in the module that owns the referenced row.
--
--   NO ::uuid CAST ANYWHERE. departments.id is varchar(50) while db/hr-schema.sql declares
--   department_id as UUID REFERENCES departments(id). They cannot both be right, and a ::uuid cast
--   against a department id is a guaranteed production 500. Every id column here that crosses a
--   module boundary is TEXT.
--
--   NO ALTER TABLE. Every table here is new. ALTER takes its ACCESS EXCLUSIVE lock BEFORE it
--   evaluates IF NOT EXISTS, and inside one transaction it holds that lock until commit — which on
--   a deploy, when every serverless instance goes cold at once, is how a schema bootstrap becomes an
--   empty connection pool and a site that answers only on the pages that never touch the database.
--   When a HORIZON table eventually needs a column, add it as a separate statement outside the
--   batch, not into this transaction.
