-- The completion engine's state (src/lib/hr/completion-engine.ts). Idempotent and additive.
-- Normally created by the bootstrap at /admin/setup. By hand: psql -v ON_ERROR_STOP=1 -f db/completion-engine-schema.sql
CREATE TABLE IF NOT EXISTS hr_engagement_completions (
  employee_id        UUID PRIMARY KEY,
  end_date_override  DATE,
  lead_notified_at   TIMESTAMPTZ,
  lead_user_id       UUID,
  lead_decision      TEXT,
  lead_decided_at    TIMESTAMPTZ,
  lead_decided_by    UUID,
  lead_note          TEXT,
  lor_serial         TEXT,
  outcome            TEXT,
  outcome_at         TIMESTAMPTZ,
  outcome_by         UUID,
  outcome_note       TEXT,
  certificate_serial TEXT,
  criteria           JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
