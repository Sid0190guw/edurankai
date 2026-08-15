// src/lib/lms/course-home.ts — THE COURSE AS A PLACE (L4).
//
// Announcements, a syllabus, threaded discussion, and scheduled release. These are the four things
// that make a course something a cohort lives inside rather than a list of lessons somebody watches
// alone, and none of them existed at course level here: /aquintutor/discussion checked a role and
// showed nothing, and training_lesson_discussions was per-lesson, so a question about the course
// itself had nowhere to go.
//
// MODERATION IS A HIDE, NOT A DELETE. A post taken down keeps its row and gains a reason. This is
// the same shape the platform's existing moderation uses, and it is what lets a moderation decision
// be reviewed by a person afterwards — which is this project's standing rule for anything automated
// touching somebody's work.

import { ensureLmsSchema, rows } from './schema';
import { releaseState, type ReleaseRule, type ReleaseContext } from './policy';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ================================================================================================
// ANNOUNCEMENTS
// ================================================================================================

export async function courseAnnouncements(courseId: string, sectionId: string | null, limit = 20): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT a.*, u.name AS author_name
      FROM lms_announcements a LEFT JOIN users u ON u.id = a.created_by
      WHERE a.course_id = ${courseId}
        AND (a.section_id IS NULL ${sectionId ? sql`OR a.section_id = ${sectionId}` : sql``})
        AND a.published_at <= NOW()
      ORDER BY a.pinned DESC, a.published_at DESC LIMIT ${limit}`));
  } catch (e: any) {
    console.error('[lms/course-home] courseAnnouncements:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function postAnnouncement(input: { courseId: string; sectionId?: string | null; title: string; body: string; pinned?: boolean; notify?: boolean }, byUserId: string): Promise<{ ok: boolean; error?: string; notified?: number }> {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (!title) return { ok: false, error: 'An announcement needs a title' };
  if (!body) return { ok: false, error: 'An announcement needs something to say' };

  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    await db.execute(sql`INSERT INTO lms_announcements (course_id, section_id, title, body, pinned, created_by)
      VALUES (${input.courseId}, ${input.sectionId || null}, ${title}, ${body}, ${!!input.pinned}, ${byUserId})`);

    let notified = 0;
    if (input.notify !== false) {
      try {
        const course = rows(await db.execute(sql`SELECT title FROM training_courses WHERE id = ${input.courseId} LIMIT 1`))[0] as any;
        const { notifyAnnouncement } = await import('./notify');
        notified = await notifyAnnouncement(input.courseId, input.sectionId || null, title, course?.title || 'Your course');
      } catch (e: any) {
        console.error('[lms/course-home] announce notify:', e?.cause?.message || e?.message);
      }
    }
    return { ok: true, notified };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/course-home] postAnnouncement:', reason);
    return { ok: false, error: reason || 'Could not post the announcement' };
  }
}

export async function deleteAnnouncement(id: string, courseId: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`DELETE FROM lms_announcements WHERE id = ${id} AND course_id = ${courseId}`);
}

// ================================================================================================
// SYLLABUS
// ================================================================================================

export async function getSyllabus(courseId: string, sectionId: string | null): Promise<string> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const r = rows(await db.execute(sql`SELECT body FROM lms_syllabus
      WHERE course_id = ${courseId} AND COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(${sectionId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) LIMIT 1`))[0] as any;
    if (r?.body) return r.body;
    // A section with no syllabus of its own inherits the course's.
    if (sectionId) {
      const base = rows(await db.execute(sql`SELECT body FROM lms_syllabus WHERE course_id = ${courseId} AND section_id IS NULL LIMIT 1`))[0] as any;
      return base?.body || '';
    }
    return '';
  } catch (e: any) {
    console.error('[lms/course-home] getSyllabus:', e?.cause?.message || e?.message);
    return '';
  }
}

export async function saveSyllabus(courseId: string, sectionId: string | null, body: string, byUserId: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    await db.execute(sql`INSERT INTO lms_syllabus (course_id, section_id, body, updated_by, updated_at)
      VALUES (${courseId}, ${sectionId}, ${String(body || '')}, ${byUserId}, NOW())
      ON CONFLICT (course_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = NOW()`);
    return { ok: true };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/course-home] saveSyllabus:', reason);
    return { ok: false, error: reason || 'Could not save the syllabus' };
  }
}

// ================================================================================================
// DISCUSSION
// ================================================================================================

export async function courseTopics(courseId: string, sectionId: string | null, limit = 40): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT t.*, u.name AS author_name,
        (SELECT COUNT(*)::int FROM lms_posts p WHERE p.topic_id = t.id AND p.hidden = false) AS reply_count,
        (SELECT COUNT(*)::int FROM lms_posts p WHERE p.topic_id = t.id AND p.is_answer = true AND p.hidden = false) AS answer_count
      FROM lms_topics t LEFT JOIN users u ON u.id = t.created_by
      WHERE t.course_id = ${courseId}
        AND (t.section_id IS NULL ${sectionId ? sql`OR t.section_id = ${sectionId}` : sql``})
      ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ${limit}`));
  } catch (e: any) {
    console.error('[lms/course-home] courseTopics:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function getTopic(topicId: string): Promise<{ topic: any | null; posts: any[] }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const topic = rows(await db.execute(sql`SELECT t.*, u.name AS author_name, c.title AS course_title, c.slug AS course_slug
      FROM lms_topics t LEFT JOIN users u ON u.id = t.created_by
      JOIN training_courses c ON c.id = t.course_id
      WHERE t.id = ${topicId} LIMIT 1`))[0] || null;
    if (!topic) return { topic: null, posts: [] };
    const posts = rows(await db.execute(sql`SELECT p.*, u.name AS author_name
      FROM lms_posts p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.topic_id = ${topicId} ORDER BY p.created_at ASC LIMIT 500`));
    return { topic, posts };
  } catch (e: any) {
    console.error('[lms/course-home] getTopic:', e?.cause?.message || e?.message);
    return { topic: null, posts: [] };
  }
}

export async function createTopic(input: { courseId: string; sectionId?: string | null; title: string; body?: string; kind?: string }, byUserId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const title = String(input.title || '').trim();
  if (title.length < 4) return { ok: false, error: 'Give the topic a title of at least four characters' };
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const r = rows(await db.execute(sql`INSERT INTO lms_topics (course_id, section_id, title, body, kind, created_by)
      VALUES (${input.courseId}, ${input.sectionId || null}, ${title}, ${input.body || null},
        ${input.kind === 'question' ? 'question' : 'discussion'}, ${byUserId})
      RETURNING id`))[0] as any;
    return { ok: true, id: r?.id };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/course-home] createTopic:', reason);
    return { ok: false, error: reason || 'Could not start the topic' };
  }
}

export async function replyToTopic(topicId: string, body: string, byUserId: string, parentId?: string | null): Promise<{ ok: boolean; error?: string }> {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'Write something first' };
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const topic = rows(await db.execute(sql`SELECT locked FROM lms_topics WHERE id = ${topicId} LIMIT 1`))[0] as any;
    if (!topic) return { ok: false, error: 'That topic no longer exists' };
    if (topic.locked) return { ok: false, error: 'This topic is locked' };
    await db.execute(sql`INSERT INTO lms_posts (topic_id, parent_id, user_id, body)
      VALUES (${topicId}, ${parentId || null}, ${byUserId}, ${text})`);
    await db.execute(sql`UPDATE lms_topics SET last_post_at = NOW() WHERE id = ${topicId}`);
    return { ok: true };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/course-home] replyToTopic:', reason);
    return { ok: false, error: reason || 'Could not post your reply' };
  }
}

/** Mark a reply as the accepted answer. Only one per topic — accepting a second unmarks the first,
 *  otherwise a question thread ends up with four "answers" and no answer. */
export async function markAnswer(topicId: string, postId: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE lms_posts SET is_answer = false WHERE topic_id = ${topicId}`);
  await db.execute(sql`UPDATE lms_posts SET is_answer = true WHERE id = ${postId} AND topic_id = ${topicId}`);
}

