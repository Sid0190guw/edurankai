// src/lib/lms/gradebook.ts — GRADING, WEIGHTED CATEGORIES, AND THE COURSE GRADE (L2).
//
// The arithmetic is not in this file — it is in policy.ts, pure and tested. This file is the part
// that talks to the database: the grading queue an instructor works through, the write that records
// a grade, the roll-up that turns rows into one percentage, and the freeze that turns a percentage
// into a final grade on a transcript.
//
// TWO RULES THIS FILE ENFORCES AND NOTHING ELSE DOES
//
// 1. POSTED IS NOT GRADED. A grade row exists the moment a grader saves it; the learner sees it
//    only when `posted` is true. Every learner-side read in this codebase filters on posted = true,
//    so an instructor can grade a whole section over three evenings and release it in one act.
//
// 2. THE LATE PENALTY IS APPLIED AT GRADE TIME FROM THE FROZEN SUBMISSION ROW, not from the clock.
//    lms_submissions.days_late was decided when the work landed (see assignments.ts). A grader
//    opening the submission a fortnight later applies the same penalty the learner was told about.

import { ensureLmsSchema, rows } from './schema';
import { uuidIn } from '@/lib/pg-array';
import {
  applyLatePolicy, courseGrade, letterFor, rubricTotal, pctOf, round2,
  DEFAULT_SCALE, type Band, type CategorySpec, type ScoreRow, type CourseGrade,
} from './policy';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ================================================================================================
// CATEGORIES AND SCALE
// ================================================================================================

export async function courseCategories(courseId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT id, name, weight, drop_lowest, position, section_id
      FROM lms_grade_categories WHERE course_id = ${courseId} ORDER BY position, name`));
  } catch (e: any) {
    console.error('[lms/gradebook] courseCategories:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function saveCategory(courseId: string, input: { id?: string | null; name: string; weight: number; dropLowest?: number; position?: number }): Promise<{ ok: boolean; error?: string }> {
  const name = String(input.name || '').trim();
  if (!name) return { ok: false, error: 'A category needs a name' };
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    if (input.id) {
      await db.execute(sql`UPDATE lms_grade_categories SET name = ${name}, weight = ${Number(input.weight) || 0},
        drop_lowest = ${Math.max(0, Math.round(Number(input.dropLowest) || 0))}, position = ${Math.round(Number(input.position) || 0)}
        WHERE id = ${input.id} AND course_id = ${courseId}`);
    } else {
      await db.execute(sql`INSERT INTO lms_grade_categories (course_id, name, weight, drop_lowest, position)
        VALUES (${courseId}, ${name}, ${Number(input.weight) || 0}, ${Math.max(0, Math.round(Number(input.dropLowest) || 0))},
          ${Math.round(Number(input.position) || 0)})`);
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[lms/gradebook] saveCategory:', e?.cause?.message || e?.message);
    return { ok: false, error: 'Could not save the category' };
  }
}

export async function deleteCategory(courseId: string, categoryId: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`DELETE FROM lms_grade_categories WHERE id = ${categoryId} AND course_id = ${courseId}`);
}

/** The course's letter scale, falling back to the platform default. A course that never set one is
 *  not a course with no scale — it is a course on the default. */
export async function courseScale(courseId: string): Promise<Band[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const r = rows(await db.execute(sql`SELECT bands FROM lms_grade_scales WHERE course_id = ${courseId} LIMIT 1`))[0] as any;
    const bands = r?.bands;
    if (Array.isArray(bands) && bands.length) return bands as Band[];
  } catch (e: any) {
    console.error('[lms/gradebook] courseScale:', e?.cause?.message || e?.message);
  }
  return DEFAULT_SCALE;
}

export async function saveScale(courseId: string, bands: Band[], byUserId: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO lms_grade_scales (course_id, bands, updated_by, updated_at)
    VALUES (${courseId}, ${JSON.stringify(bands)}::jsonb, ${byUserId}, NOW())
    ON CONFLICT (course_id) DO UPDATE SET bands = EXCLUDED.bands, updated_by = EXCLUDED.updated_by, updated_at = NOW()`);
}

// ================================================================================================
// RUBRICS
// ================================================================================================

