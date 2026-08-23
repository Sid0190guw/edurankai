// src/lib/intelligence/schema.ts — THE THREE TABLES PATCH 15 OWNS, AND THE MANY IT DOES NOT.
//
// =================================================================================================
// WHY ONLY THREE
// =================================================================================================
//
// The personal intelligence portal is a VIEW over records other modules already own. It creates a
// table only where it holds something that exists nowhere else in this codebase, and each of the
// three holds something THE EMPLOYEE AUTHORED OR DECIDED:
//
//   emp_intel_reflection   their own words about their own work
//   emp_intel_consent      their decision about a named processing purpose, append-only
//   emp_intel_correction   their statement that a record is wrong, and what it should say
//
// Everything else is read from the owning module. In particular:
//
//   WHO LOOKED AT MY RECORD   is audit_log, through src/lib/audit.ts. A second access log would be
//                             a second, disagreeing answer to the same question, and the one that
//                             disagreed would be the one on the employee's screen.
//   MY SKILLS, GOALS,         hr_employee_skills, hr_goals, hr_feedback, hr_reviews,
//   FEEDBACK, REVIEWS,        hr_learning_assignments, eims_evidence — all owned elsewhere and all
//   LEARNING, EVIDENCE        read through their modules' exported functions.
//
// =================================================================================================
// ONE ROUND TRIP, NOT TWELVE
// =================================================================================================
//
// There are no migrations on this project; everything is CREATE TABLE IF NOT EXISTS run at most once
// per process. Measured from the deployed function a round trip to the database costs ~177ms, so the
// statements go out as one batch through ensureBatch() rather than as twelve awaits. ensureBatch
// wraps them in an explicit transaction with a 3s lock_timeout, because an ALTER takes its exclusive
// lock before it evaluates IF NOT EXISTS and a batch holds every lock it takes until commit.
//
// NO try/catch HERE, on purpose. ensureBatch lets the failure reach ensureOnce, which drops its
// cache entry so the next request retries, then logs the real Postgres reason off e.cause and
// resolves. Wrapping it locally would swallow the throw that makes the retry happen. Every caller
// below already tolerates a missing table — that tolerance is the reason the swallow is safe — so a
// failed bootstrap costs a section that reports it could not be read, never a page that will not
// load. SCHEMA_BOOTSTRAP=off turns the whole thing into a resolved promise without a deploy.
import { ensureBatch } from '@/lib/ensure-once';

export const INTELLIGENCE_TABLES = [
  'emp_intel_reflection',
  'emp_intel_consent',
  'emp_intel_correction',
] as const;

/**
 * NO FOREIGN KEY TO hr_employees ON emp_intel_consent, DELIBERATELY.
 *
 * The other two cascade: a reflection and a correction request are about a live employment record
 * and have no meaning without it. A consent decision does not work that way — it is the evidence
 * that a person was asked and what they answered, and it has to survive the record it was about.
 * ON DELETE CASCADE on a consent table means the proof of consent disappears at exactly the moment
 * somebody would want to check it.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS emp_intel_reflection (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  user_id UUID,
  prompt_key VARCHAR(48) NOT NULL DEFAULT 'free',
  body TEXT NOT NULL,
  -- The employee's own one-word summary of how the period went. Their vocabulary, from a fixed
  -- supportive list, and never interpreted: nothing in this codebase reads it as a signal, scores
  -- it, or aggregates it. It is there so a person scanning six months of their own entries can find
  -- the one they are looking for.
  period_word VARCHAR(24),
  -- FALSE unless the person chooses otherwise, on every row, every time. There is no setting that
  -- makes new reflections shared by default.
  shared_with_manager BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emp_intel_refl_emp_idx ON emp_intel_reflection (employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS emp_intel_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  -- One of INTELLIGENCE_PURPOSES in ./consent.ts. Not a CHECK constraint: the vocabulary is code,
  -- and a purpose retired in code must still be readable in the history it appears in.
  purpose_key VARCHAR(64) NOT NULL,
  granted BOOLEAN NOT NULL,
  -- The account that made the decision. For a self-service decision this is the employee's own
  -- account and decided_by_self is true; the column exists so a decision recorded on somebody's
  -- behalf can never be mistaken for one they made.
  decided_by_user_id UUID,
  decided_by_self BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emp_intel_consent_emp_idx ON emp_intel_consent (employee_id, purpose_key, created_at DESC);

CREATE TABLE IF NOT EXISTS emp_intel_correction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  user_id UUID,
  -- Which section of the personal view the disputed statement appeared under, and the insight key
  -- within it. Together they identify the exact sentence, so the person handling it reads what the
  -- employee read rather than guessing.
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
`;

export function ensureIntelligenceSchema(): Promise<void> {
  return ensureBatch('emp_intel_v1', DDL);
}