export async function hidePost(postId: string, reason: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE lms_posts SET hidden = true, hidden_reason = ${String(reason || 'hidden by a moderator')} WHERE id = ${postId}`);
}

export async function setTopicFlags(topicId: string, flags: { locked?: boolean; pinned?: boolean }): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  if (flags.locked !== undefined) await db.execute(sql`UPDATE lms_topics SET locked = ${flags.locked} WHERE id = ${topicId}`);
  if (flags.pinned !== undefined) await db.execute(sql`UPDATE lms_topics SET pinned = ${flags.pinned} WHERE id = ${topicId}`);
}

// ================================================================================================
// RELEASE (DRIP)
// ================================================================================================

export async function courseReleaseRules(courseId: string): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT * FROM lms_release_rules WHERE course_id = ${courseId} ORDER BY created_at`));
  } catch (e: any) {
    console.error('[lms/course-home] courseReleaseRules:', e?.cause?.message || e?.message);
    return [];
  }
}

export async function saveReleaseRule(input: { courseId: string; sectionId?: string | null; targetKind: string; targetId: string; releaseAt?: string | null; releaseAfterDays?: number | null; requiresLessonId?: string | null; requiresAssignmentId?: string | null; minPct?: number | null }, byUserId: string): Promise<{ ok: boolean; error?: string }> {
  if (!['module', 'lesson', 'assignment'].includes(input.targetKind)) return { ok: false, error: 'Unknown target' };
  if (!input.targetId) return { ok: false, error: 'Choose what the rule applies to' };
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    await db.execute(sql`INSERT INTO lms_release_rules
      (course_id, section_id, target_kind, target_id, release_at, release_after_days, requires_lesson_id, requires_assignment_id, min_pct, created_by)
      VALUES (${input.courseId}, ${input.sectionId || null}, ${input.targetKind}, ${input.targetId},
        ${input.releaseAt || null}, ${input.releaseAfterDays ?? null}, ${input.requiresLessonId || null},
        ${input.requiresAssignmentId || null}, ${input.minPct ?? null}, ${byUserId})
      ON CONFLICT (target_kind, target_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET release_at = EXCLUDED.release_at, release_after_days = EXCLUDED.release_after_days,
        requires_lesson_id = EXCLUDED.requires_lesson_id, requires_assignment_id = EXCLUDED.requires_assignment_id,
        min_pct = EXCLUDED.min_pct`);
    return { ok: true };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/course-home] saveReleaseRule:', reason);
    return { ok: false, error: reason || 'Could not save the rule' };
  }
}

