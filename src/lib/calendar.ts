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
  if (due.length === 0) return 0;

  // THE WHOLE RECIPIENT LIST IN ONE QUERY, ALREADY DE-DUPLICATED.
  //
  // This was a nested loop: one roster read PER DEADLINE, then an "already sent?" SELECT and an
  // INSERT PER STUDENT PER DEADLINE. Five deadlines on a two-hundred-student course meant
  // 5 roster reads + 1,000 dedupe reads + 1,000 inserts inside ONE serverless invocation, all
  // sequential on one pooler connection — and it is reached from an admin endpoint, so a person is
  // waiting on it. The roster join and the already-sent exclusion are one pass for Postgres, so they
  // happen there.
  //
  // NOT EXISTS reproduces the old skip exactly, and the bulk insert still carries
  // ON CONFLICT DO NOTHING, so a concurrent run still cannot double-send.
  //
  // The id list travels as JSON rather than as a bound array: src/lib/pg-array.ts documents that
  // postgres-js serialises a JS array into a drizzle template as a record literal, which Postgres
  // will not cast.
  const deadlineIds = due.map((d: any) => String(d.id));
  const byId = new Map(due.map((d: any) => [String(d.id), d]));
  const targets = rows(await db.execute(sql`
    SELECT d.id::text AS deadline_id, e.user_id::text AS user_id
      FROM edu_deadlines d
      JOIN edu_enrolments e ON e.course_obj_id = d.course_obj_id AND e.status = 'active'
     WHERE d.id::text IN (SELECT t.x FROM jsonb_array_elements_text(${JSON.stringify(deadlineIds)}::jsonb) AS t(x))
       AND NOT EXISTS (
         SELECT 1 FROM edu_reminder_sent r WHERE r.deadline_id = d.id AND r.user_id = e.user_id
       )`));

  const { notify } = await import('@/lib/edu-notify');
  let sent = 0;
  const landed: Array<{ d: string; u: string }> = [];
  for (const t of targets) {
    const d: any = byId.get(String(t.deadline_id));
    if (!d) continue;
    // notify() stays per-recipient: that is the sink's interface, and this repair is about the two
    // round-trips per student that were NOT inherent to sending — the dedupe read and the receipt
    // insert. Both are gone.
    await notify(String(t.user_id), { type: 'deadline', title: 'Upcoming: ' + d.title, body: new Date(d.due_at).toLocaleString(), link: '/aquintutor/calendar' });
    landed.push({ d: String(d.id), u: String(t.user_id) });
    sent++;
  }

  // ONE insert for every receipt, instead of one per student per deadline.
  if (landed.length > 0) {
    await db.execute(sql`
      INSERT INTO edu_reminder_sent (deadline_id, user_id)
      SELECT (p->>'d')::uuid, (p->>'u')::uuid
        FROM jsonb_array_elements(${JSON.stringify(landed)}::jsonb) AS p
      ON CONFLICT DO NOTHING`);
  }
  return sent;
}
