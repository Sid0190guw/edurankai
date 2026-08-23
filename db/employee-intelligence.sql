-- db/employee-intelligence.sql — PATCH 15, Employee Personal Intelligence Portal.
--
-- RUN THIS YOURSELF. Nothing in this repository connects to the production database, and the
-- application will not create these tables for you: SCHEMA_BOOTSTRAP now defaults to OFF in
-- production (src/lib/ensure-once.ts), precisely so that request-path DDL cannot take the site down
-- again. Until this file has been run, /portal/employee/intelligence still LOADS — every read
-- tolerates a missing table and the sections report that they could not be read — but nothing can
-- be saved.
--
-- The same statements are in src/lib/intelligence/schema.ts, kept identical so a non-production
-- environment with SCHEMA_BOOTSTRAP unset still bootstraps itself. Idempotent: safe to run twice.
--
--   psql "$DATABASE_URL" -f db/employee-intelligence.sql
--
-- Then confirm three tables came back:
--
--   psql "$DATABASE_URL" -c "\dt emp_intel_*"

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- The employee's own words. Nothing in this codebase reads `body` as a signal, scores it, or
-- aggregates it; `period_word` is a label for the person's own scanning and is equally inert.
CREATE TABLE IF NOT EXISTS emp_intel_reflection (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  user_id UUID,
  prompt_key VARCHAR(48) NOT NULL DEFAULT 'free',
  body TEXT NOT NULL,
  period_word VARCHAR(24),
  -- FALSE on every row, every time. There is no setting that makes new entries shared by default.
  shared_with_manager BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emp_intel_refl_emp_idx ON emp_intel_reflection (employee_id, created_at DESC);

-- Consent decisions, APPEND-ONLY. A row is never updated; a withdrawal is a new row. A consent table
-- that overwrites cannot answer "was this person opted in on the day their record was used", which
-- is the only question a consent record exists to answer.
--
-- NO FOREIGN KEY TO hr_employees, deliberately. The other two tables cascade because they are about
-- a live employment record. A consent decision is the evidence that somebody was asked and what they
-- answered, and it has to outlive the record it was about — ON DELETE CASCADE here would delete the
-- proof of consent at exactly the moment anybody wanted to check it.
CREATE TABLE IF NOT EXISTS emp_intel_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  -- One of INTELLIGENCE_PURPOSES in src/lib/intelligence/consent.ts. Not a CHECK constraint: the
  -- vocabulary lives in code, and a purpose retired from that list must still be readable in the
  -- history where it appears.
  purpose_key VARCHAR(64) NOT NULL,
  granted BOOLEAN NOT NULL,
  decided_by_user_id UUID,
  -- FALSE means somebody recorded this on the person's behalf. A decision made by a person and a
  -- decision recorded for one are different facts, and the screen prints them differently.
  decided_by_self BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emp_intel_consent_emp_idx ON emp_intel_consent (employee_id, purpose_key, created_at DESC);

-- Correction requests. The queue is the whole mechanism: nothing in the application changes a
-- disputed record, and no automatic transition exists — a named person decides, with a written
-- reason, or the row stays open.
CREATE TABLE IF NOT EXISTS emp_intel_correction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  user_id UUID,
  target_section VARCHAR(40) NOT NULL,
  target_key VARCHAR(120),
  record_says TEXT NOT NULL,
  employee_says TEXT NOT NULL,
  -- A LINK, never an upload. Same rule as everywhere else in this product.
  evidence_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
    -- open | acknowledged | corrected | declined | withdrawn
  decided_by_user_id UUID,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emp_intel_corr_emp_idx ON emp_intel_correction (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS emp_intel_corr_open_idx ON emp_intel_correction (status, created_at DESC);

COMMIT;
