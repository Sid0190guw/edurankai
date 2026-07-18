// src/lib/calendar.ts — Study calendar + real ICS feed (Prompt 19). A per-student calendar built
// from deadlines on the courses they're enrolled in (lessons, assessments, exams). A genuine
// iCalendar (.ics) feed lets any calendar app subscribe (personal, token-signed URL — no login).
// Deadline reminders fire through the notification system (Prompt 18). The ICS serializer, the feed
// token, and the due-soon selection are pure and unit-tested.
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.CALENDAR_TOKEN_SECRET || process.env.SESSION_SECRET || 'edurankai-calendar-v1';
/** Stable, verifiable per-user feed token so a calendar app can subscribe without a login. Pure. */
export function calToken(userId: string): string { return createHmac('sha256', SECRET).update('cal:' + userId).digest('hex').slice(0, 32); }
export function verifyCalToken(userId: string, token: string): boolean {
  const exp = calToken(userId); if (!token || token.length !== exp.length) return false;
  try { return timingSafeEqual(Buffer.from(exp), Buffer.from(token)); } catch { return false; }
}

export interface CalEvent { uid: string; title: string; start: string; kind?: string }
function icsDate(iso: string): string { const d = new Date(iso); return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function esc(s: string): string { return String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'); }
/** Serialize events to a valid iCalendar document (CRLF line endings, VEVENT per item). Pure. */
export function toICS(events: CalEvent[], calName = 'AquinTutor'): string {
  const now = icsDate(new Date().toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AquinTutor//Study Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(calName)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${esc(e.uid)}@edurankai.in`, `DTSTAMP:${now}`, `DTSTART:${icsDate(e.start)}`, `SUMMARY:${esc((e.kind ? '[' + e.kind + '] ' : '') + e.title)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** Deadlines due within the window and still in the future. Pure. */
export function dueSoon<T extends { due_at: string }>(deadlines: T[], now: Date, withinHours = 48): T[] {
  const nMs = now.getTime(); const end = nMs + withinHours * 3600000;
  return deadlines.filter((d) => { const t = Date.parse(d.due_at); return t >= nMs && t <= end; });
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureCalendarSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_deadlines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), course_obj_id UUID NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'assessment', due_at TIMESTAMPTZ NOT NULL, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_reminder_sent (deadline_id UUID NOT NULL, user_id UUID NOT NULL, PRIMARY KEY (deadline_id, user_id))`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_deadlines_course_idx ON edu_deadlines (course_obj_id, due_at)`));
  booted = true;
}
export async function setDeadline(courseObjId: string, title: string, kind: string, dueAt: string, by: string | null): Promise<void> {
  await ensureCalendarSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_deadlines (course_obj_id, title, kind, due_at, created_by) VALUES (${courseObjId}, ${title}, ${kind}, ${dueAt}, ${by})`);
}
export async function courseDeadlines(courseObjId: string): Promise<any[]> {
  await ensureCalendarSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT id, title, kind, due_at FROM edu_deadlines WHERE course_obj_id = ${courseObjId} ORDER BY due_at`));
}
/** A student's calendar: deadlines on the courses they are enrolled in. */
export async function studentCalendar(userId: string): Promise<any[]> {
  await ensureCalendarSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT d.id, d.title, d.kind, d.due_at, c.title AS course_title FROM edu_deadlines d
    JOIN edu_enrolments e ON e.course_obj_id = d.course_obj_id AND e.user_id = ${userId}
    LEFT JOIN LATERAL (SELECT (data->>'title') AS title FROM kernel_objects WHERE id = d.course_obj_id) c ON true
    ORDER BY d.due_at`).catch(() => []));
}
/** Fire deadline reminders (Prompt 18) for enrolled students, once per (deadline,user). Returns count sent. */
export async function runDeadlineReminders(withinHours = 48): Promise<number> {
  await ensureCalendarSchema(); const { db, sql } = await ctx();
  const due = rows(await db.execute(sql`SELECT id, course_obj_id, title, kind, due_at FROM edu_deadlines WHERE due_at BETWEEN NOW() AND NOW() + (${withinHours} || ' hours')::interval`));
  const { notify } = await import('@/lib/edu-notify');
  let sent = 0;
  for (const d of due) {
    const students = rows(await db.execute(sql`SELECT e.user_id FROM edu_enrolments e WHERE e.course_obj_id = ${d.course_obj_id} AND e.status = 'active'`));
    for (const s of students) {
      const done = rows(await db.execute(sql`SELECT 1 FROM edu_reminder_sent WHERE deadline_id = ${d.id} AND user_id = ${s.user_id} LIMIT 1`));
      if (done.length) continue;
      await notify(s.user_id, { type: 'deadline', title: 'Upcoming: ' + d.title, body: new Date(d.due_at).toLocaleString(), link: '/aquintutor/calendar' });
      await db.execute(sql`INSERT INTO edu_reminder_sent (deadline_id, user_id) VALUES (${d.id}, ${s.user_id}) ON CONFLICT DO NOTHING`);
      sent++;
    }
  }
  return sent;
}
