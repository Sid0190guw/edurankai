// src/lib/performance-schema.ts — the ONLY DDL for performance, skills and employee learning.
//
// =================================================================================================
// WHAT IS NEW HERE AND WHAT IS NOT
// =================================================================================================
//
// Most of this file ALTERS tables that already exist. That is deliberate and it is the rule the
// phase brief states plainly: before creating a table, find the existing one and extend it. A second
// goals table or a second appraisal table would not be a feature, it would be a defect that takes a
// year to notice — two screens, two numbers, and no way to say which is the employee's rating.
//
//   hr_employee_goals        EXISTS (src/lib/hr-lifecycle.ts:64). It is the KRA / 30-60-90 table.
//                            EXTENDED here with the columns an OKR needs and could not express:
//                            a period, a progress figure, an owner, and a visibility choice.
//                            Key results are a SECOND LEVEL, so they are the one genuinely new
//                            table in the goals area: hr_goal_key_results, a child of that row.
//   hr_review_cycles         EXISTS (db/hr-schema.sql:382). EXTENDED with the four stages an
//   hr_performance_reviews   appraisal actually has — self-assessment, manager review, calibration,
//                            outcome — which the original pair had no columns for at all.
//
// GENUINELY NEW, because nothing in src/ or db/ answers these questions:
//   hr_goal_key_results          measurable results under an objective
//   hr_feedback                  continuous and 360 feedback
//   hr_skills / hr_employee_skills   the skill matrix
//   hr_learning_assignments      assigned learning (training_enrollments has no assigned_by, due_at
//                                or required column — recorded in navigation.ts NAV_BACKLOG, which
//                                is why the Learning nav entry has no widget behind it)
//   hr_training_events / hr_training_signups   the training calendar
//
// =================================================================================================
// SELF-BOOTSTRAPPING, AND WHERE THE ERROR HANDLING LIVES
// =================================================================================================
//
// There are no migrations on this project. Everything below is CREATE TABLE IF NOT EXISTS or ADD
// COLUMN IF NOT EXISTS, run at most once per process through ensureOnce().
//
// ensureOnce() returns `p.catch(() => {})` — it SWALLOWS. So an outer try/catch around the call
// never fires, and a failed statement leaves nothing in the log at all. The catch therefore lives
// INSIDE the callback: log the real Postgres reason off `e.cause`, then RE-THROW, because the
// re-throw is what makes ensureOnce drop its cache entry and try again on the next request instead
// of remembering the failure for the lifetime of the process.
//
// THAT CALLBACK IS NOW A STRING. The 48 statements below used to be 48 separate `await db.execute()`
// calls and therefore 48 round trips on every cold serverless instance; they are one ensureBatch()
// block. So there is no callback here left to hold a try/catch — and both jobs that catch did still
// happen, one layer down: ensureBatch's callback lets the rejection out, which is what makes
// ensureOnce delete the cache entry and retry on the next request, and ensureOnce's own catch logs
// `e.cause.message` (the real Postgres reason, not the failed SQL) under the tag
// `[ensure-once] performance_v1 failed:` instead of `[performance-schema] ensure`. If statements
// ever move back into a callback here, the catch moves back inside it with them.
//
// NO FOREIGN KEY TO training_courses. That table is created by an admin page rather than by a
// schema file, so on a database where nobody has opened /admin/hr/training it does not exist — and a
// REFERENCES clause pointing at a missing table takes the whole ensure down, including the tables
// that have nothing to do with it. The column holds the id and the read LEFT JOINs it.
//
// DEPARTMENT IDS ARE TEXT. `departments.id` is varchar(50) (a slug) in src/lib/db/schema.ts and
// UUID in db/hr-schema.sql. Every department column here is TEXT and every comparison is ::text.
// A ::uuid cast throws on the first slug that arrives.
//
// CREATE TABLE IF NOT EXISTS PROTECTS THE TABLE. IT DOES NOT PROTECT ITS SHAPE.
//
// This is the trap that broke the whole batch in production and it is worth stating plainly, because
// every statement here looks idempotent and one of them was not. If the table already exists,
// CREATE TABLE IF NOT EXISTS is a NO-OP — Postgres does not compare the definition, does not add the
// missing columns, and does not warn. Anything later in the batch that names one of those columns
// then fails with 42703, and because a batch is one transaction, EVERY statement in it is rolled
// back, including the ones with nothing to do with that table.
//
// That is exactly what happened. hr_performance_reviews exists on the live database in a shape older
// than the definition below, without cycle_id. The CREATE did nothing, the index on cycle_id threw
// `column "cycle_id" does not exist`, and hr_skills, hr_employee_skills, hr_learning_assignments,
// hr_training_events and hr_training_signups — none of which have anything to do with review cycles
// — were never created at all. They had to be recovered by hand from db/capability-spine-schema.sql
// and db/performance-remainder-schema.sql. The reason was invisible for as long as it was, because
// ensureOnce() swallows and nothing kept what it swallowed.
//
// SO EVERY COLUMN A LATER STATEMENT DEPENDS ON IS ASSERTED WITH ADD COLUMN IF NOT EXISTS, whether or
// not the CREATE above it already declares it. On a fresh database those ALTERs are no-ops. On a
// database that has been alive for a while they are the only thing that makes the rest of the batch
// reachable. src/lib/ddl-transaction.test.ts enforces the rule for this file.
import { ensureBatch } from '@/lib/ensure-once';
// The base hr_employee_goals table has exactly ONE definition, and it is in hr-lifecycle.ts. This
// module adds columns to it and must never re-declare it: two CREATE TABLE statements for one table
// is how the two drift apart the first time somebody edits only one of them.
import { ensureLifecycleSchema } from '@/lib/hr-lifecycle';

