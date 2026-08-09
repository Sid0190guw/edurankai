// src/lib/learning-progress.ts — ONE completion fact, shared by both learning surfaces.
//
// =================================================================================================
// WHY THIS FILE EXISTS
// =================================================================================================
//
// There are two course PLAYERS in this product and they were writing two different ledgers:
//
//   /portal/courses/[slug]          inserted training_progress (enrollment_id, lesson_id), then
//                                   recomputed training_enrollments.progress_pct from THAT table.
//   /api/aquintutor/lesson-complete inserted training_lesson_completions (user_id, course_id,
//                                   lesson_id), then recomputed the SAME COLUMN from THAT table.
//
// Same column, two denominators, no reader in common: finish four of five lessons in the AquinTutor
// runner (80%) and then mark one lesson done in the portal player, and progress_pct was rewritten to
// 20%. Nothing was corrupted and nothing threw — the number just quietly became wrong, and the
// employee learning path, which reads that column, reported the wrong figure to a manager.
//
// src/lib/aquintutor-authoring.ts isLessonComplete() already knew the split was real: it UNIONs the
// completion tables to answer "has this learner finished this lesson". Neither percentage writer
// used it. This module makes that union the ONLY definition of progress, and gives both players one
// writer to call.
//
// =================================================================================================
// WHICH SHAPE IS LIVE, AND ON WHAT EVIDENCE
// =================================================================================================
//
// THIS JUDGEMENT IS INFERRED FROM CODE. No database was connected and no row was observed. Every
// statement below is "what the repository writes", not "what production contains".
//
//   LESSON COMPLETION -> training_lesson_completions is the live shape.
//     Evidence: it is written by /api/aquintutor/lesson-complete (the button the AquinTutor lesson
//     runner posts to, courses/[slug]/learn/[lessonSlug].astro:402 and learn/[lesson].astro:364);
//     it is declared TWICE in the repo — in that route and again in aquintutor-authoring.ts:137,
//     whose comment names it "the table lesson completion is ACTUALLY written to"; and it is the
//     table isLessonComplete() lists first. It also carries course_id, so a course percentage can be
//     computed without a join.
//     The other two are kept and still COUNTED, never dropped:
//       training_progress          — written only by the portal player. Real rows almost certainly
//                                    exist, so it stays in the union permanently. Its writer is
//                                    migrated to this module; its rows keep counting.
//       training_lesson_progress   — declared in aquintutor-authoring.ts:123; its writer
//                                    markLessonComplete() is documented in-repo as called by
//                                    nothing. Probably empty. Counted anyway, because "probably
//                                    empty" is not a reason to discard somebody's finished work.
//
//   CERTIFICATE -> course_certificates is the live shape.
//     Evidence: it is the hash-chained, Ed25519-signed ledger in src/lib/certificates.ts; it is what
//     /verify/[cert] verifies; and it is the ONLY table the employee learning surface can read
//     (performance-learning.ts certificatesFor -> getCertificatesForUser). training_certificates is
//     a raw unsigned insert with a number built from Date.now(), and portal/certificate/[number]
//     already documents the resulting confusion: a genuine certificate reported as unverifiable
//     because its number is not in the ledger.
//     ADDITIVE MIGRATION, no DROP: the ledger issues the number, and a compatibility row is written
//     into training_certificates carrying THE SAME NUMBER, so /credentials/[number] and
//     /portal/certificate/[number] now resolve to the certificate /verify/[cert] verifies. Old rows
//     with legacy numbers are untouched and still resolve as they did.
//
//   ENROLMENT -> training_enrollments is the live shape for this product; edu_enrolments is a
//     different key space (kernel course_obj_id, not training_courses.id) and is NOT touched here.
//     That gap is reported honestly rather than guessed at.
//
// =================================================================================================
// WHAT THIS MODULE IS NOT
// =================================================================================================
//
// It is not a third learning system. It creates no course table, no lesson table and no enrolment
// table. Every table it touches already existed and already had a writer. All DDL below is CREATE
// TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS inside an ensureOnce guard, additive, never DROP.
//
// EduRankAI is the technology platform. A completion recorded here is a record of work done on this
// platform. Accredited partners award credentials; nothing in this file claims to confer a
// qualification or a degree, and the evidence wording says exactly that.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { issueCertificate, getCertificatesForUser } from '@/lib/certificates';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that read them. `const` is not hoisted,
// and a const read before its declaration throws on the first line of the function that reads it.
// -------------------------------------------------------------------------------------------------

