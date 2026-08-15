// src/lib/lms/sections.ts — TERMS, SECTIONS AND ROSTERS (L3).
//
// A course is a syllabus. A SECTION is that syllabus taught to a particular group of people, by a
// particular instructor, between two dates. Until this file existed, AquinTutor had the first and
// not the second: "cohort" appeared in the codebase only as an access-window label in
// src/lib/course-access.ts — a way of saying "this course opens on the 3rd", not a group anybody
// belongs to. So there was no answer to "who is in my class", which is the question every other
// screen in an LMS is downstream of.
//
// SECTIONS ARE OPTIONAL AND STAY OPTIONAL. A self-paced open course has no section and every query
// in this spine treats section_id NULL as "the whole course". Nothing here forces an existing
// course into a structure it does not need.

import { ensureLmsSchema, rows } from './schema';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ================================================================================================
// TERMS
// ================================================================================================

export async function listTerms(): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT t.*,
        (SELECT COUNT(*)::int FROM lms_sections s WHERE s.term_id = t.id) AS section_count
      FROM lms_terms t ORDER BY t.starts_on DESC NULLS LAST, t.code DESC`));
  } catch (e: any) {
    console.error('[lms/sections] listTerms:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function saveTerm(input: { id?: string | null; code: string; title: string; startsOn?: string | null; endsOn?: string | null; addDropUntil?: string | null; isActive?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const code = String(input.code || '').trim().toUpperCase();
  const title = String(input.title || '').trim();
  if (!code) return { ok: false, error: 'A term needs a code, for example 2026-AUTUMN' };
  if (!title) return { ok: false, error: 'A term needs a title' };
  if (input.startsOn && input.endsOn && new Date(input.endsOn) < new Date(input.startsOn)) {
    return { ok: false, error: 'The term ends before it starts' };
  }
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    if (input.id) {
      await db.execute(sql`UPDATE lms_terms SET code = ${code}, title = ${title},
        starts_on = ${input.startsOn || null}, ends_on = ${input.endsOn || null},
        add_drop_until = ${input.addDropUntil || null}, is_active = ${input.isActive !== false}
        WHERE id = ${input.id}`);
    } else {
      await db.execute(sql`INSERT INTO lms_terms (code, title, starts_on, ends_on, add_drop_until, is_active)
        VALUES (${code}, ${title}, ${input.startsOn || null}, ${input.endsOn || null},
          ${input.addDropUntil || null}, ${input.isActive !== false})
        ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, starts_on = EXCLUDED.starts_on,
          ends_on = EXCLUDED.ends_on, add_drop_until = EXCLUDED.add_drop_until, is_active = EXCLUDED.is_active`);
    }
    return { ok: true };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/sections] saveTerm:', reason);
    return { ok: false, error: reason || 'Could not save the term' };
  }
}

// ================================================================================================
// SECTIONS
// ================================================================================================

export async function courseSections(courseId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT s.*, t.code AS term_code, t.title AS term_title,
        (SELECT COUNT(*)::int FROM lms_section_members m WHERE m.section_id = s.id AND m.role = 'student' AND m.status = 'active') AS student_count,
        (SELECT string_agg(u.name, ', ') FROM lms_section_members m LEFT JOIN users u ON u.id = m.user_id
          WHERE m.section_id = s.id AND m.role = 'instructor' AND m.status = 'active') AS instructors
      FROM lms_sections s LEFT JOIN lms_terms t ON t.id = s.term_id
      WHERE s.course_id = ${courseId}
      ORDER BY t.starts_on DESC NULLS LAST, s.code`));
  } catch (e: any) {
    console.error('[lms/sections] courseSections:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function getSection(sectionId: string): Promise<any | null> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT s.*, c.title AS course_title, c.slug AS course_slug,
        t.code AS term_code, t.title AS term_title, t.starts_on, t.ends_on
      FROM lms_sections s
      JOIN training_courses c ON c.id = s.course_id
      LEFT JOIN lms_terms t ON t.id = s.term_id
      WHERE s.id = ${sectionId} LIMIT 1`))[0] || null;
  } catch (e: any) {
    console.error('[lms/sections] getSection:', e?.cause?.message || e?.message);
    return null;
  }
}

export async function saveSection(input: { id?: string | null; courseId: string; termId?: string | null; code: string; title?: string | null; capacity?: number | null; delivery?: string; meets?: string | null; isOpen?: boolean }, byUserId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const code = String(input.code || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'A section needs a code, for example S1' };
  if (!input.courseId) return { ok: false, error: 'A section belongs to a course' };
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    if (input.id) {
      await db.execute(sql`UPDATE lms_sections SET term_id = ${input.termId || null}, code = ${code},
        title = ${input.title || null}, capacity = ${input.capacity ?? null},
        delivery = ${input.delivery || 'online'}, meets = ${input.meets || null}, is_open = ${input.isOpen !== false}
        WHERE id = ${input.id}`);
      return { ok: true, id: input.id };
    }
    const r = rows(await db.execute(sql`INSERT INTO lms_sections (course_id, term_id, code, title, capacity, delivery, meets, is_open, created_by)
      VALUES (${input.courseId}, ${input.termId || null}, ${code}, ${input.title || null}, ${input.capacity ?? null},
        ${input.delivery || 'online'}, ${input.meets || null}, ${input.isOpen !== false}, ${byUserId})
      RETURNING id`))[0] as any;
    return { ok: true, id: r?.id };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/sections] saveSection:', reason);
    if (/duplicate key/i.test(reason || '')) return { ok: false, error: 'A section with that code already exists for this course and term' };
    return { ok: false, error: reason || 'Could not save the section' };
  }
}

// ================================================================================================
// ROSTER
// ================================================================================================

export async function sectionRoster(sectionId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT m.id, m.user_id, m.role, m.status, m.added_at,
        u.name, u.email
      FROM lms_section_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.section_id = ${sectionId}
      ORDER BY CASE m.role WHEN 'instructor' THEN 0 WHEN 'ta' THEN 1 ELSE 2 END, u.name`));
  } catch (e: any) {
    console.error('[lms/sections] sectionRoster:', e?.cause?.message || e?.message);
    return [];
  }
}

