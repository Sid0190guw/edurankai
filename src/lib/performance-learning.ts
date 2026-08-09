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
// recorded in two places in this codebase already (workforce/widgets.ts:1433 and
// workforce/navigation.ts:275) as the reason the Learning nav entry has no widget
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
// THE JOIN, AND THE ONLY DEFINITION OF PROGRESS.
//
// This module used to read training_enrollments.progress_pct and call that the answer. That column
// had two writers computing it from two different completion tables, neither reading the other, so
// the figure a manager saw on /admin/hr/performance/learning was whichever player wrote last. It
// also derived "complete" from training_enrollments.completed_at, which NOTHING in the repository
// wrote: a course finished in either player stayed "in progress" here forever, and the overdue
// filter went on chasing somebody who had finished.
//
// Both now come from src/lib/learning-progress.ts — the same counts the AquinTutor player computes,
// read from the same tables, not a copy and not a mirror that can drift.
import {
  backfillAssignmentLearners,
  completionEvidence,
  deriveProgress,
  ensureEnrolment,
  ensureLearningProgressSchema,
  resolveLearnerUserId,
  IS_COMPLETE_SQL,
  PROGRESS_LATERAL_SQL,
  PROGRESS_SELECT_SQL,
  type CompletionEvidence,
} from '@/lib/learning-progress';
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
  /** 'public' | 'both' | 'employees' — the picker never offers anything else to an employee. */
  accessType: string | null;
  /** Enrolling on this one goes through a checkout. A picker should say so before it is assigned. */
  isPaid: boolean;
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
  /**
   * The learner's REAL progress, counted from the completion tables the two players write — not the
   * stored training_enrollments.progress_pct, which either player could overwrite with the other's
   * denominator. Null when the learner has neither an enrolment nor a single finished lesson.
   */
  progressPct: number | null;
  completedAt: string | null;
  /** Lessons finished, counted once across every completion table. */
  lessonsCompleted: number;
  /** Lessons the course offers today. 0 when nothing has been authored yet. */
  totalLessons: number;
  /** Is there an enrolment row at all? An assignment now creates one, so this is normally true. */
  enrolled: boolean;
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
  /**
   * The write LANDED, but something beside it did not — an assignment saved for somebody with no
   * sign-in account, whose progress therefore cannot be tracked. A screen that shows only ok/error
   * would print a plain success over it.
   */
  warning?: string;
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

/**
 * Both ensures, in one call.
 *
 * ITEM_SELECT now names training_lessons, training_lesson_completions, training_progress and
 * training_lesson_progress. A MISSING RELATION FAILS THE WHOLE QUERY, LEFT JOIN or not — it is a
 * parse-time error, not a row-level one — so a database where one of those tables had never been
 * created would take the learning path down instead of degrading it. learning-progress.ts declares
 * all four additively (CREATE TABLE IF NOT EXISTS, no DROP), and this makes sure that has run before
 * the first read. Both ensures are memoised per process, so the second call costs nothing.
 */
async function ensureLearningSchema(): Promise<void> {
  await ensureLearningSchema();
  await ensureLearningProgressSchema();
}