const MOD = 'learning-progress';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED = 'We could not record that just now. Nothing was changed.';

/** Where a completion came in from. Recorded in the audit entry, never in a second table. */
export type CompletionSource = 'aquintutor' | 'portal' | 'admin';

export interface CourseProgress {
  userId: string;
  courseId: string;
  /** Lessons the catalogue currently offers on this course. */
  totalLessons: number;
  /** Distinct lessons this learner has finished, counted across every completion table. */
  completedLessons: number;
  /** 0-100, or null when this person has no enrolment and no completed lesson at all. */
  pct: number | null;
  complete: boolean;
  /** training_enrollments.completed_at, once something has set it. */
  completedAt: string | null;
  enrolled: boolean;
  /** Every enrolment row for this (user, course). More than one means duplicates exist. */
  enrollmentIds: string[];
}

export interface EnrolResult {
  ok: boolean;
  enrolled: boolean;
  created: boolean;
  enrollmentId: string | null;
  error?: string;
}

export interface LessonCompleteResult {
  ok: boolean;
  error?: string;
  /** False when this lesson was already recorded — the call is idempotent. */
  completedNow: boolean;
  /** True only on the call that took the course from unfinished to finished. */
  courseCompletedNow: boolean;
  progress: CourseProgress | null;
  certificate: { certNumber: string; alreadyIssued: boolean; verificationUrl: string; courseTitle: string } | null;
}

export interface CompletionEvidence {
  userId: string;
  courseId: string;
  courseTitle: string;
  complete: boolean;
  completedAt: string | null;
  lessonsCompleted: number;
  totalLessons: number;
  certNumber: string | null;
  verificationUrl: string | null;
  /**
   * ONE sentence, for a skill-matrix row, a completion letter and a certificate to quote verbatim.
   * It states what was done here; it does not claim a qualification.
   */
  evidence: string;
  evidenceUrl: string | null;
}

// -------------------------------------------------------------------------------------------------
// THE ONE DEFINITION OF PROGRESS, AS SQL
//
// Exported as fragments so a LIST screen stays ONE query. performance-learning.ts composes these
// into its shared SELECT; the aliases `a.user_id` and `a.course_id` are the assignment row it reads
// from, and both files are owned together so the coupling is deliberate and stated here.
//
// A lesson counts once no matter how many tables recorded it, and only if it is still a lesson on
// this course — a learner can hold a completion for a lesson that was later removed, and without
// that constraint a progress bar reads over 100%. getCourseProgress() in aquintutor-authoring.ts
// clamps for the same reason.
// -------------------------------------------------------------------------------------------------

/** The completed-lesson-id set for one (user, course), as a subquery. */
function doneIdsSql(userExpr: any, courseExpr: any) {
  return sql`
    SELECT tl.id AS lesson_id
      FROM training_lessons tl
     WHERE tl.course_id = ${courseExpr}
       AND (
         EXISTS (SELECT 1 FROM training_lesson_completions c
                  WHERE c.user_id = ${userExpr} AND c.lesson_id = tl.id)
         OR EXISTS (SELECT 1 FROM training_progress tp
                      JOIN training_enrollments e2 ON e2.id = tp.enrollment_id
                     WHERE e2.user_id = ${userExpr} AND e2.course_id = ${courseExpr}
                       AND tp.lesson_id = tl.id)
         OR EXISTS (SELECT 1 FROM training_lesson_progress lp
                     WHERE lp.user_id = ${userExpr} AND lp.lesson_id = tl.id
                       AND lp.completed_at IS NOT NULL)
       )`;
}

/**
 * The two lateral joins a list query needs. Assumes the driving row is aliased `a` and carries
 * `user_id` and `course_id`.
 */
export const PROGRESS_LATERAL_SQL = sql`
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS total_lessons
      FROM training_lessons tl0 WHERE tl0.course_id = a.course_id
  ) lt ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS done_lessons FROM (${doneIdsSql(sql`a.user_id`, sql`a.course_id`)}) dl
  ) ld ON TRUE`;

/** The columns those laterals contribute. */
export const PROGRESS_SELECT_SQL = sql`lt.total_lessons AS total_lessons, ld.done_lessons AS done_lessons`;

/** "Finished", as a boolean expression over the same two laterals. */
export const IS_COMPLETE_SQL = sql`(lt.total_lessons > 0 AND ld.done_lessons >= lt.total_lessons)`;

