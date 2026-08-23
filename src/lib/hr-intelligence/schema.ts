// src/lib/hr-intelligence/schema.ts — THE SIX TABLES PATCH 13 OWNS, AND NOTHING ELSE.
//
// =================================================================================================
// WHY THERE ARE ONLY SIX
// =================================================================================================
//
// Every one of these holds AN ACT BY THE HR DESK that no other module records. There is no table
// here for a skill, a skill level, a rating, a review, a course, an enrolment, a promotion or a
// disciplinary flag, because all seven already exist and have exactly one writer each:
//
//   hr_employee_skills        src/lib/skills.ts             the level of record
//   hr_performance_reviews    src/lib/performance.ts        ratings, calibration, outcomes
//   hr_feedback               src/lib/performance.ts        every feedback note
//   hr_learning_assignments   src/lib/performance-learning.ts   assigned learning
//   training_enrollments      the learner opening a course  what somebody actually did
//   hr_employee_lifecycle     src/lib/hr-lifecycle.ts       promotions and transfers
//   hr_flags                  src/lib/hr-flags.ts           policy breaches and their appeals
//
// A SECOND TABLE FOR ANY OF THEM WOULD BE THE BUG. This repository has already paid for that twice
// — XP, and course progress — and evidence-graph.ts refuses to carry a level column for the same
// reason. Two tables holding one fact is how a person ends up with two different answers about
// themselves on two screens.
//
// hri_interventions IS NOT A DISCIPLINARY RECORD, and the distinction is the whole reason it exists
// separately from hr_flags. A flag is a recorded breach with an appeal path attached. An
// intervention is a SUPPORT step: a conversation, a mentor, a workload change, a referral to
// training. Putting them in one table would mean every act of support sat in the table an appeal
// reads from, and it would make offering help indistinguishable from opening a case.
//
// =================================================================================================
// NO MIGRATIONS EXIST ON THIS PROJECT
// =================================================================================================
//
// Everything below is CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, following
// legal-hold.ts and performance-schema.ts.
//
// AND THE STATE IS VERIFIED, NOT ASSUMED. src/lib/ensure-once.ts ends in p.catch(() => {}): a DDL
// failure inside it RESOLVES and the caller reports success. Ten module tables were reported
// created on this project and none existed. So ensureHrIntelSchema() creates, then ASKS
// information_schema what is actually there, and memoises only a state it has verified. A state
// that is not ok is never cached: the next call tries again.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { textIn } from '@/lib/pg-array';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the very top because
// `const` is not hoisted and a handler reaching a later declaration has taken pages down here.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the failed SQL. */
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

const logFail = (tag: string, e: any) =>
  logEvent('error', 'hr-intelligence/schema:' + tag, { message: reasonOf(e) });

/** The tables this module owns, and the columns each one must have for the module to work. */
const REQUIRED: { table: string; columns: string[] }[] = [
  {
    table: 'hri_development_plans',
    columns: ['id', 'employee_id', 'title', 'reason', 'status', 'opened_by_user_id', 'target_on', 'created_at'],
  },
  {
    table: 'hri_plan_items',
    columns: ['id', 'plan_id', 'kind', 'title', 'detail', 'status', 'created_at'],
  },
  {
    table: 'hri_interventions',
    columns: ['id', 'employee_id', 'kind', 'summary', 'prompted_by', 'recorded_by_user_id', 'occurred_on', 'created_at'],
  },
  {
    table: 'hri_feedback_requests',
    columns: ['id', 'employee_id', 'requested_of_user_id', 'reason', 'status', 'requested_by_user_id', 'created_at'],
  },
  {
    table: 'hri_mobility_reviews',
    columns: ['id', 'employee_id', 'role_id', 'reason', 'status', 'opened_by_user_id', 'created_at'],
  },
  {
    table: 'hri_access_log',
    columns: ['id', 'viewer_user_id', 'subject_employee_id', 'depth', 'purpose', 'accessed_at'],
  },
];

