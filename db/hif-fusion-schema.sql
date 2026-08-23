-- db/hif-fusion-schema.sql
-- Dynamic Human Intelligence Fusion Engine (src/lib/fusion) — the four tables this patch owns.
--
-- RUN THIS YOURSELF. Nothing in this repository connects to the production database on your behalf,
-- and this file exists so a migration is something a human runs and can read first. The application
-- also creates these tables lazily through ensureFusionSchema(), but that path runs on a request and
-- can be switched off with SCHEMA_BOOTSTRAP=off — so this is the reliable way to have them.
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS. Running it twice changes nothing.
--
-- WHAT IS NOT HERE, AND WHY:
--   NO SIGNALS TABLE. A signal is derived from a row another module owns. Storing it here would make
--   a second copy of somebody else's record that drifts the moment theirs changes. Signals are
--   gathered on every computation and kept inside the snapshot's payload as a record of what was
--   believed at the time.
--   NO EMPLOYEE, SKILL, REVIEW OR FEEDBACK TABLE. Those have owners. This module reads through them.
--   NO DECISION TABLE. A decision is not an intelligence output. There is nowhere here to record
--   that somebody was promoted or let go, and that absence is the design.

-- -------------------------------------------------------------------------------------------------
-- 1. THE WEIGHTING IN FORCE
--
-- owner_user_id is NOT NULL on purpose. A weighting decides how every person is read, retrospectively
-- as far as anybody recomputes, without appearing on any one person's record. A change like that has
-- a name attached or it does not happen.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hif_weight_profiles (
  key             TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  owner_user_id   UUID NOT NULL,
  weights         JSONB NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------------------------------
-- 2. ONE COMPUTATION OF ONE PERSON'S PROFILE, AT ONE MOMENT
--
-- `weights` is stored ON the snapshot as well as named by key, because a stored profile can be edited
-- afterwards and a reading has to stay explainable against the weighting it was ACTUALLY produced
-- under. A snapshot that pointed only at a key would silently re-explain itself every time somebody
-- changed the policy.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hif_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  weight_profile_key  TEXT NOT NULL,
  weights             JSONB NOT NULL,
  dimensions_read     INT NOT NULL DEFAULT 0,
  signals_used        INT NOT NULL DEFAULT 0,
  signals_refused     INT NOT NULL DEFAULT 0,
  providers_missing   INT NOT NULL DEFAULT 0,
  computed_by_user_id UUID,
  reason              TEXT
);

CREATE INDEX IF NOT EXISTS hif_snapshots_emp
  ON hif_snapshots (employee_id, computed_at DESC);

-- -------------------------------------------------------------------------------------------------
-- 3. THE TEN READINGS INSIDE A SNAPSHOT — THIS IS WHAT MAKES EVOLUTION POSSIBLE
--
-- `reading` IS NULLABLE AND THAT IS THE WHOLE POINT. A dimension that could not be read has no
-- number; it does not have a zero. A NOT NULL DEFAULT 0 here would turn every absence in this system
-- into a permanent finding of zero about a person, in the storage layer, where nobody would think to
-- look for it. Zero is a finding. Absence is not.
--
-- hif_readings_evolution is the index the whole "profile evolution over time" feature rests on:
-- one person, one dimension, newest first.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hif_readings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id           UUID NOT NULL,
  employee_id           UUID NOT NULL,
  dimension             TEXT NOT NULL,
  status                TEXT NOT NULL,
  reading               INT,
  confidence_value      INT NOT NULL DEFAULT 0,
  confidence_band       TEXT NOT NULL DEFAULT 'insufficient',
  confidence_direction  TEXT NOT NULL DEFAULT 'first_reading',
  independent_sources   INT NOT NULL DEFAULT 0,
  sentence              TEXT NOT NULL,
  payload               JSONB NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS hif_readings_one
  ON hif_readings (snapshot_id, dimension);

CREATE INDEX IF NOT EXISTS hif_readings_evolution
  ON hif_readings (employee_id, dimension, computed_at DESC);

-- -------------------------------------------------------------------------------------------------
-- 4. A NAMED HUMAN'S WRITTEN RESPONSE TO A READING
--
-- NO UNIQUE CONSTRAINT ON (employee_id, dimension, author_user_id), deliberately. A person may write
-- twice, and the second note does not replace the first: "I said X in March and Y in August" is the
-- record, and collapsing it would be this module editing somebody's stated view after the fact.
--
-- THERE IS NO `weight` COLUMN AND NO `is_authoritative` COLUMN. One person's feedback never becomes
-- organisational truth, and a column that could make it so is a column somebody would eventually set.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hif_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL,
  dimension           TEXT,
  author_user_id      UUID NOT NULL,
  author_relationship TEXT,
  stance              TEXT NOT NULL,
  body                TEXT NOT NULL,
  written_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hif_notes_emp
  ON hif_notes (employee_id, written_at DESC);

-- -------------------------------------------------------------------------------------------------
-- VERIFY. Run this after the statements above; the application's /admin/hr/intelligence page runs
-- the same check and prints the result, so the two never disagree.
-- -------------------------------------------------------------------------------------------------
-- SELECT table_name, count(*) AS columns
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name IN ('hif_weight_profiles','hif_snapshots','hif_readings','hif_notes')
--  GROUP BY table_name
--  ORDER BY table_name;