/**
 * Turn the two counts plus the enrolment row into the shape every screen shows.
 *
 * Exported because performance-learning.ts maps the same numbers out of its list query and must not
 * arrive at a different answer than courseProgress() does for a single learner.
 */
export function deriveProgress(row: {
  total_lessons?: any;
  done_lessons?: any;
  progress_pct?: any;
  completed_at?: any;
  enrollment_id?: any;
}): { pct: number | null; complete: boolean; total: number; done: number; enrolled: boolean } {
  const total = Number(row?.total_lessons ?? 0) || 0;
  const doneRaw = Number(row?.done_lessons ?? 0) || 0;
  const done = total > 0 ? Math.min(doneRaw, total) : doneRaw;
  const enrolled = !!row?.enrollment_id;
  const storedPct = row?.progress_pct === null || row?.progress_pct === undefined ? null : Number(row.progress_pct);
  const storedComplete = !!row?.completed_at;

  if (total > 0) {
    // A course with lessons: the lessons ARE the progress. The stored percentage is not consulted,
    // because it is the figure the two players used to overwrite for each other.
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    const complete = storedComplete || done >= total;
    // "Not opened yet" and "opened, nothing done" are different sentences and the screens print both.
    return { pct: !enrolled && done === 0 ? null : pct, complete, total, done, enrolled };
  }
  // A course with no lessons authored yet. Nothing can be counted, so the enrolment row is the only
  // thing that can speak — and it says what it says rather than being replaced by a confident 0%.
  const complete = storedComplete || (storedPct !== null && storedPct >= 100);
  return { pct: storedPct, complete, total: 0, done, enrolled };
}

// -------------------------------------------------------------------------------------------------
// SCHEMA — additive only, inside an ensureOnce guard, never DROP
//
// Each statement is run through ex(), which LOGS the real reason and continues: training_enrollments
// and training_progress have no CREATE anywhere in this repository (they predate it), so on a
// database that has one and not the other a single failed ALTER must not take the rest down. The
// CREATE TABLE IF NOT EXISTS statements are no-ops wherever the table already exists; they matter
// only on a fresh database, where they keep the union query from failing on a missing relation and
// taking the whole learning path down with it.
// -------------------------------------------------------------------------------------------------