const DDL: string[] = [
  // -----------------------------------------------------------------------------------------------
  // DEVELOPMENT PLANS
  //
  // A plan is a SHARED record, not an HR file about somebody. `visible_to_employee` defaults TRUE
  // and there is no code path that sets it false: the column exists so that a future decision to
  // draft a plan before sharing it is a decision somebody makes explicitly, rather than the default
  // everybody forgets to change. A development plan the subject cannot see is a personnel file.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hri_development_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    title VARCHAR(300) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    opened_by_user_id UUID,
    opened_by_name VARCHAR(200),
    target_on DATE,
    visible_to_employee BOOLEAN NOT NULL DEFAULT TRUE,
    closed_at TIMESTAMPTZ,
    closed_by_user_id UUID,
    closed_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hri_dev_plans_status_ck CHECK (status IN ('open', 'active', 'completed', 'closed'))
  );`,
  `CREATE INDEX IF NOT EXISTS hri_dev_plans_emp_idx ON hri_development_plans (employee_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS hri_dev_plans_status_idx ON hri_development_plans (status, created_at DESC);`,

  // -----------------------------------------------------------------------------------------------
  // PLAN ITEMS
  //
  // `signal_snapshot` is the reason this table is worth having. An item created from a skill gap
  // records the SIGNAL AS IT WAS on the day it was created — its inputs, its evidence rows, its
  // confidence and its timestamp. Six months later the underlying records will have changed, and a
  // plan that cannot say what it was opened on the strength of is a plan nobody can defend or
  // disagree with. It is a snapshot and is labelled as one; it is never re-read as current truth.
  //
  // `skill_id` has no FK to hr_skills: a merge in skill-graph.ts retires a losing skill, and an item
  // pointing at it must survive as a record of what was decided, not vanish.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hri_plan_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES hri_development_plans(id) ON DELETE CASCADE,
    kind VARCHAR(30) NOT NULL DEFAULT 'skill_gap',
    skill_id UUID,
    title VARCHAR(300) NOT NULL,
    detail TEXT,
    signal_id VARCHAR(120),
    signal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    due_on DATE,
    completed_at TIMESTAMPTZ,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hri_plan_items_status_ck CHECK (status IN ('open', 'in_progress', 'done', 'dropped'))
  );`,
  `CREATE INDEX IF NOT EXISTS hri_plan_items_plan_idx ON hri_plan_items (plan_id, sort_order);`,

  // -----------------------------------------------------------------------------------------------
  // INTERVENTIONS
  //
  // `prompted_by` is NOT NULL and it is required in code as well. An intervention nobody can trace
  // to what prompted it is an act on a person's record with no stated cause, and this table is read
  // on a screen where a reader is deciding what to do next.
  //
  // THE OUTCOME IS A SEPARATE, LATER WRITE. A support step recorded with its outcome already filled
  // in was not an intervention, it was a summary. Splitting them is what makes "what followed" a
  // question the table can answer honestly, including with "nothing has been recorded yet".
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hri_interventions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    kind VARCHAR(40) NOT NULL,
    summary TEXT NOT NULL,
    prompted_by TEXT NOT NULL,
    signal_id VARCHAR(120),
    signal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    plan_id UUID REFERENCES hri_development_plans(id) ON DELETE SET NULL,
    recorded_by_user_id UUID,
    recorded_by_name VARCHAR(200),
    occurred_on DATE NOT NULL,
    outcome_note TEXT,
    outcome_recorded_at TIMESTAMPTZ,
    outcome_recorded_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS hri_interventions_emp_idx ON hri_interventions (employee_id, occurred_on DESC);`,

  // -----------------------------------------------------------------------------------------------
  // FEEDBACK REQUESTS
  //
  // The REQUEST lives here. The feedback itself lands in hr_feedback, which performance.ts owns and
  // which this module never writes. `fulfilled_feedback_id` is the join between the two, written
  // when a matching note appears; it is nullable forever, because a request that nobody answered is
  // a real and readable state.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hri_feedback_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    requested_of_user_id UUID,
    requested_of_name VARCHAR(200),
    requested_by_user_id UUID,
    requested_by_name VARCHAR(200),
    theme VARCHAR(24) NOT NULL DEFAULT 'general',
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    fulfilled_feedback_id UUID,
    fulfilled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hri_fb_req_status_ck CHECK (status IN ('open', 'received', 'withdrawn'))
  );`,
  `CREATE INDEX IF NOT EXISTS hri_fb_req_emp_idx ON hri_feedback_requests (employee_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS hri_fb_req_of_idx ON hri_feedback_requests (requested_of_user_id, status);`,

  // -----------------------------------------------------------------------------------------------
  // MOBILITY REVIEWS
  //
  // `coverage_snapshot` holds the requirement-by-requirement coverage report as it stood when the
  // review was opened — the same reasoning as signal_snapshot above. `conclusion` is free text
  // written by a named human; there is no `score`, no `fit`, and no enum that could be read as a
  // verdict the system reached.
  //
  // NOTHING HERE MOVES ANYBODY. A conclusion of 'proceed' is a recorded human opinion; the transfer
  // itself is hr-lifecycle.ts, through the approval chain it already has.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hri_mobility_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    role_id UUID NOT NULL,
    role_title_snapshot VARCHAR(300),
    reason TEXT NOT NULL,
    coverage_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    conclusion TEXT,
    concluded_by_user_id UUID,
    concluded_by_name VARCHAR(200),
    concluded_at TIMESTAMPTZ,
    opened_by_user_id UUID,
    opened_by_name VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hri_mobility_status_ck CHECK (status IN ('open', 'concluded', 'withdrawn'))
  );`,
  `CREATE INDEX IF NOT EXISTS hri_mobility_emp_idx ON hri_mobility_reviews (employee_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS hri_mobility_role_idx ON hri_mobility_reviews (role_id, status);`,

  // -----------------------------------------------------------------------------------------------
  // ACCESS LOG
  //
  // WHO OPENED THIS PERSON'S INTELLIGENCE RECORD, WHEN, AT WHAT DEPTH, AND WHY.
  //
  // `sections_granted` and `sections_withheld` are both stored. Recording only what was shown would
  // make an unusually narrow read indistinguishable from a full one, and the withheld list is what
  // proves the boundary held on the day somebody asks.
  //
  // `purpose` is NOT NULL. A read of a person's development record with no stated purpose is the
  // thing purpose limitation exists to prevent, and a nullable column here would make the honest
  // callers the only ones filling it in.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hri_access_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    viewer_user_id UUID,
    viewer_name VARCHAR(200),
    subject_employee_id UUID NOT NULL,
    depth VARCHAR(20) NOT NULL DEFAULT 'actionable',
    purpose TEXT NOT NULL,
    sections_granted JSONB NOT NULL DEFAULT '[]'::jsonb,
    sections_withheld JSONB NOT NULL DEFAULT '[]'::jsonb,
    capability_used VARCHAR(80),
    accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS hri_access_subject_idx ON hri_access_log (subject_employee_id, accessed_at DESC);`,
  `CREATE INDEX IF NOT EXISTS hri_access_viewer_idx ON hri_access_log (viewer_user_id, accessed_at DESC);`,
];

