// src/lib/lms/transcript.ts — THE ACADEMIC RECORD, ASSEMBLED FROM WHAT IS ACTUALLY TRUE (L5).
//
// /aquintutor/transcript existed and read from nothing: a page of invented courses and an invented
// grade point average, on a screen whose entire purpose is to be believed. This file is what it
// reads now.
//
// THREE SOURCES, IN A DELIBERATE ORDER OF AUTHORITY
//
//   1. lms_final_grades  — a posted final grade. FROZEN. It is never recomputed here, because a
//                          transcript that changes after it was issued is not a transcript.
//   2. the live roll-up  — for a course in progress, the grade so far, clearly marked in progress
//                          and EXCLUDED from the grade point average. An in-progress course does
//                          not have a grade; saying it does is the lie this screen used to tell.
//   3. credentials       — course_certificates and edu_credentials, which this platform issues and
//                          which are verifiable independently of any of the above.
//
// WHAT THIS FILE WILL NOT DO: call itself a degree audit, or a university record. EduRankAI is the
// technology platform; accredited partners award credentials. The transcript says what this
// platform recorded, which is a different and smaller claim, and the page says so.

import { ensureLmsSchema, rows } from './schema';
import { gpa, type TranscriptRow } from './policy';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

export interface TranscriptEntry {
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  termCode: string | null;
  termTitle: string | null;
  sectionCode: string | null;
  creditHours: number;
  pct: number | null;
  letter: string | null;
  gradePoints: number | null;
  status: 'final' | 'in_progress';
  postedAt: string | null;
}

export interface Transcript {
  entries: TranscriptEntry[];
  byTerm: Array<{ termCode: string; termTitle: string; entries: TranscriptEntry[]; termGpa: number | null; credits: number }>;
  cumulativeGpa: number | null;
  creditsEarned: number;
  creditsInProgress: number;
  credentials: any[];
  assessments: any[];
  readFailures: string[];
}

/** The whole record for one person. Every read is individually guarded and every failure is
 *  RECORDED — a transcript that quietly loses a term because one query failed is worse than one
 *  that says a term could not be read. */
export async function transcriptFor(userId: string): Promise<Transcript> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const readFailures: string[] = [];
  const q = async (label: string, statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch (e: any) {
      console.error('[lms/transcript] ' + label + ':', e?.cause?.message || e?.message);
      readFailures.push(label);
      return [];
    }
  };

  // ---------------------------------------------------------------- 1. posted final grades
  const finals = await q('your posted grades', sql`
    SELECT f.course_id, f.pct, f.letter, f.grade_points, f.credit_hours, f.posted_at,
           c.title AS course_title, c.slug AS course_slug,
           s.code AS section_code, t.code AS term_code, t.title AS term_title
    FROM lms_final_grades f
    JOIN training_courses c ON c.id = f.course_id
    LEFT JOIN lms_sections s ON s.id = f.section_id
    LEFT JOIN lms_terms t ON t.id = s.term_id
    WHERE f.user_id = ${userId}
    ORDER BY t.starts_on DESC NULLS LAST, f.posted_at DESC`);

  const entries: TranscriptEntry[] = finals.map((r: any) => ({
    courseId: r.course_id,
    courseTitle: r.course_title,
    courseSlug: r.course_slug,
    termCode: r.term_code || null,
    termTitle: r.term_title || null,
    sectionCode: r.section_code || null,
    creditHours: Number(r.credit_hours || 0),
    pct: r.pct != null ? Number(r.pct) : null,
    letter: r.letter || null,
    gradePoints: r.grade_points != null ? Number(r.grade_points) : null,
    status: 'final',
    postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
  }));

  // ---------------------------------------------------------------- 2. courses still running
  const finalised = new Set(entries.map((e) => e.courseId));
  const active = await q('your courses in progress', sql`
    SELECT te.course_id, c.title AS course_title, c.slug AS course_slug, COALESCE(c.credit_hours, 0) AS credit_hours
    FROM training_enrollments te JOIN training_courses c ON c.id = te.course_id
    WHERE te.user_id = ${userId} LIMIT 100`);

  for (const row of active) {
    if (finalised.has(row.course_id)) continue;
    let pct: number | null = null;
    let letter: string | null = null;
    try {
      const { gradeForLearner } = await import('./gradebook');
      const live = await gradeForLearner(row.course_id, userId, { postedOnly: true });
      pct = live.pct;
      letter = live.pct != null ? live.letter : null;
    } catch (e: any) {
      console.error('[lms/transcript] live grade:', e?.cause?.message || e?.message);
    }
    entries.push({
      courseId: row.course_id,
      courseTitle: row.course_title,
      courseSlug: row.course_slug,
      termCode: null, termTitle: null, sectionCode: null,
      creditHours: Number(row.credit_hours || 0),
      pct, letter,
      gradePoints: null,          // in progress: no grade points, and therefore no GPA effect
      status: 'in_progress',
      postedAt: null,
    });
  }

  // ---------------------------------------------------------------- 3. credentials and results
  const credentials = await q('your certificates', sql`
    SELECT cert_number AS code, course_title, issued_at, block_hash FROM course_certificates
    WHERE user_id = ${userId} ORDER BY issued_at DESC LIMIT 50`);
  const kernelCreds = await q('your credentials', sql`
    SELECT code, course_title, issued_at, revoked FROM edu_credentials
    WHERE user_id = ${userId} ORDER BY issued_at DESC LIMIT 50`);
  const assessments = await q('your assessment results', sql`
    SELECT assessment_id, pct, passed, graded_at FROM edu_attempts
    WHERE user_id = ${userId} AND mode = 'official' ORDER BY graded_at DESC NULLS LAST LIMIT 50`);

  // ---------------------------------------------------------------- roll-ups
  const gpaRows: TranscriptRow[] = entries
    .filter((e) => e.status === 'final' && e.gradePoints != null)
    .map((e) => ({ creditHours: e.creditHours, points: e.gradePoints as number }));
  const cumulativeGpa = gpa(gpaRows);

  const termKeys: string[] = [];
  for (const e of entries.filter((x) => x.status === 'final')) {
    const key = e.termCode || 'UNDATED';
    if (!termKeys.includes(key)) termKeys.push(key);
  }
  const byTerm = termKeys.map((key) => {
    const group = entries.filter((e) => e.status === 'final' && (e.termCode || 'UNDATED') === key);
    return {
      termCode: key,
      termTitle: group[0]?.termTitle || (key === 'UNDATED' ? 'No term recorded' : key),
      entries: group,
      termGpa: gpa(group.filter((e) => e.gradePoints != null).map((e) => ({ creditHours: e.creditHours, points: e.gradePoints as number }))),
      credits: group.reduce((s, e) => s + e.creditHours, 0),
    };
  });

  return {
    entries,
    byTerm,
    cumulativeGpa,
    creditsEarned: entries.filter((e) => e.status === 'final' && (e.gradePoints || 0) > 0).reduce((s, e) => s + e.creditHours, 0),
    creditsInProgress: entries.filter((e) => e.status === 'in_progress').reduce((s, e) => s + e.creditHours, 0),
    credentials: [...credentials, ...kernelCreds.filter((k: any) => !k.revoked)],
    assessments,
    readFailures,
  };
}
