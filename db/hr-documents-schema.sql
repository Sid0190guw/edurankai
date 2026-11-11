-- HR documents register (src/lib/hr/hr-documents-store.ts, HR_DOCUMENTS_DDL): issued experience letters,
-- no-objection certificates and relieving letters. Idempotent and additive: CREATE TABLE IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS only, no ALTER, no REFERENCES. Normally created by "Create module tables" on
-- /admin/setup. By hand, statement by statement:
--   psql -v ON_ERROR_STOP=1 -f db/hr-documents-schema.sql
-- src/lib/hr/hr-documents.test.ts fails if this file and HR_DOCUMENTS_DDL drift apart.

CREATE TABLE IF NOT EXISTS hr_issued_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial          TEXT NOT NULL UNIQUE,
  doc_type        TEXT NOT NULL,
  employee_id     UUID,
  employee_name   TEXT NOT NULL,
  employee_code   TEXT,
  recipient_email TEXT,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  html            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'issued',
  issued_by       UUID,
  issued_by_name  TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  revoked_by_name TEXT,
  revoked_reason  TEXT,
  emailed_to      TEXT,
  emailed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hr_issued_documents_issued_idx ON hr_issued_documents (issued_at DESC);
CREATE INDEX IF NOT EXISTS hr_issued_documents_employee_idx ON hr_issued_documents (employee_id);