export interface HrIntelSchemaState {
  ok: boolean;
  /** Per table: is it there, and what is missing from it. */
  tables: { table: string; present: boolean; missingColumns: string[] }[];
  /** True only when the database itself refuses UPDATE and DELETE on hri_access_log. */
  accessLogAppendOnly: boolean;
  accessLogNote: string;
  error: string | null;
  checkedAt: string;
}

let verified: HrIntelSchemaState | null = null;
let inflight: Promise<HrIntelSchemaState> | null = null;

async function runDdl(): Promise<string | null> {
  for (const statement of DDL) {
    try {
      await db.execute(sql.raw(statement));
    } catch (e: any) {
      logFail('ddl', e);
      return reasonOf(e);
    }
  }
  return null;
}

/**
 * Make the database itself refuse UPDATE and DELETE on the access log.
 *
 * BEST EFFORT, exactly as hr-events.ts does it and for the same reason: a managed database that
 * will not let this role create a trigger must not stop the log from working. The guarantee drops
 * from "the database refuses" to "no code in this repository does it", and the state report says
 * WHICH of the two is true rather than letting an operator assume the stronger one.
 */
async function enforceAppendOnly(): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION hri_access_log_append_only() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'hri_access_log is append-only: an access happened or it did not';
    END;
    $fn$ LANGUAGE plpgsql`);
  await db.execute(sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'hri_access_log' AND t.tgname = 'hri_access_log_no_update_delete'
      ) THEN
        CREATE TRIGGER hri_access_log_no_update_delete
          BEFORE UPDATE OR DELETE ON hri_access_log
          FOR EACH ROW EXECUTE FUNCTION hri_access_log_append_only();
      END IF;
    END
    $do$`);
}

