// src/lib/attendance-schema.ts — STORAGE for the attendance module. It creates tables and decides
// nothing.
//
// =================================================================================================
// WHAT ALREADY EXISTED, AND IS EXTENDED RATHER THAN REPLACED
// =================================================================================================
//
//   hr_attendance      one row per employee per day (db/hr-schema.sql:127). Written by
//                      /admin/hr/attendance, read by /portal/workspace and by
//                      src/lib/hr-leave.ts markLeaveAttendance(). THIS FILE DOES NOT CREATE A
//                      SECOND DAY TABLE. It adds three columns to that one.
//   hr_clock_events    the raw punch log (db/hr-schema.sql:150) with lat/lon/accuracy/ip/device
//                      already declared. THIS FILE DOES NOT CREATE A SECOND PUNCH LOG. It adds the
//                      QR station reference and a source marker.
//
// A second attendance table would be a defect: markLeaveAttendance() upserts on
// (employee_id, date), and a parallel store would let "on leave" and "present" both be true on the
// same day depending on which screen you opened.
//
// =================================================================================================
// WHAT IS NEW, AND WHY EACH ONE IS NOT ALREADY SOMEWHERE
// =================================================================================================
//
//   hr_shifts                  There is no shift, roster, work_schedule or working-hours table
//                              anywhere in src/ or db/ — src/lib/workforce/navigation.ts:389 records
//                              that absence as the reason there was no staff calendar. Without a
//                              shift there is no expected-hours figure, so a timesheet can only ever
//                              show what happened and never whether it matched anything.
//   hr_roster_assignments      Which shift a person is on, EFFECTIVE-DATED. Same discipline as
//                              org_relationships: changing somebody's shift closes the open row and
//                              opens a new one, so last month's timesheet keeps comparing against
//                              the shift that was actually in force last month. A shift_id column on
//                              hr_employees would be overwritten in place and destroy that.
//   hr_holidays                hr_attendance.status already accepts 'holiday' and nothing anywhere
//                              writes it, because no table says which days are holidays.
//   hr_attendance_qr_stations  The place a QR code stands for. ADVISORY ONLY — see the note below.
//   hr_attendance_corrections  The FACTS of a correction request. Its approval state lives in
//                              workflow_instances and NOWHERE HERE: see the block on that table.
//
// =================================================================================================
// AUTOMATED SIGNALS ARE EVIDENCE, NEVER A VERDICT
// =================================================================================================
//
// Every geo and QR column in this file is evidence attached to a punch. There is no `is_valid`,
// `within_geofence` or `rejected_reason` column, and that omission is the design: the moment a
// column says a punch is invalid, some screen will start filtering on it and a person will lose a
// day's pay to a phone that could not get a GPS fix indoors. Distance from a station is COMPUTED for
// display when somebody looks, and a human decides what it means.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - Self-bootstrapping DDL only: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, inside an
//     ensureOnce() guard that DELETES its cache entry on failure so a transient error retries.
//   - department_id is TEXT and is never cast to ::uuid. departments.id is varchar(50) (a slug) in
//     src/lib/db/schema.ts:80 and UUID in db/hr-schema.sql:31; a cast throws on half the values in
//     the product.
//   - Every const is declared above the function that reads it. `const` is not hoisted and a const
//     under its first use has taken pages down on this project.
//   - The real Postgres reason is on e.cause. e.message is only the SQL that failed.

// =================================================================================================
// THE SECOND ENSURE IN THIS FILE, AND WHY IT IS A SECOND ONE RATHER THAN MORE STATEMENTS ABOVE
// =================================================================================================
//
// ensureWorkingTimeSchema() at the bottom creates the OVERTIME and TIMESHEET tables and adds the
// half-day columns to hr_attendance. It is a separate ensureOnce key from 'attendance_v1' for one
// mechanical reason: ensureOnce memoises per key per PROCESS, so a running server that has already
// resolved 'attendance_v1' would never execute statements appended to it. A new key runs on the next
// request in that same process. Nothing here re-declares a table the first ensure creates.
//
// NO SECOND DAY TABLE, NO SECOND PUNCH LOG, NO SECOND HOLIDAY LIST. Overtime is a CLAIM about a day
// that hr_attendance already holds, and it writes its settled result into that row's existing
// overtime_hours column (db/hr-schema.sql:133). A timesheet is a WEEKLY DECLARATION a person signs,
// which is a different fact from the punches, so it has its own rows and deliberately does not
// overwrite hr_attendance — two writers for one day's hours is the fault this file's header warns
// about.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureBatch, ensureOnce } from './ensure-once';