/** Add one person to a section by email. Capacity is enforced for students only — an instructor
 *  added to a full section is not the thing capacity is protecting against. */
export async function addToRoster(sectionId: string, email: string, role: string, byUserId: string): Promise<{ ok: boolean; error?: string }> {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return { ok: false, error: 'Enter an email address' };
  const safeRole = ['student', 'instructor', 'ta', 'observer'].includes(role) ? role : 'student';

  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const user = rows(await db.execute(sql`SELECT id, name FROM users WHERE LOWER(email) = ${clean} LIMIT 1`))[0] as any;
    if (!user?.id) return { ok: false, error: 'No account here uses ' + clean };

    if (safeRole === 'student') {
      const section = rows(await db.execute(sql`SELECT capacity FROM lms_sections WHERE id = ${sectionId} LIMIT 1`))[0] as any;
      const capacity = section?.capacity;
      if (capacity && Number(capacity) > 0) {
        const count = Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM lms_section_members
          WHERE section_id = ${sectionId} AND role = 'student' AND status = 'active'`))[0]?.c || 0);
        if (count >= Number(capacity)) return { ok: false, error: 'This section is full (' + capacity + ' places)' };
      }
    }

    await db.execute(sql`INSERT INTO lms_section_members (section_id, user_id, role, added_by)
      VALUES (${sectionId}, ${user.id}, ${safeRole}, ${byUserId})
      ON CONFLICT (section_id, user_id, role) DO UPDATE SET status = 'active'`);
    return { ok: true };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/sections] addToRoster:', reason);
    return { ok: false, error: reason || 'Could not add that person' };
  }
}

/** Drop somebody from a section. The row is kept with status = 'dropped' rather than deleted: a
 *  student who dropped in week nine is a fact the section's history needs, and their submissions
 *  and grades still reference this membership. */
export async function setRosterStatus(memberId: string, status: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const safe = ['active', 'dropped', 'completed', 'withdrawn'].includes(status) ? status : 'active';
  await db.execute(sql`UPDATE lms_section_members SET status = ${safe} WHERE id = ${memberId}`);
}

/** The sections this learner sits in, for their own course home. */
export async function mySections(userId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT s.id, s.code, s.title, s.meets, s.delivery, s.course_id,
        c.title AS course_title, c.slug AS course_slug, t.code AS term_code, t.title AS term_title,
        m.role, m.status
      FROM lms_section_members m
      JOIN lms_sections s ON s.id = m.section_id
      JOIN training_courses c ON c.id = s.course_id
      LEFT JOIN lms_terms t ON t.id = s.term_id
      WHERE m.user_id = ${userId} AND m.status = 'active'
      ORDER BY t.starts_on DESC NULLS LAST, c.title`));
  } catch (e: any) {
    console.error('[lms/sections] mySections:', e?.cause?.message || e?.message);
    return [];
  }
}
