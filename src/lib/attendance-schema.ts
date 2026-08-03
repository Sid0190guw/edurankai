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

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from './ensure-once';

const logFail = (tag: string, e: any) =>
  console.error('[attendance-schema] ' + tag, e?.cause?.message || e?.message);

/**
 * Create the attendance tables if they are absent. Idempotent, safe on every request.
 *
 * The catch RE-THROWS after logging, exactly as ensureOrgGraphSchema() does: ensureOnce() drops a
 * failed run from its cache so the next call retries, and it swallows the rejection for the caller
 * so consumers keep the tolerate-missing-schema behaviour the rest of this codebase relies on.
 * Every reader in src/lib/attendance.ts fails closed on top of that — no schema means no attendance
 * data, never an assumed present day.
 */
export function ensureAttendanceSchema(): Promise<void> {
  return ensureOnce('attendance_v1', async () => {
    try {
      await createAttendanceTables();
    } catch (e: any) {
      logFail('ensureAttendanceSchema', e);
      throw e;
    }
  });
}

async function createAttendanceTables(): Promise<void> {
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
  await db.execute(sql`
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
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_shifts_active_idx ON hr_shifts (is_active, name)`);

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
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS hr_roster_assignments (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id    UUID NOT NULL,
      shift_id       UUID NOT NULL,
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
      effective_to   DATE,
      note           TEXT,
      created_by     UUID,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS hr_roster_emp_idx
      ON hr_roster_assignments (employee_id, effective_from DESC)`);
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

  // -----------------------------------------------------------------------------------------
  // HOLIDAYS. department_id is TEXT and NULL means the whole organization.
  //
  // The uniqueness key uses COALESCE(department_id, '') because NULLs do not collide in a plain
  // unique index — without it, "Independence Day, organization-wide" could be inserted a dozen
  // times and the holiday calendar would render twelve identical rows.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS hr_holidays (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      holiday_date  DATE NOT NULL,
      name          TEXT NOT NULL,
      department_id TEXT,
      is_optional   BOOLEAN NOT NULL DEFAULT FALSE,
      note          TEXT,
      created_by    UUID,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_holidays_date_idx ON hr_holidays (holiday_date)`);
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_holidays_date_scope
        ON hr_holidays (holiday_date, COALESCE(department_id, ''))`);
  } catch (e: any) {
    logFail('hr_holidays_date_scope', e);
  }

  // -----------------------------------------------------------------------------------------
  // QR STATIONS. A code printed on a wall, and where that wall is.
  //
  // radius_m is used ONLY to phrase a sentence for a human ("recorded 340 m from Head Office,
  // which is outside the 100 m the station expects"). Nothing compares against it to decide
  // anything. See the header.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`
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
    )`);
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS hr_qr_station_code ON hr_attendance_qr_stations (code)`);
  } catch (e: any) {
    logFail('hr_qr_station_code', e);
  }

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
  await db.execute(sql`
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
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS hr_corrections_emp_idx
      ON hr_attendance_corrections (employee_id, work_date DESC)`);

  // -----------------------------------------------------------------------------------------
  // ADDITIVE COLUMNS ON THE TABLES THAT ALREADY EXIST.
  //
  // ADD COLUMN IF NOT EXISTS, so this is a no-op on the production tables and only completes a
  // fresh environment. Nothing is retyped and nothing is dropped.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS shift_id UUID`);
  await db.execute(sql`ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS break_minutes INT NOT NULL DEFAULT 0`);
  // Who or what produced the row: 'self' (the person punched), 'admin' (the HR grid),
  // 'leave' (markLeaveAttendance), 'correction' (an approved correction was applied). Descriptive,
  // never authorising.
  await db.execute(sql`ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS source TEXT`);
  await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS qr_station_id UUID`);
  await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS qr_code_raw TEXT`);
  await db.execute(sql`ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS source TEXT`);
}
