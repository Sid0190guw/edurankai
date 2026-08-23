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
-- THREE TABLES WERE NOT THE WHOLE OF IT. A second reading of this file found that the same two
-- statements also name SIXTEEN COLUMNS that no db/*.sql declares, so creating the tables alone
-- still left both halves of a working day broken on a database built from db/:
--
--   hr_clock_events   is in db/hr-schema.sql, but WITHOUT qr_station_id, qr_code_raw, source,
--                     face_verified, face_verify_method, face_verify_outcome or face_verified_at —
--                     and punch() names all seven in its INSERT. So CLOCK-IN fails there too. The
--                     first draft of this file claimed clock-in was unaffected; it was wrong.
--
--   hr_daily_reports  is in db/hr-schema.sql with work_done, progress and blockers, and the
--                     clock-out INSERT names nine more: report_url, sharing_ack, revision_count,
--                     last_revised_at, submitted_by_user_id, work_source, form_response_url,
--                     form_service, filed_at_clock_out.
--
-- A parent table that exists while the columns written to it do not is the shape that hid all of
-- this: every "does the table exist" check passed.
--
-- AFTER RUNNING THIS: open /api/health and confirm schemas.missingCount is 0. Those three tables
-- are now in BOOTSTRAP_MODULES (src/lib/observability-health.ts), so that endpoint reports on them
-- instead of staying silent about them. Note that BOOTSTRAP_MODULES tests for TABLES, not columns,
-- so it cannot see the sixteen above — running this file is what covers them.
--
-- WHETHER ANY OF THIS IS BROKEN ON THE LIVE DATABASE TODAY IS NOT KNOWN, AND THIS FILE DOES NOT
-- CLAIM IT IS. The production kill switch in ensure-once.ts landed on 2026-08-23 at 14:48
-- (effb474b); the revisions DDL landed on 2026-08-06 (d7d43f3f). For the seventeen days between
-- them the bootstrap ran freely on the request path, so the live database has most likely had all
-- of this created already. What changed today is that it will never happen again — and ensureOnce
-- SWALLOWS a failed DDL run, so "it had seventeen days" is not evidence that it worked. This file
-- is what makes a restored, rebuilt or newly provisioned database correct, and it is idempotent on
-- one where the bootstrap already did the work.
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

-- -------------------------------------------------------------------------------------------------
-- 4. THE COLUMNS punch() WRITES THAT db/hr-schema.sql DOES NOT DECLARE.
--
-- Without these, CLOCK-IN fails as surely as clock-out: punch() names all seven in one INSERT, and
-- Postgres rejects the statement on the first column it does not recognise. Owned by
-- src/lib/attendance-schema.ts (the first three) and src/lib/attendance-verify.ts (the four face
-- columns).
--
-- The face columns are a LABEL on a punch and never a verdict: nothing refuses a punch because a
-- face check did not pass, and no screen filters on them. Automated checks here are advisory and a
-- human decides — see the header of src/pages/portal/employee/attendance/index.astro.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS qr_station_id UUID;
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS qr_code_raw TEXT;
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verified BOOLEAN;
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verify_method TEXT;
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verify_outcome TEXT;
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_verified_at TIMESTAMPTZ;

-- -------------------------------------------------------------------------------------------------
-- 5. THE COLUMNS THE CLOCK-OUT REPORT WRITES THAT db/hr-schema.sql DOES NOT DECLARE.
--
-- hr_daily_reports exists there with work_done, progress and blockers. The clock-out INSERT names
-- nine more, and the revision snapshot in section 1 reads report_url and revision_count off the
-- same row. Owned by src/lib/daily-report.ts and src/lib/attendance-verify-clockout.ts.
--
-- report_url and form_response_url are kept SEPARATE on purpose: a Drive link and a form response
-- can both be present on one day's report and neither may overwrite the other.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS report_url TEXT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS sharing_ack BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS revision_count INT NOT NULL DEFAULT 0;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS last_revised_at TIMESTAMPTZ;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS work_source TEXT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS form_response_url TEXT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS form_service TEXT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS filed_at_clock_out BOOLEAN NOT NULL DEFAULT FALSE;

-- The reviewer's half of the same table, from the same module. Included because a report that can
-- be filed and not reviewed is only half a feature, and these are ALTERs on a table this file has
-- already touched — cheaper to apply in the same pass than to discover separately.
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_by_employee_id UUID;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_revision INT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS review_comment TEXT;
