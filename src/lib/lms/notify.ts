// src/lib/lms/notify.ts — THE FOUR THINGS AN LMS HAS TO TELL SOMEBODY.
//
// A grade was released. An assignment is due. An announcement was posted. Somebody answered your
// question. That is the whole list, and it goes through src/lib/edu-notify.ts — the notification
// system this platform already has, with the learner's own opt-outs already honoured. Nothing here
// invents a second delivery path.
//
// EVERY FUNCTION HERE IS BEST-EFFORT AND SAYS SO. A grade that was saved and then failed to notify
// is still a saved grade; the caller logs and carries on. What it must never do is fail SILENTLY,
// so each catch writes the real Postgres reason (e.cause) rather than swallowing it.

import { ensureLmsSchema, rows } from './schema';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

async function send(userId: string, n: { type: 'result' | 'deadline' | 'general'; title: string; body?: string; link?: string }): Promise<void> {
  const { notify } = await import('@/lib/edu-notify');
  await notify(userId, n);
}

/** A grade has been released to this learner. */
export async function notifyGraded(userId: string, assignmentTitle: string, courseTitle: string, points: number, total: number): Promise<void> {
  await send(userId, {
    type: 'result',
    title: 'Graded: ' + assignmentTitle,
    body: courseTitle + ' — ' + points + ' out of ' + total,
    link: '/aquintutor/grades',
  });
}

/** An instructor posted an announcement to a course. Goes to the enrolled roster, not to everyone. */
export async function notifyAnnouncement(courseId: string, sectionId: string | null, title: string, courseTitle: string): Promise<number> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  let audience: any[] = [];
  try {
    audience = sectionId
      ? rows(await db.execute(sql`SELECT user_id FROM lms_section_members
          WHERE section_id = ${sectionId} AND role = 'student' AND status = 'active'`))
      : rows(await db.execute(sql`SELECT user_id FROM training_enrollments WHERE course_id = ${courseId}
          UNION SELECT m.user_id FROM lms_section_members m JOIN lms_sections s ON s.id = m.section_id
          WHERE s.course_id = ${courseId} AND m.role = 'student' AND m.status = 'active'`));
  } catch (e: any) {
    console.error('[lms/notify] announcement audience:', e?.cause?.message || e?.message);
    return 0;
  }

  let sent = 0;
  for (const row of audience) {
    try {
      await send(row.user_id, {
        type: 'general',
        title: courseTitle + ': ' + title,
        body: 'A new announcement was posted to your course.',
        link: '/aquintutor/course/' + courseId,
      });
      sent++;
    } catch (e: any) {
      console.error('[lms/notify] announcement to', row.user_id, e?.cause?.message || e?.message);
    }
  }
  return sent;
}

/**
 * Due-date reminders for everything falling due inside `withinHours`.
 *
 * IDEMPOTENCE IS THE WHOLE PROBLEM WITH A REMINDER JOB, and it is solved here by writing a marker
 * row into lms_xapi_statements (verb `reminded`, object the assignment) and checking for it before
 * sending. A cron that runs twice — which this one will, because Vercel retries — must not send a
 * learner the same deadline twice.
 *
 * Returns the number of reminders actually sent.
 */
export async function sendDueReminders(withinHours = 48): Promise<{ sent: number; skipped: number }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  let due: any[] = [];
  try {
    due = rows(await db.execute(sql`
      SELECT a.id, a.title, a.due_at, a.course_id, c.title AS course_title, learner.user_id
      FROM lms_assignments a
      JOIN training_courses c ON c.id = a.course_id
      JOIN LATERAL (
        SELECT te.user_id FROM training_enrollments te WHERE te.course_id = a.course_id AND a.section_id IS NULL
        UNION
        SELECT m.user_id FROM lms_section_members m
        WHERE m.role = 'student' AND m.status = 'active'
          AND (m.section_id = a.section_id
               OR (a.section_id IS NULL AND m.section_id IN (SELECT id FROM lms_sections WHERE course_id = a.course_id)))
      ) learner ON true
      WHERE a.published = true
        AND a.due_at IS NOT NULL
        AND a.due_at > NOW()
        -- INTERVAL '1 hour' * <int>, not (<param> || ' hours')::interval. The concatenation form
        -- needs the parameter to be inferred as text, and this driver binds a number as a number,
        -- so Postgres has no integer || text operator to reach for and the whole query throws.
        AND a.due_at < NOW() + (INTERVAL '1 hour' * ${withinHours})
        AND NOT EXISTS (
          SELECT 1 FROM lms_submissions s WHERE s.assignment_id = a.id AND s.user_id = learner.user_id AND s.status <> 'draft')
      LIMIT 2000`));
  } catch (e: any) {
    console.error('[lms/notify] sendDueReminders read:', e?.cause?.message || e?.message);
    return { sent: 0, skipped: 0 };
  }

  let sent = 0;
  let skipped = 0;
  for (const row of due) {
    const marker = 'reminder:' + row.id + ':' + row.user_id;
    try {
      const already = rows(await db.execute(sql`SELECT 1 FROM lms_xapi_statements
        WHERE verb = 'reminded' AND object_id = ${marker} LIMIT 1`));
      if (already.length) { skipped++; continue; }

      await send(row.user_id, {
        type: 'deadline',
        title: 'Due soon: ' + row.title,
        body: row.course_title + ' — due ' + new Date(row.due_at).toUTCString(),
        link: '/aquintutor/assignments/' + row.id,
      });
      await db.execute(sql`INSERT INTO lms_xapi_statements (actor_user_id, verb, object_id, object_name, course_id, source, raw)
        VALUES (${row.user_id}, 'reminded', ${marker}, ${row.title}, ${row.course_id}, 'internal', ${JSON.stringify({ dueAt: row.due_at })}::jsonb)`);
      sent++;
    } catch (e: any) {
      console.error('[lms/notify] reminder:', e?.cause?.message || e?.message);
    }
  }
  return { sent, skipped };
}
