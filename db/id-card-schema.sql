-- Employee ID cards (src/lib/hr/id-card.ts). Idempotent and additive: safe to run twice.
-- Normally created by the bootstrap at /admin/setup. To run by hand: psql -v ON_ERROR_STOP=1 -f db/id-card-schema.sql
-- (each statement commits on its own under psql -f; in a SQL-editor paste the whole file is one transaction).
CREATE TABLE IF NOT EXISTS hr_id_cards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial             TEXT NOT NULL UNIQUE,
  employee_id        UUID NOT NULL,
  state              TEXT NOT NULL DEFAULT 'active',
  valid_from         DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until        DATE NOT NULL,
  issued_by_user_id  UUID,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at         TIMESTAMPTZ,
  revoked_by_user_id UUID,
  revoked_reason     TEXT,
  verify_count       INT NOT NULL DEFAULT 0,
  last_verified_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_id_cards_one_active ON hr_id_cards (employee_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS hr_id_cards_emp_idx ON hr_id_cards (employee_id, issued_at DESC);
