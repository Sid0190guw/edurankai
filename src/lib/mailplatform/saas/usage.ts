// src/lib/mailplatform/saas/usage.ts — billing periods and the rollup from events to numbers.
//
// PURE. Every function takes data and returns data; nothing here opens a connection. That is what
// makes the arithmetic that decides an invoice testable, and metering arithmetic that nobody can
// test is metering arithmetic nobody has checked against a real month.
//
// SECTION 4 OF THE BRIEF: "Usage must be calculated from durable events, not frontend counters."
// So the durable event is the only input. `rollup()` cannot be handed a total; it can only be
// handed facts, and it derives the total. A number that cannot be traced back to the events that
// produced it is a number that cannot be defended in a billing dispute, and in a billing dispute
// the customer is right by default.
//
// COUNTERS AND GAUGES ARE ROLLED UP DIFFERENTLY, AND THIS IS THE WHOLE FILE
//
//   COUNTER: sum the period's events. At the period boundary it starts again at zero.
//   GAUGE:   carry the level FORWARD across the boundary and apply the period's deltas to it. A
//            tenant who has held five mailboxes for three years has five mailboxes, not fifteen.
//
// Summing a gauge like a counter is the classic metering bug and it always bills in the vendor's
// favour, which is exactly the kind of bug that never gets reported as a bug — it gets reported as
// "why is my bill wrong", once, by a customer who then leaves.
//
// TIME IS UTC HERE, DELIBERATELY AND VISIBLY.
//
// `OrgProfile.timezone` is recorded and displayed, but a billing period boundary in this file falls
// at midnight UTC. Doing it per-tenant properly needs a real timezone database at the boundary of
// every quota check, and half-doing it — a fixed offset, a guess at DST — produces a boundary that
// is wrong twice a year for exactly the tenants who send the most. One documented rule beats a
// convincing approximation. The admin screens say "UTC" next to the period so nobody is surprised.

import type {
  MetricKey,
  UsageCounter,
  UsageEvent,
  UsagePeriod,
  UsageSnapshot,
} from './types';
import { METRICS, METRIC_KEYS, zeroMetrics } from './plans';

// ---------------------------------------------------------------------------
// Period arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(iso: string | Date): Date {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date: ' + String(iso));
  return d;
}

/** Midnight UTC on the given calendar day. */
function utcMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}

/** Days in a UTC month. Month is 0-indexed, as JavaScript insists. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Add `n` months to a UTC date, clamping the day to the target month's length.
 *
 * A subscription anchored on the 31st has to mean SOMETHING in February. Clamping to the 28th is
 * the convention every billing system settles on, and the alternative — JavaScript's default, which
 * rolls the 31st of January into the 3rd of March — silently gives the tenant three extra days of
 * quota every year and makes two periods overlap.
 */
export function addMonthsUtc(date: Date, n: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const targetMonth = m + n;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(targetYear, normalizedMonth));
  return new Date(Date.UTC(
    targetYear, normalizedMonth, day,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ));
}

/**
 * The billing period containing `now`, for a subscription anchored at `anchor`.
 *
 * Half-open: `start` is included, `end` is not. Half-open is not fussiness — with closed intervals
 * an event landing exactly on a boundary is counted in both periods, and boundary events are the
 * common case for anything scheduled, which is most of what a mail platform sends.
 *
 * Walks month by month from the anchor rather than dividing elapsed milliseconds, because months
 * are not a fixed length and division gets the answer wrong for anyone anchored near month end.
 */