export function ensureLearningProgressSchema(): Promise<void> {
  return ensureOnce('learning-progress', async () => {
    const ex = async (q: any, tag: string) => {
      try { await db.execute(q); } catch (e: any) { logFail('ensure:' + tag, e); }
    };

    // The live completion shape. Identical to the definition in /api/aquintutor/lesson-complete and
    // in aquintutor-authoring.ts — a third identical CREATE IF NOT EXISTS redefines nothing.
    await ex(sql`CREATE TABLE IF NOT EXISTS training_lesson_completions (
      user_id UUID NOT NULL,
      course_id UUID NOT NULL,
      lesson_id UUID NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, lesson_id))`, 'completions');
    await ex(sql`CREATE INDEX IF NOT EXISTS tlc_user_course_idx
      ON training_lesson_completions(user_id, course_id)`, 'completions_idx');

    // The portal player's legacy shape. Declared here for the first time in this repository, from
    // the two columns portal/courses/[slug].astro reads and writes, so the union can name it on a
    // database where that page has never run. Its rows keep counting; nothing migrates them out.
    await ex(sql`CREATE TABLE IF NOT EXISTS training_progress (
      enrollment_id UUID NOT NULL,
      lesson_id UUID NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (enrollment_id, lesson_id))`, 'training_progress');

    // The declared-but-unwritten third shape, so the union can name it either way.
    await ex(sql`CREATE TABLE IF NOT EXISTS training_lesson_progress (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      lesson_id UUID NOT NULL,
      course_id UUID,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      time_spent_seconds INT NOT NULL DEFAULT 0,
      last_block_id UUID,
      last_position_seconds INT DEFAULT 0,
      CONSTRAINT training_lesson_progress_key UNIQUE (user_id, lesson_id))`, 'lesson_progress');

    // The columns the single writer sets. Every one of these is written by an existing call site
    // already; ADD COLUMN IF NOT EXISTS only guarantees the UPDATE below cannot fail on a database
    // where one of them was never added.
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`, 'en_completed_at');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS last_lesson_id UUID`, 'en_last_lesson');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`, 'en_last_accessed');
    await ex(sql`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`, 'en_updated_at');

    // The legacy certificate table, and the column that lets a row say which ledger entry it mirrors.
    await ex(sql`CREATE TABLE IF NOT EXISTS training_certificates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL,
      user_id UUID NOT NULL,
      enrollment_id UUID,
      certificate_number VARCHAR(64) NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`, 'training_certificates');
    await ex(sql`ALTER TABLE training_certificates ADD COLUMN IF NOT EXISTS ledger_cert_number VARCHAR(64)`, 'tc_ledger_number');
  });
}

// -------------------------------------------------------------------------------------------------
// THE JOIN, RESOLVED ONCE
// -------------------------------------------------------------------------------------------------

/**
 * hr_employees.id -> users.id, the ONLY bridge between the employee side and the course engine.
 *
 * Everything on the learning side of this product is keyed on users.id: training_enrollments,
 * training_lesson_completions, course_certificates. Everything on the employee side is keyed on
 * hr_employees.id. This function is the single place that crosses, and it returns null rather than
 * guessing when the employee record has no linked account — an assignment for somebody with no
 * users row can never join to an enrolment, and saying so is the honest answer.
 */
export async function resolveLearnerUserId(employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    const v = r.length ? r[0]?.user_id : null;
    return v ? String(v) : null;
  } catch (e: any) {
    logFail('resolveLearnerUserId', e);
    return null;
  }
}

/**
 * Make an assignment a real enrolment.
 *
 * The test and the write are ONE statement, for the reason portal/courses/[slug].astro:51 states out
 * loud: training_enrollments carries no unique key on (course_id, user_id), so a read-then-write
 * left two rows for one person on one course when two requests arrived together, and progress landed
 * on whichever the next SELECT happened to return. enrolled_count is bumped only when the statement
 * actually created a row.
 *
 * HONEST LIMIT, unchanged from that page: without the unique constraint this NARROWS the window, it
 * does not close it. Adding the constraint is a migration for a human to run against live data (it
 * fails if duplicates already exist), so it is not bootstrapped from a page load. The single writer
 * below therefore updates EVERY enrolment row for a (user, course) rather than one, so duplicates
 * cannot disagree with each other even while they exist. NOT VERIFIED at runtime.
 */
export async function ensureEnrolment(userId: string, courseId: string): Promise<EnrolResult> {
  if (!isUuid(userId) || !isUuid(courseId)) {
    return { ok: false, enrolled: false, created: false, enrollmentId: null, error: 'Not a course and a learner.' };
  }
  try {
    await ensureLearningProgressSchema();
    const made = rowsOf(await db.execute(sql`
      INSERT INTO training_enrollments (course_id, user_id, progress_pct)
      SELECT ${courseId}::uuid, ${userId}::uuid, 0
       WHERE NOT EXISTS (
         SELECT 1 FROM training_enrollments
          WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid)
      RETURNING id`));
    if (made.length > 0) {
      try {
        await db.execute(sql`
          UPDATE training_courses SET enrolled_count = COALESCE(enrolled_count, 0) + 1
           WHERE id = ${courseId}::uuid`);
      } catch (e: any) {
        // The enrolment IS created; a published counter that did not move is a display defect, not a
        // reason to tell the learner they are not enrolled. Logged, never silent.
        logFail('ensureEnrolment:count', e);
      }
      return { ok: true, enrolled: true, created: true, enrollmentId: String(made[0].id) };
    }
    const existing = rowsOf(await db.execute(sql`
      SELECT id FROM training_enrollments
       WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid
       ORDER BY id ASC LIMIT 1`));
    return {
      ok: true,
      enrolled: existing.length > 0,
      created: false,
      enrollmentId: existing.length ? String(existing[0].id) : null,
    };
  } catch (e: any) {
    logFail('ensureEnrolment', e);
    return {
      ok: false, enrolled: false, created: false, enrollmentId: null,
      error: e?.cause?.message || e?.message || WRITE_FAILED,
    };
  }
}

/** The completed-lesson ids for one learner on one course, counted across every completion table. */
export async function completedLessonIds(userId: string, courseId: string): Promise<string[]> {
  if (!isUuid(userId) || !isUuid(courseId)) return [];
  await ensureLearningProgressSchema();
  const r = rowsOf(await db.execute(sql`
    SELECT DISTINCT d.lesson_id::text AS lesson_id
      FROM (${doneIdsSql(sql`${userId}::uuid`, sql`${courseId}::uuid`)}) d`));
  return r.map((x: any) => String(x.lesson_id));
}

/**
 * ONE learner, ONE course, ONE answer. Every surface that shows a percentage reads this or the
 * lateral fragments above, which compute the identical thing.
 *
 * Throws on a read failure ON PURPOSE, exactly as isLessonComplete() does: "0%" is the answer that
 * makes a screen tell somebody their finished work is not there, and it is indistinguishable from a
 * real "not started".
 */
export async function courseProgress(userId: string, courseId: string): Promise<CourseProgress> {
  const empty: CourseProgress = {
    userId: String(userId || ''), courseId: String(courseId || ''),
    totalLessons: 0, completedLessons: 0, pct: null, complete: false,
    completedAt: null, enrolled: false, enrollmentIds: [],
  };
  if (!isUuid(userId) || !isUuid(courseId)) return empty;
  await ensureLearningProgressSchema();

  const totals = rowsOf(await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM training_lessons tl0 WHERE tl0.course_id = ${courseId}::uuid) AS total_lessons,
      (SELECT COUNT(*)::int FROM (${doneIdsSql(sql`${userId}::uuid`, sql`${courseId}::uuid`)}) d) AS done_lessons`))[0] || {};

  const enrols = rowsOf(await db.execute(sql`
    SELECT id, progress_pct, completed_at FROM training_enrollments
     WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
     ORDER BY id ASC`));

  // With duplicate enrolment rows, the FINISHED one is the truth — a second row that says nothing
  // must never erase a completion recorded on the first.
  const completedAtRow = enrols.find((e: any) => !!e?.completed_at);
  const bestPct = enrols.reduce((acc: number | null, e: any) => {
    const v = e?.progress_pct === null || e?.progress_pct === undefined ? null : Number(e.progress_pct);
    if (v === null) return acc;
    return acc === null ? v : Math.max(acc, v);
  }, null as number | null);

  const d = deriveProgress({
    total_lessons: totals.total_lessons,
    done_lessons: totals.done_lessons,
    progress_pct: bestPct,
    completed_at: completedAtRow?.completed_at ?? null,
    enrollment_id: enrols.length ? enrols[0].id : null,
  });

  return {
    userId, courseId,
    totalLessons: d.total, completedLessons: d.done, pct: d.pct, complete: d.complete,
    completedAt: completedAtRow?.completed_at ? new Date(completedAtRow.completed_at).toISOString() : null,
    enrolled: enrols.length > 0,
    enrollmentIds: enrols.map((e: any) => String(e.id)),
  };
}

