// src/lib/performance-learning.ts — THE LEARNING PATH: assigned courses, progress, certificates,
// and the training calendar.
//
// =================================================================================================
// THIS IS NOT A SECOND LMS, AND THE JOIN IS THE WHOLE DESIGN
// =================================================================================================
//
// The course engine already exists and this module reuses it rather than reimplementing any of it:
//
//   training_courses        the catalogue. Authored on /admin/hr/training, read by /portal/courses.
//   training_modules        the structure.
//   training_lessons        the content.
//   training_enrollments    WHAT SOMEBODY DID: enrolled, progress_pct, completed_at.
//   course_certificates     WHAT THEY EARNED — read through src/lib/certificates.ts
//                           getCertificatesForUser(), never with a query of our own.
//
// What none of those can say is WHAT SOMEBODY WAS ASKED TO DO. training_enrollments has exactly one
// writer — the learner opening a course — and no assigned_by, due_at or required column. That gap is
// recorded in three places in this codebase already (workforce/widgets.ts:1433,
// dashboard-config.ts:304, navigation.ts:275) as the reason the Learning nav entry has no widget
// behind it. hr_learning_assignments fills exactly that gap and nothing else.
//
// So a learning path is a LEFT JOIN: the assignment on one side, the learner's real progress on the
// other. An assignment with no enrolment is "not started", and that is a fact rather than a guess.
//
// =================================================================================================
// WHO MAY ASSIGN
// =================================================================================================
//
//   `learning.assign`  anybody in the organization, and the training calendar.
//   a RELATIONSHIP     your own reports, resolved from the Organization Graph.
//   yourself           anybody may take a course; the catalogue at /portal/courses is open to any
//                      signed-in account and narrows itself by access_type. This module does not
//                      gate learning, it gates ASSIGNING it to somebody else.
//
// EduRankAI is the technology platform. Courses here are internal training; accredited partners
// award credentials, and no copy in this module says otherwise.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { getCertificatesForUser } from '@/lib/certificates';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import {
  canSeePerformanceOf,
  clean,
  isUuid,
  LEARNING_ASSIGN,
  logFail,
  rowsOf,
  uuidList,
  type PerfViewer,
} from '@/lib/performance-scope';
// AN OVERDUE FLAG IS A DAY BOUNDARY, AND THIS PROCESS IS NOT IN THE COMPANY'S ZONE.
import { civilToday } from '@/lib/page-safety';

const MOD = 'performance-learning';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

export const TRAINING_MODES = ['online', 'in_person'] as const;
export const TRAINING_MODE_LABELS: Record<string, string> = {
  online: 'Online',
  in_person: 'In person',
};

export interface CourseOption {
  id: string;
  title: string;
  category: string | null;
  level: string | null;
  durationHours: number | null;
}

export interface LearningItem {
  assignmentId: string;
  employeeId: string;
  employeeName: string | null;
  courseId: string;
  courseTitle: string;
  courseSlug: string | null;
  category: string | null;
  level: string | null;
  required: boolean;
  dueOn: string | null;
  reason: string | null;
  assignedByUserId: string | null;
  status: string;
  /** From training_enrollments. Null when the learner has not opened the course yet. */
  progressPct: number | null;
  completedAt: string | null;
  /** Derived, so a screen never has to work it out twice. */
  state: 'not_started' | 'in_progress' | 'complete';
  overdue: boolean;
  createdAt: string | null;
}

export interface CertificateRow {
  id: string;
  courseId: string | null;
  courseTitle: string;
  certNumber: string;
  issuedAt: string | null;
  grade: string | null;
  verificationUrl: string | null;
}

export interface TrainingEvent {
  id: string;
  title: string;
  description: string | null;
  courseId: string | null;
  courseTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  mode: string;
  capacity: number | null;
  status: string;
  signups: number;
  /** Has the person this list was read for already signed up? */
  iAmGoing: boolean;
}

export interface LearningWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// -------------------------------------------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------------------------------------------