const logFail = (tag: string, e: any) =>
  console.error('[attendance-schema] ' + tag, e?.cause?.message || e?.message);

// =================================================================================================
// HOW THIS DDL IS SENT: ONE MESSAGE FOR THE RUN THAT MUST SUCCEED, SEPARATE CALLS FOR THE REST
// =================================================================================================
//
// Every statement here used to be its own `await db.execute(...)`, and every await is a round trip.
// Measured from the deployed function a round trip is ~139ms, so the nineteen statements of
// ensureAttendanceSchema() cost ~2.6s and the twelve of ensureWorkingTimeSchema() another ~1.7s —
// spent before /portal/employee/attendance/clock-out could read its first row, and spent again on
// every cold instance, because ensureOnce memoises per PROCESS and a serverless process is new most
// of the time. That is most of why that page reached the gateway timeout.
//
// The statements that are NOT allowed to fail on their own are now sent as ONE simple-protocol
// message per ensure (ensureBatch, in src/lib/ensure-once.ts). Same statements, same order, same
// IF NOT EXISTS idempotence — only the number of messages changed. Nineteen round trips become five,
// twelve become six.
//
// WHAT IS DELIBERATELY LEFT OUT OF THE BATCHES. A batch is ONE IMPLICIT TRANSACTION: if any
// statement in it fails, the whole block rolls back. The indexes below that carry their own
// try/catch carry it precisely because a live table holding duplicate rows can refuse them, and that
// refusal must not take the tables with it. So each of those stays a separate call —
// hr_roster_one_open, hr_holidays_date_scope, hr_qr_station_code and hr_attendance_emp_date_uniq in
// the first ensure; hr_holidays_date_scope_loc with its conditional DROP, hr_overtime_one_live,
// hr_timesheet_emp_week and hr_timesheet_entry_day in the second. They run AFTER their batch instead
// of interleaved between its statements, which changes no outcome: nothing in a batch depends on an
// index the batch does not create, and every tolerated index still runs after the table or column it
// needs. Their order relative to each other is unchanged, which matters for the wide-index/DROP pair
// in ensureWorkingTimeSchema().
//
// THE ONE BEHAVIOUR THAT DID CHANGE. The tolerated indexes now sit under their own ensureOnce key.
// A run that fails because the database was unreachable still drops the BATCH key and retries the
// whole batch on the next call, but the tolerated key stays cached for the life of the process, so
// those indexes are re-attempted by the next process rather than the next request. They are
// IF NOT EXISTS creates against a shared database, so any instance that gets through creates them
// for everybody, and the readers in src/lib/attendance.ts fail closed until then.
//
// The DDL is split into the constants below only so each block keeps the comment that explains it.
// They are concatenated verbatim, in the order the statements were always executed in.

// -----------------------------------------------------------------------------------------
// SHIFTS. A named pattern of working time.
//
// TIMES ARE MINUTES PAST MIDNIGHT, not TIME columns, for one reason: a night shift runs
// 22:00 to 06:00 and `end < start` is then the definition of "crosses midnight", which is a
// plain integer comparison every reader can make. With TIME columns the same fact needs an
// extra boolean that somebody eventually forgets to set.
//
// working_days is a comma-separated list of ISO weekday numbers (1 = Monday .. 7 = Sunday).
// TEXT rather than an array so it reads identically on Supabase's pooler and in a plain
// psql session, and so a missing value degrades to "no expectation recorded" rather than an
// error.
// -----------------------------------------------------------------------------------------
const DDL_SHIFTS = `
  CREATE TABLE IF NOT EXISTS hr_shifts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    code           TEXT,
    start_minute   INT NOT NULL DEFAULT 540,
    end_minute     INT NOT NULL DEFAULT 1080,
    break_minutes  INT NOT NULL DEFAULT 60,
    grace_minutes  INT NOT NULL DEFAULT 15,
    working_days   TEXT NOT NULL DEFAULT '1,2,3,4,5',
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    note           TEXT,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS hr_shifts_active_idx ON hr_shifts (is_active, name);
`;

