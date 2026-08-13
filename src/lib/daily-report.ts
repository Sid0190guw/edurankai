// src/lib/daily-report.ts — the daily work report: A LINK AND A SENTENCE, never a file.
//
// =================================================================================================
// WHY THERE IS NO UPLOAD HERE, AND NEVER WILL BE
// =================================================================================================
//
// Documents of every kind on this platform are Drive links. The ONLY stored upload anywhere is a
// small profile photo, and the reason is stated and unchanged: storage costs money per byte per
// month, forever, for a document that already exists in the submitter's own Drive. A daily report
// from every intern every working day is the single highest-volume document in the product; the
// version of this feature that accepts files is the version that quietly becomes the largest line
// on the hosting bill.
//
// So a report is: the DAY it covers, a LINK to the work, a SHORT SUMMARY of what was done, and
// optionally what is blocking. Nothing is copied onto our storage.
//
// =================================================================================================
// NO SECOND TABLE. hr_daily_reports ALREADY EXISTS.
// =================================================================================================
//
// db/hr-schema.sql:171 declares hr_daily_reports (employee_id, report_date, work_done, progress,
// blockers) with a UNIQUE (employee_id, report_date) constraint, and three surfaces already read or
// write it: /portal/employee (the dailyreport.today widget), /portal/workspace, /admin/hr/employees,
// /admin/users and /admin/hr/attendance all join it. A new hr_intern_daily_reports table would mean
// two rows claiming to be "the report for Tuesday" and two screens disagreeing about whether one was
// filed.
//
// This module therefore ADDS COLUMNS to that table and reuses work_done as the summary, so a report
// filed from the workspace widget and one filed from /portal/employee/reports are the SAME ROW.
//
// =================================================================================================
// WHAT A RESUBMIT DOES, AND WHY IT IS NOT A SILENT OVERWRITE
// =================================================================================================
//
// One row per person per day is the key, so a resubmit UPDATES. But an update that discards what was
// there before makes a reviewer's memory unfalsifiable — they read "we shipped the parser" on
// Tuesday evening, and on Wednesday the row says something else with no trace. So the previous
// values are copied into hr_daily_report_revisions BEFORE the update, revision_count increments, and
// a report that was already reviewed records WHICH revision was reviewed. A reviewer then sees
// "reviewed at revision 1, revised twice since" instead of a stale green tick.
//
// =================================================================================================
// THE SHARING WARNING IS THE POINT OF THE VALIDATION, NOT A SIDE EFFECT
// =================================================================================================
//
// We can check that a link is a Drive address. We CANNOT check who can open it, and neither can the
// submitter: their own link always opens for them because they are signed in as its owner. The
// failure is therefore invisible on one side and infuriating on the other — the reviewer opens an
// access-denied page and has no way to tell a badly-shared link from a person who filed nothing.
// checkDriveLink() consequently returns a `warning` on SUCCESS, and every surface renders it at the
// moment of pasting rather than after submission.
//
// =================================================================================================
// OUTSTANDING IS ANCHORED ON THE CLOCK, NOT ON A ROSTER, AND PENALISES NOBODY
// =================================================================================================
//
// A day counts as outstanding when the attendance row says the person WORKED it and no report
// exists. Not "every weekday" — an intern with no roster recorded would otherwise accumulate a
// column of accusations for days nobody asked them to work. And "clocked in, filed nothing" is a
// genuinely different state from "did neither", which the founder asked for explicitly: the first is
// a conversation, the second is not.
//
// A day with a clock-in and NO clock-out is INCOMPLETE. hr_attendance stores work_hours = 0 for it
// (attendance.ts computeDay(): with no clock_out there is no span), and reading that zero as "worked
// nothing" is a lie in exactly the same way as assuming a full day would be. Every figure this
// module produces reports incomplete days SEPARATELY and never folds them into a total.
//
// NOTHING HERE PENALISES ANYONE. There is no score, no streak, no flag column, and no automatic
// consequence for a gap. A missing report is displayed to a human who decides what it means.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Every read goes through rows(); never r.rows[0].
//   - The real Postgres reason is on e.cause. Logged as e?.cause?.message || e?.message.
//   - Write paths NEVER swallow. submitReport/markReviewed return { ok:false, error } with the
//     database's own words, and log the cause. Only the notification that FOLLOWS a committed write
//     is allowed to fail quietly, and it is logged when it does.
//   - Self-bootstrapping DDL only, inside an ensureOnce guard.
//   - Every const is declared above the function that reads it.
//   - One notifier (src/lib/push.ts), one audit (src/lib/audit.ts). No approval engine is used here:
//     a daily report is not approved, it is READ. Adding a workflow_instances row for it would put a
//     pending/approved state machine on a diary entry.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
import {
  isInitialized as orgIsInitialized,
  getManager,
  getMentor,
  getDirectReports,
  getReviewSubjects,
  employeeIdForUser,
  type OrgPerson,
} from '@/lib/org-graph';
import { today as attendanceToday, weekStartIso, shiftDateIso, dateRange, weekdayName } from '@/lib/attendance';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND SMALL HELPERS — all declared before anything that reads them.
// -------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[daily-report] ' + tag, e?.cause?.message || e?.message);

const errText = (e: any, fallback: string): string => {
  const m = e?.cause?.message || e?.message;
  return m ? String(m) : fallback;
};

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

const isoAt = (d: any): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(String(d));
  return isNaN(dt.getTime()) ? null : dt.toISOString();
};

/** How far back a person may file without HR. Older days are a correction conversation, not a form. */
export const BACKFILL_DAYS = 30;

/** A summary shorter than this is not a summary. Matches the existing workspace widget's rule. */
export const MIN_SUMMARY_CHARS = 10;

/** How many people one reviewer screen will read at a time. Beyond this the page says so. */
export const ROSTER_CAP = 40;

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * Add this module's columns to the table that already exists, and create the revision trail.
 *
 * THE CREATE TABLE IS THE CANONICAL SHAPE, copied from db/hr-schema.sql:171 including the constraint
 * NAME, so a fresh database gets the same table the rest of the product already reads — and an
 * existing one gets a no-op. push.ts documents the trap this avoids: a second CREATE listing FEWER
 * columns than its writers use is a no-op on an existing table and a permanent breakage on a new one.
 * Every column any writer here names is added below, so that cannot happen.
 *
 * The UNIQUE (employee_id, report_date) constraint is what makes "one report per person per day"
 * true in the DATABASE rather than merely in this file — the ON CONFLICT in submitReport depends on
 * it, and so does the workspace widget's own upsert.
 */