/**
 * Everything this module owns, as ONE batch instead of 48 round trips.
 *
 * A round trip to this database measures ~139ms from the deployed function, so sending these one at
 * a time cost roughly 6.6s of pure latency before the first real query on every cold instance —
 * paid by /admin/hr/performance and by every portal screen that reads a goal, a skill, an
 * assignment or a training signup.
 *
 * EVERY STATEMENT IS IN THE BATCH, and that is safe here because not one of them was individually
 * tolerated: the old code ran all 48 inside a SINGLE try/catch that logged and re-threw, so any
 * failure already took the whole ensure down with it — the NO FOREIGN KEY note above is written
 * about exactly that. A batch is one implicit transaction, so a failure now also rolls back the
 * statements that had already succeeded; for IF NOT EXISTS DDL that means the next request retries
 * against a clean slate rather than a half-made one.
 *
 * ensureLifecycleSchema() is NOT in here and cannot be. It is another module's ensure behind another
 * module's cache key, and it has to finish FIRST, because ADD COLUMN on hr_employee_goals needs
 * hr-lifecycle to have created that table. It stays an await in the function below.
 *
 * Written as literal statements joined with newlines rather than as one template literal because
 * several of the comments kept below contain backticks, which a template literal cannot hold.
 * Nothing here is interpolated and nothing here may ever be: ensureBatch sends this text over the
 * simple protocol, where a value spliced into the string would be executed as SQL.
 */