export async function courseRubrics(courseId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT r.id, r.title, r.description,
        (SELECT COUNT(*)::int FROM lms_rubric_criteria c WHERE c.rubric_id = r.id) AS criteria_count,
        (SELECT COALESCE(SUM(c.points),0)::float FROM lms_rubric_criteria c WHERE c.rubric_id = r.id) AS total_points
      FROM lms_rubrics r WHERE r.course_id = ${courseId} OR r.course_id IS NULL ORDER BY r.created_at DESC`));
  } catch (e: any) {
    console.error('[lms/gradebook] courseRubrics:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function rubricCriteria(rubricId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT id, label, description, points, position
      FROM lms_rubric_criteria WHERE rubric_id = ${rubricId} ORDER BY position, label`));
  } catch {
    return [];
  }
}

/** Create a rubric and its criteria in one act. A rubric with no criteria cannot grade anything, so
 *  the two are never saved separately. */
export async function createRubric(courseId: string, title: string, criteria: Array<{ label: string; description?: string; points: number }>, byUserId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const clean = criteria.map((c) => ({ label: String(c.label || '').trim(), description: c.description || null, points: Number(c.points) || 0 }))
    .filter((c) => c.label);
  if (!String(title || '').trim()) return { ok: false, error: 'The rubric needs a title' };
  if (!clean.length) return { ok: false, error: 'Add at least one criterion' };
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const r = rows(await db.execute(sql`INSERT INTO lms_rubrics (course_id, title, created_by)
      VALUES (${courseId}, ${String(title).trim()}, ${byUserId}) RETURNING id`))[0] as any;
    let position = 0;
    for (const c of clean) {
      await db.execute(sql`INSERT INTO lms_rubric_criteria (rubric_id, label, description, points, position)
        VALUES (${r.id}, ${c.label}, ${c.description}, ${c.points}, ${position++})`);
    }
    return { ok: true, id: r.id };
  } catch (e: any) {
    console.error('[lms/gradebook] createRubric:', e?.cause?.message || e?.message);
    return { ok: false, error: 'Could not create the rubric' };
  }
}

// ================================================================================================
// THE GRADING QUEUE
// ================================================================================================

/** Everything waiting on a grader, across the courses this person teaches. Oldest first — a queue
 *  sorted newest-first is a queue where the earliest submission is never reached.
 *
 *  The course filter goes through uuidIn() from src/lib/pg-array.ts, never the array-equals-any
 *  form: postgres-js sends a JS array as a plain parameter rather than a typed uuid[], so that form
 *  throws on every call. src/lib/pg-array.test.ts scans the whole tree for it, and caught this one. */
