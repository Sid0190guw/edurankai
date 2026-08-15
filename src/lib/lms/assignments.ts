// src/lib/lms/assignments.ts — ASSIGNMENTS AND SUBMISSIONS (L1).
//
// The piece the AquinTutor LMS did not have. /aquintutor/assignments and /aquintutor/homework were
// hand-written arrays of fictional coursework — a kanban board of courses that do not exist, owed
// by nobody, due never. Everything on those screens now comes from here.
//
// WHAT A SUBMISSION IS ALLOWED TO BE
//
// A link, or typed text, or both. NOT AN UPLOAD. This is the project's standing rule and it is
// enforced in normaliseLinks() rather than left to the form: work lives in the learner's own drive
// with open link access, and this platform stores the URL. There is no file column to write to.
//
// LATENESS IS DECIDED HERE, ONCE, AT SUBMIT TIME, AND FROZEN ON THE ROW.
// It is not recomputed on read. A learner who submitted two hours before the deadline must not
// become late because an instructor extended and then un-extended the due date, and a grader
// looking at a submission three weeks later must see the lateness that was true when it landed.

import { ensureLmsSchema, rows } from './schema';
import { textArray } from '@/lib/pg-array';
import {
  lateness, applyLatePolicy, submissionState, acceptingSubmissions, pctOf,
  type SubmissionState,
} from './policy';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

export interface AssignmentInput {
  id?: string | null;
  courseId: string;
  sectionId?: string | null;
  categoryId?: string | null;
  rubricId?: string | null;
  title: string;
  instructions?: string | null;
  kind?: string;
  points?: number;
  dueAt?: string | null;
  availableFrom?: string | null;
  closesAt?: string | null;
  allowLate?: boolean;
  latePenaltyPctPerDay?: number;
  maxLateDays?: number;
  maxAttempts?: number;
  submissionKinds?: string[];
  minWords?: number | null;
  peerReviewCount?: number;
  linkedAssessmentId?: string | null;
  linkedLessonId?: string | null;
  published?: boolean;
}

// ================================================================================================
// AUTHORING
// ================================================================================================

/** Create or update an assignment. Returns its id. The caller has already established a teach claim
 *  (src/lib/lms/access.ts); this function does not re-authorise, it validates. */
export async function saveAssignment(input: AssignmentInput, byUserId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const title = String(input.title || '').trim();
  if (!title) return { ok: false, error: 'A title is required' };
  if (!input.courseId) return { ok: false, error: 'A course is required' };

  const points = Number.isFinite(Number(input.points)) ? Math.max(0, Number(input.points)) : 100;
  const kinds = (input.submissionKinds && input.submissionKinds.length ? input.submissionKinds : ['link', 'text'])
    .filter((k) => k === 'link' || k === 'text');
  if (!kinds.length) return { ok: false, error: 'Choose at least one way to submit' };

  const due = nullableTimestamp(input.dueAt);
  const from = nullableTimestamp(input.availableFrom);
  const closes = nullableTimestamp(input.closesAt);
  if (due && from && new Date(due) < new Date(from)) return { ok: false, error: 'The due date is before the assignment opens' };
  if (closes && due && new Date(closes) < new Date(due)) return { ok: false, error: 'The hard close is before the due date' };

  await ensureLmsSchema();
  const { db, sql } = await ctx();

  try {
    if (input.id) {
      await db.execute(sql`UPDATE lms_assignments SET
        section_id = ${input.sectionId || null},
        category_id = ${input.categoryId || null},
        rubric_id = ${input.rubricId || null},
        title = ${title},
        instructions = ${input.instructions || null},
        kind = ${input.kind || 'essay'},
        points = ${points},
        due_at = ${due},
        available_from = ${from},
        closes_at = ${closes},
        allow_late = ${input.allowLate !== false},
        late_penalty_pct_per_day = ${clampNum(input.latePenaltyPctPerDay, 10, 0, 100)},
        max_late_days = ${Math.round(clampNum(input.maxLateDays, 5, 0, 365))},
        max_attempts = ${Math.round(clampNum(input.maxAttempts, 1, 1, 20))},
        submission_kinds = ${textArray(kinds)},
        min_words = ${input.minWords != null && Number(input.minWords) > 0 ? Math.round(Number(input.minWords)) : null},
        peer_review_count = ${Math.round(clampNum(input.peerReviewCount, 0, 0, 10))},
        linked_assessment_id = ${input.linkedAssessmentId || null},
        linked_lesson_id = ${input.linkedLessonId || null},
        published = ${!!input.published},
        updated_at = NOW()
        WHERE id = ${input.id}`);
      return { ok: true, id: input.id };
    }

    const r = rows(await db.execute(sql`INSERT INTO lms_assignments
      (course_id, section_id, category_id, rubric_id, title, instructions, kind, points, due_at,
       available_from, closes_at, allow_late, late_penalty_pct_per_day, max_late_days, max_attempts,
       submission_kinds, min_words, peer_review_count, linked_assessment_id, linked_lesson_id, published, created_by)
      VALUES (${input.courseId}, ${input.sectionId || null}, ${input.categoryId || null}, ${input.rubricId || null},
        ${title}, ${input.instructions || null}, ${input.kind || 'essay'}, ${points}, ${due},
        ${from}, ${closes}, ${input.allowLate !== false}, ${clampNum(input.latePenaltyPctPerDay, 10, 0, 100)},
        ${Math.round(clampNum(input.maxLateDays, 5, 0, 365))}, ${Math.round(clampNum(input.maxAttempts, 1, 1, 20))},
        ${textArray(kinds)}, ${input.minWords != null && Number(input.minWords) > 0 ? Math.round(Number(input.minWords)) : null},
        ${Math.round(clampNum(input.peerReviewCount, 0, 0, 10))}, ${input.linkedAssessmentId || null},
        ${input.linkedLessonId || null}, ${!!input.published}, ${byUserId})
      RETURNING id`))[0] as any;
    return { ok: true, id: r?.id };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/assignments] saveAssignment:', reason);
    return { ok: false, error: reason || 'Could not save the assignment' };
  }
}

