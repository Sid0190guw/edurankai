// src/lib/foundational/schema.ts — THE FIVE fpc_ TABLES, AND NOBODY ELSE MAY CREATE THEM.
//
// ONE MODULE CREATES THESE TABLES. Not the page that reads them first, not each service bootstrapping
// its own slice. This repository has already paid for the alternative: two `CREATE TABLE IF NOT
// EXISTS` statements for one table with DIFFERENT SHAPES, where whichever ran second was a silent
// no-op and half the columns simply never existed.
//
// WHY THESE TABLES AND NOT SOMEBODY ELSE'S:
//
//   fpc_subject_input   the birth co-ordinates, ENCRYPTED. The most sensitive row in the engine.
//   fpc_computation     one append-only header per run, with its hashes and its method manifest.
//   fpc_factor          the factors of one computation.
//   fpc_period          level-1 and level-2 cycle spans, so other patches can query a timeline in SQL.
//   fpc_consent         the default consent record — REPLACEABLE, see consent.ts.
//
// NO PERSON, EMPLOYEE OR CANDIDATE TABLE IS CREATED HERE, and no foreign key points at one. This
// patch does not own an identity space; `subject_kind` names whose space the id belongs to and
// `subject_id` is TEXT because those spaces disagree about their own id types — a `::uuid` cast
// against an id this engine did not mint is a guaranteed production 500.
//
// APPEND-ONLY WHERE IT MATTERS. A computation is never updated: a recomputation is a new row with a
// new output hash, so "what did the engine say in March" stays answerable in September. The only
// table with an UPDATE path is fpc_subject_input, because a birth time that was recorded wrongly has
// to be correctable, and fpc_consent, whose updates are confined to setting revoked_at.
//
// SAFE TO RUN ON PRODUCTION. It creates; it never drops, renames or retypes. db/foundational-schema.sql
// is the readable mirror an operator can run by hand — the established pattern here, because this
// project does not connect to the production database from a development process.
import { ensureBatch } from '@/lib/ensure-once';

// Declared before anything that reads it: `const` is not hoisted.
const KEY = 'foundational_computation_v1';

/**
 * Every statement, in ONE round trip.
 *
 * Sent as a single batch because a round trip from the deployed function costs about 177ms and this
 * bootstrap is otherwise twenty of them before the first real query. Every statement is CREATE ...
 * IF NOT EXISTS: there is no ALTER here, which is what makes the batch safe to send inside one
 * transaction — an ALTER takes its exclusive lock before it evaluates IF NOT EXISTS and holds it for
 * the length of the whole batch, and that is how a schema bootstrap took this site down.
 */
export const FOUNDATIONAL_DDL = `
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
`;

/**
 * Create every fpc_ table. Call at the top of any entry point that touches one.
 *
 * ensureOnce drops a failed promise so the next call retries, and logs the real Postgres reason —
 * e.cause.message, not e.message, which is only the failed SQL. A memoised, silently-resolved
 * bootstrap over DDL that never ran is how a write path went down here with nothing in the logs.
 */
export function ensureFoundationalSchema(): Promise<void> {
  return ensureBatch(KEY, FOUNDATIONAL_DDL);
}