export async function deleteReleaseRule(id: string, courseId: string): Promise<void> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  await db.execute(sql`DELETE FROM lms_release_rules WHERE id = ${id} AND course_id = ${courseId}`);
}

/** Build the release context for one learner on one course, then answer every rule against it in
 *  one pass. The gating decision itself is policy.releaseState — pure and tested. */
export async function releaseMap(courseId: string, userId: string, sectionId: string | null, now = new Date()): Promise<Record<string, { open: boolean; reason: string }>> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  const q = async (statement: any): Promise<any[]> => {
    try { return rows(await db.execute(statement)); } catch (e: any) {
      console.error('[lms/course-home] releaseMap:', e?.cause?.message || e?.message);
      return [];
    }
  };

  const rules = await q(sql`SELECT * FROM lms_release_rules WHERE course_id = ${courseId}
    AND (section_id IS NULL ${sectionId ? sql`OR section_id = ${sectionId}` : sql``})`);
  if (!rules.length) return {};

  const enrolment = (await q(sql`SELECT enrolled_at FROM training_enrollments WHERE course_id = ${courseId} AND user_id = ${userId} LIMIT 1`))[0];
  const completed = await q(sql`SELECT lesson_id FROM training_lesson_completions WHERE course_id = ${courseId} AND user_id = ${userId}`);
  const graded = await q(sql`SELECT g.assignment_id, g.pct FROM lms_grades g
    JOIN lms_assignments a ON a.id = g.assignment_id
    WHERE a.course_id = ${courseId} AND g.user_id = ${userId} AND g.posted = true`);

  const context: ReleaseContext = {
    enrolledAt: enrolment?.enrolled_at || null,
    completedLessonIds: completed.map((r: any) => String(r.lesson_id)),
    gradedPctByAssignment: graded.reduce((acc: Record<string, number>, r: any) => {
      acc[String(r.assignment_id)] = Number(r.pct || 0);
      return acc;
    }, {}),
  };

  const map: Record<string, { open: boolean; reason: string }> = {};
  for (const rule of rules) {
    const spec: ReleaseRule = {
      releaseAt: rule.release_at,
      releaseAfterDays: rule.release_after_days,
      requiresLessonId: rule.requires_lesson_id,
      requiresAssignmentId: rule.requires_assignment_id,
      minPct: rule.min_pct != null ? Number(rule.min_pct) : null,
    };
    map[String(rule.target_id)] = releaseState(spec, context, now);
  }
  return map;
}
