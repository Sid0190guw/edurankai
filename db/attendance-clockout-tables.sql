-- db/attendance-clockout-tables.sql
--
-- RUN THIS BY HAND AGAINST PRODUCTION. Nothing in the application will create these tables there.
--
-- =================================================================================================
-- WHY THIS FILE EXISTS
-- =================================================================================================
--
-- src/lib/ensure-once.ts turns every ensureOnce() bootstrap into a resolved promise when
-- NODE_ENV=production and SCHEMA_BOOTSTRAP is unset. That default is deliberate and correct: the
-- measurement in that file's header shows eighteen ALTER TABLEs taking ACCESS EXCLUSIVE on `roles`
-- was enough to make sixteen of twenty concurrent requests return nothing at all.
--
-- The safety argument for it was: "every caller already tolerates a missing table, so the failure
-- mode is a feature with no rows rather than a site that will not load."
--
-- THAT IS TRUE OF EVERY TABLE BUT THESE. All three are read or written on paths a real person
-- walks, none appears in any other db/*.sql file, and the first one breaks the argument outright:
--
--   hr_daily_report_revisions
--       submitClockOutReport() (src/lib/attendance-verify-clockout.ts) INSERTs into it as the
--       FIRST statement inside a db.transaction(). A missing table there does not degrade the
--       daily report — it aborts the transaction, so the CLOCK-OUT ITSELF FAILS and the person
--       cannot end their day. It is easy to miss because the parent table hr_daily_reports IS in
--       db/hr-schema.sql; only the revision trail was left behind.
--
--   hr_clock_out_checks
--       The identity-check trail written at the clock-out gate, from the same bootstrap.
--
--   training_certificates
--       Read by /portal/profile, /portal/index, /aquintutor/dashboard and four more. A missing
--       table here does degrade gracefully — the page says the certificates could not be loaded —
--       but it says that to every person, on every open, forever.
--
-- AFTER RUNNING THIS: open /api/health and confirm schemas.missingCount is 0. Those three tables
-- are now in BOOTSTRAP_MODULES (src/lib/observability-health.ts), so that endpoint reports on them
-- instead of staying silent about them.
--
-- Every statement is IF NOT EXISTS and none of them drops, alters or deletes anything. Running it
-- twice is safe. The DDL is copied from the modules that own it, so it must stay identical to:
--   src/lib/daily-report.ts               (ensureDailyReportSchema)
--   src/lib/attendance-verify-clockout.ts (ensureClockOutSchema)
--   src/lib/learning-progress.ts          (ensureLearningProgressSchema)
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. THE DAILY REPORT REVISION TRAIL — the one that fails a clock-out when it is absent.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_daily_report_revisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     UUID NOT NULL,
  employee_id   UUID NOT NULL,
  report_date   DATE NOT NULL,
  revision      INT NOT NULL DEFAULT 0,
  report_url    TEXT,
  work_done     TEXT,
  blockers      TEXT,
  replaced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replaced_by_user_id UUID
);

CREATE INDEX IF NOT EXISTS hr_daily_report_rev_idx
  ON hr_daily_report_revisions (report_id, revision DESC);

-- ONE SNAPSHOT PER REVISION, ENFORCED BY THE DATABASE.
--
-- If this statement fails, DO NOT force it. A duplicate (report_id, revision) pair means two
-- submits snapshotted the same revision and the text in between was kept nowhere — somebody's edit
-- was lost. Find them first:
--
--   SELECT report_id, revision, count(*) FROM hr_daily_report_revisions
--    GROUP BY 1,2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS hr_daily_report_rev_uniq
  ON hr_daily_report_revisions (report_id, revision);

-- -------------------------------------------------------------------------------------------------
-- 2. THE CLOCK-OUT IDENTITY TRAIL.
--
-- Note what is absent and must stay absent: no descriptor, no distance, no photo, no score, and no
-- "suspicious" or "rejected" column. needs_human_look is DERIVED when somebody looks. The moment a
-- verdict becomes a column, a screen starts filtering on it and somebody loses a day to a lighting
-- problem. Automated checks on this platform are advisory; a human decides.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_clock_out_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL,
  user_id         UUID,
  work_date       DATE NOT NULL,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  passed          BOOLEAN NOT NULL DEFAULT FALSE,
  declined_reason TEXT,
  work_source     TEXT,
  report_id       UUID,
  clock_out_written BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at     TIMESTAMPTZ,
  reviewed_by_user_id UUID,
  review_note     TEXT
);

CREATE INDEX IF NOT EXISTS hr_clock_out_checks_emp_idx
  ON hr_clock_out_checks (employee_id, work_date DESC);

CREATE INDEX IF NOT EXISTS hr_clock_out_checks_outcome_idx
  ON hr_clock_out_checks (outcome, checked_at DESC);

-- -------------------------------------------------------------------------------------------------
-- 3. COURSE CERTIFICATES.
--
-- issued_at, not created_at. /portal/profile asked for created_at and Postgres answered "column
-- does not exist" on every single open, which is what the "your certificates could not be loaded"
-- banner on that page was. The column name here is the one every other reader already uses.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL,
  user_id UUID NOT NULL,
  enrollment_id UUID,
  certificate_number VARCHAR(64) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE training_certificates ADD COLUMN IF NOT EXISTS ledger_cert_number VARCHAR(64);

CREATE INDEX IF NOT EXISTS training_certificates_user_idx
  ON training_certificates (user_id, issued_at DESC);