// -----------------------------------------------------------------------------------------
// ROSTER. Which shift a person is on, and WHEN THAT WAS TRUE.
//
// effective_from / effective_to, closed and reopened rather than overwritten — the same shape
// as org_relationships and for the same reason. "What was Ravi rostered on in March" is a
// SELECT with a date in it; on a mutated column it is unanswerable, and every historical
// timesheet silently re-scores itself against today's shift.
//
// The partial unique index enforces AT MOST ONE OPEN ROW PER PERSON in the database, so a
// second code path cannot get around it. It is allowed to fail (an existing table with a
// duplicate open row would reject it) without taking the table with it — hence its own
// try/catch below.
// -----------------------------------------------------------------------------------------
const DDL_ROSTER = `
  CREATE TABLE IF NOT EXISTS hr_roster_assignments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    UUID NOT NULL,
    shift_id       UUID NOT NULL,
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to   DATE,
    note           TEXT,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS hr_roster_emp_idx
    ON hr_roster_assignments (employee_id, effective_from DESC);
`;

// -----------------------------------------------------------------------------------------
// HOLIDAYS. department_id is TEXT and NULL means the whole organization.
//
// The uniqueness key uses COALESCE(department_id, '') because NULLs do not collide in a plain
// unique index — without it, "Independence Day, organization-wide" could be inserted a dozen
// times and the holiday calendar would render twelve identical rows.
// -----------------------------------------------------------------------------------------
const DDL_HOLIDAYS = `
  CREATE TABLE IF NOT EXISTS hr_holidays (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    holiday_date  DATE NOT NULL,
    name          TEXT NOT NULL,
    department_id TEXT,
    is_optional   BOOLEAN NOT NULL DEFAULT FALSE,
    note          TEXT,
    created_by    UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS hr_holidays_date_idx ON hr_holidays (holiday_date);
`;