export async function setPublished(assignmentId: string, published: boolean): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE lms_assignments SET published = ${published}, updated_at = NOW() WHERE id = ${assignmentId}`);
}

/** Delete an assignment. Submissions and grades cascade, so this refuses once anything is graded —
 *  a deleted grade is not recoverable and no instructor means to do that with one click. */
export async function deleteAssignment(assignmentId: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const graded = Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM lms_grades WHERE assignment_id = ${assignmentId}`))[0]?.c || 0);
    if (graded > 0) return { ok: false, error: 'This assignment has ' + graded + ' graded submission(s). Unpublish it instead of deleting it.' };
    await db.execute(sql`DELETE FROM lms_assignments WHERE id = ${assignmentId}`);
    return { ok: true };
  } catch (e: any) {
    console.error('[lms/assignments] deleteAssignment:', e?.cause?.message || e?.message);
    return { ok: false, error: 'Could not delete the assignment' };
  }
}

export async function getAssignment(assignmentId: string): Promise<any | null> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT a.*, c.title AS course_title, c.slug AS course_slug,
        s.code AS section_code, cat.name AS category_name
      FROM lms_assignments a
      JOIN training_courses c ON c.id = a.course_id
      LEFT JOIN lms_sections s ON s.id = a.section_id
      LEFT JOIN lms_grade_categories cat ON cat.id = a.category_id
      WHERE a.id = ${assignmentId} LIMIT 1`))[0] || null;
  } catch (e: any) {
    console.error('[lms/assignments] getAssignment:', e?.cause?.message || e?.message);
    return null;
  }
}

/** Every assignment on a course, for the instructor list, with submission counts. */
export async function courseAssignments(courseId: string, opts: { includeUnpublished?: boolean } = {}): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT a.*, s.code AS section_code, cat.name AS category_name,
        (SELECT COUNT(*)::int FROM lms_submissions sub WHERE sub.assignment_id = a.id AND sub.status <> 'draft') AS submitted_count,
        (SELECT COUNT(*)::int FROM lms_submissions sub
           LEFT JOIN lms_grades g ON g.submission_id = sub.id
           WHERE sub.assignment_id = a.id AND sub.status = 'submitted' AND g.id IS NULL) AS ungraded_count
      FROM lms_assignments a
      LEFT JOIN lms_sections s ON s.id = a.section_id
      LEFT JOIN lms_grade_categories cat ON cat.id = a.category_id
      WHERE a.course_id = ${courseId} ${opts.includeUnpublished ? sql`` : sql`AND a.published = true`}
      ORDER BY a.due_at NULLS LAST, a.created_at DESC`));
  } catch (e: any) {
    console.error('[lms/assignments] courseAssignments:', e?.cause?.message || e?.message);
    return [];
  }
}