// -------------------------------------------------------------------------------------------------
// THE SINGLE WRITER
// -------------------------------------------------------------------------------------------------

/**
 * Record that a learner finished a lesson. BOTH players call this and nothing else writes a course
 * percentage.
 *
 * Idempotent: calling it twice records the lesson once and issues one certificate.
 *
 * Nothing here is swallowed. The completion INSERT and the percentage UPDATE are allowed to throw
 * into the catch, which logs the real Postgres reason off e.cause and returns ok:false so the caller
 * can say the work did not save. A player that reports "Lesson completed" over a write that threw is
 * the exact failure this project has already paid for once.
 */
export async function recordLessonComplete(input: {
  userId: string;
  courseId?: string | null;
  lessonId: string;
  source: CompletionSource;
}): Promise<LessonCompleteResult> {
  const fail = (error: string): LessonCompleteResult => ({
    ok: false, error, completedNow: false, courseCompletedNow: false, progress: null, certificate: null,
  });

  const userId = String(input?.userId || '');
  const lessonId = String(input?.lessonId || '');
  if (!isUuid(userId)) return fail('Sign in to record this lesson.');
  if (!isUuid(lessonId)) return fail('That lesson does not exist.');

  try {
    await ensureLearningProgressSchema();

    // The course is resolved FROM THE LESSON, never trusted from the caller. One live call site
    // posts courseId:'' (aquintutor/learn/[lesson].astro:364), and a completion row filed under the
    // wrong course counts towards a course the learner never took.
    const les = rowsOf(await db.execute(sql`
      SELECT id, course_id FROM training_lessons WHERE id = ${lessonId}::uuid LIMIT 1`));
    if (!les.length || !les[0]?.course_id) return fail('That lesson is not part of a course.');
    const courseId = String(les[0].course_id);
    const claimed = String(input?.courseId || '');
    if (isUuid(claimed) && claimed !== courseId) {
      // Not fatal, and not silent: the lesson's own course wins, and the mismatch is findable.
      logFail('recordLessonComplete:course-mismatch',
        new Error('lesson ' + lessonId + ' belongs to ' + courseId + ', caller said ' + claimed));
    }

    const before = await courseProgress(userId, courseId);
    await ensureEnrolment(userId, courseId);

    const ins = rowsOf(await db.execute(sql`
      INSERT INTO training_lesson_completions (user_id, course_id, lesson_id)
      VALUES (${userId}::uuid, ${courseId}::uuid, ${lessonId}::uuid)
      ON CONFLICT (user_id, lesson_id) DO NOTHING
      RETURNING lesson_id`));
    const completedNow = ins.length > 0;

    const after = await courseProgress(userId, courseId);
    const pct = after.pct === null ? 0 : after.pct;

    // EVERY enrolment row for this pair, not one. While duplicates can exist they must not be able
    // to hold different answers, and the completion timestamp is set ONCE and never moved.
    await db.execute(sql`
      UPDATE training_enrollments
         SET progress_pct = ${pct},
             last_lesson_id = ${lessonId}::uuid,
             last_accessed_at = NOW(),
             updated_at = NOW(),
             completed_at = CASE WHEN ${after.complete} THEN COALESCE(completed_at, NOW()) ELSE completed_at END
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid`);

    const courseCompletedNow = after.complete && !before.complete;

    let certificate: LessonCompleteResult['certificate'] = null;
    if (after.complete) {
      certificate = await issueCourseCertificate(userId, courseId, after.enrollmentIds[0] || null);
    }

    if (courseCompletedNow) {
      // ONE audit entry, on the fact that matters. A row per lesson would bury it.
      await logAudit({
        userId,
        action: 'learning.course_completed',
        entity: 'training_enrollments',
        entityId: after.enrollmentIds[0] || courseId,
        diff: {
          courseId,
          source: input.source,
          lessonsCompleted: after.completedLessons,
          totalLessons: after.totalLessons,
          certNumber: certificate?.certNumber || null,
        },
      });

      // THE SPINE IS TOLD, ONCE, ON THE FACT THAT MATTERS — and never on a lesson.
      //
      // It runs after the completion is written and cannot undo it: emitHrEvent() does not throw,
      // and a failure is logged here rather than swallowed. A learner who finished a course and lost
      // the timeline row is a reporting gap; a learner who finished a course and lost the COMPLETION
      // to a logging failure would be the real damage, and that cannot happen from here.
      //
      // `assertion: 'factual'` is the honest word: this platform watched the lessons complete. The
      // certificate number is the signed ledger's, so anything reading this event cites the same
      // certificate /verify/[cert] verifies.
      try {
        const { emitHrEvent } = await import('@/lib/hr-events');
        const emitted = await emitHrEvent({
          type: 'CourseCompleted',
          subject: { userId },
          actorUserId: userId,
          actorKind: 'human',
          sourceModule: 'lib/learning-progress.recordLessonComplete',
          recordRef: after.enrollmentIds[0] || courseId,
          assertion: 'factual',
          payload: {
            courseId,
            source: input.source,
            lessonsCompleted: after.completedLessons,
            totalLessons: after.totalLessons,
            certNumber: certificate?.certNumber || null,
            verificationUrl: certificate?.verificationUrl || null,
          },
        });
        if (!emitted.ok) {
          logFail('recordLessonComplete:emit', new Error(emitted.error || 'CourseCompleted was not appended'));
        }
      } catch (e: any) {
        logFail('recordLessonComplete:emit', e);
      }
    }

    return { ok: true, completedNow, courseCompletedNow, progress: after, certificate };
  } catch (e: any) {
    logFail('recordLessonComplete', e);
    return fail(e?.cause?.message || e?.message || WRITE_FAILED);
  }
}