export async function gradingQueue(courseIds: string[], opts: { assignmentId?: string | null; limit?: number } = {}): Promise<any[]> {
  if (!courseIds.length) return [];
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`
      SELECT s.id AS submission_id, s.assignment_id, s.user_id, s.attempt, s.body, s.links, s.link_url,
             s.word_count, s.submitted_at, s.is_late, s.days_late,
             a.title AS assignment_title, a.points, a.kind, a.rubric_id, a.course_id,
             a.late_penalty_pct_per_day, a.max_late_days, a.allow_late,
             c.title AS course_title, c.slug AS course_slug,
             u.name AS student_name, u.email AS student_email,
             g.id AS grade_id, g.points AS graded_points, g.posted
      FROM lms_submissions s
      JOIN lms_assignments a ON a.id = s.assignment_id
      JOIN training_courses c ON c.id = a.course_id
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN lms_grades g ON g.submission_id = s.id
      WHERE s.status = 'submitted'
        AND g.id IS NULL
        AND a.course_id IN ${uuidIn(courseIds)}
        ${opts.assignmentId ? sql`AND a.id = ${opts.assignmentId}` : sql``}
      ORDER BY s.submitted_at ASC NULLS LAST
      LIMIT ${Math.min(200, opts.limit || 60)}`));
  } catch (e: any) {
    console.error('[lms/gradebook] gradingQueue:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function submissionForGrading(submissionId: string): Promise<any | null> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`
      SELECT s.*, a.title AS assignment_title, a.points, a.rubric_id, a.course_id, a.kind,
             a.allow_late, a.late_penalty_pct_per_day, a.max_late_days,
             c.title AS course_title, u.name AS student_name, u.email AS student_email,
             g.id AS grade_id, g.raw_points, g.penalty_points, g.points AS grade_points, g.pct,
             g.feedback, g.rubric_scores, g.posted, g.excused
      FROM lms_submissions s
      JOIN lms_assignments a ON a.id = s.assignment_id
      JOIN training_courses c ON c.id = a.course_id
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN lms_grades g ON g.submission_id = s.id
      WHERE s.id = ${submissionId} LIMIT 1`))[0] || null;
  } catch (e: any) {
    console.error('[lms/gradebook] submissionForGrading:', e?.cause?.message || e?.message);
    return null;
  }
}

export interface GradeInput {
  submissionId: string;
  rawPoints?: number;
  rubricScores?: Record<string, number>;
  feedback?: string;
  excused?: boolean;
  post?: boolean;
  returnForRevision?: boolean;
}

/**
 * Record a grade.
 *
 * A rubric, when the assignment has one, is the source of the score: the criteria are totalled and
 * clamped (policy.rubricTotal) and rawPoints from the form is ignored. Two numbers on one screen
 * that can disagree is a bug waiting to be filed by a student.
 */
export async function saveGrade(input: GradeInput, byUserId: string): Promise<{ ok: boolean; error?: string; points?: number; pct?: number | null }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();

  const sub = await submissionForGrading(input.submissionId);
  if (!sub) return { ok: false, error: 'That submission no longer exists' };

  const total = Number(sub.points || 0);
  let raw = Number(input.rawPoints);
  let rubricScores: Record<string, number> = {};

  if (sub.rubric_id) {
    const criteria = await rubricCriteria(sub.rubric_id);
    const scores = input.rubricScores || {};
    const totalled = rubricTotal(criteria.map((c: any) => ({ id: c.id, label: c.label, points: Number(c.points) })), scores);
    raw = totalled.total;
    rubricScores = scores;
    // A rubric worth 40 grading an assignment worth 100 is a setup error, not a 40% for the learner.
    if (totalled.possible > 0 && Math.abs(totalled.possible - total) > 0.01) {
      raw = round2((totalled.total / totalled.possible) * total);
    }
  }

  if (!Number.isFinite(raw)) return { ok: false, error: 'Enter a score' };
  raw = Math.max(0, Math.min(total, raw));

  const penalty = applyLatePolicy(total, Number(sub.days_late || 0), {
    allowLate: !!sub.allow_late,
    penaltyPctPerDay: Number(sub.late_penalty_pct_per_day || 0),
    maxLateDays: Number(sub.max_late_days || 0),
  });
  const penaltyPoints = input.excused ? 0 : penalty.penaltyPoints;
  const final = Math.max(0, round2(raw - penaltyPoints));
  const pct = pctOf(final, total);

  try {
    await db.execute(sql`INSERT INTO lms_grades
      (submission_id, assignment_id, user_id, raw_points, penalty_points, points, pct, feedback,
       rubric_scores, excused, graded_by, graded_at, posted, posted_at)
      VALUES (${input.submissionId}, ${sub.assignment_id}, ${sub.user_id}, ${raw}, ${penaltyPoints}, ${final},
        ${pct}, ${input.feedback || null}, ${JSON.stringify(rubricScores)}::jsonb, ${!!input.excused},
        ${byUserId}, NOW(), ${!!input.post}, ${input.post ? new Date().toISOString() : null})
      ON CONFLICT (submission_id) DO UPDATE SET
        raw_points = EXCLUDED.raw_points, penalty_points = EXCLUDED.penalty_points,
        points = EXCLUDED.points, pct = EXCLUDED.pct, feedback = EXCLUDED.feedback,
        rubric_scores = EXCLUDED.rubric_scores, excused = EXCLUDED.excused,
        graded_by = EXCLUDED.graded_by, graded_at = NOW(),
        posted = EXCLUDED.posted, posted_at = CASE WHEN EXCLUDED.posted THEN NOW() ELSE lms_grades.posted_at END`);

    await db.execute(sql`UPDATE lms_submissions SET
      status = ${input.returnForRevision ? 'returned' : (input.post ? 'graded' : 'submitted')}, updated_at = NOW()
      WHERE id = ${input.submissionId}`);

    if (input.post) {
      try {
        const { recordStatement } = await import('./interop');
        await recordStatement({
          actorUserId: sub.user_id, verb: 'scored',
          objectId: 'assignment:' + sub.assignment_id, objectName: sub.assignment_title,
          courseId: sub.course_id, scoreScaled: pct != null ? pct / 100 : null,
          success: pct != null ? pct >= 60 : null, source: 'internal',
          raw: { submissionId: input.submissionId, points: final, of: total },
        });
      } catch (e: any) {
        console.error('[lms/gradebook] grade xapi:', e?.cause?.message || e?.message);
      }
      try {
        const { notifyGraded } = await import('./notify');
        await notifyGraded(sub.user_id, sub.assignment_title, sub.course_title, final, total);
      } catch (e: any) {
        console.error('[lms/gradebook] notifyGraded:', e?.cause?.message || e?.message);
      }
    }

    return { ok: true, points: final, pct };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/gradebook] saveGrade:', reason);
    return { ok: false, error: reason || 'Could not save the grade' };
  }
}

/** Release every unposted grade on an assignment at once. Returns how many were released. */
export async function postAllGrades(assignmentId: string): Promise<number> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const r = rows(await db.execute(sql`UPDATE lms_grades SET posted = true, posted_at = NOW()
      WHERE assignment_id = ${assignmentId} AND posted = false RETURNING id`));
    if (r.length) {
      await db.execute(sql`UPDATE lms_submissions SET status = 'graded'
        WHERE assignment_id = ${assignmentId} AND id IN (SELECT submission_id FROM lms_grades WHERE assignment_id = ${assignmentId} AND posted = true)`);
    }
    return r.length;
  } catch (e: any) {
    console.error('[lms/gradebook] postAllGrades:', e?.cause?.message || e?.message);
    return 0;
  }
}

// ================================================================================================
// ROLL-UP
// ================================================================================================

/** One learner's course grade, computed from posted grades only. `postedOnly: false` is what an
 *  instructor's own gradebook view uses, so they can see where a section is heading before release. */
export async function gradeForLearner(courseId: string, userId: string, opts: { postedOnly?: boolean } = {}): Promise<CourseGrade & { rows: any[] }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const postedOnly = opts.postedOnly !== false;
  let scoreRows: any[] = [];
  try {
    scoreRows = rows(await db.execute(sql`
      SELECT a.id AS assignment_id, a.title, a.points AS total, a.category_id,
             g.points, g.pct, g.excused, g.posted, g.graded_at
      FROM lms_assignments a
      LEFT JOIN lms_submissions s ON s.assignment_id = a.id AND s.user_id = ${userId}
      LEFT JOIN lms_grades g ON g.submission_id = s.id ${postedOnly ? sql`AND g.posted = true` : sql``}
      WHERE a.course_id = ${courseId} AND a.published = true
      ORDER BY a.due_at NULLS LAST, a.created_at`));
  } catch (e: any) {
    console.error('[lms/gradebook] gradeForLearner:', e?.cause?.message || e?.message);
  }

  const cats = await courseCategories(courseId);
  const specs: CategorySpec[] = cats.map((c: any) => ({
    id: c.id, name: c.name, weight: Number(c.weight || 0), dropLowest: Number(c.drop_lowest || 0),
  }));
  const scores: ScoreRow[] = scoreRows
    .filter((r: any) => r.points != null && !r.excused)
    .map((r: any) => ({ categoryId: r.category_id || null, points: Number(r.points), total: Number(r.total || 0) }));

  const scale = await courseScale(courseId);
  const grade = courseGrade(specs, scores, scale);
  return { ...grade, rows: scoreRows };
}

/** The whole section as a matrix: one row per student, one column per assignment. */
export async function gradebookMatrix(courseId: string, sectionId: string | null): Promise<{ assignments: any[]; students: any[] }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const q = async (statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch (e: any) {
      console.error('[lms/gradebook] gradebookMatrix:', e?.cause?.message || e?.message);
      return [];
    }
  };

  const assignments = await q(sql`SELECT id, title, points, category_id, due_at FROM lms_assignments
    WHERE course_id = ${courseId} AND published = true
      ${sectionId ? sql`AND (section_id = ${sectionId} OR section_id IS NULL)` : sql``}
    ORDER BY due_at NULLS LAST, created_at`);

  const roster = sectionId
    ? await q(sql`SELECT m.user_id, u.name, u.email FROM lms_section_members m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.section_id = ${sectionId} AND m.role = 'student' AND m.status = 'active' ORDER BY u.name`)
    : await q(sql`SELECT te.user_id, u.name, u.email FROM training_enrollments te
        LEFT JOIN users u ON u.id = te.user_id WHERE te.course_id = ${courseId} ORDER BY u.name LIMIT 500`);

  const grades = await q(sql`SELECT g.user_id, g.assignment_id, g.points, g.pct, g.posted, g.excused
    FROM lms_grades g JOIN lms_assignments a ON a.id = g.assignment_id WHERE a.course_id = ${courseId}`);

  const cats = await courseCategories(courseId);
  const specs: CategorySpec[] = cats.map((c: any) => ({
    id: c.id, name: c.name, weight: Number(c.weight || 0), dropLowest: Number(c.drop_lowest || 0),
  }));
  const scale = await courseScale(courseId);

  const students = roster.map((s: any) => {
    const mine = grades.filter((g: any) => g.user_id === s.user_id);
    const cells = assignments.map((a: any) => {
      const hit = mine.find((g: any) => g.assignment_id === a.id);
      return {
        assignmentId: a.id,
        points: hit ? Number(hit.points) : null,
        pct: hit && hit.pct != null ? Number(hit.pct) : null,
        posted: hit ? !!hit.posted : false,
        excused: hit ? !!hit.excused : false,
      };
    });
    const scores: ScoreRow[] = cells
      .filter((c) => c.points != null && !c.excused)
      .map((c) => {
        const a = assignments.find((x: any) => x.id === c.assignmentId);
        return { categoryId: a?.category_id || null, points: c.points as number, total: Number(a?.points || 0) };
      });
    const total = courseGrade(specs, scores, scale);
    return { userId: s.user_id, name: s.name || '(no name)', email: s.email, cells, total };
  });

  return { assignments, students };
}

// ================================================================================================
// FINAL GRADES
// ================================================================================================

/** Freeze the computed grade as a final grade. This is a registrar act: after it, the transcript
 *  reads THIS row and never recomputes, so a later edit to an assignment cannot silently rewrite a
 *  grade somebody has already been told. */
export async function postFinalGrade(courseId: string, sectionId: string | null, userId: string, byUserId: string, override?: { pct?: number | null; letter?: string; note?: string }): Promise<{ ok: boolean; error?: string }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const computed = await gradeForLearner(courseId, userId, { postedOnly: true });
    const scale = await courseScale(courseId);
    const pct = override?.pct != null ? Number(override.pct) : computed.pct;
    const band = pct != null ? letterFor(pct, scale) : null;
    const letter = override?.letter || (band ? band.letter : null);
    const points = band ? band.points : 0;

    const credit = Number(rows(await db.execute(sql`SELECT COALESCE(credit_hours, 0) AS credit_hours FROM training_courses WHERE id = ${courseId} LIMIT 1`))[0]?.credit_hours || 0);

    await db.execute(sql`INSERT INTO lms_final_grades
      (course_id, section_id, user_id, pct, letter, grade_points, credit_hours, note, posted_by, posted_at)
      VALUES (${courseId}, ${sectionId}, ${userId}, ${pct}, ${letter}, ${points}, ${credit}, ${override?.note || null}, ${byUserId}, NOW())
      ON CONFLICT (course_id, user_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET pct = EXCLUDED.pct, letter = EXCLUDED.letter, grade_points = EXCLUDED.grade_points,
        credit_hours = EXCLUDED.credit_hours, note = EXCLUDED.note, posted_by = EXCLUDED.posted_by, posted_at = NOW()`);
    return { ok: true };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/gradebook] postFinalGrade:', reason);
    return { ok: false, error: reason || 'Could not post the final grade' };
  }
}

export { round2 };
