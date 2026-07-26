-- db/hr-schema.sql — the HR (HRMS) schema, in the repository.
--
-- WHY THIS FILE EXISTS
-- Most HR tables had no definition anywhere in the repo. Some were created lazily at request
-- time by ensureLeaveSchema() / ensureWalletSchema(); the rest — hr_employees, hr_attendance,
-- hr_payslips, hr_payroll_runs, hr_salary_structures, hr_clock_events, hr_daily_reports —
-- existed ONLY in the production database. The HR module could not be rebuilt from source, and
-- a new environment came up broken with errors that only appeared when someone clicked the
-- right button.
--
-- SAFE TO RUN ON PRODUCTION. Every statement is CREATE TABLE IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS — additive and idempotent, never dropping or retyping anything. On
-- the existing production database it is a no-op that simply fills in anything missing.
--
-- HOW TO APPLY
--   psql "$DATABASE_URL" -f db/hr-schema.sql
-- or, if psql is not installed (uses the app's own postgres driver):
--   node scripts/apply-sql.mjs db/hr-schema.sql --env-file .env.production --dry-run   # preview
--   node scripts/apply-sql.mjs db/hr-schema.sql --env-file .env.production             # apply
-- The runner prints the target host first — confirm it is the Supabase database, not Neon.
--
-- SCOPE NOTE. Column types here are reconstructed from how the application reads and writes
-- them, not dumped from production, so on the live database the existing column types win (the
-- IF NOT EXISTS clauses skip them). Treat this as the definition for a NEW environment and as
-- documentation for the existing one. To make it authoritative, dump production once
-- (pg_dump --schema-only -t 'hr_*') and reconcile.

-- ---------------------------------------------------------------------------
-- Departments (referenced by hr_employees.department_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  code         TEXT,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Employees — the spine of the HR module
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID,
  application_id      UUID,
  employee_code       TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  email               TEXT,
  personal_email      TEXT,
  work_email          TEXT,
  phone               TEXT,
  designation         TEXT,
  department_id       UUID REFERENCES departments(id) ON DELETE SET NULL,
  reporting_manager_id UUID,
  employment_type     TEXT,                       -- Full-time | Intern | Contract | ...
  work_mode           TEXT DEFAULT 'remote',      -- remote | onsite | hybrid
  employment_status   TEXT NOT NULL DEFAULT 'active',
  onboarding_status   TEXT NOT NULL DEFAULT 'pending',
  joining_date        DATE,
  probation_end_date  DATE,
  confirmation_date   DATE,
  exit_date           DATE,
  last_working_day    DATE,
  notice_period_days  INT,
  base_salary         NUMERIC(14,2),
  currency            TEXT NOT NULL DEFAULT 'INR',
  photo_url           TEXT,
  date_of_birth       DATE,
  gender              TEXT,
  blood_group         TEXT,
  address             TEXT,
  emergency_contact   TEXT,
  pan_number          TEXT,
  aadhaar_number      TEXT,
  uan_number          TEXT,
  esic_number         TEXT,
  bank_name           TEXT,
  bank_holder         TEXT,
  bank_account_number TEXT,
  bank_ifsc           TEXT,
  bank_branch         TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_email TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'pending';
-- Columns added as the HR module grew: fuller personal details + emergency contact
-- (admin/hr/employees/[id] and portal/profile), worker classification (admin/hr/classification),
-- and offboarding (admin/hr/employees/[id], lib/hr/sync.ts). ADD COLUMN IF NOT EXISTS, so these
-- are a no-op on the existing production table and only complete a fresh environment — where
-- their absence otherwise 500s the edit-employee, classification and offboarding screens.
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS nationality                TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_name     TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_phone    TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_relation TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS city                       TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS state                      TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS country                    TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pf_number                  TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification             TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS country_of_work            TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS engaged_via                TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification_reviewed_at TIMESTAMPTZ;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification_reviewed_by UUID;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS exit_type                  TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS exit_reason                TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS notice_served_at           TIMESTAMPTZ;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS offboarding_state          JSONB;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS relieving_letter_url       TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS notes                      TEXT;
CREATE INDEX IF NOT EXISTS hr_employees_user_idx   ON hr_employees (user_id);
CREATE INDEX IF NOT EXISTS hr_employees_active_idx ON hr_employees (is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS hr_employees_app_idx    ON hr_employees (application_id);

-- ---------------------------------------------------------------------------
-- Attendance — one row per employee per day. The (employee_id, date) uniqueness
-- is REQUIRED: clock-in, the HR grid and approved-leave marking all upsert on it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  date        DATE NOT NULL,
  clock_in    TIMESTAMPTZ,
  clock_out   TIMESTAMPTZ,
  work_hours     NUMERIC(6,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'present',   -- present | wfh | on_leave | absent | holiday
  work_mode   TEXT NOT NULL DEFAULT 'remote',
  notes       TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_attendance_emp_date_key UNIQUE (employee_id, date)
);
-- overtime_hours is summed on /admin/hr/attendance; ADD COLUMN so it exists on the pre-existing
-- production table too (the CREATE TABLE above only fills a brand-new one).
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS hr_attendance_emp_idx ON hr_attendance (employee_id, date DESC);

-- ---------------------------------------------------------------------------
-- Clock events — the raw punch log behind attendance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_clock_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL,
  event_type    TEXT NOT NULL,                   -- clock_in | clock_out | break_start | break_end
  event_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lat           NUMERIC(10,6),
  lon           NUMERIC(10,6),
  accuracy      NUMERIC(10,2),
  location_name TEXT,
  work_mode     TEXT,
  note          TEXT,
  face_photo    TEXT,
  ip_address    TEXT,
  device_info   TEXT
);
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_photo TEXT;
CREATE INDEX IF NOT EXISTS hr_clock_events_emp_idx ON hr_clock_events (employee_id, event_time DESC);

-- ---------------------------------------------------------------------------
-- Daily work reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_daily_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  report_date DATE NOT NULL,
  work_done   TEXT,
  progress    TEXT,
  blockers    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_daily_reports_emp_date_key UNIQUE (employee_id, report_date)
);

-- ---------------------------------------------------------------------------
-- Salary structures — versioned; the current one is the row with effective_to IS NULL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_salary_structures (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL,
  effective_from      DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to        DATE,
  currency            TEXT NOT NULL DEFAULT 'INR',
  basic               NUMERIC(14,2) NOT NULL DEFAULT 0,
  hra                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  da                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  special_allowance   NUMERIC(14,2) NOT NULL DEFAULT 0,
  transport_allowance NUMERIC(14,2) NOT NULL DEFAULT 0,
  medical_allowance   NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_allowances    NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_salary        NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_employee         NUMERIC(14,2) NOT NULL DEFAULT 0,
  esic_employee       NUMERIC(14,2) NOT NULL DEFAULT 0,
  professional_tax    NUMERIC(14,2) NOT NULL DEFAULT 0,
  tds                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_deductions    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_deductions    NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_salary          NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_salary_emp_idx ON hr_salary_structures (employee_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Payroll runs — one per month/year
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month            INT NOT NULL,
  year             INT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',   -- draft | approved | paid
  notes            TEXT,
  total_employees  INT NOT NULL DEFAULT 0,
  total_gross      NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_net        NUMERIC(16,2) NOT NULL DEFAULT 0,
  processed_by     UUID,
  approved_by      UUID,
  approved_at      TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_payroll_runs_period_key UNIQUE (month, year)
);

-- ---------------------------------------------------------------------------
-- Payslips — one per employee per run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_payslips (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id      UUID NOT NULL,
  employee_id         UUID NOT NULL,
  month               INT NOT NULL,
  year                INT NOT NULL,
  days_worked         NUMERIC(6,2) NOT NULL DEFAULT 0,
  days_leave          NUMERIC(6,2) NOT NULL DEFAULT 0,
  days_absent         NUMERIC(6,2) NOT NULL DEFAULT 0,
  lop_days            NUMERIC(6,2) NOT NULL DEFAULT 0,
  lop_deduction       NUMERIC(14,2) NOT NULL DEFAULT 0,
  basic               NUMERIC(14,2) NOT NULL DEFAULT 0,
  hra                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  da                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  special_allowance   NUMERIC(14,2) NOT NULL DEFAULT 0,
  transport_allowance NUMERIC(14,2) NOT NULL DEFAULT 0,
  medical_allowance   NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_allowances    NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_salary        NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_employee         NUMERIC(14,2) NOT NULL DEFAULT 0,
  esic_employee       NUMERIC(14,2) NOT NULL DEFAULT 0,
  professional_tax    NUMERIC(14,2) NOT NULL DEFAULT 0,
  tds                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_deductions    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_deductions    NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_salary          NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | paid
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_payslips_run_emp_key UNIQUE (payroll_run_id, employee_id)
);
-- Loss of pay: added after the fact, because unpaid leave and absence originally cost nothing.
ALTER TABLE hr_payslips ADD COLUMN IF NOT EXISTS lop_days      NUMERIC(6,2)  NOT NULL DEFAULT 0;
ALTER TABLE hr_payslips ADD COLUMN IF NOT EXISTS lop_deduction NUMERIC(14,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS hr_payslips_emp_idx ON hr_payslips (employee_id, year DESC, month DESC);

-- ---------------------------------------------------------------------------
-- Leave — the SINGULAR table. hr_leave_types / hr_leave_balances / hr_leave_requests
-- (plural) were an orphaned second schema with readers but no writer; every reader has been
-- repointed here. Entitlement lives in LEAVE_TYPES in src/lib/hr-leave.ts and consumption is
-- derived from this table, so there is no per-employee balance row to keep in step.
-- Also created at runtime by ensureLeaveSchema(); kept here so the schema is complete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_request (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL,
  leave_type     TEXT NOT NULL,                  -- casual | sick | earned | unpaid
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  days           INT NOT NULL,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by     UUID,
  decided_by_role TEXT,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT
);
CREATE INDEX IF NOT EXISTS hr_leave_status ON hr_leave_request (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS hr_leave_emp    ON hr_leave_request (employee_id, start_date DESC);

-- ---------------------------------------------------------------------------
-- Wallet / payouts — also created at runtime by ensureWalletSchema()
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_wallet_txn (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  direction   TEXT NOT NULL,                    -- credit | debit
  amount      NUMERIC(14,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  kind        TEXT NOT NULL DEFAULT 'adjustment', -- salary | bonus | reimbursement | withdrawal | adjustment
  ref         TEXT, note TEXT, created_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_wallet_txn_emp ON hr_wallet_txn (employee_id, created_at DESC);
-- Payroll credits carry ref 'payslip:<id>'; this makes the idempotency check an index lookup
-- and is what stops a re-clicked "Mark Paid" from paying a run twice.
CREATE INDEX IF NOT EXISTS hr_wallet_txn_ref ON hr_wallet_txn (ref);

CREATE TABLE IF NOT EXISTS hr_bank_account (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL,
  holder         TEXT NOT NULL,
  account_number TEXT NOT NULL,
  ifsc           TEXT NOT NULL DEFAULT '',
  bank_name      TEXT NOT NULL DEFAULT '',
  upi_id         TEXT NOT NULL DEFAULT '',
  is_primary     BOOLEAN NOT NULL DEFAULT TRUE,
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  rzp_fund_account_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_withdrawal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL,
  amount          NUMERIC(14,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  bank_account_id UUID,
  method          TEXT NOT NULL DEFAULT 'bank',
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid | failed
  note            TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by      UUID, decided_by_role TEXT, decided_at TIMESTAMPTZ, decision_note TEXT,
  payout_ref      TEXT, paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hr_withdrawal_status ON hr_withdrawal (status, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Time logs — per-period work entries an employee books against a day. Read on
-- /admin/hr/attendance (UNGUARDED — a fresh DB without this table 500s that page) and written
-- from /portal/employee. start_time / end_time are "HH:MM" strings parsed client-side.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_time_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  log_date    DATE NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  hours       NUMERIC(6,2) NOT NULL DEFAULT 0,
  task        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_time_logs_emp_date_idx ON hr_time_logs (employee_id, log_date);

-- ---------------------------------------------------------------------------
-- Task log — end-of-day task summary captured at clock-out. Self-bootstrapped by
-- portal/employee.astro; defined here so the schema is complete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_task_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  log_date    DATE NOT NULL,
  task        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'done',
  percent     INT NOT NULL DEFAULT 100,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_task_log_emp_date_idx ON hr_task_log (employee_id, log_date);

-- ---------------------------------------------------------------------------
-- Performance reviews — cycles + one review row per (cycle, employee). The auto-seed inserts a
-- row per active employee with ON CONFLICT (cycle_id, employee_id), so that pair MUST be unique.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_review_cycles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  period_start DATE,
  period_end   DATE,
  review_type  TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft | active | closed
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_performance_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          UUID NOT NULL,
  employee_id       UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | submitted
  overall_rating    NUMERIC(5,2),
  goals_score       NUMERIC(5,2),
  skills_score      NUMERIC(5,2),
  attitude_score    NUMERIC(5,2),
  strengths         TEXT,
  improvements      TEXT,
  goals_next        TEXT,
  reviewer_comments TEXT,
  submitted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_performance_reviews_cycle_emp_key UNIQUE (cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS hr_performance_reviews_cycle_idx ON hr_performance_reviews (cycle_id);

-- ---------------------------------------------------------------------------
-- New-hire joining documents (Google Drive links, capped per hire)
-- Also created at runtime by src/lib/hr-onboarding.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_onboarding_documents (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  employee_id TEXT,
  doc_type    TEXT NOT NULL DEFAULT 'other',
  title       TEXT NOT NULL DEFAULT '',
  drive_url   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'submitted',  -- submitted | verified | rejected
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_onboarding_docs_user_idx   ON hr_onboarding_documents (user_id, id);
CREATE INDEX IF NOT EXISTS hr_onboarding_docs_status_idx ON hr_onboarding_documents (status, id);

-- ---------------------------------------------------------------------------
-- Face-2FA enrolment selfie, retained so it can become the employee profile photo.
-- Enrolment is forced by middleware on the first protected page load, which for a new hire
-- happens BEFORE their hr_employees row exists; promoteEnrolmentPhoto() copies it across later.
-- ---------------------------------------------------------------------------
ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS selfie_url TEXT;
