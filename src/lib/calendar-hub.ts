// src/lib/calendar-hub.ts — ONE WORKFORCE CALENDAR, SEVERAL SOURCES.
//
// =================================================================================================
// WHY THIS FILE IS NOT src/lib/calendar.ts
// =================================================================================================
//
// src/lib/calendar.ts already exists and is the LEARNER study calendar: edu_deadlines, per-student
// course deadlines, an ICS feed signed with a per-user token. It is a different calendar for a
// different population and it is not extended into a staff roster, because a module that answers
// both "when is Ravi's assignment due" and "who is on the late shift on Thursday" ends up answering
// neither cleanly.
//
// THIS FILE OWNS NO EVENTS. It has no table of its own and creates none. Every row it renders is
// read from the system that already owns that fact:
//
//   Attendance and hours   hr_attendance          (db/hr-schema.sql, written by punches and by HR)
//   Leave                  hr_leave_request       (src/lib/hr-leave.ts)
//   Working pattern        hr_roster_assignments  (src/lib/attendance.ts)
//   Holidays               hr_holidays            (src/lib/attendance.ts)
//   Tasks                  employee_tasks         (src/lib/employee-tasks.ts)
//   Meetings               meet_rooms             (the Meet module)
//   Training               live_classes           (+ live_class_enrollments)
//
// A calendar that copied those rows into a table of its own would be a second source of truth, and
// the day the two disagreed the calendar would be the one people believed.
//
// =================================================================================================
// AUTHORIZATION IS PART OF EVERY QUERY. NOTHING IS FETCHED AND THEN HIDDEN.
// =================================================================================================
//
//   personal    scoped to the viewer's own employee id, in the WHERE clause.
//   team        the viewer's DIRECT REPORTS, resolved from the Organization Graph
//               (src/lib/org-graph.ts getDirectReports). Not from users.role, not from
//               hr_employees.reporting_manager_id, and never from a role called 'department_head'.
//   department  the departments the graph records this person as HEADING, or every department for a
//               holder of `employee.manage`. Resolved by resolveOrgViewerScope(), the same function
//               /portal/organization scopes itself with — one answer, two surfaces.
//   meeting     meetings this person hosts.
//   holiday     organization-wide holidays plus their own department's.
//   training    sessions they are enrolled on or hosting.
//
// WHAT A TEAM OR DEPARTMENT VIEW SHOWS ABOUT ANOTHER PERSON is deliberately thin: a name, that they
// are away, and the leave type. No reason, no medical detail, no attendance minute-by-minute for
// somebody else. A manager needs to know who is in on Thursday; nothing here needs to know why.
//
// AND THE GRAPH IS EMPTY UNTIL THE FOUNDER RUNS db/org-graph-backfill.sql. The team and department
// views therefore render an HONEST EMPTY STATE naming exactly that, and never fall back to a role
// name to produce a plausible-looking team. A calendar drawn from role names would look exactly like
// a calendar drawn from data.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS; `r.rows[0]` is a bug.
//   - The real Postgres reason is on e.cause.
//   - department ids compared ::text, never ::uuid.
//   - EVERY SOURCE IS INDEPENDENTLY WRAPPED. One source failing degrades to "this part could not be
//     read" beside the rest of the calendar, rather than blanking the page — and it says so, because
//     a calendar that silently drops your leave is worse than one that admits it could not load it.

import { db } from './db';
import { sql } from 'drizzle-orm';
import {
  listHolidays,
  rosterFor,
  isoWeekday,
  weekdayName,
  dateRange,
  shiftDateIso,
  minuteToHm,
  today as attendanceToday,
  type Holiday,
  type Shift,
} from './attendance';
import { getDirectReports, employeeIdForUser } from './org-graph';
// The ONE owner of the meet_* DDL. Awaited before the meeting source reads a column that only
// exists because that module adds it; this file creates no table of its own.
import { ensureMeetSchema } from './meet-schema';
import { resolveOrgViewerScope, type OrgViewerScope } from './org-chart';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above every function that reads them.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[calendar-hub] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

/** Rows any one source will return. A calendar month for a department is well inside this. */
const SOURCE_LIMIT = 300;

/** How many people a team or department view will read events for in one pass. */
const PEOPLE_LIMIT = 60;

/** The longest window this module will build. A mistyped range must not become a year-long scan. */
const MAX_WINDOW_DAYS = 62;