// ================================================================================================
// THE LEARNER'S BOARD
// ================================================================================================

export interface BoardItem {
  id: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  title: string;
  kind: string;
  points: number;
  dueAt: string | null;
  availableFrom: string | null;
  closesAt: string | null;
  allowLate: boolean;
  maxLateDays: number;
  maxAttempts: number;
  attempt: number;
  submissionId: string | null;
  submissionStatus: string | null;
  submittedAt: string | null;
  isLate: boolean;
  gradePoints: number | null;
  gradePct: number | null;
  gradePosted: boolean;
  excused: boolean;
  state: SubmissionState;
}

/**
 * Every assignment this learner owes, across every course they are enrolled in.
 *
 * THE JOIN THAT MATTERS: an assignment scoped to a section belongs to the students of THAT section
 * only. A course-wide assignment (section_id NULL) belongs to everybody enrolled. Getting this
 * wrong shows a learner somebody else's coursework, which is the fastest way to lose a cohort.
 *
 * Grades are read only when posted. An unposted grade is a grader's working note.
 */
export async function learnerBoard(userId: string, now: Date = new Date()): Promise<BoardItem[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  let raw: any[] = [];
  try {
    raw = rows(await db.execute(sql`
      SELECT a.id, a.course_id, a.title, a.kind, a.points, a.due_at, a.available_from, a.closes_at,
             a.allow_late, a.max_late_days, a.max_attempts,
             c.title AS course_title, c.slug AS course_slug,
             sub.id AS submission_id, sub.status AS submission_status, sub.submitted_at,
             sub.is_late, sub.attempt,
             g.points AS grade_points, g.pct AS grade_pct, g.posted AS grade_posted, g.excused
      FROM lms_assignments a
      JOIN training_courses c ON c.id = a.course_id
      LEFT JOIN LATERAL (
        SELECT * FROM lms_submissions s2
        WHERE s2.assignment_id = a.id AND s2.user_id = ${userId}
        ORDER BY s2.attempt DESC LIMIT 1
      ) sub ON true
      LEFT JOIN lms_grades g ON g.submission_id = sub.id AND g.posted = true
      WHERE a.published = true
        AND (
          a.section_id IS NULL
            AND (
              EXISTS (SELECT 1 FROM training_enrollments te WHERE te.course_id = a.course_id AND te.user_id = ${userId})
              OR EXISTS (SELECT 1 FROM lms_section_members m JOIN lms_sections s ON s.id = m.section_id
                         WHERE s.course_id = a.course_id AND m.user_id = ${userId} AND m.role = 'student' AND m.status = 'active')
            )
          OR a.section_id IN (
              SELECT m.section_id FROM lms_section_members m
              WHERE m.user_id = ${userId} AND m.role = 'student' AND m.status = 'active')
        )
      ORDER BY a.due_at NULLS LAST, a.created_at DESC
      LIMIT 400`));
  } catch (e: any) {
    console.error('[lms/assignments] learnerBoard:', e?.cause?.message || e?.message);
    throw e;   // the caller decides how to say "we could not read your coursework"
  }

  return raw.map((r: any) => {
    const state = submissionState({
      availableFrom: r.available_from,
      dueAt: r.due_at,
      closesAt: r.closes_at,
      allowLate: r.allow_late,
      maxLateDays: Number(r.max_late_days || 0),
      submissionStatus: r.submission_status || null,
      graded: r.grade_points != null && !!r.grade_posted,
    }, now);
    return {
      id: r.id,
      courseId: r.course_id,
      courseTitle: r.course_title || 'Course',
      courseSlug: r.course_slug || '',
      title: r.title,
      kind: r.kind,
      points: Number(r.points || 0),
      dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
      availableFrom: r.available_from ? new Date(r.available_from).toISOString() : null,
      closesAt: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      allowLate: !!r.allow_late,
      maxLateDays: Number(r.max_late_days || 0),
      maxAttempts: Number(r.max_attempts || 1),
      attempt: Number(r.attempt || 0),
      submissionId: r.submission_id || null,
      submissionStatus: r.submission_status || null,
      submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
      isLate: !!r.is_late,
      gradePoints: r.grade_points != null ? Number(r.grade_points) : null,
      gradePct: r.grade_pct != null ? Number(r.grade_pct) : null,
      gradePosted: !!r.grade_posted,
      excused: !!r.excused,
      state,
    };
  });
}

