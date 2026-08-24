-- db/performance-remainder-schema.sql
-- THE FOUR TABLES THE PERFORMANCE BATCH NEVER REACHED.
--
-- SAFE TO RUN ON PRODUCTION. CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No ALTER TABLE — the
-- ALTERs in PERFORMANCE_DDL are deliberately NOT reproduced here; see the note at the bottom.
--
-- RUN IT YOURSELF. Nothing in the build opens a production connection.
--
-- ============================================================================================
-- WHY FOUR AND NOT TEN
-- ============================================================================================
--
-- src/lib/performance-schema.ts holds PERFORMANCE_DDL, one array of statements run in order by
-- ensureBatch(). It stops at the first failure and ensureOnce() swallows the error, so the module
-- is HALF created in production and always has been. The live database, enumerated 2026-08-24,
-- draws the line exactly:
--
--   PRESENT   hr_employee_goals, hr_goal_key_results, hr_review_cycles, hr_performance_reviews
--   ABSENT    hr_feedback, hr_skills, hr_employee_skills, hr_learning_assignments,
--             hr_training_events, hr_training_signups
--
-- hr_goal_key_results is the second statement in the array and it exists; hr_feedback is the first
-- statement after the block of ALTER TABLE lines and it does not, along with everything below it.
-- The batch died in the ALTERs. hr_skills and hr_employee_skills were already recovered by
-- db/capability-spine-schema.sql because the hiring decision report needed them; these four are the
-- rest of the same casualty list — continuous feedback, assigned learning, and training events.
--
-- ORDER IS FOREIGN KEYS. hr_training_signups references hr_training_events, so the event table is
-- created first. All four reference hr_employees, which db/hr-schema.sql already created.

-- --------------------------------------------------------------------------------------------
-- CONTINUOUS AND 360 FEEDBACK — one table, two kinds.
--
-- A 360 comment and a note somebody left after a good week are the same shape: an author, a
-- subject, a body, a date. `cycle_id` is the whole distinction and `kind` is what a screen filters
-- on. Two tables would mean two readers, two visibility rules, and two chances to get "who may read
-- this" wrong. 360 REVIEWERS ARE NOT STORED HERE — they resolve live from the Organization Graph's
-- `reviewer` edge, because a reviewers table would be a second org graph that goes stale the day
-- somebody changes teams.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_feedback (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                VARCHAR(20) NOT NULL DEFAULT 'continuous',
  subject_employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  author_user_id      UUID,
  author_employee_id  UUID,
  author_name         VARCHAR(200),
  cycle_id            UUID,
  theme               VARCHAR(24) NOT NULL DEFAULT 'general',
  body                TEXT NOT NULL,
  visible_to_manager  BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hr_feedback_subject_idx ON hr_feedback (subject_employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hr_feedback_cycle_idx   ON hr_feedback (cycle_id);
CREATE INDEX IF NOT EXISTS hr_feedback_author_idx  ON hr_feedback (author_user_id, created_at DESC);

-- --------------------------------------------------------------------------------------------
-- ASSIGNED LEARNING.
--
-- This does NOT replace training_enrollments and does not duplicate it. That table records what
-- somebody DID — enrolled, progressed, finished — and its only writer is the learner opening a
-- course. It has no assigned_by, no due date and no required flag, which is what this table adds:
-- the record that somebody was ASKED to do it, by whom, and by when.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_learning_assignments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  user_id             UUID,
  course_id           UUID NOT NULL,
  assigned_by_user_id UUID,
  reason              TEXT,
  due_on              DATE,
  required            BOOLEAN NOT NULL DEFAULT false,
  status              VARCHAR(20) NOT NULL DEFAULT 'assigned',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_learning_assignments_key UNIQUE (employee_id, course_id)
);

CREATE INDEX IF NOT EXISTS hr_learning_assign_due_idx ON hr_learning_assignments (employee_id, due_on);

-- --------------------------------------------------------------------------------------------
-- TRAINING EVENTS AND WHO SAID THEY WOULD COME.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_training_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title              VARCHAR(200) NOT NULL,
  description        TEXT,
  course_id          UUID,
  department_id      TEXT,
  starts_at          TIMESTAMPTZ NOT NULL,
  ends_at            TIMESTAMPTZ,
  location           VARCHAR(200),
  mode               VARCHAR(20) NOT NULL DEFAULT 'online',
  capacity           INT,
  status             VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hr_training_events_when_idx ON hr_training_events (starts_at);

-- One signup per person per event, enforced by the constraint rather than by a screen.
CREATE TABLE IF NOT EXISTS hr_training_signups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES hr_training_events(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  user_id     UUID,
  status      VARCHAR(20) NOT NULL DEFAULT 'going',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_training_signups_key UNIQUE (event_id, employee_id)
);

CREATE INDEX IF NOT EXISTS hr_training_signups_emp_idx ON hr_training_signups (employee_id);

-- ============================================================================================
-- VERIFY (safe, read-only). Expect four rows.
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN ('hr_feedback','hr_learning_assignments','hr_training_events',
--                         'hr_training_signups')
--    ORDER BY table_name;
--
-- THE ALTER TABLE STATEMENTS ARE NOT IN THIS FILE, AND THAT IS THE POINT.
--
-- PERFORMANCE_DDL carries roughly twenty `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT
-- EXISTS ...` and four on hr_review_cycles — self-assessment, calibration, outcome, the promotion
-- recommendation. Those columns are almost certainly the reason the batch aborted, and an ALTER
-- takes ACCESS EXCLUSIVE: every reader of the table queues behind it, which is precisely how the
-- site went down on 2026-08-23.
--
-- Creating the four tables above is additive and takes no lock anyone is waiting on. Adding twenty
-- columns to a table the appraisal screens read is a different operation and deserves its own
-- window: run it when nobody is using /admin/hr, one statement at a time, watching each return. If
-- it is run as one pasted block in a SQL editor it becomes a single transaction holding every one
-- of those locks together until the last statement finishes.
