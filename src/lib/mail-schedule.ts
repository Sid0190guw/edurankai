// src/lib/mail-schedule.ts — WHEN A CAMPAIGN GOES OUT. Pure; no database, no timers.
//
// SCHEDULING IS SERVER-SIDE AND NOTHING HERE RUNS IN A BROWSER. A browser timer cannot schedule a
// send: the tab closes, the laptop sleeps, the operator flies somewhere. Everything below computes
// an INSTANT (a UTC timestamp) which is written to the campaign row; a server cron drains what is
// due. The only thing the browser does is pick a wall-clock time and a zone.
//
// WALL CLOCK IS NOT AN INSTANT, AND THAT IS THE WHOLE PROBLEM. "9:30 on the 20th" means six
// different instants depending on the zone, and in a zone with daylight saving it can mean two
// instants or none at all on two days a year. `new Date('2026-08-20T09:30')` reads that string in
// the SERVER's zone — which on Vercel is UTC and on the operator's laptop is not — so a campaign
// scheduled for 9:30 IST would have gone out at 15:00 IST. zonedTimeToUtc() resolves the wall clock
// in the zone the operator actually chose, with a second pass across the DST boundary.
//
// No Intl.DateTimeFormat construction happens at module scope, so importing this file is free.

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** A small, real list. Anything IANA works — this is just what the picker offers first. */
export const COMMON_TIMEZONES: ReadonlyArray<{ tz: string; label: string }> = [
  { tz: 'Asia/Kolkata', label: 'India (IST)' },
  { tz: 'UTC', label: 'UTC' },
  { tz: 'Europe/London', label: 'United Kingdom' },
  { tz: 'Europe/Zurich', label: 'Switzerland' },
  { tz: 'Europe/Berlin', label: 'Central Europe' },
  { tz: 'America/New_York', label: 'US Eastern' },
  { tz: 'America/Los_Angeles', label: 'US Pacific' },
  { tz: 'Asia/Singapore', label: 'Singapore' },
  { tz: 'Asia/Dubai', label: 'Gulf' },
  { tz: 'Australia/Sydney', label: 'Australia Eastern' },
];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return true;
  } catch {
    return false;
  }
}

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock reading of a UTC instant in a zone. */
export function zoneParts(timeZone: string, at: Date): ZoneParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value || '0';
  let hour = Number(pick('hour'));
  if (hour === 24) hour = 0;   // some ICU builds render midnight as 24
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour,
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: Math.max(0, WEEKDAYS.indexOf(String(pick('weekday')).slice(0, 3))),
  };
}

/** The zone's offset from UTC, in minutes, at a given instant. Positive is east of Greenwich. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const p = zoneParts(timeZone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * The UTC instant of a wall-clock time in a zone.
 *
 * `local` is `YYYY-MM-DDTHH:MM` (or with seconds, or a space separator) — exactly what an
 * `<input type="datetime-local">` submits.
 *
 * The second pass is the DST correction: the first guess uses the offset in force at the naive
 * instant, which is the wrong side of the boundary on two days a year. Re-reading the offset at the
 * candidate instant and recomputing fixes the ordinary case.
 *
 * THE THIRD CHECK IS THE ONE THAT MATTERS, and a two-pass version of this function got it wrong.
 * On a SPRING-FORWARD GAP the chosen wall clock does not exist at all (02:30 on 8 March in New
 * York), and the correction then overshoots BACKWARDS — resolving "02:30" to 01:30, an hour EARLIER
 * than asked for, which for a campaign means it goes out before the operator expected. So the
 * candidate is verified: if re-reading its offset does not agree, we are in a gap and the
 * FIRST-PASS instant is used, which lands just after the jump (03:30 local). Late by the width of
 * the gap, never early. On an AMBIGUOUS fall-back hour the two passes agree and the earlier of the
 * two possible instants is returned.
 */
export function zonedTimeToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(local || '').trim());
  if (!m || !isValidTimeZone(timeZone)) return new Date(NaN);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  const off1 = zoneOffsetMinutes(timeZone, new Date(naive));
  const first = naive - off1 * 60000;
  const off2 = zoneOffsetMinutes(timeZone, new Date(first));
  if (off2 === off1) return new Date(first);
  const second = naive - off2 * 60000;
  const off3 = zoneOffsetMinutes(timeZone, new Date(second));
  return new Date(off3 === off2 ? second : first);
}

/** The `YYYY-MM-DDTHH:MM` an operator should see for a stored instant, in their chosen zone. */
export function utcToZonedInput(at: Date, timeZone: string): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime()) || !isValidTimeZone(timeZone)) return '';
  const p = zoneParts(timeZone, at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
}

/** A readable stamp, e.g. "20 Aug 2026, 09:30 (Asia/Kolkata)". */
export function formatInZone(at: Date, timeZone: string): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return '—';
  if (!isValidTimeZone(timeZone)) return at.toISOString();
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return f.format(at) + ' (' + timeZone + ')';
}

// ── recurrence ─────────────────────────────────────────────────────────────────────────────────

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly';
  /** Every N days / weeks / months. Minimum 1. */
  interval?: number;
  /** Weekly only: 0 = Sunday … 6 = Saturday. Empty means "the anchor's weekday". */
  byWeekday?: number[];
  /** Wall-clock hour/minute in `timeZone`. */
  hour: number;
  minute: number;
  timeZone: string;
  /** The first occurrence, as a UTC ISO string. Interval arithmetic counts from this date. */
  anchor: string;
  /** Stop after this instant (UTC ISO), inclusive. */
  until?: string | null;
  /** Stop after this many occurrences in total. */
  count?: number | null;
}

