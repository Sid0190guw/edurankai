// src/lib/lms/access.ts — WHO MAY TEACH, GRADE, OR READ THIS COURSE. SERVER SIDE, EVERY TIME.
//
// There is exactly one rule that matters in a gradebook and it is this: a person may read a grade
// if it is their own, or if they teach the course it belongs to. Everything below is that rule,
// spelled out, with the sources of "teaches" enumerated rather than guessed.
//
// The teaching claim can come from four places, all of which already exist in this database:
//   1. lms_course_staff        — the LMS spine's own course-level staff list
//   2. lms_section_members     — instructor or ta on a section OF this course
//   3. training_course_authors — the authoring system's per-course author/editor list
//   4. an RBAC role            — faculty, dean, registrar, reviewer_examiner, admin, super_admin
//
// A platform admin is not special-cased into grading by accident: `admin` and `super_admin` are
// listed explicitly below, because a registrar has to be able to fix a grade and the alternative is
// nobody being able to.
//
// NOTHING HERE IS A CLIENT-SIDE CHECK. Every page and every API route calls one of these functions
// before it reads a row, and the functions take the user object the server resolved from the
// session, never an id from a request body.

import { ensureLmsSchema, rows } from './schema';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

/** Platform roles that carry a teaching or registrar claim over every course. */
export const STAFF_ROLES = ['admin', 'super_admin', 'superadmin'] as const;
/** RBAC roster roles that carry a teaching claim over every course they are attached to. */
export const TEACHING_RBAC_ROLES = ['faculty', 'dean', 'registrar', 'reviewer_examiner', 'moderator'] as const;

export interface LmsActor {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface TeachClaim {
  canTeach: boolean;      // may create and edit assignments, post announcements
  canGrade: boolean;      // may grade submissions and post grades
  canAdminister: boolean; // may create sections, post final grades, import rosters
  via: string;            // the source of the claim, for the audit line and the UI
}

const NONE: TeachClaim = { canTeach: false, canGrade: false, canAdminister: false, via: 'none' };

function isPlatformStaff(user: LmsActor | null | undefined): boolean {
  if (!user?.role) return false;
  return (STAFF_ROLES as readonly string[]).includes(String(user.role));
}

/** Every RBAC roster role this user holds. Empty on any failure — a read that cannot be made is not
 *  a grant, and the caller falls through to the per-course checks. */
async function rbacRoles(userId: string): Promise<string[]> {
  try {
    const { db, sql } = await ctx();
    return rows(await db.execute(sql`SELECT role_key FROM rbac_user_roles WHERE user_id = ${userId}`))
      .map((r: any) => String(r.role_key));
  } catch {
    return [];
  }
}

/** What this person may do on this course. One query per source, all failures treated as "no claim"
 *  rather than as an error, because a missing optional table must not lock a dean out of grading. */
export async function teachClaim(user: LmsActor | null | undefined, courseId: string): Promise<TeachClaim> {
  if (!user?.id || !courseId) return NONE;

  if (isPlatformStaff(user)) {
    return { canTeach: true, canGrade: true, canAdminister: true, via: 'platform administrator' };
  }

  const roles = await rbacRoles(user.id);
  if (roles.includes('dean') || roles.includes('registrar')) {
    return { canTeach: true, canGrade: true, canAdminister: true, via: roles.includes('dean') ? 'dean' : 'registrar' };
  }

  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const q = async (statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch { return []; }
  };

  const staff = await q(sql`SELECT role FROM lms_course_staff WHERE course_id = ${courseId} AND user_id = ${user.id} LIMIT 1`);
  if (staff.length) {
    const role = String(staff[0].role || 'instructor');
    return { canTeach: true, canGrade: true, canAdminister: role === 'instructor', via: 'course ' + role };
  }

  const section = await q(sql`SELECT m.role FROM lms_section_members m
    JOIN lms_sections s ON s.id = m.section_id
    WHERE s.course_id = ${courseId} AND m.user_id = ${user.id} AND m.role IN ('instructor','ta') AND m.status = 'active' LIMIT 1`);
  if (section.length) {
    const role = String(section[0].role);
    return { canTeach: true, canGrade: true, canAdminister: role === 'instructor', via: 'section ' + role };
  }

  const author = await q(sql`SELECT role FROM training_course_authors WHERE course_id = ${courseId} AND user_id = ${user.id} LIMIT 1`);
  if (author.length) {
    const role = String(author[0].role || 'author');
    return { canTeach: true, canGrade: role !== 'reviewer', canAdminister: false, via: 'course ' + role };
  }

  if (roles.includes('faculty') || roles.includes('reviewer_examiner')) {
    // Faculty with no attachment to THIS course may grade what is routed to them but may not
    // restructure somebody else's course.
    return { canTeach: false, canGrade: true, canAdminister: false, via: 'faculty' };
  }

  return NONE;
}

/** Courses this person teaches, for the instructor console's course picker. A platform
 *  administrator sees every published course; everybody else sees only their own attachments. */
export async function myTaughtCourses(user: LmsActor | null | undefined): Promise<any[]> {
  if (!user?.id) return [];
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const q = async (statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch (e: any) {
      console.error('[lms/access] myTaughtCourses:', e?.cause?.message || e?.message);
      return [];
    }
  };

  const roles = await rbacRoles(user.id);
  if (isPlatformStaff(user) || roles.includes('dean') || roles.includes('registrar')) {
    return q(sql`SELECT id, slug, title, is_published FROM training_courses ORDER BY updated_at DESC NULLS LAST, title LIMIT 300`);
  }

  return q(sql`
    SELECT DISTINCT c.id, c.slug, c.title, c.is_published
    FROM training_courses c
    WHERE c.id IN (SELECT course_id FROM lms_course_staff WHERE user_id = ${user.id})
       OR c.id IN (SELECT s.course_id FROM lms_sections s
                   JOIN lms_section_members m ON m.section_id = s.id
                   WHERE m.user_id = ${user.id} AND m.role IN ('instructor','ta') AND m.status = 'active')
       OR c.id IN (SELECT course_id FROM training_course_authors WHERE user_id = ${user.id})
    ORDER BY c.title LIMIT 300`);
}

/** Is this person enrolled in (or on the roster of) this course? The learner-side read gate. */
export async function isEnrolled(userId: string, courseId: string): Promise<boolean> {
  if (!userId || !courseId) return false;
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const q = async (statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch { return []; }
  };
  const legacy = await q(sql`SELECT 1 FROM training_enrollments WHERE user_id = ${userId} AND course_id = ${courseId} LIMIT 1`);
  if (legacy.length) return true;
  const roster = await q(sql`SELECT 1 FROM lms_section_members m JOIN lms_sections s ON s.id = m.section_id
    WHERE s.course_id = ${courseId} AND m.user_id = ${userId} AND m.role = 'student' AND m.status = 'active' LIMIT 1`);
  return roster.length > 0;
}

/** The section this learner sits in for a course, if any. Assignments scoped to another section are
 *  not theirs, and this is the value that decides that. */
export async function mySectionId(userId: string, courseId: string): Promise<string | null> {
  if (!userId || !courseId) return null;
  await ensureLmsSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT m.section_id FROM lms_section_members m
      JOIN lms_sections s ON s.id = m.section_id
      WHERE s.course_id = ${courseId} AND m.user_id = ${userId} AND m.role = 'student' AND m.status = 'active'
      ORDER BY m.added_at DESC LIMIT 1`))[0] as any;
    return r?.section_id || null;
  } catch {
    return null;
  }
}