function isoDay(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Today as the COMPANY counts it, for the overdue comparison.
 *
 * This was `new Date().toISOString().slice(0,10)` — the date in UTC, described in its own comment
 * as "as the SERVER counts it", which is the bug stated out loud. The process runs in UTC and the
 * people whose training is being chased work in IST (UTC+05:30), so between 00:00 and 05:29 local
 * an assignment that fell due yesterday still read as on time: the compliance list a manager opens
 * first thing in the morning was a day behind itself, in the direction that under-reports.
 */
function todayIso(): string {
  return civilToday();
}

function mapItem(r: any): LearningItem {
  const progress = r?.progress_pct === null || r?.progress_pct === undefined ? null : Number(r.progress_pct);
  const completedAt = iso(r?.completed_at);
  const state: LearningItem['state'] = completedAt
    ? 'complete'
    : progress !== null && progress > 0
      ? 'in_progress'
      : 'not_started';
  const dueOn = isoDay(r?.due_on);
  return {
    assignmentId: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    courseId: String(r?.course_id ?? ''),
    courseTitle: r?.course_title ? String(r.course_title) : 'A course that is no longer published',
    courseSlug: r?.course_slug ? String(r.course_slug) : null,
    category: r?.category ? String(r.category) : null,
    level: r?.level ? String(r.level) : null,
    required: r?.required === true,
    dueOn,
    reason: r?.reason ? String(r.reason) : null,
    assignedByUserId: r?.assigned_by_user_id ? String(r.assigned_by_user_id) : null,
    status: String(r?.status ?? 'assigned'),
    progressPct: progress,
    completedAt,
    state,
    overdue: state !== 'complete' && !!dueOn && dueOn < todayIso(),
    createdAt: iso(r?.created_at),
  };
}

/**
 * The SELECT every learning-path read shares.
 *
 * training_courses and training_enrollments are LEFT JOINed on purpose. Both are created by an admin
 * page rather than a schema file, so on a database where nobody has opened /admin/hr/training they
 * may not exist at all — and an INNER JOIN would drop every assignment rather than showing it with a
 * missing title. The enrolment join is keyed on the learner's users.id, which is why the assignment
 * carries one: hr_employees.id would match nothing and read as "never started" for everybody.
 */
const ITEM_SELECT = sql`
  SELECT a.*,
         c.title AS course_title,
         c.slug AS course_slug,
         c.category AS category,
         c.level AS level,
         en.progress_pct AS progress_pct,
         en.completed_at AS completed_at,
         e.full_name AS employee_name
    FROM hr_learning_assignments a
    LEFT JOIN training_courses c ON c.id = a.course_id
    LEFT JOIN training_enrollments en ON en.course_id = a.course_id AND en.user_id = a.user_id
    LEFT JOIN hr_employees e ON e.id = a.employee_id`;

// -------------------------------------------------------------------------------------------------
// THE LEARNING PATH
// -------------------------------------------------------------------------------------------------

/** One person's assigned learning: required first, then whatever is due soonest. */
export async function learningPathFor(employeeId: string): Promise<LearningItem[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      ${ITEM_SELECT}
       WHERE a.employee_id = ${employeeId}::uuid AND a.status = 'assigned'
       ORDER BY a.required DESC, a.due_on ASC NULLS LAST, a.created_at DESC
       LIMIT 200`));
    return rows.map(mapItem);
  } catch (e: any) {
    logFail(MOD, 'learningPathFor', e);
    return [];
  }
}

/** Assigned learning across a set of people — the manager and HR views. */
export async function learningForEmployees(employeeIds: readonly string[]): Promise<LearningItem[]> {
  const ids = employeeIds.filter(isUuid);
  if (ids.length === 0) return []; // never emit `IN ()`
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      ${ITEM_SELECT}
       WHERE a.employee_id IN (${uuidList(ids)}) AND a.status = 'assigned'
       ORDER BY e.full_name ASC, a.required DESC, a.due_on ASC NULLS LAST
       LIMIT 500`));
    return rows.map(mapItem);
  } catch (e: any) {
    logFail(MOD, 'learningForEmployees', e);
    return [];
  }
}

/** Everything assigned, for the console. `learning.assign` territory — the caller checks. */
export async function allAssignments(opts: { overdueOnly?: boolean; limit?: number } = {}): Promise<LearningItem[]> {
  const lim = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  try {
    await ensurePerformanceSchema();
    const overdue = opts.overdueOnly === true
      ? sql`AND a.due_on IS NOT NULL AND a.due_on < CURRENT_DATE AND en.completed_at IS NULL`
      : sql``;
    const rows = rowsOf(await db.execute(sql`
      ${ITEM_SELECT}
       WHERE a.status = 'assigned' ${overdue}
       ORDER BY a.due_on ASC NULLS LAST, e.full_name ASC
       LIMIT ${lim}`));
    return rows.map(mapItem);
  } catch (e: any) {
    logFail(MOD, 'allAssignments', e);
    return [];
  }
}

/**
 * Assign a course.
 *
 * The learner's users.id is resolved HERE, from their employee record, rather than taken from the
 * caller — the enrolment join depends on it and handing in the wrong id space would make every
 * assignment read as "never started" forever.
 *
 * Re-assigning an existing course UPDATES the due date and reason rather than failing: the unique
 * constraint is (employee_id, course_id), and "you already assigned this" is not useful when what
 * somebody meant was "and now it is due sooner".
 */