export const CALENDAR_VIEWS = [
  {
    key: 'personal',
    label: 'Mine',
    blurb: 'Your own hours, leave, shifts, tasks and holidays.',
  },
  {
    key: 'team',
    label: 'Team',
    blurb: 'The people who report to you, and when they are away.',
  },
  {
    key: 'department',
    label: 'Department',
    blurb: 'The departments the organization graph records you as heading.',
  },
  {
    key: 'meeting',
    label: 'Meetings',
    blurb: 'Meetings you are hosting.',
  },
  {
    key: 'holiday',
    label: 'Holidays',
    blurb: 'Company holidays, and any your department keeps of its own.',
  },
  {
    key: 'training',
    label: 'Training',
    blurb: 'Live sessions you are enrolled on or running.',
  },
] as const;

export type CalendarViewKey = (typeof CALENDAR_VIEWS)[number]['key'];

const VIEW_KEYS = new Set<string>(CALENDAR_VIEWS.map((v) => v.key));

/** Parse a query-string view, falling back to 'personal'. Never throws on rubbish. */
export function parseCalendarView(raw: unknown): CalendarViewKey {
  const v = String(raw || '').trim();
  return (VIEW_KEYS.has(v) ? v : 'personal') as CalendarViewKey;
}

/** Which system a row came from. Rendered as a small label so nothing is unattributed. */
export type CalendarSourceKey =
  | 'attendance'
  | 'leave'
  | 'roster'
  | 'holiday'
  | 'task'
  | 'meeting'
  | 'training';

export const SOURCE_LABELS: Record<CalendarSourceKey, string> = {
  attendance: 'Hours',
  leave: 'Leave',
  roster: 'Shift',
  holiday: 'Holiday',
  task: 'Task',
  meeting: 'Meeting',
  training: 'Training',
};

export interface CalendarEvent {
  /** Unique within a build, so a renderer can key on it. */
  id: string;
  source: CalendarSourceKey;
  dateIso: string;
  title: string;
  /** A second line, or null. Never a reason for leave and never a health detail. */
  detail: string | null;
  /** 'HH:MM' when the event has a time of day, null when it is a whole day. */
  timeLabel: string | null;
  /** Whose event this is, on a team or department view. Null on personal views. */
  personName: string | null;
  /** Where to go to act on it, or null when there is nowhere to go. */
  href: string | null;
}

export interface CalendarSourceResult {
  key: CalendarSourceKey;
  label: string;
  events: CalendarEvent[];
  /** False when the source could not be read. The UI says so beside the rest of the calendar. */
  available: boolean;
  /** A sentence about this source: why it is empty, or what could not be read. */
  note: string | null;
}

export interface CalendarDay {
  dateIso: string;
  weekday: string;
  /** ISO weekday, 1 = Monday. */
  dayNumber: number;
  isToday: boolean;
  isWeekend: boolean;
  events: CalendarEvent[];
}

export interface CalendarModel {
  view: CalendarViewKey;
  label: string;
  blurb: string;
  from: string;
  to: string;
  days: CalendarDay[];
  sources: CalendarSourceResult[];
  eventCount: number;
  /** One sentence about what this person is looking at and why. Rendered verbatim. */
  explanation: string;
  /** A calm sentence about a limit of THIS result, or null. */
  notice: string | null;
  emptyTitle: string;
  emptyBody: string;
  /** True when a source could not be read. The page must not print a confident "nothing on" then. */
  degraded: boolean;
}

/**
 * Everything a calendar build is allowed to know about the reader.
 *
 * `holds` is the composition's wildcard-aware capability test (ctx.holds), passed in rather than
 * re-resolved, so the calendar, the nav and the widgets on the same request were all decided from
 * ONE composition and cannot disagree.
 */
export interface CalendarViewer {
  userId: string;
  employeeId: string | null;
  departmentId: string | null;
  holds: (key: string) => boolean;
}

// -------------------------------------------------------------------------------------------------
// WINDOW
// -------------------------------------------------------------------------------------------------

/** The month containing a date, as a from/to pair. Falls back to the month containing today. */
export function monthWindow(anchor: string): { from: string; to: string } {
  const base = isDateIso(anchor) ? anchor : new Date().toISOString().slice(0, 10);
  const from = base.slice(0, 8) + '01';
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  const to = shiftDateIso(d.toISOString().slice(0, 10), -1);
  return { from, to };
}