// -----------------------------------------------------------------------------------------
// QR STATIONS. A code printed on a wall, and where that wall is.
//
// radius_m is used ONLY to phrase a sentence for a human ("recorded 340 m from Head Office,
// which is outside the 100 m the station expects"). Nothing compares against it to decide
// anything. See the header.
// -----------------------------------------------------------------------------------------
const DDL_QR_STATIONS = `
  CREATE TABLE IF NOT EXISTS hr_attendance_qr_stations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code       TEXT NOT NULL,
    label      TEXT NOT NULL,
    lat        NUMERIC(10,6),
    lon        NUMERIC(10,6),
    radius_m   INT NOT NULL DEFAULT 150,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

// -----------------------------------------------------------------------------------------
// CORRECTIONS. THE FACTS OF THE REQUEST — AND NOT ITS APPROVAL.
//
// THERE IS NO status COLUMN HERE, AND THAT ABSENCE IS THE WHOLE POINT. Whether a correction is
// waiting, approved, rejected or halted is answered by workflow_instances, keyed on
// (domain = 'attendance', record_id = this row's id). A `status` column beside it would be a
// SECOND approval state machine: two rows to keep in step, and a day where one says approved
// and the other says pending. src/lib/workflow.ts is the only approval engine in this codebase.
//
// `applied_at` is not an approval state. It records whether the approved change has been
// WRITTEN INTO hr_attendance yet, which is a different question with a different answer — an
// approval can be recorded a second before the write, and the timesheet must be able to say
// "approved, not yet applied" instead of quietly showing the old numbers.
// -----------------------------------------------------------------------------------------
const DDL_CORRECTIONS = `
  CREATE TABLE IF NOT EXISTS hr_attendance_corrections (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id          UUID NOT NULL,
    work_date            DATE NOT NULL,
    requested_status     TEXT,
    requested_clock_in   TIMESTAMPTZ,
    requested_clock_out  TIMESTAMPTZ,
    reason               TEXT NOT NULL,
    requested_by_user_id UUID,
    applied_at           TIMESTAMPTZ,
    withdrawn_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS hr_corrections_emp_idx
    ON hr_attendance_corrections (employee_id, work_date DESC);
`;

// -----------------------------------------------------------------------------------------
// ADDITIVE COLUMNS ON THE TABLES THAT ALREADY EXIST.
//
// ADD COLUMN IF NOT EXISTS, so this is a no-op on the production tables and only completes a
// fresh environment. Nothing is retyped and nothing is dropped.
//
// The note that used to sit between the break_minutes and the source ALTER is now an SQL comment
// inside the block, on the statement it describes. It says the same thing; a -- comment is ignored
// by the database parser exactly as a // comment was ignored by the compiler.
// -----------------------------------------------------------------------------------------
const DDL_ADDITIVE_COLUMNS = `
  ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS shift_id UUID;
  ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS break_minutes INT NOT NULL DEFAULT 0;
  -- Who or what produced the row: 'self' (the person punched), 'admin' (the HR grid),
  -- 'leave' (markLeaveAttendance), 'correction' (an approved correction was applied). Descriptive,
  -- never authorising.
  ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS source TEXT;
  ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS qr_station_id UUID;
  ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS qr_code_raw TEXT;
  ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS source TEXT;
`;

// The fifteen statements of ensureAttendanceSchema() that are not individually tolerated, in their
// original order, as one message.
const ATTENDANCE_DDL =
  DDL_SHIFTS + DDL_ROSTER + DDL_HOLIDAYS + DDL_QR_STATIONS + DDL_CORRECTIONS + DDL_ADDITIVE_COLUMNS;

/**
 * Create the attendance tables if they are absent. Idempotent, safe on every request.
 *
 * ensureBatch() is ensureOnce() underneath, so the two properties every caller here depends on are
 * unchanged: a failed run is dropped from the cache so the next call retries it, and the rejection
 * is swallowed for the caller so consumers keep the tolerate-missing-schema behaviour the rest of
 * this codebase relies on. Every reader in src/lib/attendance.ts fails closed on top of that — no
 * schema means no attendance data, never an assumed present day.
 *
 * The log-and-re-throw wrapper this function used to carry went with the statements it wrapped: the
 * re-throw existed to make ensureOnce drop the cache entry, which ensureBatch's own ensureOnce does,
 * and ensureOnce logs the key with e.cause.message — the same reason logFail() was printing under a
 * second prefix. logFail() is still what the tolerated indexes use.
 */
export async function ensureAttendanceSchema(): Promise<void> {
  await ensureBatch('attendance_v1', ATTENDANCE_DDL);
  await ensureOnce('attendance_v1_tolerated_idx', createAttendanceToleratedIndexes);
}

/**
 * The four indexes that are allowed to fail on their own, in the order they held among the
 * statements above. Each keeps its own try/catch and its own log line, which is exactly why none of
 * them can go in the batch: a refusal here is a data-repair job, not a reason to lose the tables.
 *
 * Nothing in this function throws, so its ensureOnce key resolves and is not retried in this
 * process — the intended shape for statements whose failure is tolerated. See the note at the top
 * of this file for what that means on the run where the batch itself failed first.
 */
async function createAttendanceToleratedIndexes(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_roster_one_open
        ON hr_roster_assignments (employee_id) WHERE effective_to IS NULL`);
  } catch (e: any) {
    // A pre-existing table with two open rows for one person would reject this. Log it and carry
    // on: the application-side supersede in attendance.ts closes the old row in the same statement
    // that opens the new one, so the invariant holds through the only writer either way.
    logFail('hr_roster_one_open', e);
  }

  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_holidays_date_scope
        ON hr_holidays (holiday_date, COALESCE(department_id, ''))`);
  } catch (e: any) {
    logFail('hr_holidays_date_scope', e);
  }

  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_qr_station_code ON hr_attendance_qr_stations (code)`);
  } catch (e: any) {
    logFail('hr_qr_station_code', e);
  }

  // -----------------------------------------------------------------------------------------
  // THE UNIQUENESS EIGHT UPSERTS DEPEND ON, WHICH ONLY A BRAND-NEW DATABASE HAD.
  //
  // `UNIQUE (employee_id, date)` is declared ONLY inside the CREATE TABLE body at
  // db/hr-schema.sql:140, and that file's own comment two lines below says the production table
  // pre-dates it and the CREATE "only fills a brand-new one" — which is exactly why overtime_hours
  // was given an explicit ALTER and this constraint was not. No module CREATEs hr_attendance (this
  // file only ALTERs columns onto it) and there is no ADD CONSTRAINT anywhere in the repository.
  //
  // Without it every `ON CONFLICT (employee_id, date)` fails with "there is no unique or exclusion
  // constraint matching the ON CONFLICT specification" — clock-in, clock-out, the HR bulk-mark grid
  // and approved-leave propagation all die together (src/lib/attendance.ts:1246/1721/2237,
  // src/lib/hr-leave.ts:1047/1055/1063, /admin/hr/attendance/index.astro:83/110,
  // /portal/employee.astro:270). ON CONFLICT infers from a unique INDEX just as it does from a
  // table constraint, and CREATE UNIQUE INDEX IF NOT EXISTS is the only additive, idempotent form.
  //
  // ITS OWN try/catch, DELIBERATELY. If a live table already holds two rows for one employee-day
  // the index cannot be built, and that must not abort the rest of this ensure (which re-throws) or
  // take the module down. It is logged as the data-repair job it is; the day's rows must be merged
  // by hand before the guarantee can be restored.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_attendance_emp_date_uniq ON hr_attendance (employee_id, date)`);
  } catch (e: any) {
    console.error('[attendance-schema] could not create the UNIQUE index on hr_attendance (employee_id, date) — duplicate rows for one employee-day probably exist and must be merged by hand; until then every attendance upsert will fail:', e?.cause?.message || e?.message);
  }
}

