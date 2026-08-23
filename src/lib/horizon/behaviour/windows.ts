// src/lib/behaviour/windows.ts — PATCH 04: the six time windows, and the baseline period behind each.
//
// PURE. No database, no clock of its own — `now` is always passed in. Two reasons, both load-bearing:
// a window function that reads Date.now() cannot be tested against a fixed calendar, and every
// caller in this patch needs ONE instant shared across every window it resolves. Resolving "this
// month" and "this quarter" a few milliseconds apart is harmless until the read happens at midnight
// on the first of January, and then the two windows disagree about which year it is.
//
// =================================================================================================
// WHY A FIXED OFFSET AND NOT A TIME ZONE DATABASE
// =================================================================================================
//
// "This week" has to mean the week the person actually worked, not the week in UTC. At UTC a
// Monday-morning task in Bengaluru lands in the previous week for the five and a half hours before
// 05:30, which quietly moves somebody's Monday into last week's numbers.
//
// The organisation this runs for is in India, which has ONE offset and NO daylight saving, so a
// fixed +05:30 is not an approximation here — it is exact, and it is deterministic in a way an
// Intl lookup inside a metric loop is not. `tzOffsetMinutes` is a parameter rather than a constant
// so a deployment elsewhere passes its own.
//
// THE LIMIT, STATED: a deployment in a zone WITH daylight saving must not use this as-is. A fixed
// offset there would misplace one hour twice a year, and the fix is an IANA-aware boundary function,
// not a different number. See docs/behavioural-intelligence.md.
import type { BehaviourWindow, ResolvedWindow } from './types';
import { BEHAVIOUR_WINDOWS } from './types';

/** India Standard Time. No daylight saving, so this is exact rather than approximate. */
export const DEFAULT_TZ_OFFSET_MINUTES = 330;

/**
 * How far back 'recent' reaches.
 *
 * Fourteen days rather than seven: at a weekly cadence a single missed day is a large share of the
 * window, and a metric that swings on one task is noise wearing a trend's clothes. Fourteen is also
 * two full working weeks, so the window is not distorted by which weekday it is read on.
 */
export const RECENT_DAYS = 14;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** ISO 8601 UTC, milliseconds dropped. Every timestamp this patch emits goes through here. */
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Parse a stored timestamp or date to epoch ms; null for anything unparseable. Never throws. */
export function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Calendar parts of an instant AS SEEN in the offset zone.
 *
 * Implemented by shifting the instant and then reading the UTC parts, which is the one arithmetic
 * that cannot be wrong about the host machine's own zone. Reading `getFullYear()` on a server set to
 * UTC and on a laptop set to IST would produce two different "this month" boundaries from the same
 * code, and that difference would only ever be noticed at month end.
 */