/** The previous / next month anchor, for the two arrows on screen. */
export function shiftMonth(anchor: string, months: number): string {
  const base = isDateIso(anchor) ? anchor : new Date().toISOString().slice(0, 10);
  const d = new Date(base.slice(0, 8) + '01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + Math.round(Number(months) || 0));
  return d.toISOString().slice(0, 10);
}

/** 'August 2026' from a date. Fixed locale so the label does not change with the server's. */
export function monthLabel(anchor: string): string {
  const base = isDateIso(anchor) ? anchor : new Date().toISOString().slice(0, 10);
  const d = new Date(base.slice(0, 8) + '01T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// -------------------------------------------------------------------------------------------------
// SMALL SHARED HELPERS
// -------------------------------------------------------------------------------------------------

function timeOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function empty(key: CalendarSourceKey, note: string | null = null): CalendarSourceResult {
  return { key, label: SOURCE_LABELS[key], events: [], available: true, note };
}

function unavailable(key: CalendarSourceKey, note: string): CalendarSourceResult {
  return { key, label: SOURCE_LABELS[key], events: [], available: false, note };
}

function filled(key: CalendarSourceKey, events: CalendarEvent[], note: string | null = null): CalendarSourceResult {
  return { key, label: SOURCE_LABELS[key], events, available: true, note };
}

// -------------------------------------------------------------------------------------------------
// SOURCES. Each reads ONE system, each fails on its own, and none of them decides access — the
// employee-id list they are given was already narrowed by the scope resolution above them.
// -------------------------------------------------------------------------------------------------

/** Recorded days from hr_attendance, for one person only. */
async function attendanceSource(
  employeeId: string,
  from: string,
  to: string,
): Promise<CalendarSourceResult> {
  try {
    const r = await db.execute(sql`
      SELECT a.date, a.status, a.work_hours, a.clock_in, a.clock_out, a.work_mode
        FROM hr_attendance a
       WHERE a.employee_id = ${employeeId}::uuid
         AND a.date >= ${from}::date AND a.date <= ${to}::date
       ORDER BY a.date ASC
       LIMIT ${SOURCE_LIMIT}`);
    const events = rows(r).map((row: any, i: number) => {
      const dateIso = String(row?.date || '').slice(0, 10);
      const hours = Number(row?.work_hours) || 0;
      const status = String(row?.status || 'present');
      return {
        id: 'att-' + dateIso + '-' + i,
        source: 'attendance' as const,
        dateIso,
        title: hours > 0 ? hours + ' hours recorded' : statusWord(status),
        detail: hours > 0 ? statusWord(status) : null,
        timeLabel: timeOf(row?.clock_in ? new Date(row.clock_in).toISOString() : null),
        personName: null,
        href: '/portal/employee/attendance',
      };
    });
    return filled(
      'attendance',
      events,
      events.length ? null : 'No hours are recorded in this period.',
    );
  } catch (e: any) {
    logFail('attendanceSource', e);
    return unavailable('attendance', 'Your recorded hours could not be read just now.');
  }
}

function statusWord(status: string): string {
  if (status === 'wfh') return 'Working from home';
  if (status === 'on_leave') return 'On leave';
  if (status === 'absent') return 'Absent';
  if (status === 'holiday') return 'Holiday';
  return 'Present';
}

/**
 * Leave rows for a set of employees.
 *
 * `withNames` is what separates the personal view from the team view: on your own calendar there is
 * no point repeating your name on every row, and on a team calendar the name IS the information.
 * The reason field is never selected on either.
 */
async function leaveSource(
  employeeIds: string[],
  from: string,
  to: string,
  withNames: boolean,
): Promise<CalendarSourceResult> {
  const ids = employeeIds.filter(isUuid).slice(0, PEOPLE_LIMIT);
  if (!ids.length) return empty('leave', null);
  try {
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const r = await db.execute(sql`
      SELECT l.id, l.employee_id, l.leave_type, l.status, l.start_date, l.end_date,
             e.full_name AS employee_name
        FROM hr_leave_request l
        LEFT JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.employee_id IN (${idList})
         AND l.status IN ('pending', 'approved')
         AND l.start_date <= ${to}::date
         AND l.end_date >= ${from}::date
       ORDER BY l.start_date ASC
       LIMIT ${SOURCE_LIMIT}`);

    const events: CalendarEvent[] = [];
    for (const row of rows(r)) {
      const start = String(row?.start_date || '').slice(0, 10);
      const end = String(row?.end_date || '').slice(0, 10);
      const type = String(row?.leave_type || 'leave');
      const status = String(row?.status || '');
      const name = row?.employee_name ? String(row.employee_name) : null;
      // A leave request spans days; it becomes one event per day inside the window so the calendar
      // shows who is away on Thursday rather than only on the day the leave started.
      for (const dateIso of dateRange(start > from ? start : from, end < to ? end : to, 62)) {
        events.push({
          id: 'lv-' + String(row?.id || '') + '-' + dateIso,
          source: 'leave',
          dateIso,
          title: (withNames && name ? name + ' - ' : '') + leaveWord(type),
          detail: status === 'pending' ? 'Requested, not yet decided' : 'Approved',
          timeLabel: null,
          personName: withNames ? name : null,
          href: withNames ? null : '/portal/employee/leave',
        });
      }
    }
    return filled('leave', events, events.length ? null : 'No leave falls in this period.');
  } catch (e: any) {
    logFail('leaveSource', e);
    return unavailable('leave', 'Leave could not be read just now.');
  }
}

function leaveWord(type: string): string {
  const t = String(type || '').replace(/_/g, ' ').trim();
  if (!t) return 'Leave';
  return t.charAt(0).toUpperCase() + t.slice(1) + ' leave';
}

/**
 * The working pattern, expanded from the roster.
 *
 * NOT A QUERY PER DAY. The employee's whole roster history is read once and the shift in force is
 * resolved in memory for each date, exactly as the timesheet does — the roster can change mid-month
 * and every day has to be scored against the row that was actually in force on it.
 */
async function rosterSource(
  employeeId: string,
  from: string,
  to: string,
  holidays: Holiday[],
): Promise<CalendarSourceResult> {
  try {
    const assignments = await rosterFor(employeeId);
    if (!assignments.length) {
      return empty(
        'roster',
        'No shift is rostered for you yet, so this calendar cannot say which days you are expected to work.',
      );
    }
    const holidayDates = new Set(holidays.filter((h) => !h.isOptional).map((h) => h.dateIso));
    const shiftFor = (dateIso: string): Shift | null => {
      for (const a of assignments) {
        if (a.effectiveFrom && a.effectiveFrom <= dateIso && (!a.effectiveTo || a.effectiveTo >= dateIso)) {
          return a.shift;
        }
      }
      return null;
    };

    const events: CalendarEvent[] = [];
    for (const dateIso of dateRange(from, to, MAX_WINDOW_DAYS)) {
      if (holidayDates.has(dateIso)) continue;
      const shift = shiftFor(dateIso);
      const wd = isoWeekday(dateIso) || 0;
      if (!shift || !shift.workingDays.includes(wd)) continue;
      events.push({
        id: 'sh-' + dateIso,
        source: 'roster',
        dateIso,
        title: shift.name,
        detail: minuteToHm(shift.startMinute) + ' to ' + minuteToHm(shift.endMinute),
        timeLabel: minuteToHm(shift.startMinute),
        personName: null,
        href: '/portal/employee/attendance',
      });
    }
    return filled('roster', events);
  } catch (e: any) {
    logFail('rosterSource', e);
    return unavailable('roster', 'Your shift pattern could not be read just now.');
  }
}

function holidaySource(holidays: Holiday[]): CalendarSourceResult {
  const events: CalendarEvent[] = holidays.map((h) => ({
    id: 'hol-' + h.id,
    source: 'holiday' as const,
    dateIso: h.dateIso,
    title: h.name,
    detail:
      (h.departmentName ? h.departmentName + ' only' : 'Whole organization') +
      (h.isOptional ? ', optional' : ''),
    timeLabel: null,
    personName: null,
    href: null,
  }));
  return filled(
    'holiday',
    events,
    events.length ? null : 'No holidays are recorded in this period.',
  );
}

/** Tasks due, for one person. Completed tasks are not calendar entries — they are history. */
async function taskSource(employeeId: string, from: string, to: string): Promise<CalendarSourceResult> {
  try {
    const r = await db.execute(sql`
      SELECT t.id, t.title, t.due_on, t.priority, t.status
        FROM employee_tasks t
       WHERE t.employee_id = ${employeeId}::uuid
         AND t.due_on IS NOT NULL
         AND t.due_on >= ${from}::date AND t.due_on <= ${to}::date
         AND t.status <> 'done'
       ORDER BY t.due_on ASC
       LIMIT ${SOURCE_LIMIT}`);
    const events = rows(r).map((row: any) => ({
      id: 'tk-' + String(row?.id || ''),
      source: 'task' as const,
      dateIso: String(row?.due_on || '').slice(0, 10),
      title: String(row?.title || 'Task'),
      detail: row?.priority && String(row.priority) !== 'normal' ? String(row.priority) + ' priority' : null,
      timeLabel: null,
      personName: null,
      href: '/portal/tasks',
    }));
    return filled('task', events, events.length ? null : 'Nothing is due in this period.');
  } catch (e: any) {
    logFail('taskSource', e);
    return unavailable('task', 'Your tasks could not be read just now.');
  }
}

/**
 * Meetings this person hosts OR was invited to.
 *
 * STILL COMPARED ::text, and that has not changed: meet_rooms may carry the legacy id TEXT /
 * host_user_id INTEGER shape on a database that met /portal/meet before /portal/meet/[id], and a
 * ::uuid cast against it would throw and take the whole calendar down with it.
 *
 * WHAT DID CHANGE: INVITEES ARE READ NOW. This function used to say "the `invitees` JSONB column
 * exists in only one of the two declarations, so a query touching it fails outright on the other",
 * and that was true while two pages each CREATEd this table with a different shape. One module owns
 * that DDL now — src/lib/meet-schema.ts — and it adds every column either surface needs with ALTER
 * TABLE ... ADD COLUMN IF NOT EXISTS. ensureMeetSchema() is awaited below precisely so this query
 * cannot run before the column it names exists.
 *
 * The invitee match is on the stored email, the same test the scheduler itself uses. It is a text
 * containment test rather than a join, because invitations are stored as a JSONB array of addresses
 * and not as rows — a real invitee table is still the better artefact, and is still not this
 * build's to invent.
 */
async function meetingSource(userId: string, from: string, to: string): Promise<CalendarSourceResult> {
  try {
    await ensureMeetSchema();
    const emailRow = rows(await db.execute(sql`SELECT email FROM users WHERE id::text = ${userId} LIMIT 1`))[0] as any;
    const email = String(emailRow?.email || '');
    // An empty address must never become a wildcard: '%%' matches every row. When there is no
    // address on file the invitee arm is switched off rather than opened up.
    const inviteeNeedle = email ? '%' + email + '%' : null;
    const r = await db.execute(sql`
      SELECT m.id::text AS id, m.title, m.scheduled_at, m.status,
             (m.host_user_id::text = ${userId}::text) AS is_host
        FROM meet_rooms m
       WHERE (m.host_user_id::text = ${userId}::text
              OR (${inviteeNeedle}::text IS NOT NULL AND m.invitees::text ILIKE ${inviteeNeedle}))
         AND m.scheduled_at IS NOT NULL
         AND m.scheduled_at >= ${from}::date
         AND m.scheduled_at < (${to}::date + INTERVAL '1 day')
       ORDER BY m.scheduled_at ASC
       LIMIT ${SOURCE_LIMIT}`);
    const events = rows(r).map((row: any) => {
      const at = row?.scheduled_at ? new Date(row.scheduled_at).toISOString() : '';
      return {
        id: 'mt-' + String(row?.id || ''),
        source: 'meeting' as const,
        dateIso: at.slice(0, 10),
        title: String(row?.title || 'Meeting'),
        detail: row?.status ? String(row.status) : (row?.is_host ? 'hosting' : 'invited'),
        timeLabel: timeOf(at),
        personName: null,
        href: '/portal/meet',
      };
    });
    return filled(
      'meeting',
      events,
      events.length
        ? null
        : 'No meetings you host or were invited to are scheduled in this period.',
    );
  } catch (e: any) {
    logFail('meetingSource', e);
    return unavailable(
      'meeting',
      'Meetings could not be read just now. This source degrades rather than taking the calendar with it; nothing in your diary has been changed.',
    );
  }
}

/** Live training sessions this person is enrolled on or hosting. */
async function trainingSource(userId: string, from: string, to: string): Promise<CalendarSourceResult> {
  try {
    const r = await db.execute(sql`
      SELECT c.id::text AS id, c.title, c.subject, c.scheduled_at, c.status,
             (c.host_user_id::text = ${userId}::text) AS is_host
        FROM live_classes c
       WHERE c.scheduled_at IS NOT NULL
         AND c.scheduled_at >= ${from}::date
         AND c.scheduled_at < (${to}::date + INTERVAL '1 day')
         AND (
           c.host_user_id::text = ${userId}::text
           OR EXISTS (
             SELECT 1 FROM live_class_enrollments en
              WHERE en.class_id::text = c.id::text
                AND en.user_id::text = ${userId}::text)
         )
       ORDER BY c.scheduled_at ASC
       LIMIT ${SOURCE_LIMIT}`);
    const events = rows(r).map((row: any) => {
      const at = row?.scheduled_at ? new Date(row.scheduled_at).toISOString() : '';
      return {
        id: 'tr-' + String(row?.id || ''),
        source: 'training' as const,
        dateIso: at.slice(0, 10),
        title: String(row?.title || 'Training session'),
        detail:
          (row?.is_host ? 'You are running this' : 'You are enrolled') +
          (row?.subject ? ' - ' + String(row.subject) : ''),
        timeLabel: timeOf(at),
        personName: null,
        href: '/portal/liveclass',
      };
    });
    return filled(
      'training',
      events,
      events.length ? null : 'No live sessions you are on fall in this period.',
    );
  } catch (e: any) {
    logFail('trainingSource', e);
    return unavailable('training', 'Training sessions could not be read just now.');
  }
}

// -------------------------------------------------------------------------------------------------
// PEOPLE RESOLUTION — the only place a view decides WHOSE events it may read
// -------------------------------------------------------------------------------------------------

interface PeopleScope {
  employeeIds: string[];
  names: Map<string, string>;
  /** Rendered verbatim. Says who this person is seeing and why. */
  explanation: string;
  /** Set when there is nobody to show and the reason is worth a screen of its own. */
  emptyTitle: string | null;
  emptyBody: string | null;
}

/** Direct reports, from the Organization Graph. No role names, no legacy column. */
async function teamScope(viewer: CalendarViewer, scope: OrgViewerScope): Promise<PeopleScope> {
  if (!scope.initialized) {
    return {
      employeeIds: [],
      names: new Map(),
      explanation: 'The Organization Graph has no relationships recorded yet.',
      emptyTitle: 'Organization Graph not yet initialized',
      emptyBody:
        'A team calendar is drawn from who reports to whom, and no reporting relationships have been recorded yet. Once the founder loads the organization graph, the people who report to you appear here. Nothing is guessed from job titles or account roles in the meantime.',
    };
  }
  if (!viewer.employeeId) {
    return {
      employeeIds: [],
      names: new Map(),
      explanation: 'This account has no employee record.',
      emptyTitle: 'No employee record is linked to this account',
      emptyBody:
        'A team calendar is built from your own place in the organization graph, which is keyed to an employee record. Ask HR to link yours to the address you signed in with.',
    };
  }

  const reports = await getDirectReports(viewer.employeeId);
  const names = new Map<string, string>();
  for (const p of reports) if (p.employeeId) names.set(p.employeeId, p.fullName || 'Unnamed record');

  if (!reports.length) {
    return {
      employeeIds: [],
      names,
      explanation: 'The graph records nobody as reporting to you.',
      emptyTitle: 'Nobody reports to you on the organization graph',
      emptyBody:
        'This is the honest answer, not an error: the graph has relationships in it and none of them make you somebody\'s reporting manager. If that is wrong, it is a relationship to record rather than a setting to change.',
    };
  }

  return {
    employeeIds: reports.map((p) => p.employeeId).filter(isUuid) as string[],
    names,
    explanation:
      'You are seeing the ' + reports.length + ' ' + (reports.length === 1 ? 'person' : 'people') +
      ' the organization graph records as reporting to you.',
    emptyTitle: null,
    emptyBody: null,
  };
}

/** Departments the graph records this person as heading, or every department for employee.manage. */
async function departmentScope(scope: OrgViewerScope): Promise<PeopleScope> {
  if (!scope.initialized && scope.kind !== 'full') {
    return {
      employeeIds: [],
      names: new Map(),
      explanation: 'The Organization Graph has no relationships recorded yet.',
      emptyTitle: 'Organization Graph not yet initialized',
      emptyBody:
        'A department calendar is drawn from who heads which department, and no such relationships have been recorded yet. Being labelled a department head on an account is not the same fact and is deliberately not used here.',
    };
  }
  if (scope.kind !== 'full' && scope.departmentIds.length === 0) {
    return {
      employeeIds: [],
      names: new Map(),
      explanation: 'The graph does not record you as heading a department.',
      emptyTitle: 'You do not head a department on the organization graph',
      emptyBody:
        'This view shows the departments the graph records you as heading. It has relationships in it and none of them name you as a head. Your own calendar is on the Mine tab.',
    };
  }

  try {
    const filter =
      scope.kind === 'full'
        ? sql``
        : sql`AND e.department_id::text IN (${sql.join(
            scope.departmentIds.map((d) => sql`${String(d)}::text`),
            sql`, `,
          )})`;
    const r = await db.execute(sql`
      SELECT e.id, e.full_name
        FROM hr_employees e
       WHERE e.is_active = TRUE ${filter}
       ORDER BY e.full_name ASC
       LIMIT ${PEOPLE_LIMIT}`);
    const list = rows(r);
    const names = new Map<string, string>();
    const ids: string[] = [];
    for (const row of list) {
      const id = String(row?.id || '');
      if (!isUuid(id)) continue;
      ids.push(id);
      names.set(id, row?.full_name ? String(row.full_name) : 'Unnamed record');
    }
    return {
      employeeIds: ids,
      names,
      explanation:
        scope.kind === 'full'
          ? 'You are seeing every active employee, because you hold the capability to administer employee records.'
          : 'You are seeing ' +
            (scope.departmentNames.length ? scope.departmentNames.join(', ') : 'your department') +
            ', because the graph records you as its head.',
      emptyTitle: ids.length ? null : 'No active employees in scope',
      emptyBody: ids.length
        ? null
        : 'There are no active employee records in the departments this view covers.',
    };
  } catch (e: any) {
    logFail('departmentScope', e);
    return {
      employeeIds: [],
      names: new Map(),
      explanation: 'The employee list could not be read.',
      emptyTitle: 'We could not read the department list',
      emptyBody:
        'Something went wrong reading employee records. Nothing is lost. Try again in a moment, and tell HR if it keeps happening.',
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE BUILD
// -------------------------------------------------------------------------------------------------

/**
 * Build one calendar view for one person over one window.
 *
 * The scope is resolved BEFORE any event query runs, and every source is handed the employee ids it
 * may read. There is no branch below that fetches broadly and filters afterwards.
 */
export async function buildCalendar(
  view: CalendarViewKey,
  viewer: CalendarViewer,
  window: { from: string; to: string },
): Promise<CalendarModel> {
  const def = CALENDAR_VIEWS.find((v) => v.key === view) || CALENDAR_VIEWS[0];
  const from = isDateIso(window?.from) ? window.from : new Date().toISOString().slice(0, 10);
  let to = isDateIso(window?.to) ? window.to : shiftDateIso(from, 30);
  if (to < from) to = from;
  // Hard ceiling, so a hand-edited query string cannot ask for a decade.
  const dates = dateRange(from, to, MAX_WINDOW_DAYS);
  const lastDate = dates.length ? dates[dates.length - 1] : from;
  const truncated = lastDate < to;

  const now = await attendanceToday();
  const sources: CalendarSourceResult[] = [];
  let explanation = '';
  let emptyTitle = 'Nothing on';
  let emptyBody = 'There is nothing recorded in this period.';

  if (view === 'personal') {
    if (!viewer.employeeId) {
      explanation = 'This account has no employee record.';
      emptyTitle = 'No employee record is linked to this account';
      emptyBody =
        'Your hours, shift and leave all hang off an employee record. Ask HR to link yours to the address you signed in with, and this calendar fills itself in.';
    } else {
      const holidays = await listHolidays(from, lastDate, viewer.departmentId);
      sources.push(await attendanceSource(viewer.employeeId, from, lastDate));
      sources.push(await leaveSource([viewer.employeeId], from, lastDate, false));
      sources.push(await rosterSource(viewer.employeeId, from, lastDate, holidays));
      sources.push(holidaySource(holidays));
      sources.push(await taskSource(viewer.employeeId, from, lastDate));
      explanation = 'Your own hours, leave, shifts, tasks and holidays.';
      emptyTitle = 'Nothing recorded in this period';
      emptyBody =
        'No hours, leave, shifts or tasks fall in these dates. Checking in on the Attendance screen is what starts filling this.';
    }
  } else if (view === 'team' || view === 'department') {
    const scope = await resolveOrgViewerScope(viewer.userId, viewer.holds);
    const people = view === 'team' ? await teamScope(viewer, scope) : await departmentScope(scope);
    explanation = people.explanation;
    if (people.emptyTitle) {
      emptyTitle = people.emptyTitle;
      emptyBody = people.emptyBody || emptyBody;
    } else {
      const holidays = await listHolidays(from, lastDate, viewer.departmentId);
      sources.push(await leaveSource(people.employeeIds, from, lastDate, true));
      sources.push(holidaySource(holidays));
      emptyTitle = 'Nobody is away in this period';
      emptyBody = 'That is the good version of an empty calendar. No leave falls in these dates.';
    }
  } else if (view === 'meeting') {
    sources.push(await meetingSource(viewer.userId, from, lastDate));
    explanation = 'Meetings you are hosting.';
    emptyTitle = 'No meetings you host in this period';
    emptyBody =
      'Meetings you were invited to are not listed. The meeting store records who hosts a room and does not record invitations in a shape this calendar can read honestly, so it does not pretend to.';
  } else if (view === 'holiday') {
    // Whole-organization holidays plus this person's department. A holder of employee.manage sees
    // every department's, because they administer them.
    const dept = viewer.holds('employee.manage') ? null : viewer.departmentId;
    const holidays = await listHolidays(from, lastDate, dept);
    sources.push(holidaySource(holidays));
    explanation = viewer.holds('employee.manage')
      ? 'Every holiday recorded, for every department.'
      : 'Company holidays, and any your own department keeps.';
    emptyTitle = 'No holidays recorded in this period';
    emptyBody =
      'Holidays are recorded on the Shifts and roster screen. Until somebody records them, attendance cannot tell a holiday from an ordinary day.';
  } else {
    sources.push(await trainingSource(viewer.userId, from, lastDate));
    explanation = 'Live sessions you are enrolled on or running.';
    emptyTitle = 'No training in this period';
    emptyBody = 'Sessions you are enrolled on appear here once they are scheduled.';
  }

  // ---- fold every source into days ------------------------------------------------------------
  const byDate = new Map<string, CalendarEvent[]>();
  for (const d of dates) byDate.set(d, []);
  let eventCount = 0;
  for (const s of sources) {
    for (const ev of s.events) {
      const bucket = byDate.get(ev.dateIso);
      if (!bucket) continue; // outside the window; never rendered under the wrong day
      bucket.push(ev);
      eventCount++;
    }
  }

  const days: CalendarDay[] = dates.map((dateIso) => {
    const wd = isoWeekday(dateIso) || 1;
    return {
      dateIso,
      weekday: weekdayName(dateIso),
      dayNumber: wd,
      isToday: !!now && now === dateIso,
      isWeekend: wd >= 6,
      events: (byDate.get(dateIso) || []).sort((a, b) => {
        const at = a.timeLabel || '';
        const bt = b.timeLabel || '';
        if (at && bt && at !== bt) return at < bt ? -1 : 1;
        if (at && !bt) return -1;
        if (!at && bt) return 1;
        return a.title.localeCompare(b.title);
      }),
    };
  });

  const degraded = sources.some((s) => !s.available);

  return {
    view: def.key,
    label: def.label,
    blurb: def.blurb,
    from,
    to: lastDate,
    days,
    sources,
    eventCount,
    explanation,
    notice: truncated
      ? 'This calendar shows at most ' + MAX_WINDOW_DAYS + ' days at a time, so the range was shortened.'
      : null,
    emptyTitle,
    emptyBody,
    degraded,
  };
}

/**
 * The employee id for a signed-in account, for a caller that has only a user id.
 *
 * Re-exported from the org graph rather than re-queried: the users.id to hr_employees.id crossing is
 * the single most likely way to get a wrong answer in this codebase, and it is crossed in one place.
 */
export { employeeIdForUser };