/**
 * Issue the course certificate through the ledger, then write the legacy-compatibility row.
 *
 * src/lib/certificates.ts owns course_certificates and its hash chain; this never inserts into it
 * directly. The training_certificates row carries THE LEDGER'S number, so the two verification
 * front doors stop disagreeing: /credentials/[number] and /portal/certificate/[number] now resolve
 * to the same certificate /verify/[cert] verifies.
 */
async function issueCourseCertificate(
  userId: string, courseId: string, enrollmentId: string | null,
): Promise<LessonCompleteResult['certificate']> {
  let courseTitle = 'An EduRankAI course';
  try {
    const c = rowsOf(await db.execute(sql`
      SELECT title FROM training_courses WHERE id = ${courseId}::uuid LIMIT 1`));
    if (c.length && c[0]?.title) courseTitle = String(c[0].title);
  } catch (e: any) {
    logFail('issueCourseCertificate:title', e);
  }

  const cert = await issueCertificate({ userId, courseId, courseTitle, grade: 'Pass' });
  if (!cert) return null;

  // COMPATIBILITY WRITE, not a second ledger. It is allowed to fail without failing the completion —
  // the certificate already exists and is verifiable — but it is never allowed to fail in silence.
  try {
    await db.execute(sql`
      INSERT INTO training_certificates (course_id, user_id, enrollment_id, certificate_number, ledger_cert_number)
      SELECT ${courseId}::uuid, ${userId}::uuid, ${enrollmentId}::uuid, ${cert.certNumber}, ${cert.certNumber}
       WHERE NOT EXISTS (
         SELECT 1 FROM training_certificates
          WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid)`);
  } catch (e: any) {
    logFail('issueCourseCertificate:compat', e);
  }

  return {
    certNumber: cert.certNumber,
    alreadyIssued: cert.alreadyIssued,
    verificationUrl: '/verify/' + cert.certNumber,
    courseTitle,
  };
}

