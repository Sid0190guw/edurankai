// AquinTutor study-plan calendar. Emits a standards-compliant iCalendar (ICS)
// feed the learner can connect to ANY calendar app — Google Calendar (Add by
// URL), Apple Calendar, Outlook — via a private, stable webcal/https URL. No
// OAuth, no third-party API keys (consistent with the self-built ethos): the
// per-user feed token is the only secret. The feed aggregates:
//   - spaced-repetition reviews that are due (from aq_srs_card, per deck),
//   - a daily practice reminder (recurring),
//   - the learner's own planned study sessions (aq_study_plan).
// Self-bootstrapping schema (CREATE/ALTER IF NOT EXISTS at runtime).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { DECKS, getStats } from '@/lib/aquintutor-srs';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
export function ensureCalendarSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_calendar_feed (
        user_id UUID PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_study_plan (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        title TEXT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_study_plan_user_idx ON aq_study_plan (user_id, starts_at)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

function randomToken(): string {
  // 32 hex chars of feed secret. Global Web Crypto (Node 18+ / Vercel) or fallback.
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// Stable per-user feed token (created on first request).
export async function getOrCreateToken(userId: string): Promise<string> {
  await ensureCalendarSchema();
  const existing = rows(await db.execute(sql`SELECT token FROM aq_calendar_feed WHERE user_id = ${userId} LIMIT 1`))[0];
  if (existing?.token) return existing.token;
  const token = randomToken();
  await db.execute(sql`INSERT INTO aq_calendar_feed (user_id, token) VALUES (${userId}, ${token})
    ON CONFLICT (user_id) DO NOTHING`).catch(() => {});
  const after = rows(await db.execute(sql`SELECT token FROM aq_calendar_feed WHERE user_id = ${userId} LIMIT 1`))[0];
  return after?.token || token;
}

export async function userIdForToken(token: string): Promise<string | null> {
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return null;
  await ensureCalendarSchema();
  const r = rows(await db.execute(sql`SELECT user_id FROM aq_calendar_feed WHERE token = ${token} LIMIT 1`))[0];
  return r?.user_id || null;
}

// Rotate the token (invalidates the old feed URL).
export async function rotateToken(userId: string): Promise<string> {
  await ensureCalendarSchema();
  const token = randomToken();
  await db.execute(sql`UPDATE aq_calendar_feed SET token = ${token} WHERE user_id = ${userId}`).catch(() => {});
  await db.execute(sql`INSERT INTO aq_calendar_feed (user_id, token) VALUES (${userId}, ${token})
    ON CONFLICT (user_id) DO UPDATE SET token = ${token}`).catch(() => {});
  return token;
}

// ---- study plan CRUD ----
export interface StudySession { id: string; title: string; starts_at: string; ends_at: string; notes: string | null; }

export async function listStudyPlan(userId: string, fromNowOnly = false): Promise<StudySession[]> {
  await ensureCalendarSchema();
  const r = fromNowOnly
    ? rows(await db.execute(sql`SELECT id, title, starts_at, ends_at, notes FROM aq_study_plan WHERE user_id = ${userId} AND ends_at >= NOW() - INTERVAL '1 day' ORDER BY starts_at ASC LIMIT 200`))
    : rows(await db.execute(sql`SELECT id, title, starts_at, ends_at, notes FROM aq_study_plan WHERE user_id = ${userId} ORDER BY starts_at ASC LIMIT 200`));
  return r as StudySession[];
}

export async function addStudySession(userId: string, title: string, startsAt: string, endsAt: string, notes: string | null): Promise<void> {
  await ensureCalendarSchema();
  await db.execute(sql`INSERT INTO aq_study_plan (user_id, title, starts_at, ends_at, notes)
    VALUES (${userId}, ${title.slice(0, 200)}, ${startsAt}, ${endsAt}, ${notes ? notes.slice(0, 500) : null})`);
}

export async function deleteStudySession(userId: string, id: string): Promise<void> {
  await ensureCalendarSchema();
  await db.execute(sql`DELETE FROM aq_study_plan WHERE id = ${id} AND user_id = ${userId}`).catch(() => {});
}

// ---- ICS emission ----
function pad(n: number): string { return String(n).padStart(2, '0'); }
function toUtcStamp(d: Date): string {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
function toDateStamp(d: Date): string {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}
function esc(s: string): string {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// Fold lines to <=75 octets per RFC 5545 (simple char-based fold is fine for ASCII).
function fold(line: string): string {
  if (line.length <= 74) return line;
  let out = line.slice(0, 74);
  let rest = line.slice(74);
  while (rest.length > 73) { out += '\r\n ' + rest.slice(0, 73); rest = rest.slice(73); }
  out += '\r\n ' + rest;
  return out;
}

export async function buildIcs(userId: string): Promise<string> {
  await ensureCalendarSchema();
  const now = new Date();
  const stamp = toUtcStamp(now);
  const L: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EduRankAI//AquinTutor Study Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:AquinTutor Study Plan',
    'X-WR-CALDESC:Your spaced-repetition reviews, daily practice and study sessions.',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  const ev = (uid: string, extra: string[]) => {
    L.push('BEGIN:VEVENT', 'UID:' + uid + '@edurankai.in', 'DTSTAMP:' + stamp, ...extra, 'END:VEVENT');
  };

  // 1) Daily practice reminder — recurring, 19:00 IST (13:30 UTC).
  const firstReminder = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 30, 0));
  ev('aq-daily-practice', [
    'DTSTART:' + toUtcStamp(firstReminder),
    'DTEND:' + toUtcStamp(new Date(firstReminder.getTime() + 15 * 60000)),
    'RRULE:FREQ=DAILY',
    'SUMMARY:' + esc('AquinTutor — daily practice'),
    'DESCRIPTION:' + esc('A short practice round keeps your streak alive and earns XP. https://edurankai.in/aquintutor/daily'),
    'URL:https://edurankai.in/aquintutor/daily',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:' + esc('Time to practise'), 'END:VALARM',
  ]);

  // 2) Spaced-repetition reviews due, per deck.
  for (const deck of DECKS) {
    let stats: { total: number; due: number; nextDueAt: string | null };
    try { stats = await getStats(userId, deck.id); } catch (_) { continue; }
    if (!stats.total) continue;
    // due now -> today; else the next due date.
    const dueDate = stats.due > 0 ? now : (stats.nextDueAt ? new Date(stats.nextDueAt) : null);
    if (!dueDate) continue;
    const count = stats.due > 0 ? stats.due : 1;
    const dayStart = new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    ev('aq-srs-' + deck.id + '-' + toDateStamp(dayStart), [
      'DTSTART;VALUE=DATE:' + toDateStamp(dayStart),
      'DTEND;VALUE=DATE:' + toDateStamp(dayEnd),
      'SUMMARY:' + esc('Revise ' + deck.name + (stats.due > 0 ? ' (' + count + ' due)' : '')),
      'DESCRIPTION:' + esc(deck.blurb + ' https://edurankai.in/aquintutor/recall'),
      'URL:https://edurankai.in/aquintutor/recall',
    ]);
  }

  // 3) The learner's own planned study sessions.
  let plan: StudySession[] = [];
  try { plan = await listStudyPlan(userId, true); } catch (_) {}
  for (const s of plan) {
    const st = new Date(s.starts_at), en = new Date(s.ends_at);
    if (isNaN(st.getTime()) || isNaN(en.getTime())) continue;
    ev('aq-plan-' + s.id, [
      'DTSTART:' + toUtcStamp(st),
      'DTEND:' + toUtcStamp(en.getTime() > st.getTime() ? en : new Date(st.getTime() + 30 * 60000)),
      'SUMMARY:' + esc(s.title),
      ...(s.notes ? ['DESCRIPTION:' + esc(s.notes)] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:' + esc('Study session'), 'END:VALARM',
    ]);
  }

  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

// Google Calendar "Add event" template link (per session, no OAuth).
export function googleTemplateUrl(title: string, start: Date, end: Date, details = ''): string {
  const fmt = (d: Date) => toUtcStamp(d);
  const p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: fmt(start) + '/' + fmt(end), details });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