/** One assignment as this learner sees it: the brief, their latest attempt, their posted grade, and
 *  whether they may still write. Returns null when the assignment is not theirs to see. */
export async function learnerAssignment(userId: string, assignmentId: string, now: Date = new Date()): Promise<any | null> {
  const board = await learnerBoard(userId, now);
  const item = board.find((b) => b.id === assignmentId);
  if (!item) return null;

  const { db, sql } = await ctx();
  const q = async (statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch (e: any) {
      console.error('[lms/assignments] learnerAssignment:', e?.cause?.message || e?.message);
      return [];
    }
  };

  const detail = (await q(sql`SELECT a.*, c.slug AS course_slug, c.title AS course_title
    FROM lms_assignments a JOIN training_courses c ON c.id = a.course_id WHERE a.id = ${assignmentId} LIMIT 1`))[0];
  if (!detail) return null;

  const attempts = await q(sql`SELECT s.*, g.points AS grade_points, g.pct AS grade_pct, g.feedback,
      g.rubric_scores, g.penalty_points, g.posted AS grade_posted, g.excused, g.graded_at
    FROM lms_submissions s
    LEFT JOIN lms_grades g ON g.submission_id = s.id AND g.posted = true
    WHERE s.assignment_id = ${assignmentId} AND s.user_id = ${userId}
    ORDER BY s.attempt DESC`);

  const rubric = detail.rubric_id
    ? await q(sql`SELECT id, label, description, points, position FROM lms_rubric_criteria WHERE rubric_id = ${detail.rubric_id} ORDER BY position, label`)
    : [];

  const window = acceptingSubmissions({
    availableFrom: detail.available_from,
    dueAt: detail.due_at,
    closesAt: detail.closes_at,
    allowLate: detail.allow_late,
    maxLateDays: Number(detail.max_late_days || 0),
  }, now);

  const used = attempts.filter((a: any) => a.status !== 'draft').length;
  const attemptsLeft = Math.max(0, Number(detail.max_attempts || 1) - used);
  const preview = window.willBeLate
    ? applyLatePolicy(Number(detail.points || 0), window.daysLate, {
        allowLate: detail.allow_late,
        penaltyPctPerDay: Number(detail.late_penalty_pct_per_day || 0),
        maxLateDays: Number(detail.max_late_days || 0),
      })
    : null;

  return { item, detail, attempts, rubric, window, attemptsLeft, latePreview: preview };
}

// ================================================================================================
// WRITING A SUBMISSION
// ================================================================================================

export interface SubmitInput {
  assignmentId: string;
  body?: string;
  links?: string[];
  asDraft?: boolean;
}

/** Turn whatever the form sent into a clean list of http(s) URLs. Rejects anything else outright:
 *  a `javascript:` "link" rendered into an instructor's grading screen is a stored XSS, and a
 *  relative path is a learner who pasted a local file path that nobody will ever be able to open. */
export function normaliseLinks(input: unknown): { links: string[]; rejected: string[] } {
  const list = Array.isArray(input) ? input : (typeof input === 'string' ? String(input).split(/[\s,]+/) : []);
  const links: string[] = [];
  const rejected: string[] = [];
  for (const entry of list) {
    const value = String(entry || '').trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') { rejected.push(value); continue; }
      if (!links.includes(url.toString())) links.push(url.toString());
    } catch {
      rejected.push(value);
    }
  }
  return { links: links.slice(0, 10), rejected };
}