export function periodFor(anchorIso: string | Date, nowIso: string | Date = new Date()): UsagePeriod {
  const anchor = toDate(anchorIso);
  const now = toDate(nowIso);

  if (now.getTime() < anchor.getTime()) {
    // Before the subscription began. The period is the one ENDING at the anchor, so usage recorded
    // early (a trial, a backfill) has somewhere to live instead of being silently discarded.
    const start = addMonthsUtc(anchor, -1);
    return { start: start.toISOString(), end: anchor.toISOString() };
  }

  // Jump most of the way in one step, then walk. A tenant three years in takes two iterations
  // rather than thirty-six, and the walk still handles the month-length clamping exactly.
  const approxMonths = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / (30.44 * DAY_MS)) - 1);
  let start = addMonthsUtc(anchor, approxMonths);
  let end = addMonthsUtc(anchor, approxMonths + 1);
  let guard = 0;
  while (end.getTime() <= now.getTime() && guard < 480) {
    start = end;
    end = addMonthsUtc(anchor, approxMonths + guard + 2);
    guard++;
  }
  while (start.getTime() > now.getTime() && guard < 480) {
    end = start;
    start = addMonthsUtc(start, -1);
    guard++;
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/** The period immediately after this one. */
export function nextPeriod(period: UsagePeriod): UsagePeriod {
  const end = toDate(period.end);
  return { start: period.end, end: addMonthsUtc(end, 1).toISOString() };
}

/** Is this instant inside the half-open period? */
export function inPeriod(period: UsagePeriod, when: string | Date): boolean {
  const t = toDate(when).getTime();
  return t >= toDate(period.start).getTime() && t < toDate(period.end).getTime();
}

/** Whole days left in the period, floored at zero. Used for "renews in N days". */
export function daysRemaining(period: UsagePeriod, nowIso: string | Date = new Date()): number {
  const ms = toDate(period.end).getTime() - toDate(nowIso).getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/**
 * How far through the period we are, 0 to 1.
 *
 * The quota screens use this to say whether consumption is AHEAD of schedule — "60% of your sends,
 * 30% of the way through the month" is the sentence an operator can act on, and it is the one
 * number a raw usage bar cannot give them.
 */
export function periodProgress(period: UsagePeriod, nowIso: string | Date = new Date()): number {
  const start = toDate(period.start).getTime();
  const end = toDate(period.end).getTime();
  if (end <= start) return 1;
  const now = toDate(nowIso).getTime();
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}

/** A calendar-month period, for tenants with no subscription anchor yet. */
export function calendarPeriod(nowIso: string | Date = new Date()): UsagePeriod {
  const now = toDate(nowIso);
  const start = utcMidnight(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = utcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

export interface RollupInput {
  orgId: string;
  period: UsagePeriod;
  /** Events to fold in. Order does not matter — they are sorted by `occurredAt` first. */
  events: UsageEvent[];
  /**
   * The GAUGE levels as they stood at `period.start`, normally the previous period's closing
   * values. Counters are ignored here: a counter's opening value is zero by definition, and
   * accepting one would be the bug this whole file exists to prevent.
   */
  opening?: Partial<Record<MetricKey, number>>;
}

/**
 * Fold durable events into the numbers a quota check reads.
 *
 * Events OUTSIDE the period are dropped for counters and — importantly — for gauges too: a gauge's
 * history before the period is already summarised in `opening`, so applying those deltas again
 * would double-count every mailbox the tenant has ever created.
 */
export function rollup(input: RollupInput): UsageSnapshot {
  const { period } = input;
  const values = zeroMetrics();
  const peaks = zeroMetrics();

  // Gauges start from the carried-forward level; counters start at zero.
  for (const key of METRIC_KEYS) {
    if (METRICS[key].kind === 'gauge') {
      const opening = input.opening ? input.opening[key] : undefined;
      const v = typeof opening === 'number' && Number.isFinite(opening) ? Math.max(0, opening) : 0;
      values[key] = v;
      peaks[key] = v;
    }
  }

  const ordered = [...input.events]
    .filter((e) => e && typeof e.metric === 'string' && METRICS[e.metric] && inPeriod(period, e.occurredAt))
    .sort((a, b) => {
      const t = toDate(a.occurredAt).getTime() - toDate(b.occurredAt).getTime();
      // A stable tiebreak on id, so the same event set always rolls up to the same number. Two
      // events at the identical millisecond is common under a queue, and an unstable sort there
      // would make a 'set' and a 'delta' land in either order — two different answers from the
      // same facts, which is worse than either answer.
      return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
    });

  for (const e of ordered) {
    const q = Number(e.quantity);
    if (!Number.isFinite(q)) continue;
    const mode = e.mode === 'set' ? 'set' : 'delta';
    if (mode === 'set') {
      values[e.metric] = Math.max(0, q);
    } else {
      values[e.metric] = values[e.metric] + q;
      // A gauge below zero means drift — more deletions recorded than creations, usually because a
      // creation event was lost. Clamped, because a negative mailbox count is not a fact about the
      // world, and left for the reconciler's 'set' to correct properly.
      if (values[e.metric] < 0) values[e.metric] = 0;
    }
    if (values[e.metric] > peaks[e.metric]) peaks[e.metric] = values[e.metric];
  }

  return { orgId: input.orgId, period, values, peaks };
}

/** Closing gauge levels, ready to be handed to the next period as `opening`. */
export function closingGauges(snapshot: UsageSnapshot): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const key of METRIC_KEYS) {
    if (METRICS[key].kind === 'gauge') out[key] = snapshot.values[key];
  }
  return out;
}

/** Stored counter rows to a snapshot. Missing rows read as zero, never as undefined. */
export function snapshotFromCounters(
  orgId: string,
  period: UsagePeriod,
  counters: UsageCounter[],
): UsageSnapshot {
  const values = zeroMetrics();
  const peaks = zeroMetrics();
  for (const c of counters) {
    if (!METRICS[c.metric]) continue;
    values[c.metric] = Number(c.value) || 0;
    peaks[c.metric] = Number(c.peak) || Number(c.value) || 0;
  }
  return { orgId, period, values, peaks };
}

/** An empty snapshot. A tenant with no usage has zeroes, not gaps. */
export function emptySnapshot(orgId: string, period: UsagePeriod): UsageSnapshot {
  return { orgId, period, values: zeroMetrics(), peaks: zeroMetrics() };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Build the key that stops a fact being counted twice.
 *
 * The parts must identify the FACT, not the attempt: `['message.sent', messageId]`, never anything
 * with a timestamp or a random value in it. A key that differs between retries is not an
 * idempotency key, it is a slower way of writing two rows — and it looks like it works, because
 * the first delivery and the retry both succeed.
 */
export function usageKey(...parts: (string | number | null | undefined)[]): string {
  return parts
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .map((p) => String(p).replace(/\s+/g, '_'))
    .join(':')
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Threshold crossings
// ---------------------------------------------------------------------------

export interface ThresholdCrossing {
  metric: MetricKey;
  threshold: number;
  used: number;
  limit: number;
}

/**
 * Which warning thresholds a metric crossed by moving from `before` to `after`.
 *
 * Takes BOTH numbers rather than just the new one, so a warning fires on the transition and not on
 * every subsequent call. Without that, a tenant sitting at 96% of their quota receives a "you have
 * used 95%" notification for every message they send for the rest of the month, which trains them
 * to filter the one message that mattered.
 */
export function crossedThresholds(
  metric: MetricKey,
  before: number,
  after: number,
  limit: number | null,
  thresholds: number[],
): ThresholdCrossing[] {
  if (limit === null || limit <= 0) return [];
  if (after <= before) return [];
  const out: ThresholdCrossing[] = [];
  for (const t of thresholds) {
    const mark = limit * t;
    if (before < mark && after >= mark) out.push({ metric, threshold: t, used: after, limit });
  }
  return out;
}

/**
 * A whole snapshot's worth of crossings, for a periodic sweep rather than a per-call check.
 * The sweep is what catches a tenant who crossed a threshold through a path that never called the
 * quota engine — an import, a backfill, a reconciler's 'set'.
 */
export function allCrossings(
  before: UsageSnapshot,
  after: UsageSnapshot,
  limitOf: (metric: MetricKey) => number | null,
  thresholds: number[],
): ThresholdCrossing[] {
  const out: ThresholdCrossing[] = [];
  for (const key of METRIC_KEYS) {
    out.push(...crossedThresholds(key, before.values[key], after.values[key], limitOf(key), thresholds));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export interface UsagePoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  value: number;
}

/**
 * Daily totals for one metric, for the usage trend on the billing dashboard.
 *
 * Counters are summed per day. Gauges are the level AT THE END of each day — a gauge summed per day
 * is meaningless, and drawing it as one would put a mountain range where a flat line belongs.
 * Days with no events are emitted at zero (counter) or carried forward (gauge), so the series has
 * no gaps and a chart does not connect two points across a week of silence.
 */
export function dailySeries(
  metric: MetricKey,
  events: UsageEvent[],
  period: UsagePeriod,
  opening = 0,
): UsagePoint[] {
  const kind = METRICS[metric] ? METRICS[metric].kind : 'counter';
  const start = toDate(period.start);
  const end = toDate(period.end);
  const relevant = events
    .filter((e) => e.metric === metric && inPeriod(period, e.occurredAt))
    .sort((a, b) => toDate(a.occurredAt).getTime() - toDate(b.occurredAt).getTime());

  const byDay = new Map<string, UsageEvent[]>();
  for (const e of relevant) {
    const day = toDate(e.occurredAt).toISOString().slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(e);
    else byDay.set(day, [e]);
  }

  const out: UsagePoint[] = [];
  let level = Math.max(0, opening);
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const todays = byDay.get(day) || [];
    if (kind === 'counter') {
      let sum = 0;
      for (const e of todays) {
        const q = Number(e.quantity) || 0;
        if (e.mode === 'set') sum = Math.max(0, q);
        else sum += q;
      }
      out.push({ day, value: Math.max(0, sum) });
    } else {
      for (const e of todays) {
        const q = Number(e.quantity) || 0;
        level = e.mode === 'set' ? Math.max(0, q) : Math.max(0, level + q);
      }
      out.push({ day, value: level });
    }
  }
  return out;
}

/**
 * Where a counter lands at period end if consumption continues at the current rate.
 *
 * Null before enough of the period has passed to mean anything: projecting a month from ninety
 * minutes of data produces a confident number that is wrong by an order of magnitude, and a
 * confident wrong number on a billing screen gets acted on.
 */
export function projectedTotal(
  used: number,
  period: UsagePeriod,
  nowIso: string | Date = new Date(),
): number | null {
  const progress = periodProgress(period, nowIso);
  if (progress < 0.1) return null;
  return Math.round(used / progress);
}