// =================================================================================================
// WORKING TIME: OVERTIME CLAIMS, WEEKLY TIMESHEETS, AND THE HOLIDAY LOCATION
// =================================================================================================

// -----------------------------------------------------------------------------------------
// HOLIDAYS GAIN A LOCATION. Null means everywhere.
//
// A holiday list without one is unusable in this country: a state holiday is a working day two
// states away, and an organisation with people in both had to choose which half of its staff
// the calendar would be wrong for. department_id already scopes by TEAM; location scopes by
// WHERE SOMEBODY IS, and the two are independent questions.
//
// The uniqueness key that has to widen with it is a separate, individually tolerated pair —
// createWorkingTimeToleratedIndexes() below, where the rest of that note lives.
// -----------------------------------------------------------------------------------------
const DDL_HOLIDAY_LOCATION = `
  ALTER TABLE hr_holidays ADD COLUMN IF NOT EXISTS location TEXT;
`;

// -----------------------------------------------------------------------------------------
// HALF DAYS ON THE DAY ROW.
//
// hr_attendance.status is one word for a whole day, and a half day is not one of the words it
// can say. Without these two columns an approved half-day leave has to be rendered as either a
// full 'on_leave' day (the person is recorded absent for a day they worked half of) or as
// nothing at all (the leave they were granted vanishes from the day). Both are wrong in a way
// payroll reads.
//
// leave_units is the FRACTION OF THE DAY that was leave: 0.5 for a half day, 0.13 for an hour of
// an eight-hour day, 1 for a whole one. leave_type says which allowance it came out of.
// -----------------------------------------------------------------------------------------
const DDL_HALF_DAY_COLUMNS = `
  ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS leave_units NUMERIC(4,2);
  ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS leave_type TEXT;
`;

// -----------------------------------------------------------------------------------------
// OVERTIME CLAIMS. THE FACTS OF THE CLAIM — AND NOT ITS APPROVAL.
//
// NO status COLUMN, for the same reason hr_attendance_corrections has none: whether a claim is
// waiting, approved, rejected or halted is answered by workflow_instances keyed on
// (domain = 'overtime', record_id = this row's id). src/lib/workflow.ts is the only approval
// engine in this codebase and a status column here would be a second one.
//
// OVERTIME IS NEVER CREDITED AUTOMATICALLY, and this table is why it cannot be: extra minutes
// computed from punches are a NUMBER ON A SCREEN until a person claims them and an approver the
// organization graph named says yes. Only then does applied_at get a timestamp and only then
// does anything become comp off or pay. A stuck clock must never turn into a day's wages.
//
// convert_to records what the claim ASKS for. It decides nothing on its own.
// -----------------------------------------------------------------------------------------
const DDL_OVERTIME = `
  CREATE TABLE IF NOT EXISTS hr_overtime_requests (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id          UUID NOT NULL,
    work_date            DATE NOT NULL,
    minutes              INT NOT NULL,
    reason               TEXT NOT NULL,
    convert_to           TEXT NOT NULL DEFAULT 'comp_off',
    worked_holiday       BOOLEAN NOT NULL DEFAULT FALSE,
    requested_by_user_id UUID,
    applied_at           TIMESTAMPTZ,
    withdrawn_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS hr_overtime_emp_idx
    ON hr_overtime_requests (employee_id, work_date DESC);
`;