function dayNumber(p: { year: number; month: number; day: number }): number {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function recurrenceErrors(r: Recurrence): string[] {
  const out: string[] = [];
  if (!r || !['daily', 'weekly', 'monthly'].includes(r.freq)) out.push('Choose how often this repeats.');
  if (!isValidTimeZone(r?.timeZone || '')) out.push('That time zone is not one the server recognises.');
  if (!Number.isInteger(r?.hour) || r.hour < 0 || r.hour > 23) out.push('Hour must be 0-23.');
  if (!Number.isInteger(r?.minute) || r.minute < 0 || r.minute > 59) out.push('Minute must be 0-59.');
  if (r?.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 52)) out.push('Repeat every must be between 1 and 52.');
  if (Number.isNaN(Date.parse(String(r?.anchor)))) out.push('The first send date is not a date we can read.');
  if (r?.freq === 'weekly' && r.byWeekday && r.byWeekday.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) out.push('Weekdays must be 0 (Sunday) to 6 (Saturday).');
  if (r?.count !== undefined && r.count !== null && (!Number.isInteger(r.count) || r.count < 1)) out.push('Occurrence count must be 1 or more.');
  return out;
}

const SEARCH_DAYS = 800;

/**
 * The first occurrence strictly after `after`, or null when the series has ended.
 *
 * Walks candidate DAYS in the target zone rather than adding milliseconds, which is the only way a
 * "every day at 09:00 IST" series stays at 09:00 across a DST change in any zone. `occurrencesSoFar`
 * is what enforces `count`; the caller keeps that tally on the campaign row.
 *
 * A monthly series anchored on the 31st CLAMPS to the last day of shorter months (28 Feb, 30 Apr)
 * rather than skipping them. Skipping is the other defensible choice; clamping is stated here so
 * nobody has to read the loop to find out which one this is.
 */
export function nextOccurrence(r: Recurrence, after: Date, occurrencesSoFar = 0): Date | null {
  if (recurrenceErrors(r).length) return null;
  if (r.count !== null && r.count !== undefined && occurrencesSoFar >= r.count) return null;

  const interval = Math.max(1, Math.floor(r.interval || 1));
  const anchorDate = new Date(r.anchor);
  const tz = r.timeZone;
  const anchorParts = zoneParts(tz, anchorDate);
  const anchorDay = dayNumber(anchorParts);
  const anchorDom = anchorParts.day;
  const untilMs = r.until ? Date.parse(r.until) : null;

  const startParts = zoneParts(tz, after.getTime() > anchorDate.getTime() ? after : anchorDate);
  let cursor = dayNumber(startParts);

  for (let i = 0; i < SEARCH_DAYS; i++, cursor++) {
    const d = new Date(cursor * 86400000);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const dom = d.getUTCDate();
    const weekday = d.getUTCDay();

    let matches = false;
    if (r.freq === 'daily') {
      const diff = cursor - anchorDay;
      matches = diff >= 0 && diff % interval === 0;
    } else if (r.freq === 'weekly') {
      const wanted = (r.byWeekday && r.byWeekday.length ? r.byWeekday : [anchorParts.weekday]);
      if (wanted.includes(weekday)) {
        // Week index relative to the anchor's week (weeks start on Sunday).
        const anchorWeekStart = anchorDay - anchorParts.weekday;
        const thisWeekStart = cursor - weekday;
        const weeks = Math.floor((thisWeekStart - anchorWeekStart) / 7);
        matches = weeks >= 0 && weeks % interval === 0;
      }
    } else {
      const months = (y - anchorParts.year) * 12 + (mo - anchorParts.month);
      if (months >= 0 && months % interval === 0) {
        const target = Math.min(anchorDom, daysInMonth(y, mo));
        matches = dom === target;
      }
    }
    if (!matches) continue;

    const pad = (n: number) => String(n).padStart(2, '0');
    const local = y + '-' + pad(mo) + '-' + pad(dom) + 'T' + pad(r.hour) + ':' + pad(r.minute);
    const instant = zonedTimeToUtc(local, tz);
    if (Number.isNaN(instant.getTime())) continue;
    if (instant.getTime() <= after.getTime()) continue;
    if (untilMs !== null && instant.getTime() > untilMs) return null;
    return instant;
  }
  return null;
}

/** The next `n` occurrences — what the schedule screen shows so nobody has to guess the series. */
export function occurrencePreview(r: Recurrence, from: Date, n = 5): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < n; i++) {
    const next = nextOccurrence(r, cursor, i);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Is a scheduled instant due?
 *
 * `graceMs` exists because a cron that runs every five minutes will never fire at the exact second,
 * and a campaign scheduled for 09:30 that goes out at 09:33 is correct. There is deliberately no
 * upper bound: a campaign whose cron did not run for two hours is LATE, not cancelled, and dropping
 * it silently is exactly the failure this system must not have.
 */
export function isDue(scheduledAt: Date | string | null | undefined, now: Date = new Date(), graceMs = 0): boolean {
  if (!scheduledAt) return false;
  const t = scheduledAt instanceof Date ? scheduledAt.getTime() : Date.parse(String(scheduledAt));
  if (Number.isNaN(t)) return false;
  return t - graceMs <= now.getTime();
}

/** How late a due campaign is, in minutes. Shown on the ops screen; 0 when not yet due. */
export function minutesLate(scheduledAt: Date | string, now: Date = new Date()): number {
  const t = scheduledAt instanceof Date ? scheduledAt.getTime() : Date.parse(String(scheduledAt));
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 60000));
}