const PERFORMANCE_DDL = [
  // ---------------------------------------------------------------------------------------
  // GOALS AND OKRs — extending the KRA table rather than adding a second one.
  // ---------------------------------------------------------------------------------------

  // `kind` is a varchar with no check constraint, so 'okr' is a new VALUE and not a schema
  // change. A KRA row written by hr-lifecycle.ts setGoal() keeps working untouched: every
  // column added below is nullable or carries a default.
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS period_label VARCHAR(40);`,
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS period_start DATE;`,
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS period_end DATE;`,
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS progress_pct INT NOT NULL DEFAULT 0;`,
  // users.id of whoever the objective BELONGS to, which is not always who set it: an employee
  // writing their own OKR is owner and setter; a manager drafting one for a report is the
  // setter only. set_by_user_id already exists and keeps meaning what it meant.
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS owner_user_id UUID;`,
  // 'private' = the employee and nobody else. 'manager' = the employee and whoever the org graph
  // says answers for their work. There is no 'company' value: an org-wide goal feed is a
  // different product decision and inventing it here would publish people's targets by default.
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'manager';`,
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ;`,
  // hr-lifecycle.ts owns this column and this file has never declared it, which is precisely the
  // assumption that lost five tables further down: the index below is only as safe as the shape of a
  // table another module created. Asserting it costs a no-op ALTER and removes the assumption.
  `ALTER TABLE hr_employee_goals ADD COLUMN IF NOT EXISTS employee_id UUID;`,
  `CREATE INDEX IF NOT EXISTS hr_goals_period_idx ON hr_employee_goals(employee_id, period_end DESC);`,

  // The measurable half of an OKR. A separate table because an objective has MANY key results
  // and a row cannot hold a list — the one place where extending was not available.
  `CREATE TABLE IF NOT EXISTS hr_goal_key_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id UUID NOT NULL REFERENCES hr_employee_goals(id) ON DELETE CASCADE,
    title VARCHAR(300) NOT NULL,
    unit VARCHAR(24),
    start_value NUMERIC(14,2) NOT NULL DEFAULT 0,
    target_value NUMERIC(14,2) NOT NULL DEFAULT 100,
    current_value NUMERIC(14,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    sort_order INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  // The two columns the index below sorts on, asserted rather than assumed. See the note above
  // PERFORMANCE_DDL: a CREATE TABLE IF NOT EXISTS over an existing table of an older shape is a
  // silent no-op, and the index is then built against columns that were never added.
  `ALTER TABLE hr_goal_key_results ADD COLUMN IF NOT EXISTS goal_id UUID;`,
  `ALTER TABLE hr_goal_key_results ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;`,
  `CREATE INDEX IF NOT EXISTS hr_goal_kr_goal_idx ON hr_goal_key_results(goal_id, sort_order);`,

  // ---------------------------------------------------------------------------------------
  // APPRAISAL CYCLES — the pair from db/hr-schema.sql, created here too.
  //
  // Both are declared in that file, and that file is applied by hand. On a database where it
  // has not been, /admin/hr/performance throws on its first query. Creating them here is the
  // same fix work_email and hr_task_log needed on /portal/employee: a table that exists in the
  // schema file and not in the database. The definitions below are copied from
  // db/hr-schema.sql:382-411 verbatim, including the unique constraint the auto-seed's
  // ON CONFLICT depends on.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_review_cycles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT NOT NULL,
    period_start DATE,
    period_end   DATE,
    review_type  TEXT,
    status       TEXT NOT NULL DEFAULT 'draft',
    created_by   UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE TABLE IF NOT EXISTS hr_performance_reviews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id          UUID NOT NULL,
    employee_id       UUID NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
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
  );`,
  // THIS IS THE STATEMENT THAT WAS FAILING IN PRODUCTION, AND THESE TWO LINES ARE THE FIX.
  //
  // /admin/setup reported `performance_v1: column "cycle_id" does not exist` on 2026-08-24. The
  // live hr_performance_reviews predates the definition above and has no cycle_id, so the CREATE
  // TABLE IF NOT EXISTS did nothing and the index below asked for a column the table has never
  // had. That is a 42703, and it took the whole batch with it — which is why hr_skills,
  // hr_employee_skills and everything under them had to be created by hand from
  // db/capability-spine-schema.sql instead.
  //
  // NULLABLE, unlike the column in the CREATE. On a fresh database the CREATE has already made it
  // NOT NULL and these are no-ops; on the existing table an ADD COLUMN ... NOT NULL would fail on
  // the first row. A nullable column is the honest additive outcome.
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS cycle_id UUID;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS employee_id UUID;`,
  `CREATE INDEX IF NOT EXISTS hr_performance_reviews_cycle_idx ON hr_performance_reviews (cycle_id);`,

  // The stage a cycle is IN, which the original `status` (draft|active|closed) cannot say. A
  // cycle that is 'active' tells nobody whether self-assessments are still open.
  `ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS stage VARCHAR(24) NOT NULL DEFAULT 'self_assessment';`,
  `ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS self_due_on DATE;`,
  `ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS manager_due_on DATE;`,
  `ALTER TABLE hr_review_cycles ADD COLUMN IF NOT EXISTS calibration_due_on DATE;`,

  // The employee's own half of the review. It did not exist: the original table has only the
  // reviewer's fields, so "self-assessment" had nowhere to go.
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS self_assessment TEXT;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS self_rating NUMERIC(5,2);`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS self_submitted_at TIMESTAMPTZ;`,
  // WHO the manager was WHEN the review was written, captured from the org graph at the moment
  // the manager submitted. Not a live lookup: the point of writing it down is that a
  // reorganisation six months later must not change who is recorded as having reviewed somebody.
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS manager_employee_id UUID;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS manager_submitted_at TIMESTAMPTZ;`,
  // Calibration is a SEPARATE number from the manager's rating, kept beside it rather than
  // overwriting it. Overwriting would erase what the manager actually said, which is the one
  // thing an employee disputing an outcome needs to be able to see.
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibrated_rating NUMERIC(5,2);`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibration_note TEXT;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibrated_by_user_id UUID;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS calibrated_at TIMESTAMPTZ;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS outcome VARCHAR(24);`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS outcome_note TEXT;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS shared_with_employee_at TIMESTAMPTZ;`,
  // The workflow_instances row that carries the sign-off. NULL until somebody sends it.
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS workflow_instance_id UUID;`,
  // THE PROMOTION RECOMMENDATION, and it is three columns rather than a table on purpose. The
  // employee-lifecycle console owns promotions and its own record; this records only that an
  // appraisal RECOMMENDED one, and routes it through the SAME `promotion` workflow chain
  // (src/lib/workflow.ts DOMAINS.promotion) with a namespaced record id. Nothing here writes
  // hr_employees.designation — a recommendation is not a promotion.
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS proposed_designation VARCHAR(200);`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS promotion_justification TEXT;`,
  `ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS promotion_workflow_id UUID;`,
  `CREATE INDEX IF NOT EXISTS hr_perf_reviews_emp_idx ON hr_performance_reviews (employee_id);`,

  // ---------------------------------------------------------------------------------------
  // CONTINUOUS AND 360 FEEDBACK — one table, two kinds.
  //
  // ONE TABLE ON PURPOSE. A 360 comment and a note somebody left after a good week are the same
  // shape: an author, a subject, a body, a date. The only difference is that a 360 row names the
  // cycle it belongs to, so `cycle_id` is the whole distinction and `kind` is what a screen
  // filters on. Two tables would mean two readers, two visibility rules, and two chances to get
  // "who may read this" wrong.
  //
  // 360 REVIEWERS ARE NOT STORED HERE. They are resolved live from the Organization Graph's
  // `reviewer` edge (org-graph.ts getReviewers / getReviewSubjects). A reviewers table would be
  // a second org graph, and it would go stale the day somebody changes teams.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind VARCHAR(20) NOT NULL DEFAULT 'continuous',
    subject_employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    author_user_id UUID,
    author_employee_id UUID,
    author_name VARCHAR(200),
    cycle_id UUID,
    theme VARCHAR(24) NOT NULL DEFAULT 'general',
    body TEXT NOT NULL,
    visible_to_manager BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  // The four columns the three indexes below read. No REFERENCES on the ALTER: validating a
  // foreign key against rows that already exist can fail, and this must not be able to.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS subject_employee_id UUID;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS cycle_id UUID;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS author_user_id UUID;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `CREATE INDEX IF NOT EXISTS hr_feedback_subject_idx ON hr_feedback(subject_employee_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS hr_feedback_cycle_idx ON hr_feedback(cycle_id);`,
  `CREATE INDEX IF NOT EXISTS hr_feedback_author_idx ON hr_feedback(author_user_id, created_at DESC);`,

  // ---------------------------------------------------------------------------------------
  // THE SKILL MATRIX
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    category VARCHAR(60) NOT NULL DEFAULT 'general',
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  // Case-insensitive uniqueness: "TypeScript" and "typescript" are one skill, and letting them
  // be two silently halves every count on the department matrix.
  `ALTER TABLE hr_skills ADD COLUMN IF NOT EXISTS name VARCHAR(120);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS hr_skills_name_key ON hr_skills(lower(name));`,

  `CREATE TABLE IF NOT EXISTS hr_employee_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
    level INT NOT NULL DEFAULT 1,
    evidence TEXT,
    evidence_url TEXT,
    source VARCHAR(20) NOT NULL DEFAULT 'self',
    assessed_by_user_id UUID,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hr_employee_skills_key UNIQUE (employee_id, skill_id)
  );`,
  `ALTER TABLE hr_employee_skills ADD COLUMN IF NOT EXISTS skill_id UUID;`,
  `ALTER TABLE hr_employee_skills ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1;`,
  `CREATE INDEX IF NOT EXISTS hr_employee_skills_skill_idx ON hr_employee_skills(skill_id, level);`,

  // ---------------------------------------------------------------------------------------
  // ASSIGNED LEARNING
  //
  // This does NOT replace training_enrollments and does not duplicate it. That table records
  // what somebody DID — enrolled, progressed, finished — and has exactly one writer, the learner
  // opening a course. It has no assigned_by, no due date and no required flag, which is why the
  // Learning nav entry has no widget behind it (navigation.ts:275). This table records what
  // somebody was ASKED to do. The learning path joins the two: assignment on the left, the
  // learner's real progress on the right.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_learning_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    user_id UUID,
    course_id UUID NOT NULL,
    assigned_by_user_id UUID,
    reason TEXT,
    due_on DATE,
    required BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL DEFAULT 'assigned',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hr_learning_assignments_key UNIQUE (employee_id, course_id)
  );`,
  `ALTER TABLE hr_learning_assignments ADD COLUMN IF NOT EXISTS employee_id UUID;`,
  `ALTER TABLE hr_learning_assignments ADD COLUMN IF NOT EXISTS due_on DATE;`,
  `CREATE INDEX IF NOT EXISTS hr_learning_assign_due_idx ON hr_learning_assignments(employee_id, due_on);`,

  // ---------------------------------------------------------------------------------------
  // THE TRAINING CALENDAR
  //
  // There is no staff calendar anywhere in this product — navigation.ts NAV_BACKLOG records that
  // the only calendars are learner calendars, and that meet_rooms.scheduled_at is written by
  // nothing. This is a training calendar and is scoped to say so; it is not a general staff
  // scheduler and must not grow into one without that being a decision somebody made.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_training_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    course_id UUID,
    department_id TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    location VARCHAR(200),
    mode VARCHAR(20) NOT NULL DEFAULT 'online',
    capacity INT,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `ALTER TABLE hr_training_events ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;`,
  `CREATE INDEX IF NOT EXISTS hr_training_events_when_idx ON hr_training_events(starts_at);`,

  `CREATE TABLE IF NOT EXISTS hr_training_signups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES hr_training_events(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL,
    user_id UUID,
    status VARCHAR(20) NOT NULL DEFAULT 'going',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hr_training_signups_key UNIQUE (event_id, employee_id)
  );`,
  `ALTER TABLE hr_training_signups ADD COLUMN IF NOT EXISTS employee_id UUID;`,
  `CREATE INDEX IF NOT EXISTS hr_training_signups_emp_idx ON hr_training_signups(employee_id);`,
].join('\n');

/**
 * Create and extend everything this module owns. Idempotent, and safe to call from any reader.
 *
 * Ordered: the goals extension waits on hr-lifecycle's own ensure, because ADD COLUMN on a table
 * that does not exist yet fails.
 */
export async function ensurePerformanceSchema(): Promise<void> {
  // Awaited out here rather than from inside the ensure callback, because the callback is now a
  // plain DDL string and cannot contain a call. Repeating it is cheap and safe: it is itself an
  // ensureOnce('hr_lifecycle_core_v1', ...) guard, so after the first call in a process it resolves
  // from that cache without touching the database, and it never rejects (ensureOnce swallows for
  // the caller), so this function keeps its old contract of never rejecting either.
  await ensureLifecycleSchema();
  return ensureBatch('performance_v1', PERFORMANCE_DDL);
}