async function readState(): Promise<HrIntelSchemaState> {
  const state: HrIntelSchemaState = {
    ok: false,
    tables: REQUIRED.map((r) => ({ table: r.table, present: false, missingColumns: r.columns.slice() })),
    accessLogAppendOnly: false,
    accessLogNote: '',
    error: null,
    checkedAt: new Date().toISOString(),
  };
  try {
    const names = REQUIRED.map((r) => r.table);
    const cols = rowsOf(await db.execute(sql`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ${textIn(names)}`));

    const byTable = new Map<string, Set<string>>();
    for (const c of cols) {
      const t = String((c as any).table_name);
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t)!.add(String((c as any).column_name));
    }

    state.tables = REQUIRED.map((r) => {
      const have = byTable.get(r.table) || new Set<string>();
      return {
        table: r.table,
        present: have.size > 0,
        missingColumns: r.columns.filter((c) => !have.has(c)),
      };
    });

    const broken = state.tables.filter((t) => !t.present || t.missingColumns.length > 0);
    state.ok = broken.length === 0;
    if (!state.ok) {
      state.error = broken
        .map((t) => (t.present ? t.table + ' is missing ' + t.missingColumns.join(', ') : t.table + ' does not exist'))
        .join('; ') + '.';
    }

    const trig = rowsOf(await db.execute(sql`
      SELECT 1 AS present FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'hri_access_log' AND t.tgname = 'hri_access_log_no_update_delete'
       LIMIT 1`));
    state.accessLogAppendOnly = trig.length > 0;
    state.accessLogNote = state.accessLogAppendOnly
      ? 'The database refuses UPDATE and DELETE on hri_access_log.'
      : 'Append-only is a convention here, not a database guarantee: no trigger is installed, so a '
        + 'direct UPDATE or DELETE would succeed. No code in this repository writes one.';
    return state;
  } catch (e: any) {
    logFail('readState', e);
    state.error = 'The database could not be asked what exists: ' + reasonOf(e);
    state.accessLogNote = 'Unknown — the check could not run.';
    return state;
  }
}

/**
 * Create the tables, try to make the access log append-only, then ASK THE DATABASE WHAT IS THERE.
 *
 * The return value is a report, not a promise that it worked. Callers that need the tables — every
 * write in actions.ts, and the access log the view will not render without — read `ok` and say so
 * in words when it is false.
 */
export async function ensureHrIntelSchema(): Promise<HrIntelSchemaState> {
  if (verified && verified.ok) return verified;
  if (inflight) return inflight;
  inflight = (async () => {
    const ddlError = await runDdl();
    try {
      await enforceAppendOnly();
    } catch (e: any) {
      // Reported, never fatal — see enforceAppendOnly().
      logFail('append-only', e);
    }
    const state = await readState();
    if (ddlError && !state.ok) {
      state.error = (state.error ? state.error + ' — ' : '') + 'DDL failed: ' + ddlError;
    }
    if (state.ok) verified = state;
    return state;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Re-read from scratch, ignoring the memo. For an ops surface that wants the truth on demand. */
export async function hrIntelSchemaState(): Promise<HrIntelSchemaState> {
  verified = null;
  return ensureHrIntelSchema();
}

/** Exported for tests that need the memo cleared between cases. */
export function resetHrIntelSchemaMemo(): void {
  verified = null;
}