function partsInZone(ms: number, tzOffsetMinutes: number) {
  const shifted = new Date(ms + tzOffsetMinutes * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/** The instant at which a local calendar date begins, expressed as epoch ms. */
function localMidnightMs(year: number, month: number, day: number, tzOffsetMinutes: number): number {
  return Date.UTC(year, month, day) - tzOffsetMinutes * MS_PER_MINUTE;
}

/**
 * The start of the window, before employment clamping. Half-open: [start, now).
 *
 * Weeks start on MONDAY. `getUTCDay()` calls Sunday 0, so a naive subtraction puts Sunday's work in
 * the week that is about to start rather than the one that just ended — which is the single most
 * common off-by-one in week bucketing and is invisible six days out of seven.
 */
function windowStartMs(window: BehaviourWindow, nowMs: number, tzOffsetMinutes: number): number {
  const p = partsInZone(nowMs, tzOffsetMinutes);
  switch (window) {
    case 'recent':
      return nowMs - RECENT_DAYS * MS_PER_DAY;
    case 'this_week': {
      const daysSinceMonday = (p.weekday + 6) % 7;
      return localMidnightMs(p.year, p.month, p.day - daysSinceMonday, tzOffsetMinutes);
    }
    case 'this_month':
      return localMidnightMs(p.year, p.month, 1, tzOffsetMinutes);
    case 'this_quarter':
      return localMidnightMs(p.year, Math.floor(p.month / 3) * 3, 1, tzOffsetMinutes);
    case 'this_year':
      return localMidnightMs(p.year, 0, 1, tzOffsetMinutes);
    case 'employment_history':
      // Bounded by employment below. Unbounded here rather than guessing an epoch: an invented
      // start date would be reported in `statement` as though somebody had joined then.
      return Number.NEGATIVE_INFINITY;
  }
}

export interface WindowOptions {
  /** hr_employees.joining_date, or the earliest record on file. Null when unknown. */
  employedFromMs?: number | null;
  /** hr_employees.last_working_day or exit_date. Null while employed. */
  employedToMs?: number | null;
  tzOffsetMinutes?: number;
}

/**
 * RESOLVE ONE WINDOW against a fixed instant and the person's employment bounds.
 *
 * CLAMPING IS NOT COSMETIC. "This year" on somebody who joined in July is three months of records
 * wearing a twelve-month label. Left unclamped, the preceding-period baseline for it would be drawn
 * from six months in which the person did not work here, the comparison would be against nothing,
 * and the trend would read as a collapse. `clampedToEmployment` says out loud that it happened, and
 * `statement` prints the interval that was actually queried rather than the one that was asked for.
 */
export function resolveWindow(
  window: BehaviourWindow,
  nowMs: number,
  opts: WindowOptions = {},
): ResolvedWindow {
  const tz = opts.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES;
  const employedFrom = opts.employedFromMs ?? null;
  const employedTo = opts.employedToMs ?? null;

  // The end is now, or the last working day for somebody who has left. Reading a departed
  // colleague's "this month" as an empty month would be a false record about their last weeks.
  const endMs = employedTo !== null && employedTo < nowMs ? employedTo : nowMs;

  const rawStart = windowStartMs(window, nowMs, tz);
  let startMs = rawStart;
  let clamped = false;

  if (employedFrom !== null && employedFrom > startMs) {
    startMs = employedFrom;
    // An unbounded history window starting at the joining date is the window working as intended,
    // not a clamp. Saying "clamped" there would put a caveat on a complete record.
    clamped = window !== 'employment_history';
  } else if (window === 'employment_history' && rawStart === Number.NEGATIVE_INFINITY) {
    // No joining date on file. The window is every row we hold, and it says so rather than
    // implying a start date nobody recorded.
    startMs = Number.NEGATIVE_INFINITY;
  }

  const bounded = startMs !== Number.NEGATIVE_INFINITY;
  const safeStart = bounded ? Math.min(startMs, endMs) : endMs;
  const days = bounded ? Math.max(0, Math.round((endMs - safeStart) / MS_PER_DAY)) : 0;

  const fromIso = bounded ? iso(safeStart) : '';
  const toIso = iso(endMs);

  const statement = bounded
    ? `${fromIso} to ${toIso} (${days} day${days === 1 ? '' : 's'})` +
      (clamped ? ', start moved forward to the joining date on file' : '')
    : `every record held, up to ${toIso}; no joining date on file to bound it`;

  return {
    window,
    fromIso,
    toIso,
    days,
    clampedToEmployment: clamped,
    statement,
  };
}

/** All six, resolved against one instant. The only way this patch builds a window set. */
export function resolveAllWindows(nowMs: number, opts: WindowOptions = {}): ResolvedWindow[] {
  return BEHAVIOUR_WINDOWS.map((w) => resolveWindow(w, nowMs, opts));
}

/**
 * THE COMPARISON PERIOD: the same number of days immediately before the window.
 *
 * Same LENGTH, deliberately, not "the previous calendar month". Comparing eleven days of August
 * against thirty-one days of July is a comparison between a part and a whole, and it makes anybody
 * read as slower in the first third of every month.
 *
 * Returns null when there is no room for one — an unbounded history window has nothing before it,
 * and a window that starts on the joining date has nothing before it either. A null here becomes
 * `Baseline.kind = 'none'` and every verdict built on it becomes 'insufficient_evidence', which is
 * the correct answer for a person in their first month.
 */
export function precedingPeriod(
  resolved: ResolvedWindow,
  opts: WindowOptions = {},
): { fromIso: string; toIso: string; days: number } | null {
  if (!resolved.fromIso) return null;
  const startMs = toMs(resolved.fromIso);
  if (startMs === null || resolved.days <= 0) return null;

  const priorEnd = startMs;
  let priorStart = priorEnd - resolved.days * MS_PER_DAY;

  const employedFrom = opts.employedFromMs ?? null;
  if (employedFrom !== null) {
    if (priorEnd <= employedFrom) return null;             // nothing before the joining date exists
    if (priorStart < employedFrom) priorStart = employedFrom;
  }

  const days = Math.max(0, Math.round((priorEnd - priorStart) / MS_PER_DAY));
  if (days <= 0) return null;

  return { fromIso: iso(priorStart), toIso: iso(priorEnd), days };
}

/**
 * SPLIT A WINDOW INTO SUB-PERIODS, so a one-off can be told apart from a direction.
 *
 * This is the whole mechanism behind `temporary_anomaly` versus `sustained_pattern`: without
 * sub-periods, a metric has one number for the window and one for the baseline, and two numbers can
 * only ever say "different", never "different, and it has been different every week since July".
 *
 * The count is capped at MAX_SUBPERIODS: past that, each bucket holds too few events to say
 * anything, and a chart with twenty near-empty buckets reads as violent instability that is entirely
 * an artefact of the bucketing.
 */
export const MIN_SUBPERIODS = 3;
export const MAX_SUBPERIODS = 8;

export function subPeriods(
  resolved: ResolvedWindow,
  count: number,
): { fromIso: string; toIso: string }[] {
  if (!resolved.fromIso || resolved.days <= 0) return [];
  const startMs = toMs(resolved.fromIso);
  const endMs = toMs(resolved.toIso);
  if (startMs === null || endMs === null || endMs <= startMs) return [];

  const n = Math.max(MIN_SUBPERIODS, Math.min(MAX_SUBPERIODS, Math.floor(count) || MIN_SUBPERIODS));
  const span = (endMs - startMs) / n;
  if (span <= 0) return [];

  const out: { fromIso: string; toIso: string }[] = [];
  for (let i = 0; i < n; i++) {
    // The last bucket ends exactly at the window end rather than at start + n*span, so floating
    // point cannot leave the final few milliseconds of the window in no bucket at all.
    const from = startMs + i * span;
    const to = i === n - 1 ? endMs : startMs + (i + 1) * span;
    out.push({ fromIso: iso(from), toIso: iso(to) });
  }
  return out;
}

/** Is an instant inside [fromIso, toIso)? An empty `fromIso` means unbounded on the left. */
export function withinWindow(occurredAtIso: string, fromIso: string, toIso: string): boolean {
  const t = toMs(occurredAtIso);
  if (t === null) return false;
  const to = toMs(toIso);
  if (to === null || t >= to) return false;
  if (!fromIso) return true;
  const from = toMs(fromIso);
  return from === null ? false : t >= from;
}