export async function assignCourse(
  viewer: PerfViewer,
  input: {
    employeeId: string;
    courseId: string;
    dueOn?: string | null;
    required?: boolean;
    reason?: string | null;
    /** True when the caller holds `learning.assign`. Resolved by the page, passed in here. */
    orgWide?: boolean;
  },
): Promise<LearningWriteResult> {
  const employeeId = String(input?.employeeId || '');
  const courseId = String(input?.courseId || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'Choose who the course is for.' };
  if (!isUuid(courseId)) return { ok: false, error: 'Choose a course.' };

  const own = viewer.employeeId === employeeId;
  const orgWide = input?.orgWide === true;
  if (!own && !orgWide && !(await canSeePerformanceOf(viewer, employeeId))) {
    return {
      ok: false,
      error: viewer.initialized
        ? 'The Organization Graph does not record you as answering for this person\'s work, so you cannot assign them a course.'
        : 'The Organization Graph has not been set up yet, so no reporting line can be confirmed. '
          + 'Until it is, only somebody with organization-wide authority can assign learning.',
    };
  }

  const dueOn = validDay(input?.dueOn);
  const required = input?.required === true;
  const reason = clean(input?.reason, 1000) || null;

  try {
    await ensurePerformanceSchema();
    const emp = rowsOf(await db.execute(sql`
      SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!emp.length) return { ok: false, error: 'That employee record does not exist.' };
    const learnerUserId = emp[0]?.user_id ? String(emp[0].user_id) : null;

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_learning_assignments
        (employee_id, user_id, course_id, assigned_by_user_id, reason, due_on, required, status)
      VALUES
        (${employeeId}::uuid, ${learnerUserId}::uuid, ${courseId}::uuid, ${viewer.userId}::uuid,
         ${reason}::text, ${dueOn}::date, ${required}, 'assigned')
      ON CONFLICT (employee_id, course_id) DO UPDATE
        SET due_on = EXCLUDED.due_on,
            required = EXCLUDED.required,
            reason = COALESCE(EXCLUDED.reason, hr_learning_assignments.reason),
            user_id = COALESCE(EXCLUDED.user_id, hr_learning_assignments.user_id),
            assigned_by_user_id = EXCLUDED.assigned_by_user_id,
            status = 'assigned'
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };

    if (learnerUserId && !own) {
      const course = rowsOf(await db.execute(sql`
        SELECT title FROM training_courses WHERE id = ${courseId}::uuid LIMIT 1`));
      const title = course.length && course[0]?.title ? String(course[0].title) : 'a course';
      await notifyUser(learnerUserId, {
        title: required ? 'A required course has been assigned to you' : 'A course has been assigned to you',
        body: title + (dueOn ? ' — due ' + dueOn : ''),
        type: 'info',
        actionUrl: '/portal/employee/learning',
        entityType: 'learning_assignment',
        entityId: String(rows[0].id),
      });
    }

    await logAudit({
      userId: viewer.userId,
      action: 'learning.assign',
      entity: 'hr_learning_assignments',
      entityId: String(rows[0].id),
      diff: { employeeId, courseId, dueOn, required },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'assignCourse', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Withdraw an assignment. NOT a delete — the row is marked 'withdrawn' so the record still says
 * somebody was once asked to do this and by whom. Deleting it would erase that.
 */
export async function withdrawAssignment(
  viewer: PerfViewer,
  assignmentId: string,
  orgWide: boolean,
): Promise<LearningWriteResult> {
  if (!isUuid(assignmentId)) return { ok: false, error: 'That assignment does not exist.' };
  try {
    await ensurePerformanceSchema();
    const found = rowsOf(await db.execute(sql`
      SELECT employee_id FROM hr_learning_assignments WHERE id = ${assignmentId}::uuid LIMIT 1`));
    if (!found.length) return { ok: false, error: 'That assignment does not exist.' };
    const employeeId = String(found[0].employee_id);
    if (!orgWide && !(await canSeePerformanceOf(viewer, employeeId))) {
      return { ok: false, error: 'That assignment is not yours to withdraw.' };
    }
    await db.execute(sql`
      UPDATE hr_learning_assignments SET status = 'withdrawn' WHERE id = ${assignmentId}::uuid`);
    await logAudit({
      userId: viewer.userId,
      action: 'learning.withdraw',
      entity: 'hr_learning_assignments',
      entityId: assignmentId,
      diff: { employeeId },
    });
    return { ok: true, id: assignmentId };
  } catch (e: any) {
    logFail(MOD, 'withdrawAssignment', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Certificates earned. Read through src/lib/certificates.ts, which owns that table and its hash
 * chain — a query of our own here would be a second reader of a ledger whose whole value is that
 * there is one.
 */
export async function certificatesFor(userId: string): Promise<CertificateRow[]> {
  if (!isUuid(userId)) return [];
  try {
    const rows = await getCertificatesForUser(userId);
    return (rows || []).map((r: any) => ({
      id: String(r.id),
      courseId: r.course_id ? String(r.course_id) : null,
      courseTitle: r.course_title ? String(r.course_title) : 'A course',
      certNumber: String(r.cert_number || ''),
      issuedAt: iso(r.issued_at),
      grade: r.grade ? String(r.grade) : null,
      verificationUrl: r.verification_url ? String(r.verification_url) : null,
    }));
  } catch (e: any) {
    logFail(MOD, 'certificatesFor', e);
    return [];
  }
}

/** Published courses, for an assignment picker. */
export async function courseOptions(limit = 200): Promise<CourseOption[]> {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, title, category, level, duration_hours
        FROM training_courses
       WHERE is_published = true
       ORDER BY title ASC
       LIMIT ${lim}`));
    return rows.map((r: any) => ({
      id: String(r.id),
      title: r.title ? String(r.title) : 'Untitled course',
      category: r.category ? String(r.category) : null,
      level: r.level ? String(r.level) : null,
      durationHours: r.duration_hours === null || r.duration_hours === undefined ? null : Number(r.duration_hours),
    }));
  } catch (e: any) {
    // training_courses is created by an admin page rather than a schema file, so on a fresh database
    // it can genuinely be absent. An empty picker with an honest empty state beats a 500.
    logFail(MOD, 'courseOptions', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// THE TRAINING CALENDAR
// -------------------------------------------------------------------------------------------------

/**
 * Scheduled training.
 *
 * `forEmployeeId` decides only whether `iAmGoing` is true — it never filters the list. A calendar
 * that hid sessions somebody had not signed up for would be a calendar nobody could use to sign up.
 */
export async function listTrainingEvents(
  opts: { forEmployeeId?: string | null; departmentId?: string | null; includePast?: boolean; limit?: number } = {},
): Promise<TrainingEvent[]> {
  const lim = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  const me = isUuid(opts.forEmployeeId) ? String(opts.forEmployeeId) : null;
  try {
    await ensurePerformanceSchema();
    const timeFilter = opts.includePast === true ? sql`` : sql`AND (t.ends_at IS NULL OR t.ends_at > NOW() - INTERVAL '1 day')`;
    // ::text on both sides — departments.id is a slug in one schema file and a uuid in the other.
    const dept = opts.departmentId ? String(opts.departmentId).trim() : '';
    const deptFilter = dept ? sql`AND (t.department_id IS NULL OR t.department_id = ${dept})` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT t.*,
             c.title AS course_title,
             d.name AS department_name,
             (SELECT COUNT(*)::int FROM hr_training_signups s
               WHERE s.event_id = t.id AND s.status = 'going') AS signups,
             CASE WHEN ${me}::text IS NULL THEN false ELSE EXISTS (
               SELECT 1 FROM hr_training_signups s2
                WHERE s2.event_id = t.id AND s2.employee_id::text = ${me}::text AND s2.status = 'going'
             ) END AS i_am_going
        FROM hr_training_events t
        LEFT JOIN training_courses c ON c.id = t.course_id
        LEFT JOIN departments d ON d.id::text = t.department_id
       WHERE t.status = 'scheduled' ${timeFilter} ${deptFilter}
       ORDER BY t.starts_at ASC
       LIMIT ${lim}`));
    return rows.map((r: any) => ({
      id: String(r.id),
      title: r.title ? String(r.title) : 'Training session',
      description: r.description ? String(r.description) : null,
      courseId: r.course_id ? String(r.course_id) : null,
      courseTitle: r.course_title ? String(r.course_title) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      departmentName: r.department_name ? String(r.department_name) : null,
      startsAt: iso(r.starts_at),
      endsAt: iso(r.ends_at),
      location: r.location ? String(r.location) : null,
      mode: String(r.mode || 'online'),
      capacity: r.capacity === null || r.capacity === undefined ? null : Number(r.capacity),
      status: String(r.status || 'scheduled'),
      signups: Number(r.signups) || 0,
      iAmGoing: r.i_am_going === true,
    }));
  } catch (e: any) {
    logFail(MOD, 'listTrainingEvents', e);
    return [];
  }
}

/** Schedule a session. `learning.assign` territory — the caller checks and passes `orgWide`. */
export async function createTrainingEvent(input: {
  title: string;
  description?: string | null;
  courseId?: string | null;
  departmentId?: string | null;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
  mode?: string;
  capacity?: number | null;
  actorUserId?: string | null;
}): Promise<LearningWriteResult> {
  const title = clean(input?.title, 200);
  if (!title) return { ok: false, error: 'Give the session a title.' };
  const startsAt = validInstant(input?.startsAt);
  if (!startsAt) return { ok: false, error: 'A session needs a start date and time.' };
  const endsAt = validInstant(input?.endsAt);
  if (endsAt && endsAt < startsAt) return { ok: false, error: 'The session ends before it starts.' };
  const mode = (TRAINING_MODES as readonly string[]).indexOf(String(input?.mode || 'online')) >= 0
    ? String(input?.mode || 'online')
    : 'online';
  const capacity = input?.capacity === null || input?.capacity === undefined || input?.capacity === ('' as any)
    ? null
    : Math.max(1, Math.round(Number(input.capacity) || 0)) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  // TEXT, never ::uuid — see the header of org-graph.ts.
  const departmentId = clean(input?.departmentId, 80) || null;

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_training_events
        (title, description, course_id, department_id, starts_at, ends_at, location, mode, capacity,
         status, created_by_user_id)
      VALUES
        (${title}, ${clean(input?.description, 2000) || null}::text,
         ${isUuid(input?.courseId) ? String(input.courseId) : null}::uuid,
         ${departmentId}::text, ${startsAt}::timestamptz, ${endsAt}::timestamptz,
         ${clean(input?.location, 200) || null}::text, ${mode}, ${capacity}::int,
         'scheduled', ${actor}::uuid)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'training.event.create',
      entity: 'hr_training_events',
      entityId: String(rows[0].id),
      diff: { title, startsAt, mode, departmentId },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'createTrainingEvent', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Cancel a session. The row stays, so people who signed up can still see what happened to it. */
export async function cancelTrainingEvent(
  eventId: string,
  actorUserId?: string | null,
): Promise<LearningWriteResult> {
  if (!isUuid(eventId)) return { ok: false, error: 'That session does not exist.' };
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_training_events SET status = 'cancelled' WHERE id = ${eventId}::uuid RETURNING id`));
    if (!rows.length) return { ok: false, error: 'That session does not exist.' };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'training.event.cancel',
      entity: 'hr_training_events',
      entityId: eventId,
      diff: {},
    });
    return { ok: true, id: eventId };
  } catch (e: any) {
    logFail(MOD, 'cancelTrainingEvent', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Sign up for, or withdraw from, a session.
 *
 * THE CAPACITY CHECK IS IN THE INSERT, not in a read before it. Reading a count and then inserting
 * lets two people take the last place between the two statements; the conditional insert below
 * either finds room at write time or does nothing, and "nothing" is reported as a full session.
 */
export async function setTrainingSignup(
  employeeId: string,
  userId: string | null,
  eventId: string,
  going: boolean,
): Promise<LearningWriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'This account has no employee record.' };
  if (!isUuid(eventId)) return { ok: false, error: 'That session does not exist.' };
  try {
    await ensurePerformanceSchema();
    if (!going) {
      await db.execute(sql`
        UPDATE hr_training_signups SET status = 'withdrawn'
         WHERE event_id = ${eventId}::uuid AND employee_id = ${employeeId}::uuid`);
      return { ok: true, id: eventId };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_training_signups (event_id, employee_id, user_id, status)
      SELECT ${eventId}::uuid, ${employeeId}::uuid, ${isUuid(userId) ? String(userId) : null}::uuid, 'going'
        FROM hr_training_events t
       WHERE t.id = ${eventId}::uuid
         AND t.status = 'scheduled'
         AND (
           t.capacity IS NULL
           OR (SELECT COUNT(*) FROM hr_training_signups s
                WHERE s.event_id = t.id AND s.status = 'going'
                  AND s.employee_id <> ${employeeId}::uuid) < t.capacity
         )
      ON CONFLICT (event_id, employee_id) DO UPDATE SET status = 'going'
      RETURNING id`));
    if (!rows.length) {
      return { ok: false, error: 'That session is full, or it is no longer scheduled.' };
    }
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'setTrainingSignup', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// SMALL HELPERS
// -------------------------------------------------------------------------------------------------

function validDay(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

/** An `<input type="datetime-local">` value, or null. */
function validInstant(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Re-exported so a page can name the capability without importing two modules for one string. */
export { LEARNING_ASSIGN };