function mapItem(r: any): LearningItem {
  // ONE derivation, shared with courseProgress() in learning-progress.ts. Two copies of this
  // arithmetic is how the employee surface and the learner's own screen come to show two numbers.
  const d = deriveProgress(r);
  const progress = d.pct;
  const completedAt = iso(r?.completed_at);
  const state: LearningItem['state'] = d.complete
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
    lessonsCompleted: d.done,
    totalLessons: d.total,
    enrolled: d.enrolled,
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
 *
 * THE TWO LATERALS ARE THE PROGRESS. They come from learning-progress.ts and count the same lessons,
 * out of the same tables, as the AquinTutor player does — so this list cannot disagree with the
 * screen the learner is looking at. en.progress_pct is still selected, but only so a course with no
 * lessons authored yet has something to say; it is no longer what anybody is shown when lessons
 * exist.
 *
 * THE ENROLMENT JOIN IS A LATERAL THAT TAKES ONE ROW. It was a plain LEFT JOIN, and
 * training_enrollments has no unique key on (course_id, user_id) — portal/courses/[slug].astro:51
 * documents duplicates as possible — so one assignment could render as TWO lines in a manager's
 * list, with two different percentages, and neither of them wrong. The lateral picks the most
 * finished row by the same rule courseProgress() uses: a second row that says nothing must never
 * erase a completion recorded on the first.
 */
const ITEM_SELECT = sql`
  SELECT a.*,
         c.title AS course_title,
         c.slug AS course_slug,
         c.category AS category,
         c.level AS level,
         en.id AS enrollment_id,
         en.progress_pct AS progress_pct,
         en.completed_at AS completed_at,
         ${PROGRESS_SELECT_SQL},
         e.full_name AS employee_name
    FROM hr_learning_assignments a
    LEFT JOIN training_courses c ON c.id = a.course_id
    LEFT JOIN LATERAL (
      SELECT en0.id, en0.progress_pct, en0.completed_at
        FROM training_enrollments en0
       WHERE en0.course_id = a.course_id AND en0.user_id = a.user_id
       ORDER BY (en0.completed_at IS NOT NULL) DESC, en0.progress_pct DESC NULLS LAST, en0.id ASC
       LIMIT 1
    ) en ON TRUE
    LEFT JOIN hr_employees e ON e.id = a.employee_id
    ${PROGRESS_LATERAL_SQL}`;

// -------------------------------------------------------------------------------------------------
// THE LEARNING PATH
// -------------------------------------------------------------------------------------------------

/**
 * One person's assigned learning: required first, then whatever is due soonest — WITH the read state
 * beside it.
 *
 * "NOTHING IS ASSIGNED TO YOU" AND "WE COULD NOT READ THIS" ARE DIFFERENT SENTENCES, and until this
 * existed every caller had only an empty array to tell them apart. A learner shown "nothing has been
 * assigned to you" during an outage goes back to work; the same learner shown it while a required
 * course is quietly overdue is being misled by their own tools. The list is unchanged — the caller
 * now gets to say which of the two happened.
 */
export async function learningPathRead(
  employeeId: string,
): Promise<{ read: 'ok' | 'unreadable'; items: LearningItem[] }> {
  if (!isUuid(employeeId)) return { read: 'ok', items: [] };
  try {
    await ensureLearningSchema();
    const rows = rowsOf(await db.execute(sql`
      ${ITEM_SELECT}
       WHERE a.employee_id = ${employeeId}::uuid AND a.status = 'assigned'
       ORDER BY a.required DESC, a.due_on ASC NULLS LAST, a.created_at DESC
       LIMIT 200`));
    return { read: 'ok', items: rows.map(mapItem) };
  } catch (e: any) {
    logFail(MOD, 'learningPathRead', e);
    return { read: 'unreadable', items: [] };
  }
}

/** The same read, for callers with nothing useful to do with the distinction. */
export async function learningPathFor(employeeId: string): Promise<LearningItem[]> {
  return (await learningPathRead(employeeId)).items;
}

/** Assigned learning across a set of people — the manager and HR views. */
export async function learningForEmployees(employeeIds: readonly string[]): Promise<LearningItem[]> {
  const ids = employeeIds.filter(isUuid);
  if (ids.length === 0) return []; // never emit `IN ()`
  try {
    await ensureLearningSchema();
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
    await ensureLearningSchema();
    const overdue = opts.overdueOnly === true
      // OVERDUE AGAINST THE COMPANY'S DAY, NOT THE SERVER'S. CURRENT_DATE is the database session's
      // date; nothing sets that session's zone, so it is UTC while the learner's deadline was set in
      // IST. Between 00:00 and 05:29 IST an assignment that fell due yesterday was still not counted
      // overdue, so the console under-reported for the first five and a half hours of every day.
      // The module already declares its civil-date helper for exactly this reason.
      //
      // AND "FINISHED" IS THE COUNTED FINISH, NOT en.completed_at. Nothing in this repository ever
      // wrote that column, so this filter excluded nobody: a learner who had completed every lesson
      // of a required course was still listed as overdue and still chased for it. The same lateral
      // the rest of the row reads answers it now. en.completed_at is kept in the test as well, so a
      // course with no lessons authored still counts as finished once something sets it.
      ? sql`AND a.due_on IS NOT NULL AND a.due_on < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND en.completed_at IS NULL AND NOT ${IS_COMPLETE_SQL}`
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
 *
 * AN ASSIGNMENT IS NOW AN ENROLMENT. It used to be a row in a table only HR could see: the employee
 * was asked to do a course they were not enrolled in, and the enrolment only appeared if they found
 * the course and opened the player. Until they did, every screen said "not started" — which was
 * indistinguishable from "has not bothered". ensureEnrolment() puts them on the actual course, in
 * the actual training_enrollments table both players read, at the moment they are asked.
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
    await ensureLearningSchema();
    const exists = rowsOf(await db.execute(sql`
      SELECT 1 AS hit FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!exists.length) return { ok: false, error: 'That employee record does not exist.' };
    // ONE PLACE crosses from employee-id space to users-id space, and it is not this file.
    const learnerUserId = await resolveLearnerUserId(employeeId);

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

    // ENROL THEM ON THE COURSE THEY WERE JUST ASKED TO DO.
    //
    // This is deliberately AFTER the assignment row: the assignment is the record of the decision
    // and must survive an enrolment that could not be written. It is not swallowed either — the
    // reason is logged inside ensureEnrolment() and the caller is told in `warning`, because
    // "assigned" with no enrolment behind it is the state that used to read as "not started"
    // forever and send a manager looking for a person's motivation instead of a data problem.
    let warning: string | undefined;
    if (!learnerUserId) {
      warning = 'Assigned. This employee record has no linked sign-in account yet, so we could not '
        + 'enrol them on the course — their progress cannot be tracked until the account is linked.';
    } else {
      const enrol = await ensureEnrolment(learnerUserId, courseId);
      if (!enrol.ok || !enrol.enrolled) {
        warning = 'Assigned, but we could not enrol them on the course just now. They can still open '
          + 'it from their learning path, which enrols them.';
      }
    }

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
      diff: { employeeId, courseId, dueOn, required, enrolled: !warning },
    });
    return { ok: true, id: String(rows[0].id), warning };
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
    await ensureLearningSchema();
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
export async function certificatesRead(
  userId: string,
): Promise<{ read: 'ok' | 'unreadable'; items: CertificateRow[] }> {
  if (!isUuid(userId)) return { read: 'ok', items: [] };
  try {
    const rows = await getCertificatesForUser(userId);
    return {
      read: 'ok',
      items: (rows || []).map((r: any) => ({
        id: String(r.id),
        courseId: r.course_id ? String(r.course_id) : null,
        courseTitle: r.course_title ? String(r.course_title) : 'A course',
        certNumber: String(r.cert_number || ''),
        issuedAt: iso(r.issued_at),
        grade: r.grade ? String(r.grade) : null,
        verificationUrl: r.verification_url ? String(r.verification_url) : null,
      })),
    };
  } catch (e: any) {
    // "YOU HAVE NOT COMPLETED ANYTHING YET" IS A CRUEL THING TO SAY TO SOMEBODY WHO HAS. An empty
    // array cannot tell the two apart, so the read state travels with the list and the screen picks
    // the sentence.
    logFail(MOD, 'certificatesRead', e);
    return { read: 'unreadable', items: [] };
  }
}

/** The same read, for callers with nothing useful to do with the distinction. */
export async function certificatesFor(userId: string): Promise<CertificateRow[]> {
  return (await certificatesRead(userId)).items;
}

/**
 * THE ONE FACT, for an employee rather than a user account.
 *
 * A certificate, a skill-matrix row (`source = 'course'`, which src/lib/skills.ts has always
 * declared and nothing has ever written) and a completion letter all need to name the same evidence:
 * the same date, the same lesson count, the same certificate number. They get it here, so they
 * cannot cite three different versions of one afternoon's work.
 *
 * `evidence` and `evidenceUrl` are shaped for setEmployeeSkill()'s existing fields. The URL is a
 * verification link — a document on this project is a link, never an upload.
 *
 * The wording says what was done on this platform. It does not claim a qualification: EduRankAI is
 * the technology platform and accredited partners award credentials.
 */
export async function evidenceFor(employeeId: string, courseId: string): Promise<CompletionEvidence | null> {
  if (!isUuid(employeeId) || !isUuid(courseId)) return null;
  try {
    const learnerUserId = await resolveLearnerUserId(employeeId);
    if (!learnerUserId) return null;
    return await completionEvidence(learnerUserId, courseId);
  } catch (e: any) {
    logFail(MOD, 'evidenceFor', e);
    return null;
  }
}

export interface LearnerLinkReport {
  ok: boolean;
  /** Assignments whose learner account was filled in from the employee record. */
  linked: number;
  /**
   * Assignments that STILL have no users.id. These can never join to an enrolment, so they will read
   * as "not started" whatever the person does. The cause is always the same and it is not guessable
   * from here: hr_employees.user_id is null, meaning that employee record has never been connected
   * to a sign-in account.
   */
  unmatched: number;
  reason: string;
  error?: string;
}

/**
 * Reconnect assignments to learner accounts, and COUNT the ones that cannot be reconnected.
 *
 * hr_learning_assignments.user_id is nullable and was only ever filled in by COALESCE when somebody
 * happened to re-assign the same course. An assignment created before the employee's account was
 * linked kept a null there permanently, and the enrolment join — which keys on users.id — had
 * nothing to match, so that person read as "never started" no matter how much of the course they
 * finished.
 *
 * WHAT IT WILL NOT DO: match on a name or an email address. One hr_employees row carries exactly one
 * user_id, so filling it in from there is unambiguous. Anything else is a guess about which human
 * being did some work, and a wrong guess attributes one person's training record to another.
 * Unmatched rows are counted and reported instead.
 */
export async function reconcileLearnerLinks(): Promise<LearnerLinkReport> {
  const r = await backfillAssignmentLearners();
  return {
    ok: r.ok,
    linked: r.updated,
    unmatched: r.unmatched,
    reason: r.unmatched === 0
      ? 'Every assignment is connected to a sign-in account.'
      : r.unmatched + ' assignment' + (r.unmatched === 1 ? '' : 's')
        + ' could not be connected, because the employee record behind '
        + (r.unmatched === 1 ? 'it has' : 'them has') + ' no linked sign-in account. '
        + 'Their progress cannot be tracked until somebody links the account; we did not guess at a '
        + 'match from a name or an email address.',
    error: r.error,
  };
}

/**
 * Published courses, for an assignment picker.
 *
 * IT ONLY OFFERS COURSES THE ASSIGNEE CAN ACTUALLY OPEN. This filtered on is_published alone, while
 * both players enforce access_type (portal/courses/[slug].astro:41, start-enrollment.ts), so HR
 * could assign a course with access_type='applicants' and the employee was redirected straight back
 * to the catalogue with no explanation — a required course nobody could take, chased as overdue
 * forever. 'public', 'both' and 'employees' are the three an employee is admitted to; NULL is
 * included because rows predating the column exist and excluding them would empty the picker.
 *
 * A PAID COURSE IS STILL OFFERED, AND SAID SO. start-enrollment.ts demands payment for one, so
 * assigning it without warning would send somebody to a checkout they were told was mandatory
 * training. `isPaid` is returned rather than the row being hidden, because a company that has paid
 * for seats has a real reason to assign one.
 */
export async function courseOptions(limit = 200): Promise<CourseOption[]> {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, title, category, level, duration_hours, access_type, is_free, is_paid_course,
             price_inr_paise
        FROM training_courses
       WHERE is_published = true
         AND (access_type IS NULL OR access_type IN ('public', 'both', 'employees'))
       ORDER BY title ASC
       LIMIT ${lim}`));
    return rows.map((r: any) => ({
      id: String(r.id),
      title: r.title ? String(r.title) : 'Untitled course',
      category: r.category ? String(r.category) : null,
      level: r.level ? String(r.level) : null,
      durationHours: r.duration_hours === null || r.duration_hours === undefined ? null : Number(r.duration_hours),
      accessType: r.access_type ? String(r.access_type) : null,
      isPaid: r.is_free !== true && r.is_paid_course === true && Number(r.price_inr_paise || 0) >= 100,
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
    await ensureLearningSchema();
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
    await ensureLearningSchema();
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
    await ensureLearningSchema();
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
    await ensureLearningSchema();
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
