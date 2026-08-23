-- db/foundational-schema.sql
-- HORIZON patch 02 — Foundational Personal Computation engine. The five fpc_ tables.
--
-- THE READABLE MIRROR of src/lib/foundational/schema.ts. That module creates these tables at
-- runtime; this file is what an operator runs by hand, because this project does not connect a
-- development process to its production database. The two must stay identical — if you change one,
-- change the other in the same commit.
--
-- SAFE TO RUN AGAINST PRODUCTION. Every statement is CREATE ... IF NOT EXISTS. Nothing here drops,
-- renames or retypes anything, and nothing here touches a table this patch does not own.
--
-- WHY subject_id IS TEXT AND HAS NO FOREIGN KEY:
-- this patch owns no identity space. A subject may be a person, an employee or a candidate, and
-- those tables are owned by other patches which disagree about their own id types. `subject_kind`
-- names whose space the id belongs to; a ::uuid cast against an id this engine did not mint is a
-- guaranteed production 500.
--
-- SENSITIVITY, TABLE BY TABLE:
--   fpc_subject_input  ENCRYPTED birth co-ordinates. The most sensitive row in the engine. The
--                      ciphertext is AES-256-GCM enveloped and bound to the subject as AAD, so a row
--                      copied onto another person's record fails to decrypt rather than quietly
--                      describing the wrong human being.
--   fpc_computation    `raw` holds the computed positions AND the normalised input; it is gated in
--                      the application layer by the same capability as `technical`.
--   fpc_factor         `technical` holds traditional framework vocabulary. Gated.
--   fpc_period         `technical` holds traditional framework vocabulary. Gated.
--   fpc_consent        the default consent register. Replaceable — see src/lib/foundational/consent.ts.

CREATE TABLE IF NOT EXISTS fpc_subject_input (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  ciphertext      JSONB NOT NULL,
  key_id          TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  time_precision  TEXT NOT NULL DEFAULT 'minute',
  consent_id      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT,
  erased_at       TIMESTAMPTZ,
  erased_by       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fpc_subject_input_uq
  ON fpc_subject_input (subject_kind, subject_id);

-- APPEND-ONLY BY CONVENTION AND BY USE: nothing in the engine updates a computation. A recomputation
-- is a new row with a new output_hash, so "what did the engine say in March" stays answerable in
-- September.
CREATE TABLE IF NOT EXISTS fpc_computation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  method_version  TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  output_hash     TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT 'initial',
  factor_count    INT NOT NULL DEFAULT 0,
  period_count    INT NOT NULL DEFAULT 0,
  method          JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fpc_computation_subject_idx
  ON fpc_computation (subject_kind, subject_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS fpc_computation_version_idx
  ON fpc_computation (subject_kind, subject_id, method_version, computed_at DESC);
CREATE INDEX IF NOT EXISTS fpc_computation_output_idx
  ON fpc_computation (output_hash);

CREATE TABLE IF NOT EXISTS fpc_factor (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  computation_id  UUID NOT NULL,
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  factor_id       TEXT NOT NULL,
  category        TEXT NOT NULL,
  code            TEXT NOT NULL,
  label           TEXT NOT NULL,
  value_text      TEXT NOT NULL,
  numeric_value   DOUBLE PRECISION,
  strength        DOUBLE PRECISION NOT NULL DEFAULT 0,
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 0,
  method_version  TEXT NOT NULL,
  source_inputs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  components      JSONB,
  technical       JSONB,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS fpc_factor_uq
  ON fpc_factor (computation_id, factor_id);
CREATE INDEX IF NOT EXISTS fpc_factor_computation_idx
  ON fpc_factor (computation_id, category, code);
CREATE INDEX IF NOT EXISTS fpc_factor_subject_idx
  ON fpc_factor (subject_kind, subject_id, code, computed_at DESC);

CREATE TABLE IF NOT EXISTS fpc_period (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  computation_id  UUID NOT NULL,
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  period_id       TEXT NOT NULL,
  level           INT NOT NULL,
  ruler_code      TEXT NOT NULL,
  chain           JSONB NOT NULL DEFAULT '[]'::jsonb,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  length_days     DOUBLE PRECISION NOT NULL DEFAULT 0,
  method_version  TEXT NOT NULL,
  technical       JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS fpc_period_uq
  ON fpc_period (computation_id, period_id);
CREATE INDEX IF NOT EXISTS fpc_period_window_idx
  ON fpc_period (subject_kind, subject_id, level, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS fpc_period_computation_idx
  ON fpc_period (computation_id, level, starts_at);

-- The default consent register. If another patch owns consent centrally, point the engine at it with
-- setConsentProvider() and leave this table empty rather than maintaining two answers to the same
-- question.
CREATE TABLE IF NOT EXISTS fpc_consent (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  granted       BOOLEAN NOT NULL DEFAULT TRUE,
  evidence_ref  TEXT NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  recorded_by   TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fpc_consent_lookup_idx
  ON fpc_consent (subject_kind, subject_id, purpose, granted_at DESC);