export function ensureDailyReportSchema(): Promise<void> {
  return ensureOnce('daily_report_v1', async () => {
    try {
      await db.execute(sql`
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
        )`);

      // The link, and what the submitter said about how it is shared. sharing_ack is an
      // ACKNOWLEDGEMENT, never a verification — see checkDriveLink().
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS report_url TEXT`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS sharing_ack BOOLEAN NOT NULL DEFAULT FALSE`);

      // The resubmit trace. revision_count is 0 for a first filing.
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS revision_count INT NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS last_revised_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID`);

      // The review. reviewed_revision records WHICH revision was read, so a later edit shows as
      // "revised since it was reviewed" instead of leaving a tick over changed text.
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_by_employee_id UUID`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS review_comment TEXT`);
      await db.execute(sql`ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS reviewed_revision INT`);

      // A reviewer's screen reads BY DATE across several people; the existing index is by employee.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_daily_reports_date_idx ON hr_daily_reports (report_date DESC)`);

      // -------------------------------------------------------------------------------------------
      // THE REVISION TRAIL. Append-only, and holds the PREVIOUS values of a row that was edited.
      //
      // Nothing in this codebase already stores one — grep for _revisions finds only
      // src/lib/submissions.ts, where 'request_revisions' is a REVIEW VERDICT on an applicant task
      // and not a history of anything. So this table is new, and it is the smallest thing that makes
      // "a resubmit keeps a trace" true.
      // -------------------------------------------------------------------------------------------
      await db.execute(sql`
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
        )`);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS hr_daily_report_rev_idx
          ON hr_daily_report_revisions (report_id, revision DESC)`);
      // ONE SNAPSHOT PER REVISION, AND THE DATABASE IS WHAT SAYS SO.
      //
      // The index above is not unique, so two submits landing together both snapshotted the SAME
      // revision number and the text in between existed in neither the trail nor the live row — it
      // was simply gone, while the counter jumped by two and both screens told their author they had
      // filed the next revision. submitReport() now takes the row lock that makes that impossible;
      // this index is what makes it impossible to have MISSED a case.
      //
      // ADDITIVE AND NON-FATAL. A trail that already carries a duplicated (report_id, revision) pair
      // cannot take the index, and that must not stop the module loading — it is logged with the
      // query to run, because the duplicate itself is the evidence that somebody's edit was lost.
      try {
        await db.execute(sql`
          CREATE UNIQUE INDEX IF NOT EXISTS hr_daily_report_rev_uniq
            ON hr_daily_report_revisions (report_id, revision)`);
      } catch (e: any) {
        console.error(
          '[daily-report] could not create hr_daily_report_rev_uniq. Two snapshots of one revision '
          + 'already exist, which means a report edit was overwritten with no copy kept. Check with: '
          + 'SELECT report_id, revision, count(*) FROM hr_daily_report_revisions '
          + 'GROUP BY report_id, revision HAVING count(*) > 1; -- reason: '
          + String(e?.cause?.message || e?.message || 'unknown database error'),
        );
      }
    } catch (e: any) {
      // Re-thrown after logging so ensureOnce drops the failed run from its cache and the next
      // request retries, matching ensureAttendanceSchema()'s discipline.
      logFail('ensureDailyReportSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// THE LINK CHECK — PURE, AND HONEST ABOUT WHAT IT CANNOT SEE
// -------------------------------------------------------------------------------------------------

/** The two addresses a Drive share dialog produces. Anything else is not a shareable Drive link. */
export const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'] as const;

/**
 * Shown at the moment of pasting, on success, every time. It is the only defence against a failure
 * neither side can see until the reviewer hits it.
 */
export const SHARING_WARNING =
  'Set this file to "Anyone with the link" before you submit. Open it, choose Share, and change '
  + 'General access from Restricted to "Anyone with the link". We can check the address is a Drive '
  + 'link; we cannot check who is allowed to open it — and neither can you, because your own link '
  + 'always opens for you as its owner. If it is left restricted, your reviewer gets an '
  + 'access-denied page and cannot tell that apart from a report you never filed.';

/** What kind of thing the link points at. Display only — nothing branches on it. */
export type DriveLinkKind =
  | 'document' | 'spreadsheet' | 'presentation' | 'form' | 'file' | 'folder' | 'drive' | 'unknown';

export interface DriveLinkCheck {
  ok: boolean;
  /** The link as it will be stored: trimmed, with a scheme. Empty when it could not be read. */
  url: string;
  host: string | null;
  kind: DriveLinkKind;
  /** Why it was refused. Empty when ok. */
  problem: string;
  /** The sharing warning, present whenever ok. Never suppressed on a "looks fine" link. */
  warning: string;
  /** Extra things worth saying that are NOT refusals — e.g. an account-scoped /u/0/ address. */
  notes: string[];
}

const KIND_BY_PATH: [RegExp, DriveLinkKind][] = [
  [/^\/document\//, 'document'],
  [/^\/spreadsheets\//, 'spreadsheet'],
  [/^\/presentation\//, 'presentation'],
  [/^\/forms\//, 'form'],
  [/\/folders\//, 'folder'],
  [/\/file\//, 'file'],
];

function kindFor(pathname: string): DriveLinkKind {
  for (const [re, kind] of KIND_BY_PATH) if (re.test(pathname)) return kind;
  return pathname.startsWith('/drive') ? 'drive' : 'unknown';
}

/**
 * Is this a Drive link we can store, and what must the submitter be told about it?
 *
 * PURE, so the live check as somebody types and the check the write path runs are THE SAME RULE.
 * A client-side regex beside a server-side one is how a form starts accepting what the server then
 * refuses.
 *
 * A missing scheme is repaired rather than refused: people paste `drive.google.com/file/d/...` from
 * an address bar constantly, and refusing that teaches nothing. `http://` is refused rather than
 * upgraded — silently rewriting somebody's URL is a change we would not be able to explain later.
 */
export function checkDriveLink(raw: unknown): DriveLinkCheck {
  const empty: DriveLinkCheck = { ok: false, url: '', host: null, kind: 'unknown', problem: '', warning: '', notes: [] };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return { ...empty, problem: 'Paste the link to today\'s report.' };
  }
  if (/\s/.test(text)) {
    return { ...empty, url: text, problem: 'That has a space in it, so it is not a single link. Copy the link again from the Share dialog.' };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ...empty, url: text, problem: 'That is not a web address. Open the file in Drive, choose Share, then Copy link.' };
  }

  if (parsed.protocol === 'http:') {
    return {
      ...empty, url: text, host: parsed.hostname,
      problem: 'Use the https:// address. Drive always gives you one; an http:// link is not the link it produced.',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ...empty, url: text, host: parsed.hostname,
      problem: 'Only an https:// Drive link can be stored here.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!(DRIVE_HOSTS as readonly string[]).includes(host)) {
    return {
      ...empty, url: withScheme, host,
      problem: 'That is not a Drive link. Reports are kept in your own Drive and shared by link, never '
        + 'uploaded here. The address must begin https://drive.google.com/ or https://docs.google.com/ — '
        + 'open your file, choose Share, then Copy link.',
    };
  }

  const notes: string[] = [];
  if (/\/u\/\d+\//.test(parsed.pathname)) {
    notes.push(
      'This link has an account number in it (the /u/0/ part). That points at whichever account the '
      + 'person opening it signed in with first, which may not be the one you shared with. Copy the '
      + 'link from the Share dialog instead of the address bar.',
    );
  }
  if (/^\/drive\/my-drive/.test(parsed.pathname) || parsed.pathname === '/drive' || parsed.pathname === '/drive/') {
    notes.push('This looks like a link to your whole Drive rather than to one file or folder. Nobody else can open that.');
  }

  return {
    ok: true,
    url: withScheme,
    host,
    kind: kindFor(parsed.pathname),
    problem: '',
    warning: SHARING_WARNING,
    notes,
  };
}

// -------------------------------------------------------------------------------------------------
// THE DAY, AS THE CLOCK RECORDED IT
// -------------------------------------------------------------------------------------------------

/**
 * What an attendance row says about a day.
 *
 *  unrecorded  no hr_attendance row at all — nothing was clocked and nothing was marked
 *  incomplete  a clock-in with no clock-out. The stored work_hours is 0 and MUST NOT be read as
 *              "worked nothing", nor assumed to be a full day. Both are lies.
 *  worked      clocked in and out; workedMinutes is net of breaks
 *  leave       recorded as on_leave
 *  absent      recorded absent
 *  holiday     recorded as a holiday
 */
export type DayState = 'unrecorded' | 'incomplete' | 'worked' | 'leave' | 'absent' | 'holiday';

export interface AttendanceFact {
  dateIso: string;
  weekday: string;
  state: DayState;
  status: string | null;
  clockIn: string | null;
  clockOut: string | null;
  /** Net of breaks. NULL — not 0 — when the day is incomplete or nothing was recorded. */
  workedMinutes: number | null;
  breakMinutes: number | null;
  /** True when the clock says this day was worked (complete or not). Drives "outstanding". */
  wasWorked: boolean;
}

const DAY_STATE_SENTENCE: Record<DayState, string> = {
  unrecorded: 'No attendance recorded for this day.',
  incomplete: 'Checked in but never checked out, so the worked time for this day is not known.',
  worked: 'Worked, net of breaks.',
  leave: 'Recorded as leave.',
  absent: 'Recorded as absent.',
  holiday: 'Holiday.',
};

/** A sentence a person can read, for each day state. */
export function dayStateSentence(state: DayState): string {
  return DAY_STATE_SENTENCE[state] || '';
}

function factFromRow(dateIso: string, row: any): AttendanceFact {
  const weekday = weekdayName(dateIso);
  if (!row) {
    return {
      dateIso, weekday, state: 'unrecorded', status: null,
      clockIn: null, clockOut: null, workedMinutes: null, breakMinutes: null, wasWorked: false,
    };
  }
  const status = row.status ? String(row.status) : null;
  const clockIn = isoAt(row.clock_in);
  const clockOut = isoAt(row.clock_out);
  const minutes = Math.round((Number(row.work_hours) || 0) * 60);
  const breaks = Number(row.break_minutes) || 0;

  let state: DayState;
  if (status === 'holiday') state = 'holiday';
  else if (status === 'on_leave') state = 'leave';
  else if (status === 'absent' && !clockIn) state = 'absent';
  else if (clockIn && !clockOut) state = 'incomplete';
  else if (clockIn || minutes > 0) state = 'worked';
  else state = status === 'absent' ? 'absent' : 'unrecorded';

  return {
    dateIso, weekday, state, status, clockIn, clockOut,
    // NULL, deliberately, on an incomplete day. A caller that wants to print a number has to
    // acknowledge the null and say why there isn't one.
    workedMinutes: state === 'worked' ? minutes : null,
    breakMinutes: state === 'worked' || state === 'incomplete' ? breaks : null,
    wasWorked: state === 'worked' || state === 'incomplete',
  };
}

/**
 * Attendance facts for one or more people across a date range, in ONE query.
 *
 * READS hr_attendance DIRECTLY and computes NOTHING it does not have to: the net-of-breaks
 * arithmetic already happened in src/lib/attendance.ts computeDay() when the punch was recorded, and
 * work_hours is where it landed (attendance.ts writeDayFromPunches). Recomputing it here from the
 * punch log would be a second implementation of the same rule, which is how two screens start
 * disagreeing about somebody's Tuesday.
 *
 * The list must be BOUNDED by the caller — there is no LIMIT, because a LIMIT across several people
 * silently truncates the last person's days and understates them.
 */
export async function attendanceFacts(
  employeeIds: string[],
  from: string,
  to: string,
): Promise<Map<string, Map<string, AttendanceFact>>> {
  const out = new Map<string, Map<string, AttendanceFact>>();
  const ids = (employeeIds || []).filter(isUuid);
  if (!ids.length || !isDateIso(from) || !isDateIso(to) || to < from) return out;

  const dates = dateRange(from, to);
  for (const id of ids) out.set(id, new Map());

  let byEmployee = new Map<string, Map<string, any>>();
  try {
    // ::text on BOTH sides. hr_attendance.employee_id is uuid here, but casting the parameter list
    // the other way (::uuid) throws outright on anything that is not one and takes the page down.
    // AN IN LIST, NOT = ANY($array). This driver sends a JS array as a plain parameter, never as a
    // typed array, and Postgres answers "op ANY/ALL (array) requires array on right side" — so this
    // query threw on EVERY call. Both callers wrap it in a catch that logs and returns an empty map,
    // which means a review screen would have shown "nobody submitted anything" for a company that
    // had submitted plenty. The identical bug ran in the health check for weeks, reporting ten
    // missing tables without once reading the database.
    const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    const r = await db.execute(sql`
      SELECT employee_id::text AS employee_id, date, status, clock_in, clock_out, work_hours, break_minutes
        FROM hr_attendance
       WHERE employee_id::text IN (${idList})
         AND date >= ${from}::date
         AND date <= ${to}::date`);
    for (const row of rows(r)) {
      const key = String(row.employee_id);
      const m = byEmployee.get(key) || new Map<string, any>();
      m.set(iso(row.date), row);
      byEmployee.set(key, m);
    }
  } catch (e: any) {
    // Every id is already seeded with an empty map, so a failure reads as "nothing recorded" per
    // person. The CALLER must say on screen that attendance could not be read — see the surfaces.
    logFail('attendanceFacts', e);
    byEmployee = new Map();
  }

  for (const id of ids) {
    const rowsFor = byEmployee.get(id) || new Map<string, any>();
    const day = out.get(id)!;
    for (const d of dates) day.set(d, factFromRow(d, rowsFor.get(d) || null));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// READING REPORTS
// -------------------------------------------------------------------------------------------------

export interface DailyReport {
  id: string;
  employeeId: string;
  dateIso: string;
  url: string | null;
  summary: string;
  blockers: string | null;
  sharingAck: boolean;
  revision: number;
  createdAt: string | null;
  lastRevisedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reviewComment: string | null;
  reviewedRevision: number | null;
  /** True when the report changed AFTER it was reviewed — the tick no longer covers what is there. */
  revisedSinceReview: boolean;
  /** True for a row filed before this module existed: text, but no link. Shown as such, never hidden. */
  predatesLink: boolean;
}

const REPORT_COLS = sql`id, employee_id::text AS employee_id, report_date, report_url, work_done,
  blockers, sharing_ack, revision_count, created_at, last_revised_at,
  reviewed_at, reviewed_by_user_id::text AS reviewed_by_user_id, review_comment, reviewed_revision`;

function mapReport(row: any): DailyReport {
  const revision = Number(row?.revision_count) || 0;
  const reviewedAt = isoAt(row?.reviewed_at);
  const reviewedRevision = row?.reviewed_revision == null ? null : Number(row.reviewed_revision);
  const url = row?.report_url ? String(row.report_url) : null;
  return {
    id: String(row?.id ?? ''),
    employeeId: String(row?.employee_id ?? ''),
    dateIso: iso(row?.report_date),
    url,
    summary: row?.work_done ? String(row.work_done) : '',
    blockers: row?.blockers ? String(row.blockers) : null,
    sharingAck: row?.sharing_ack === true,
    revision,
    createdAt: isoAt(row?.created_at),
    lastRevisedAt: isoAt(row?.last_revised_at),
    reviewedAt,
    reviewedByUserId: row?.reviewed_by_user_id ? String(row.reviewed_by_user_id) : null,
    reviewComment: row?.review_comment ? String(row.review_comment) : null,
    reviewedRevision,
    revisedSinceReview: !!reviewedAt && reviewedRevision !== null && revision > reviewedRevision,
    predatesLink: !url,
  };
}

/** One person's report for one day, or null. */
export async function getReport(employeeId: string, dateIso: string): Promise<DailyReport | null> {
  if (!isUuid(employeeId) || !isDateIso(dateIso)) return null;
  try {
    await ensureDailyReportSchema();
    const r = await db.execute(sql`
      SELECT ${REPORT_COLS} FROM hr_daily_reports
       WHERE employee_id = ${employeeId}::uuid AND report_date = ${dateIso}::date
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapReport(list[0]) : null;
  } catch (e: any) {
    logFail('getReport', e);
    return null;
  }
}

/** Reports for several people over a range, keyed employeeId -> dateIso -> report. ONE query. */
export async function reportsFor(
  employeeIds: string[],
  from: string,
  to: string,
): Promise<Map<string, Map<string, DailyReport>>> {
  const out = new Map<string, Map<string, DailyReport>>();
  const ids = (employeeIds || []).filter(isUuid);
  if (!ids.length || !isDateIso(from) || !isDateIso(to) || to < from) return out;
  for (const id of ids) out.set(id, new Map());
  try {
    await ensureDailyReportSchema();
    // AN IN LIST, NOT = ANY($array). This driver sends a JS array as a plain parameter, never as a
    // typed array, and Postgres answers "op ANY/ALL (array) requires array on right side" — so this
    // query threw on EVERY call. Both callers wrap it in a catch that logs and returns an empty map,
    // which means a review screen would have shown "nobody submitted anything" for a company that
    // had submitted plenty. The identical bug ran in the health check for weeks, reporting ten
    // missing tables without once reading the database.
    const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    const r = await db.execute(sql`
      SELECT ${REPORT_COLS} FROM hr_daily_reports
       WHERE employee_id::text IN (${idList})
         AND report_date >= ${from}::date
         AND report_date <= ${to}::date
       ORDER BY report_date DESC`);
    for (const row of rows(r)) {
      const rep = mapReport(row);
      const m = out.get(rep.employeeId);
      if (m) m.set(rep.dateIso, rep);
    }
  } catch (e: any) {
    logFail('reportsFor', e);
  }
  return out;
}

/** The previous versions of one report, newest first. Empty when it has never been revised. */
export async function revisionsFor(reportId: string): Promise<{
  revision: number; url: string | null; summary: string; blockers: string | null; replacedAt: string | null;
}[]> {
  if (!isUuid(reportId)) return [];
  try {
    await ensureDailyReportSchema();
    const r = await db.execute(sql`
      SELECT revision, report_url, work_done, blockers, replaced_at
        FROM hr_daily_report_revisions
       WHERE report_id = ${reportId}::uuid
       ORDER BY revision DESC
       LIMIT 50`);
    return rows(r).map((row: any) => ({
      revision: Number(row.revision) || 0,
      url: row.report_url ? String(row.report_url) : null,
      summary: row.work_done ? String(row.work_done) : '',
      blockers: row.blockers ? String(row.blockers) : null,
      replacedAt: isoAt(row.replaced_at),
    }));
  } catch (e: any) {
    logFail('revisionsFor', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WHO READS IT — RESOLVED PER ROW FROM THE ORGANIZATION GRAPH, NEVER FROM users.role
// -------------------------------------------------------------------------------------------------

export interface ReviewerResolution {
  /** False until the founder runs the backfill. Render the honest empty state, do not guess. */
  graphReady: boolean;
  /** 'reporting_manager' | 'mentor' | null. Null with graphReady true means nobody is recorded. */
  via: 'reporting_manager' | 'mentor' | null;
  person: OrgPerson | null;
  /** A sentence for the screen. Always populated. */
  sentence: string;
}

/**
 * Who reads this person's daily report?
 *
 * THE REPORTING MANAGER FIRST, THE MENTOR AS THE RECORDED FALLBACK. Both come from
 * org_relationships, per ROW, as of now. Neither comes from users.role, and a role name could not
 * answer this question anyway: "this account is a department_head" would make one person the
 * reviewer of everybody.
 *
 * A MENTOR IS ALLOWED TO READ A DAILY REPORT, and that is a deliberate exception to
 * org-graph.ts RESPONSIBILITY_TYPES, which excludes `mentor` on the grounds that support is not
 * authority. That exclusion is about POWER — leave, pay, approvals — and it stands. Reading what
 * somebody did today, and writing a comment on it, is the substance of mentoring; a mentor who
 * cannot see their mentee's work is not a mentor. Nothing in this module lets a reviewer of either
 * kind approve, penalise or alter anything.
 *
 * THE EMPTY GRAPH IS NOT "NO MANAGER". Until db/org-graph-backfill.sql is run there are no edges at
 * all, and getManager() returns null for everybody. Guessing an approver from a department, a role
 * or an hr_employees column at that moment would name the wrong person on every screen at once.
 */
export async function reviewerFor(employeeId: string): Promise<ReviewerResolution> {
  const notReady: ReviewerResolution = {
    graphReady: false, via: null, person: null,
    sentence: 'The Organization Graph has not been initialized yet, so who reviews this report is not '
      + 'recorded anywhere we are willing to read. Nothing is guessed from a job title.',
  };
  if (!isUuid(employeeId)) return notReady;

  const ready = await orgIsInitialized();
  if (!ready) return notReady;

  const manager = await getManager(employeeId);
  if (manager) {
    return {
      graphReady: true, via: 'reporting_manager', person: manager,
      sentence: 'Reviewed by ' + (manager.fullName || 'the recorded reporting manager') + ', reporting manager.',
    };
  }
  const mentor = await getMentor(employeeId);
  if (mentor) {
    return {
      graphReady: true, via: 'mentor', person: mentor,
      sentence: 'Reviewed by ' + (mentor.fullName || 'the recorded mentor') + ', mentor.',
    };
  }
  return {
    graphReady: true, via: null, person: null,
    sentence: 'No reporting manager or mentor is recorded for this person, so nobody is named as the '
      + 'reviewer. The report is still filed, and HR can record the relationship.',
  };
}

export interface RosterEntry extends OrgPerson {
  /**
   * How this person came to be on the list. Shown, so nothing looks like a guess.
   *
   * 'everyone' is not a relationship — it is the absence of one, used by the whole-company view
   * below. Kept distinct precisely so the screen cannot imply that somebody reports to the viewer
   * when the only thing they have in common is being employed here.
   */
  via: 'reporting_manager' | 'reviewer' | 'everyone';
}

export interface ReviewerRoster {
  graphReady: boolean;
  reviewerEmployeeId: string | null;
  people: RosterEntry[];
  /** True when the graph named more people than ROSTER_CAP and the list was cut. */
  truncated: boolean;
  sentence: string;
}

/**
 * The people a signed-in user is actually responsible for, resolved per ROW.
 *
 * TWO EDGE TYPES, both read through org-graph.ts resolvers rather than a query written here:
 * `reporting_manager` (getDirectReports) and `reviewer` (getReviewSubjects). Writing a third
 * SELECT against org_relationships from this file is exactly the drift org-graph.ts's header
 * forbids, and two modules resolving one relationship is how they start disagreeing about it.
 *
 * A MENTOR'S MENTEES ARE NOT IN THIS LIST, and that is a stated gap rather than an oversight:
 * org-graph.ts exports getMentor() but no inverse resolver, and the fix belongs in that file, not
 * in a private query here. A mentor therefore opens this screen and is told plainly that only
 * reporting and review lines are listed — see the follow-up note in the return sentence. Reviewing
 * an individual report still works for a mentor, because reviewerFor() resolves the mentor edge.
 */
/**
 * Everybody currently employed, as a roster.
 *
 * =================================================================================================
 * WHY THIS EXISTS: THE REVIEW SCREEN SHOWED NOTHING WHILE NINETY-ONE REPORTS SAT IN THE TABLE
 * =================================================================================================
 *
 * reviewerRoster() answers "who is recorded as reporting to me", read from the organisation graph.
 * That is the right question for a manager, and it was the ONLY question /admin/hr/reports asked —
 * so with an empty graph the founder opened the page and saw "nobody is on your list" while people
 * were filing reports at clock-out every day.
 *
 * The page was careful to say that an empty roster does not mean nobody submitted anything, which
 * is true and was not the point: somebody who needs to READ the submissions still could not.
 *
 * So there is a second, blunter question — everybody employed — for the people whose job is to see
 * all of it. It requires no graph, because needing the graph is exactly what broke.
 *
 * `via: 'everyone'` on every entry, so the screen never implies these people report to the viewer.
 */
export async function everyoneRoster(): Promise<ReviewerRoster> {
  const empty: ReviewerRoster = {
    graphReady: true, reviewerEmployeeId: null, people: [], truncated: false,
    sentence: 'Nobody has an active employee record, so there is nobody to show.',
  };
  try {
    const list = rows(await db.execute(sql`
      SELECT id::text          AS employee_id,
             user_id::text     AS user_id,
             full_name,
             designation,
             department_id::text AS department_id
        FROM hr_employees
       WHERE is_active = true
       ORDER BY full_name ASC
       LIMIT ${ROSTER_CAP + 1}`));
    const people: RosterEntry[] = list.slice(0, ROSTER_CAP).map((r: any) => ({
      employeeId: r.employee_id ? String(r.employee_id) : null,
      userId: r.user_id ? String(r.user_id) : null,
      fullName: r.full_name ? String(r.full_name) : null,
      designation: r.designation ? String(r.designation) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      via: 'everyone',
    }));
    const truncated = list.length > ROSTER_CAP;
    return {
      graphReady: true,
      reviewerEmployeeId: null,
      people,
      truncated,
      sentence: people.length === 0
        ? empty.sentence
        : 'Everybody with an active employee record'
          + (truncated ? ', showing the first ' + ROSTER_CAP + ' by name.' : '.')
          + ' This list does not use the organisation graph, so it works whether or not that has been filled.',
    };
  } catch (e: any) {
    // NOT an empty list. "We could not read who works here" and "nobody works here" are different
    // facts, and showing the second when the first is true is how a screen lies quietly.
    logFail('everyoneRoster', e);
    return {
      graphReady: true, reviewerEmployeeId: null, people: [], truncated: false,
      sentence: 'The employee list could not be read just now, so this is not a statement that '
        + 'nobody submitted anything. Reload in a moment.',
    };
  }
}

export async function reviewerRoster(userId: string): Promise<ReviewerRoster> {
  const notReady: ReviewerRoster = {
    graphReady: false, reviewerEmployeeId: null, people: [], truncated: false,
    sentence: 'The Organization Graph has not been initialized yet. Until it is, nobody has a '
      + 'recorded team here — and a team guessed from job titles would be the wrong one.',
  };
  if (!isUuid(userId)) return notReady;

  const ready = await orgIsInitialized();
  if (!ready) return notReady;

  const me = await employeeIdForUser(userId);
  if (!me) {
    return {
      graphReady: true, reviewerEmployeeId: null, people: [], truncated: false,
      sentence: 'This sign-in has no employee record linked to it, so the graph has no edges to read '
        + 'from it. Ask HR to link your employee record.',
    };
  }

  const [reports, subjects] = await Promise.all([getDirectReports(me), getReviewSubjects(me)]);
  const seen = new Set<string>();
  const people: RosterEntry[] = [];
  for (const p of reports) {
    if (!p.employeeId || seen.has(p.employeeId)) continue;
    seen.add(p.employeeId);
    people.push({ ...p, via: 'reporting_manager' });
  }
  for (const p of subjects) {
    if (!p.employeeId || seen.has(p.employeeId)) continue;
    seen.add(p.employeeId);
    people.push({ ...p, via: 'reviewer' });
  }

  const truncated = people.length > ROSTER_CAP;
  return {
    graphReady: true,
    reviewerEmployeeId: me,
    people: truncated ? people.slice(0, ROSTER_CAP) : people,
    truncated,
    sentence: people.length
      ? 'Resolved from the Organization Graph: people who report to you, and people whose work you '
        + 'are recorded as reviewing. Mentees are not listed here — the graph has no inverse mentor '
        + 'resolver yet.'
      : 'The Organization Graph records nobody reporting to you and nobody whose work you review. '
        + 'That is what it says, not a loading state.',
  };
}

/**
 * May this signed-in user read and comment on this person's daily reports?
 *
 * Asked again at the WRITE, never inferred from the fact that a list rendered. A page that lists
 * five people is not an authorisation to review a sixth typed into a form field.
 */
export async function mayReview(userId: string, employeeId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(employeeId)) return false;
  const actor = await employeeIdForUser(userId);
  if (!actor || actor === employeeId) return false;   // nobody reviews their own report
  const resolved = await reviewerFor(employeeId);
  if (!resolved.graphReady) return false;
  if (resolved.person?.employeeId === actor) return true;
  // A recorded reviewer edge counts too, even when the manager edge named somebody else.
  const subjects = await getReviewSubjects(actor);
  return subjects.some((p) => p.employeeId === employeeId);
}

// -------------------------------------------------------------------------------------------------
// WRITING
// -------------------------------------------------------------------------------------------------

export interface SubmitInput {
  employeeId: string;
  /** The signed-in user filing it. Recorded, and used for the audit line. */
  userId: string | null;
  dateIso: string;
  url: string;
  summary: string;
  blockers?: string | null;
  /** The submitter's own statement that the file is shared as "anyone with the link". */
  sharingAck?: boolean;
}

export interface SubmitResult {
  ok: boolean;
  error: string;
  /** True when this created the day's first report, false when it revised an existing one. */
  created: boolean;
  revision: number;
  reportId: string | null;
  /** The link as stored, after checkDriveLink normalised the scheme. */
  url: string;
}

/**
 * File or revise the report for one day.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *   1. Validate everything, including the link, with the SAME pure function the form used.
 *   2. Read the existing row, if any.
 *   3. Copy the OLD values into the revision trail — BEFORE the update, or there is nothing left to
 *      copy.
 *   4. Upsert on (employee_id, report_date), the constraint db/hr-schema.sql already declares.
 *   5. Audit. Then notify. Both AFTER the row is committed, so nothing announces a write that
 *      did not happen.
 *
 * NOTHING IS SWALLOWED. A failure returns the database's own words and logs e.cause — a bare
 * `catch { error = 'could not save' }` on a write path is the pattern that hid a sign-in outage on
 * this project for hours.
 */
export async function submitReport(input: SubmitInput): Promise<SubmitResult> {
  const fail = (error: string): SubmitResult =>
    ({ ok: false, error, created: false, revision: 0, reportId: null, url: '' });

  const employeeId = String(input?.employeeId || '');
  const userId = isUuid(input?.userId) ? String(input.userId) : null;
  const dateIso = String(input?.dateIso || '');
  const summary = String(input?.summary || '').trim();
  const blockers = String(input?.blockers || '').trim() || null;
  const sharingAck = input?.sharingAck === true;

  if (!isUuid(employeeId)) return fail('We could not tell whose report this is.');
  if (!isDateIso(dateIso)) return fail('Pick the day this report covers.');

  const link = checkDriveLink(input?.url);
  if (!link.ok) return fail(link.problem);
  if (summary.length < MIN_SUMMARY_CHARS) {
    return fail('Write a sentence about what you did. The link alone does not tell your reviewer '
      + 'whether it is worth opening.');
  }

  // TODAY COMES FROM POSTGRES, not from this process. A serverless region in a different timezone
  // would otherwise refuse a report filed at 11pm as "tomorrow", or accept one for a day that has
  // not started. Null means the read did not happen, and a day-partitioned rule must not be applied
  // on a guess — so the date bounds are skipped and the row still saves.
  const now = await attendanceToday();
  if (now) {
    if (dateIso > now) {
      return fail('That day has not happened yet. A report for a future day would be a promise, not a record.');
    }
    const earliest = shiftDateIso(now, -BACKFILL_DAYS);
    if (dateIso < earliest) {
      return fail('That day is more than ' + BACKFILL_DAYS + ' days ago. Ask HR to record it, so an old '
        + 'entry is a decision somebody made rather than a form somebody found.');
    }
  }

  try {
    await ensureDailyReportSchema();

    const existingRows = rows(await db.execute(sql`
      SELECT ${REPORT_COLS} FROM hr_daily_reports
       WHERE employee_id = ${employeeId}::uuid AND report_date = ${dateIso}::date
       LIMIT 1`));
    const existing = existingRows.length ? mapReport(existingRows[0]) : null;

    // =============================================================================================
    // THE SNAPSHOT AND THE OVERWRITE ARE ONE TRANSACTION, AND THE SNAPSHOT READS THE LIVE ROW
    // =============================================================================================
    //
    // It used to be: SELECT the row, INSERT a snapshot built from the values JavaScript had just
    // read, then UPSERT. The counter in the upsert is atomic (`revision_count + 1`), so nobody
    // noticed that the SNAPSHOT was not. Two submits of the same (employee, date) — a double-tapped
    // button on a slow phone, or the author on two devices — both read revision 3 and both wrote a
    // snapshot OF revision 3. The counter went to 5, the trail showed "revision 3" twice, and
    // revision 4's text, the first person's actual edit, existed in no snapshot and no live row.
    // It was not recoverable from anywhere, and both screens said the submit had worked.
    //
    // Two changes, and both are needed:
    //   * the snapshot is now INSERT ... SELECT straight from hr_daily_reports, so it copies what the
    //     row ACTUALLY holds at that instant rather than what was read a round-trip earlier, and
    //   * FOR UPDATE takes the row lock, so the second submitter waits for the first to commit and
    //     then snapshots the first submitter's text under its own revision number.
    // The transaction means a failed snapshot rolls the overwrite back: losing the previous text
    // with no copy of it is worse than a refused submit, and the person can simply press again.
    //
    // HONEST LIMIT: two submits for a date that has NO row yet cannot be serialised this way — there
    // is no row to lock. One inserts revision 0 and the other updates to revision 1 with nothing
    // snapshotted, because at the moment each looked there was genuinely nothing to snapshot. The
    // unique index on (report_id, revision) is what would surface it.
    let written: any[] = [];
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`
        INSERT INTO hr_daily_report_revisions
          (report_id, employee_id, report_date, revision, report_url, work_done, blockers, replaced_by_user_id)
        SELECT r.id, r.employee_id, r.report_date, COALESCE(r.revision_count, 0),
               r.report_url, r.work_done, r.blockers, ${userId}::uuid
          FROM hr_daily_reports r
         WHERE r.employee_id = ${employeeId}::uuid AND r.report_date = ${dateIso}::date
         FOR UPDATE`);

      written = rows(await tx.execute(sql`
        INSERT INTO hr_daily_reports
          (employee_id, report_date, work_done, blockers, report_url, sharing_ack,
           revision_count, submitted_by_user_id, updated_at)
        VALUES
          (${employeeId}::uuid, ${dateIso}::date, ${summary}, ${blockers}, ${link.url}, ${sharingAck},
           0, ${userId}::uuid, NOW())
        ON CONFLICT (employee_id, report_date) DO UPDATE
          SET work_done            = EXCLUDED.work_done,
              blockers             = EXCLUDED.blockers,
              report_url           = EXCLUDED.report_url,
              sharing_ack          = EXCLUDED.sharing_ack,
              revision_count       = hr_daily_reports.revision_count + 1,
              last_revised_at      = NOW(),
              submitted_by_user_id = EXCLUDED.submitted_by_user_id,
              updated_at           = NOW()
        RETURNING id, revision_count`));
    });

    const reportId = written.length && written[0]?.id ? String(written[0].id) : (existing?.id || null);
    // The revision number REPORTED is the one the database landed on, not one derived from a read
    // taken before the write. Those two disagreed under exactly the concurrency above, so both
    // authors were told they had filed revision 4.
    const nextRevision = written.length && written[0]?.revision_count != null
      ? Number(written[0].revision_count) || 0
      : (existing ? existing.revision + 1 : 0);

    // ---------------------------------------------------------------------------------------------
    // AFTER THE COMMIT. Neither of these may take the submit down — the report IS filed by now, and
    // telling the person it failed would make them file it twice.
    // ---------------------------------------------------------------------------------------------
    try {
      await logAudit({
        userId,
        action: existing ? 'daily_report.revise' : 'daily_report.submit',
        entity: 'hr_daily_reports',
        entityId: reportId || undefined,
        // The date, the revision and whether the link changed. Not the report text: an audit row is
        // read by people who have no business reading somebody's day in full.
        diff: {
          reportDate: dateIso,
          revision: nextRevision,
          linkChanged: !!existing && existing.url !== link.url,
          sharingAcknowledged: sharingAck,
        },
      });
    } catch (e: any) {
      logFail('submitReport.audit', e);
    }

    try {
      await notifyReviewer(employeeId, dateIso, !!existing);
    } catch (e: any) {
      logFail('submitReport.notify', e);
    }

    return { ok: true, error: '', created: !existing, revision: nextRevision, reportId, url: link.url };
  } catch (e: any) {
    logFail('submitReport', e);
    return {
      ...fail(errText(e, 'The report could not be saved. Nothing was changed.')),
      url: link.url,
    };
  }
}

/**
 * Tell the reviewer a report arrived. ONE notifier, src/lib/push.ts, and only ever to the person the
 * graph names. Silent when the graph is empty — there is nobody to tell, and picking somebody would
 * be the guess this whole module refuses to make.
 */
async function notifyReviewer(employeeId: string, dateIso: string, wasRevision: boolean): Promise<void> {
  const resolved = await reviewerFor(employeeId);
  const to = resolved.person?.userId;
  if (!to) return;

  let name = 'An intern';
  try {
    const r = rows(await db.execute(sql`
      SELECT full_name FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (r.length && r[0]?.full_name) name = String(r[0].full_name);
  } catch (e: any) {
    logFail('notifyReviewer.name', e);
  }

  await sendPushToUser(to, {
    type: 'daily_report_filed',
    title: wasRevision ? 'Daily report revised' : 'Daily report filed',
    body: name + ' — ' + dateIso + (wasRevision ? ' (revised)' : ''),
    url: '/portal/employee/reports/team?d=' + dateIso,
    tag: 'daily-report-' + employeeId + '-' + dateIso,
  });
}

export interface ReviewResult { ok: boolean; error: string }

/**
 * Mark a report read, with an optional comment.
 *
 * THE RIGHT TO DO THIS IS RE-CHECKED HERE, from the graph, against the report's OWN employee_id read
 * out of the row — not against anything the form posted. A rendered list is not an authorisation.
 *
 * There is no verdict, no rating and no rejection: a daily report is not approved. If it needs a
 * decision, that is a conversation, and src/lib/workflow.ts exists for the things that genuinely
 * route for approval. Nothing here penalises a person, and there is no column that could.
 */
export async function markReviewed(input: {
  reportId: string;
  reviewerUserId: string;
  comment?: string | null;
}): Promise<ReviewResult> {
  const reportId = String(input?.reportId || '');
  const reviewerUserId = String(input?.reviewerUserId || '');
  const comment = String(input?.comment || '').trim() || null;

  if (!isUuid(reportId)) return { ok: false, error: 'That is not a report we can find.' };
  if (!isUuid(reviewerUserId)) return { ok: false, error: 'Sign in again — we could not tell who you are.' };

  try {
    await ensureDailyReportSchema();
    const found = rows(await db.execute(sql`
      SELECT id, employee_id::text AS employee_id, report_date, revision_count
        FROM hr_daily_reports WHERE id = ${reportId}::uuid LIMIT 1`));
    if (!found.length) return { ok: false, error: 'That report no longer exists.' };

    const subjectId = String(found[0].employee_id);
    const allowed = await mayReview(reviewerUserId, subjectId);
    if (!allowed) {
      return {
        ok: false,
        error: 'The Organization Graph does not record you as this person\'s reporting manager, mentor '
          + 'or reviewer, so this is not yours to mark.',
      };
    }

    const reviewerEmployeeId = await employeeIdForUser(reviewerUserId);
    const revision = Number(found[0].revision_count) || 0;

    await db.execute(sql`
      UPDATE hr_daily_reports
         SET reviewed_at             = NOW(),
             reviewed_by_user_id     = ${reviewerUserId}::uuid,
             reviewed_by_employee_id = ${reviewerEmployeeId}::uuid,
             review_comment          = ${comment},
             reviewed_revision       = ${revision},
             updated_at              = NOW()
       WHERE id = ${reportId}::uuid`);

    try {
      await logAudit({
        userId: reviewerUserId,
        action: 'daily_report.review',
        entity: 'hr_daily_reports',
        entityId: reportId,
        diff: { reportDate: iso(found[0].report_date), revisionReviewed: revision, commented: !!comment },
      });
    } catch (e: any) {
      logFail('markReviewed.audit', e);
    }

    try {
      const emp = rows(await db.execute(sql`
        SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${subjectId}::uuid LIMIT 1`));
      const to = emp.length && emp[0]?.user_id ? String(emp[0].user_id) : null;
      if (to) {
        await sendPushToUser(to, {
          type: 'daily_report_reviewed',
          title: 'Your daily report was read',
          body: iso(found[0].report_date) + (comment ? ' — with a comment' : ''),
          url: '/portal/employee/reports?d=' + iso(found[0].report_date),
          tag: 'daily-report-reviewed-' + reportId,
        });
      }
    } catch (e: any) {
      logFail('markReviewed.notify', e);
    }

    return { ok: true, error: '' };
  } catch (e: any) {
    logFail('markReviewed', e);
    return { ok: false, error: errText(e, 'That could not be saved. Nothing was changed.') };
  }
}

// -------------------------------------------------------------------------------------------------
// THE WEEK, WITH THE REPORT SITTING BESIDE THE DAY IT COVERS
// -------------------------------------------------------------------------------------------------

export interface DayRow {
  dateIso: string;
  weekday: string;
  isToday: boolean;
  isFuture: boolean;
  attendance: AttendanceFact;
  report: DailyReport | null;
  /** The clock says this day was worked and no report exists. ADVISORY. Nothing acts on it. */
  outstanding: boolean;
  /** One sentence naming the state of this day, for a person to read. */
  sentence: string;
}

export interface WeekView {
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  days: DayRow[];
  /** Net worked minutes across COMPLETE days only. Incomplete days are counted separately. */
  workedMinutes: number;
  completeDays: number;
  incompleteDays: number;
  reportsFiled: number;
  outstandingDays: number;
}

function sentenceFor(fact: AttendanceFact, report: DailyReport | null, isFuture: boolean): string {
  if (isFuture) return 'Not yet.';
  if (report && fact.wasWorked) return 'Report filed.';
  if (report) return 'Report filed for a day with no worked attendance recorded.';
  if (fact.state === 'incomplete') return 'Checked in, never checked out, and no report filed.';
  if (fact.state === 'worked') return 'Worked, and no report filed.';
  return dayStateSentence(fact.state);
}

/**
 * One person's week: every day, what the clock recorded, and the report that covers it.
 *
 * TWO QUERIES for the whole week, not one per day — a phone on a slow connection at the end of a
 * working day is the device this is opened on.
 */
export async function weekView(employeeId: string, anyDayInWeek: string): Promise<WeekView | null> {
  if (!isUuid(employeeId)) return null;
  const start = weekStartIso(isDateIso(anyDayInWeek) ? anyDayInWeek : '');
  if (!isDateIso(start)) return null;
  const end = shiftDateIso(start, 6);

  const [facts, reports, now] = await Promise.all([
    attendanceFacts([employeeId], start, end),
    reportsFor([employeeId], start, end),
    attendanceToday(),
  ]);

  const factDays = facts.get(employeeId) || new Map<string, AttendanceFact>();
  const reportDays = reports.get(employeeId) || new Map<string, DailyReport>();

  const days: DayRow[] = [];
  let workedMinutes = 0;
  let completeDays = 0;
  let incompleteDays = 0;
  let reportsFiled = 0;
  let outstandingDays = 0;

  for (const dateIso of dateRange(start, end)) {
    const attendance = factDays.get(dateIso) || factFromRow(dateIso, null);
    const report = reportDays.get(dateIso) || null;
    const isFuture = !!now && dateIso > now;
    const outstanding = !isFuture && attendance.wasWorked && !report;

    if (attendance.state === 'worked') {
      completeDays++;
      workedMinutes += attendance.workedMinutes || 0;
    }
    if (attendance.state === 'incomplete') incompleteDays++;
    if (report) reportsFiled++;
    if (outstanding) outstandingDays++;

    days.push({
      dateIso,
      weekday: attendance.weekday,
      isToday: !!now && now === dateIso,
      isFuture,
      attendance,
      report,
      outstanding,
      sentence: sentenceFor(attendance, report, isFuture),
    });
  }

  return { employeeId, weekStart: start, weekEnd: end, days, workedMinutes, completeDays, incompleteDays, reportsFiled, outstandingDays };
}

export interface PersonWeek {
  person: RosterEntry;
  week: WeekView | null;
}

/**
 * A reviewer's week across their roster.
 *
 * THREE QUERIES TOTAL regardless of team size: attendance for everybody, reports for everybody, and
 * the date once. weekView() per person would be three per head, which on a team of twelve is
 * thirty-six round trips on a pooled connection — the shape that has taken this site down before.
 */
export async function teamWeek(people: RosterEntry[], anyDayInWeek: string): Promise<{
  weekStart: string; weekEnd: string; rows: PersonWeek[];
}> {
  const start = weekStartIso(isDateIso(anyDayInWeek) ? anyDayInWeek : '');
  const end = isDateIso(start) ? shiftDateIso(start, 6) : '';
  const list = (people || []).filter((p) => isUuid(p?.employeeId));
  if (!isDateIso(start) || !isDateIso(end) || !list.length) {
    return { weekStart: start || '', weekEnd: end || '', rows: list.map((p) => ({ person: p, week: null })) };
  }

  const ids = list.map((p) => String(p.employeeId));
  const [facts, reports, now] = await Promise.all([
    attendanceFacts(ids, start, end),
    reportsFor(ids, start, end),
    attendanceToday(),
  ]);
  const dates = dateRange(start, end);

  const out: PersonWeek[] = list.map((person) => {
    const id = String(person.employeeId);
    const factDays = facts.get(id) || new Map<string, AttendanceFact>();
    const reportDays = reports.get(id) || new Map<string, DailyReport>();
    const days: DayRow[] = [];
    let workedMinutes = 0;
    let completeDays = 0;
    let incompleteDays = 0;
    let reportsFiled = 0;
    let outstandingDays = 0;

    for (const dateIso of dates) {
      const attendance = factDays.get(dateIso) || factFromRow(dateIso, null);
      const report = reportDays.get(dateIso) || null;
      const isFuture = !!now && dateIso > now;
      const outstanding = !isFuture && attendance.wasWorked && !report;
      if (attendance.state === 'worked') { completeDays++; workedMinutes += attendance.workedMinutes || 0; }
      if (attendance.state === 'incomplete') incompleteDays++;
      if (report) reportsFiled++;
      if (outstanding) outstandingDays++;
      days.push({
        dateIso, weekday: attendance.weekday, isToday: !!now && now === dateIso, isFuture,
        attendance, report, outstanding, sentence: sentenceFor(attendance, report, isFuture),
      });
    }

    return {
      person,
      week: { employeeId: id, weekStart: start, weekEnd: end, days, workedMinutes, completeDays, incompleteDays, reportsFiled, outstandingDays },
    };
  });

  return { weekStart: start, weekEnd: end, rows: out };
}

// -------------------------------------------------------------------------------------------------
// SAYING WHAT A NUMBER COVERS
// -------------------------------------------------------------------------------------------------

/**
 * The sentence that must travel with the worked-minutes figure on any screen that prints it.
 *
 * A bare "40 hours" is the thing the founder objected to: it came from an offer letter's free-text
 * hoursCommitment and measured nothing anybody did. A COMPUTED figure with no stated period and no
 * stated exclusions is the same failure with better credibility, so the number never appears alone.
 *
 * THIS MODULE DELIBERATELY DOES NOT COMPARE HOURS AGAINST A COMMITMENT. Engagement terms, the
 * offer's commitment string and the whole worked-versus-agreed comparison live in their own module
 * (src/lib/intern-hours.ts); a second implementation here would be a second answer to one question.
 * What a daily report needs, and all it takes from attendance, is whether THIS DAY was worked.
 */
export function workedBasis(week: { weekStart: string; weekEnd: string; completeDays: number; incompleteDays: number }): string {
  const d = week.completeDays;
  return 'Measured from check-in and check-out between ' + week.weekStart + ' and ' + week.weekEnd
    + ', net of breaks, across ' + d + ' complete ' + (d === 1 ? 'day' : 'days')
    + (week.incompleteDays
      ? '. ' + week.incompleteDays + ' ' + (week.incompleteDays === 1 ? 'day has' : 'days have')
        + ' a check-in and no check-out, so that time is not known and is not counted here.'
      : '.');
}