// -----------------------------------------------------------------------------------------
// WEEKLY TIMESHEETS. A DECLARATION, not a second attendance record.
//
// The punches say what the clock saw. The timesheet is what the PERSON says their week was, in
// their own words, per day, with a mode and — where the work has one — a project. Approving it
// does NOT rewrite hr_attendance, deliberately: two writers for one day's hours is how "on
// leave" and "present" end up both true, and this file's header says so.
//
// NO status COLUMN HERE EITHER. workflow_instances, domain 'timesheet', record_id = this id.
//
// project IS FREE TEXT, DELIBERATELY, AND THIS IS THE FOLLOW-UP TO WRITE DOWN. A project register
// (src/lib/projects.ts) landed in the same phase as this table, in parallel. A foreign key added
// now would couple the timesheet to a schema that was still being written the same week, and a
// wrong id is harder to repair than a name. So the column holds what the person typed, and the
// migration that turns these names into project ids is a deliberate, reviewable step somebody
// takes once both modules have settled. Nothing is lost in the meantime — the text is the answer
// to "what was this week's work", which is what the approver is reading it for.
//
// The two CREATE TABLEs had hr_timesheet_emp_week between them in the original sequence. That
// index is individually tolerated, so it moved to createWorkingTimeToleratedIndexes() and the
// tables are now adjacent. Neither table depends on the index.
// -----------------------------------------------------------------------------------------
const DDL_TIMESHEETS = `
  CREATE TABLE IF NOT EXISTS hr_timesheets (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id          UUID NOT NULL,
    week_start           DATE NOT NULL,
    note                 TEXT,
    submitted_by_user_id UUID,
    submitted_at         TIMESTAMPTZ,
    withdrawn_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS hr_timesheet_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timesheet_id UUID NOT NULL,
    work_date    DATE NOT NULL,
    minutes      INT NOT NULL DEFAULT 0,
    work_mode    TEXT,
    project      TEXT,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

// The seven statements of ensureWorkingTimeSchema() that are not individually tolerated, in their
// original order, as one message.
const WORKING_TIME_DDL =
  DDL_HOLIDAY_LOCATION + DDL_HALF_DAY_COLUMNS + DDL_OVERTIME + DDL_TIMESHEETS;

/**
 * The second half of the attendance storage. Idempotent, safe on every request, own ensureOnce key.
 *
 * Same shape as ensureAttendanceSchema(): the run that is not individually tolerated goes as one
 * message under the key it has always had, and ensureBatch's ensureOnce still drops that key on
 * failure so the next call retries rather than a transient error poisoning the process.
 */
export async function ensureWorkingTimeSchema(): Promise<void> {
  await ensureBatch('working_time_v1', WORKING_TIME_DDL);
  await ensureOnce('working_time_v1_tolerated_idx', createWorkingTimeToleratedIndexes);
}

/**
 * The five statements of the working-time bootstrap that are allowed to fail on their own, in the
 * order they held among the statements above. The first two are a PAIR, and that pair is the
 * clearest reason none of this can be batched: the DROP runs only if the CREATE succeeded, which is
 * a decision taken in TypeScript between two round trips and has no expression inside one block of
 * SQL sent as a single transaction.
 */
async function createWorkingTimeToleratedIndexes(): Promise<void> {
  // -----------------------------------------------------------------------------------------
  // THE UNIQUENESS KEY HAS TO WIDEN WITH hr_holidays.location. hr_holidays_date_scope is
  // (holiday_date, COALESCE(department_id,'')), so two DIFFERENT regional holidays falling on one
  // date would collide and the second would be silently dropped by ON CONFLICT DO NOTHING. The
  // wider index is created FIRST and the narrow one dropped only if that succeeded, so there is
  // no instant at which the table has no uniqueness at all. If the create fails, the drop does not
  // run and the old, stricter rule stays in force.
  // -----------------------------------------------------------------------------------------
  let wideIndex = false;
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_holidays_date_scope_loc
        ON hr_holidays (holiday_date, COALESCE(department_id, ''), COALESCE(location, ''))`);
    wideIndex = true;
  } catch (e: any) {
    logFail('hr_holidays_date_scope_loc', e);
  }
  if (wideIndex) {
    try {
      await db.execute(sql`DROP INDEX IF EXISTS hr_holidays_date_scope`);
    } catch (e: any) {
      // Uniqueness is still enforced, just more strictly than intended. Worth a log, not a failure.
      logFail('drop hr_holidays_date_scope', e);
    }
  }

  try {
    // One LIVE claim per person per day. A withdrawn one does not block a corrected re-claim.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_overtime_one_live
        ON hr_overtime_requests (employee_id, work_date) WHERE withdrawn_at IS NULL`);
  } catch (e: any) {
    logFail('hr_overtime_one_live', e);
  }

  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_timesheet_emp_week
        ON hr_timesheets (employee_id, week_start)`);
  } catch (e: any) {
    logFail('hr_timesheet_emp_week', e);
  }

  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_timesheet_entry_day
        ON hr_timesheet_entries (timesheet_id, work_date)`);
  } catch (e: any) {
    logFail('hr_timesheet_entry_day', e);
  }
}