// -------------------------------------------------------------------------------------------------
// THE ONE FACT, IN THE WORDS EVERY DOCUMENT QUOTES
// -------------------------------------------------------------------------------------------------

/**
 * What a certificate, a skill-matrix row and a completion letter must all be able to name.
 *
 * All three call this, so they cite the same lesson count, the same date and the same certificate
 * number. `evidence` is a sentence about work done on this platform. It does not say "qualified",
 * "certified in", "degree" or "credential" — accredited partners award credentials and this is not
 * one.
 *
 * `evidenceUrl` is a verification link, never an upload. Documents on this project are links.
 */
export async function completionEvidence(userId: string, courseId: string): Promise<CompletionEvidence | null> {
  if (!isUuid(userId) || !isUuid(courseId)) return null;
  try {
    const p = await courseProgress(userId, courseId);

    let courseTitle = 'A course';
    try {
      const c = rowsOf(await db.execute(sql`
        SELECT title FROM training_courses WHERE id = ${courseId}::uuid LIMIT 1`));
      if (c.length && c[0]?.title) courseTitle = String(c[0].title);
    } catch (e: any) {
      logFail('completionEvidence:title', e);
    }

    // The ledger, through its owner. A query of our own here would be a second reader of a chain
    // whose whole value is that there is one.
    let certNumber: string | null = null;
    let verificationUrl: string | null = null;
    try {
      const certs = await getCertificatesForUser(userId);
      const mine = (certs || []).find((c: any) => String(c?.course_id || '') === courseId);
      if (mine) {
        certNumber = String(mine.cert_number || '') || null;
        verificationUrl = certNumber ? '/verify/' + certNumber : null;
      }
    } catch (e: any) {
      logFail('completionEvidence:certs', e);
    }

    const day = p.completedAt ? p.completedAt.slice(0, 10) : null;
    const counted = p.totalLessons > 0
      ? p.completedLessons + ' of ' + p.totalLessons + ' lessons'
      : 'the course';
    const evidence = p.complete
      ? 'Completed ' + courseTitle + ' on the EduRankAI platform'
        + (day ? ' on ' + day : '')
        + ' (' + counted + ' recorded)'
        + (certNumber ? ', certificate ' + certNumber : '')
      : 'In progress: ' + courseTitle + ' (' + counted + ' recorded)';

    return {
      userId, courseId, courseTitle,
      complete: p.complete,
      completedAt: p.completedAt,
      lessonsCompleted: p.completedLessons,
      totalLessons: p.totalLessons,
      certNumber, verificationUrl,
      evidence,
      evidenceUrl: verificationUrl,
    };
  } catch (e: any) {
    logFail('completionEvidence', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// THE HONEST GAP
// -------------------------------------------------------------------------------------------------

export interface LearnerBackfillReport {
  ok: boolean;
  /** Assignments whose learner account was filled in from the employee record. */
  updated: number;
  /** Assignments still with no users.id — they cannot join to an enrolment and never will. */
  unmatched: number;
  error?: string;
}

/**
 * Fill in hr_learning_assignments.user_id wherever the link is UNAMBIGUOUS.
 *
 * The column is nullable and was only ever backfilled by COALESCE on re-assign, so an assignment
 * created before its employee record was linked to an account stays "not started" forever — the
 * enrolment join keys on users.id and has nothing to match.
 *
 * The link is unambiguous by construction: one hr_employees row carries exactly one user_id. Rows
 * where that column is null are NOT guessed at from a name or an email address; they are counted
 * and reported, because an honest gap beats a silent mismatch.
 */
export async function backfillAssignmentLearners(): Promise<LearnerBackfillReport> {
  try {
    const updated = rowsOf(await db.execute(sql`
      UPDATE hr_learning_assignments a
         SET user_id = e.user_id
        FROM hr_employees e
       WHERE e.id = a.employee_id
         AND a.user_id IS NULL
         AND e.user_id IS NOT NULL
      RETURNING a.id`));
    const left = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hr_learning_assignments WHERE user_id IS NULL`));
    return { ok: true, updated: updated.length, unmatched: Number(left[0]?.n || 0) };
  } catch (e: any) {
    logFail('backfillAssignmentLearners', e);
    return { ok: false, updated: 0, unmatched: 0, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export interface ProgressDisagreement {
  userId: string;
  courseId: string;
  courseTitle: string;
  /** What training_enrollments.progress_pct currently says. */
  storedPct: number | null;
  /** What the completion tables say, counted together. */
  countedPct: number | null;
  lessonsCompleted: number;
  totalLessons: number;
  /** Which tables hold rows for this learner on this course. */
  sources: string[];
}

/**
 * Where the stored percentage and the counted percentage disagree.
 *
 * Nothing could see this before: no screen showed training_progress beside
 * training_lesson_completions, so the overwrite that turned a learner's 80% into 20% left no trace
 * to look at. This is a READ. It corrects nothing — the next lesson a learner finishes goes through
 * the single writer and the stored figure catches up on its own, and every surface already reads the
 * counted figure rather than the stored one.
 */
export async function progressDisagreements(limit = 200): Promise<ProgressDisagreement[]> {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  try {
    await ensureLearningProgressSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT en.user_id::text AS user_id,
             en.course_id::text AS course_id,
             c.title AS course_title,
             en.progress_pct AS stored_pct,
             lt.total_lessons AS total_lessons,
             ld.done_lessons AS done_lessons,
             (SELECT COUNT(*)::int FROM training_lesson_completions x
               WHERE x.user_id = en.user_id AND x.course_id = en.course_id) AS n_completions,
             (SELECT COUNT(*)::int FROM training_progress tp WHERE tp.enrollment_id = en.id) AS n_portal,
             (SELECT COUNT(*)::int FROM training_lesson_progress lp
                JOIN training_lessons l3 ON l3.id = lp.lesson_id
               WHERE lp.user_id = en.user_id AND l3.course_id = en.course_id
                 AND lp.completed_at IS NOT NULL) AS n_authoring
        FROM training_enrollments en
        LEFT JOIN training_courses c ON c.id = en.course_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS total_lessons FROM training_lessons tl0 WHERE tl0.course_id = en.course_id
        ) lt ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT dl.lesson_id)::int AS done_lessons
            FROM (${doneIdsSql(sql`en.user_id`, sql`en.course_id`)}) dl
        ) ld ON TRUE
       WHERE lt.total_lessons > 0
         AND COALESCE(en.progress_pct, -1)
             <> ROUND((LEAST(ld.done_lessons, lt.total_lessons)::numeric / lt.total_lessons) * 100)
       ORDER BY c.title ASC NULLS LAST
       LIMIT ${lim}`));
    return rows.map((r: any) => {
      const total = Number(r?.total_lessons || 0);
      const done = Math.min(Number(r?.done_lessons || 0), total);
      const sources: string[] = [];
      if (Number(r?.n_completions || 0) > 0) sources.push('training_lesson_completions');
      if (Number(r?.n_portal || 0) > 0) sources.push('training_progress');
      if (Number(r?.n_authoring || 0) > 0) sources.push('training_lesson_progress');
      return {
        userId: String(r?.user_id || ''),
        courseId: String(r?.course_id || ''),
        courseTitle: r?.course_title ? String(r.course_title) : 'A course that is no longer published',
        storedPct: r?.stored_pct === null || r?.stored_pct === undefined ? null : Number(r.stored_pct),
        countedPct: total > 0 ? Math.round((done / total) * 100) : null,
        lessonsCompleted: done,
        totalLessons: total,
        sources,
      };
    });
  } catch (e: any) {
    logFail('progressDisagreements', e);
    return [];
  }
}