export function countWords(text: string): number {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Save a draft or submit an attempt.
 *
 * The window check, the attempt cap and the late stamp all happen HERE, on the server, against the
 * assignment row as it is right now — not against whatever the form was rendered with, which may be
 * an hour old and may have been edited by hand.
 */
export async function submitAssignment(userId: string, input: SubmitInput, now: Date = new Date()): Promise<{ ok: boolean; error?: string; submissionId?: string; late?: boolean; daysLate?: number }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();

  const view = await learnerAssignment(userId, input.assignmentId, now);
  if (!view) return { ok: false, error: 'That assignment is not on your coursework' };
  const a = view.detail;

  const { links, rejected } = normaliseLinks(input.links);
  const body = String(input.body || '').trim();
  const kinds: string[] = Array.isArray(a.submission_kinds) ? a.submission_kinds : ['link', 'text'];

  if (rejected.length) return { ok: false, error: 'These are not web links: ' + rejected.slice(0, 3).join(', ') };
  if (!kinds.includes('link') && links.length) return { ok: false, error: 'This assignment does not take links' };
  if (!kinds.includes('text') && body) return { ok: false, error: 'This assignment does not take typed text' };

  const asDraft = !!input.asDraft;
  if (!asDraft) {
    if (!links.length && !body) return { ok: false, error: 'Add a link or write something before you submit' };
    if (a.min_words && countWords(body) < Number(a.min_words)) {
      return { ok: false, error: 'This assignment asks for at least ' + a.min_words + ' words; you have written ' + countWords(body) };
    }
    if (!view.window.open) return { ok: false, error: 'This assignment is not accepting submissions: ' + view.window.reason };
    if (view.attemptsLeft <= 0) return { ok: false, error: 'You have used all ' + a.max_attempts + ' attempt(s) on this assignment' };
  }

  const late = lateness(a.due_at, now);
  const draftRow = view.attempts.find((s: any) => s.status === 'draft');
  const nextAttempt = draftRow ? Number(draftRow.attempt) : (view.attempts.length ? Number(view.attempts[0].attempt) + 1 : 1);

  try {
    if (draftRow) {
      const r = rows(await db.execute(sql`UPDATE lms_submissions SET
        body = ${body || null}, links = ${JSON.stringify(links)}::jsonb, link_url = ${links[0] || null},
        word_count = ${countWords(body)},
        status = ${asDraft ? 'draft' : 'submitted'},
        submitted_at = ${asDraft ? null : now.toISOString()},
        is_late = ${asDraft ? false : late.isLate},
        days_late = ${asDraft ? 0 : late.daysLate},
        updated_at = NOW()
        WHERE id = ${draftRow.id} RETURNING id`))[0] as any;
      await recordXapi(userId, a, asDraft, now);
      return { ok: true, submissionId: r?.id || draftRow.id, late: !asDraft && late.isLate, daysLate: late.daysLate };
    }

    const r = rows(await db.execute(sql`INSERT INTO lms_submissions
      (assignment_id, user_id, attempt, body, links, link_url, word_count, status, submitted_at, is_late, days_late)
      VALUES (${input.assignmentId}, ${userId}, ${nextAttempt}, ${body || null}, ${JSON.stringify(links)}::jsonb,
        ${links[0] || null}, ${countWords(body)}, ${asDraft ? 'draft' : 'submitted'},
        ${asDraft ? null : now.toISOString()}, ${asDraft ? false : late.isLate}, ${asDraft ? 0 : late.daysLate})
      RETURNING id`))[0] as any;
    await recordXapi(userId, a, asDraft, now);
    return { ok: true, submissionId: r?.id, late: !asDraft && late.isLate, daysLate: late.daysLate };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/assignments] submitAssignment:', reason);
    return { ok: false, error: 'Your work was not saved. ' + (reason || '') };
  }
}

/** A submission is an xAPI-shaped learning event, and recording it here is what makes the L6
 *  statement store real rather than a table nothing writes to. Never fails the submission. */
async function recordXapi(userId: string, assignment: any, asDraft: boolean, now: Date): Promise<void> {
  if (asDraft) return;
  try {
    const { recordStatement } = await import('./interop');
    await recordStatement({
      actorUserId: userId,
      verb: 'submitted',
      objectId: 'assignment:' + assignment.id,
      objectName: assignment.title,
      courseId: assignment.course_id,
      completion: true,
      source: 'internal',
      raw: { assignmentId: assignment.id, at: now.toISOString() },
    });
  } catch (e: any) {
    console.error('[lms/assignments] recordXapi:', e?.cause?.message || e?.message);
  }
}

// ================================================================================================
// SHARED
// ================================================================================================

function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function nullableTimestamp(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export { pctOf };
